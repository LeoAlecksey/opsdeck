//! In-app updates from GitHub Releases (tauri-plugin-updater). Releases are signed in CI with
//! the project's private key; the app only installs packages whose signature matches the public
//! key in tauri.conf.json.

use crate::store::err;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

/// GitHub repository the releases come from (same as the endpoint in tauri.conf.json).
const REPO: &str = "LeoAlecksey/opsdeck";

#[derive(Serialize)]
pub struct UpdateInfo {
    current: String,
    available: bool,
    version: Option<String>,
    notes: Option<String>,
    /// release date, unix seconds
    date: Option<i64>,
    /// the installed version was withdrawn (critical bug): `version` is the stable one to go back to
    rollback: bool,
}

#[tauri::command]
pub fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

fn http() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(concat!("OpsDeck/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(err)
}

#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    draft: bool,
    published_at: Option<String>,
    body: Option<String>,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

#[derive(Deserialize)]
struct GhAsset {
    name: String,
}

/// The installed version was withdrawn: its GitHub release is gone or marked pre-release
/// (the "Отозвать версию" workflow does that). Dev builds never count as withdrawn.
async fn withdrawn(current: &str) -> bool {
    if cfg!(debug_assertions) {
        return false;
    }
    let Ok(c) = http() else { return false };
    let url = format!("https://api.github.com/repos/{REPO}/releases/tags/v{current}");
    match c.get(url).header("Accept", "application/vnd.github+json").send().await {
        Ok(r) if r.status() == reqwest::StatusCode::NOT_FOUND => true,
        Ok(r) if r.status().is_success() => r.json::<GhRelease>().await.map(|g| g.prerelease).unwrap_or(false),
        // rate limit, offline...: don't guess
        _ => false,
    }
}

fn check_err(e: tauri_plugin_updater::Error) -> String {
    let e = e.to_string();
    // no published release yet (or no latest.json in it) — not an error for the user
    if e.contains("404") || e.contains("valid release JSON") {
        "релизов с обновлениями пока нет".to_string()
    } else {
        format!("не удалось проверить обновления: {e}")
    }
}

/// Почему установка не удалась — словами, а не кодом библиотеки.
///
/// Главный случай: менеджер обновлений до 2.14 на Linux всегда брал из latest.json общий ключ
/// `linux-x86_64`, а там AppImage. Для копии, установленной из .deb или .rpm, он не подходит —
/// отсюда «invalid updater binary format». С 0.8.2 менеджер выбирает ключ под тип установки
/// (`linux-x86_64-deb`), но прежние версии этого не умеют: такую копию надо один раз обновить
/// пакетом вручную.
fn install_err(e: &str) -> String {
    if e.contains("invalid updater binary format") || e.contains("not a valid deb") {
        return format!(
            "эта копия установлена пакетом (.deb или .rpm), а обновление пришло в другом формате. \
Скачайте пакет со страницы релиза и установите его один раз — дальше обновления будут ставиться сами: \
https://github.com/{REPO}/releases/latest"
        );
    }
    format!("не удалось установить: {e}")
}

#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<UpdateInfo, String> {
    let current = app.package_info().version.to_string();
    // offer anything different from the installed version; decide below whether it is an update
    let update = app.updater_builder().version_comparator(|cur, remote| remote.version != cur).build().map_err(err)?.check().await.map_err(check_err)?;
    let none = |current: String| UpdateInfo { current, available: false, version: None, notes: None, date: None, rollback: false };
    let Some(u) = update else { return Ok(none(current)) };
    let newer = semver_gt(&u.version, &current);
    // "latest" is older than what's installed: offer it only if the installed one was withdrawn
    let rollback = !newer && withdrawn(&current).await;
    if !newer && !rollback {
        return Ok(none(current));
    }
    Ok(UpdateInfo {
        current,
        available: true,
        version: Some(u.version.clone()),
        notes: u.body.clone(),
        date: u.date.map(|d| d.unix_timestamp()),
        rollback,
    })
}

fn semver_gt(a: &str, b: &str) -> bool {
    let parse = |s: &str| -> Vec<u64> { s.split(['.', '-', '+']).take(3).map(|p| p.parse().unwrap_or(0)).collect() };
    parse(a) > parse(b)
}

#[derive(Serialize)]
pub struct ReleaseInfo {
    version: String,
    date: Option<String>,
    notes: String,
    /// marked pre-release = withdrawn
    withdrawn: bool,
    /// has signed update files (latest.json), i.e. can be installed from the app
    installable: bool,
}

/// Published releases, newest first (for "install another version").
#[tauri::command]
pub async fn releases_list() -> Result<Vec<ReleaseInfo>, String> {
    let url = format!("https://api.github.com/repos/{REPO}/releases?per_page=30");
    let r = http()?.get(url).header("Accept", "application/vnd.github+json").send().await.map_err(err)?;
    if !r.status().is_success() {
        return Err(format!("GitHub ответил {}", r.status()));
    }
    let list: Vec<GhRelease> = r.json().await.map_err(err)?;
    Ok(list
        .into_iter()
        .filter(|g| !g.draft && g.tag_name.starts_with('v'))
        .map(|g| ReleaseInfo {
            version: g.tag_name.trim_start_matches('v').to_string(),
            date: g.published_at,
            notes: g.body.unwrap_or_default(),
            withdrawn: g.prerelease,
            installable: g.assets.iter().any(|a| a.name == "latest.json"),
        })
        .collect())
}

/// Downloads, verifies the signature, installs and restarts. Progress: `update-progress` events.
/// `version` = install exactly that release (also older: rollback); none = the offered update.
#[tauri::command]
pub async fn update_install(app: AppHandle, version: Option<String>) -> Result<(), String> {
    let mut builder = app.updater_builder().version_comparator(|cur, remote| remote.version != cur);
    if let Some(v) = &version {
        if !v.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') {
            return Err("bad version".into());
        }
        let url = format!("https://github.com/{REPO}/releases/download/v{v}/latest.json");
        builder = builder.endpoints(vec![url.parse().map_err(err)?]).map_err(err)?;
    }
    let update = builder.build().map_err(err)?.check().await.map_err(err)?.ok_or("эта версия уже установлена")?;
    if let Some(v) = &version {
        if update.version != *v {
            return Err(format!("в релизе v{v} лежит версия {}", update.version));
        }
    }
    let mut done: u64 = 0;
    let progress = app.clone();
    let finished = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                done += chunk as u64;
                let _ = progress.emit("update-progress", json!({ "downloaded": done, "total": total }));
            },
            move || {
                let _ = finished.emit("update-progress", json!({ "installing": true }));
            },
        )
        .await
        .map_err(|e| install_err(&e.to_string()))?;
    app.restart();
}

#[cfg(test)]
mod tests {
    /// Из отчёта: обновление 0.8.0 → 0.8.1 на установке из .deb падало с «invalid updater binary
    /// format». Человеку нужен понятный выход, а не текст библиотеки.
    #[test]
    fn a_package_install_is_told_what_to_do() {
        let msg = super::install_err("invalid updater binary format");
        assert!(msg.contains(".deb"), "{msg}");
        assert!(msg.contains("releases/latest"), "ссылка, куда идти: {msg}");
        assert!(!msg.contains("invalid updater"), "код библиотеки человеку ни о чём: {msg}");
        // остальные ошибки показываем как есть, не выдумывая причину
        assert_eq!(super::install_err("connection closed"), "не удалось установить: connection closed");
    }

    #[test]
    fn semver() {
        assert!(super::semver_gt("0.10.0", "0.9.9"));
        assert!(super::semver_gt("1.0.0", "0.3.0"));
        assert!(!super::semver_gt("0.2.0", "0.3.0"));
        assert!(!super::semver_gt("0.3.0", "0.3.0"));
    }
}
