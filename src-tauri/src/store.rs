//! Shared persistence: JSON files in ~/.config/opsdeck and secrets in the OS keyring.

use serde::{de::DeserializeOwned, Serialize};
use std::{fs, path::Path, path::PathBuf};

const KEYRING_SERVICE: &str = "opsdeck";

pub fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

pub fn config_dir() -> Result<PathBuf, String> {
    #[cfg(not(test))]
    let base = dirs::config_dir().ok_or("no config dir")?;
    // unit tests must not read or rewrite the developer's own settings
    #[cfg(test)]
    let base = std::env::temp_dir().join(format!("opsdeck-test-config-{}", std::process::id()));
    let dir = base.join("opsdeck");
    fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir)
}

/// Previous copy of a config file: save_json renames the old file here before putting the new one in
/// place, so an interrupted write can never leave the app without its settings.
fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("config");
    path.with_file_name(format!("{name}.{suffix}"))
}

pub fn load_json<T: DeserializeOwned + Default>(name: &str) -> Result<T, String> {
    let path = config_dir()?.join(name);
    let bak = sibling(&path, "bak");
    let parsed = |p: &Path| -> Option<Result<T, String>> {
        let raw = fs::read_to_string(p).ok()?;
        Some(serde_json::from_str(&raw).map_err(|e| format!("{}: {e}", p.display())))
    };
    match parsed(&path) {
        Some(Ok(v)) => return Ok(v),
        // the file is there but unreadable: fall back to the previous copy before anything overwrites it
        Some(Err(e)) => {
            if let Some(Ok(v)) = parsed(&bak) {
                log::warn!("{e}; взята предыдущая копия {}", bak.display());
                return Ok(v);
            }
            let broken = sibling(&path, "bad");
            let _ = fs::copy(&path, &broken);
            return Err(format!("{e} (копия сохранена: {})", broken.display()));
        }
        // killed between the two renames of save_json: only the previous copy is left
        None => {
            if let Some(Ok(v)) = parsed(&bak) {
                log::warn!("{} не найден, взята предыдущая копия {}", path.display(), bak.display());
                return Ok(v);
            }
        }
    }
    Ok(T::default())
}

pub fn exists(name: &str) -> bool {
    // the backup counts: without it a lost settings.json would look like a first run and be re-detected
    config_dir().map(|d| d.join(name).exists() || sibling(&d.join(name), "bak").exists()).unwrap_or(false)
}

pub fn clean_path_buf(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(stripped) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{stripped}"))
    } else if let Some(stripped) = s.strip_prefix(r"\\?\") {
        PathBuf::from(stripped)
    } else {
        p
    }
}

/// Writes atomically and keeps the previous version next to it: `fs::write` truncates first, so an
/// app killed mid-write (an update, a reboot) used to leave an empty file — and settings were gone.
pub fn save_json<T: Serialize>(name: &str, value: &T) -> Result<(), String> {
    write_json(name, &serde_json::to_string_pretty(value).map_err(err)?)
}

/// Для машинных файлов, которые никто не читает глазами (история алертов): без отступов — вчетверо
/// меньше байт на запись и на разбор.
pub fn save_json_compact<T: Serialize>(name: &str, value: &T) -> Result<(), String> {
    write_json(name, &serde_json::to_string(value).map_err(err)?)
}

fn write_json(name: &str, data: &str) -> Result<(), String> {
    let path = config_dir()?.join(name);
    let tmp = sibling(&path, "tmp");
    {
        use std::io::Write;
        let mut f = fs::File::create(&tmp).map_err(err)?;
        f.write_all(data.as_bytes()).map_err(err)?;
        f.sync_all().map_err(err)?;
    }
    restrict(&tmp, 0o600)?;
    if path.exists() {
        let _ = fs::rename(&path, sibling(&path, "bak"));
    }
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        err(e)
    })?;
    restrict(&path, 0o600)
}

/// chmod on Unix (files with secrets: 0600, dirs: 0700). On Windows files in the user profile
/// are already private to the user, so this is a no-op there.
pub fn restrict(path: &Path, mode: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).map_err(err)
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
        Ok(())
    }
}

/// Opens a URL (http(s), obsidian://, …) with the system handler, without a shell.
pub fn open_with_system(url: &str) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    let mut cmd = std::process::Command::new("xdg-open");
    #[cfg(target_os = "macos")]
    let mut cmd = std::process::Command::new("open");
    #[cfg(target_os = "windows")]
    let mut cmd = {
        // rundll32 avoids cmd.exe quoting problems with & in URLs
        let mut c = std::process::Command::new("rundll32");
        c.arg("url.dll,FileProtocolHandler");
        c
    };
    let mut child = cmd.arg(url).spawn().map_err(err)?;
    std::thread::spawn(move || child.wait());
    Ok(())
}

/// Executable file? (Unix: x bit; Windows: .exe)
pub fn is_executable(p: &Path) -> bool {
    let Ok(m) = p.metadata() else { return false };
    if !m.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        m.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        p.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe"))
    }
}

/// Tests share one config dir, so the ones that write settings.json take this lock (they ran in parallel
/// and overwrote each other's vault path).
#[cfg(test)]
pub(crate) static SETTINGS_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Keyring accesses, for tests that check a code path doesn't reach the keyring.
#[cfg(test)]
pub(crate) static KEYRING_CALLS: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

fn entry(key: &str) -> Result<keyring::Entry, String> {
    #[cfg(test)]
    KEYRING_CALLS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    keyring::Entry::new(KEYRING_SERVICE, key).map_err(err)
}

pub fn secret_get(key: &str) -> Option<String> {
    entry(key).ok()?.get_password().ok()
}

pub fn secret_set(key: &str, value: &str) -> Result<(), String> {
    entry(key)?.set_password(value).map_err(err)
}

pub fn secret_delete(key: &str) {
    if let Ok(e) = entry(key) {
        let _ = e.delete_credential();
    }
}

/// Constant-time comparison for tokens (no early exit that would leak the matching prefix).
pub fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Ids come from the frontend (crypto.randomUUID) and end up in keyring keys and window labels.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The Windows \\?\ form is what `canonicalize` returns there; paths are compared without it, so
    /// a vault path and a note path match (notes and tasks broke on Windows when one side kept it).
    #[test]
    fn verbatim_prefix_is_stripped() {
        let clean = |s: &str| clean_path_buf(PathBuf::from(s)).to_string_lossy().into_owned();
        assert_eq!(clean(r"\\?\C:\Users\u\Notes\a.md"), r"C:\Users\u\Notes\a.md");
        assert_eq!(clean(r"\\?\UNC\server\share\Notes"), r"\\server\share\Notes");
        assert_eq!(clean(r"C:\Users\u\Notes"), r"C:\Users\u\Notes");
        assert_eq!(clean("/home/u/notes"), "/home/u/notes");
    }

    #[derive(serde::Serialize, serde::Deserialize, Default, PartialEq, Debug)]
    struct Cfg {
        path: String,
    }

    /// An interrupted write used to leave an empty settings.json, and the next load silently went to
    /// defaults — the notes folder and the other paths were gone (report after 0.7.1).
    #[test]
    fn an_empty_or_broken_config_falls_back_to_the_previous_copy() {
        let name = "store-test-cfg.json";
        let dir = config_dir().unwrap();
        for n in [name, &format!("{name}.bak"), &format!("{name}.bad")] {
            let _ = fs::remove_file(dir.join(n));
        }
        save_json(name, &Cfg { path: "/home/u/notes".into() }).unwrap();
        save_json(name, &Cfg { path: "/home/u/notes2".into() }).unwrap();
        assert_eq!(load_json::<Cfg>(name).unwrap().path, "/home/u/notes2");
        assert!(dir.join(format!("{name}.bak")).exists(), "the previous version is kept");

        // killed while writing: the file is truncated
        fs::write(dir.join(name), "").unwrap();
        assert_eq!(load_json::<Cfg>(name).unwrap().path, "/home/u/notes");
        // killed between the two renames: no main file at all
        fs::remove_file(dir.join(name)).unwrap();
        assert_eq!(load_json::<Cfg>(name).unwrap().path, "/home/u/notes");
        assert!(exists(name), "a config that only has its backup is not a first run");

        // nothing readable left: an error, and the unreadable file is kept for a look
        fs::write(dir.join(name), "{oops").unwrap();
        fs::write(dir.join(format!("{name}.bak")), "{oops").unwrap();
        assert!(load_json::<Cfg>(name).unwrap_err().contains(".bad"));
        assert!(dir.join(format!("{name}.bad")).exists());
    }

    #[test]
    fn ids() {
        assert!(valid_id("3f2b9c1e-7a4d-4f6b-9a1e-0c2d3e4f5a6b"));
        for bad in ["", "../etc/passwd", "a b", "a/b", "ид", &"a".repeat(65)] {
            assert!(!valid_id(bad), "{bad}");
        }
    }

    #[test]
    fn token_compare() {
        assert!(ct_eq("secret-token", "secret-token"));
        assert!(!ct_eq("secret-token", "secret-tokeN"));
        assert!(!ct_eq("short", "shorter"));
        assert!(ct_eq("", ""));
    }
}
