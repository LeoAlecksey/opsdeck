//! Read-only Passbolt access over its JWT API, the counterpart of `keepass`. The account (from an
//! account kit or a recovery kit) is stored in the config dir with the private key still locked by
//! its passphrase; the unlocked key, the session, the decrypted list and the fetched secrets live
//! only in memory and are dropped on lock / auto-lock. Secrets are fetched one by one when used:
//! Passbolt logs every secret access, so the whole vault is never downloaded at unlock.

use crate::{settings, store, store::err};
use base64::Engine;
use pgp::{
    composed::{
        CleartextSignedMessage, Deserializable, Message, MessageBuilder, SignedPublicKey,
        SignedPublicSubKey, SignedSecretKey,
    },
    crypto::{hash::HashAlgorithm, sym::SymmetricKeyAlgorithm},
    types::{KeyDetails, Password},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use zeroize::{Zeroize, Zeroizing};

const ACCOUNT_FILE: &str = "passbolt-account.json";
/// keyring entry of the "remember for a month" MFA cookie
pub(crate) const MFA_KEY: &str = "passbolt-mfa";
const TIMEOUT: Duration = Duration::from_secs(20);
/// refresh the 5-minute access token this long before it expires
const REFRESH_MARGIN: Duration = Duration::from_secs(60);
const SESSION_LOST: &str = "сессия Passbolt не продлилась";

#[derive(Serialize, Deserialize, Clone, Default)]
struct Account {
    domain: String,
    user_id: String,
    username: String,
    first_name: String,
    last_name: String,
    /// armored, still locked by the user's passphrase (as the browser extension keeps it)
    private_key: String,
    server_key: String,
    server_fingerprint: String,
}

struct Session {
    http: reqwest::Client,
    domain: String,
    user_id: String,
    /// `PassboltState::epoch` the session belongs to
    epoch: u64,
    access: Zeroizing<String>,
    access_until: Instant,
    refresh: Zeroizing<String>,
    mfa: Option<Zeroizing<String>>,
    /// the server still waits for the second factor
    mfa_pending: bool,
}

struct Entry {
    id: String,
    kind: String,
    name: String,
    username: String,
    uris: Vec<String>,
    /// v4 cleartext description or v5 metadata description; the secret may hold another one
    description: String,
    folder: Option<String>,
}

#[derive(Default)]
struct Secret {
    password: Option<String>,
    description: Option<String>,
}

impl Drop for Secret {
    fn drop(&mut self) {
        self.password.zeroize();
        self.description.zeroize();
    }
}

struct Vault {
    key: Arc<SignedSecretKey>,
    /// MFA providers the server asks for; the list is loaded after `pb_mfa`
    mfa_pending: Option<Vec<String>>,
    entries: Vec<Entry>,
    /// folder id → (name, parent id)
    folders: HashMap<String, (String, Option<String>)>,
    secrets: HashMap<String, Secret>,
    /// resources whose metadata could not be read (hidden from the list)
    unreadable: usize,
    warnings: Vec<String>,
    last_used: Instant,
}

#[derive(Default)]
pub struct PassboltState {
    inner: Mutex<Option<Vault>>,
    /// The tokens; holding the lock = one request at a time: a refresh token is single-use, and
    /// Passbolt treats a reused one as session theft (it revokes the session and e-mails the admins)
    session: Arc<tokio::sync::Mutex<Option<Session>>>,
    /// bumped on lock: results of requests started before it are dropped
    epoch: std::sync::atomic::AtomicU64,
    /// set at startup (absent in tests): lock events go to the UI
    app: std::sync::OnceLock<AppHandle>,
}

#[derive(Serialize)]
pub struct Status {
    configured: bool,
    unlocked: bool,
    /// MFA providers to choose from (totp, yubikey) when the server asks for a second factor
    mfa: Vec<String>,
    url: String,
    user: String,
    server_fingerprint: String,
    entries: usize,
    unreadable: usize,
    warnings: Vec<String>,
    lock_minutes: u64,
    keep_open: bool,
}

#[derive(Serialize)]
pub struct EntryInfo {
    id: String,
    kind: String,
    title: String,
    username: String,
    url: String,
    group: String,
    has_password: bool,
    has_notes: bool,
}

#[derive(Serialize)]
pub struct AccountInfo {
    url: String,
    user: String,
    name: String,
    server_fingerprint: String,
}

fn locked_err() -> String {
    "Passbolt заблокирован — разблокируйте его на вкладке Passbolt".into()
}

fn load_account() -> Result<Option<Account>, String> {
    let a: Account = store::load_json(ACCOUNT_FILE)?;
    if a.user_id.is_empty() {
        return Ok(None);
    }
    check_domain(&a.domain)?;
    Ok(Some(a))
}

/// Tokens and the "remember for 30 days" cookie travel in HTTP headers: only https, plain http
/// just for a Passbolt on this computer (a test stand).
fn check_domain(domain: &str) -> Result<(), String> {
    let url = reqwest::Url::parse(domain).map_err(|_| format!("адрес Passbolt «{domain}» не разобран"))?;
    let local = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    match url.scheme() {
        "https" => Ok(()),
        "http" if local => Ok(()),
        _ => Err(format!("адрес Passbolt «{domain}» — не https: токены входа пошли бы по сети открытым текстом")),
    }
}

fn status_of(state: &PassboltState) -> Status {
    let s = settings::load();
    let account = load_account();
    let inner = state.inner.lock().unwrap();
    let mut warnings = Vec::new();
    let account = match account {
        Ok(a) => a,
        Err(e) => {
            warnings.push(format!("файл аккаунта Passbolt не читается: {e}"));
            None
        }
    };
    let v = inner.as_ref();
    if let Some(v) = v {
        warnings.extend(v.warnings.iter().cloned());
    }
    Status {
        configured: account.is_some(),
        unlocked: v.is_some_and(|v| v.mfa_pending.is_none()),
        mfa: v.and_then(|v| v.mfa_pending.clone()).unwrap_or_default(),
        url: account
            .as_ref()
            .map(|a| a.domain.clone())
            .unwrap_or_default(),
        user: account
            .as_ref()
            .map(|a| a.username.clone())
            .unwrap_or_default(),
        server_fingerprint: account
            .as_ref()
            .map(|a| a.server_fingerprint.clone())
            .unwrap_or_default(),
        entries: v.map_or(0, |v| v.entries.len()),
        unreadable: v.map_or(0, |v| v.unreadable),
        warnings,
        lock_minutes: s.passbolt_lock_minutes,
        keep_open: s.passbolt_keep_open,
    }
}

// ---------- OpenPGP ----------

fn parse_secret_key(armored: &str) -> Result<SignedSecretKey, String> {
    let (key, _) = SignedSecretKey::from_string(armored)
        .map_err(|e| format!("закрытый ключ не читается: {e}"))?;
    key.verify_bindings()
        .map_err(|e| format!("закрытый ключ повреждён: {e}"))?;
    Ok(key)
}

fn parse_public_key(armored: &str, what: &str) -> Result<SignedPublicKey, String> {
    let (key, _) =
        SignedPublicKey::from_string(armored).map_err(|e| format!("{what} не читается: {e}"))?;
    key.verify_bindings()
        .map_err(|e| format!("{what} повреждён: {e}"))?;
    Ok(key)
}

fn fingerprint(key: &impl KeyDetails) -> String {
    format!("{:X}", key.fingerprint())
}

/// The key with its passphrase removed, so that each decryption does not repeat the slow S2K.
fn unlock_key(armored: &str, passphrase: &str) -> Result<SignedSecretKey, String> {
    let mut key = parse_secret_key(armored)?;
    let pw = Password::from(passphrase);
    key.primary_key
        .remove_password(&pw)
        .map_err(|_| "неверная парольная фраза ключа Passbolt".to_string())?;
    for sub in &mut key.secret_subkeys {
        sub.key
            .remove_password(&pw)
            .map_err(|_| "неверная парольная фраза ключа Passbolt".to_string())?;
    }
    Ok(key)
}

fn read_message(mut msg: Message<'_>) -> Result<(Vec<u8>, Message<'_>), String> {
    if msg.is_compressed() {
        msg = msg.decompress().map_err(err)?;
    }
    let data = msg.as_data_vec().map_err(err)?;
    Ok((data, msg))
}

fn decrypt(key: &SignedSecretKey, armored: &str) -> Result<Vec<u8>, String> {
    let (msg, _) = Message::from_string(armored).map_err(err)?;
    let msg = msg.decrypt(&Password::empty(), key).map_err(err)?;
    Ok(read_message(msg)?.0)
}

/// Decrypt and require a valid signature by `signer` (its primary key or a signing subkey).
fn decrypt_verified(
    key: &SignedSecretKey,
    armored: &str,
    signer: &SignedPublicKey,
) -> Result<Vec<u8>, String> {
    let (msg, _) = Message::from_string(armored).map_err(err)?;
    let msg = msg.decrypt(&Password::empty(), key).map_err(err)?;
    let (data, msg) = read_message(msg)?;
    let signed =
        msg.verify(signer).is_ok() || signer.public_subkeys.iter().any(|s| msg.verify(s).is_ok());
    if !signed {
        return Err("ответ не подписан ключом сервера Passbolt".into());
    }
    Ok(data)
}

fn encryption_subkey(key: &SignedPublicKey) -> Option<&SignedPublicSubKey> {
    key.public_subkeys.iter().find(|s| {
        s.key.algorithm().can_encrypt()
            && s.signatures
                .iter()
                .any(|sig| sig.key_flags().encrypt_comms() || sig.key_flags().encrypt_storage())
    })
}

fn sign_and_encrypt(
    text: &str,
    signer: &SignedSecretKey,
    to: &SignedPublicKey,
) -> Result<String, String> {
    let mut rng = rand::thread_rng();
    let mut builder = MessageBuilder::from_bytes("", text.as_bytes().to_vec())
        .seipd_v1(&mut rng, SymmetricKeyAlgorithm::AES256);
    builder.sign(
        &signer.primary_key,
        Password::empty(),
        HashAlgorithm::Sha256,
    );
    match encryption_subkey(to) {
        Some(sub) => builder.encrypt_to_key(&mut rng, sub),
        None => builder.encrypt_to_key(&mut rng, to),
    }
    .map_err(|e| format!("ключ сервера не годится для шифрования: {e}"))?;
    builder
        .to_armored_string(&mut rng, Default::default())
        .map_err(err)
}

// ---------- HTTP ----------

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(TIMEOUT)
        // requests go only to the Passbolt address of the account: a redirect is an error, not a hop
        // to another host with the tokens
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!(
            env!("CARGO_PKG_NAME"),
            "/",
            env!("CARGO_PKG_VERSION")
        ))
        .build()
        .map_err(err)
}

fn api_url(domain: &str, path: &str) -> String {
    let sep = if path.contains('?') { '&' } else { '?' };
    format!("{}{path}{sep}api-version=v2", domain.trim_end_matches('/'))
}

/// The value of a Set-Cookie of the response.
fn cookie(resp: &reqwest::Response, name: &str) -> Option<String> {
    resp.headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .find_map(|h| {
            let (pair, _) = h
                .to_str()
                .ok()?
                .split_once(';')
                .unwrap_or((h.to_str().ok()?, ""));
            let (n, v) = pair.split_once('=')?;
            (n.trim() == name && !v.is_empty() && v != "deleted").then(|| v.trim().to_string())
        })
}

/// `body` of a Passbolt JSON answer, or its error message with the validation details.
async fn passbolt_body(resp: reqwest::Response, what: &str) -> Result<Value, String> {
    let status = resp.status();
    if status.is_redirection() {
        let to = resp
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|l| l.to_str().ok())
            .unwrap_or("?");
        return Err(format!(
            "{what}: HTTP {status}, сервер переадресует на {to} — запросы идут только на адрес Passbolt, без переадресаций; подключитесь с адресом, который открывается в браузере"
        ));
    }
    let text = resp.text().await.map_err(|e| format!("{what}: {e}"))?;
    let v: Value = serde_json::from_str(&text).map_err(|_| {
        let head: String = text.chars().take(120).collect();
        format!("{what}: HTTP {status}, ответ не JSON Passbolt: {head}")
    })?;
    if status.is_success() && v["header"]["status"] == "success" {
        return Ok(v["body"].clone());
    }
    let message = v["header"]["message"].as_str().unwrap_or("ошибка");
    let details = match &v["body"] {
        Value::Null => String::new(),
        Value::String(s) if s.is_empty() => String::new(),
        b => format!(" {b}"),
    };
    Err(format!("{what}: HTTP {status}: {message}{details}"))
}

/// Unix time of the `exp` claim of a JWT.
fn jwt_exp(token: &str) -> Option<i64> {
    let payload = token.split('.').nth(1)?;
    let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    serde_json::from_slice::<Value>(&raw).ok()?["exp"].as_i64()
}

fn access_until(token: &str) -> Instant {
    let left = jwt_exp(token).map_or(0, |exp| exp - chrono::Utc::now().timestamp());
    Instant::now() + Duration::from_secs(left.max(0) as u64)
}

/// Before logging in: the server is a Passbolt with the JWT API, and the address we would sign into
/// the login challenge is the one it is configured with. A challenge for another domain makes the
/// server e-mail its admins about an attack, so it is not even sent.
async fn check_server(http: &reqwest::Client, domain: &str) -> Result<(), String> {
    let resp = http
        .get(api_url(domain, "/settings.json"))
        .send()
        .await
        .map_err(|e| format!("{domain}: {e}"))?;
    let body = passbolt_body(resp, "настройки сервера Passbolt").await?;
    let url = body["app"]["url"].as_str().unwrap_or_default();
    if url.trim_end_matches('/') != domain.trim_end_matches('/') {
        return Err(format!(
            "адрес «{domain}» не совпадает с адресом, на который настроен сервер Passbolt («{url}») — укажите тот же адрес, что открываете в браузере"
        ));
    }
    if body["passbolt"]["plugins"]["jwtAuthentication"]["enabled"] != Value::Bool(true) {
        return Err("на сервере Passbolt выключен вход по JWT (плагин JwtAuthentication)".into());
    }
    Ok(())
}

async fn server_key(http: &reqwest::Client, domain: &str) -> Result<(String, String), String> {
    let resp = http
        .get(api_url(domain, "/auth/verify.json"))
        .send()
        .await
        .map_err(|e| format!("{domain}: {e}"))?;
    let body = passbolt_body(resp, "ключ сервера Passbolt").await?;
    let armored = body["keydata"]
        .as_str()
        .ok_or("сервер Passbolt не отдал свой ключ")?
        .to_string();
    let key = parse_public_key(&armored, "ключ сервера Passbolt")?;
    Ok((armored, fingerprint(&key)))
}

struct Login {
    session: Session,
    providers: Vec<String>,
}

/// JWT login: a challenge signed by the user and encrypted to the server; the answer, encrypted to
/// the user and signed by the server, carries the tokens (and the MFA providers if one is required).
async fn jwt_login(
    http: &reqwest::Client,
    account: &Account,
    key: Arc<SignedSecretKey>,
    server: Arc<SignedPublicKey>,
    mfa: Option<&str>,
) -> Result<Login, String> {
    let verify_token = uuid::Uuid::new_v4().to_string();
    let challenge = json!({
        "version": "1.0.0",
        "domain": account.domain,
        "verify_token": verify_token,
        "verify_token_expiry": chrono::Utc::now().timestamp() + 120,
    })
    .to_string();
    let (k, s) = (key.clone(), server.clone());
    let armored =
        tauri::async_runtime::spawn_blocking(move || sign_and_encrypt(&challenge, &k, &s))
            .await
            .map_err(err)??;
    let mut req = http
        .post(api_url(&account.domain, "/auth/jwt/login.json"))
        .json(&json!({ "user_id": account.user_id, "challenge": armored }));
    if let Some(m) = mfa {
        req = req.header(reqwest::header::COOKIE, format!("passbolt_mfa={m}"));
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("{}: {e}", account.domain))?;
    let body = passbolt_body(resp, "вход в Passbolt").await?;
    let answer = body["challenge"]
        .as_str()
        .ok_or("в ответе на вход нет challenge")?
        .to_string();
    let plain =
        tauri::async_runtime::spawn_blocking(move || decrypt_verified(&key, &answer, &server))
            .await
            .map_err(err)??;
    let plain = Zeroizing::new(plain);
    let v: Value =
        serde_json::from_slice(&plain).map_err(|e| format!("ответ на вход не читается: {e}"))?;
    if v["verify_token"].as_str() != Some(verify_token.as_str()) {
        return Err("сервер Passbolt вернул чужой verify_token — вход прерван".into());
    }
    let access = v["access_token"]
        .as_str()
        .ok_or("в ответе на вход нет access_token")?;
    let refresh = v["refresh_token"]
        .as_str()
        .ok_or("в ответе на вход нет refresh_token")?;
    let providers = v["providers"].as_array().map_or_else(Vec::new, |p| {
        p.iter()
            .filter_map(|x| x.as_str().map(String::from))
            .collect()
    });
    Ok(Login {
        session: Session {
            http: http.clone(),
            domain: account.domain.clone(),
            user_id: account.user_id.clone(),
            epoch: 0,
            access: Zeroizing::new(access.to_string()),
            access_until: access_until(access),
            refresh: Zeroizing::new(refresh.to_string()),
            mfa: mfa.map(|m| Zeroizing::new(m.to_string())),
            mfa_pending: !providers.is_empty(),
        },
        providers,
    })
}

impl Session {
    fn cookie(&self) -> Option<String> {
        self.mfa
            .as_ref()
            .map(|m| format!("passbolt_mfa={}", m.as_str()))
    }

    fn expiring(&self) -> bool {
        self.access_until.saturating_duration_since(Instant::now()) < REFRESH_MARGIN
    }

    /// New access token by the refresh token (which the server replaces with a new one).
    async fn refresh(&mut self) -> Result<(), String> {
        let mut req = self
            .http
            .post(api_url(&self.domain, "/auth/jwt/refresh.json"))
            .json(&json!({ "user_id": self.user_id, "refresh_token": self.refresh.as_str() }));
        if let Some(c) = self.cookie() {
            req = req.header(reqwest::header::COOKIE, c);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| format!("{}: {e}", self.domain))?;
        let new_refresh = cookie(&resp, "refresh_token");
        let new_mfa = cookie(&resp, "passbolt_mfa");
        let body = passbolt_body(resp, "продление сессии Passbolt").await?;
        let access = body["access_token"]
            .as_str()
            .ok_or("в ответе нет access_token")?
            .to_string();
        let new_refresh = new_refresh.ok_or("сервер не выдал новый refresh_token")?;
        self.access_until = access_until(&access);
        self.access = Zeroizing::new(access);
        self.refresh = Zeroizing::new(new_refresh);
        if let Some(m) = new_mfa {
            self.mfa = Some(Zeroizing::new(m));
        }
        Ok(())
    }

    /// Ends the session on the server. The logout needs a valid access token: an expired one is
    /// refreshed first, else the refresh token would stay valid on the server for a month.
    async fn logout(mut self) -> Result<(), String> {
        // before the second factor the server refuses the logout too (403, MFA required); such
        // tokens give access to nothing until a code is entered
        if self.mfa_pending {
            return Ok(());
        }
        if self.expiring() {
            self.refresh().await?;
        }
        let mut req = self
            .http
            .post(api_url(&self.domain, "/auth/jwt/logout.json"))
            .bearer_auth(self.access.as_str())
            .json(&json!({ "refresh_token": self.refresh.as_str() }));
        if let Some(c) = self.cookie() {
            req = req.header(reqwest::header::COOKIE, c);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| format!("{}: {e}", self.domain))?;
        passbolt_body(resp, "выход из Passbolt").await.map(|_| ())
    }
}

fn spawn_logout(s: Session) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = s.logout().await {
            log::warn!("passbolt: logout failed (the session expires by itself): {e}");
        }
    });
}

impl PassboltState {
    fn epoch(&self) -> u64 {
        self.epoch.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// GET a Passbolt API path with the session, refreshing the access token when it is about to expire.
    async fn get(&self, path: &str, what: &str) -> Result<Value, String> {
        let mut guard = self.session.lock().await;
        let epoch = self.epoch();
        let s = guard
            .as_mut()
            .filter(|s| s.epoch == epoch)
            .ok_or_else(locked_err)?;
        if s.expiring() {
            if let Err(e) = s.refresh().await {
                // the old refresh token may already be spent on the server: retrying it would look
                // like a stolen token, so the session ends here
                guard.take();
                drop(guard);
                let msg =
                    format!("{SESSION_LOST} ({e}) — Passbolt заблокирован, разблокируйте заново");
                self.lock_with(Some(msg.clone()));
                return Err(msg);
            }
        }
        let s = guard.as_ref().ok_or_else(locked_err)?;
        let mut req = s
            .http
            .get(api_url(&s.domain, path))
            .bearer_auth(s.access.as_str());
        if let Some(c) = s.cookie() {
            req = req.header(reqwest::header::COOKIE, c);
        }
        let resp = req.send().await.map_err(|e| format!("{}: {e}", s.domain))?;
        let body = passbolt_body(resp, what).await;
        if self.epoch() != epoch {
            return Err(locked_err());
        }
        body
    }
}

// ---------- list ----------

struct Raw {
    id: String,
    kind: String,
    v4: Option<(String, String, String, String)>,
    metadata: Option<(String, String, String)>,
    folder: Option<String>,
}

fn str_of(v: &Value, k: &str) -> String {
    v[k].as_str().unwrap_or_default().to_string()
}

/// Decrypts the v5 metadata. Returns the entries and the number of unreadable resources.
fn build_entries(
    raws: Vec<Raw>,
    user_key: &SignedSecretKey,
    shared: &HashMap<String, SignedSecretKey>,
) -> (Vec<Entry>, usize, Vec<String>) {
    let mut out = Vec::new();
    let mut unreadable = 0;
    let mut reasons: Vec<String> = Vec::new();
    for r in raws {
        let entry = match (r.v4, r.metadata) {
            (Some((name, username, uri, description)), None) => Ok(Entry {
                id: r.id,
                kind: r.kind,
                name,
                username,
                uris: if uri.is_empty() { vec![] } else { vec![uri] },
                description,
                folder: r.folder,
            }),
            (_, Some((armored, key_id, key_type))) => {
                let key = if key_type == "shared_key" {
                    shared.get(&key_id)
                } else {
                    Some(user_key)
                };
                match key {
                    None => Err(format!("нет ключа метаданных {key_id}")),
                    Some(k) => decrypt(k, &armored).and_then(|plain| {
                        let m: Value = serde_json::from_slice(&plain).map_err(err)?;
                        Ok(Entry {
                            id: r.id,
                            kind: r.kind,
                            name: str_of(&m, "name"),
                            username: str_of(&m, "username"),
                            uris: m["uris"]
                                .as_array()
                                .map(|u| {
                                    u.iter()
                                        .filter_map(|x| x.as_str().map(String::from))
                                        .collect()
                                })
                                .unwrap_or_default(),
                            description: str_of(&m, "description"),
                            folder: r.folder,
                        })
                    }),
                }
            }
            (None, None) => Err("нет ни метаданных, ни имени".into()),
        };
        match entry {
            Ok(e) => out.push(e),
            Err(e) => {
                unreadable += 1;
                if reasons.len() < 3 && !reasons.contains(&e) {
                    reasons.push(e);
                }
            }
        }
    }
    (out, unreadable, reasons)
}

/// The resources of `/resources.json` with their type slug from `/resource-types.json`, and the
/// number of resources of an unknown type (left out).
fn raws_from(types: &Value, resources: &Value) -> (Vec<Raw>, usize) {
    let slugs: HashMap<String, String> = types
        .as_array()
        .map(|t| {
            t.iter()
                .map(|x| (str_of(x, "id"), str_of(x, "slug")))
                .collect()
        })
        .unwrap_or_default();
    let mut unknown = 0;
    let raws = resources
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| {
            let kind = slugs.get(&str_of(r, "resource_type_id")).cloned();
            if kind.is_none() {
                unknown += 1;
            }
            let metadata = r["metadata"].as_str().map(|m| {
                (
                    m.to_string(),
                    str_of(r, "metadata_key_id"),
                    str_of(r, "metadata_key_type"),
                )
            });
            Some(Raw {
                id: str_of(r, "id"),
                kind: kind?,
                v4: r["name"].as_str().map(|n| {
                    (
                        n.to_string(),
                        str_of(r, "username"),
                        str_of(r, "uri"),
                        str_of(r, "description"),
                    )
                }),
                metadata,
                folder: r["folder_parent_id"].as_str().map(String::from),
            })
        })
        .collect();
    (raws, unknown)
}

/// The shared metadata keys of `/metadata/keys.json`, decrypted with the user's key, and warnings
/// for the ones that do not decrypt.
fn shared_keys_from(
    user_key: &SignedSecretKey,
    metadata_keys: &Value,
) -> (HashMap<String, SignedSecretKey>, Vec<String>) {
    let mut shared = HashMap::new();
    let mut warnings = Vec::new();
    for k in metadata_keys.as_array().into_iter().flatten() {
        let id = str_of(k, "id");
        let Some(data) = k["metadata_private_keys"]
            .as_array()
            .and_then(|p| p.first())
            .and_then(|p| p["data"].as_str())
        else {
            continue;
        };
        let key = decrypt(user_key, data).and_then(|plain| {
            let plain = Zeroizing::new(plain);
            let v: Value = serde_json::from_slice(&plain).map_err(err)?;
            let armored = Zeroizing::new(str_of(&v, "armored_key"));
            parse_secret_key(&armored)
        });
        match key {
            Ok(key) => {
                shared.insert(id, key);
            }
            Err(e) => warnings.push(format!("ключ метаданных {id} не расшифровался: {e}")),
        }
    }
    (shared, warnings)
}

/// The resource list with decrypted metadata, after the login (and MFA, if asked) succeeded.
async fn load_list(state: &PassboltState) -> Result<(), String> {
    let types = state
        .get("/resource-types.json", "типы записей Passbolt")
        .await?;
    let resources = state.get("/resources.json", "записи Passbolt").await?;
    let mut warnings = Vec::new();
    let folders = match state.get("/folders.json", "папки Passbolt").await {
        Ok(f) => f.as_array().cloned().unwrap_or_default(),
        Err(e) => {
            warnings.push(format!(
                "папки не загрузились, записи показаны без них: {e}"
            ));
            Vec::new()
        }
    };
    let (raws, unknown) = raws_from(&types, &resources);
    if unknown > 0 {
        warnings.push(format!(
            "записей неизвестного типа: {unknown} — не показаны"
        ));
    }
    let mut folder_map = HashMap::new();
    let mut encrypted_folders = 0;
    for f in &folders {
        match f["name"].as_str() {
            Some(n) => {
                folder_map.insert(
                    str_of(f, "id"),
                    (
                        n.to_string(),
                        f["folder_parent_id"].as_str().map(String::from),
                    ),
                );
            }
            None => encrypted_folders += 1,
        }
    }
    if encrypted_folders > 0 {
        warnings.push(format!(
            "папок с зашифрованным именем (v5): {encrypted_folders} — их записи показаны без папки"
        ));
    }

    let shared_ids: Vec<String> = raws
        .iter()
        .filter_map(|r| {
            r.metadata
                .as_ref()
                .filter(|m| m.2 == "shared_key")
                .map(|m| m.1.clone())
        })
        .collect();
    let metadata_keys = if shared_ids.is_empty() {
        Value::Array(vec![])
    } else {
        state
            .get(
                "/metadata/keys.json?contain[metadata_private_keys]=1",
                "ключи метаданных Passbolt",
            )
            .await?
    };
    let user_key = {
        let inner = state.inner.lock().unwrap();
        inner.as_ref().ok_or_else(locked_err)?.key.clone()
    };
    let (entries, unreadable, reasons, key_warnings) =
        tauri::async_runtime::spawn_blocking(move || {
            let (shared, key_warnings) = shared_keys_from(&user_key, &metadata_keys);
            let (entries, unreadable, reasons) = build_entries(raws, &user_key, &shared);
            (entries, unreadable, reasons, key_warnings)
        })
        .await
        .map_err(err)?;
    warnings.extend(key_warnings);
    if unreadable > 0 {
        warnings.push(format!(
            "не прочитано записей: {unreadable} ({})",
            reasons.join("; ")
        ));
    }
    for w in &warnings {
        log::warn!("passbolt: {w}");
    }
    let mut inner = state.inner.lock().unwrap();
    let v = inner.as_mut().ok_or_else(locked_err)?;
    v.entries = entries;
    v.folders = folder_map;
    v.unreadable = unreadable;
    v.warnings = warnings;
    v.last_used = Instant::now();
    Ok(())
}

fn folder_path(folders: &HashMap<String, (String, Option<String>)>, id: Option<&String>) -> String {
    let mut names = Vec::new();
    let mut cur = id.cloned();
    // the depth limit guards against a parent loop in a broken answer
    while let Some(id) = cur.take().filter(|_| names.len() < 32) {
        if let Some((name, parent)) = folders.get(&id) {
            names.push(name.clone());
            cur = parent.clone();
        }
    }
    names.reverse();
    names.join(" / ")
}

fn has_password(kind: &str) -> bool {
    !matches!(
        kind,
        "totp" | "v5-totp-standalone" | "v5-note" | "v5-custom-fields"
    )
}

/// Kinds whose secret is a bare password string (no JSON, no description).
fn bare_secret(kind: &str) -> bool {
    matches!(kind, "password-string" | "v5-password-string")
}

fn parse_secret(kind: &str, plain: &[u8]) -> Result<Secret, String> {
    let text = std::str::from_utf8(plain).map_err(|_| "секрет не в UTF-8".to_string())?;
    if bare_secret(kind) {
        return Ok(Secret {
            password: Some(text.to_string()),
            description: None,
        });
    }
    let mut v: Value =
        serde_json::from_str(text).map_err(|_| "секрет не в формате JSON Passbolt".to_string())?;
    let s = Secret {
        password: v["password"].as_str().map(String::from),
        description: v["description"].as_str().map(String::from),
    };
    if let Value::Object(m) = &mut v {
        for (_, x) in m.iter_mut() {
            if let Value::String(s) = x {
                s.zeroize();
            }
        }
    }
    Ok(s)
}

/// The decrypted secret of a resource: from memory, or fetched from the server (logged there).
async fn secret<T>(
    state: &PassboltState,
    id: &str,
    f: impl Fn(&Entry, &Secret) -> T,
) -> Result<T, String> {
    uuid::Uuid::parse_str(id).map_err(|_| "bad entry id".to_string())?;
    let (kind, key) = {
        let mut inner = state.inner.lock().unwrap();
        let v = inner
            .as_mut()
            .filter(|v| v.mfa_pending.is_none())
            .ok_or_else(locked_err)?;
        v.last_used = Instant::now();
        let e = v
            .entries
            .iter()
            .find(|e| e.id == id)
            .ok_or("запись не найдена в Passbolt")?;
        if let Some(s) = v.secrets.get(id) {
            return Ok(f(e, s));
        }
        (e.kind.clone(), v.key.clone())
    };
    let body = state
        .get(&format!("/secrets/resource/{id}.json"), "секрет Passbolt")
        .await?;
    let data = body["data"]
        .as_str()
        .ok_or("в ответе нет секрета")?
        .to_string();
    let s = tauri::async_runtime::spawn_blocking(move || {
        let plain = Zeroizing::new(decrypt(&key, &data)?);
        parse_secret(&kind, &plain)
    })
    .await
    .map_err(err)?
    .map_err(|e| format!("секрет не расшифровался: {e}"))?;
    let mut inner = state.inner.lock().unwrap();
    let v = inner.as_mut().ok_or_else(locked_err)?;
    let e = v
        .entries
        .iter()
        .find(|e| e.id == id)
        .ok_or("запись не найдена в Passbolt")?;
    let out = f(e, &s);
    v.secrets.insert(id.to_string(), s);
    Ok(out)
}

impl PassboltState {
    fn lock(&self) -> bool {
        self.lock_with(None)
    }

    /// Drops the vault (and ends its session on the server). True if something was unlocked.
    fn lock_with(&self, reason: Option<String>) -> bool {
        let locked_epoch = self.epoch.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let had = self.inner.lock().unwrap().take().is_some();
        // after a request still in flight: it may be refreshing the tokens right now
        let session = self.session.clone();
        tauri::async_runtime::spawn(async move {
            let mut g = session.lock().await;
            if g.as_ref().is_some_and(|s| s.epoch <= locked_epoch) {
                if let Some(s) = g.take() {
                    drop(g);
                    spawn_logout(s);
                }
            }
        });
        if !had {
            return false;
        }
        if let Some(app) = self.app.get() {
            if let Err(e) = app.emit("pb-locked", reason) {
                log::warn!("passbolt: pb-locked event: {e}");
            }
        }
        true
    }
}

// live tests against the test server of tests/passbolt (ignored by default)
#[cfg(test)]
mod live_tests;

// ---------- commands ----------

#[tauri::command]
pub fn pb_status(state: State<PassboltState>) -> Status {
    status_of(&state)
}

/// Imports an account kit ("Desktop app setup" in the Passbolt profile): base64 of a JSON account
/// clear-signed by the user's key.
#[tauri::command]
pub async fn pb_import_kit(
    state: State<'_, PassboltState>,
    path: String,
) -> Result<AccountInfo, String> {
    let account = read_kit(&path).await?;
    save_account(&state, account)
}

async fn read_kit(path: &str) -> Result<Account, String> {
    let raw = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("{path}: {e}"))?;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(raw.trim())
        .map_err(|_| "это не account kit Passbolt (файл не в base64)".to_string())?;
    let text = String::from_utf8(decoded).map_err(|_| "это не account kit Passbolt".to_string())?;
    let (msg, _) = CleartextSignedMessage::from_string(&text)
        .map_err(|e| format!("account kit не читается: {e}"))?;
    let kit: Value = serde_json::from_str(&msg.signed_text())
        .map_err(|e| format!("account kit не читается: {e}"))?;
    let user_public = parse_public_key(
        kit["user_public_armored_key"].as_str().unwrap_or_default(),
        "ключ пользователя из account kit",
    )?;
    msg.verify(&user_public)
        .map_err(|_| "подпись account kit не сходится — файл изменён или повреждён".to_string())?;
    let private_key = str_of(&kit, "user_private_armored_key");
    if fingerprint(&parse_secret_key(&private_key)?.primary_key) != fingerprint(&user_public) {
        return Err("в account kit закрытый ключ не от того пользователя".into());
    }
    let server_armored = str_of(&kit, "server_public_armored_key");
    let server_fp = fingerprint(&parse_public_key(
        &server_armored,
        "ключ сервера из account kit",
    )?);
    let account = Account {
        domain: str_of(&kit, "domain").trim_end_matches('/').to_string(),
        user_id: str_of(&kit, "user_id"),
        username: str_of(&kit, "username"),
        first_name: str_of(&kit, "first_name"),
        last_name: str_of(&kit, "last_name"),
        private_key,
        server_key: server_armored,
        server_fingerprint: server_fp.clone(),
    };
    uuid::Uuid::parse_str(&account.user_id)
        .map_err(|_| "в account kit нет ID пользователя".to_string())?;
    check_domain(&account.domain)?;
    let http = http_client()?;
    check_server(&http, &account.domain).await?;
    let (_, live_fp) = server_key(&http, &account.domain).await?;
    if live_fp != server_fp {
        return Err(format!(
            "ключ сервера {} ({live_fp}) не совпадает с ключом из account kit ({server_fp}) — сервер подменён или ключ сменили; уточните у администратора",
            account.domain
        ));
    }
    Ok(account)
}

fn save_account(state: &PassboltState, account: Account) -> Result<AccountInfo, String> {
    state.lock();
    store::secret_delete(MFA_KEY);
    store::save_json(ACCOUNT_FILE, &account)?;
    Ok(AccountInfo {
        url: account.domain,
        user: account.username,
        name: format!("{} {}", account.first_name, account.last_name)
            .trim()
            .to_string(),
        server_fingerprint: account.server_fingerprint,
    })
}

#[tauri::command]
pub fn pb_forget(state: State<PassboltState>) -> Result<(), String> {
    state.lock();
    store::secret_delete(MFA_KEY);
    let path = store::config_dir()?.join(ACCOUNT_FILE);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn pb_unlock(
    state: State<'_, PassboltState>,
    mut passphrase: String,
) -> Result<Status, String> {
    let pw = Zeroizing::new(std::mem::take(&mut passphrase));
    let account = load_account()?
        .ok_or("Passbolt не настроен — импортируйте account kit или recovery kit")?;
    unlock(&state, account, pw, store::secret_get(MFA_KEY)).await?;
    Ok(status_of(&state))
}

/// Login and, unless the server asks for a second factor, the list. `remembered`: a "remember for a
/// month" MFA cookie from an earlier login.
async fn unlock(
    state: &PassboltState,
    account: Account,
    pw: Zeroizing<String>,
    remembered: Option<String>,
) -> Result<(), String> {
    let armored = account.private_key.clone();
    let server_armored = account.server_key.clone();
    let (key, server) = tauri::async_runtime::spawn_blocking(move || {
        Ok::<_, String>((
            unlock_key(&armored, &pw)?,
            parse_public_key(&server_armored, "сохранённый ключ сервера")?,
        ))
    })
    .await
    .map_err(err)??;
    let (key, server) = (Arc::new(key), Arc::new(server));
    let http = http_client()?;
    check_server(&http, &account.domain).await?;
    let (_, live_fp) = server_key(&http, &account.domain).await?;
    if live_fp != account.server_fingerprint {
        return Err(format!(
            "ключ сервера Passbolt сменился: был {}, сейчас {live_fp}. Если администратор его менял — импортируйте account kit заново; иначе это может быть подмена сервера",
            account.server_fingerprint
        ));
    }
    let login = jwt_login(&http, &account, key.clone(), server, remembered.as_deref()).await?;
    let mut session = login.session;
    let mfa_pending = if login.providers.is_empty() {
        None
    } else {
        let supported: Vec<String> = login
            .providers
            .into_iter()
            .filter(|p| p == "totp" || p == "yubikey")
            .collect();
        if supported.is_empty() {
            spawn_logout(session);
            return Err("Passbolt требует второй фактор, который здесь не поддерживается (поддерживаются TOTP и Yubikey)".into());
        }
        Some(supported)
    };
    // a vault unlocked before is replaced: its session ends on the server
    state.lock();
    session.epoch = state.epoch();
    let vault = Vault {
        key,
        mfa_pending: mfa_pending.clone(),
        entries: Vec::new(),
        folders: HashMap::new(),
        secrets: HashMap::new(),
        unreadable: 0,
        warnings: Vec::new(),
        last_used: Instant::now(),
    };
    {
        let mut g = state.session.lock().await;
        *state.inner.lock().unwrap() = Some(vault);
        if let Some(old) = g.replace(session) {
            spawn_logout(old);
        }
    }
    if mfa_pending.is_none() {
        if let Err(e) = load_list(state).await {
            state.lock();
            return Err(e);
        }
    }
    Ok(())
}

/// Second factor: provider totp | yubikey, the code (Yubikey: the OTP the key types).
#[tauri::command]
pub async fn pb_mfa(
    state: State<'_, PassboltState>,
    provider: String,
    code: String,
    remember: bool,
) -> Result<Status, String> {
    match verify_mfa(&state, &provider, &code, remember).await {
        Ok(cookie) => {
            if remember {
                if let Err(e) = store::secret_set(MFA_KEY, &cookie) {
                    log::warn!("passbolt: MFA cookie not remembered: {e}");
                }
            }
            Ok(status_of(&state))
        }
        Err(e) => Err(e),
    }
}

/// Returns the MFA cookie (to remember when asked); then loads the list.
async fn verify_mfa(
    state: &PassboltState,
    provider: &str,
    code: &str,
    remember: bool,
) -> Result<String, String> {
    let field = match provider {
        "totp" => "totp",
        "yubikey" => "hotp",
        _ => return Err("unknown MFA provider".into()),
    };
    let mut g = state.session.lock().await;
    let epoch = state.epoch();
    let s = g
        .as_mut()
        .filter(|s| s.epoch == epoch)
        .ok_or_else(locked_err)?;
    let resp = s
        .http
        .post(api_url(&s.domain, &format!("/mfa/verify/{provider}.json")))
        .bearer_auth(s.access.as_str())
        .json(&json!({ field: code.trim(), "remember": remember }))
        .send()
        .await
        .map_err(|e| format!("{}: {e}", s.domain))?;
    let mfa = cookie(&resp, "passbolt_mfa");
    if let Err(e) = passbolt_body(resp, "проверка второго фактора").await {
        // after too many wrong codes the server has ended the session itself
        if e.contains("logged out") {
            g.take();
            drop(g);
            state.lock();
        }
        return Err(e);
    }
    let mfa = mfa.ok_or("сервер принял код, но не выдал cookie MFA")?;
    s.mfa = Some(Zeroizing::new(mfa.clone()));
    s.mfa_pending = false;
    drop(g);
    {
        let mut inner = state.inner.lock().unwrap();
        let v = inner
            .as_mut()
            .filter(|_| state.epoch() == epoch)
            .ok_or_else(locked_err)?;
        v.mfa_pending = None;
    }
    if let Err(e) = load_list(state).await {
        state.lock();
        return Err(e);
    }
    Ok(mfa)
}

#[tauri::command]
pub fn pb_lock(state: State<PassboltState>) {
    state.lock();
}

/// Re-reads the list from the server; on failure the previous list stays.
#[tauri::command]
pub async fn pb_reload(state: State<'_, PassboltState>) -> Result<Status, String> {
    if let Err(e) = load_list(&state).await {
        let mut inner = state.inner.lock().unwrap();
        let v = inner.as_mut().ok_or_else(locked_err)?;
        v.warnings
            .push(format!("список не обновился, показан прежний: {e}"));
    }
    Ok(status_of(&state))
}

#[tauri::command]
pub fn pb_entries(
    state: State<PassboltState>,
    query: Option<String>,
) -> Result<Vec<EntryInfo>, String> {
    let q = query.unwrap_or_default().to_lowercase();
    let mut inner = state.inner.lock().unwrap();
    let v = inner
        .as_mut()
        .filter(|v| v.mfa_pending.is_none())
        .ok_or_else(locked_err)?;
    v.last_used = Instant::now();
    let mut out: Vec<EntryInfo> = v
        .entries
        .iter()
        .map(|e| EntryInfo {
            id: e.id.clone(),
            kind: e.kind.clone(),
            title: e.name.clone(),
            username: e.username.clone(),
            url: e.uris.first().cloned().unwrap_or_default(),
            group: folder_path(&v.folders, e.folder.as_ref()),
            has_password: has_password(&e.kind),
            has_notes: !e.description.is_empty() || !bare_secret(&e.kind),
        })
        .filter(|i| {
            q.is_empty()
                || [&i.title, &i.username, &i.url, &i.group]
                    .iter()
                    .any(|f| f.to_lowercase().contains(&q))
        })
        .collect();
    out.sort_by(|a, b| (&a.group, a.title.to_lowercase()).cmp(&(&b.group, b.title.to_lowercase())));
    Ok(out)
}

/// The secret description, else the public (metadata) one.
fn notes(e: &Entry, s: &Secret) -> String {
    s.description
        .clone()
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| e.description.clone())
}

/// field: username | password | url | notes
#[tauri::command]
pub async fn pb_copy(
    app: AppHandle,
    state: State<'_, PassboltState>,
    id: String,
    field: String,
) -> Result<(), String> {
    let value = match field.as_str() {
        "username" | "url" => {
            let mut inner = state.inner.lock().unwrap();
            let v = inner
                .as_mut()
                .filter(|v| v.mfa_pending.is_none())
                .ok_or_else(locked_err)?;
            v.last_used = Instant::now();
            let e = v
                .entries
                .iter()
                .find(|e| e.id == id)
                .ok_or("запись не найдена в Passbolt")?;
            if field == "username" {
                e.username.clone()
            } else {
                e.uris.first().cloned().unwrap_or_default()
            }
        }
        "password" => {
            let pw = secret(&state, &id, |_, s| s.password.clone().unwrap_or_default()).await?;
            return crate::keepass::copy_secret(&app, pw);
        }
        "notes" => secret(&state, &id, notes).await?,
        _ => return Err("unknown field".into()),
    };
    app.clipboard().write_text(value).map_err(err)
}

#[tauri::command]
pub async fn pb_reveal(state: State<'_, PassboltState>, id: String) -> Result<String, String> {
    secret(&state, &id, |_, s| s.password.clone().unwrap_or_default()).await
}

#[tauri::command]
pub async fn pb_notes(state: State<'_, PassboltState>, id: String) -> Result<String, String> {
    secret(&state, &id, notes).await
}

/// Opens the resource (or Passbolt itself) in the browser.
#[tauri::command]
pub fn pb_open_external(id: Option<String>) -> Result<(), String> {
    let account = load_account()?.ok_or("Passbolt не настроен")?;
    let url = match id.filter(|i| uuid::Uuid::parse_str(i).is_ok()) {
        Some(i) => format!("{}/app/passwords/view/{i}", account.domain),
        None => account.domain,
    };
    store::open_with_system(&url)
}

/// Native file dialog; None when cancelled.
async fn pick_file(
    app: AppHandle,
    title: &'static str,
    ext: &'static [&'static str],
) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title(title)
            .add_filter(title, ext)
            .add_filter("Все файлы", &["*"])
            .blocking_pick_file()
            .and_then(|f| f.into_path().ok())
            .map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .ok()
    .flatten()
}

/// File dialog for an account kit; None when cancelled.
#[tauri::command]
pub async fn pb_pick_file(app: AppHandle) -> Option<String> {
    pick_file(app, "Account kit Passbolt", &["passbolt"]).await
}

/// Background auto-lock; started from `setup`.
pub fn spawn_autolock(app: AppHandle) {
    if app.state::<PassboltState>().app.set(app.clone()).is_err() {
        log::warn!("passbolt: auto-lock started twice");
        return;
    }
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(5));
        loop {
            tick.tick().await;
            let s = settings::load();
            if s.passbolt_lock_minutes == 0 || s.passbolt_keep_open {
                continue;
            }
            let state = app.state::<PassboltState>();
            let expired = state.inner.lock().unwrap().as_ref().is_some_and(|v| {
                v.last_used.elapsed() > Duration::from_secs(s.passbolt_lock_minutes * 60)
            });
            if expired {
                state.lock();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- without a server: keys and encrypted data are made here, API answers shaped as Passbolt's

    /// A Passbolt-like key (Ed25519 primary, Curve25519 encryption subkey), armored; locked by
    /// `passphrase` as in an account kit (none: as a metadata key or the server's).
    fn test_key(passphrase: Option<&str>) -> (String, SignedPublicKey) {
        use pgp::composed::{EncryptionCaps, KeyType, SecretKeyParamsBuilder, SubkeyParamsBuilder};
        use pgp::crypto::ecc_curve::ECCCurve;
        let mut rng = rand::thread_rng();
        let mut key = SecretKeyParamsBuilder::default()
            .key_type(KeyType::Ed25519Legacy)
            .can_certify(true)
            .can_sign(true)
            .primary_user_id("Test <test@example.com>".into())
            .subkeys(vec![SubkeyParamsBuilder::default()
                .key_type(KeyType::ECDH(ECCCurve::Curve25519Legacy))
                .can_encrypt(EncryptionCaps::All)
                .build()
                .unwrap()])
            .build()
            .unwrap()
            .generate(&mut rng)
            .unwrap();
        let public = key.to_public_key();
        if let Some(p) = passphrase {
            let pw = Password::from(p);
            key.primary_key.set_password(&mut rng, &pw).unwrap();
            for sub in &mut key.secret_subkeys {
                sub.key.set_password(&mut rng, &pw).unwrap();
            }
        }
        (key.to_armored_string(Default::default()).unwrap(), public)
    }

    /// Encrypted to `to` as the Passbolt clients store metadata and secrets.
    fn encrypt_to(text: &str, to: &SignedPublicKey) -> String {
        let mut rng = rand::thread_rng();
        let mut b = MessageBuilder::from_bytes("", text.as_bytes().to_vec())
            .seipd_v1(&mut rng, SymmetricKeyAlgorithm::AES256);
        b.encrypt_to_key(&mut rng, encryption_subkey(to).unwrap())
            .unwrap();
        b.to_armored_string(&mut rng, Default::default()).unwrap()
    }

    #[test]
    fn only_https_or_a_local_stand() {
        assert!(check_domain("https://passbolt.example.com").is_ok());
        assert!(check_domain("http://127.0.0.1:8090").is_ok());
        assert!(check_domain("http://localhost:8090").is_ok());
        assert!(check_domain("http://passbolt.example.com").unwrap_err().contains("не https"));
        assert!(check_domain("http://127.0.0.1.example.com").is_err());
        assert!(check_domain("file:///etc/passwd").is_err());
        assert!(check_domain("passbolt.example.com").is_err());
    }

    #[test]
    fn the_key_unlocks_only_with_its_passphrase() {
        let (armored, public) = test_key(Some("correct horse"));
        let e = unlock_key(&armored, "wrong").unwrap_err();
        assert!(e.contains("неверная парольная фраза"), "{e}");
        let key = unlock_key(&armored, "correct horse").unwrap();
        assert_eq!(decrypt(&key, &encrypt_to("ok", &public)).unwrap(), b"ok");
    }

    #[test]
    fn the_list_from_api_answers_v4_and_v5() {
        let (user_armored, user_pub) = test_key(Some("pass"));
        let user = unlock_key(&user_armored, "pass").unwrap();
        let (shared_armored, shared_pub) = test_key(None);
        let types = json!([
            { "id": "t-v4", "slug": "password-and-description" },
            { "id": "t-v5", "slug": "v5-default" },
        ]);
        let meta = |name: &str, login: &str, uris: &[&str]| {
            json!({
                "object_type": "PASSBOLT_RESOURCE_METADATA", "resource_type_id": "t-v5",
                "name": name, "username": login, "uris": uris, "description": "about",
            })
            .to_string()
        };
        let resources = json!([
            { "id": "r1", "resource_type_id": "t-v4", "name": "Router v4", "username": "admin",
              "uri": "https://router.example.com", "description": "v4 cleartext", "folder_parent_id": "f1" },
            { "id": "r2", "resource_type_id": "t-v5", "metadata_key_id": null, "metadata_key_type": "user_key",
              "metadata": encrypt_to(&meta("Server v5", "deploy", &["https://a.example.com", "https://b.example.com"]), &user_pub) },
            { "id": "r3", "resource_type_id": "t-v5", "metadata_key_id": "mk1", "metadata_key_type": "shared_key",
              "metadata": encrypt_to(&meta("Shared v5", "shared", &[]), &shared_pub) },
            { "id": "r4", "resource_type_id": "t-v5", "metadata_key_id": "mk-unknown", "metadata_key_type": "shared_key",
              "metadata": encrypt_to(&meta("No key", "x", &[]), &shared_pub) },
            { "id": "r5", "resource_type_id": "t-unknown", "name": "A type this version does not know" },
        ]);
        // the shared metadata key comes encrypted to the user, as /metadata/keys.json gives it
        let keys = json!([{ "id": "mk1", "metadata_private_keys": [
            { "data": encrypt_to(&json!({ "armored_key": shared_armored }).to_string(), &user_pub) }
        ] }]);

        let (raws, unknown) = raws_from(&types, &resources);
        assert_eq!((raws.len(), unknown), (4, 1));
        let (shared, warnings) = shared_keys_from(&user, &keys);
        assert!(warnings.is_empty(), "{warnings:?}");
        let (entries, unreadable, reasons) = build_entries(raws, &user, &shared);
        assert_eq!(unreadable, 1, "{reasons:?}");
        assert!(reasons[0].contains("mk-unknown"), "{reasons:?}");
        let by = |id: &str| entries.iter().find(|e| e.id == id).unwrap();
        let v4 = by("r1");
        assert_eq!(
            (
                v4.name.as_str(),
                v4.username.as_str(),
                v4.description.as_str()
            ),
            ("Router v4", "admin", "v4 cleartext")
        );
        assert_eq!(
            (v4.uris.as_slice(), v4.folder.as_deref()),
            (&["https://router.example.com".to_string()][..], Some("f1"))
        );
        let v5 = by("r2");
        assert_eq!(
            (v5.name.as_str(), v5.username.as_str(), v5.kind.as_str()),
            ("Server v5", "deploy", "v5-default")
        );
        assert_eq!(v5.uris, ["https://a.example.com", "https://b.example.com"]);
        assert_eq!(by("r3").name, "Shared v5");
    }

    #[test]
    fn secrets_v4_and_v5_decrypt() {
        let (armored, public) = test_key(Some("p"));
        let key = unlock_key(&armored, "p").unwrap();
        for (kind, plain, password, description) in [
            ("password-string", "only-a-password".to_string(), "only-a-password", None),
            (
                "password-and-description",
                json!({ "password": "v4-pass", "description": "v4 secret note" }).to_string(),
                "v4-pass",
                Some("v4 secret note"),
            ),
            (
                "v5-default",
                json!({ "object_type": "PASSBOLT_SECRET_DATA", "password": "v5-pass", "description": "v5 note" })
                    .to_string(),
                "v5-pass",
                Some("v5 note"),
            ),
        ] {
            let plain = decrypt(&key, &encrypt_to(&plain, &public)).unwrap();
            let s = parse_secret(kind, &plain).unwrap();
            assert_eq!(
                (s.password.as_deref(), s.description.as_deref()),
                (Some(password), description),
                "{kind}"
            );
        }
        // another key cannot read it
        let (other, _) = test_key(None);
        assert!(decrypt(
            &parse_secret_key(&other).unwrap(),
            &encrypt_to("x", &public)
        )
        .is_err());
    }

    #[test]
    fn only_answers_signed_by_the_server_key_are_accepted() {
        let (user_armored, user_pub) = test_key(None);
        let user = parse_secret_key(&user_armored).unwrap();
        let (server_armored, server_pub) = test_key(None);
        let server = parse_secret_key(&server_armored).unwrap();
        let (other_armored, _) = test_key(None);
        let other = parse_secret_key(&other_armored).unwrap();
        // the login challenge goes signed by the user; the server's answer comes signed by the server
        let to_server = sign_and_encrypt("challenge", &user, &server_pub).unwrap();
        assert_eq!(
            decrypt_verified(&server, &to_server, &user_pub).unwrap(),
            b"challenge"
        );
        let answer = sign_and_encrypt("tokens", &server, &user_pub).unwrap();
        assert_eq!(
            decrypt_verified(&user, &answer, &server_pub).unwrap(),
            b"tokens"
        );
        let forged = sign_and_encrypt("tokens", &other, &user_pub).unwrap();
        let e = decrypt_verified(&user, &forged, &server_pub).unwrap_err();
        assert!(e.contains("не подписан ключом сервера"), "{e}");
    }

    #[tokio::test]
    async fn a_redirect_is_not_followed() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let requests = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let seen = requests.clone();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let mut buf = [0u8; 4096];
                assert!(sock.read(&mut buf).await.unwrap() > 0, "an empty request");
                let answer = format!("HTTP/1.1 302 Found\r\nLocation: http://{addr}/elsewhere\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                sock.write_all(answer.as_bytes()).await.unwrap();
            }
        });
        let resp = http_client()
            .unwrap()
            .get(format!("http://{addr}/settings.json"))
            .send()
            .await
            .unwrap();
        let e = passbolt_body(resp, "настройки").await.unwrap_err();
        assert!(
            e.contains("переадресует на http://") && e.contains("/elsewhere"),
            "{e}"
        );
        assert_eq!(
            requests.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "the redirect was followed"
        );
    }

    #[test]
    fn secrets_by_kind() {
        let s = parse_secret("password-string", b"p@ss").unwrap();
        assert_eq!(s.password.as_deref(), Some("p@ss"));
        let s = parse_secret(
            "v5-default",
            br#"{"object_type":"PASSBOLT_SECRET_DATA","password":"x","description":"d"}"#,
        )
        .unwrap();
        assert_eq!(
            (s.password.as_deref(), s.description.as_deref()),
            (Some("x"), Some("d"))
        );
        let s = parse_secret(
            "v5-note",
            br#"{"object_type":"PASSBOLT_SECRET_DATA","description":"n"}"#,
        )
        .unwrap();
        assert_eq!(
            (s.password.as_deref(), s.description.as_deref()),
            (None, Some("n"))
        );
        assert!(parse_secret("password-and-description", b"not json").is_err());
    }
}
