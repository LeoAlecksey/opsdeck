//! Web connectors (Grafana, ArgoCD, GitLab, generic URL).
//! Metadata lives in ~/.config/opsdeck/connectors.json, secrets in the OS keyring.
//! Opening a connector creates a separate webview window with an init script that logs in
//! on the configured origin only; the window has no IPC access to the app.

use crate::{
    keepass::{self, KeepassState},
    passbolt::{self, PassboltState},
    store,
};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::LazyLock, sync::Mutex};
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
    /// Passbolt resource uuid when auth == "passbolt"
    #[serde(default)]
    pub passbolt_entry: String,
    /// kind "ai": token the analyzer uses to push findings to OpsDeck's local ingest endpoint
    #[serde(default)]
    pub ingest_token: String,
    /// kind "zabbix": login of HTTP Basic auth set up on the web server in front of Zabbix; its
    /// password is a separate keyring secret
    #[serde(default)]
    pub basic_user: String,
}

fn new_token() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn default_auth() -> String {
    "password".into()
}

fn keyring_entry(id: &str) -> String {
    format!("connector:{id}")
}

fn keyring_entry_basic(id: &str) -> String {
    format!("connector:{id}:basic")
}

enum Cached {
    Found(zeroize::Zeroizing<String>),
    Missing,
    /// the keyring could not be read: asked again next time, but warned about once
    Failed,
}

// Keyring secrets of connectors for background polls: on Linux every read is a D-Bus session
// with the Secret Service, once a minute per source. KeePass and Passbolt are not cached here —
// their reads follow the lock state of the vault.
static SECRETS: LazyLock<Mutex<HashMap<String, Cached>>> = LazyLock::new(Default::default);

fn keyring_secret(key: &str, used: keepass::Use) -> Option<String> {
    keyring_secret_with(key, used, store::secret_lookup)
}

/// A user's action reads the keyring itself (and drops what the polls keep, in case the secret was
/// changed outside the app); a background read is served from memory after the first one.
fn keyring_secret_with(key: &str, used: keepass::Use, read: impl FnOnce(&str) -> Result<Option<String>, String>) -> Option<String> {
    if used == keepass::Use::User {
        let got = read(key);
        SECRETS.lock().unwrap().remove(key);
        return got.unwrap_or_else(|e| {
            log::warn!("keyring {key}: {e}");
            None
        });
    }
    // held across the read: a save that forgets the key after writing it cannot be overtaken by an older value
    let mut cache = SECRETS.lock().unwrap();
    let warned = match cache.get(key) {
        Some(Cached::Found(s)) => return Some(s.to_string()),
        Some(Cached::Missing) => return None,
        Some(Cached::Failed) => true,
        None => false,
    };
    match read(key) {
        Ok(got) => {
            cache.insert(key.to_string(), got.clone().map_or(Cached::Missing, |s| Cached::Found(s.into())));
            got
        }
        Err(e) => {
            if !warned {
                log::warn!("keyring {key}: {e}");
            }
            cache.insert(key.to_string(), Cached::Failed);
            None
        }
    }
}

/// Drops the kept secrets of a connector; after its secrets are written or deleted.
fn forget_secrets(id: &str) {
    let mut cache = SECRETS.lock().unwrap();
    cache.remove(&keyring_entry(id));
    cache.remove(&keyring_entry_basic(id));
}

/// Drops all kept secrets: the poll stopped or restarted.
pub fn forget_all_secrets() {
    SECRETS.lock().unwrap().clear();
}

/// Forgets on every return path of a save, also when it fails after writing some of the secrets.
struct ForgetOnDrop(String);

impl Drop for ForgetOnDrop {
    fn drop(&mut self) {
        forget_secrets(&self.0);
    }
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

/// `secret`, `basic_secret` (password of `basic_user`): Some(non-empty) replaces the stored one,
/// None/empty keeps it.
#[tauri::command]
pub fn connector_save(
    mut connector: Connector,
    secret: Option<String>,
    basic_secret: Option<String>,
) -> Result<(), String> {
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
    if connector.auth == "passbolt" && connector.passbolt_entry.is_empty() {
        return Err("выберите запись Passbolt".into());
    }
    let basic_secret = basic_secret.filter(|s| !s.is_empty());
    if !connector.basic_user.is_empty()
        && basic_secret.is_none()
        && store::secret_get(&keyring_entry_basic(&connector.id)).is_none()
    {
        return Err("задайте пароль Basic auth".into());
    }
    let _forget = ForgetOnDrop(connector.id.clone());
    if let Some(s) = secret.filter(|s| !s.is_empty()) {
        store::secret_set(&keyring_entry(&connector.id), &s)?;
    }
    if connector.basic_user.is_empty() {
        store::secret_delete(&keyring_entry_basic(&connector.id));
    } else if let Some(s) = basic_secret {
        store::secret_set(&keyring_entry_basic(&connector.id), &s)?;
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
    store::secret_delete(&keyring_entry(&id));
    store::secret_delete(&keyring_entry_basic(&id));
    forget_secrets(&id);
    store::save_json(FILE, &list)
}

/// HTTP Basic auth of the web server in front of the connector, if configured.
pub fn basic_credentials(c: &Connector, used: keepass::Use) -> Result<Option<(String, String)>, String> {
    if c.basic_user.is_empty() {
        return Ok(None);
    }
    let pass = keyring_secret(&keyring_entry_basic(&c.id), used)
        .ok_or("не задан пароль Basic auth — откройте коннектор и введите его")?;
    Ok(Some((c.basic_user.clone(), pass)))
}

/// All connectors (for other modules, e.g. alert polling).
pub fn all() -> Result<Vec<Connector>, String> {
    load()
}

/// (username, password-or-token) of a connector; empty when it has no credentials.
pub async fn credentials(
    kp: &KeepassState,
    pb: &PassboltState,
    c: &Connector,
    used: keepass::Use,
) -> Result<(String, String), String> {
    Ok(match c.auth.as_str() {
        "none" => (c.username.clone(), String::new()),
        "keepass" => {
            let (user, pass) = keepass::credentials(kp, &c.keepass_entry, used)?;
            (if c.username.is_empty() { user } else { c.username.clone() }, pass)
        }
        "passbolt" => {
            let (user, pass) = passbolt::credentials(pb, &c.passbolt_entry, used).await?;
            (
                if c.username.is_empty() {
                    user
                } else {
                    c.username.clone()
                },
                pass,
            )
        }
        _ => (c.username.clone(), keyring_secret(&keyring_entry(&c.id), used).unwrap_or_default()),
    })
}

/// Connector, its start URL and (if credentials are configured) the auto-login init script.
pub async fn prepare(
    kp: &KeepassState,
    pb: &PassboltState,
    id: &str,
) -> Result<(Connector, Url, Option<String>), String> {
    let mut c = load()?.into_iter().find(|c| c.id == id).ok_or("connector not found")?;
    let url = Url::parse(&c.url).map_err(|e| e.to_string())?;
    let secret = match c.auth.as_str() {
        "none" => String::new(),
        "keepass" => {
            let (user, pass) = keepass::credentials(kp, &c.keepass_entry, keepass::Use::User)?;
            if c.username.is_empty() {
                c.username = user;
            }
            c.auth = "password".into(); // same login flow as a stored password
            pass
        }
        "passbolt" => {
            let (user, pass) = passbolt::credentials(pb, &c.passbolt_entry, keepass::Use::User).await?;
            if c.username.is_empty() {
                c.username = user;
            }
            c.auth = "password".into();
            pass
        }
        _ => store::secret_get(&keyring_entry(&c.id)).unwrap_or_default(),
    };
    let script = (!secret.is_empty()).then(|| login_script(&c, &url, &secret));
    Ok((c, url, script))
}

/// Opens the connector in its own window. Async: on Windows, building a window from a synchronous
/// command deadlocks (WebviewWindowBuilder::build docs) — a blank window that cannot be closed.
#[tauri::command]
pub async fn connector_open(
    app: AppHandle,
    kp: State<'_, KeepassState>,
    pb: State<'_, PassboltState>,
    id: String,
) -> Result<(), String> {
    let label = format!("conn-{id}");
    if let Some(w) = app.get_webview_window(&label) {
        return w.set_focus().map_err(|e| e.to_string());
    }
    let (c, url, script) = prepare(&kp, &pb, &id).await?;
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

    // the kept secrets are one map for the process, and one test clears all of it
    static SECRETS_TESTS: Mutex<()> = Mutex::new(());

    #[test]
    fn background_reads_keep_a_keyring_secret_until_it_is_forgotten() {
        let _one = SECRETS_TESTS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        use crate::keepass::Use::{Background, User};
        let (id, reads, stored) = ("cache-reads", std::cell::Cell::new(0), std::cell::RefCell::new(Some("old".to_string())));
        let key = keyring_entry(id);
        let read = |_: &str| {
            reads.set(reads.get() + 1);
            Ok(stored.borrow().clone())
        };
        assert_eq!(keyring_secret_with(&key, Background, read).as_deref(), Some("old"));
        assert_eq!(keyring_secret_with(&key, Background, read).as_deref(), Some("old"));
        assert_eq!(reads.get(), 1, "every poll read the keyring");
        // changed in the connector dialog: the save forgets what the polls kept
        *stored.borrow_mut() = Some("new".into());
        drop(ForgetOnDrop(id.into()));
        assert_eq!(keyring_secret_with(&key, Background, read).as_deref(), Some("new"));
        assert_eq!(reads.get(), 2);
        // a user's action reads the keyring itself and makes the next poll read it too
        *stored.borrow_mut() = Some("outside".into());
        assert_eq!(keyring_secret_with(&key, User, read).as_deref(), Some("outside"));
        assert_eq!(keyring_secret_with(&key, Background, read).as_deref(), Some("outside"));
        assert_eq!(reads.get(), 4);
        // no password at all is kept too: an Alertmanager without auth is not a keyring read a minute
        let none = keyring_entry_basic(id);
        let missing = |_: &str| {
            reads.set(reads.get() + 1);
            Ok(None)
        };
        assert_eq!(keyring_secret_with(&none, Background, missing), None);
        assert_eq!(keyring_secret_with(&none, Background, missing), None);
        assert_eq!(reads.get(), 5);
        // an unreadable keyring (locked, no Secret Service) is asked again, not taken for "no password"
        let failing = |_: &str| {
            reads.set(reads.get() + 1);
            Err::<Option<String>, _>("locked".to_string())
        };
        let locked = keyring_entry("cache-locked");
        assert_eq!(keyring_secret_with(&locked, Background, failing), None);
        assert_eq!(keyring_secret_with(&locked, Background, read).as_deref(), Some("outside"));
        assert_eq!(reads.get(), 7);
        forget_all_secrets();
        assert_eq!(keyring_secret_with(&key, Background, read).as_deref(), Some("outside"));
        assert_eq!(reads.get(), 8, "a restarted poll reads anew");
    }

    // connector_save and connector_delete themselves are not called here: they reach the keyring,
    // and settings::tests count keyring calls of the whole process in parallel
    #[test]
    fn a_saved_or_deleted_connector_has_no_kept_secrets() {
        let _one = SECRETS_TESTS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let (id, other) = ("cache-save", "cache-other");
        let kept = |key: &str| SECRETS.lock().unwrap().contains_key(key);
        let fill = || {
            for key in [keyring_entry(id), keyring_entry_basic(id), keyring_entry(other)] {
                keyring_secret_with(&key, keepass::Use::Background, |_| Ok(Some("old".into())));
                assert!(kept(&key));
            }
        };
        let gone = || !kept(&keyring_entry(id)) && !kept(&keyring_entry_basic(id));
        fill();
        // what connector_save holds over its keyring writes, on every return path
        let failed_save = || -> Result<(), String> {
            let _forget = ForgetOnDrop(id.into());
            Err("secret_set failed half way".into())
        };
        failed_save().unwrap_err();
        assert!(gone(), "a save that failed after writing some secrets left the old ones to the polls");
        assert!(kept(&keyring_entry(other)), "another connector's secret was dropped");
        fill();
        forget_secrets(id);
        assert!(gone(), "a deleted connector's secrets stayed in memory");
    }

    #[test]
    fn keepass_and_passbolt_secrets_follow_the_vault_lock() {
        let _one = SECRETS_TESTS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let c = |auth: &str| -> Connector {
            serde_json::from_value(serde_json::json!({
                "id": format!("cache-{auth}"), "kind": "alertmanager", "name": "am", "url": "http://am.example.com:9093", "auth": auth,
                "keepass_entry": "3f2b9c1e-7a4d-4f6b-9a1e-0c2d3e4f5a6b", "passbolt_entry": "3f2b9c1e-7a4d-4f6b-9a1e-0c2d3e4f5a6b"
            }))
            .unwrap()
        };
        let (kp, pb) = (KeepassState::default(), PassboltState::default());
        tauri::async_runtime::block_on(async {
            for auth in ["keepass", "passbolt"] {
                let e = credentials(&kp, &pb, &c(auth), keepass::Use::Background).await.expect_err(auth);
                assert!(e.contains("заблокирован"), "{auth}: {e}");
            }
        });
        let cache = SECRETS.lock().unwrap();
        assert!(!cache.keys().any(|k| k.starts_with("connector:cache-keepass") || k.starts_with("connector:cache-passbolt")));
    }

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
