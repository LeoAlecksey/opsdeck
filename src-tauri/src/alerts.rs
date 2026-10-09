//! Alerts and AI findings.
//! - pull (main path): OpsDeck periodically GETs Grafana's Alertmanager API, Prometheus
//!   Alertmanager `/api/v2/alerts`, and "AI feed" URLs of the connectors — nothing needs to reach
//!   this machine, so a changing IP or NAT doesn't matter;
//! - push, loopback only: a local analyzer (log/alert AI running on this machine) POSTs findings
//!   or alerts to 127.0.0.1 with its connector's token.
//!
//! Current items are keyed by fingerprint; a bounded event history is kept on disk.

use crate::{
    connectors,
    keepass::{self, KeepassState},
    passbolt::PassboltState,
    store,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    sync::{LazyLock, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::oneshot;

const CONFIG_FILE: &str = "alerts-config.json";
const DATA_FILE: &str = "alerts.json";
const HISTORY_CAP: usize = 1000;

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct AlertsConfig {
    /// loopback ingest endpoint for local analyzers
    pub ingest_enabled: bool,
    pub ingest_port: u16,
    pub poll_enabled: bool,
    pub poll_seconds: u64,
    pub notify: bool,
    pub notify_resolved: bool,
    /// "hide such alerts": rules by source + alert name; hidden from the badge and notifications
    pub muted: Vec<Mute>,
}

#[derive(Serialize, Deserialize, Clone, PartialEq)]
pub struct Mute {
    pub source: String,
    pub name: String,
}

fn is_muted(cfg: &AlertsConfig, a: &Alert) -> bool {
    cfg.muted.iter().any(|m| m.name == a.name && (m.source.is_empty() || m.source == a.source))
}

impl Default for AlertsConfig {
    fn default() -> Self {
        Self {
            ingest_enabled: true,
            ingest_port: 9095,
            poll_enabled: true,
            poll_seconds: 60,
            notify: true,
            notify_resolved: false,
            muted: Vec::new(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Link {
    pub title: String,
    pub url: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default)]
pub struct Alert {
    /// "alert" (Alertmanager/Grafana) or "ai" (finding from an analyzer)
    pub kind: String,
    pub links: Vec<Link>,
    pub fingerprint: String,
    /// firing | resolved
    pub status: String,
    pub silenced: bool,
    /// name of the connector it came from
    pub source: String,
    pub name: String,
    pub severity: String,
    pub summary: String,
    pub description: String,
    pub labels: BTreeMap<String, String>,
    pub annotations: BTreeMap<String, String>,
    pub starts_at: String,
    pub ends_at: String,
    pub generator_url: String,
    pub silence_url: String,
    pub dashboard_url: String,
    pub panel_url: String,
    pub value: String,
    pub received_at: String,
    pub acked: bool,
}

#[derive(Serialize, Deserialize, Default)]
struct Data {
    current: HashMap<String, Alert>,
    history: VecDeque<Alert>,
}

#[derive(Default)]
pub struct AlertsState {
    data: Mutex<Data>,
    ingest_stop: Mutex<Option<oneshot::Sender<()>>>,
    poll_stop: Mutex<Option<oneshot::Sender<()>>>,
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

pub fn config() -> AlertsConfig {
    store::load_json(CONFIG_FILE).unwrap_or_default()
}

// ---------- payload parsing ----------

fn str_map(v: &Value) -> BTreeMap<String, String> {
    v.as_object()
        .into_iter()
        .flatten()
        .map(|(k, v)| (k.clone(), v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string())))
        .collect()
}

fn s(v: &Value) -> String {
    v.as_str().unwrap_or_default().to_string()
}

/// One alert from the Alertmanager v2 API (webhook-style "firing"/"resolved" status also accepted).
fn parse_alert(a: &Value, source: &str) -> Alert {
    let labels = str_map(&a["labels"]);
    let annotations = str_map(&a["annotations"]);
    // API v2 has status {state: active|suppressed|unprocessed}; webhooks have "firing"/"resolved"
    let (status, silenced) = match &a["status"] {
        Value::String(st) => (st.clone(), false),
        Value::Object(o) => ("firing".to_string(), o.get("state").and_then(Value::as_str) == Some("suppressed")),
        _ => ("firing".to_string(), false),
    };
    let fingerprint = match s(&a["fingerprint"]) {
        f if !f.is_empty() => f,
        // no fingerprint (older senders): stable hash of the label set
        _ => format!("{:x}", labels.iter().fold(0xcbf29ce484222325u64, |h, (k, v)| {
            format!("{k}={v};").bytes().fold(h, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3))
        })),
    };
    let ends = s(&a["endsAt"]);
    Alert {
        kind: "alert".into(),
        links: Vec::new(),
        fingerprint,
        status,
        silenced,
        source: source.into(),
        name: labels.get("alertname").cloned().unwrap_or_else(|| "alert".into()),
        severity: labels.get("severity").or(labels.get("priority")).cloned().unwrap_or_default(),
        summary: annotations.get("summary").cloned().unwrap_or_default(),
        description: annotations.get("description").or(annotations.get("message")).cloned().unwrap_or_default(),
        starts_at: s(&a["startsAt"]),
        ends_at: if ends.starts_with("0001-") { String::new() } else { ends },
        generator_url: s(&a["generatorURL"]),
        silence_url: s(&a["silenceURL"]),
        dashboard_url: s(&a["dashboardURL"]),
        panel_url: s(&a["panelURL"]),
        value: s(&a["valueString"]),
        received_at: now(),
        labels,
        annotations,
        acked: false,
    }
}

fn fnv(s: &str) -> String {
    format!("{:x}", s.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3)))
}

/// A finding from an AI analyzer:
/// {id?, title, severity?, summary?, details?, status?: firing|resolved, labels?, links?: [{title,url}], time?}
fn parse_finding(v: &Value, source: &str) -> Option<Alert> {
    let title = s(&v["title"]);
    if title.is_empty() {
        return None;
    }
    let labels = str_map(&v["labels"]);
    let id = s(&v["id"]);
    let fingerprint = if id.is_empty() {
        fnv(&format!("{source}|{title}|{}", labels.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(",")))
    } else {
        fnv(&format!("{source}|{id}"))
    };
    let links = v["links"].as_array().into_iter().flatten()
        .filter_map(|l| {
            let url = s(&l["url"]);
            url.starts_with("http").then(|| Link { title: s(&l["title"]).chars().take(40).collect(), url })
        })
        .take(8)
        .collect();
    let status = match s(&v["status"]).as_str() {
        "resolved" | "ok" | "closed" => "resolved",
        _ => "firing",
    };
    let time = s(&v["time"]);
    Some(Alert {
        kind: "ai".into(),
        links,
        fingerprint,
        status: status.into(),
        silenced: false,
        source: source.into(),
        name: title.chars().take(200).collect(),
        severity: s(&v["severity"]),
        summary: s(&v["summary"]).chars().take(1000).collect(),
        description: s(&v["details"]).chars().take(20000).collect(),
        starts_at: if time.is_empty() { now() } else { time },
        received_at: now(),
        labels,
        ..Default::default()
    })
}

/// Alertmanager alert (has labels + startsAt/fingerprint) or AI finding (has title).
fn parse_item(v: &Value, source: &str) -> Option<Alert> {
    if v["labels"].is_object() && (v.get("startsAt").is_some() || v.get("fingerprint").is_some()) {
        Some(parse_alert(v, source))
    } else {
        parse_finding(v, source)
    }
}

/// Items of a response/POST body: a bare array, {alerts: [...]}, {findings: [...]} or one object.
fn items_of(v: &Value) -> Vec<&Value> {
    if let Some(a) = v.as_array() {
        return a.iter().collect();
    }
    for key in ["alerts", "findings", "items"] {
        if let Some(a) = v[key].as_array() {
            return a.iter().collect();
        }
    }
    if v.is_object() { vec![v] } else { Vec::new() }
}

// ---------- state updates ----------

fn persist(data: &Data) {
    let _ = store::save_json(DATA_FILE, data);
}

pub fn load_data(state: &AlertsState) {
    let d: Data = store::load_json(DATA_FILE).unwrap_or_default();
    *state.data.lock().unwrap() = d;
}

fn firing_count(d: &Data) -> usize {
    let cfg = config();
    d.current.values().filter(|a| a.status == "firing" && !a.acked && !a.silenced && !is_muted(&cfg, a)).count()
}

/// Applies alerts; returns the ones that are news (newly firing or just resolved).
fn apply(app: &AppHandle, incoming: Vec<Alert>) {
    let state = app.state::<AlertsState>();
    let mut news: Vec<Alert> = Vec::new();
    let count = {
        let mut d = state.data.lock().unwrap();
        for mut a in incoming {
            let prev = d.current.get(&a.fingerprint);
            let changed = prev.is_none_or(|p| p.status != a.status);
            if let Some(p) = prev {
                // ack sticks while the same incident keeps firing
                a.acked = p.acked && p.status == a.status && p.starts_at == a.starts_at;
            }
            if changed {
                d.history.push_front(a.clone());
                news.push(a.clone());
            }
            if a.status == "resolved" {
                d.current.remove(&a.fingerprint);
            } else {
                d.current.insert(a.fingerprint.clone(), a);
            }
        }
        d.history.truncate(HISTORY_CAP);
        persist(&d);
        firing_count(&d)
    };
    let _ = app.emit("alerts-changed", count);
    notify(app, &news);
}

fn notify(app: &AppHandle, news: &[Alert]) {
    let cfg = config();
    if !cfg.notify {
        return;
    }
    let shown: Vec<&Alert> = news
        .iter()
        .filter(|a| !a.silenced && !is_muted(&cfg, a) && (a.status == "firing" || cfg.notify_resolved))
        .collect();
    // one notification per alert up to 3, then a summary
    for a in shown.iter().take(3) {
        let icon = if a.status == "resolved" { "✅" } else if a.kind == "ai" { "🤖" } else if a.severity.contains("crit") { "🔴" } else { "🟠" };
        let body = [a.summary.as_str(), a.description.as_str(), a.value.as_str()]
            .into_iter()
            .find(|x| !x.is_empty())
            .unwrap_or(&a.source)
            .chars()
            .take(240)
            .collect::<String>();
        let _ = app.notification().builder().title(format!("{icon} {}", a.name)).body(body).show();
    }
    if shown.len() > 3 {
        let more = (shown.len() - 3).to_string();
        let _ = app
            .notification()
            .builder()
            .title(crate::i18n::tr("🔔 Ещё {} алертов", &[&more]))
            .body(crate::i18n::tr("Откройте раздел алертов в OpsDeck", &[]))
            .show();
    }
}

// ---------- pull: Grafana Alertmanager API ----------

/// URL to poll for a connector, if it is an alert source.
fn poll_url(c: &connectors::Connector) -> Option<String> {
    let base = c.url.trim_end_matches('/');
    match c.kind.as_str() {
        "grafana" => Some(format!("{base}/api/alertmanager/grafana/api/v2/alerts?active=true&silenced=true&inhibited=true")),
        "alertmanager" => Some(format!("{base}/api/v2/alerts?active=true&silenced=true&inhibited=true")),
        "zabbix" => Some(zabbix_api(base)),
        // AI feed: the URL is the feed itself
        "ai" if !base.is_empty() => Some(c.url.clone()),
        _ => None,
    }
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().timeout(Duration::from_secs(15)).build().map_err(|e| e.to_string())
}

// ---------- pull: Zabbix (JSON-RPC API, Zabbix 6.0+) ----------

fn zabbix_api(base: &str) -> String {
    if base.ends_with("api_jsonrpc.php") { base.to_string() } else { format!("{base}/api_jsonrpc.php") }
}

/// Zabbix severity 0..5 → a name the alert view sorts by (disaster/high are critical).
fn zabbix_severity(s: &str) -> &'static str {
    match s {
        "5" => "disaster",
        "4" => "high",
        "3" => "average",
        "2" => "warning",
        "1" => "information",
        _ => "not classified",
    }
}

/// Current problems (problem.get) + their hosts (event.get) → alerts.
fn parse_zabbix(problems: &Value, events: &Value, base: &str, source: &str) -> Vec<Alert> {
    let base = base.trim_end_matches('/').trim_end_matches("/api_jsonrpc.php");
    let hosts: std::collections::HashMap<String, Vec<String>> = events
        .as_array()
        .into_iter()
        .flatten()
        .map(|e| (s(&e["eventid"]), e["hosts"].as_array().into_iter().flatten().map(|h| s(if h["name"].is_string() { &h["name"] } else { &h["host"] })).collect()))
        .collect();
    problems
        .as_array()
        .into_iter()
        .flatten()
        .map(|p| {
            let eventid = s(&p["eventid"]);
            let host = hosts.get(&eventid).map(|h| h.join(", ")).unwrap_or_default();
            let mut labels: BTreeMap<String, String> = p["tags"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|t| (s(&t["tag"]), s(&t["value"])))
                .filter(|(k, _)| !k.is_empty())
                .collect();
            if !host.is_empty() {
                labels.insert("host".into(), host.clone());
            }
            let started = s(&p["clock"]).parse::<i64>().ok().and_then(|t| chrono::DateTime::from_timestamp(t, 0)).map(|t| t.to_rfc3339()).unwrap_or_else(now);
            Alert {
                kind: "alert".into(),
                fingerprint: format!("zabbix-{}", fnv(&format!("{source}|{eventid}"))),
                status: "firing".into(),
                silenced: s(&p["suppressed"]) == "1",
                source: source.into(),
                name: s(&p["name"]),
                severity: zabbix_severity(&s(&p["severity"])).into(),
                summary: host,
                starts_at: started,
                received_at: now(),
                generator_url: format!("{base}/tr_events.php?triggerid={}&eventid={eventid}", s(&p["objectid"])),
                dashboard_url: format!("{base}/zabbix.php?action=problem.view"),
                labels,
                ..Default::default()
            }
        })
        .collect()
}

/// Where a server takes the token: the Authorization header since 6.4, the "auth" field before.
/// Both at once no longer works — 7.2 removed the field and rejects a request that has it.
fn zabbix_token_in_header(version: &str) -> bool {
    // not a version we can read: the current way
    zabbix_version(version).is_none_or(|v| v >= (6, 4))
}

/// How the token or session goes to the API.
#[derive(Clone, Copy, PartialEq, Debug)]
enum ZabbixAuth {
    Header,
    Field,
    /// zbx_session cookie of the web sign-in
    Cookie,
}

/// With HTTP Basic auth of the web server in front of Zabbix the Authorization header is taken, so
/// the token can go only in the "auth" field — and 7.2 removed it. There the API is called with the
/// session of the web sign-in (index.php), a workaround: the API itself has no other way.
fn zabbix_auth(version: &str, basic: bool) -> ZabbixAuth {
    match (basic, zabbix_version(version)) {
        (true, Some(v)) if v >= (7, 2) => ZabbixAuth::Cookie,
        (true, _) => ZabbixAuth::Field,
        _ if zabbix_token_in_header(version) => ZabbixAuth::Header,
        _ => ZabbixAuth::Field,
    }
}

/// (major, minor) of a version string like "7.0.31".
fn zabbix_version(version: &str) -> Option<(u32, u32)> {
    let mut parts = version.split('.').map(|p| p.parse::<u32>().ok());
    Some((parts.next()??, parts.next()??))
}

/// Problems whose trigger is in `triggers` (trigger.get with monitored + skipDependent): what the
/// Problems page of Zabbix shows.
fn zabbix_shown(problems: &Value, triggers: &Value) -> Value {
    let keep: HashSet<String> = triggers
        .as_array()
        .into_iter()
        .flatten()
        .map(|t| s(&t["triggerid"]))
        .collect();
    problems
        .as_array()
        .into_iter()
        .flatten()
        .filter(|p| keep.contains(&s(&p["objectid"])))
        .cloned()
        .collect()
}

/// A Zabbix API endpoint with the HTTP Basic pair of the web server in front of it, if any.
struct ZabbixApi<'a> {
    client: &'a reqwest::Client,
    url: String,
    basic: Option<(String, String)>,
}

/// Turns a non-2xx answer into an explanation; a 401 asking for Basic means the web server wants it.
fn zabbix_http_error(r: &reqwest::Response, basic: bool) -> String {
    let basic_demanded = r
        .headers()
        .get(reqwest::header::WWW_AUTHENTICATE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.to_ascii_lowercase().starts_with("basic"));
    match (r.status().as_u16(), basic_demanded, basic) {
        (401, true, false) => "HTTP 401: веб-сервер перед Zabbix требует Basic auth — заполните логин и пароль Basic в коннекторе".to_string(),
        (401, true, true) => "HTTP 401: веб-сервер не принял логин/пароль Basic auth".to_string(),
        (code, ..) => format!("HTTP {code} — проверьте URL (нужен адрес веб-интерфейса Zabbix)"),
    }
}

async fn zabbix_call(
    api: &ZabbixApi<'_>,
    token: &str,
    auth: ZabbixAuth,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let mut body =
        serde_json::json!({ "jsonrpc": "2.0", "method": method, "params": params, "id": 1 });
    let mut req = api.client.post(&api.url);
    if let Some((user, pass)) = &api.basic {
        req = req.basic_auth(user, Some(pass));
    }
    if !token.is_empty() && method != "user.login" {
        match auth {
            ZabbixAuth::Header => req = req.bearer_auth(token),
            ZabbixAuth::Field => body["auth"] = Value::String(token.to_string()),
            ZabbixAuth::Cookie => {
                req = req.header(reqwest::header::COOKIE, format!("zbx_session={token}"))
            }
        }
    }
    let r = req.json(&body).send().await.map_err(|e| format!("нет соединения ({e}) — проверьте URL и VPN"))?;
    if !r.status().is_success() {
        return Err(zabbix_http_error(&r, api.basic.is_some()));
    }
    let v: Value = r.json().await.map_err(|e| format!("ответ не JSON ({e}) — проверьте URL"))?;
    if let Some(e) = v.get("error") {
        let msg = format!("{} {}", s(&e["message"]), s(&e["data"]));
        return Err(if msg.contains("auth") || msg.contains("session") || msg.contains("Not authorized") {
            format!("Zabbix не принял токен или пароль: {}", msg.trim())
        } else {
            format!("Zabbix: {}", msg.trim())
        });
    }
    Ok(v["result"].clone())
}

/// Sessions of user.login (or zbx_session cookies of the web sign-in) by API URL and user: signing
/// in at every poll would leave a new session on the server every minute.
static ZABBIX_SESSIONS: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(Default::default);

fn zabbix_session_key(url: &str, auth: ZabbixAuth, user: &str) -> String {
    format!("{url}\n{auth:?}\n{user}")
}

async fn zabbix_login(
    api: &ZabbixApi<'_>,
    auth: ZabbixAuth,
    user: &str,
    pass: &str,
) -> Result<String, String> {
    let session = if auth == ZabbixAuth::Cookie {
        zabbix_web_login(api, user, pass).await?
    } else {
        let r = zabbix_call(
            api,
            "",
            auth,
            "user.login",
            serde_json::json!({ "username": user, "password": pass }),
        )
        .await?;
        r.as_str()
            .ok_or("Zabbix не вернул сессию после входа")?
            .to_string()
    };
    ZABBIX_SESSIONS
        .lock()
        .unwrap()
        .insert(zabbix_session_key(&api.url, auth, user), session.clone());
    Ok(session)
}

/// The sign-in form of the web UI (index.php) through the Basic auth of the web server; returns the
/// zbx_session cookie, which the API accepts like a token.
async fn zabbix_web_login(api: &ZabbixApi<'_>, user: &str, pass: &str) -> Result<String, String> {
    // the session cookie comes with the 302 of a successful sign-in, so no redirects here
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let form = [
        ("name", user),
        ("password", pass),
        ("autologin", "1"),
        ("enter", "Sign in"),
    ];
    let mut req = client
        .post(format!(
            "{}/index.php",
            api.url.trim_end_matches("/api_jsonrpc.php")
        ))
        .form(&form);
    if let Some((u, p)) = &api.basic {
        req = req.basic_auth(u, Some(p));
    }
    let r = req
        .send()
        .await
        .map_err(|e| format!("нет соединения ({e}) — проверьте URL и VPN"))?;
    let location = r
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    match r.status().as_u16() {
        302 if location.contains("index_mfa") => {
            return Err("вход в веб-интерфейс Zabbix требует второй фактор (MFA) — для Zabbix 7.2+ за Basic auth нужен пользователь без MFA".into())
        }
        // a wrong password shows the form again (with a guest zbx_session)
        302 if !location.contains("index.php") => {}
        401 => return Err(zabbix_http_error(&r, true)),
        _ => return Err("вход в веб-интерфейс Zabbix не удался — проверьте логин и пароль Zabbix".into()),
    }
    r.headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .find_map(|v| v.strip_prefix("zbx_session="))
        .and_then(|v| v.split(';').next())
        .map(str::to_string)
        .ok_or_else(|| "вход в веб-интерфейс Zabbix: сервер не выдал cookie zbx_session".into())
}

async fn fetch_zabbix(
    client: &reqwest::Client,
    c: &connectors::Connector,
    user: &str,
    pass: &str,
) -> Result<Vec<Alert>, String> {
    let api = ZabbixApi {
        client,
        url: zabbix_api(c.url.trim_end_matches('/')),
        basic: connectors::basic_credentials(c)?,
    };
    zabbix_problems(&api, c, user, pass).await
}

async fn zabbix_problems(
    api: &ZabbixApi<'_>,
    c: &connectors::Connector,
    user: &str,
    pass: &str,
) -> Result<Vec<Alert>, String> {
    if pass.is_empty() {
        return Err("не задан API-токен или пароль Zabbix".into());
    }
    // apiinfo.version needs no auth
    let version = zabbix_call(
        api,
        "",
        ZabbixAuth::Field,
        "apiinfo.version",
        serde_json::json!([]),
    )
    .await?;
    let auth = zabbix_auth(&s(&version), api.basic.is_some());
    if auth == ZabbixAuth::Cookie && c.auth == "token" {
        return Err(format!(
            "Zabbix {}: за Basic auth токен можно передать только в поле auth, а в 7.2+ его нет. Варианты: снять Basic с /api_jsonrpc.php на веб-сервере и закрыть его по IP (VPN), или авторизация «логин/пароль» — тогда OpsDeck войдёт в веб-интерфейс Zabbix и пойдёт в API с этой сессией (обходной путь)",
            s(&version)
        ));
    }
    let kept = if c.auth == "token" {
        None
    } else {
        ZABBIX_SESSIONS
            .lock()
            .unwrap()
            .get(&zabbix_session_key(&api.url, auth, user))
            .cloned()
    };
    let mut token = match (c.auth == "token", &kept) {
        (true, _) => pass.to_string(),
        (false, Some(session)) => session.clone(),
        (false, None) => zabbix_login(api, auth, user, pass).await?,
    };
    let mut query = serde_json::json!({
        "output": ["eventid", "objectid", "name", "severity", "clock", "suppressed"],
        "selectTags": "extend", "recent": false, "sortfield": ["eventid"], "sortorder": "DESC", "limit": 1000
    });
    // the Problems page hides symptoms (problems attached to a cause problem; 7.0+)
    if zabbix_version(&s(&version)).is_some_and(|v| v >= (7, 0)) {
        query["symptom"] = Value::Bool(false);
    }
    let problems = match zabbix_call(api, &token, auth, "problem.get", query.clone()).await {
        // a kept session ends with auto-logout or a server restart ("Session terminated,
        // re-login, please."): sign in again, once
        Err(e)
            if kept.is_some() && (e.contains("re-login") || e.starts_with("Zabbix не принял")) =>
        {
            token = zabbix_login(api, auth, user, pass).await?;
            zabbix_call(api, &token, auth, "problem.get", query).await?
        }
        r => r?,
    };
    // the Problems page also drops problems of disabled triggers, hosts and items (they stay open in
    // the database, sometimes for years) and of triggers that depend on another one in a problem state
    let mut triggerids: Vec<String> = problems
        .as_array()
        .into_iter()
        .flatten()
        .map(|p| s(&p["objectid"]))
        .collect();
    triggerids.sort();
    triggerids.dedup();
    let problems = if triggerids.is_empty() {
        problems
    } else {
        let triggers = zabbix_call(
            api,
            &token,
            auth,
            "trigger.get",
            serde_json::json!({ "output": ["triggerid"], "triggerids": triggerids, "monitored": true, "skipDependent": true }),
        )
        .await?;
        zabbix_shown(&problems, &triggers)
    };
    let ids: Vec<String> = problems.as_array().into_iter().flatten().map(|p| s(&p["eventid"])).collect();
    let events = if ids.is_empty() {
        Value::Array(Vec::new())
    } else {
        zabbix_call(api, &token, auth, "event.get", serde_json::json!({ "eventids": ids, "output": ["eventid"], "selectHosts": ["host", "name"] })).await?
    };
    Ok(parse_zabbix(&problems, &events, &c.url, &c.name))
}

/// Current alerts of one source, with a human explanation on failure.
async fn fetch_source(
    client: &reqwest::Client,
    kp: &KeepassState,
    pb: &PassboltState,
    c: &connectors::Connector,
    used: keepass::Use,
) -> Result<Vec<Alert>, String> {
    let url = poll_url(c).ok_or("этот тип коннектора не является источником алертов")?;
    let (user, pass) = connectors::credentials(kp, pb, c, used).await?;
    if c.kind == "zabbix" {
        return fetch_zabbix(client, c, &user, &pass).await;
    }
    if c.kind == "grafana" && pass.is_empty() {
        return Err("не задан пароль или токен — Grafana не отдаёт алерты без авторизации".into());
    }
    let req = client.get(&url);
    let req = match c.auth.as_str() {
        "none" => req,
        "token" => req.bearer_auth(&pass),
        _ => req.basic_auth(&user, Some(&pass)),
    };
    let r = req.send().await.map_err(|e| format!("нет соединения ({e}) — проверьте URL и VPN"))?;
    let status = r.status();
    if !status.is_success() {
        return Err(match status.as_u16() {
            401 => "HTTP 401: неверный логин/пароль или токен".to_string(),
            403 => "HTTP 403: у пользователя/токена нет прав на чтение алертов (нужна роль Viewer или выше)".to_string(),
            404 if c.kind == "grafana" => "HTTP 404: в Grafana не включён Grafana Alerting или это не Grafana (если алерты в Prometheus Alertmanager — добавьте коннектор Alertmanager)".to_string(),
            code => format!("HTTP {code}"),
        });
    }
    let body: Value = r.json().await.map_err(|e| format!("ответ не JSON ({e}) — проверьте URL"))?;
    Ok(items_of(&body).into_iter().filter_map(|v| parse_item(v, &c.name)).collect())
}

/// Applies a fresh snapshot of one source: whatever of it vanished has been resolved.
fn apply_snapshot(app: &AppHandle, source: &str, mut alerts: Vec<Alert>) {
    let seen: HashSet<String> = alerts.iter().map(|a| a.fingerprint.clone()).collect();
    {
        let d = app.state::<AlertsState>();
        let d = d.data.lock().unwrap();
        for a in d.current.values().filter(|a| a.source == source && !seen.contains(&a.fingerprint)) {
            let mut r = a.clone();
            r.status = "resolved".into();
            r.ends_at = now();
            r.received_at = now();
            alerts.push(r);
        }
    }
    apply(app, alerts);
}

async fn poll_once(app: &AppHandle) -> Vec<String> {
    let kp = app.state::<KeepassState>();
    let pb = app.state::<PassboltState>();
    let client = match http_client() {
        Ok(c) => c,
        Err(e) => return vec![e],
    };
    let mut errors = Vec::new();
    let all = connectors::all().unwrap_or_default();
    // alerts of deleted connectors: nobody will ever resolve them — move them to history
    let orphans: Vec<Alert> = {
        let names: HashSet<&str> = all.iter().map(|c| c.name.as_str()).collect();
        let d = app.state::<AlertsState>();
        let d = d.data.lock().unwrap();
        d.current.values().filter(|a| !names.contains(a.source.as_str())).cloned().collect()
    };
    if !orphans.is_empty() {
        apply(app, orphans.into_iter().map(|mut a| { a.status = "resolved".into(); a.ends_at = now(); a.received_at = now(); a }).collect());
    }
    for c in all {
        if poll_url(&c).is_none() {
            continue;
        }
        // a Grafana connector without credentials is just a web panel, not an alert source
        if c.kind == "grafana" && c.auth == "none" {
            continue;
        }
        match fetch_source(&client, &kp, &pb, &c, keepass::Use::Background).await {
            Ok(alerts) => apply_snapshot(app, &c.name, alerts),
            Err(e) => errors.push(format!("{}: {e}", c.name)),
        }
    }
    errors
}

/// "Save and check" in the connector dialog: fetch one source now.
#[tauri::command]
pub async fn alerts_test_source(
    app: AppHandle,
    kp: State<'_, KeepassState>,
    pb: State<'_, PassboltState>,
    id: String,
) -> Result<usize, String> {
    let c = connectors::all()?.into_iter().find(|c| c.id == id).ok_or("коннектор не найден")?;
    let alerts = fetch_source(&http_client()?, &kp, &pb, &c, keepass::Use::User).await?;
    let n = alerts.len();
    apply_snapshot(&app, &c.name, alerts);
    Ok(n)
}

/// Whether any alert source is configured (for the empty state of the alerts view).
#[tauri::command]
pub fn alerts_sources() -> Vec<String> {
    connectors::all()
        .unwrap_or_default()
        .into_iter()
        .filter(|c| poll_url(c).is_some() && !(c.kind == "grafana" && c.auth == "none") || (c.kind == "ai"))
        .map(|c| c.name)
        .collect()
}

// ---------- push from local analyzers (127.0.0.1 only) ----------

/// POST /api/v1/findings or /api/v1/alerts with `Authorization: Bearer <AI connector token>`.
async fn ingest(
    axum::extract::State(app): axum::extract::State<AppHandle>,
    headers: axum::http::HeaderMap,
    body: axum::body::Bytes,
) -> (axum::http::StatusCode, String) {
    use axum::http::StatusCode;
    // DNS rebinding guard: a web page whose domain resolves to 127.0.0.1 would send its own Host
    let host = headers.get("host").and_then(|v| v.to_str().ok()).unwrap_or_default();
    let host = host.rsplit_once(':').map_or(host, |(h, _)| h);
    if !matches!(host, "127.0.0.1" | "localhost" | "[::1]") {
        return (StatusCode::FORBIDDEN, "only local clients\n".into());
    }
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer ").or(v.strip_prefix("bearer ")))
        .unwrap_or_default();
    let source = connectors::all()
        .unwrap_or_default()
        .into_iter()
        .find(|c| c.kind == "ai" && c.ingest_token.len() >= 16 && store::ct_eq(&c.ingest_token, token));
    let Some(source) = source else {
        return (StatusCode::UNAUTHORIZED, "unknown token: create an «AI / анализатор» connector in OpsDeck and use its token\n".into());
    };
    let v: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return (StatusCode::BAD_REQUEST, format!("invalid JSON: {e}\n")),
    };
    let alerts: Vec<Alert> = items_of(&v).into_iter().filter_map(|x| parse_item(x, &source.name)).collect();
    if alerts.is_empty() {
        return (StatusCode::BAD_REQUEST, "nothing to import: a finding needs \"title\", an alert needs \"labels\"\n".into());
    }
    let n = alerts.len();
    apply(&app, alerts);
    (StatusCode::OK, format!("accepted {n}\n"))
}

async fn run_ingest(app: AppHandle, port: u16, stop: oneshot::Receiver<()>) -> Result<(), String> {
    use axum::{routing::{get, post}, Router};
    let router = Router::new()
        .route("/api/v1/health", get(|| async { "ok\n" }))
        .route("/api/v1/findings", post(ingest))
        .route("/api/v1/alerts", post(ingest))
        .layer(axum::extract::DefaultBodyLimit::max(2 * 1024 * 1024))
        .with_state(app);
    // loopback only: nothing from the network can reach it
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|e| format!("порт приёма 127.0.0.1:{port} занят: {e}"))?;
    tauri::async_runtime::spawn(async move {
        let _ = axum::serve(listener, router).with_graceful_shutdown(async { let _ = stop.await; }).await;
    });
    Ok(())
}

fn start_poll(app: AppHandle, secs: u64, stop: oneshot::Receiver<()>) {
    tauri::async_runtime::spawn(async move {
        let mut stop = stop;
        let mut tick = tokio::time::interval(Duration::from_secs(secs.max(15)));
        loop {
            tokio::select! {
                _ = &mut stop => break,
                _ = tick.tick() => {
                    let errors = poll_once(&app).await;
                    let _ = app.emit("alerts-poll", errors);
                }
            }
        }
    });
}

/// (Re)starts the poller and the loopback ingest endpoint according to the saved config.
pub async fn restart(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AlertsState>();
    let had_ingest = if let Some(tx) = state.ingest_stop.lock().unwrap().take() {
        let _ = tx.send(());
        true
    } else {
        false
    };
    if let Some(tx) = state.poll_stop.lock().unwrap().take() {
        let _ = tx.send(());
    }
    let cfg = config();
    if cfg.poll_enabled {
        let (tx, rx) = oneshot::channel();
        *state.poll_stop.lock().unwrap() = Some(tx);
        start_poll(app.clone(), cfg.poll_seconds, rx);
    }
    if cfg.ingest_enabled {
        if had_ingest {
            tokio::time::sleep(Duration::from_millis(200)).await; // let the old listener release the port
        }
        let (tx, rx) = oneshot::channel();
        *state.ingest_stop.lock().unwrap() = Some(tx);
        run_ingest(app.clone(), cfg.ingest_port, rx).await?;
    }
    Ok(())
}

// ---------- commands ----------

#[derive(Serialize)]
pub struct AlertsView {
    current: Vec<Alert>,
    history: Vec<Alert>,
    firing: usize,
}

#[tauri::command]
pub fn alerts_get(state: State<AlertsState>, history_limit: Option<usize>) -> AlertsView {
    let d = state.data.lock().unwrap();
    let mut current: Vec<Alert> = d.current.values().cloned().collect();
    current.sort_by(|a, b| b.starts_at.cmp(&a.starts_at));
    AlertsView { firing: firing_count(&d), current, history: d.history.iter().take(history_limit.unwrap_or(300)).cloned().collect() }
}

#[tauri::command]
pub fn alerts_ack(app: AppHandle, state: State<AlertsState>, fingerprint: String, acked: bool) {
    let count = {
        let mut d = state.data.lock().unwrap();
        if let Some(a) = d.current.get_mut(&fingerprint) {
            a.acked = acked;
        }
        persist(&d);
        firing_count(&d)
    };
    let _ = app.emit("alerts-changed", count);
}

/// Forget current alerts (e.g. stale ones from a source that stopped sending) and/or history.
#[tauri::command]
pub fn alerts_clear(app: AppHandle, state: State<AlertsState>, current: bool, history: bool) {
    let count = {
        let mut d = state.data.lock().unwrap();
        if current {
            d.current.clear();
        }
        if history {
            d.history.clear();
        }
        persist(&d);
        firing_count(&d)
    };
    let _ = app.emit("alerts-changed", count);
}

#[tauri::command]
pub fn alerts_config_get() -> AlertsConfig {
    config()
}

#[tauri::command]
pub async fn alerts_config_set(app: AppHandle, config: AlertsConfig) -> Result<(), String> {
    store::save_json(CONFIG_FILE, &config)?;
    restart(&app).await
}

/// Hide (or show again) alerts with this name from this source.
#[tauri::command]
pub fn alerts_mute(app: AppHandle, state: State<AlertsState>, source: String, name: String, muted: bool) -> Result<(), String> {
    let mut cfg = config();
    let rule = Mute { source, name };
    cfg.muted.retain(|m| *m != rule);
    if muted {
        cfg.muted.push(rule);
    }
    store::save_json(CONFIG_FILE, &cfg)?;
    let count = firing_count(&state.data.lock().unwrap());
    let _ = app.emit("alerts-changed", count);
    Ok(())
}

/// Close an item by hand (AI findings have no natural end): it goes to history as resolved.
#[tauri::command]
pub fn alerts_resolve(app: AppHandle, fingerprint: String) {
    let state = app.state::<AlertsState>();
    let item = state.data.lock().unwrap().current.get(&fingerprint).cloned();
    if let Some(mut a) = item {
        a.status = "resolved".into();
        a.ends_at = now();
        a.received_at = now();
        apply(&app, vec![a]);
    }
}

/// Poll right now (button in the UI); returns per-connector errors.
#[tauri::command]
pub async fn alerts_poll_now(app: AppHandle) -> Vec<String> {
    poll_once(&app).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn alertmanager_v2_alert() {
        let a = parse_alert(
            &json!({
                "labels": { "alertname": "PodCrashLooping", "severity": "critical", "namespace": "shop" },
                "annotations": { "summary": "worker restarts", "message": "OOM" },
                "status": { "state": "suppressed" },
                "fingerprint": "abc123",
                "startsAt": "2026-10-06T09:00:00Z",
                "endsAt": "0001-01-01T00:00:00Z",
                "generatorURL": "https://grafana.example.com/alerting"
            }),
            "Alertmanager",
        );
        assert_eq!(a.name, "PodCrashLooping");
        assert_eq!(a.severity, "critical");
        assert_eq!(a.status, "firing");
        assert!(a.silenced, "suppressed in API v2 = silenced");
        assert_eq!(a.fingerprint, "abc123");
        assert_eq!(a.summary, "worker restarts");
        assert_eq!(a.description, "OOM", "message is used when there is no description");
        assert_eq!(a.ends_at, "", "the zero date means 'not ended'");
        assert_eq!(a.labels["namespace"], "shop");
        assert_eq!(a.source, "Alertmanager");
    }

    #[test]
    fn webhook_alert_without_fingerprint_gets_stable_one() {
        let v = json!({ "labels": { "alertname": "X", "priority": "P2" }, "status": "resolved", "startsAt": "t" });
        let a = parse_alert(&v, "Grafana");
        let b = parse_alert(&v, "Grafana");
        assert_eq!(a.status, "resolved");
        assert_eq!(a.severity, "P2", "priority is the fallback severity");
        assert!(!a.fingerprint.is_empty());
        assert_eq!(a.fingerprint, b.fingerprint, "same labels → same fingerprint");
        let c = parse_alert(&json!({ "labels": { "alertname": "Y" }, "startsAt": "t" }), "Grafana");
        assert_ne!(a.fingerprint, c.fingerprint);
    }

    #[test]
    fn ai_finding() {
        let f = parse_finding(
            &json!({
                "title": "Burst of 401",
                "severity": "warning",
                "summary": "312 responses",
                "details": "long text",
                "status": "closed",
                "labels": { "app": "api" },
                "links": [{ "title": "Grafana", "url": "https://grafana.example.com/d/1" }, { "title": "bad", "url": "javascript:alert(1)" }]
            }),
            "log-analyzer",
        )
        .unwrap();
        assert_eq!(f.kind, "ai");
        assert_eq!(f.status, "resolved");
        assert_eq!(f.links.len(), 1, "only http(s) links are kept");
        assert_eq!(f.description, "long text");
        assert!(parse_finding(&json!({ "summary": "no title" }), "x").is_none());
    }

    #[test]
    fn finding_fingerprint_by_id_or_content() {
        let by_id = |t: &str| parse_finding(&json!({ "id": "stable-1", "title": t }), "a").unwrap().fingerprint;
        assert_eq!(by_id("first wording"), by_id("second wording"), "same id updates the same finding");
        let by_content = |src: &str| parse_finding(&json!({ "title": "T", "labels": { "a": "1" } }), src).unwrap().fingerprint;
        assert_ne!(by_content("a"), by_content("b"), "different sources never collide");
    }

    #[test]
    fn finding_is_bounded() {
        let long = "x".repeat(5000);
        let f = parse_finding(&json!({ "title": long, "summary": long, "links": (0..20).map(|i| json!({ "url": format!("https://e.com/{i}") })).collect::<Vec<_>>() }), "a").unwrap();
        assert_eq!(f.name.chars().count(), 200);
        assert_eq!(f.summary.chars().count(), 1000);
        assert_eq!(f.links.len(), 8);
    }

    #[test]
    fn item_kind_detection() {
        assert_eq!(parse_item(&json!({ "labels": { "alertname": "A" }, "startsAt": "t" }), "s").unwrap().kind, "alert");
        assert_eq!(parse_item(&json!({ "title": "F" }), "s").unwrap().kind, "ai");
        assert!(parse_item(&json!({ "foo": 1 }), "s").is_none());
    }

    #[test]
    fn body_shapes() {
        assert_eq!(items_of(&json!([1, 2, 3])).len(), 3);
        assert_eq!(items_of(&json!({ "alerts": [1, 2] })).len(), 2);
        assert_eq!(items_of(&json!({ "findings": [1] })).len(), 1);
        assert_eq!(items_of(&json!({ "items": [1, 2, 3, 4] })).len(), 4);
        assert_eq!(items_of(&json!({ "title": "one" })).len(), 1);
        assert!(items_of(&json!("text")).is_empty());
    }

    #[test]
    fn zabbix_problems() {
        let problems = json!([
            { "eventid": "101", "objectid": "9001", "name": "High CPU on web-1", "severity": "4", "clock": "1791300000", "suppressed": "0",
              "tags": [{ "tag": "service", "value": "shop" }, { "tag": "", "value": "x" }] },
            { "eventid": "102", "objectid": "9002", "name": "Disk is full", "severity": "5", "clock": "bad", "suppressed": "1", "tags": [] },
        ]);
        let events = json!([{ "eventid": "101", "hosts": [{ "host": "web-1", "name": "Web 1" }] }]);
        let a = parse_zabbix(&problems, &events, "https://zabbix.example.com/", "Zabbix");
        assert_eq!(a.len(), 2);
        assert_eq!((a[0].name.as_str(), a[0].severity.as_str(), a[0].summary.as_str()), ("High CPU on web-1", "high", "Web 1"));
        assert_eq!(a[0].labels["host"], "Web 1");
        assert_eq!(a[0].labels["service"], "shop");
        assert!(!a[0].labels.contains_key(""), "empty tags are dropped");
        assert_eq!(a[0].starts_at, "2026-10-06T15:20:00+00:00");
        assert_eq!(a[0].generator_url, "https://zabbix.example.com/tr_events.php?triggerid=9001&eventid=101");
        assert_eq!(a[1].severity, "disaster");
        assert!(a[1].silenced, "suppressed in Zabbix = silenced");
        assert_ne!(a[0].fingerprint, a[1].fingerprint);
        assert_eq!(a[0].fingerprint, parse_zabbix(&problems, &events, "https://zabbix.example.com", "Zabbix")[0].fingerprint, "stable per event");
        assert_eq!(zabbix_api("https://z.example.com"), "https://z.example.com/api_jsonrpc.php");
        assert_eq!(zabbix_api("https://z.example.com/api_jsonrpc.php"), "https://z.example.com/api_jsonrpc.php");
    }

    #[test]
    fn zabbix_token_place() {
        for v in ["6.0.48", "6.2.9"] {
            assert!(!zabbix_token_in_header(v), "{v}: the auth field");
        }
        for v in ["6.4.21", "7.0.31", "7.4.15", "8.0.0"] {
            assert!(
                zabbix_token_in_header(v),
                "{v}: the header (7.2+ rejects the field)"
            );
        }
        assert!(zabbix_token_in_header(""));
    }

    #[test]
    fn zabbix_auth_behind_basic() {
        // HTTP Basic of the web server takes the Authorization header
        for v in ["6.0.48", "6.4.21", "7.0.31"] {
            assert_eq!(zabbix_auth(v, true), ZabbixAuth::Field, "{v}");
        }
        for v in ["7.2.0", "7.4.15", "8.0.0"] {
            assert_eq!(
                zabbix_auth(v, true),
                ZabbixAuth::Cookie,
                "{v}: no auth field, the web sign-in session"
            );
        }
        assert_eq!(zabbix_auth("7.4.15", false), ZabbixAuth::Header);
        assert_eq!(zabbix_auth("6.0.48", false), ZabbixAuth::Field);
    }

    #[test]
    fn zabbix_problems_page() {
        assert_eq!(zabbix_version("7.0.31"), Some((7, 0)));
        assert_eq!(zabbix_version("8.0.0rc2"), Some((8, 0)));
        assert_eq!(zabbix_version("x"), None);
        let problems = json!([
            { "eventid": "1", "objectid": "10" },
            { "eventid": "2", "objectid": "20" },
            { "eventid": "3", "objectid": "10" },
        ]);
        // trigger 20 is disabled or depends on a trigger in a problem state
        let shown = zabbix_shown(&problems, &json!([{ "triggerid": "10" }]));
        let ids: Vec<&str> = shown
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["eventid"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["1", "3"]);
    }

    #[test]
    fn muting() {
        let cfg = AlertsConfig { muted: vec![Mute { source: "Grafana".into(), name: "Noise".into() }, Mute { source: String::new(), name: "Everywhere".into() }], ..Default::default() };
        let a = |src: &str, name: &str| Alert { source: src.into(), name: name.into(), ..Default::default() };
        assert!(is_muted(&cfg, &a("Grafana", "Noise")));
        assert!(!is_muted(&cfg, &a("Alertmanager", "Noise")), "a mute is per source");
        assert!(is_muted(&cfg, &a("Alertmanager", "Everywhere")), "empty source mutes in every source");
        assert!(!is_muted(&cfg, &a("Grafana", "Other")));
    }
}
