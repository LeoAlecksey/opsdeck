//! SSH host profiles: OpsDeck's own list (~/.config/opsdeck/ssh.json, secrets in keyring/KeePass)
//! plus read-only hosts from ~/.ssh/config. Connecting opens `ssh` in a terminal tab; a known
//! password goes to the clipboard for 30 s (ssh itself only reads passwords from the tty).

use crate::{
    keepass::{self, KeepassState},
    passbolt::{self, PassboltState},
    process, store,
    tools::valid_host,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, State};

const FILE: &str = "ssh.json";
/// Groups for ~/.ssh/config hosts (alias → group): OpsDeck never writes to the ssh config itself.
const GROUPS_FILE: &str = "ssh_groups.json";

#[derive(Serialize, Deserialize, Clone)]
pub struct SshHost {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub group: String,
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub identity_file: String,
    #[serde(default)]
    pub jump: String,
    /// key | keepass | password | none
    #[serde(default = "default_auth")]
    pub auth: String,
    #[serde(default)]
    pub keepass_entry: String,
    /// Passbolt resource uuid when auth == "passbolt"
    #[serde(default)]
    pub passbolt_entry: String,
}

fn default_port() -> u16 {
    22
}
fn default_auth() -> String {
    "key".into()
}

#[derive(Serialize, Default)]
pub struct ConfigHost {
    /// effective values as ssh resolves them (`ssh -G alias`): user, hostname, port, identity
    effective: Option<Effective>,
    alias: String,
    /// from ssh_groups.json, else from a `# group: …` comment right above the Host line
    group: String,
    hostname: String,
    user: String,
    port: String,
    identity_file: String,
    proxy_jump: String,
    proxy_command: String,
}

#[derive(Serialize)]
pub struct SshList {
    hosts: Vec<SshHost>,
    config: Vec<ConfigHost>,
}

fn secret_key(id: &str) -> String {
    format!("ssh:{id}")
}

fn load() -> Result<Vec<SshHost>, String> {
    store::load_json(FILE)
}

fn ssh_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".ssh")
}

fn strip_comment(line: &str) -> (&str, Option<&str>) {
    let mut in_quotes = false;
    for (i, c) in line.char_indices() {
        if c == '"' {
            in_quotes = !in_quotes;
        } else if c == '#' && !in_quotes {
            let code = line[..i].trim();
            let comment = line[i + 1..].trim();
            return (code, Some(comment));
        }
    }
    (line.trim(), None)
}

fn glob_matches(pattern: &str, name: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    if let Some((prefix, suffix)) = pattern.split_once('*') {
        return name.starts_with(prefix)
            && name.ends_with(suffix)
            && name.len() >= prefix.len() + suffix.len();
    }
    pattern == name
}

fn resolve_includes(pattern: &str, base_dir: Option<&Path>) -> Vec<PathBuf> {
    let expanded = if let Some(rest) = pattern.strip_prefix("~/").or_else(|| pattern.strip_prefix("~\\")) {
        dirs::home_dir().unwrap_or_default().join(rest)
    } else if pattern == "~" {
        dirs::home_dir().unwrap_or_default()
    } else {
        let p = Path::new(pattern);
        if p.is_absolute() {
            p.to_path_buf()
        } else if let Some(base) = base_dir {
            base.join(p)
        } else {
            ssh_dir().join(p)
        }
    };

    if pattern.contains(['*', '?']) {
        let parent = expanded.parent().unwrap_or(Path::new(""));
        let file_pattern = expanded.file_name().and_then(|f| f.to_str()).unwrap_or("");
        let mut matches = Vec::new();
        if let Ok(entries) = std::fs::read_dir(parent) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                        if glob_matches(file_pattern, name) {
                            matches.push(path);
                        }
                    }
                }
            }
        }
        matches.sort();
        matches
    } else if expanded.is_file() {
        vec![expanded]
    } else {
        Vec::new()
    }
}

/// Concrete `Host` entries of ~/.ssh/config (patterns with * ? ! are skipped; follows Include).
fn parse_config() -> Vec<ConfigHost> {
    read_config().0
}

/// [`parse_config`] plus the text of every file it read, included ones too: the `ssh -G` cache key.
fn read_config() -> (Vec<ConfigHost>, String) {
    let config_path = ssh_dir().join("config");
    let Ok(raw) = std::fs::read_to_string(&config_path) else {
        return (Vec::new(), String::new());
    };
    let mut out = Vec::new();
    let mut text = String::new();
    let mut visited = HashSet::new();
    if let Ok(canon) = config_path.canonicalize() {
        visited.insert(canon);
    } else {
        visited.insert(config_path);
    }
    parse_config_text_internal(&raw, Some(&ssh_dir()), &mut out, &mut visited, &mut text, 0);
    (out, text)
}

#[cfg_attr(not(test), allow(dead_code))]
fn parse_config_text(raw: &str) -> Vec<ConfigHost> {
    let mut out = Vec::new();
    let mut visited = HashSet::new();
    parse_config_text_internal(
        raw,
        Some(&ssh_dir()),
        &mut out,
        &mut visited,
        &mut String::new(),
        0,
    );
    out
}

fn parse_config_text_internal(
    raw: &str,
    base_dir: Option<&Path>,
    out: &mut Vec<ConfigHost>,
    visited: &mut HashSet<PathBuf>,
    text: &mut String,
    depth: usize,
) {
    // length-prefixed, so a line moved from one file to the next still changes the text
    text.push_str(&format!("{}\n{raw}", raw.len()));
    let mut current: Vec<usize> = Vec::new();
    let mut comment_group = String::new();
    for line in raw.lines() {
        let (code, comment) = strip_comment(line);

        if let Some(c) = comment {
            if let Some(g) = c.strip_prefix("group:").or_else(|| c.strip_prefix("Group:")) {
                comment_group = g.trim().to_string();
            }
        }

        if code.is_empty() {
            continue;
        }

        let (key, value) = match code.split_once(|c: char| c.is_whitespace() || c == '=') {
            Some((k, v)) => (
                k.to_lowercase(),
                v.trim_start_matches(|c: char| c.is_whitespace() || c == '=')
                    .trim()
                    .trim_matches('"')
                    .to_string(),
            ),
            None => continue,
        };

        match key.as_str() {
            "host" => {
                current.clear();
                for alias in value.split_whitespace() {
                    let alias = alias.trim_matches('"');
                    if alias.is_empty()
                        || alias.starts_with('#')
                        || alias.starts_with('-')
                        || alias.contains(['*', '?', '!'])
                    {
                        continue;
                    }
                    if let Some(idx) = out.iter().position(|h| h.alias == alias) {
                        current.push(idx);
                        if out[idx].group.is_empty() && !comment_group.is_empty() {
                            out[idx].group = comment_group.clone();
                        }
                    } else {
                        current.push(out.len());
                        out.push(ConfigHost {
                            alias: alias.into(),
                            group: comment_group.clone(),
                            ..Default::default()
                        });
                    }
                }
                comment_group.clear();
            }
            "match" => {
                current.clear();
                comment_group.clear();
            }
            "include" => {
                current.clear();
                comment_group.clear();
                if depth < 8 {
                    for inc_token in value.split_whitespace() {
                        let inc_pattern = inc_token.trim_matches('"');
                        for inc_path in resolve_includes(inc_pattern, base_dir) {
                            let canon = inc_path.canonicalize().unwrap_or_else(|_| inc_path.clone());
                            if visited.insert(canon) {
                                if let Ok(raw_inc) = std::fs::read_to_string(&inc_path) {
                                    parse_config_text_internal(
                                        &raw_inc,
                                        inc_path.parent(),
                                        out,
                                        visited,
                                        text,
                                        depth + 1,
                                    );
                                }
                            }
                        }
                    }
                }
            }
            _ => {
                for &i in &current {
                    let h = &mut out[i];
                    // first value wins, like ssh itself
                    let slot = match key.as_str() {
                        "hostname" => &mut h.hostname,
                        "user" => &mut h.user,
                        "port" => &mut h.port,
                        "identityfile" => &mut h.identity_file,
                        "proxyjump" => &mut h.proxy_jump,
                        "proxycommand" => &mut h.proxy_command,
                        _ => continue,
                    };
                    if slot.is_empty() {
                        *slot = value.clone();
                    }
                }
            }
        }
    }
}

#[derive(Serialize, Clone, Default)]
pub struct Effective {
    user: String,
    hostname: String,
    port: String,
    identity_files: Vec<String>,
    proxy_jump: String,
    proxy_command: String,
}

/// Cache of `ssh -G` keyed by the config text from [`read_config`] — otherwise every ssh_list spawns
/// ssh.exe per alias. The mtime of ~/.ssh/config alone missed edits in files it includes.
type EffectiveCache = (String, HashMap<String, Option<Effective>>);
static EFFECTIVE_CACHE: Mutex<Option<EffectiveCache>> = Mutex::new(None);
/// Parallel `ssh -G` runs: ssh.exe takes tens of ms to start on Windows, 100 aliases one by one is seconds.
const SSH_G_THREADS: usize = 8;

/// What ssh will really use for an alias. No network access: `-G` only evaluates the config.
fn effective(alias: &str) -> Option<Effective> {
    let mut cmd = std::process::Command::new("ssh");
    cmd.args(["-G", alias])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    // without this, Windows flashes an OpenSSH console for every alias
    process::no_console(&mut cmd);
    let out = match cmd.output() {
        Ok(out) => out,
        Err(e) => {
            log::warn!("ssh -G {alias}: {e}");
            return None;
        }
    };
    if !out.status.success() {
        log::warn!(
            "ssh -G {alias}: {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        );
        return None;
    }
    let mut e = Effective::default();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let Some((k, v)) = line.split_once(' ') else { continue };
        match k {
            "user" => e.user = v.into(),
            "hostname" => e.hostname = v.into(),
            "port" => e.port = v.into(),
            "identityfile" => e.identity_files.push(v.into()),
            "proxyjump" if v != "none" => e.proxy_jump = v.into(),
            "proxycommand" if v != "none" => e.proxy_command = v.into(),
            _ => {}
        }
    }
    Some(e)
}

fn effective_map(aliases: &[String], config_text: String) -> HashMap<String, Option<Effective>> {
    if let Ok(cache) = EFFECTIVE_CACHE.lock() {
        if let Some((cached_text, map)) = cache.as_ref() {
            if *cached_text == config_text && aliases.iter().all(|a| map.contains_key(a)) {
                return map.clone();
            }
        }
    }
    let resolved = resolve_parallel(aliases, effective);
    // a worker that panicked left its aliases unresolved: not cached, the next ssh_list retries them
    let complete = resolved.iter().all(Option::is_some);
    let map: HashMap<String, Option<Effective>> = aliases
        .iter()
        .cloned()
        .zip(resolved.into_iter().map(Option::flatten))
        .collect();
    // #84 + #85: the key is the text of every config file (Include too), and a run with a panicked
    // worker is not cached — the next ssh_list asks for those aliases again
    if complete {
        if let Ok(mut cache) = EFFECTIVE_CACHE.lock() {
            *cache = Some((config_text, map.clone()));
        }
    }
    map
}

/// `resolve` for every alias on up to [`SSH_G_THREADS`] threads, results in the order of `aliases`.
/// `None` in the outer Option: the worker panicked, the alias was not resolved.
fn resolve_parallel<F>(aliases: &[String], resolve: F) -> Vec<Option<Option<Effective>>>
where
    F: Fn(&str) -> Option<Effective> + Sync,
{
    let next = std::sync::atomic::AtomicUsize::new(0);
    let work = || {
        let mut done = Vec::new();
        loop {
            let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let Some(alias) = aliases.get(i) else {
                return done;
            };
            done.push((i, resolve(alias)));
        }
    };
    let mut results: Vec<Option<Option<Effective>>> = vec![None; aliases.len()];
    std::thread::scope(|s| {
        let mut workers = Vec::new();
        // this thread works too, so a failed spawn only means fewer threads
        for _ in 1..SSH_G_THREADS.min(aliases.len()) {
            match std::thread::Builder::new()
                .name("ssh-G".into())
                .spawn_scoped(s, work)
            {
                Ok(w) => workers.push(w),
                Err(e) => {
                    log::warn!(
                        "ssh -G: no extra thread ({e}), continuing with {}",
                        workers.len() + 1
                    );
                    break;
                }
            }
        }
        let mut done = work();
        for w in workers {
            match w.join() {
                Ok(d) => done.extend(d),
                Err(panic) => {
                    let why = panic
                        .downcast_ref::<&str>()
                        .map(|s| s.to_string())
                        .or_else(|| panic.downcast_ref::<String>().cloned())
                        .unwrap_or_default();
                    log::error!(
                        "ssh -G: a worker thread panicked ({why}), its aliases stay unresolved"
                    );
                }
            }
        }
        for (i, e) in done {
            results[i] = Some(e);
        }
    });
    results
}

#[tauri::command]
pub async fn ssh_list() -> Result<SshList, String> {
    let hosts = load()?;
    let groups: HashMap<String, String> = store::load_json(GROUPS_FILE)?;
    let config = tauri::async_runtime::spawn_blocking(move || {
        let (mut list, config_text) = read_config();
        let aliases: Vec<String> = list.iter().map(|h| h.alias.clone()).collect();
        let effectives = effective_map(&aliases, config_text);
        for h in &mut list {
            h.effective = effectives.get(&h.alias).cloned().flatten();
            if let Some(g) = groups.get(&h.alias) {
                h.group = g.clone();
            }
        }
        list
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(SshList { hosts, config })
}

/// Local login name — ssh falls back to it when no User applies (a common misconfiguration).
#[tauri::command]
pub fn ssh_local_user() -> String {
    std::env::var("USER").or_else(|_| std::env::var("USERNAME")).unwrap_or_default()
}

/// Private key candidates in ~/.ssh (files that have a matching .pub, or start with id_).
#[tauri::command]
pub fn ssh_keys() -> Vec<String> {
    let dir = ssh_dir();
    let mut keys: Vec<String> = std::fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().is_none_or(|e| e != "pub"))
        .filter(|p| {
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or_default();
            dir.join(format!("{name}.pub")).exists() || name.starts_with("id_")
        })
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    keys.sort();
    keys
}

/// Права на приватный ключ: ssh отказывается читать ключ, доступный не только владельцу (#86).
#[derive(Serialize)]
pub struct KeyPerms {
    /// ssh примет такой ключ
    pub ok: bool,
    /// кто лишний / какие права сейчас
    pub detail: String,
    /// что сделает «Исправить» (пустая строка — исправлять нечего или нечем)
    pub fix: String,
}

/// Unix: ssh требует, чтобы в ключ не могли смотреть группа и остальные.
#[cfg_attr(windows, allow(dead_code))]
fn unix_perm_problem(mode: u32) -> Option<String> {
    let extra = mode & 0o077;
    (extra != 0).then(|| format!("права {:03o}, доступ есть не только у владельца", mode & 0o777))
}

/// Windows: разбор `icacls` — кого в списке доступа ssh считает лишним.
/// Своя учётка, SYSTEM и администраторы разрешены, всё остальное (Users, Authenticated Users,
/// Everyone, другие пользователи) и даёт «UNPROTECTED PRIVATE KEY FILE».
#[cfg_attr(not(windows), allow(dead_code))]
fn icacls_extra(out: &str, me: &str) -> Vec<String> {
    let allowed = |t: &str| {
        let short = t.rsplit('\\').next().unwrap_or(t).trim();
        short.eq_ignore_ascii_case(me)
            || short.eq_ignore_ascii_case("SYSTEM")
            || short.eq_ignore_ascii_case("Administrators")
            || short.eq_ignore_ascii_case("Администраторы")
    };
    let mut extra = Vec::new();
    for line in out.lines() {
        // «путь TRUSTEE:(F)» в первой строке, дальше «        TRUSTEE:(RX)»; права могут идти списком
        let Some(cut) = line.rfind(":(") else { continue };
        let head = line[..cut].trim_end();
        // имя доверенного лица — последнее «слово» перед правами; путь с пробелами остаётся слева
        let trustee = match head.rfind('\\') {
            Some(i) => head[..i].rsplit(' ').next().map(|d| format!("{d}\\{}", &head[i + 1..])).unwrap_or_else(|| head.to_string()),
            None => head.rsplit(' ').next().unwrap_or(head).to_string(),
        };
        if trustee.is_empty() || allowed(&trustee) || extra.contains(&trustee) {
            continue;
        }
        extra.push(trustee);
    }
    extra
}

fn key_path(path: &str) -> Result<PathBuf, String> {
    let p = crate::editor::expand(path);
    if !p.is_file() {
        return Err(format!("нет файла {}", p.display()));
    }
    Ok(p)
}

/// Проверка прав на ключ перед подключением.
#[tauri::command]
pub fn ssh_key_perms(path: String) -> Result<KeyPerms, String> {
    let p = key_path(&path)?;
    #[cfg(windows)]
    {
        let me = ssh_local_user();
        let mut cmd = std::process::Command::new("icacls");
        cmd.arg(&p);
        process::no_console(&mut cmd);
        let out = cmd.output().map_err(|e| format!("icacls: {e}"))?;
        let text = String::from_utf8_lossy(&out.stdout).into_owned();
        let extra = icacls_extra(&text, &me);
        return Ok(if extra.is_empty() {
            KeyPerms { ok: true, detail: format!("доступ только у {me}, администраторов и SYSTEM"), fix: String::new() }
        } else {
            KeyPerms {
                ok: false,
                detail: format!("доступ есть ещё у: {}", extra.join(", ")),
                fix: format!("убрать из списка доступа {} и оставить только {me}", extra.join(", ")),
            }
        });
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&p).map_err(|e| e.to_string())?.permissions().mode();
        Ok(match unix_perm_problem(mode) {
            None => KeyPerms { ok: true, detail: format!("права {:03o}", mode & 0o777), fix: String::new() },
            Some(d) => KeyPerms { ok: false, detail: d, fix: "поставить права 600 (чтение и запись только владельцу)".into() },
        })
    }
}

/// Сузить права на ключ до тех, что принимает ssh.
#[tauri::command]
pub fn ssh_key_fix_perms(path: String) -> Result<KeyPerms, String> {
    let p = key_path(&path)?;
    #[cfg(windows)]
    {
        let me = ssh_local_user();
        let mut probe = std::process::Command::new("icacls");
        probe.arg(&p);
        process::no_console(&mut probe);
        let text = probe.output().map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default();
        let mut cmd = std::process::Command::new("icacls");
        // /inheritance:r убирает наследуемые записи, /grant:r оставляет полный доступ только себе,
        // /remove снимает явные записи остальных — после этого ssh берёт ключ
        cmd.arg(&p).arg("/inheritance:r").arg(format!("/grant:r{me}:F"));
        for t in icacls_extra(&text, &me) {
            cmd.arg(format!("/remove:g{t}")).arg(format!("/remove:d{t}"));
        }
        process::no_console(&mut cmd);
        let out = cmd.output().map_err(|e| format!("icacls: {e}"))?;
        if !out.status.success() {
            return Err(format!("icacls: {}", String::from_utf8_lossy(&out.stderr).trim()));
        }
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    }
    ssh_key_perms(path)
}

fn valid_user(u: &str) -> bool {
    // '@' is allowed: AD-style logins like user@domain (ssh splits the destination on the last '@')
    u.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '@')) && !u.starts_with('-')
}

/// Jump spec: [user@]host[:port][,...]
fn valid_jump(j: &str) -> bool {
    j.split(',').all(|hop| {
        let (user, rest) = hop.rsplit_once('@').map_or(("", hop), |(u, r)| (u, r));
        let host = rest.split(':').next().unwrap_or_default();
        valid_user(user) && valid_host(host)
    })
}

#[tauri::command]
pub fn ssh_save(host: SshHost, secret: Option<String>) -> Result<(), String> {
    if !store::valid_id(&host.id) {
        return Err("invalid id".into());
    }
    if !valid_host(&host.host) {
        return Err("некорректный адрес".into());
    }
    if !valid_user(&host.user) {
        return Err("некорректный пользователь".into());
    }
    if !host.jump.is_empty() && !valid_jump(&host.jump) {
        return Err("некорректный jump-хост (формат user@host:port)".into());
    }
    if host.identity_file.starts_with('-') {
        return Err("некорректный путь к ключу".into());
    }
    if host.auth == "keepass" && host.keepass_entry.is_empty() {
        return Err("выберите запись KeePass".into());
    }
    if host.auth == "passbolt" && host.passbolt_entry.is_empty() {
        return Err("выберите запись Passbolt".into());
    }
    if let Some(s) = secret.filter(|s| !s.is_empty()) {
        store::secret_set(&secret_key(&host.id), &s)?;
    }
    let mut list = load()?;
    match list.iter_mut().find(|h| h.id == host.id) {
        Some(h) => *h = host,
        None => list.push(host),
    }
    store::save_json(FILE, &list)
}

/// Put a ~/.ssh/config host into a group (empty = back to the comment / ungrouped).
#[tauri::command]
pub fn ssh_config_group(alias: String, group: String) -> Result<(), String> {
    let mut groups: HashMap<String, String> = store::load_json(GROUPS_FILE)?;
    let group = group.trim().to_string();
    if group.is_empty() {
        groups.remove(&alias);
    } else {
        groups.insert(alias, group);
    }
    store::save_json(GROUPS_FILE, &groups)
}

/// Rename a group everywhere: own profiles and ~/.ssh/config assignments. Hosts grouped only by a
/// `# group:` comment keep it (the ssh config is not edited); they get an override instead.
#[tauri::command]
pub fn ssh_group_rename(from: String, to: String) -> Result<(), String> {
    let to = to.trim().to_string();
    let mut list = load()?;
    for h in list.iter_mut().filter(|h| h.group == from) {
        h.group = to.clone();
    }
    store::save_json(FILE, &list)?;
    let mut groups: HashMap<String, String> = store::load_json(GROUPS_FILE)?;
    let hits: Vec<String> = parse_config()
        .into_iter()
        .filter(|h| groups.get(&h.alias).unwrap_or(&h.group) == &from)
        .map(|h| h.alias)
        .collect();
    for alias in hits {
        groups.insert(alias, to.clone());
    }
    groups.retain(|_, g| !g.is_empty());
    store::save_json(GROUPS_FILE, &groups)
}

#[tauri::command]
pub fn ssh_delete(id: String) -> Result<(), String> {
    let mut list = load()?;
    list.retain(|h| h.id != id);
    store::secret_delete(&secret_key(&id));
    store::save_json(FILE, &list)
}

#[derive(Serialize)]
pub struct SshSpec {
    program: String,
    args: Vec<String>,
    password_copied: bool,
}

/// What to run for a saved profile (`id`) or a ~/.ssh/config alias (`alias`).
#[tauri::command]
pub async fn ssh_connect(
    app: AppHandle,
    kp: State<'_, KeepassState>,
    pb: State<'_, PassboltState>,
    id: Option<String>,
    alias: Option<String>,
) -> Result<SshSpec, String> {
    if let Some(alias) = alias {
        if alias.starts_with('-') || !parse_config().iter().any(|h| h.alias == alias) {
            return Err("хост не найден в ~/.ssh/config".into());
        }
        return Ok(SshSpec { program: "ssh".into(), args: vec![alias], password_copied: false });
    }
    let id = id.ok_or("не указан хост")?;
    let h = load()?.into_iter().find(|h| h.id == id).ok_or("профиль не найден")?;
    let (user, pass) = match h.auth.as_str() {
        "keepass" => {
            let (u, p) = keepass::credentials(&kp, &h.keepass_entry, keepass::Use::User)?;
            (if h.user.is_empty() { u } else { h.user.clone() }, p)
        }
        "passbolt" => {
            let (u, p) = passbolt::credentials(&pb, &h.passbolt_entry, keepass::Use::User).await?;
            (if h.user.is_empty() { u } else { h.user.clone() }, p)
        }
        "password" => (h.user.clone(), store::secret_get(&secret_key(&h.id)).unwrap_or_default()),
        _ => (h.user.clone(), String::new()),
    };
    if !valid_user(&user) {
        return Err("некорректный пользователь в записи KeePass".into());
    }
    let args = profile_args(&h, &user);
    let copied = !pass.is_empty();
    if copied {
        keepass::copy_secret(&app, pass)?;
    }
    Ok(SshSpec { program: "ssh".into(), args, password_copied: copied })
}



/// ssh arguments for the monitoring board's probe: "id:<profile>" or "alias:<Host from ~/.ssh/config>".
/// Never asks KeePass or the keyring: the probe logs in by key or over an open session.
pub(crate) fn probe_args(target: &str) -> Result<Vec<String>, String> {
    if let Some(alias) = target.strip_prefix("alias:") {
        if alias.starts_with('-') || !parse_config().iter().any(|h| h.alias == alias) {
            return Err("хост не найден в ~/.ssh/config".into());
        }
        return Ok(vec![alias.to_string()]);
    }
    let id = target.strip_prefix("id:").ok_or("неизвестный хост")?;
    let h = load()?.into_iter().find(|h| h.id == id).ok_or("профиль не найден")?;
    Ok(profile_args(&h, &h.user))
}

fn profile_args(h: &SshHost, user: &str) -> Vec<String> {
    let mut args = vec!["-p".to_string(), h.port.to_string()];
    if !h.identity_file.is_empty() {
        args.extend(["-i".into(), h.identity_file.clone()]);
    }
    if !h.jump.is_empty() {
        args.extend(["-J".into(), h.jump.clone()]);
    }
    args.push(if user.is_empty() { h.host.clone() } else { format!("{user}@{}", h.host) });
    args
}

#[cfg(test)]
mod tests {
    /// Права на ключ: ssh отвергает ключ, доступный не только владельцу (#86). Разбор `icacls`
    /// проверяется на любой ОС — на Windows его видно только на самой Windows.
    #[test]
    fn a_key_others_can_read_is_reported() {
        assert_eq!(unix_perm_problem(0o600), None);
        assert_eq!(unix_perm_problem(0o400), None);
        assert!(unix_perm_problem(0o644).unwrap().contains("644"));
        assert!(unix_perm_problem(0o660).is_some());

        let out = "c:\\my\\id_rsa NT AUTHORITY\\SYSTEM:(F)\n                BUILTIN\\Administrators:(F)\n                DESKTOP-7\\alex:(F)\n                BUILTIN\\Users:(RX)\n                DESKTOP-7\\guest:(R)\n\nSuccessfully processed 1 files.\n";
        assert_eq!(icacls_extra(out, "alex"), vec!["BUILTIN\\Users", "DESKTOP-7\\guest"]);
        assert!(icacls_extra(out, "ALEX").iter().all(|t| t != "DESKTOP-7\\alex"), "своя учётка не лишняя");
        // только владелец, администраторы и SYSTEM — такой ключ ssh принимает
        let ok = "c:\\my\\id_rsa DESKTOP-7\\alex:(F)\n                NT AUTHORITY\\SYSTEM:(F)\n";
        assert!(icacls_extra(ok, "alex").is_empty());
        // путь с пробелами: имя доверенного лица не склеивается с путём
        let spaced = "C:\\my keys\\id_rsa BUILTIN\\Users:(RX)\n";
        assert_eq!(icacls_extra(spaced, "alex"), vec!["BUILTIN\\Users"]);
    }


    #[test]
    fn include_comments_and_proxycommand() {
        let dir = std::env::temp_dir().join(format!("opsdeck-ssh-include-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("conf.d")).unwrap();
        std::fs::write(dir.join("conf.d/10-prod.conf"), "# group: prod\nHost db-1\n  HostName 10.0.0.5 # primary\n  ProxyCommand ssh -W %h:%p bastion\nInclude ../main\n").unwrap();
        std::fs::write(dir.join("conf.d/20-stage.conf"), "Host stage-1 \"stage-2\"\n  User deploy\n").unwrap();
        std::fs::write(dir.join("conf.d/notes.txt"), "Host not-included\n").unwrap();
        let main = "Include conf.d/*.conf\nHost web-1\n  HostName web.example.com\n";
        std::fs::write(dir.join("main"), main).unwrap();
        let mut out = Vec::new();
        let mut seen = HashSet::new();
        seen.insert(dir.join("main").canonicalize().unwrap());
        parse_config_text_internal(main, Some(&dir), &mut out, &mut seen, &mut String::new(), 0);
        let names: Vec<&str> = out.iter().map(|h| h.alias.as_str()).collect();
        assert_eq!(names, ["db-1", "stage-1", "stage-2", "web-1"], "only *.conf, in order; the loop back to main is cut");
        let db = &out[0];
        assert_eq!((db.group.as_str(), db.hostname.as_str(), db.proxy_command.as_str()), ("prod", "10.0.0.5", "ssh -W %h:%p bastion"), "a trailing comment is not part of the value");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cache_key_covers_included_files() {
        let dir = std::env::temp_dir().join(format!("opsdeck-ssh-key-{}", std::process::id()));
        if dir.exists() {
            std::fs::remove_dir_all(&dir).unwrap();
        }
        std::fs::create_dir_all(dir.join("conf.d")).unwrap();
        let key = |main: &str| {
            let mut text = String::new();
            parse_config_text_internal(
                main,
                Some(&dir),
                &mut Vec::new(),
                &mut HashSet::new(),
                &mut text,
                0,
            );
            text
        };
        let main = "Include conf.d/*.conf\nHost web-1\n";
        std::fs::write(
            dir.join("conf.d/10-prod.conf"),
            "Host db-1\n  HostName 10.0.0.5\n",
        )
        .unwrap();
        let before = key(main);
        assert_eq!(key(main), before, "nothing changed");
        std::fs::write(
            dir.join("conf.d/10-prod.conf"),
            "Host db-1\n  HostName 10.0.0.6\n",
        )
        .unwrap();
        let edited = key(main);
        assert_ne!(edited, before, "an included file edited");
        std::fs::write(dir.join("conf.d/20-stage.conf"), "Host stage-1\n").unwrap();
        assert_ne!(key(main), edited, "a file matching Include added");

        std::fs::write(dir.join("x"), "User u\n").unwrap();
        let split = key("Include x\nHost a\n");
        std::fs::write(dir.join("x"), "").unwrap();
        assert_ne!(key("Include x\nHost a\nUser u\n"), split, "a line moved between files");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn board_probe_args() {
        let h = SshHost {
            id: "a".into(), name: "web".into(), group: String::new(), host: "192.0.2.1".into(), port: 2222, user: "ops".into(),
            identity_file: "~/.ssh/id".into(), jump: "bastion".into(), auth: "keepass".into(), keepass_entry: "k".into(),
            passbolt_entry: String::new(),
        };
        assert_eq!(profile_args(&h, &h.user), ["-p", "2222", "-i", "~/.ssh/id", "-J", "bastion", "ops@192.0.2.1"]);
        assert_eq!(profile_args(&SshHost { identity_file: String::new(), jump: String::new(), ..h.clone() }, "").last().unwrap(), "192.0.2.1");
        assert!(probe_args("alias:-oProxyCommand=x").is_err());
        assert!(probe_args("rm -rf").is_err());
    }
    use super::*;

    const CONFIG: &str = "
# group: prod
Host bastion bastion-alt
    HostName bastion.example.com
    User ops
    Port 2222
    IdentityFile ~/.ssh/id_ed25519

Host app-1
    HostName=198.51.100.11
    ProxyJump bastion
    User deploy
    User ignored-second-value

Host *.internal !secret
    User wildcard

Match host foo
    User from-match

host lower
  hostname lower.example.com
";

    #[test]
    fn config_hosts() {
        let hosts = parse_config_text(CONFIG);
        let names: Vec<_> = hosts.iter().map(|h| h.alias.as_str()).collect();
        assert_eq!(names, ["bastion", "bastion-alt", "app-1", "lower"], "patterns are skipped");
        let b = &hosts[0];
        assert_eq!((b.hostname.as_str(), b.user.as_str(), b.port.as_str()), ("bastion.example.com", "ops", "2222"));
        assert_eq!(b.group, "prod", "# group: comment above Host");
        assert_eq!(hosts[1].hostname, "bastion.example.com", "settings apply to every alias of the line");
        assert_eq!(hosts[1].group, "prod");
        let app = &hosts[2];
        assert_eq!(app.hostname, "198.51.100.11", "key=value form");
        assert_eq!(app.user, "deploy", "first value wins, like ssh");
        assert_eq!(app.proxy_jump, "bastion");
        assert_eq!(app.group, "", "the group comment is used once");
        assert_eq!(hosts[3].hostname, "lower.example.com", "keywords are case-insensitive");
        assert_eq!(hosts[3].user, "", "Match blocks do not leak into the next Host");
    }

    fn fake(alias: &str) -> Option<Effective> {
        (!alias.ends_with('7')).then(|| Effective {
            user: format!("u-{alias}"),
            port: alias.len().to_string(),
            ..Default::default()
        })
    }

    #[test]
    fn parallel_matches_sequential() {
        let aliases: Vec<String> = (0..100).map(|i| format!("host-{i}")).collect();
        let threads = Mutex::new(HashSet::new());
        let got = resolve_parallel(&aliases, |a| {
            threads.lock().unwrap().insert(std::thread::current().id());
            std::thread::sleep(std::time::Duration::from_millis(2));
            fake(a)
        });
        let want: Vec<_> = aliases.iter().map(|a| Some(fake(a))).collect();
        let key = |v: &[Option<Option<Effective>>]| -> Vec<Option<Option<(String, String)>>> {
            v.iter()
                .map(|o| {
                    o.as_ref()
                        .map(|e| e.as_ref().map(|e| (e.user.clone(), e.port.clone())))
                })
                .collect()
        };
        assert_eq!(
            key(&got),
            key(&want),
            "same values in the same order, failures stay None"
        );
        let used = threads.lock().unwrap().len();
        assert!((2..=SSH_G_THREADS).contains(&used), "{used} threads");
        assert!(resolve_parallel(&[], fake).is_empty());
    }

    #[test]
    fn users_and_jumps() {
        assert!(valid_user("deploy"));
        assert!(valid_user("user@CORP.example"), "AD-style logins");
        assert!(!valid_user("-oProxyCommand=x"), "no option injection");
        assert!(!valid_user("a b"));
        assert!(!valid_user("a;rm"));
        assert!(valid_jump("bastion"));
        assert!(valid_jump("ops@bastion.example.com:2222,deploy@10.0.0.1"));
        assert!(!valid_jump("-J evil"));
        assert!(!valid_jump("ops@host;id"));
    }
}
