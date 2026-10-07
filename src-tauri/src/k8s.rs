//! Kubernetes: kubeconfig sources, resource listing/editing via kube-rs, pod log streaming.
//! Interactive things (exec, port-forward, a shell bound to a context) run `kubectl` in a
//! terminal tab with KUBECONFIG pointing at a single-context file from `k8s_shell_config`.

use futures::{AsyncBufReadExt, StreamExt};
use k8s_openapi::api::core::v1::{Pod, Secret};
use kube::{
    api::{Api, ApiResource, DeleteParams, DynamicObject, GroupVersionKind, ListParams, LogParams, Patch, PatchParams},
    config::{KubeConfigOptions, Kubeconfig},
    Client, Config,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    time::Duration,
};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{oneshot, Mutex};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Default)]
pub struct K8sState {
    clients: Mutex<HashMap<(String, String), Client>>,
    logs: std::sync::Mutex<HashMap<String, oneshot::Sender<()>>>,
    watches: std::sync::Mutex<HashMap<String, oneshot::Sender<()>>>,
    /// multi-pod log sessions: dropping/sending stops every per-container stream
    workload_logs: std::sync::Mutex<HashMap<String, tokio::sync::watch::Sender<bool>>>,
}

#[derive(Deserialize, Clone)]
pub struct Ctx {
    file: String,
    context: String,
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

// ---------- kubeconfig sources ----------

fn imported_dir() -> Result<PathBuf, String> {
    let dir = dirs::config_dir().ok_or("no config dir")?.join("opsdeck").join("kubeconfigs");
    fs::create_dir_all(&dir).map_err(err)?;
    crate::store::restrict(&dir, 0o700)?;
    Ok(dir)
}

/// The shared kubeconfig files kubectl uses outside OpsDeck: $KUBECONFIG entries or ~/.kube/config.
fn system_files() -> Vec<(PathBuf, &'static str)> {
    let mut out: Vec<(PathBuf, &'static str)> = Vec::new();
    // OpsDeck's own terminals get KUBECONFIG pointing at the store: don't treat that as "system"
    let own = imported_dir().ok();
    if let Ok(env) = std::env::var("KUBECONFIG") {
        for p in env.split(':').filter(|s| !s.is_empty()).map(PathBuf::from) {
            if p.is_file() && own.as_deref() != p.parent() && !out.iter().any(|(x, _)| *x == p) {
                out.push((p, "env"));
            }
        }
    }
    if let Some(p) = dirs::home_dir().map(|h| h.join(".kube/config")).filter(|p| p.is_file()) {
        if !out.iter().any(|(x, _)| *x == p) {
            out.push((p, "kube"));
        }
    }
    out
}

/// Kubeconfig files in OpsDeck's own store (~/.config/opsdeck/kubeconfigs), sorted.
fn store_files() -> Vec<PathBuf> {
    let Ok(dir) = imported_dir() else { return Vec::new() };
    let mut files: Vec<_> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| matches!(p.extension().and_then(|e| e.to_str()), Some("yaml" | "yml")))
        .collect();
    files.sort();
    files
}

fn sources() -> Vec<(PathBuf, &'static str)> {
    let mut out = if crate::settings::load().k8s_include_system { system_files() } else { Vec::new() };
    out.extend(store_files().into_iter().map(|p| (p, "opsdeck")));
    out
}

/// KUBECONFIG for terminals started by OpsDeck: only OpsDeck's store, so kubectl/helm/claude
/// there never touch the shared ~/.kube/config. None when the user opted into system configs.
pub fn terminal_kubeconfig() -> Option<String> {
    if crate::settings::load().k8s_include_system {
        return None;
    }
    let files = store_files();
    if files.is_empty() {
        // an empty config keeps kubectl from falling back to ~/.kube/config
        let empty = crate::store::config_dir().ok()?.join("empty-kubeconfig");
        if !empty.exists() {
            write_private(&empty, "apiVersion: v1\nkind: Config\nclusters: []\ncontexts: []\nusers: []\n").ok()?;
        }
        return Some(empty.to_string_lossy().into_owned());
    }
    let joined: Vec<String> = files.iter().map(|p| p.to_string_lossy().into_owned()).collect();
    Some(joined.join(":"))
}

fn read_yaml(path: &Path) -> Result<Value, String> {
    let raw = fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_yaml_ng::from_str(&raw).map_err(|e| format!("{}: {e}", path.display()))
}

fn named<'a>(cfg: &'a Value, list: &str, name: &str) -> Option<&'a Value> {
    cfg[list].as_array()?.iter().find(|x| x["name"] == name)
}

#[derive(Serialize)]
pub struct CtxInfo {
    file: String,
    source: &'static str,
    label: String,
    context: String,
    cluster: String,
    user: String,
    namespace: String,
    current: bool,
    server: String,
}

#[tauri::command]
pub fn k8s_contexts() -> Vec<CtxInfo> {
    contexts_of(sources())
}

/// Contexts of the shared kubeconfig, for the import dialog.
#[tauri::command]
pub fn k8s_system_contexts() -> Vec<CtxInfo> {
    contexts_of(system_files())
}

fn contexts_of(files: Vec<(PathBuf, &'static str)>) -> Vec<CtxInfo> {
    let mut out = Vec::new();
    for (path, source) in files {
        let Ok(cfg) = read_yaml(&path) else { continue };
        let current = cfg["current-context"].as_str().unwrap_or_default();
        let label = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        for c in cfg["contexts"].as_array().into_iter().flatten() {
            let name = c["name"].as_str().unwrap_or_default();
            let cluster = c["context"]["cluster"].as_str().unwrap_or_default();
            out.push(CtxInfo {
                file: path.to_string_lossy().into_owned(),
                source,
                label: label.clone(),
                context: name.into(),
                cluster: cluster.into(),
                user: c["context"]["user"].as_str().unwrap_or_default().into(),
                namespace: c["context"]["namespace"].as_str().unwrap_or("default").into(),
                current: name == current,
                server: named(&cfg, "clusters", cluster)
                    .and_then(|x| x["cluster"]["server"].as_str())
                    .unwrap_or_default()
                    .into(),
            });
        }
    }
    out
}

fn sanitize(s: &str) -> String {
    let s: String = s
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') { c } else { '_' })
        .collect();
    s.trim_matches('.').chars().take(80).collect()
}

fn write_private(path: &Path, content: &str) -> Result<(), String> {
    fs::write(path, content).map_err(err)?;
    crate::store::restrict(path, 0o600)
}

/// Import from pasted YAML or from a file path (drag & drop). Returns the number of contexts.
#[tauri::command]
pub fn k8s_import(name: Option<String>, yaml: Option<String>, path: Option<String>) -> Result<ImportResult, String> {
    let (raw, default_name) = match (yaml, path) {
        (Some(y), _) if !y.trim().is_empty() => (y, "cluster".to_string()),
        (_, Some(p)) => {
            let p = PathBuf::from(p);
            let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            (fs::read_to_string(&p).map_err(err)?, stem)
        }
        _ => return Err("нужен YAML или путь к файлу".into()),
    };
    let cfg: Value = serde_yaml_ng::from_str(&raw).map_err(|e| format!("это не YAML: {e}"))?;
    let count = cfg["contexts"].as_array().map_or(0, Vec::len);
    if count == 0 || cfg["clusters"].as_array().is_none_or(Vec::is_empty) {
        return Err("в файле нет contexts/clusters — это не kubeconfig".into());
    }
    let name = sanitize(name.as_deref().filter(|n| !n.trim().is_empty()).unwrap_or(&default_name));
    if name.is_empty() {
        return Err("пустое имя".into());
    }
    let target = imported_dir()?.join(format!("{name}.yaml"));
    if target.exists() {
        return Err(format!("«{name}» уже импортирован — выберите другое имя"));
    }
    write_private(&target, &raw)?;
    Ok(ImportResult { count, exec: exec_commands(&cfg) })
}

#[derive(Serialize)]
pub struct ImportResult {
    count: usize,
    /// commands the kubeconfig runs to get credentials (users[].user.exec) — worth a look
    exec: Vec<String>,
}

fn exec_commands(cfg: &Value) -> Vec<String> {
    cfg["users"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|u| {
            let e = &u["user"]["exec"];
            let cmd = e["command"].as_str()?;
            let args: Vec<&str> = e["args"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
            Some(format!("{cmd} {}", args.join(" ")).trim().to_string())
        })
        .collect()
}

#[tauri::command]
pub async fn k8s_remove_source(state: State<'_, K8sState>, file: String) -> Result<(), String> {
    let path = PathBuf::from(&file);
    if path.parent() != Some(imported_dir()?.as_path()) {
        return Err("удалять можно только импортированные файлы".into());
    }
    fs::remove_file(path).map_err(err)?;
    state.clients.lock().await.retain(|(f, _), _| *f != file);
    Ok(())
}

/// Removes one context from its kubeconfig file (like `kubectl config delete-context`), plus its
/// cluster/user entries when no other context uses them. A timestamped backup is written first;
/// an imported file left without contexts is deleted.
#[tauri::command]
pub async fn k8s_delete_context(state: State<'_, K8sState>, ctx: Ctx) -> Result<String, String> {
    let backup = delete_context_in_file(&ctx)?;
    state.clients.lock().await.remove(&(ctx.file.clone(), ctx.context.clone()));
    Ok(backup)
}

fn delete_context_in_file(ctx: &Ctx) -> Result<String, String> {
    let path = PathBuf::from(&ctx.file);
    let raw = fs::read_to_string(&path).map_err(err)?;
    let mut cfg: Value = serde_yaml_ng::from_str(&raw).map_err(err)?;
    let entry = named(&cfg, "contexts", &ctx.context).ok_or("контекст не найден")?.clone();
    let cluster = entry["context"]["cluster"].as_str().unwrap_or_default().to_string();
    let user = entry["context"]["user"].as_str().unwrap_or_default().to_string();

    let contexts = cfg["contexts"].as_array_mut().ok_or("в файле нет contexts")?;
    contexts.retain(|c| c["name"] != ctx.context.as_str());
    let still_used = |field: &str, name: &str| contexts.iter().any(|c| c["context"][field] == name);
    let (drop_cluster, drop_user) = (!still_used("cluster", &cluster), !still_used("user", &user));
    let left = contexts.len();
    if drop_cluster {
        if let Some(a) = cfg["clusters"].as_array_mut() { a.retain(|x| x["name"] != cluster.as_str()); }
    }
    if drop_user {
        if let Some(a) = cfg["users"].as_array_mut() { a.retain(|x| x["name"] != user.as_str()); }
    }
    if cfg["current-context"] == ctx.context.as_str() {
        cfg["current-context"] = json!("");
    }

    let backup = PathBuf::from(format!("{}.opsdeck-bak-{}", ctx.file, chrono::Local::now().format("%Y%m%d-%H%M%S")));
    write_private(&backup, &raw)?;
    let imported = path.parent() == Some(imported_dir()?.as_path());
    if imported && left == 0 {
        fs::remove_file(&path).map_err(err)?;
    } else {
        write_private(&path, &serde_yaml_ng::to_string(&cfg).map_err(err)?)?;
    }
    Ok(backup.to_string_lossy().into_owned())
}

/// Single-context kubeconfig for kubectl/helm/k9s in a terminal tab. Relative cert paths are
/// made absolute so the file works from its new location.
#[tauri::command]
pub fn k8s_shell_config(ctx: Ctx, namespace: Option<String>) -> Result<String, String> {
    let src = PathBuf::from(&ctx.file);
    let out = single_context(&src, &ctx.context, namespace.as_deref())?;
    let dir = dirs::config_dir().ok_or("no config dir")?.join("opsdeck").join("run");
    fs::create_dir_all(&dir).map_err(err)?;
    crate::store::restrict(&dir, 0o700)?;
    let stem = src.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let path = dir.join(format!("{}.yaml", sanitize(&format!("{stem}-{}", ctx.context))));
    write_private(&path, &serde_yaml_ng::to_string(&out).map_err(err)?)?;
    Ok(path.to_string_lossy().into_owned())
}

/// Copies the chosen contexts of a shared kubeconfig into OpsDeck's store, one file per context.
/// Returns the created file names.
#[tauri::command]
pub fn k8s_import_contexts(file: String, contexts: Vec<String>) -> Result<Vec<String>, String> {
    let src = PathBuf::from(&file);
    let dir = imported_dir()?;
    let mut created = Vec::new();
    for name in contexts {
        let cfg = single_context(&src, &name, None)?;
        let base = sanitize(&name);
        let mut target = dir.join(format!("{base}.yaml"));
        let mut n = 2;
        while target.exists() {
            target = dir.join(format!("{base}-{n}.yaml"));
            n += 1;
        }
        write_private(&target, &serde_yaml_ng::to_string(&cfg).map_err(err)?)?;
        created.push(target.file_name().unwrap_or_default().to_string_lossy().into_owned());
    }
    Ok(created)
}

/// A standalone kubeconfig with one context and the cluster/user it references.
/// Relative cert paths are made absolute so the result works from any location.
fn single_context(src: &Path, context: &str, namespace: Option<&str>) -> Result<Value, String> {
    let cfg = read_yaml(src)?;
    let mut c = named(&cfg, "contexts", context).ok_or_else(|| format!("контекст {context} не найден"))?.clone();
    if let Some(ns) = namespace.filter(|n| !n.is_empty()) {
        c["context"]["namespace"] = json!(ns);
    }
    let base = src.parent().unwrap_or(Path::new("/"));
    let absolutize = |mut v: Value, section: &str, keys: &[&str]| {
        for k in keys {
            if let Some(p) = v[section][*k].as_str().filter(|p| Path::new(p).is_relative()) {
                v[section][*k] = json!(base.join(p).to_string_lossy());
            }
        }
        v
    };
    let cluster = named(&cfg, "clusters", c["context"]["cluster"].as_str().unwrap_or_default())
        .cloned()
        .map(|v| absolutize(v, "cluster", &["certificate-authority"]));
    let user = named(&cfg, "users", c["context"]["user"].as_str().unwrap_or_default())
        .cloned()
        .map(|v| absolutize(v, "user", &["client-certificate", "client-key"]));

    Ok(json!({
        "apiVersion": "v1",
        "kind": "Config",
        "current-context": context,
        "contexts": [c],
        "clusters": cluster.into_iter().collect::<Vec<_>>(),
        "users": user.into_iter().collect::<Vec<_>>(),
    }))
}

// ---------- per-context preferences ----------

const PREFS_FILE: &str = "k8s.json";

/// Contexts are keyed as "<kubeconfig file>|<context name>".
#[derive(Serialize, Deserialize, Default)]
pub struct K8sPrefs {
    #[serde(default)]
    hidden: Vec<String>,
    /// Read-only contexts: apply / delete / scale / restart are refused by the backend.
    #[serde(default)]
    readonly: Vec<String>,
}

fn ctx_key(ctx: &Ctx) -> String {
    format!("{}|{}", ctx.file, ctx.context)
}

#[tauri::command]
pub fn k8s_prefs_get() -> K8sPrefs {
    crate::store::load_json(PREFS_FILE).unwrap_or_default()
}

#[tauri::command]
pub fn k8s_prefs_set(prefs: K8sPrefs) -> Result<(), String> {
    crate::store::save_json(PREFS_FILE, &prefs)
}

fn ensure_writable(ctx: &Ctx) -> Result<(), String> {
    if k8s_prefs_get().readonly.contains(&ctx_key(ctx)) {
        return Err(format!("контекст «{}» в режиме только чтения — снимите 🔒, чтобы менять ресурсы", ctx.context));
    }
    Ok(())
}

// ---------- API access ----------

async fn client(state: &K8sState, ctx: &Ctx) -> Result<Client, String> {
    let key = (ctx.file.clone(), ctx.context.clone());
    if let Some(c) = state.clients.lock().await.get(&key) {
        return Ok(c.clone());
    }
    let kc = Kubeconfig::read_from(&ctx.file).map_err(err)?;
    let opts = KubeConfigOptions { context: Some(ctx.context.clone()), ..Default::default() };
    let mut cfg = Config::from_custom_kubeconfig(kc, &opts).await.map_err(err)?;
    cfg.connect_timeout = Some(Duration::from_secs(5));
    // log follow streams can be silent for a long time; per-request timeouts are applied below
    cfg.read_timeout = None;
    let c = Client::try_from(cfg).map_err(err)?;
    state.clients.lock().await.insert(key, c.clone());
    Ok(c)
}

/// Drop a cached client after a failure so expired exec/oidc tokens get re-fetched.
async fn forget(state: &K8sState, ctx: &Ctx) {
    state.clients.lock().await.remove(&(ctx.file.clone(), ctx.context.clone()));
}

/// Error text with its causes: "ServiceError: client error (SendRequest)" alone says nothing,
/// the reason ("connection closed before message completed", "connection reset"…) is in the chain.
fn describe(e: &(dyn std::error::Error + 'static)) -> String {
    let mut s = e.to_string();
    let mut cur = e.source();
    while let Some(c) = cur {
        let t = c.to_string();
        if !s.contains(&t) {
            s.push_str(": ");
            s.push_str(&t);
        }
        cur = c.source();
    }
    s
}

async fn timed<T, E: std::error::Error + 'static>(fut: impl std::future::Future<Output = Result<T, E>>) -> Result<T, String> {
    match tokio::time::timeout(REQUEST_TIMEOUT, fut).await {
        Ok(r) => r.map_err(|e| describe(&e)),
        Err(_) => Err("таймаут запроса к API (20 с)".into()),
    }
}

/// The request never got a proper answer: dead pooled connection, reset, TLS/connect failure.
fn is_transport(e: &kube::Error) -> bool {
    matches!(e, kube::Error::Service(_) | kube::Error::HyperError(_))
}

/// Runs an API call; on a transport error drops the cached client (and with it the pool of
/// keep-alive connections the server or a load balancer may have closed) and tries once more
/// on a fresh connection. For non-idempotent calls pass `retry = false`.
async fn call<T, Fut>(state: &K8sState, ctx: &Ctx, what: &str, retry: bool, f: impl Fn(Client) -> Fut) -> Result<T, kube::Error>
where
    Fut: std::future::Future<Output = Result<T, kube::Error>>,
{
    let timeout = |fut: Fut| async move {
        tokio::time::timeout(REQUEST_TIMEOUT, fut)
            .await
            .unwrap_or_else(|_| Err(kube::Error::Service("таймаут запроса к API (20 с)".into())))
    };
    let c = client(state, ctx).await.map_err(|e| kube::Error::Service(e.into()))?;
    match timeout(f(c)).await {
        Err(e) if is_transport(&e) => {
            log::warn!("k8s {what} [{}]: {}; повтор на новом соединении", ctx.context, describe(&e));
            forget(state, ctx).await;
            if !retry {
                return Err(e);
            }
            let c = client(state, ctx).await.map_err(|e| kube::Error::Service(e.into()))?;
            let r = timeout(f(c)).await;
            if let Err(e) = &r {
                log::error!("k8s {what} [{}]: {}", ctx.context, describe(e));
            }
            r
        }
        Err(e) => {
            if !matches!(&e, kube::Error::Api(s) if s.code == 404 || s.code == 409) {
                log::warn!("k8s {what} [{}]: {}", ctx.context, describe(&e));
            }
            Err(e)
        }
        ok => ok,
    }
}

/// (group, version, kind, plural, namespaced)
const KINDS: &[(&str, &str, &str, &str, bool)] = &[
    ("", "v1", "Pod", "pods", true),
    ("apps", "v1", "Deployment", "deployments", true),
    ("apps", "v1", "StatefulSet", "statefulsets", true),
    ("apps", "v1", "DaemonSet", "daemonsets", true),
    ("apps", "v1", "ReplicaSet", "replicasets", true),
    ("batch", "v1", "Job", "jobs", true),
    ("batch", "v1", "CronJob", "cronjobs", true),
    ("", "v1", "Service", "services", true),
    ("networking.k8s.io", "v1", "Ingress", "ingresses", true),
    ("", "v1", "ConfigMap", "configmaps", true),
    ("", "v1", "Secret", "secrets", true),
    ("", "v1", "PersistentVolumeClaim", "persistentvolumeclaims", true),
    ("", "v1", "Event", "events", true),
    ("", "v1", "Node", "nodes", false),
    ("", "v1", "Namespace", "namespaces", false),
    ("", "v1", "PersistentVolume", "persistentvolumes", false),
    ("argoproj.io", "v1alpha1", "Application", "applications", true),
];

/// Built-in kinds by plural, or custom resources as "crd:<group>/<version>/<plural>/<Kind>/<namespaced>".
fn resource(kind: &str) -> Result<(ApiResource, bool), String> {
    if let Some(rest) = kind.strip_prefix("crd:") {
        let p: Vec<&str> = rest.split('/').collect();
        let [g, v, plural, k, namespaced] = p[..] else { return Err(format!("bad resource id {kind}")) };
        return Ok((ApiResource::from_gvk_with_plural(&GroupVersionKind::gvk(g, v, k), plural), namespaced == "true"));
    }
    let &(g, v, k, plural, namespaced) =
        KINDS.iter().find(|x| x.3 == kind).ok_or_else(|| format!("unknown kind {kind}"))?;
    Ok((ApiResource::from_gvk_with_plural(&GroupVersionKind::gvk(g, v, k), plural), namespaced))
}

fn api(client: Client, kind: &str, ns: Option<&str>) -> Result<Api<DynamicObject>, String> {
    let (ar, namespaced) = resource(kind)?;
    Ok(match (namespaced, ns.filter(|n| !n.is_empty())) {
        (true, Some(ns)) => Api::namespaced_with(client, ns, &ar),
        _ => Api::all_with(client, &ar),
    })
}

/// `call` for a built-in kind/CRD: the closure gets a ready Api (on a fresh client when retried).
async fn with_api<T, Fut>(
    state: &K8sState,
    ctx: &Ctx,
    what: &str,
    kind: &str,
    ns: Option<&str>,
    f: impl Fn(Api<DynamicObject>) -> Fut,
) -> Result<T, kube::Error>
where
    Fut: std::future::Future<Output = Result<T, kube::Error>>,
{
    let (ar, namespaced) = resource(kind).map_err(|e| kube::Error::Service(e.into()))?;
    let ns = ns.filter(|n| namespaced && !n.is_empty());
    call(state, ctx, what, true, |c| {
        f(match ns {
            Some(ns) => Api::namespaced_with(c, ns, &ar),
            None => Api::all_with(c, &ar),
        })
    })
    .await
}

fn clean(mut v: Value) -> Value {
    if let Some(meta) = v.get_mut("metadata").and_then(Value::as_object_mut) {
        meta.remove("managedFields");
        if let Some(a) = meta.get_mut("annotations").and_then(Value::as_object_mut) {
            a.remove("kubectl.kubernetes.io/last-applied-configuration");
        }
    }
    v
}

#[tauri::command]
pub async fn k8s_list(
    state: State<'_, K8sState>,
    ctx: Ctx,
    kind: String,
    namespace: Option<String>,
) -> Result<Vec<Value>, String> {
    let res = with_api(&state, &ctx, &format!("list {kind}"), &kind, namespace.as_deref(), |a| async move {
        a.list(&ListParams::default()).await
    })
    .await;
    match res {
        Ok(list) => Ok(list.items.into_iter().filter_map(|o| serde_json::to_value(o).ok()).map(clean).collect()),
        Err(e) => {
            forget(&state, &ctx).await; // e.g. an expired exec/oidc token
            Err(describe(&e))
        }
    }
}

#[tauri::command]
pub async fn k8s_get_yaml(
    state: State<'_, K8sState>,
    ctx: Ctx,
    kind: String,
    namespace: Option<String>,
    name: String,
) -> Result<String, String> {
    let obj = with_api(&state, &ctx, &format!("get {kind}/{name}"), &kind, namespace.as_deref(), |a| {
        let name = name.clone();
        async move { a.get(&name).await }
    })
    .await
    .map_err(|e| describe(&e))?;
    serde_yaml_ng::to_string(&clean(serde_json::to_value(obj).map_err(err)?)).map_err(err)
}

/// Server-side apply of an edited manifest. resourceVersion (if kept) acts as a conflict guard.
#[tauri::command]
pub async fn k8s_apply_yaml(
    state: State<'_, K8sState>,
    ctx: Ctx,
    kind: String,
    namespace: Option<String>,
    yaml: String,
) -> Result<(), String> {
    ensure_writable(&ctx)?;
    let v = clean(serde_yaml_ng::from_str::<Value>(&yaml).map_err(|e| format!("YAML: {e}"))?);
    let name = v["metadata"]["name"].as_str().ok_or("metadata.name missing")?.to_string();
    let ns = v["metadata"]["namespace"].as_str().map(str::to_string).or(namespace);
    let params = PatchParams::apply("opsdeck").force();
    with_api(&state, &ctx, &format!("apply {kind}/{name}"), &kind, ns.as_deref(), |a| {
        let (name, params, v) = (name.clone(), params.clone(), v.clone());
        async move { a.patch(&name, &params, &Patch::Apply(&v)).await }
    })
    .await
    .map_err(|e| describe(&e))?;
    Ok(())
}

#[tauri::command]
pub async fn k8s_delete(
    state: State<'_, K8sState>,
    ctx: Ctx,
    kind: String,
    namespace: Option<String>,
    name: String,
    force: Option<bool>,
) -> Result<(), String> {
    ensure_writable(&ctx)?;
    // force = `kubectl delete --grace-period=0 --force`: the object goes away without waiting for the
    // kubelet (a pod stuck in Terminating on a node that is offline)
    let dp = if force.unwrap_or(false) { DeleteParams { grace_period_seconds: Some(0), ..DeleteParams::default() } } else { DeleteParams::default() };
    let what = format!("delete {kind}/{name}{}", if force.unwrap_or(false) { " (force)" } else { "" });
    let r = with_api(&state, &ctx, &what, &kind, namespace.as_deref(), |a| {
        let (name, dp) = (name.clone(), dp.clone());
        async move { a.delete(&name, &dp).await }
    })
    .await;
    match r {
        Ok(_) => Ok(()),
        // the first attempt may have gone through before the connection died
        Err(kube::Error::Api(s)) if s.code == 404 => Ok(()),
        Err(e) => Err(describe(&e)),
    }
}

#[tauri::command]
pub async fn k8s_scale(
    state: State<'_, K8sState>,
    ctx: Ctx,
    kind: String,
    namespace: String,
    name: String,
    replicas: u32,
) -> Result<(), String> {
    ensure_writable(&ctx)?;
    if !matches!(kind.as_str(), "deployments" | "statefulsets" | "replicasets") {
        return Err("scale не поддерживается для этого типа".into());
    }
    let patch = json!({ "spec": { "replicas": replicas } });
    merge_patch(&state, &ctx, &format!("scale {kind}/{name}"), &kind, &namespace, &name, patch).await?;
    Ok(())
}

/// Merge patch with the retry of `with_api` (merge patches with fixed values are idempotent).
async fn merge_patch(state: &K8sState, ctx: &Ctx, what: &str, kind: &str, ns: &str, name: &str, patch: Value) -> Result<(), String> {
    with_api(state, ctx, what, kind, Some(ns), |a| {
        let (name, patch) = (name.to_string(), patch.clone());
        async move { a.patch(&name, &PatchParams::default(), &Patch::Merge(&patch)).await }
    })
    .await
    .map(|_| ())
    .map_err(|e| describe(&e))
}

/// Same as `kubectl rollout restart`.
#[tauri::command]
pub async fn k8s_restart(
    state: State<'_, K8sState>,
    ctx: Ctx,
    kind: String,
    namespace: String,
    name: String,
) -> Result<(), String> {
    ensure_writable(&ctx)?;
    if !matches!(kind.as_str(), "deployments" | "statefulsets" | "daemonsets") {
        return Err("restart не поддерживается для этого типа".into());
    }
    // the timestamp is fixed before the call, so a retry sets the same value (one restart)
    let now = chrono::Utc::now().to_rfc3339();
    let patch = json!({ "spec": { "template": { "metadata": { "annotations": {
        "kubectl.kubernetes.io/restartedAt": now } } } } });
    merge_patch(&state, &ctx, &format!("restart {kind}/{name}"), &kind, &namespace, &name, patch).await?;
    Ok(())
}

// ---------- logs ----------

#[derive(Deserialize)]
pub struct LogRequest {
    namespace: String,
    pod: String,
    container: Option<String>,
    tail: Option<i64>,
    previous: Option<bool>,
    timestamps: Option<bool>,
}

/// Streams lines as `k8s-log-{id}` (batched), then `k8s-log-end-{id}` with an optional error.
#[tauri::command]
pub async fn k8s_logs_start(
    app: AppHandle,
    state: State<'_, K8sState>,
    ctx: Ctx,
    id: String,
    req: LogRequest,
) -> Result<(), String> {
    let c = client(&state, &ctx).await?;
    let pods: Api<Pod> = Api::namespaced(c, &req.namespace);
    let previous = req.previous.unwrap_or(false);
    let lp = LogParams {
        container: req.container.filter(|c| !c.is_empty()),
        follow: !previous,
        previous,
        tail_lines: Some(req.tail.unwrap_or(500)),
        timestamps: req.timestamps.unwrap_or(false),
        ..Default::default()
    };
    let reader = timed(pods.log_stream(&req.pod, &lp)).await?;

    let (tx, mut rx) = oneshot::channel();
    if let Some(old) = state.logs.lock().unwrap().insert(id.clone(), tx) {
        let _ = old.send(());
    }

    tauri::async_runtime::spawn(async move {
        let mut lines = reader.lines();
        let mut batch: Vec<String> = Vec::new();
        let mut tick = tokio::time::interval(Duration::from_millis(100));
        let data_event = format!("k8s-log-{id}");
        let error = loop {
            tokio::select! {
                _ = &mut rx => break None,
                _ = tick.tick() => {
                    if !batch.is_empty() { let _ = app.emit(&data_event, std::mem::take(&mut batch)); }
                }
                line = lines.next() => match line {
                    Some(Ok(l)) => {
                        batch.push(l);
                        if batch.len() >= 1000 { let _ = app.emit(&data_event, std::mem::take(&mut batch)); }
                    }
                    Some(Err(e)) => break Some(e.to_string()),
                    None => break None,
                },
            }
        };
        if !batch.is_empty() {
            let _ = app.emit(&data_event, batch);
        }
        let _ = app.emit(&format!("k8s-log-end-{id}"), error);
    });
    Ok(())
}

#[tauri::command]
pub fn k8s_logs_stop(state: State<K8sState>, id: String) {
    if let Some(tx) = state.logs.lock().unwrap().remove(&id) {
        let _ = tx.send(());
    }
    if let Some(tx) = state.workload_logs.lock().unwrap().remove(&id) {
        let _ = tx.send(true);
    }
}

// ---------- logs of every pod of a workload ----------

const MAX_WORKLOAD_PODS: usize = 40;

#[derive(Serialize, Clone)]
struct PodLine {
    pod: String,
    container: String,
    line: String,
}

#[derive(Deserialize)]
pub struct WorkloadLogRequest {
    kind: String,
    namespace: String,
    name: String,
    /// None = all containers
    container: Option<String>,
    tail: Option<i64>,
    timestamps: Option<bool>,
}

/// Label selector string from `spec.selector` (matchLabels + matchExpressions).
fn selector_string(sel: &Value) -> Option<String> {
    let mut parts: Vec<String> = sel["matchLabels"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(k, v)| format!("{k}={}", v.as_str().unwrap_or_default()))
        .collect();
    for e in sel["matchExpressions"].as_array().into_iter().flatten() {
        let key = e["key"].as_str()?;
        let vals: Vec<&str> = e["values"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
        parts.push(match e["operator"].as_str()? {
            "In" => format!("{key} in ({})", vals.join(",")),
            "NotIn" => format!("{key} notin ({})", vals.join(",")),
            "Exists" => key.to_string(),
            "DoesNotExist" => format!("!{key}"),
            _ => return None,
        });
    }
    (!parts.is_empty()).then(|| parts.join(","))
}

/// Streams logs of all pods selected by a Deployment/StatefulSet/DaemonSet/ReplicaSet/Job into
/// `k8s-log-{id}` as batches of {pod, container, line}; `k8s-log-pods-{id}` gets the list of
/// streamed pods whenever it changes. Pods created later (rollouts) are picked up via watch.
#[tauri::command]
pub async fn k8s_logs_workload_start(
    app: AppHandle,
    state: State<'_, K8sState>,
    ctx: Ctx,
    id: String,
    req: WorkloadLogRequest,
) -> Result<(), String> {
    use kube::runtime::{watcher, WatchStreamExt};
    let c = client(&state, &ctx).await?;
    let obj = timed(api(c.clone(), &req.kind, Some(&req.namespace))?.get(&req.name)).await?;
    let selector = selector_string(&obj.data["spec"]["selector"]).ok_or("у ресурса нет селектора подов")?;

    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
    if let Some(old) = state.workload_logs.lock().unwrap().insert(id.clone(), stop_tx) {
        let _ = old.send(true);
    }
    let (line_tx, mut line_rx) = mpsc_channel();

    // aggregator: batch lines from every container stream
    {
        let app = app.clone();
        let mut stop = stop_rx.clone();
        let event = format!("k8s-log-{id}");
        tauri::async_runtime::spawn(async move {
            let mut batch: Vec<PodLine> = Vec::new();
            let mut tick = tokio::time::interval(Duration::from_millis(150));
            loop {
                tokio::select! {
                    _ = stop.changed() => break,
                    _ = tick.tick() => if !batch.is_empty() { let _ = app.emit(&event, std::mem::take(&mut batch)); },
                    l = line_rx.recv() => match l {
                        Some(l) => { batch.push(l); if batch.len() >= 2000 { let _ = app.emit(&event, std::mem::take(&mut batch)); } }
                        None => break,
                    },
                }
            }
        });
    }

    // pod watcher: start a stream per (pod, container) once the container is running
    let pods: Api<Pod> = Api::namespaced(c, &req.namespace);
    let started = std::time::Instant::now();
    let tail = req.tail.unwrap_or(200);
    let timestamps = req.timestamps.unwrap_or(false);
    let only = req.container.filter(|c| !c.is_empty());
    tauri::async_runtime::spawn(async move {
        let active: std::sync::Arc<std::sync::Mutex<std::collections::HashSet<(String, String)>>> = Default::default();
        let mut stream = watcher(pods.clone(), watcher::Config::default().labels(&selector)).default_backoff().boxed();
        let mut stop = stop_rx.clone();
        let pods_event = format!("k8s-log-pods-{id}");
        let mut known: std::collections::BTreeSet<String> = Default::default();
        loop {
            let ev = tokio::select! {
                _ = stop.changed() => break,
                ev = stream.next() => match ev { Some(Ok(ev)) => ev, Some(Err(_)) => continue, None => break },
            };
            let (pod, removed) = match ev {
                watcher::Event::Apply(p) | watcher::Event::InitApply(p) => (p, false),
                watcher::Event::Delete(p) => (p, true),
                _ => continue,
            };
            let pod_name = pod.metadata.name.clone().unwrap_or_default();
            let changed = if removed { known.remove(&pod_name) } else { known.insert(pod_name.clone()) };
            if changed {
                let _ = app.emit(&pods_event, known.iter().collect::<Vec<_>>());
            }
            if removed || known.len() > MAX_WORKLOAD_PODS {
                continue;
            }
            let running: Vec<String> = pod.status.as_ref().and_then(|s| s.container_statuses.as_ref()).into_iter().flatten()
                .filter(|cs| cs.state.as_ref().is_some_and(|st| st.running.is_some()))
                .map(|cs| cs.name.clone())
                .filter(|n| only.as_ref().is_none_or(|o| o == n))
                .collect();
            for container in running {
                let key = (pod_name.clone(), container.clone());
                if !active.lock().unwrap().insert(key.clone()) {
                    continue; // already streaming
                }
                // pods that existed at start get the tail; later ones (rollout) are shown from their start
                let fresh = started.elapsed() > Duration::from_secs(3);
                let lp = LogParams {
                    container: Some(container.clone()),
                    follow: true,
                    tail_lines: if fresh { None } else { Some(tail) },
                    timestamps,
                    ..Default::default()
                };
                let (pods, tx, active, mut stop) = (pods.clone(), line_tx.clone(), active.clone(), stop_rx.clone());
                tauri::async_runtime::spawn(async move {
                    if let Ok(reader) = pods.log_stream(&key.0, &lp).await {
                        let mut lines = reader.lines();
                        loop {
                            tokio::select! {
                                _ = stop.changed() => break,
                                l = lines.next() => match l {
                                    Some(Ok(line)) => { if tx.send(PodLine { pod: key.0.clone(), container: key.1.clone(), line }).is_err() { break; } }
                                    _ => break,
                                },
                            }
                        }
                    }
                    // container stopped/restarted: allow a new stream on the next pod update
                    active.lock().unwrap().remove(&key);
                });
            }
        }
    });
    Ok(())
}

fn mpsc_channel() -> (tokio::sync::mpsc::UnboundedSender<PodLine>, tokio::sync::mpsc::UnboundedReceiver<PodLine>) {
    tokio::sync::mpsc::unbounded_channel()
}



// ---------- live watch ----------

/// Streams a resource list: `k8s-watch-{id}` gets {type:"reset", items} after every (re)list,
/// then batched {type:"apply", items} / {type:"delete", uids}; {type:"error", message} on failures.
#[tauri::command]
pub async fn k8s_watch_start(
    app: AppHandle,
    state: State<'_, K8sState>,
    ctx: Ctx,
    id: String,
    kind: String,
    namespace: Option<String>,
) -> Result<(), String> {
    use kube::runtime::{watcher, WatchStreamExt};
    let c = client(&state, &ctx).await?;
    let api = api(c, &kind, namespace.as_deref())?;
    let (tx, mut stop) = oneshot::channel();
    if let Some(old) = state.watches.lock().unwrap().insert(id.clone(), tx) {
        let _ = old.send(());
    }
    let event = format!("k8s-watch-{id}");
    tauri::async_runtime::spawn(async move {
        let mut stream = watcher(api, watcher::Config::default()).default_backoff().boxed();
        let mut init: Vec<Value> = Vec::new();
        let (mut applied, mut deleted): (Vec<Value>, Vec<String>) = (Vec::new(), Vec::new());
        let mut tick = tokio::time::interval(Duration::from_millis(300));
        let mut errored = false;
        let mut listed = false; // got at least one full list
        let to_value = |o: DynamicObject| serde_json::to_value(o).ok().map(clean);
        loop {
            tokio::select! {
                _ = &mut stop => break,
                _ = tick.tick() => {
                    if !applied.is_empty() { let _ = app.emit(&event, json!({ "type": "apply", "items": std::mem::take(&mut applied) })); }
                    if !deleted.is_empty() { let _ = app.emit(&event, json!({ "type": "delete", "uids": std::mem::take(&mut deleted) })); }
                }
                ev = stream.next() => match ev {
                    None => break,
                    Some(Err(e)) => {
                        // Dropped watch connections ("error reading a body from connection") are routine:
                        // API servers/proxies close long-lived streams and the watcher resumes by itself.
                        // Only tell the UI when nothing could be listed yet or access is denied.
                        let msg = e.to_string();
                        let denied = ["401", "403", "Unauthorized", "Forbidden", "forbidden"].iter().any(|k| msg.contains(k));
                        if (!listed || denied) && !errored {
                            let _ = app.emit(&event, json!({ "type": "error", "message": msg }));
                        }
                        errored = true;
                    }
                    Some(Ok(ev)) => {
                        errored = false;
                        match ev {
                            watcher::Event::Init => init.clear(),
                            watcher::Event::InitApply(o) => init.extend(to_value(o)),
                            watcher::Event::InitDone => {
                                listed = true;
                                applied.clear();
                                deleted.clear();
                                let _ = app.emit(&event, json!({ "type": "reset", "items": std::mem::take(&mut init) }));
                            }
                            watcher::Event::Apply(o) => applied.extend(to_value(o)),
                            watcher::Event::Delete(o) => deleted.extend(o.metadata.uid),
                        }
                    }
                },
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub fn k8s_watch_stop(state: State<K8sState>, id: String) {
    if let Some(tx) = state.watches.lock().unwrap().remove(&id) {
        let _ = tx.send(());
    }
}

// ---------- metrics-server ----------

/// CPU in millicores from a quantity like "123456789n", "250m", "2".
fn cpu_milli(q: &str) -> f64 {
    let (num, mult) = match q.chars().last() {
        Some('n') => (&q[..q.len() - 1], 1e-6),
        Some('u') => (&q[..q.len() - 1], 1e-3),
        Some('m') => (&q[..q.len() - 1], 1.0),
        _ => (q, 1000.0),
    };
    num.parse::<f64>().unwrap_or(0.0) * mult
}

/// Memory in bytes from a quantity like "123456Ki", "512Mi", "1G", "1024".
fn mem_bytes(q: &str) -> f64 {
    const UNITS: &[(&str, f64)] = &[
        ("Ki", 1024.0), ("Mi", 1048576.0), ("Gi", 1073741824.0), ("Ti", 1099511627776.0),
        ("k", 1e3), ("M", 1e6), ("G", 1e9), ("T", 1e12),
    ];
    for (suffix, mult) in UNITS {
        if let Some(n) = q.strip_suffix(suffix) {
            return n.parse::<f64>().unwrap_or(0.0) * mult;
        }
    }
    q.parse().unwrap_or(0.0)
}

#[derive(Serialize)]
pub struct Usage {
    namespace: String,
    name: String,
    cpu_m: f64,
    mem: f64,
}

/// Current usage from metrics.k8s.io for "pods" (summed over containers) or "nodes".
#[tauri::command]
pub async fn k8s_metrics(state: State<'_, K8sState>, ctx: Ctx, kind: String, namespace: Option<String>) -> Result<Vec<Usage>, String> {
    metrics(&state, &ctx, &kind, namespace.as_deref()).await
}

async fn metrics(state: &K8sState, ctx: &Ctx, kind: &str, namespace: Option<&str>) -> Result<Vec<Usage>, String> {
    let (k, plural, namespaced) = match kind {
        "pods" => ("PodMetrics", "pods", true),
        "nodes" => ("NodeMetrics", "nodes", false),
        _ => return Err("metrics only for pods and nodes".into()),
    };
    let ar = ApiResource::from_gvk_with_plural(&GroupVersionKind::gvk("metrics.k8s.io", "v1beta1", k), plural);
    let c = client(state, ctx).await?;
    let api: Api<DynamicObject> = match (namespaced, namespace.filter(|n| !n.is_empty())) {
        (true, Some(ns)) => Api::namespaced_with(c, ns, &ar),
        _ => Api::all_with(c, &ar),
    };
    let list = timed(api.list(&ListParams::default())).await?;
    Ok(list
        .items
        .into_iter()
        .map(|o| {
            let usages: Vec<&Value> = match o.data["containers"].as_array() {
                Some(cs) => cs.iter().map(|c| &c["usage"]).collect(),
                None => vec![&o.data["usage"]],
            };
            Usage {
                namespace: o.metadata.namespace.clone().unwrap_or_default(),
                name: o.metadata.name.clone().unwrap_or_default(),
                cpu_m: usages.iter().map(|u| cpu_milli(u["cpu"].as_str().unwrap_or("0"))).sum(),
                mem: usages.iter().map(|u| mem_bytes(u["memory"].as_str().unwrap_or("0"))).sum(),
            }
        })
        .collect())
}

// ---------- Helm (releases are stored as secrets of type helm.sh/release.v1) ----------

/// Secret payload: base64 text of gzipped release JSON (the API already undid the outer base64).
fn decode_release(sec: &Secret) -> Option<Value> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use std::io::Read;
    let raw = sec.data.as_ref()?.get("release")?;
    let gz = STANDARD.decode(&raw.0).ok()?;
    let mut json = String::new();
    flate2::read::GzDecoder::new(&gz[..]).read_to_string(&mut json).ok()?;
    serde_json::from_str(&json).ok()
}

fn release_summary(r: &Value) -> Value {
    let meta = &r["chart"]["metadata"];
    json!({
        "name": r["name"], "namespace": r["namespace"], "revision": r["version"],
        "status": r["info"]["status"], "updated": r["info"]["last_deployed"],
        "description": r["info"]["description"],
        "chart": format!("{}-{}", meta["name"].as_str().unwrap_or("?"), meta["version"].as_str().unwrap_or("?")),
        "app_version": meta["appVersion"],
    })
}

fn helm_api(c: Client, namespace: Option<&str>) -> Api<Secret> {
    match namespace.filter(|n| !n.is_empty()) {
        Some(ns) => Api::namespaced(c, ns),
        None => Api::all(c),
    }
}

/// (namespace, secret name, release name, revision, status) from metadata only — release
/// secrets are large, so bodies are fetched one by one when actually needed.
async fn helm_index(state: &K8sState, ctx: &Ctx, namespace: Option<&str>, name: Option<&str>) -> Result<Vec<(String, String, String, u64, String)>, String> {
    let c = client(state, ctx).await?;
    let mut selector = "owner=helm".to_string();
    if let Some(n) = name {
        selector.push_str(&format!(",name={n}"));
    }
    let list = timed(helm_api(c, namespace).list_metadata(&ListParams::default().labels(&selector))).await?;
    Ok(list
        .items
        .into_iter()
        .map(|m| {
            let l = m.metadata.labels.unwrap_or_default();
            let get = |k: &str| l.get(k).cloned().unwrap_or_default();
            (
                m.metadata.namespace.unwrap_or_default(),
                m.metadata.name.unwrap_or_default(),
                get("name"),
                get("version").parse().unwrap_or(0),
                get("status"),
            )
        })
        .collect())
}

async fn helm_get(state: &K8sState, ctx: &Ctx, namespace: &str, secret: &str) -> Result<Value, String> {
    let c = client(state, ctx).await?;
    let s = timed(helm_api(c, Some(namespace)).get(secret)).await?;
    decode_release(&s).ok_or_else(|| format!("не удалось разобрать {secret}"))
}

/// Latest revision of every release, plus revision count.
#[tauri::command]
pub async fn k8s_helm_releases(state: State<'_, K8sState>, ctx: Ctx, namespace: Option<String>) -> Result<Vec<Value>, String> {
    helm_releases(&state, &ctx, namespace.as_deref()).await
}

async fn helm_releases(state: &K8sState, ctx: &Ctx, namespace: Option<&str>) -> Result<Vec<Value>, String> {
    let index = helm_index(state, ctx, namespace, None).await?;
    let mut latest: HashMap<(String, String), (u64, usize, String)> = HashMap::new();
    for (ns, secret, name, rev, _) in index {
        let e = latest.entry((ns, name)).or_insert((0, 0, String::new()));
        e.1 += 1;
        if rev >= e.0 {
            e.0 = rev;
            e.2 = secret;
        }
    }
    let fetches = latest.into_iter().map(|((ns, name), (_, count, secret))| async move {
        let r = helm_get(state, ctx, &ns, &secret).await.ok()?;
        let mut v = release_summary(&r);
        v["revisions"] = json!(count);
        v["metadata"] = json!({ "name": name, "namespace": ns, "uid": format!("helm/{ns}/{name}") });
        Some(v)
    });
    let mut out: Vec<Value> = futures::future::join_all(fetches).await.into_iter().flatten().collect();
    out.sort_by(|a, b| (a["namespace"].as_str(), a["name"].as_str()).cmp(&(b["namespace"].as_str(), b["name"].as_str())));
    Ok(out)
}

/// Values, manifest and notes of the latest revision + full history of one release.
#[tauri::command]
pub async fn k8s_helm_release(state: State<'_, K8sState>, ctx: Ctx, namespace: String, name: String) -> Result<Value, String> {
    let mut index = helm_index(&state, &ctx, Some(&namespace), Some(&name)).await?;
    index.sort_by_key(|x| std::cmp::Reverse(x.3));
    let (_, last_secret, ..) = index.first().ok_or("релиз не найден")?.clone();
    let last = helm_get(&state, &ctx, &namespace, &last_secret).await?;
    let yaml = |v: &Value| if v.is_null() || v.as_object().is_some_and(|o| o.is_empty()) { "# значения по умолчанию из чарта\n".to_string() } else { serde_yaml_ng::to_string(v).unwrap_or_default() };
    // history needs chart/date per revision: fetch older revisions (usually a handful, capped)
    let older = index.iter().skip(1).take(20).map(|(ns, secret, ..)| helm_get(&state, &ctx, ns, secret));
    let mut history = vec![release_summary(&last)];
    history.extend(futures::future::join_all(older).await.into_iter().flatten().map(|r| release_summary(&r)));
    Ok(json!({
        "values": yaml(&last["config"]),
        "manifest": last["manifest"],
        "notes": last["info"]["notes"],
        "history": history,
    }))
}

// ---------- Argo CD ----------

/// "refresh": hard refresh annotation; "sync": set .operation like the argocd CLI does.
#[tauri::command]
pub async fn k8s_argo_action(state: State<'_, K8sState>, ctx: Ctx, namespace: String, name: String, action: String) -> Result<(), String> {
    ensure_writable(&ctx)?;
    let c = client(&state, &ctx).await?;
    let apps = api(c, "applications", Some(&namespace))?;
    let patch = match action.as_str() {
        "refresh" => json!({ "metadata": { "annotations": { "argocd.argoproj.io/refresh": "hard" } } }),
        "sync" => json!({ "operation": {
            "initiatedBy": { "username": "opsdeck" },
            "sync": { "syncStrategy": { "hook": {} } },
        } }),
        _ => return Err("unknown action".into()),
    };
    timed(apps.patch(&name, &PatchParams::default(), &Patch::Merge(&patch))).await?;
    Ok(())
}




// ---------- custom resources & object events ----------

#[derive(Serialize)]
pub struct CrdInfo {
    /// resource id usable with every k8s_* command ("crd:group/version/plural/Kind/namespaced")
    id: String,
    group: String,
    version: String,
    kind: String,
    plural: String,
    namespaced: bool,
    /// additionalPrinterColumns (priority 0): what `kubectl get` shows
    columns: Vec<Value>,
}

/// Custom resource types installed in the cluster, from CustomResourceDefinitions.
#[tauri::command]
pub async fn k8s_crds(state: State<'_, K8sState>, ctx: Ctx) -> Result<Vec<CrdInfo>, String> {
    let c = client(&state, &ctx).await?;
    let ar = ApiResource::from_gvk_with_plural(
        &GroupVersionKind::gvk("apiextensions.k8s.io", "v1", "CustomResourceDefinition"),
        "customresourcedefinitions",
    );
    let list = timed(Api::<DynamicObject>::all_with(c, &ar).list(&ListParams::default())).await?;
    let mut out: Vec<CrdInfo> = list
        .items
        .iter()
        .filter_map(|o| {
            let spec = &o.data["spec"];
            let versions = spec["versions"].as_array()?;
            // the storage version is always served; otherwise take the first served one
            let ver = versions.iter().find(|v| v["storage"] == true && v["served"] == true)
                .or_else(|| versions.iter().find(|v| v["served"] == true))?;
            let (group, version) = (spec["group"].as_str()?, ver["name"].as_str()?);
            let (kind, plural) = (spec["names"]["kind"].as_str()?, spec["names"]["plural"].as_str()?);
            let namespaced = spec["scope"] == "Namespaced";
            let columns = ver["additionalPrinterColumns"].as_array().into_iter().flatten()
                .filter(|c| c["priority"].as_i64().unwrap_or(0) == 0)
                .cloned()
                .collect();
            Some(CrdInfo {
                id: format!("crd:{group}/{version}/{plural}/{kind}/{namespaced}"),
                group: group.into(), version: version.into(), kind: kind.into(), plural: plural.into(),
                namespaced, columns,
            })
        })
        .collect();
    out.sort_by(|a, b| (&a.group, &a.kind).cmp(&(&b.group, &b.kind)));
    Ok(out)
}

/// Events about one object (by uid), newest first.
#[tauri::command]
pub async fn k8s_object_events(state: State<'_, K8sState>, ctx: Ctx, namespace: Option<String>, uid: String) -> Result<Vec<Value>, String> {
    let c = client(&state, &ctx).await?;
    let events = api(c, "events", namespace.as_deref())?;
    let lp = ListParams::default().fields(&format!("involvedObject.uid={uid}"));
    let mut items: Vec<Value> = timed(events.list(&lp)).await?.items.into_iter().filter_map(|o| serde_json::to_value(o).ok()).collect();
    let when = |e: &Value| e["lastTimestamp"].as_str().or(e["eventTime"].as_str()).or(e["metadata"]["creationTimestamp"].as_str()).unwrap_or_default().to_string();
    items.sort_by_key(|e| std::cmp::Reverse(when(e)));
    Ok(items)
}


#[cfg(test)]
mod tests {
    use super::*;

    const KUBECONFIG: &str = r#"
apiVersion: v1
kind: Config
current-context: prod
clusters:
- name: prod-cluster
  cluster: { server: "https://k8s.example.com:6443", certificate-authority: certs/ca.crt }
- name: stage-cluster
  cluster: { server: "https://stage.example.com:6443" }
users:
- name: admin
  user: { client-certificate: certs/admin.crt, client-key: /abs/admin.key }
- name: oidc
  user:
    exec: { command: kubelogin, args: [get-token, --oidc-issuer-url=https://sso.example.com] }
contexts:
- name: prod
  context: { cluster: prod-cluster, user: admin, namespace: shop }
- name: stage
  context: { cluster: stage-cluster, user: admin }
- name: stage-oidc
  context: { cluster: stage-cluster, user: oidc }
"#;

    /// A kubeconfig in its own temp folder (removed at the end of the test).
    struct Tmp(PathBuf);
    impl Tmp {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("opsdeck-k8s-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            let file = dir.join("config.yaml");
            fs::write(&file, KUBECONFIG).unwrap();
            Tmp(file)
        }
        fn dir(&self) -> &Path {
            self.0.parent().unwrap()
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(self.dir());
        }
    }

    #[test]
    fn contexts_from_a_file() {
        let t = Tmp::new("ctx");
        let list = contexts_of(vec![(t.0.clone(), "opsdeck")]);
        assert_eq!(list.len(), 3);
        let prod = &list[0];
        assert_eq!((prod.context.as_str(), prod.namespace.as_str(), prod.server.as_str()), ("prod", "shop", "https://k8s.example.com:6443"));
        assert!(prod.current);
        assert_eq!(list[1].namespace, "default", "no namespace → default");
        assert!(!list[1].current);
        assert_eq!(prod.label, "config");
    }

    #[test]
    fn one_context_extracted_with_absolute_paths() {
        let t = Tmp::new("single");
        let cfg = single_context(&t.0, "prod", Some("payments")).unwrap();
        assert_eq!(cfg["current-context"], "prod");
        assert_eq!(cfg["contexts"].as_array().unwrap().len(), 1);
        assert_eq!(cfg["contexts"][0]["context"]["namespace"], "payments", "namespace override");
        let ca = cfg["clusters"][0]["cluster"]["certificate-authority"].as_str().unwrap();
        assert_eq!(Path::new(ca), t.dir().join("certs/ca.crt"), "relative cert paths become absolute");
        let key = cfg["users"][0]["user"]["client-key"].as_str().unwrap();
        if cfg!(windows) {
            // "/abs/…" has no drive on Windows: it is on the drive of the kubeconfig
            assert!(key.ends_with("/abs/admin.key") && key.as_bytes()[1] == b':', "{key}");
        } else {
            assert_eq!(key, "/abs/admin.key", "absolute paths stay");
        }
        assert!(single_context(&t.0, "missing", None).is_err());
    }

    #[test]
    fn delete_context_keeps_shared_entries_and_makes_a_backup() {
        let t = Tmp::new("delete");
        let ctx = Ctx { file: t.0.to_string_lossy().into_owned(), context: "prod".into() };
        let backup = delete_context_in_file(&ctx).unwrap();
        assert_eq!(fs::read_to_string(&backup).unwrap(), KUBECONFIG, "backup is the original file");
        let cfg: Value = serde_yaml_ng::from_str(&fs::read_to_string(&t.0).unwrap()).unwrap();
        let names = |list: &str| cfg[list].as_array().unwrap().iter().map(|x| x["name"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        assert_eq!(names("contexts"), ["stage", "stage-oidc"]);
        assert_eq!(names("clusters"), ["stage-cluster"], "prod-cluster is no longer used");
        assert_eq!(names("users"), ["admin", "oidc"], "admin is still used by stage");
        assert_eq!(cfg["current-context"], "", "the deleted context is no longer current");
    }

    #[test]
    fn helpers() {
        assert_eq!(sanitize("prod/eu west:1"), "prod_eu_west_1");
        assert_eq!(sanitize("..hidden.."), "hidden");
        assert_eq!(sanitize(&"x".repeat(200)).len(), 80);
        let cfg: Value = serde_yaml_ng::from_str(KUBECONFIG).unwrap();
        assert_eq!(exec_commands(&cfg), ["kubelogin get-token --oidc-issuer-url=https://sso.example.com"]);
    }

    #[test]
    fn quantities() {
        assert_eq!(cpu_milli("250m"), 250.0);
        assert_eq!(cpu_milli("2"), 2000.0);
        assert_eq!(cpu_milli("1500000n"), 1.5);
        assert_eq!(cpu_milli("garbage"), 0.0);
        assert_eq!(mem_bytes("512Mi"), 512.0 * 1048576.0);
        assert_eq!(mem_bytes("1G"), 1e9);
        assert_eq!(mem_bytes("1024"), 1024.0);
    }

    #[test]
    fn yaml_cleanup_and_selectors() {
        let v = clean(json!({ "metadata": { "name": "a", "managedFields": [1], "annotations": { "kubectl.kubernetes.io/last-applied-configuration": "{}", "keep": "1" } } }));
        assert!(v["metadata"].get("managedFields").is_none());
        assert_eq!(v["metadata"]["annotations"], json!({ "keep": "1" }));
        let sel = json!({ "matchLabels": { "app": "api" }, "matchExpressions": [
            { "key": "tier", "operator": "In", "values": ["web", "api"] },
            { "key": "canary", "operator": "DoesNotExist" } ] });
        assert_eq!(selector_string(&sel).unwrap(), "app=api,tier in (web,api),!canary");
        assert!(selector_string(&json!({})).is_none());
        assert!(selector_string(&json!({ "matchExpressions": [{ "key": "x", "operator": "Weird" }] })).is_none());
    }
}
