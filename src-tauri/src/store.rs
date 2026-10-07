//! Shared persistence: JSON files in ~/.config/opsdeck and secrets in the OS keyring.

use serde::{de::DeserializeOwned, Serialize};
use std::{fs, path::Path, path::PathBuf};

const KEYRING_SERVICE: &str = "opsdeck";

pub fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

pub fn config_dir() -> Result<PathBuf, String> {
    let dir = dirs::config_dir().ok_or("no config dir")?.join("opsdeck");
    fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir)
}

pub fn load_json<T: DeserializeOwned + Default>(name: &str) -> Result<T, String> {
    let path = config_dir()?.join(name);
    if !path.exists() {
        return Ok(T::default());
    }
    let raw = fs::read_to_string(&path).map_err(err)?;
    serde_json::from_str(&raw).map_err(|e| format!("{}: {e}", path.display()))
}

pub fn save_json<T: Serialize>(name: &str, value: &T) -> Result<(), String> {
    let path = config_dir()?.join(name);
    fs::write(&path, serde_json::to_string_pretty(value).map_err(err)?).map_err(err)?;
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

fn entry(key: &str) -> Result<keyring::Entry, String> {
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
