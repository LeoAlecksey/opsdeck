//! Live tests against the test server of tests/passbolt (see tests/passbolt/seed/main.go):
//!   cd src-tauri; set -a; . ../tests/passbolt/.env.test; set +a
//!   cargo test --lib passbolt_live -- --ignored --test-threads=1

use super::*;

fn env(k: &str) -> String {
    std::env::var(k).unwrap_or_else(|_| panic!("{k} is not set: . tests/passbolt/.env.test"))
}

fn totp(secret: &str) -> String {
    use hmac::{Hmac, Mac};
    let key = data_encoding::BASE32_NOPAD
        .decode(secret.trim_end_matches('=').as_bytes())
        .unwrap();
    let counter = (chrono::Utc::now().timestamp() / 30) as u64;
    let mut mac = Hmac::<sha1::Sha1>::new_from_slice(&key).unwrap();
    mac.update(&counter.to_be_bytes());
    let h = mac.finalize().into_bytes();
    let o = (h[19] & 0xf) as usize;
    let n = u32::from_be_bytes([h[o] & 0x7f, h[o + 1], h[o + 2], h[o + 3]]) % 1_000_000;
    format!("{n:06}")
}

fn by_title(state: &PassboltState, title: &str) -> String {
    let inner = state.inner.lock().unwrap();
    let v = inner.as_ref().unwrap();
    v.entries
        .iter()
        .find(|e| e.name == title)
        .unwrap_or_else(|| panic!("no entry {title}"))
        .id
        .clone()
}

async fn password(state: &PassboltState, id: &str) -> Result<String, String> {
    secret(state, id, keepass::Use::User, |_, s| s.password.clone().unwrap_or_default()).await
}

/// Makes the next request refresh the session first.
fn expire_access(state: &PassboltState) -> String {
    let mut g = state.session.try_lock().unwrap();
    let s = g.as_mut().unwrap();
    s.access_until = Instant::now();
    s.refresh.to_string()
}

#[tokio::test]
#[ignore]
async fn passbolt_live_admin() {
    let account = read_kit(&env("PB_ADMIN_KIT")).await.unwrap();
    assert_eq!(account.user_id, env("PB_ADMIN_ID"));
    assert_eq!(
        account.server_fingerprint,
        env("PB_SERVER_FINGERPRINT").to_uppercase()
    );
    let state = PassboltState::default();

    let wrong = unlock(
        &state,
        account.clone(),
        Zeroizing::new("wrong".into()),
        None,
    )
    .await
    .unwrap_err();
    assert!(wrong.contains("неверная парольная фраза"), "{wrong}");

    unlock(
        &state,
        account,
        Zeroizing::new(env("PB_ADMIN_PASSPHRASE")),
        None,
    )
    .await
    .unwrap();
    let s = status_of(&state);
    assert!(s.unlocked && s.mfa.is_empty());
    assert_eq!(
        (s.entries, s.unreadable),
        (10, 0),
        "warnings: {:?}",
        s.warnings
    );

    {
        let inner = state.inner.lock().unwrap();
        let v = inner.as_ref().unwrap();
        let e = v
            .entries
            .iter()
            .find(|e| e.name == "Сервер v5 personal")
            .unwrap();
        assert_eq!(
            e.uris,
            ["https://v5.example.com", "https://alt.example.com"]
        );
        assert_eq!(folder_path(&v.folders, e.folder.as_ref()), "Servers");
    }
    for (title, pw) in [
        ("Router v4", "v4-router-pass"),
        ("Legacy v4 string", "v4-legacy-pass"),
        ("v4 with TOTP", "v4-totp-pass"),
        ("Сервер v5 personal", "v5-personal-pass"),
        ("Shared v5", "v5-shared-pass"),
        ("v5 with TOTP", "v5-totp-pass"),
    ] {
        assert_eq!(
            password(&state, &by_title(&state, title)).await.unwrap(),
            pw,
            "{title}"
        );
    }
    for (title, n) in [
        ("Router v4", "v4 description: encrypted"),
        ("Legacy v4 string", "v4 cleartext description"),
        ("Сервер v5 personal", "Описание v5"),
        ("v5 note", "a secure note\nsecond line"),
    ] {
        assert_eq!(
            secret(&state, &by_title(&state, title), keepass::Use::User, notes)
                .await
                .unwrap(),
            n,
            "{title}"
        );
    }

    // refresh: the token is replaced, and the session keeps working on the new one
    let old = expire_access(&state);
    let id = by_title(&state, "v5 note");
    state
        .inner
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .secrets
        .clear();
    secret(&state, &id, keepass::Use::User, notes).await.unwrap();
    let new = state
        .session
        .try_lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .refresh
        .to_string();
    assert_ne!(old, new);
    load_list(&state).await.unwrap();

    // a logout with an expired access token refreshes it first (else the server refuses it)
    let mut session = state.session.try_lock().unwrap().take().unwrap();
    session.access = Zeroizing::new("expired".into());
    session.access_until = Instant::now();
    session.logout().await.unwrap();

    assert!(state.lock());
    let e = password(&state, &id).await.unwrap_err();
    assert!(e.contains("заблокирован"), "{e}");
}

#[tokio::test]
#[ignore]
async fn passbolt_live_totp() {
    let account = read_kit(&env("PB_USER_KIT")).await.unwrap();
    let pass = || Zeroizing::new(env("PB_USER_PASSPHRASE"));
    let state = PassboltState::default();
    // a login waiting for the second factor can be ended too
    unlock(&state, account.clone(), pass(), None).await.unwrap();
    assert_eq!(status_of(&state).mfa, ["totp"]);
    state
        .session
        .try_lock()
        .unwrap()
        .take()
        .unwrap()
        .logout()
        .await
        .unwrap();
    state.lock();

    unlock(&state, account.clone(), pass(), None).await.unwrap();
    assert_eq!(status_of(&state).mfa, ["totp"]);
    assert!(pb_entries_of(&state).is_err());

    let wrong = verify_mfa(&state, "totp", "000000", false)
        .await
        .unwrap_err();
    assert!(wrong.contains("проверка второго фактора"), "{wrong}");
    let remembered = verify_mfa(&state, "totp", &totp(&env("PB_USER_TOTP")), true)
        .await
        .unwrap();
    let s = status_of(&state);
    assert!(s.unlocked && s.mfa.is_empty());
    assert_eq!(
        s.entries, 1,
        "the user sees only the resource shared with them"
    );
    let id = by_title(&state, "Shared v5");
    assert_eq!(password(&state, &id).await.unwrap(), "v5-shared-pass");

    // the MFA proof moves to the new access token on refresh
    expire_access(&state);
    load_list(&state).await.unwrap();
    state
        .inner
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .secrets
        .clear();
    assert_eq!(password(&state, &id).await.unwrap(), "v5-shared-pass");
    state.lock();

    // "remember for a month": the next login asks no code
    let state = PassboltState::default();
    unlock(&state, account, pass(), Some(remembered))
        .await
        .unwrap();
    assert!(status_of(&state).unlocked);
}

fn pb_entries_of(state: &PassboltState) -> Result<usize, String> {
    let inner = state.inner.lock().unwrap();
    inner
        .as_ref()
        .filter(|v| v.mfa_pending.is_none())
        .map(|v| v.entries.len())
        .ok_or_else(locked_err)
}

#[tokio::test]
#[ignore]
async fn passbolt_live_wrong_domain() {
    let mut account = read_kit(&env("PB_ADMIN_KIT")).await.unwrap();
    account.domain = account.domain.replace("127.0.0.1", "localhost");
    let e = unlock(
        &PassboltState::default(),
        account,
        Zeroizing::new(env("PB_ADMIN_PASSPHRASE")),
        None,
    )
    .await
    .unwrap_err();
    assert!(e.contains("не совпадает с адресом"), "{e}");
}
