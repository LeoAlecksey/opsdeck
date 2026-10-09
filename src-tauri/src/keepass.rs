//! Read-only KeePass (.kdbx) access. The decrypted database lives only in memory and is dropped
//! on lock / auto-lock. Other modules (connectors, MikroTik) take credentials from here by entry id.
//! While unlocked, the file is watched: edits made in KeePassXC etc. are re-read with the same key.

use crate::{settings, store::err};
use keepass::{
    db::{EntryId, EntryRef},
    Database, DatabaseKey,
};
use serde::Serialize;
use std::{
    fs::File,
    path::Path,
    sync::Mutex,
    time::{Duration, Instant, SystemTime},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use zeroize::Zeroize;

const CLIPBOARD_CLEAR: Duration = Duration::from_secs(30);

struct Unlocked {
    db: Database,
    path: String,
    last_used: Instant,
    /// kept (zeroized on drop) only to re-open the file after it changes on disk
    key: DatabaseKey,
    /// (mtime, size) of the file the current `db` was read from
    stamp: Option<(SystemTime, u64)>,
    /// consecutive failed re-reads of a changed file (it may still be being written)
    reload_fails: u8,
}

fn file_stamp(path: &str) -> Option<(SystemTime, u64)> {
    let m = std::fs::metadata(Path::new(path)).ok()?;
    Some((m.modified().ok()?, m.len()))
}

#[derive(Default)]
pub struct KeepassState {
    inner: Mutex<Option<Unlocked>>,
}

#[derive(Serialize)]
pub struct Status {
    unlocked: bool,
    path: String,
    keyfile: String,
    entries: usize,
    lock_minutes: u64,
    keep_open: bool,
}

#[derive(Serialize)]
pub struct EntryInfo {
    id: String,
    title: String,
    username: String,
    url: String,
    group: String,
    tags: Vec<String>,
    has_password: bool,
    has_notes: bool,
}

fn locked_err() -> String {
    "KeePass заблокирован — разблокируйте базу на вкладке KeePass".into()
}

fn status_of(state: &KeepassState) -> Status {
    let s = settings::load();
    let inner = state.inner.lock().unwrap();
    Status {
        unlocked: inner.is_some(),
        path: inner.as_ref().map(|u| u.path.clone()).unwrap_or(s.keepass_path),
        keyfile: s.keepass_keyfile,
        entries: inner.as_ref().map_or(0, |u| visible_entries(&u.db).count()),
        lock_minutes: s.keepass_lock_minutes,
        keep_open: s.keepass_keep_open,
    }
}

/// Group path of an entry ("Infra / MikroTik"), or None if it sits in the recycle bin.
fn group_path(db: &Database, e: &EntryRef) -> Option<String> {
    let bin = db.meta.recyclebin_uuid;
    let mut names = Vec::new();
    let mut gid = Some(e.parent().id());
    while let Some(id) = gid {
        let g = db.group(id)?;
        if bin.is_some() && Some(id.uuid()) == bin {
            return None;
        }
        let parent = g.parent().map(|p| p.id());
        if parent.is_some() {
            names.push(g.name.clone()); // skip the root group's name
        }
        gid = parent;
    }
    names.reverse();
    Some(names.join(" / "))
}

fn visible_entries(db: &Database) -> impl Iterator<Item = (EntryRef<'_>, String)> {
    db.iter_all_entries().filter_map(move |e| group_path(db, &e).map(|g| (e, g)))
}

fn parse_id(id: &str) -> Result<EntryId, String> {
    uuid::Uuid::parse_str(id).map(EntryId::from).map_err(|_| "bad entry id".to_string())
}

/// Who reads an entry. Only the user's own actions keep the database open: alert polling takes a
/// connector's password every minute and would otherwise defeat the auto-lock for good.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Use {
    User,
    Background,
}

/// Runs `f` against an entry of the unlocked database; a use by the user refreshes the auto-lock timer.
fn with_entry<T>(
    state: &KeepassState,
    id: &str,
    used: Use,
    f: impl FnOnce(EntryRef) -> T,
) -> Result<T, String> {
    let id = parse_id(id)?;
    let mut inner = state.inner.lock().unwrap();
    let u = inner.as_mut().ok_or_else(locked_err)?;
    if used == Use::User {
        u.last_used = Instant::now();
    }
    let e = u.db.entry(id).ok_or("запись не найдена в базе")?;
    Ok(f(e))
}

/// (username, password) for other modules.
pub fn credentials(state: &KeepassState, id: &str, used: Use) -> Result<(String, String), String> {
    with_entry(state, id, used, |e| {
        (e.get_username().unwrap_or_default().to_string(), e.get_password().unwrap_or_default().to_string())
    })
}

/// Put a secret on the clipboard and wipe it after 30 s unless the user copied something else.
pub fn copy_secret(app: &AppHandle, value: String) -> Result<(), String> {
    app.clipboard().write_text(value.clone()).map_err(err)?;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(CLIPBOARD_CLEAR).await;
        if app.clipboard().read_text().ok().as_deref() == Some(value.as_str()) {
            let _ = app.clipboard().write_text(String::new());
        }
        let mut value = value;
        value.zeroize();
    });
    Ok(())
}

#[tauri::command]
pub fn kp_status(state: State<KeepassState>) -> Status {
    status_of(&state)
}

#[tauri::command]
pub async fn kp_unlock(state: State<'_, KeepassState>, mut password: String) -> Result<Status, String> {
    let s = settings::load();
    let path = if s.keepass_path.is_empty() { settings::current().await.keepass_path } else { s.keepass_path };
    if path.is_empty() {
        return Err("не задан путь к .kdbx — укажите его в настройках".into());
    }
    let keyfile = s.keepass_keyfile;
    let pw = std::mem::take(&mut password);
    let p = path.clone();
    // KDF (Argon2/AES-KDF) is deliberately slow: keep it off the async runtime
    let (db, key) = tauri::async_runtime::spawn_blocking(move || -> Result<(Database, DatabaseKey), String> {
        let mut pw = pw;
        let mut key = DatabaseKey::new();
        if !pw.is_empty() {
            key = key.with_password(&pw);
        }
        pw.zeroize();
        if !keyfile.is_empty() {
            let mut f = File::open(&keyfile).map_err(|e| format!("ключевой файл: {e}"))?;
            key = key.with_keyfile(&mut f).map_err(|e| format!("ключевой файл: {e}"))?;
        }
        let mut f = File::open(&p).map_err(|e| format!("{p}: {e}"))?;
        let db = Database::open(&mut f, key.clone()).map_err(|e| format!("не удалось открыть базу: {e}"))?;
        Ok((db, key))
    })
    .await
    .map_err(err)??;

    let stamp = file_stamp(&path);
    *state.inner.lock().unwrap() = Some(Unlocked { db, path, last_used: Instant::now(), key, stamp, reload_fails: 0 });
    Ok(status_of(&state))
}

#[tauri::command]
pub fn kp_lock(app: AppHandle, state: State<KeepassState>) {
    state.inner.lock().unwrap().take();
    let _ = app.emit("kp-locked", ());
}

#[tauri::command]
pub fn kp_entries(state: State<KeepassState>, query: Option<String>) -> Result<Vec<EntryInfo>, String> {
    let q = query.unwrap_or_default().to_lowercase();
    let mut inner = state.inner.lock().unwrap();
    let u = inner.as_mut().ok_or_else(locked_err)?;
    u.last_used = Instant::now();
    let mut out: Vec<EntryInfo> = visible_entries(&u.db)
        .map(|(e, group)| EntryInfo {
            id: e.id().uuid().to_string(),
            title: e.get_title().unwrap_or_default().into(),
            username: e.get_username().unwrap_or_default().into(),
            url: e.get_url().unwrap_or_default().into(),
            tags: e.tags.clone(),
            has_password: e.get_password().is_some_and(|p| !p.is_empty()),
            has_notes: e.get("Notes").is_some_and(|n| !n.is_empty()),
            group,
        })
        .filter(|i| {
            q.is_empty()
                || [&i.title, &i.username, &i.url, &i.group].iter().any(|f| f.to_lowercase().contains(&q))
                || i.tags.iter().any(|t| t.to_lowercase().contains(&q))
        })
        .collect();
    out.sort_by(|a, b| (&a.group, a.title.to_lowercase()).cmp(&(&b.group, b.title.to_lowercase())));
    Ok(out)
}

/// field: username | password | url | notes
#[tauri::command]
pub async fn kp_copy(app: AppHandle, state: State<'_, KeepassState>, id: String, field: String) -> Result<(), String> {
    let key = match field.as_str() {
        "username" => "UserName",
        "password" => "Password",
        "url" => "URL",
        "notes" => "Notes",
        _ => return Err("unknown field".into()),
    };
    let value = with_entry(&state, &id, Use::User, |e| {
        e.get(key).unwrap_or_default().to_string()
    })?;
    if field == "password" {
        copy_secret(&app, value)
    } else {
        app.clipboard().write_text(value).map_err(err)
    }
}

#[tauri::command]
pub fn kp_reveal(state: State<KeepassState>, id: String) -> Result<String, String> {
    with_entry(&state, &id, Use::User, |e| {
        e.get_password().unwrap_or_default().to_string()
    })
}

#[tauri::command]
pub fn kp_notes(state: State<KeepassState>, id: String) -> Result<String, String> {
    with_entry(&state, &id, Use::User, |e| {
        e.get("Notes").unwrap_or_default().to_string()
    })
}

#[tauri::command]
pub fn kp_open_external() -> Result<(), String> {
    let path = settings::load().keepass_path;
    let mut child = std::process::Command::new("keepassxc")
        .arg(path)
        .spawn()
        .map_err(|e| format!("keepassxc: {e}"))?;
    std::thread::spawn(move || child.wait());
    Ok(())
}

/// Background auto-lock and reload-on-change; started from `setup`.
pub fn spawn_autolock(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(3));
        loop {
            tick.tick().await;
            reload_if_changed(&app).await;
            let s = settings::load();
            let minutes = s.keepass_lock_minutes;
            if minutes == 0 || s.keepass_keep_open {
                continue;
            }
            let state = app.state::<KeepassState>();
            let expired = {
                let mut inner = state.inner.lock().unwrap();
                let expired = inner.as_ref().is_some_and(|u| u.last_used.elapsed() > Duration::from_secs(minutes * 60));
                if expired {
                    inner.take();
                }
                expired
            };
            if expired {
                let _ = app.emit("kp-locked", ());
            }
        }
    });
}

/// The .kdbx changed on disk (saved from KeePassXC, synced, ...): read it again with the kept key.
async fn reload_if_changed(app: &AppHandle) {
    let state = app.state::<KeepassState>();
    let job = {
        let inner = state.inner.lock().unwrap();
        let Some(u) = inner.as_ref() else { return };
        let now = file_stamp(&u.path);
        // missing file (moved / mid-replace) or unchanged: nothing to do
        let Some(now) = now else { return };
        if u.stamp == Some(now) {
            return;
        }
        // let a writer finish: only re-read once the file has been quiet for a second
        if now.0.elapsed().map_or(true, |d| d < Duration::from_secs(1)) {
            return;
        }
        (u.path.clone(), u.key.clone(), now)
    };
    let (path, key, now) = job;
    let p = path.clone();
    let res = tauri::async_runtime::spawn_blocking(move || -> Result<Database, String> {
        let mut f = File::open(&p).map_err(err)?;
        Database::open(&mut f, key).map_err(|e| e.to_string())
    })
    .await
    .map_err(err)
    .and_then(|r| r);

    let mut inner = state.inner.lock().unwrap();
    // locked or switched to another file meanwhile
    let Some(u) = inner.as_mut().filter(|u| u.path == path) else { return };
    match res {
        Ok(db) => {
            u.db = db;
            u.stamp = Some(now);
            u.reload_fails = 0;
            drop(inner);
            log::info!("keepass: {path} changed on disk, reloaded");
            let _ = app.emit("kp-changed", ());
        }
        Err(e) => {
            u.reload_fails += 1;
            // a few retries for a half-written file; then keep the old copy and stop retrying this version
            if u.reload_fails >= 3 {
                u.stamp = Some(now);
                u.reload_fails = 0;
                drop(inner);
                log::warn!("keepass: reload of {path} failed: {e}");
                let _ = app.emit("kp-reload-failed", format!(
                    "База KeePass изменилась, но перечитать её не удалось ({e}). Показана прежняя версия; если сменился пароль — заблокируйте и откройте заново."
                ));
            }
        }
    }
}

#[tauri::command]
pub async fn clip_write(app: AppHandle, text: String) -> Result<(), String> {
    app.clipboard().write_text(text).map_err(err)
}

#[tauri::command]
// async = not on the UI thread: reading a selection that OpsDeck itself owns from the UI thread
// blocks it until the clipboard request times out ("application not responding")
pub async fn clip_read(app: AppHandle) -> String {
    app.clipboard().read_text().unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An unlocked in-memory database with one entry, last used `idle` ago.
    fn unlocked(idle: Duration) -> (KeepassState, String) {
        let mut db = Database::new();
        let id = {
            let mut root = db.root_mut();
            let mut e = root.add_entry();
            e.set_unprotected("UserName", "grafana");
            e.set_protected("Password", "s3cret");
            e.id().to_string()
        };
        let u = Unlocked {
            db,
            path: String::new(),
            last_used: Instant::now() - idle,
            key: DatabaseKey::new(),
            stamp: None,
            reload_fails: 0,
        };
        (
            KeepassState {
                inner: Mutex::new(Some(u)),
            },
            id,
        )
    }
    fn idle(state: &KeepassState) -> Duration {
        state.inner.lock().unwrap().as_ref().unwrap().last_used.elapsed()
    }

    #[test]
    fn background_reads_do_not_keep_the_database_open() {
        let (state, id) = unlocked(Duration::from_secs(600));
        assert_eq!(
            credentials(&state, &id, Use::Background).unwrap(),
            ("grafana".into(), "s3cret".into())
        );
        assert!(
            idle(&state) >= Duration::from_secs(600),
            "alert polling must not reset the auto-lock timer"
        );
        credentials(&state, &id, Use::User).unwrap();
        assert!(idle(&state) < Duration::from_secs(5), "the user's own action does");
    }

    #[test]
    fn entry_ids() {
        assert!(super::parse_id("3f2b9c1e-7a4d-4f6b-9a1e-0c2d3e4f5a6b").is_ok());
        assert!(super::parse_id("../../etc").is_err());
        assert!(super::parse_id("").is_err());
    }
}
