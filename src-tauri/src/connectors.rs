//! Web connectors (Grafana, ArgoCD, GitLab, generic URL).
//! Metadata lives in ~/.config/opsdeck/connectors.json, secrets in the OS keyring.
//! Opening a connector creates a separate webview window with an init script that logs in
//! on the configured origin only; the window has no IPC access to the app.

use crate::{
    keepass::{self, KeepassState},
    store,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, Url, WebviewUrl, WebviewWindowBuilder};

const FILE: &str = "connectors.json";

#[derive(Serialize, Deserialize, Clone)]
pub struct Connector {
    pub id: String,
    /// grafana | argocd | gitlab | alertmanager | ai | generic
    pub kind: String,
    pub name: String,
    /// row on the web panels page (like a Grafana dashboard row); empty = ungrouped
    #[serde(default)]
    pub group: String,
    pub url: String,
    #[serde(default)]
    pub username: String,
    /// password | token | keepass | none
    #[serde(default = "default_auth")]
    pub auth: String,
    /// KeePass entry uuid when auth == "keepass"
    #[serde(default)]
    pub keepass_entry: String,
    /// kind "ai": token the analyzer uses to push findings to OpsDeck's local ingest endpoint
    #[serde(default)]
    pub ingest_token: String,
}

fn new_token() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn default_auth() -> String {
    "password".into()
}

fn secret_key(id: &str) -> String {
    format!("connector:{id}")
}

fn load() -> Result<Vec<Connector>, String> {
    store::load_json(FILE)
}

#[tauri::command]
pub fn connectors_list() -> Result<Vec<Connector>, String> {
    let mut list = load()?;
    // older configs could keep a pasted token in the login field (plain text on disk):
    // token auth never uses the login, so drop it — the token itself is in the keyring
    if list.iter().any(|c| c.auth == "token" && !c.username.is_empty()) {
        for c in list.iter_mut().filter(|c| c.auth == "token") {
            c.username.clear();
        }
        store::save_json(FILE, &list)?;
    }
    Ok(list)
}

/// `secret`: Some(non-empty) replaces the stored secret, None/empty keeps the existing one.
#[tauri::command]
pub fn connector_save(mut connector: Connector, secret: Option<String>) -> Result<(), String> {
    if !store::valid_id(&connector.id) {
        return Err("invalid id".into());
    }
    // an AI analyzer may only push (no feed URL to poll)
    if !(connector.kind == "ai" && connector.url.trim().is_empty()) {
        let url = Url::parse(&connector.url).map_err(|e| format!("bad URL: {e}"))?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err("URL must be http(s)".into());
        }
    }
    if connector.auth == "token" {
        connector.username.clear(); // the login is unused with a token; never keep secrets here
    }
    if connector.kind == "ai" && connector.ingest_token.len() < 16 {
        connector.ingest_token = load()?
            .into_iter()
            .find(|c| c.id == connector.id && c.ingest_token.len() >= 16)
            .map(|c| c.ingest_token)
            .unwrap_or_else(new_token);
    }
    if connector.auth == "keepass" && connector.keepass_entry.is_empty() {
        return Err("выберите запись KeePass".into());
    }
    if let Some(s) = secret.filter(|s| !s.is_empty()) {
        store::secret_set(&secret_key(&connector.id), &s)?;
    }
    let mut list = load()?;
    match list.iter_mut().find(|c| c.id == connector.id) {
        Some(c) => *c = connector,
        None => list.push(connector),
    }
    store::save_json(FILE, &list)
}

/// New push token for an AI connector (the old one stops working immediately).
#[tauri::command]
pub fn connector_regen_token(id: String) -> Result<String, String> {
    let mut list = load()?;
    let c = list.iter_mut().find(|c| c.id == id && c.kind == "ai").ok_or("AI-коннектор не найден")?;
    c.ingest_token = new_token();
    let token = c.ingest_token.clone();
    store::save_json(FILE, &list)?;
    Ok(token)
}

#[tauri::command]
pub fn connector_delete(id: String) -> Result<(), String> {
    let mut list = load()?;
    list.retain(|c| c.id != id);
    store::secret_delete(&secret_key(&id));
    store::save_json(FILE, &list)
}

/// All connectors (for other modules, e.g. alert polling).
pub fn all() -> Result<Vec<Connector>, String> {
    load()
}

/// (username, password-or-token) of a connector; empty when it has no credentials.
pub fn credentials(kp: &KeepassState, c: &Connector) -> Result<(String, String), String> {
    Ok(match c.auth.as_str() {
        "none" => (c.username.clone(), String::new()),
        "keepass" => {
            let (user, pass) = keepass::credentials(kp, &c.keepass_entry)?;
            (if c.username.is_empty() { user } else { c.username.clone() }, pass)
        }
        _ => (c.username.clone(), store::secret_get(&secret_key(&c.id)).unwrap_or_default()),
    })
}

/// Connector, its start URL and (if credentials are configured) the auto-login init script.
pub fn prepare(kp: &KeepassState, id: &str) -> Result<(Connector, Url, Option<String>), String> {
    let mut c = load()?.into_iter().find(|c| c.id == id).ok_or("connector not found")?;
    let url = Url::parse(&c.url).map_err(|e| e.to_string())?;
    let secret = match c.auth.as_str() {
        "none" => String::new(),
        "keepass" => {
            let (user, pass) = keepass::credentials(&kp, &c.keepass_entry)?;
            if c.username.is_empty() {
                c.username = user;
            }
            c.auth = "password".into(); // same login flow as a stored password
            pass
        }
        _ => store::secret_get(&secret_key(&c.id)).unwrap_or_default(),
    };
    let script = (!secret.is_empty()).then(|| login_script(&c, &url, &secret));
    Ok((c, url, script))
}

/// Opens the connector in its own window. Async: on Windows, building a window from a synchronous
/// command deadlocks (WebviewWindowBuilder::build docs) — a blank window that cannot be closed.
#[tauri::command]
pub async fn connector_open(app: AppHandle, kp: State<'_, KeepassState>, id: String) -> Result<(), String> {
    let label = format!("conn-{id}");
    if let Some(w) = app.get_webview_window(&label) {
        return w.set_focus().map_err(|e| e.to_string());
    }
    let (c, url, script) = prepare(&kp, &id)?;
    let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(url))
        .title(format!("{} — OpsDeck", c.name))
        .inner_size(1360.0, 860.0)
        .zoom_hotkeys_enabled(true); // Ctrl +/−/0 inside the window
    if let Some(js) = script {
        builder = builder.initialization_script(&js);
    }
    builder.build().map_err(|e| e.to_string())?;
    Ok(())
}

/// JS that runs before page scripts on every navigation in the connector window.
/// Values are embedded as JSON literals and kept inside a closure (not on window).
fn login_script(c: &Connector, url: &Url, secret: &str) -> String {
    let origin = url.origin().ascii_serialization();
    let base = c.url.trim_end_matches('/');
    let cfg = serde_json::json!({
        "kind": c.kind, "auth": c.auth, "origin": origin, "base": base,
        "user": c.username, "secret": secret,
    });
    format!("(function(cfg){{\n{}\n}})({});", LOGIN_JS, cfg)
}

const LOGIN_JS: &str = r#"
if (location.origin !== cfg.origin) return;
// keep the browser's own fetch: page scripts loaded later can't wrap it to see the credentials
const nativeFetch = window.fetch.bind(window);
const path = location.pathname.replace(/\/+$/, '');
// retry at most once a minute so a wrong password doesn't loop
const KEY = '__opsdeck_login';
const last = Number(sessionStorage.getItem(KEY) || 0);
const mayTry = () => Date.now() - last > 60000 && (sessionStorage.setItem(KEY, String(Date.now())), true);
const post = (url, body) => nativeFetch(url, {
  method: 'POST', credentials: 'include',
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

if (cfg.kind === 'grafana') {
  if (path.endsWith('/login') && mayTry())
    post(cfg.base + '/login', { user: cfg.user, password: cfg.secret })
      .then(r => { if (r.ok) location.replace(cfg.base + '/'); });
}

if (cfg.kind === 'argocd') {
  if (cfg.auth === 'token') {
    if (!document.cookie.includes('argocd.token='))
      document.cookie = 'argocd.token=' + cfg.secret + '; path=/' + (location.protocol === 'https:' ? '; secure' : '');
    if (path.endsWith('/login')) location.replace(cfg.base + '/applications');
  } else if (path.endsWith('/login') && mayTry()) {
    post(cfg.base + '/api/v1/session', { username: cfg.user, password: cfg.secret })
      .then(r => { if (r.ok) location.replace(cfg.base + '/applications'); });
  }
}

if (cfg.kind === 'gitlab') {
  if (path.endsWith('/users/sign_in') && mayTry()) {
    const fill = () => {
      const u = document.querySelector('#user_login'), p = document.querySelector('#user_password');
      if (!u || !p) return false;
      const set = (el, v) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set(u, cfg.user); set(p, cfg.secret);
      const form = p.closest('form');
      const btn = form && form.querySelector('[type=submit]');
      btn ? btn.click() : form && form.submit();
      return true;
    };
    document.addEventListener('DOMContentLoaded', () => {
      if (!fill()) { let n = 0; const t = setInterval(() => { if (fill() || ++n > 20) clearInterval(t); }, 250); }
    });
  }
}
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_script_embeds_values_safely() {
        let c: Connector = serde_json::from_value(serde_json::json!({
            "id": "c1", "kind": "grafana", "name": "Grafana", "url": "https://grafana.example.com/", "username": "admin", "auth": "password"
        }))
        .unwrap();
        let url = Url::parse("https://grafana.example.com/login").unwrap();
        let secret = r#"p"a\ss</script><script>alert(1)"#;
        let js = login_script(&c, &url, secret);
        assert!(js.contains("if (location.origin !== cfg.origin) return;"), "only on the connector's own origin");
        assert!(js.contains(r#""origin":"https://grafana.example.com""#));
        assert!(js.contains(r#""base":"https://grafana.example.com""#), "no trailing slash in the base");
        // the secret is a JSON string literal: quotes and backslashes escaped, nothing breaks out
        assert!(js.contains(&serde_json::to_string(secret).unwrap()));
        assert!(!js.contains(r#"p"a\ss"#));
        assert!(js.ends_with(");"));
    }
}
