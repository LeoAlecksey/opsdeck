//! SSH host profiles: OpsDeck's own list (~/.config/opsdeck/ssh.json, secrets in keyring/KeePass)
//! plus read-only hosts from ~/.ssh/config. Connecting opens `ssh` in a terminal tab; a known
//! password goes to the clipboard for 30 s (ssh itself only reads passwords from the tty).

use crate::{
    keepass::{self, KeepassState},
    process, store,
    tools::valid_host,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Mutex,
    time::SystemTime,
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

/// Concrete `Host` entries of ~/.ssh/config (patterns with * ? ! are skipped; Include is not followed).
fn parse_config() -> Vec<ConfigHost> {
    let Ok(raw) = std::fs::read_to_string(ssh_dir().join("config")) else { return Vec::new() };
    parse_config_text(&raw)
}

fn parse_config_text(raw: &str) -> Vec<ConfigHost> {
    let mut out: Vec<ConfigHost> = Vec::new();
    let mut current: Vec<usize> = Vec::new();
    let mut comment_group = String::new();
    for line in raw.lines() {
        let line = line.trim();
        if let Some(c) = line.strip_prefix('#') {
            let c = c.trim();
            if let Some(g) = c.strip_prefix("group:").or_else(|| c.strip_prefix("Group:")) {
                comment_group = g.trim().to_string();
            }
            continue;
        }
        if line.is_empty() {
            continue;
        }
        let (key, value) = match line.split_once(|c: char| c.is_whitespace() || c == '=') {
            Some((k, v)) => (k.to_lowercase(), v.trim_start_matches(|c: char| c.is_whitespace() || c == '=').trim().to_string()),
            None => continue,
        };
        match key.as_str() {
            "host" => {
                current.clear();
                for alias in value.split_whitespace().filter(|a| !a.contains(['*', '?', '!'])) {
                    current.push(out.len());
                    out.push(ConfigHost { alias: alias.into(), group: comment_group.clone(), ..Default::default() });
                }
                comment_group.clear();
            }
            "match" => {
                current.clear();
                comment_group.clear();
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
                        _ => continue,
                    };
                    if slot.is_empty() {
                        *slot = value.clone();
                    }
                }
            }
        }
    }
    out
}

#[derive(Serialize, Clone, Default)]
pub struct Effective {
    user: String,
    hostname: String,
    port: String,
    identity_files: Vec<String>,
    proxy_jump: String,
}

/// Cache of `ssh -G` keyed by ~/.ssh/config mtime — otherwise every ssh_list spawns ssh.exe per alias.
type EffectiveCache = (Option<SystemTime>, HashMap<String, Option<Effective>>);
static EFFECTIVE_CACHE: Mutex<Option<EffectiveCache>> = Mutex::new(None);

fn config_mtime() -> Option<SystemTime> {
    std::fs::metadata(ssh_dir().join("config"))
        .and_then(|m| m.modified())
        .ok()
}

/// What ssh will really use for an alias. No network access: `-G` only evaluates the config.
fn effective(alias: &str) -> Option<Effective> {
    let mut cmd = std::process::Command::new("ssh");
    cmd.args(["-G", alias])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    // without this, Windows flashes an OpenSSH console for every alias
    process::no_console(&mut cmd);
    let out = cmd.output().ok()?;
    if !out.status.success() {
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
            _ => {}
        }
    }
    Some(e)
}

fn effective_map(aliases: &[String]) -> HashMap<String, Option<Effective>> {
    let mtime = config_mtime();
    if let Ok(cache) = EFFECTIVE_CACHE.lock() {
        if let Some((cached_mtime, map)) = cache.as_ref() {
            if *cached_mtime == mtime && aliases.iter().all(|a| map.contains_key(a)) {
                return map.clone();
            }
        }
    }
    let map: HashMap<String, Option<Effective>> = aliases
        .iter()
        .map(|a| (a.clone(), effective(a)))
        .collect();
    if let Ok(mut cache) = EFFECTIVE_CACHE.lock() {
        *cache = Some((mtime, map.clone()));
    }
    map
}

#[tauri::command]
pub async fn ssh_list() -> Result<SshList, String> {
    let hosts = load()?;
    let groups: HashMap<String, String> = store::load_json(GROUPS_FILE)?;
    let config = tauri::async_runtime::spawn_blocking(move || {
        let mut list = parse_config();
        let aliases: Vec<String> = list.iter().map(|h| h.alias.clone()).collect();
        let effectives = effective_map(&aliases);
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
pub fn ssh_connect(app: AppHandle, kp: State<KeepassState>, id: Option<String>, alias: Option<String>) -> Result<SshSpec, String> {
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
            let (u, p) = keepass::credentials(&kp, &h.keepass_entry)?;
            (if h.user.is_empty() { u } else { h.user.clone() }, p)
        }
        "password" => (h.user.clone(), store::secret_get(&secret_key(&h.id)).unwrap_or_default()),
        _ => (h.user.clone(), String::new()),
    };
    if !valid_user(&user) {
        return Err("некорректный пользователь в записи KeePass".into());
    }
    let mut args = vec!["-p".to_string(), h.port.to_string()];
    if !h.identity_file.is_empty() {
        args.extend(["-i".into(), h.identity_file.clone()]);
    }
    if !h.jump.is_empty() {
        args.extend(["-J".into(), h.jump.clone()]);
    }
    args.push(if user.is_empty() { h.host.clone() } else { format!("{user}@{}", h.host) });
    let copied = !pass.is_empty();
    if copied {
        keepass::copy_secret(&app, pass)?;
    }
    Ok(SshSpec { program: "ssh".into(), args, password_copied: copied })
}



#[cfg(test)]
mod tests {
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
