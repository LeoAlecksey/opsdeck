//! VK Cloud через OpenStack SDK: виртуальные машины, сети и доступы. Вход — запись в
//! `~/.config/openstack/clouds.yaml` пользователя. Запросы выполняет постоянный SDK-процесс; для биллинга
//! OpsDeck получает временный токен в память и читает auth_url для выбора региона. Пароли,
//! токены и application credentials на диск не записываются. CLI используется для проверки установки.

use crate::process;
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

const CLI_TIMEOUT: Duration = Duration::from_secs(60);
const FORBIDDEN_MESSAGE: &str = "нет прав на эту операцию у текущего проекта";

// Drain both pipes while waiting; dropping a timed-out child kills and reaps it via Tokio.
fn cli_output(cmd: Command, timeout: Duration) -> std::io::Result<std::process::Output> {
    type CliResult = Result<std::process::Output, (std::io::ErrorKind, String)>;
    static PENDING: std::sync::OnceLock<PendingRequests<CliResult>> = std::sync::OnceLock::new();
    let key = format!("{cmd:?}|{timeout:?}");
    match join_request(PENDING.get_or_init(Default::default), key, || {
        Ok(cli_output_request(cmd, timeout).map_err(|e| (e.kind(), e.to_string())))
    }) {
        Ok(Ok(output)) => Ok(output),
        Ok(Err((kind, message))) => Err(std::io::Error::new(kind, message)),
        Err(message) => Err(std::io::Error::other(message)),
    }
}

fn cli_output_request(cmd: Command, timeout: Duration) -> std::io::Result<std::process::Output> {
    let log_id = crate::vkcs_log::start(&cmd);
    let result = tauri::async_runtime::block_on(async move {
        let mut cmd = tokio::process::Command::from(cmd);
        cmd.kill_on_drop(true);
        tokio::time::timeout(timeout, cmd.output())
            .await
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "openstack: превышено время ожидания"))?
    });
    crate::vkcs_log::finish(log_id, &result);
    result
}

/// Имена облаков в clouds.yaml и UUID проектов.
fn valid_name(id: &str) -> bool {
    !id.is_empty() && id.len() <= 200 && !id.starts_with('-') && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

fn valid_uuid(id: &str) -> bool {
    (id.len() == 36 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') && id.chars().filter(|c| *c == '-').count() == 4)
        || (id.len() == 32 && id.chars().all(|c| c.is_ascii_hexdigit()))
}

fn check_name(id: &str) -> Result<&str, String> {
    valid_name(id).then_some(id).ok_or_else(|| format!("недопустимое имя облака: {id}"))
}

fn check_uuid(id: &str) -> Result<&str, String> {
    valid_uuid(id).then_some(id).ok_or_else(|| format!("недопустимый идентификатор проекта: {id}"))
}

/// Единый вид пути в UI (на Windows — только `\`).
fn path_display(p: &Path) -> String {
    let s = p.to_string_lossy();
    #[cfg(windows)]
    {
        return s.replace('/', "\\");
    }
    #[cfg(not(windows))]
    {
        s.into_owned()
    }
}

fn openstack_candidates(home: &Path, windows: bool) -> Vec<PathBuf> {
    let name = if windows { "openstack.exe" } else { "openstack" };
    let mut out = Vec::new();
    if windows {
        for ver in ["Python313", "Python312", "Python311", "Python310", "Python39"] {
            out.push(home.join(format!("AppData/Local/Programs/Python/{ver}/Scripts")).join(name));
            out.push(home.join(format!("AppData/Roaming/Python/{ver}/Scripts")).join(name));
        }
        out.push(home.join("AppData/Local/Programs/Python/Scripts").join(name));
    } else {
        out.extend([".local/bin", "bin"].iter().map(|d| home.join(d).join(name)));
        out.extend(["/usr/local/bin", "/usr/bin", "/snap/bin"].iter().map(|d| Path::new(d).join(name)));
    }
    out
}

fn pick_bin(candidates: &[PathBuf], ok: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    candidates.iter().find(|p| ok(p)).cloned()
}

const CFG_FILE: &str = "vkcs.json";
static CONFIG_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn update_cfg(edit: impl FnOnce(&mut VkcsCfg)) -> Result<(), String> {
    let _guard = CONFIG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut cfg: VkcsCfg = crate::store::load_json(CFG_FILE).unwrap_or_default();
    edit(&mut cfg);
    crate::store::save_json(CFG_FILE, &cfg)
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct VkcsCfg {
    path: String,
    cloud: String,
    project_id: String,
    #[serde(default)]
    project_lists: std::collections::BTreeMap<String, Vec<Named>>,
    #[serde(default)]
    flavor_cache: std::collections::BTreeMap<String, std::collections::BTreeMap<String, std::collections::HashMap<String, FlavorEntry>>>,
    /// путь к clouds.yaml, если лежит не в ~/.config/openstack/
    clouds_yaml: String,
    /// PID вида mcs0123456789 для Billing API, если имя проекта OpenStack не совпадает с PID
    #[serde(default)]
    billing_pids: std::collections::BTreeMap<String, String>,
}

fn clouds_yaml_candidates(home: &Path) -> Vec<PathBuf> {
    let mut out = vec![
        home.join(".config").join("openstack").join("clouds.yaml"),
        home.join(".config").join("openstack").join("clouds.yml"),
    ];
    if cfg!(windows) {
        if let Ok(appdata) = std::env::var("APPDATA") {
            out.push(PathBuf::from(appdata).join("openstack").join("clouds.yaml"));
        }
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            out.push(PathBuf::from(local).join("openstack").join("clouds.yaml"));
        }
    }
    out.push(PathBuf::from("/etc/openstack/clouds.yaml"));
    out
}

fn default_clouds_yaml_hint() -> String {
    dirs::home_dir()
        .map(|h| path_display(&h.join(".config").join("openstack").join("clouds.yaml")))
        .unwrap_or_else(|| "~/.config/openstack/clouds.yaml".into())
}

fn clouds_yaml_path() -> Option<PathBuf> {
    let saved: VkcsCfg = crate::store::load_json(CFG_FILE).unwrap_or_default();
    if !saved.clouds_yaml.is_empty() {
        let p = crate::editor::expand(saved.clouds_yaml.trim());
        if p.is_file() {
            return Some(p);
        }
    }
    if let Ok(env) = std::env::var("OS_CLIENT_CONFIG_FILE") {
        let p = PathBuf::from(env.trim());
        if p.is_file() {
            return Some(p);
        }
    }
    let home = dirs::home_dir()?;
    clouds_yaml_candidates(&home).into_iter().find(|p| p.is_file())
}

/// Имена верхнего уровня `clouds:` — без чтения auth и паролей наружу.
pub fn cloud_names_from_yaml(text: &str) -> Vec<String> {
    let v: serde_yaml_ng::Value = match serde_yaml_ng::from_str(text) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    v.get("clouds")
        .and_then(|c| c.as_mapping())
        .map(|m| m.keys().filter_map(|k| k.as_str()).filter(|n| valid_name(n)).map(str::to_string).collect())
        .unwrap_or_default()
}

fn openstack_bin() -> PathBuf {
    let saved: VkcsCfg = crate::store::load_json(CFG_FILE).unwrap_or_default();
    if !saved.path.is_empty() && crate::store::is_executable(Path::new(&saved.path)) {
        return saved.path.into();
    }
    let name = if cfg!(windows) { "openstack.exe" } else { "openstack" };
    let in_path = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .map(|d| d.join(name))
        .find(|p| crate::store::is_executable(p));
    in_path
        .or_else(|| {
            pick_bin(
                &openstack_candidates(&dirs::home_dir().unwrap_or_default(), cfg!(windows)),
                crate::store::is_executable,
            )
        })
        .unwrap_or_else(|| name.into())
}

fn str_field(v: &Value, keys: &[&str]) -> String {
    for k in keys {
        if let Some(s) = v.get(k).and_then(Value::as_str) {
            return s.to_string();
        }
    }
    String::new()
}

fn explain_fail(stdout: &str, stderr: &str) -> String {
    let stderr = stderr.trim();
    let stdout = stdout.trim();
    let text = if stderr.is_empty() { stdout } else { stderr };
    explain(text)
}

fn explain(stderr: &str) -> String {
    let line = stderr.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("openstack не ответил");
    let low = line.to_lowercase();
    if low.contains("could not find") && low.contains("openstack") || low.contains("not found") && low.contains("openstack") {
        return "openstack не найден — установите python-openstackclient (pip install python-openstackclient) или укажите путь к файлу кнопкой ниже".into();
    }
    if low.contains("401") || low.contains("unauthorized") || low.contains("authentication failed") || low.contains("invalid credentials") {
        return "нет входа в VK Cloud — проверьте clouds.yaml (пароль или application credential) или выполните source openrc.sh в терминале".into();
    }
    if low.contains("403") || low.contains("forbidden") || low.contains("permission") {
        return FORBIDDEN_MESSAGE.into();
    }
    if low.contains("404") || (low.contains("not found") && !low.contains("clouds.yaml") && !low.contains("cloud ")) {
        return "объект не найден — возможно, выбран другой проект или регион".into();
    }
    if low.contains("clouds.yaml") {
        if low.contains("could not find")
            || low.contains("no such file")
            || low.contains("unable to find")
            || low.contains("does not exist")
            || (low.contains("not found") && (low.contains("config") || low.contains("file")))
        {
            return format!(
                "OpenStack не находит clouds.yaml — положите файл в {} или укажите путь кнопкой «Путь к clouds.yaml…»",
                default_clouds_yaml_hint()
            );
        }
        if low.contains("cloud") && (low.contains("was not found") || low.contains("unknown") || low.contains("no cloud")) {
            return format!("имя облака (--os-cloud) не найдено в clouds.yaml: {line}");
        }
        return format!("ошибка конфигурации clouds.yaml: {line}");
    }
    if low.contains("no cloud") {
        return format!("имя облака (--os-cloud) не найдено в clouds.yaml: {line}");
    }
    line.chars().take(300).collect()
}

#[derive(Clone)]
struct OsCtx {
    cloud: String,
    project_id: String,
}

/// Несколько процессов openstack параллельно — на Windows каждый старт Python дорогой, но три подряд ещё дольше.
fn openstack_json_parallel(ctx: &OsCtx, args_list: &[&[&str]]) -> Vec<Result<Value, String>> {
    parallel_queries(args_list, |args| openstack_json(args, ctx))
}

fn parallel_queries(args_list: &[&[&str]], query: impl Fn(&[&str]) -> Result<Value, String> + Sync) -> Vec<Result<Value, String>> {
    std::thread::scope(|scope| {
        let handles: Vec<_> = args_list
            .iter()
            .map(|args| {
                let query = &query;
                scope.spawn(move || query(args))
            })
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().unwrap_or_else(|_| Err("не удалось получить ответ openstack".into())))
            .collect()
    })
}

struct PendingRequest<T> {
    result: std::sync::Mutex<Option<Result<T, String>>>,
    ready: std::sync::Condvar,
}
impl<T> Default for PendingRequest<T> {
    fn default() -> Self {
        Self { result: std::sync::Mutex::new(None), ready: std::sync::Condvar::new() }
    }
}
type PendingRequests<T> = std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<PendingRequest<T>>>>;
static PENDING_REQUESTS: std::sync::OnceLock<PendingRequests<String>> = std::sync::OnceLock::new();

fn join_request<T: Clone>(pending: &PendingRequests<T>, key: String, run: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let (request, owner) = {
        let mut pending = pending.lock().unwrap_or_else(|e| e.into_inner());
        match pending.entry(key.clone()) {
            std::collections::hash_map::Entry::Occupied(entry) => (entry.get().clone(), false),
            std::collections::hash_map::Entry::Vacant(entry) => {
                let request = std::sync::Arc::new(PendingRequest::default());
                entry.insert(request.clone());
                (request, true)
            }
        }
    };
    if !owner {
        let mut result = request.result.lock().unwrap_or_else(|e| e.into_inner());
        while result.is_none() {
            result = request.ready.wait(result).unwrap_or_else(|e| e.into_inner());
        }
        return result.as_ref().unwrap().clone();
    }
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(run))
        .unwrap_or_else(|_| Err("OpenStack: запрос прерван".into()));
    *request.result.lock().unwrap_or_else(|e| e.into_inner()) = Some(result.clone());
    request.ready.notify_all();
    pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&key);
    result
}

fn openstack(args: &[&str], ctx: &OsCtx) -> Result<String, String> {
    let config = clouds_yaml_path();
    let stamp = config.as_ref().and_then(|p| std::fs::metadata(p).ok()).and_then(|m| m.modified().ok());
    let key = format!("{:?}|{:?}|{:?}|{}|{}|{:?}", openstack_bin(), config, stamp, ctx.cloud, ctx.project_id, args);
    join_request(PENDING_REQUESTS.get_or_init(Default::default), key, || openstack_request(args, ctx))
}

fn openstack_request(args: &[&str], ctx: &OsCtx) -> Result<String, String> {
    let mut cmd = Command::new(openstack_bin());
    cmd.args(["--os-cloud", &ctx.cloud]);
    if !ctx.project_id.is_empty() {
        cmd.args(["--os-project-id", &ctx.project_id]);
    }
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(cfg) = clouds_yaml_path() {
        cmd.env("OS_CLIENT_CONFIG_FILE", cfg);
    }
    process::no_console(&mut cmd);
    // Preserve the pasteable CLI equivalent in history, never SDK payloads/tokens.
    let log_id = crate::vkcs_log::start_sdk(&cmd);
    let clean_args = args.strip_suffix(&["-f", "json"]).unwrap_or(args);
    let result = crate::vkcs_sdk::query(&openstack_bin(), clouds_yaml_path().as_deref(),
        &ctx.cloud, &ctx.project_id, clean_args, CLI_TIMEOUT);
    crate::vkcs_log::finish_sdk(log_id, &result);
    match result {
        Ok(Value::String(text)) => Ok(text),
        Ok(value) => serde_json::to_string(&value).map_err(|e| e.to_string()),
        Err(error) => Err(format!("{}: {}", clean_args.join(" "), explain(&error))),
    }
}

fn openstack_json(args: &[&str], ctx: &OsCtx) -> Result<Value, String> {
    // -f json после подкоманды: иначе на Windows openstack воспринимает «-f json …» как имя команды
    let mut a = args.to_vec();
    a.extend_from_slice(&["-f", "json"]);
    let text = openstack(&a, ctx)?;
    if text.trim().is_empty() {
        return Ok(Value::Array(vec![]));
    }
    serde_json::from_str(&text).map_err(|e| format!("openstack вернул не JSON: {e}"))
}

fn map_status(s: &str) -> String {
    match s {
        "ACTIVE" => "RUNNING".into(),
        "SHUTOFF" => "STOPPED".into(),
        other => other.to_string(),
    }
}

/// Разбор колонки Networks: «private=10.0.0.4» или «net=10.0.0.1, 203.0.113.2».
fn parse_networks_col(s: &str) -> (String, String) {
    let mut ips: Vec<String> = Vec::new();
    for part in s.split(',') {
        let part = part.trim();
        let ip = part.split_once('=').map(|(_, ip)| ip.trim()).unwrap_or(part);
        if ip.contains('.') || ip.contains(':') {
            ips.push(ip.to_string());
        }
    }
    let internal = ips.first().cloned().unwrap_or_default();
    let public = if ips.len() > 1 { ips[1].clone() } else { String::new() };
    (internal, public)
}

#[tauri::command]
pub async fn vkcs_set_path(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = crate::editor::expand(path.trim());
        if !crate::store::is_executable(&p) {
            return Err(format!("это не исполняемый файл: {}", p.display()));
        }
        let mut cmd = Command::new(&p);
        cmd.arg("--version").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        process::no_console(&mut cmd);
        let out = cli_output(cmd, CLI_TIMEOUT).map_err(|e| format!("не удалось запустить {}: {e}", p.display()))?;
        if !out.status.success() {
            return Err(format!("{} не отвечает на «--version»", p.display()));
        }
        update_cfg(|cfg| {
            cfg.path = p.to_string_lossy().into_owned();
        })
    })
    .await
    .map_err(crate::store::err)?
}

#[tauri::command]
pub async fn vkcs_set_clouds_yaml(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = crate::editor::expand(path.trim());
        if !p.is_file() {
            return Err(format!("файл не найден: {}", p.display()));
        }
        let text = std::fs::read_to_string(&p).map_err(|e| format!("не прочитать {}: {e}", p.display()))?;
        if cloud_names_from_yaml(&text).is_empty() {
            return Err("в файле нет секции clouds или ни одно имя облака не распознано".into());
        }
        update_cfg(|cfg| {
            cfg.clouds_yaml = path_display(&p);
        })
    })
    .await
    .map_err(crate::store::err)?
}

#[derive(Serialize, Default)]
pub struct Status {
    pub found: bool,
    pub version: String,
    /// выбранное имя из clouds.yaml (только в vkcs.json, CLI глобально не меняем)
    pub cloud: String,
    pub clouds: Vec<String>,
    pub project_id: String,
    pub projects: Vec<Named>,
    pub error: String,
    pub bin: String,
    /// какой clouds.yaml используем (если найден)
    pub config_path: String,
}

#[tauri::command]
pub async fn vkcs_status() -> Status {
    tauri::async_runtime::spawn_blocking(|| {
        let saved: VkcsCfg = crate::store::load_json(CFG_FILE).unwrap_or_default();
        let mut s = Status {
            bin: openstack_bin().to_string_lossy().into_owned(),
            cloud: saved.cloud.clone(),
            project_id: saved.project_id.clone(),
            projects: saved.project_lists.get(&saved.cloud).cloned().unwrap_or_default(),
            ..Default::default()
        };
        let mut cmd = Command::new(openstack_bin());
        cmd.arg("--version").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        process::no_console(&mut cmd);
        match cli_output(cmd, CLI_TIMEOUT) {
            Ok(out) if out.status.success() => {
                s.found = true;
                s.version = String::from_utf8_lossy(&out.stdout).lines().next().unwrap_or("").trim().to_string();
            }
            Ok(out) => {
                s.error = explain_fail(
                    &String::from_utf8_lossy(&out.stdout),
                    &String::from_utf8_lossy(&out.stderr),
                );
                return s;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                s.error = "openstack не найден — установите python-openstackclient (pip install python-openstackclient) или укажите путь к файлу кнопкой ниже".into();
                return s;
            }
            Err(e) => {
                s.error = format!("не удалось запустить openstack: {e}");
                return s;
            }
        }
        let yaml = clouds_yaml_path();
        if let Some(p) = &yaml {
            s.config_path = path_display(p);
            if let Ok(text) = std::fs::read_to_string(p) {
                s.clouds = cloud_names_from_yaml(&text);
            }
        }
        if s.clouds.is_empty() {
            s.error = if yaml.is_some() {
                format!(
                    "файл {} найден, но в нём нет секции clouds или имя облака не распознано (латиница, цифры, дефис, подчёркивание, точка). Скачайте openrc в ЛК VK Cloud и перенесите поля в clouds.yaml — см. документацию CLI",
                    s.config_path
                )
            } else {
                format!(
                    "не найден clouds.yaml — создайте {} (или укажите путь кнопкой «Путь к clouds.yaml…»). OpenRC из ЛК — не замена: нужен yaml с секцией clouds:",
                    default_clouds_yaml_hint()
                )
            };
        } else if s.cloud.is_empty() || !s.clouds.contains(&s.cloud) {
            s.cloud = s.clouds[0].clone();
            s.project_id.clear();
            s.projects.clear();
        }
        s
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
pub async fn vkcs_use_cloud(name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        check_name(&name)?;
        update_cfg(|cfg| {
            if cfg.cloud != name { cfg.project_id.clear(); }
            cfg.cloud = name;
        })
    })
    .await
    .map_err(crate::store::err)?
}

#[tauri::command]
pub async fn vkcs_use_project(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !id.is_empty() {
            check_uuid(&id)?;
        }
        update_cfg(|cfg| {
            cfg.project_id = id;
        })
    })
    .await
    .map_err(crate::store::err)?
}

#[derive(Serialize, serde::Deserialize, Clone, PartialEq, Debug)]
pub struct Named {
    pub id: String,
    pub name: String,
    pub parent: String,
    pub description: String,
}

fn parse_named_projects(v: &Value) -> Vec<Named> {
    v.as_array()
        .map(|a| {
            a.iter()
                .map(|x| Named {
                    id: str_field(x, &["ID", "Id", "id"]),
                    name: str_field(x, &["Name", "name"]),
                    parent: String::new(),
                    description: str_field(x, &["Description", "description"]),
                })
                .collect()
        })
        .unwrap_or_default()
}

#[tauri::command]
pub async fn vkcs_clouds() -> Result<Vec<Named>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let p = clouds_yaml_path().ok_or_else(|| "нет ~/.config/openstack/clouds.yaml".to_string())?;
        let text = std::fs::read_to_string(&p).map_err(|e| format!("не прочитать clouds.yaml: {e}"))?;
        Ok(cloud_names_from_yaml(&text)
            .into_iter()
            .map(|n| Named {
                id: n.clone(),
                name: n,
                parent: String::new(),
                description: String::new(),
            })
            .collect())
    })
    .await
    .map_err(crate::store::err)?
}

#[tauri::command]
pub async fn vkcs_projects(cloud: String) -> Result<Vec<Named>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ctx = OsCtx {
            cloud: check_name(&cloud)?.to_string(),
            project_id: String::new(),
        };
        let projects = openstack_json(&["project", "list"], &ctx).map(|v| parse_named_projects(&v))?;
        update_cfg(|cfg| { cfg.project_lists.insert(cloud, projects.clone()); })?;
        Ok(projects)
    })
    .await
    .map_err(crate::store::err)?
}

#[tauri::command]
pub async fn vkcs_project(cloud: String, project_id: String) -> Result<Named, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ctx = OsCtx {
            cloud: check_name(&cloud)?.to_string(),
            project_id: check_uuid(&project_id)?.to_string(),
        };
        let value = openstack_json(&["project", "show", &project_id], &ctx)?;
        let name = str_field(&value, &["name", "Name"]);
        if name.is_empty() { return Err("OpenStack не вернул имя проекта".into()); }
        let project = Named { id: project_id, name, parent: String::new(), description: String::new() };
        update_cfg(|cfg| {
            let projects = cfg.project_lists.entry(cloud).or_default();
            if let Some(saved) = projects.iter_mut().find(|p| p.id == project.id) {
                *saved = project.clone();
            } else { projects.push(project.clone()); }
        })?;
        Ok(project)
    }).await.map_err(crate::store::err)?
}

#[derive(Serialize, PartialEq, Debug)]
pub struct Instance {
    pub id: String,
    pub name: String,
    pub status: String,
    pub zone: String,
    pub platform: String,
    pub flavor_id: String,
    pub cores: u64,
    pub memory: u64,
    pub core_fraction: u64,
    pub preemptible: bool,
    pub internal_ip: String,
    pub public_ip: String,
    pub subnet_id: String,
}

fn flavor_map(v: &Value) -> std::collections::HashMap<String, (String, u64, u64)> {
    let mut m = std::collections::HashMap::new();
    if let Some(a) = v.as_array() {
        for x in a {
            let id = str_field(x, &["ID", "Id", "id"]);
            let name = str_field(x, &["Name", "name"]);
            let ram_mb = str_field(x, &["RAM", "Ram", "ram"])
                .parse::<u64>()
                .ok()
                .or_else(|| x.get("RAM").and_then(|n| n.as_u64()))
                .unwrap_or(0);
            let vcpus = str_field(x, &["VCPUs", "Vcpus", "vcpus"])
                .parse::<u64>()
                .ok()
                .or_else(|| x.get("VCPUs").and_then(|n| n.as_u64()))
                .unwrap_or(0);
            if !id.is_empty() {
                m.insert(id, (name, vcpus, ram_mb * 1024 * 1024));
            }
        }
    }
    m
}

fn floating_by_fixed(v: &Value) -> std::collections::HashMap<String, String> {
    let mut m = std::collections::HashMap::new();
    if let Some(a) = v.as_array() {
        for x in a {
            let fixed = str_field(x, &["Fixed IP Address", "fixed_ip_address", "Fixed IP"]);
            let floating = str_field(x, &["Floating IP Address", "floating_ip_address", "Floating IP"]);
            if !fixed.is_empty() && !floating.is_empty() {
                m.insert(fixed, floating);
            }
        }
    }
    m
}

fn parse_instances(
    v: &Value,
    flavors: &std::collections::HashMap<String, (String, u64, u64)>,
    float_map: &std::collections::HashMap<String, String>,
) -> Vec<Instance> {
    v.as_array()
        .map(|a| {
            a.iter()
                .map(|x| {
                    let id = str_field(x, &["ID", "Id", "id"]);
                    let name = str_field(x, &["Name", "name"]);
                    let status = map_status(&str_field(x, &["Status", "status"]));
                    let zone = str_field(x, &["Availability Zone", "availability_zone", "AZ"]);
                    let flavor_key = str_field(x, &["Flavor", "flavor"]);
                    let (platform, cores, memory) = flavors
                        .get(&flavor_key)
                        .cloned()
                        .or_else(|| flavors.values().find(|(n, _, _)| n == &flavor_key).cloned())
                        .unwrap_or((flavor_key.clone(), 0, 0));
                    let nets = str_field(x, &["Networks", "networks"]);
                    let (internal_ip, mut public_ip) = parse_networks_col(&nets);
                    if public_ip.is_empty() {
                        public_ip = float_map.get(&internal_ip).cloned().unwrap_or_default();
                    }
                    Instance {
                        id,
                        name,
                        status,
                        zone,
                        platform,
                        flavor_id: flavor_key,
                        cores,
                        memory,
                        core_fraction: 100,
                        preemptible: false,
                        internal_ip,
                        public_ip,
                        subnet_id: String::new(),
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Serialize, Default)]
pub struct InstanceMaps {
    pub flavors: std::collections::HashMap<String, FlavorEntry>,
    pub floating: std::collections::HashMap<String, String>,
}

#[derive(Serialize, serde::Deserialize, Clone)]
pub struct FlavorEntry {
    pub name: String,
    pub cores: u64,
    pub memory: u64,
}

fn cached_flavors(cfg: &VkcsCfg, ctx: &OsCtx) -> std::collections::HashMap<String, (String, u64, u64)> {
    cfg.flavor_cache.get(&ctx.cloud).and_then(|projects| projects.get(&ctx.project_id))
        .map(|flavors| flavors.iter().map(|(id, flavor)|
            (id.clone(), (flavor.name.clone(), flavor.cores, flavor.memory))).collect())
        .unwrap_or_default()
}

fn instance_maps_from_json(flavor_v: &Value, float_v: &Value) -> InstanceMaps {
    InstanceMaps {
        flavors: flavor_map(flavor_v)
            .into_iter()
            .map(|(id, (name, cores, memory))| (id, FlavorEntry { name, cores, memory }))
            .collect(),
        floating: floating_by_fixed(float_v),
    }
}

#[tauri::command]
pub async fn vkcs_server_list(cloud: String, project_id: String) -> Result<Vec<Instance>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ctx = OsCtx {
            cloud: check_name(&cloud)?.to_string(),
            project_id: check_uuid(&project_id)?.to_string(),
        };
        let servers = openstack_json(&["server", "list"], &ctx)?;
        let cfg: VkcsCfg = crate::store::load_json(CFG_FILE).unwrap_or_default();
        let flavors = cached_flavors(&cfg, &ctx);
        Ok(parse_instances(&servers, &flavors, &std::collections::HashMap::new()))
    })
    .await
    .map_err(crate::store::err)?
}

#[tauri::command]
pub async fn vkcs_instance_maps(cloud: String, project_id: String) -> Result<InstanceMaps, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ctx = OsCtx {
            cloud: check_name(&cloud)?.to_string(),
            project_id: check_uuid(&project_id)?.to_string(),
        };
        let results = openstack_json_parallel(&ctx, &[&["flavor", "list"], &["floating", "ip", "list"]]);
        let flavors = results[0].as_ref().map_err(|e| e.clone())?;
        let empty = Value::Array(vec![]);
        let floats = results[1].as_ref().unwrap_or(&empty);
        let maps = instance_maps_from_json(flavors, floats);
        update_cfg(|cfg| {
            cfg.flavor_cache.entry(ctx.cloud).or_default().insert(ctx.project_id, maps.flavors.clone());
        })?;
        Ok(maps)
    })
    .await
    .map_err(crate::store::err)?
}

#[tauri::command]
pub async fn vkcs_instances(cloud: String, project_id: String) -> Result<Vec<Instance>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ctx = OsCtx {
            cloud: check_name(&cloud)?.to_string(),
            project_id: check_uuid(&project_id)?.to_string(),
        };
        let results = openstack_json_parallel(&ctx, &[&["server", "list"], &["flavor", "list"], &["floating", "ip", "list"]]);
        let servers = results[0].as_ref().map_err(|e| e.clone())?;
        let flavors = flavor_map(results[1].as_ref().map_err(|e| e.clone())?);
        let empty = Value::Array(vec![]);
        let floats = floating_by_fixed(results[2].as_ref().unwrap_or(&empty));
        Ok(parse_instances(servers, &flavors, &floats))
    })
    .await
    .map_err(crate::store::err)?
}

#[tauri::command]
pub async fn vkcs_instance_op(cloud: String, project_id: String, id: String, op: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ctx = OsCtx {
            cloud: check_name(&cloud)?.to_string(),
            project_id: check_uuid(&project_id)?.to_string(),
        };
        let id = check_uuid(&id)?;
        let args: &[&str] = match op.as_str() {
            "start" => &["server", "start", id],
            "stop" => &["server", "stop", id],
            "restart" => &["server", "reboot", "--soft", id],
            _ => return Err("неизвестная операция".into()),
        };
        openstack(args, &ctx).map(|_| ())
    })
    .await
    .map_err(crate::store::err)?
}

#[derive(Serialize, PartialEq, Debug)]
pub struct Subnet {
    pub id: String,
    pub name: String,
    pub network_id: String,
    pub zone: String,
    pub cidrs: Vec<String>,
    pub route_table_id: String,
}

fn parse_networks(v: &Value) -> Vec<Named> {
    v.as_array()
        .map(|a| {
            a.iter()
                .map(|x| Named {
                    id: str_field(x, &["ID", "Id", "id"]),
                    name: str_field(x, &["Name", "name"]),
                    parent: String::new(),
                    description: str_field(x, &["Description", "description"]),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn parse_subnets(v: &Value) -> Vec<Subnet> {
    v.as_array()
        .map(|a| {
            a.iter()
                .map(|x| {
                    let cidr = str_field(x, &["CIDR", "cidr", "Subnet", "subnet"]);
                    Subnet {
                        id: str_field(x, &["ID", "Id", "id"]),
                        name: str_field(x, &["Name", "name"]),
                        network_id: str_field(x, &["Network", "network_id"]),
                        zone: String::new(),
                        cidrs: if cidr.is_empty() { vec![] } else { vec![cidr] },
                        route_table_id: String::new(),
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Serialize)]
pub struct NetView {
    pub networks: Vec<Named>,
    pub subnets: Vec<Subnet>,
}

#[tauri::command]
pub async fn vkcs_net_view(cloud: String, project_id: String) -> Result<NetView, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ctx = OsCtx {
            cloud: check_name(&cloud)?.to_string(),
            project_id: check_uuid(&project_id)?.to_string(),
        };
        let results = openstack_json_parallel(&ctx, &[&["network", "list"], &["subnet", "list"]]);
        let nets = results[0].as_ref().map_err(|e| e.clone())?;
        let subs = results[1].as_ref().map_err(|e| e.clone())?;
        Ok(NetView {
            networks: parse_networks(nets),
            subnets: parse_subnets(subs),
        })
    })
    .await
    .map_err(crate::store::err)?
}

#[tauri::command]
pub async fn vkcs_networks(cloud: String, project_id: String) -> Result<Vec<Named>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ctx = OsCtx {
            cloud: check_name(&cloud)?.to_string(),
            project_id: check_uuid(&project_id)?.to_string(),
        };
        openstack_json(&["network", "list"], &ctx).map(|v| parse_networks(&v))
    })
    .await
    .map_err(crate::store::err)?
}

#[tauri::command]
pub async fn vkcs_subnets(cloud: String, project_id: String) -> Result<Vec<Subnet>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ctx = OsCtx {
            cloud: check_name(&cloud)?.to_string(),
            project_id: check_uuid(&project_id)?.to_string(),
        };
        openstack_json(&["subnet", "list"], &ctx).map(|v| parse_subnets(&v))
    })
    .await
    .map_err(crate::store::err)?
}

#[derive(Serialize, PartialEq, Debug)]
pub struct Rule {
    pub direction: String,
    pub protocol: String,
    pub ports: String,
    pub source: String,
    pub description: String,
}

#[derive(Serialize, PartialEq, Debug)]
pub struct SecGroup {
    pub id: String,
    pub name: String,
    pub network_id: String,
    pub rules: Vec<Rule>,
}

fn parse_sec_groups(groups: &Value, rules: &Value) -> Vec<SecGroup> {
    let mut by_id: std::collections::HashMap<String, SecGroup> = groups
        .as_array()
        .map(|a| {
            a.iter()
                .map(|x| {
                    let id = str_field(x, &["ID", "Id", "id"]);
                    (
                        id.clone(),
                        SecGroup {
                            id,
                            name: str_field(x, &["Name", "name"]),
                            network_id: String::new(),
                            rules: Vec::new(),
                        },
                    )
                })
                .collect()
        })
        .unwrap_or_default();

    if let Some(a) = rules.as_array() {
        for r in a {
            let gid = str_field(r, &["Security Group ID", "security_group_id", "Security Group"]);
            let dir = str_field(r, &["Direction", "direction"]);
            let direction = if dir.eq_ignore_ascii_case("ingress") {
                "INGRESS".into()
            } else if dir.eq_ignore_ascii_case("egress") {
                "EGRESS".into()
            } else {
                dir
            };
            let proto = str_field(r, &["IP Protocol", "ip_protocol", "Protocol", "protocol"]);
            let protocol = if proto.is_empty() || proto.eq_ignore_ascii_case("any") {
                "любой".into()
            } else {
                proto.to_lowercase()
            };
            let port = str_field(r, &["Port Range", "port_range", "Dst Port", "dst_port"]);
            let ports = if port.is_empty() { "любые".into() } else { port };
            let remote_ip = str_field(r, &["Remote IP Prefix", "remote_ip_prefix", "Remote IP"]);
            let remote_group = str_field(r, &["Remote Security Group", "remote_group_id", "Remote Group"]);
            let source = if !remote_ip.is_empty() {
                remote_ip
            } else if !remote_group.is_empty() {
                if remote_group == gid {
                    "эта же группа".into()
                } else {
                    format!("группа {remote_group}")
                }
            } else {
                "не указано".into()
            };
            let rule = Rule {
                direction,
                protocol,
                ports,
                source,
                description: str_field(r, &["Description", "description"]),
            };
            if let Some(g) = by_id.get_mut(&gid) {
                g.rules.push(rule);
            }
        }
    }
    let mut out: Vec<SecGroup> = by_id.into_values().collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn parse_sec_groups_shell(groups: &Value) -> Vec<SecGroup> {
    parse_sec_groups(groups, &Value::Array(vec![]))
}

#[derive(Serialize)]
pub struct SecGroupRulesChunk {
    pub group_id: String,
    pub rules: Vec<Rule>,
}

fn parse_sec_group_rules_chunked(rules: &Value) -> Vec<SecGroupRulesChunk> {
    let mut by_id: std::collections::HashMap<String, Vec<Rule>> = std::collections::HashMap::new();
    if let Some(a) = rules.as_array() {
        for r in a {
            let gid = str_field(r, &["Security Group ID", "security_group_id", "Security Group"]);
            if gid.is_empty() {
                continue;
            }
            let dir = str_field(r, &["Direction", "direction"]);
            let direction = if dir.eq_ignore_ascii_case("ingress") {
                "INGRESS".into()
            } else if dir.eq_ignore_ascii_case("egress") {
                "EGRESS".into()
            } else {
                dir
            };
            let proto = str_field(r, &["IP Protocol", "ip_protocol", "Protocol", "protocol"]);
            let protocol = if proto.is_empty() || proto.eq_ignore_ascii_case("any") {
                "любой".into()
            } else {
                proto.to_lowercase()
            };
            let port = str_field(r, &["Port Range", "port_range", "Dst Port", "dst_port"]);
            let ports = if port.is_empty() { "любые".into() } else { port };
            let remote_ip = str_field(r, &["Remote IP Prefix", "remote_ip_prefix", "Remote IP"]);
            let remote_group = str_field(r, &["Remote Security Group", "remote_group_id", "Remote Group"]);
            let source = if !remote_ip.is_empty() {
                remote_ip
            } else if !remote_group.is_empty() {
                if remote_group == gid {
                    "эта же группа".into()
                } else {
                    format!("группа {remote_group}")
                }
            } else {
                "не указано".into()
            };
            by_id.entry(gid).or_default().push(Rule {
                direction,
                protocol,
                ports,
                source,
                description: str_field(r, &["Description", "description"]),
            });
        }
    }
    by_id.into_iter().map(|(group_id, rules)| SecGroupRulesChunk { group_id, rules }).collect()
}

#[tauri::command]
pub async fn vkcs_sec_groups_shell(cloud: String, project_id: String) -> Result<Vec<SecGroup>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ctx = OsCtx {
            cloud: check_name(&cloud)?.to_string(),
            project_id: check_uuid(&project_id)?.to_string(),
        };
        openstack_json(&["security", "group", "list"], &ctx).map(|v| parse_sec_groups_shell(&v))
    })
    .await
    .map_err(crate::store::err)?
}

#[tauri::command]
pub async fn vkcs_sec_group_rules(cloud: String, project_id: String) -> Result<Vec<SecGroupRulesChunk>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ctx = OsCtx {
            cloud: check_name(&cloud)?.to_string(),
            project_id: check_uuid(&project_id)?.to_string(),
        };
        openstack_json(&["security", "group", "rule", "list", "--long"], &ctx).map(|v| parse_sec_group_rules_chunked(&v))
    })
    .await
    .map_err(crate::store::err)?
}

#[tauri::command]
pub async fn vkcs_sec_groups(cloud: String, project_id: String) -> Result<Vec<SecGroup>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ctx = OsCtx {
            cloud: check_name(&cloud)?.to_string(),
            project_id: check_uuid(&project_id)?.to_string(),
        };
        let results = openstack_json_parallel(&ctx, &[&["security", "group", "list"], &["security", "group", "rule", "list", "--long"]]);
        let groups = results[0].as_ref().map_err(|e| e.clone())?;
        let rules = results[1].as_ref().map_err(|e| e.clone())?;
        Ok(parse_sec_groups(groups, rules))
    })
    .await
    .map_err(crate::store::err)?
}

#[derive(Serialize, PartialEq, Debug)]
pub struct Address {
    pub id: String,
    pub address: String,
    pub external: bool,
    pub reserved: bool,
    pub used: bool,
    pub zone: String,
    pub name: String,
}

fn parse_floating_ips(v: &Value) -> Vec<Address> {
    v.as_array()
        .map(|a| {
            a.iter()
                .map(|x| {
                    let floating = str_field(x, &["Floating IP Address", "floating_ip_address", "Floating IP"]);
                    let fixed = str_field(x, &["Fixed IP Address", "fixed_ip_address", "Fixed IP"]);
                    let id = str_field(x, &["ID", "Id", "id"]);
                    Address {
                        id,
                        address: floating,
                        external: true,
                        reserved: true,
                        used: !fixed.is_empty(),
                        zone: fixed,
                        name: String::new(),
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

#[tauri::command]
pub async fn vkcs_addresses(cloud: String, project_id: String) -> Result<Vec<Address>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ctx = OsCtx {
            cloud: check_name(&cloud)?.to_string(),
            project_id: check_uuid(&project_id)?.to_string(),
        };
        openstack_json(&["floating", "ip", "list"], &ctx).map(|v| parse_floating_ips(&v))
    })
    .await
    .map_err(crate::store::err)?
}

#[derive(Serialize, PartialEq, Debug)]
pub struct AccessRow {
    pub role: String,
    pub kind: String,
    pub subject: String,
}

fn parse_access(v: &Value) -> Vec<AccessRow> {
    let mut out: Vec<AccessRow> = v
        .as_array()
        .map(|a| {
            a.iter()
                .map(|x| AccessRow {
                    role: str_field(x, &["Role", "role"]),
                    kind: str_field(x, &["Type", "type", "User", "user"]),
                    subject: str_field(x, &["User", "user", "Group", "group", "Name", "name"]),
                })
                .filter(|r| !r.role.is_empty())
                .collect()
        })
        .unwrap_or_default();
    out.sort_by(|a, b| a.role.cmp(&b.role).then_with(|| a.subject.cmp(&b.subject)));
    out
}

#[tauri::command]
pub async fn vkcs_access(cloud: String, project_id: String) -> Result<AccessView, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let pid = check_uuid(&project_id)?;
        let ctx = OsCtx {
            cloud: check_name(&cloud)?.to_string(),
            project_id: pid.to_string(),
        };
        access_view(openstack_json(&["role", "assignment", "list", "--project", pid], &ctx))
    })
    .await
    .map_err(crate::store::err)?
}

#[derive(Serialize)]
pub struct AccessView {
    rows: Vec<AccessRow>,
    denied: bool,
}

fn access_view(result: Result<Value, String>) -> Result<AccessView, String> {
    match result {
        Ok(value) => Ok(AccessView { rows: parse_access(&value), denied: false }),
        Err(error) if error.contains(FORBIDDEN_MESSAGE) => Ok(AccessView { rows: Vec::new(), denied: true }),
        Err(error) => Err(error),
    }
}

fn is_billing_pid(s: &str) -> bool {
    let s = s.trim().to_lowercase();
    let Some(digits) = s.strip_prefix("mcs") else { return false };
    !digits.is_empty() && digits.len() <= 16 && digits.chars().all(|c| c.is_ascii_digit())
}

fn cloud_auth_url(cloud: &str) -> Option<String> {
    let p = clouds_yaml_path()?;
    let text = std::fs::read_to_string(&p).ok()?;
    let v: serde_yaml_ng::Value = serde_yaml_ng::from_str(&text).ok()?;
    v.get("clouds")?
        .get(cloud)?
        .get("auth")?
        .get("auth_url")
        .and_then(|u| u.as_str())
        .map(str::to_string)
}

/// Базовый URL Billing API (без пути `/public/v1/…`); регион — по auth_url в clouds.yaml.
fn billing_api_base(cloud: &str) -> String {
    if let Some(url) = cloud_auth_url(cloud) {
        let low = url.to_lowercase();
        if low.contains("kz.infra") {
            return "https://kz.cloud.vk.ru/billing".into();
        }
    }
    "https://msk.cloud.vk.ru/billing".into()
}

fn billing_currency(base: &str) -> &'static str {
    if base.contains("kz.cloud") {
        "KZT"
    } else {
        "RUB"
    }
}

fn openstack_token(ctx: &OsCtx) -> Result<String, String> {
    let t = openstack(&["token", "issue", "-c", "id", "-f", "value"], ctx)?;
    let t = t.trim();
    if t.is_empty() {
        return Err("openstack не вернул токен — проверьте вход в облако".into());
    }
    Ok(t.to_string())
}

fn resolve_billing_pid(ctx: &OsCtx, project_id: &str) -> Result<String, String> {
    let cfg: VkcsCfg = crate::store::load_json(CFG_FILE).unwrap_or_default();
    if let Some(pid) = cfg.billing_pids.get(project_id) {
        let pid = pid.trim().to_lowercase();
        if is_billing_pid(&pid) {
            return Ok(pid);
        }
    }
    let v = openstack_json(&["project", "show", project_id], ctx)?;
    let name = str_field(&v, &["name", "Name"]);
    let name_l = name.trim().to_lowercase();
    if is_billing_pid(&name_l) {
        return Ok(name_l);
    }
    Err(format!(
        "для Billing API нужен PID проекта (mcs…), а не UUID OpenStack — скопируйте его в шапке личного кабинета VK Cloud (имя проекта OpenStack «{name}» не похоже на PID)"
    ))
}

fn fmt_money(n: f64) -> String {
    format!("{:.2}", n).replace('.', ",")
}

#[derive(Serialize, PartialEq, Debug, Default)]
pub struct VkcsBilling {
    pub ok: bool,
    pub need_pid: bool,
    pub pid: String,
    pub base: String,
    pub bonus: String,
    pub currency: String,
    pub error: String,
}

enum BillingPrep {
    NeedPid(VkcsBilling),
    Ready { token: String, pid: String, api_base: String },
}

fn billing_session(cloud: &str, project_id: &str) -> Result<BillingPrep, String> {
    let ctx = OsCtx {
        cloud: cloud.to_string(),
        project_id: project_id.to_string(),
    };
    let token = openstack_token(&ctx)?;
    let api_base = billing_api_base(cloud);
    let pid = match resolve_billing_pid(&ctx, project_id) {
        Ok(p) => p,
        Err(e) => {
            return Ok(BillingPrep::NeedPid(VkcsBilling {
                need_pid: true,
                error: e,
                currency: billing_currency(&api_base).to_string(),
                ..Default::default()
            }));
        }
    };
    Ok(BillingPrep::Ready { token, pid, api_base })
}

fn billing_timezone(api_base: &str) -> &'static str {
    if api_base.contains("kz.cloud") {
        "Asia/Almaty"
    } else {
        "Europe/Moscow"
    }
}

fn check_bill_date(s: &str, label: &str) -> Result<String, String> {
    let s = s.trim();
    if s.len() != 10 || s.as_bytes()[4] != b'-' || s.as_bytes()[7] != b'-' {
        return Err(format!("{label}: дата в формате ГГГГ-ММ-ДД"));
    }
    if !s.chars().all(|c| c.is_ascii_digit() || c == '-') {
        return Err(format!("{label}: дата в формате ГГГГ-ММ-ДД"));
    }
    Ok(s.to_string())
}

fn billing_api_error(status: reqwest::StatusCode, body: &str, pid: &str, currency: &str) -> VkcsBilling {
    let msg = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string))
        .unwrap_or_else(|| body.trim().chars().take(200).collect());
    if status == reqwest::StatusCode::NOT_FOUND {
        return VkcsBilling {
            need_pid: true,
            error: "проект не найден в биллинге — проверьте PID (mcs…) для этого проекта OpenStack".into(),
            currency: currency.to_string(),
            pid: pid.to_string(),
            ..Default::default()
        };
    }
    VkcsBilling {
        error: if status.as_u16() == 401 {
            "доступ по API отключён или токен не принят — включите API в настройках проекта VK Cloud".into()
        } else {
            format!("биллинг ответил {status}: {msg}")
        },
        currency: currency.to_string(),
        pid: pid.to_string(),
        ..Default::default()
    }
}

#[derive(Serialize, PartialEq, Debug, Default, Clone)]
pub struct VkcsReportRow {
    pub day: String,
    pub service: String,
    pub resource: String,
    pub parameter: String,
    pub money: String,
    pub bonus: String,
}

#[derive(Serialize, PartialEq, Debug, Default)]
pub struct VkcsBillingReport {
    pub ok: bool,
    pub need_pid: bool,
    pub pid: String,
    pub currency: String,
    pub error: String,
    pub rows: Vec<VkcsReportRow>,
}

fn str_field_opt(x: &Value, keys: &[&str]) -> String {
    keys.iter().find_map(|k| x.get(*k).and_then(|v| v.as_str())).unwrap_or("").trim().to_string()
}

fn report_resource_line(x: &Value) -> String {
    let mut parts: Vec<String> = Vec::new();
    for k in ["resource_type", "resource_subtype"] {
        let s = str_field_opt(x, &[k]);
        if !s.is_empty() {
            parts.push(s);
        }
    }
    let id = str_field_opt(x, &["resource_id"]);
    if !id.is_empty() {
        let short = if id.len() > 12 { format!("{}…", &id[..12]) } else { id };
        parts.push(short);
    }
    parts.join(" · ")
}

pub fn parse_report_items(v: &Value) -> Vec<VkcsReportRow> {
    let Some(items) = v.get("items").and_then(|i| i.as_array()) else {
        return Vec::new();
    };
    let mut out: Vec<VkcsReportRow> = items
        .iter()
        .map(|x| {
            let mut service = str_field_opt(x, &["service_name"]);
            if service.is_empty() {
                service = str_field_opt(x, &["service_code"]);
            }
            let parameter = str_field_opt(x, &["parameter_name"]);
            let parameter = if parameter.is_empty() {
                str_field_opt(x, &["parameter_code"])
            } else {
                parameter
            };
            VkcsReportRow {
                day: str_field_opt(x, &["usage_day"]),
                service,
                resource: report_resource_line(x),
                parameter,
                money: str_field_opt(x, &["money"]),
                bonus: str_field_opt(x, &["bonus"]),
            }
        })
        .collect();
    out.sort_by(|a, b| {
        a.day
            .cmp(&b.day)
            .then_with(|| a.service.cmp(&b.service))
            .then_with(|| a.resource.cmp(&b.resource))
    });
    out
}

#[tauri::command]
pub async fn vkcs_set_billing_pid(project_id: String, pid: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let id = check_uuid(&project_id)?.to_string();
        let pid = pid.trim().to_lowercase();
        if !is_billing_pid(&pid) {
            return Err("PID должен быть вида mcs0123456789 — наведите на имя проекта в шапке личного кабинета VK Cloud и скопируйте идентификатор".into());
        }
        update_cfg(|cfg| {
            cfg.billing_pids.insert(id, pid);
        })
    })
    .await
    .map_err(crate::store::err)?
}

#[tauri::command]
pub async fn vkcs_billing(cloud: String, project_id: String) -> Result<VkcsBilling, String> {
    let cloud = check_name(&cloud)?.to_string();
    let project_id = check_uuid(&project_id)?.to_string();
    let prep = tauri::async_runtime::spawn_blocking({
        let cloud = cloud.clone();
        let project_id = project_id.clone();
        move || billing_session(&cloud, &project_id)
    })
    .await
    .map_err(crate::store::err)??;

    let (token, pid, api_base) = match prep {
        BillingPrep::NeedPid(b) => return Ok(b),
        BillingPrep::Ready { token, pid, api_base } => (token, pid, api_base),
    };
    let currency = billing_currency(&api_base).to_string();
    let url = format!("{api_base}/public/v1/projects/{pid}/balances/amount");

    let client = crate::net::client_for(&url).build().map_err(|e| format!("HTTP-клиент: {e}"))?;
    let resp = client
        .get(&url)
        .header("Accept", "application/json")
        .header("X-Auth-Token", &token)
        .send()
        .await
        .map_err(|e| format!("запрос баланса: {e}"))?;

    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        crate::vkcs_sdk::invalidate(&cloud, &project_id);
    }
    let body = resp.text().await.map_err(|e| format!("ответ баланса: {e}"))?;

    if !status.is_success() {
        return Ok(billing_api_error(status, &body, &pid, &currency));
    }

    let v: Value = serde_json::from_str(&body).map_err(|e| format!("биллинг вернул не JSON: {e}"))?;
    let base = v.get("base").and_then(|n| n.as_f64()).unwrap_or(0.0);
    let bonus = v.get("bonus").and_then(|n| n.as_f64()).unwrap_or(0.0);
    Ok(VkcsBilling {
        ok: true,
        pid,
        base: fmt_money(base),
        bonus: fmt_money(bonus),
        currency,
        ..Default::default()
    })
}

#[tauri::command]
pub async fn vkcs_billing_report(cloud: String, project_id: String, date_from: String, date_to: String) -> Result<VkcsBillingReport, String> {
    let cloud = check_name(&cloud)?.to_string();
    let project_id = check_uuid(&project_id)?.to_string();
    let date_from = check_bill_date(&date_from, "Начало периода")?;
    let date_to = if date_to.trim().is_empty() {
        String::new()
    } else {
        check_bill_date(&date_to, "Конец периода")?
    };
    if !date_to.is_empty() && date_to < date_from {
        return Err("конец периода раньше начала".into());
    }

    let prep = tauri::async_runtime::spawn_blocking({
        let cloud = cloud.clone();
        let project_id = project_id.clone();
        move || billing_session(&cloud, &project_id)
    })
    .await
    .map_err(crate::store::err)??;

    let (token, pid, api_base) = match prep {
        BillingPrep::NeedPid(b) => {
            return Ok(VkcsBillingReport {
                need_pid: b.need_pid,
                error: b.error,
                currency: b.currency,
                pid: b.pid,
                ..Default::default()
            });
        }
        BillingPrep::Ready { token, pid, api_base } => (token, pid, api_base),
    };
    let currency = billing_currency(&api_base).to_string();
    let tz = billing_timezone(&api_base);
    let path = format!("{api_base}/public/v1/projects/{pid}/reports/lite-granular");

    let client = crate::net::client_for(&path).build().map_err(|e| format!("HTTP-клиент: {e}"))?;
    let req = client.get(&path).header("Accept", "application/json").header("X-Auth-Token", &token);
    let mut q = vec![("date_from", date_from.as_str()), ("timezone", tz)];
    if !date_to.is_empty() {
        q.push(("date_to", date_to.as_str()));
    }
    let resp = req.query(&q).send().await.map_err(|e| format!("запрос отчёта: {e}"))?;

    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        crate::vkcs_sdk::invalidate(&cloud, &project_id);
    }
    let body = resp.text().await.map_err(|e| format!("ответ отчёта: {e}"))?;

    if !status.is_success() {
        let b = billing_api_error(status, &body, &pid, &currency);
        return Ok(VkcsBillingReport {
            need_pid: b.need_pid,
            error: b.error,
            currency: b.currency,
            pid: b.pid,
            ..Default::default()
        });
    }

    let v: Value = serde_json::from_str(&body).map_err(|e| format!("биллинг вернул не JSON: {e}"))?;
    Ok(VkcsBillingReport {
        ok: true,
        pid,
        currency,
        rows: parse_report_items(&v),
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flavor_names_survive_restart_and_stay_scoped_to_cloud_and_project() {
        let mut cfg = VkcsCfg::default();
        cfg.flavor_cache.entry("cloud".into()).or_default().insert("project".into(),
            std::collections::HashMap::from([("flavor-id".into(), FlavorEntry { name: "Standard-2-4".into(), cores: 2, memory: 4294967296 })]));
        let restored: VkcsCfg = serde_json::from_str(&serde_json::to_string(&cfg).unwrap()).unwrap();
        let ctx = OsCtx { cloud: "cloud".into(), project_id: "project".into() };
        let flavors = cached_flavors(&restored, &ctx);
        let servers = serde_json::json!([{ "ID": "vm", "Name": "vm", "Flavor": "flavor-id" }]);
        let instances = parse_instances(&servers, &flavors, &Default::default());
        assert_eq!(instances[0].platform, "Standard-2-4");
        assert_eq!(instances[0].flavor_id, "flavor-id");
        assert_eq!(instances[0].cores, 2);
        assert!(cached_flavors(&restored, &OsCtx { cloud: "other".into(), project_id: "project".into() }).is_empty());
        assert!(cached_flavors(&restored, &OsCtx { cloud: "cloud".into(), project_id: "other".into() }).is_empty());
    }

    #[test]
    fn access_denial_is_distinct_from_empty_roles_and_request_failure() {
        assert!(access_view(Err(format!("role assignment list: {FORBIDDEN_MESSAGE}"))).unwrap().denied);
        let empty = access_view(Ok(serde_json::json!([]))).unwrap();
        assert!(!empty.denied);
        assert!(empty.rows.is_empty());
        assert!(access_view(Err("request timeout".into())).is_err());
    }

    #[test]
    fn duplicate_requests_share_results_and_allow_retry() {
        let pending: PendingRequests<String> = Default::default();
        let executions = std::sync::atomic::AtomicUsize::new(0);
        std::thread::scope(|scope| {
            let (started_tx, started_rx) = std::sync::mpsc::channel();
            let (finish_tx, finish_rx) = std::sync::mpsc::channel();
            let pending = &pending;
            let executions = &executions;
            let owner = scope.spawn(move || join_request(pending, "same".into(), || {
                executions.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                started_tx.send(()).unwrap();
                finish_rx.recv().unwrap();
                Err("test failure".into())
            }));
            started_rx.recv().unwrap();
            let waiter = scope.spawn(move || join_request(pending, "same".into(), || {
                panic!("duplicate request executed")
            }));
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            loop {
                let joined = pending.lock().unwrap().get("same").map(|r| std::sync::Arc::strong_count(r) >= 3).unwrap_or(false);
                if joined { break; }
                if std::time::Instant::now() >= deadline {
                    finish_tx.send(()).unwrap();
                    panic!("duplicate did not join");
                }
                std::thread::yield_now();
            }
            finish_tx.send(()).unwrap();
            assert_eq!(owner.join().unwrap(), Err("test failure".into()));
            assert_eq!(waiter.join().unwrap(), Err("test failure".into()));
        });
        assert_eq!(executions.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(pending.lock().unwrap().is_empty());
        assert_eq!(join_request(&pending, "same".into(), || Ok("retry".into())), Ok("retry".into()));
    }

    // Reuse the test binary as a portable CLI fixture, without depending on a shell or Python.
    fn fixture(mode: &str) -> Command {
        let mut cmd = Command::new(std::env::current_exe().unwrap());
        cmd.args(["--exact", "vkcs::tests::cli_fixture", "--nocapture"])
            .env("OPSDECK_VKCS_TEST_CLI", mode)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        process::no_console(&mut cmd);
        cmd
    }

    #[test]
    fn cli_fixture() {
        match std::env::var("OPSDECK_VKCS_TEST_CLI").as_deref() {
            Ok("hang") => std::thread::sleep(Duration::from_secs(30)),
            Ok("output") => {
                use std::io::Write;
                std::io::stdout().write_all(&vec![b'x'; 256 * 1024]).unwrap();
                std::io::stderr().write_all(&vec![b'y'; 256 * 1024]).unwrap();
            }
            _ => {}
        }
    }

    #[test]
    fn cli_drains_both_pipes() {
        let out = cli_output(fixture("output"), Duration::from_secs(10)).unwrap();
        assert!(out.status.success());
        assert!(out.stdout.len() >= 256 * 1024);
        assert!(out.stderr.len() >= 256 * 1024);
    }

    #[test]
    fn cli_timeout_returns_instead_of_hanging() {
        let started = std::time::Instant::now();
        let err = cli_output(fixture("hang"), Duration::from_millis(300)).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn independent_queries_start_together_and_keep_input_order() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let started = AtomicUsize::new(0);
        let result = parallel_queries(&[&["first"], &["second"]], |args| {
            started.fetch_add(1, Ordering::SeqCst);
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            while started.load(Ordering::SeqCst) < 2 {
                if std::time::Instant::now() >= deadline {
                    return Err("second query did not start".into());
                }
                std::thread::yield_now();
            }
            Ok(Value::String(args[0].into()))
        });
        assert_eq!(result, vec![Ok(Value::String("first".into())), Ok(Value::String("second".into()))]);
    }

    #[test]
    fn report_items_are_parsed() {
        let v: Value = serde_json::from_str(
            r#"{"items":[{"usage_day":"2026-01-15","service_name":"Cloud Servers","resource_type":"compute","resource_subtype":"STD3-2-4","resource_id":"abc-def","parameter_name":"RAM","money":"12.5","bonus":"0","labels":{}}]}"#,
        )
        .unwrap();
        let rows = parse_report_items(&v);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].day, "2026-01-15");
        assert_eq!(rows[0].service, "Cloud Servers");
        assert!(rows[0].resource.contains("compute"));
        assert_eq!(rows[0].money, "12.5");
    }

    #[test]
    fn billing_pid_format() {
        assert!(is_billing_pid("mcs0123456789"));
        assert!(is_billing_pid("MCS99"));
        assert!(!is_billing_pid("prod"));
        assert!(!is_billing_pid("mcs"));
    }

    #[test]
    fn billing_base_follows_auth_region() {
        assert_eq!(billing_api_base("any"), "https://msk.cloud.vk.ru/billing");
    }

    #[test]
    fn cloud_names_are_read_without_passwords() {
        let yaml = r"
clouds:
  vk-prod:
    auth:
      auth_url: https://infra.mail.ru:5000/v3/
      username: u
      password: secret
      project_id: 11111111-2222-3333-4444-555555555555
  vk-stage:
    auth:
      password: other
";
        assert_eq!(cloud_names_from_yaml(yaml), ["vk-prod", "vk-stage"]);
        assert!(cloud_names_from_yaml("clouds: {}").is_empty());
    }

    #[test]
    fn networks_column_is_parsed() {
        assert_eq!(parse_networks_col("private=10.0.0.4"), ("10.0.0.4".into(), String::new()));
        assert_eq!(parse_networks_col("net=10.0.0.1, 203.0.113.7"), ("10.0.0.1".into(), "203.0.113.7".into()));
    }

    #[test]
    fn instances_merge_flavors_and_floating() {
        let servers: Value =
            serde_json::from_str(r#"[{"ID":"s1","Name":"app","Status":"ACTIVE","Availability Zone":"MS1","Flavor":"f1","Networks":"private=10.0.0.4"}]"#)
                .unwrap();
        let flavors: Value = serde_json::from_str(r#"[{"ID":"f1","Name":"Standard-2-4","RAM":4096,"VCPUs":2}]"#).unwrap();
        let floats: Value = serde_json::from_str(r#"[{"Fixed IP Address":"10.0.0.4","Floating IP Address":"203.0.113.1"}]"#).unwrap();
        let fm = flavor_map(&flavors);
        let fl = floating_by_fixed(&floats);
        let i = parse_instances(&servers, &fm, &fl);
        assert_eq!(i[0].status, "RUNNING");
        assert_eq!((i[0].cores, i[0].memory), (2, 4096 * 1024 * 1024));
        assert_eq!(i[0].public_ip, "203.0.113.1");
    }

    #[test]
    fn security_group_rules_are_grouped() {
        let groups: Value = serde_json::from_str(r#"[{"ID":"g1","Name":"web"}]"#).unwrap();
        let rules: Value = serde_json::from_str(
            r#"[{"Security Group ID":"g1","Direction":"ingress","IP Protocol":"tcp","Port Range":"443","Remote IP Prefix":"0.0.0.0/0","Description":"https"}]"#,
        )
        .unwrap();
        let g = parse_sec_groups(&groups, &rules);
        assert_eq!(g[0].rules[0].ports, "443");
        assert_eq!(g[0].rules[0].direction, "INGRESS");
    }

    #[test]
    fn only_safe_names_and_uuids() {
        assert!(valid_name("vk-prod"));
        assert!(!valid_name(""));
        assert!(valid_uuid("11111111-2222-3333-4444-555555555555"));
        assert!(!valid_uuid("not-uuid"));
    }
}
