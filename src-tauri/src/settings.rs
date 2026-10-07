//! App settings (paths to KeePass db, Obsidian vault, WinBox) + discovery of likely candidates.

use crate::store;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const FILE: &str = "settings.json";

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Settings {
    pub keepass_path: String,
    pub keepass_keyfile: String,
    pub keepass_lock_minutes: u64,
    /// once unlocked, stay unlocked until OpsDeck exits (auto-lock minutes are ignored)
    pub keepass_keep_open: bool,
    pub obsidian_vault: String,
    pub winbox_path: String,
    /// Also list contexts from ~/.kube/config and $KUBECONFIG (off: OpsDeck uses only its own store).
    pub k8s_include_system: bool,
    /// check GitHub Releases for a newer version at startup
    pub update_auto_check: bool,
    /// External AI server (Ollama, vLLM, LM Studio…): used instead of the built-in
    /// local engine when `ai_host` and `ai_model` are both set.
    pub ai_host: String,
    pub ai_port: String,
    pub ai_model: String,
    /// Comes from the UI when the user types a new key; kept in the OS keyring, never written to
    /// settings.json and never sent back to the UI.
    #[serde(skip_serializing)]
    pub ai_api_key: String,
    /// for the UI: a key is saved in the keyring
    #[serde(skip_deserializing)]
    pub ai_key_saved: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            keepass_path: String::new(),
            keepass_keyfile: String::new(),
            keepass_lock_minutes: 15,
            keepass_keep_open: true,
            obsidian_vault: String::new(),
            winbox_path: String::new(),
            k8s_include_system: false,
            update_auto_check: true,
            ai_host: String::new(),
            ai_port: String::new(),
            ai_model: String::new(),
            ai_api_key: String::new(),
            ai_key_saved: false,
        }
    }
}

pub fn load() -> Settings {
    store::load_json(FILE).unwrap_or_default()
}

#[tauri::command]
pub async fn settings_get() -> Settings {
    tauri::async_runtime::spawn_blocking(filled).await.unwrap_or_default()
}

/// Keyring entry of the external AI server's API key.
const AI_KEY: &str = "ai-api-key";

/// The external AI server's API key ("" when none).
pub fn ai_api_key() -> String {
    store::secret_get(AI_KEY).unwrap_or_default()
}

/// Forget the external AI server's API key.
#[tauri::command]
pub fn ai_key_clear() {
    store::secret_delete(AI_KEY);
}

fn filled() -> Settings {
    let mut s = load();
    // a key saved in plain text by an earlier build: move it to the keyring
    if !s.ai_api_key.trim().is_empty() && store::secret_set(AI_KEY, s.ai_api_key.trim()).is_ok() {
        s.ai_api_key.clear();
        let _ = store::save_json(FILE, &s);
    }
    s.ai_key_saved = store::secret_get(AI_KEY).is_some();
    // first run: pre-fill from what's on disk so things work without visiting settings
    if s.keepass_path.is_empty() || s.obsidian_vault.is_empty() || s.winbox_path.is_empty() {
        let d = detect();
        if s.keepass_path.is_empty() {
            s.keepass_path = d.keepass.first().cloned().unwrap_or_default();
        }
        if s.obsidian_vault.is_empty() {
            s.obsidian_vault = d.obsidian.first().cloned().unwrap_or_default();
        }
        if s.winbox_path.is_empty() {
            s.winbox_path = d.winbox.first().cloned().unwrap_or_default();
        }
        // persist what was found so later `load()` calls don't need to rescan
        let _ = store::save_json(FILE, &s);
    }
    s
}

/// Settings with auto-detected defaults filled in (may scan $HOME on first use).
pub async fn current() -> Settings {
    settings_get().await
}

#[tauri::command]
pub fn settings_set(settings: Settings) -> Result<(), String> {
    // a newly typed key goes to the keyring; an empty field keeps the saved one
    let key = settings.ai_api_key.trim();
    if !key.is_empty() {
        store::secret_set(AI_KEY, key).map_err(|e| format!("не удалось сохранить API-ключ в хранилище паролей: {e}"))?;
    }
    store::save_json(FILE, &settings)
}

#[derive(Serialize, Default)]
pub struct Detected {
    pub keepass: Vec<String>,
    pub obsidian: Vec<String>,
    pub winbox: Vec<String>,
}

/// Shallow scan of $HOME (depth 4, skipping hidden dirs and heavy trees).
fn scan(dir: &Path, depth: u32, out: &mut Detected) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            if name == ".obsidian" {
                out.obsidian.push(dir.to_string_lossy().into_owned());
                continue;
            }
            if depth > 0 && !name.starts_with('.') && !matches!(name.as_str(), "node_modules" | "target" | "snap" | "venv" | ".venv") {
                scan(&p, depth - 1, out);
            }
        } else if name.ends_with(".kdbx") {
            out.keepass.push(p.to_string_lossy().into_owned());
        } else if is_winbox_name(&name) && crate::store::is_executable(&p) {
            out.winbox.push(p.to_string_lossy().into_owned());
        }
    }
}


pub fn detect() -> Detected {
    let mut out = Detected::default();
    for bin in ["WinBox", "winbox", "WinBox.exe", "winbox64.exe", "winbox.exe"] {
        if let Some(p) = std::env::var_os("PATH")
            .into_iter()
            .flat_map(|p| std::env::split_paths(&p).collect::<Vec<PathBuf>>())
            .map(|d| d.join(bin))
            .find(|p| crate::store::is_executable(p))
        {
            out.winbox.push(p.to_string_lossy().into_owned());
        }
    }
    if let Some(home) = dirs::home_dir() {
        scan(&home, 4, &mut out);
    }
    for v in [&mut out.keepass, &mut out.obsidian, &mut out.winbox] {
        v.sort();
        v.dedup();
    }
    out
}

#[tauri::command]
pub async fn settings_detect() -> Detected {
    tauri::async_runtime::spawn_blocking(detect).await.unwrap_or_default()
}

/// "WinBox" on Linux/macOS, "winbox64.exe" / "WinBox.exe" on Windows.
fn is_winbox_name(name: &str) -> bool {
    let n = name.to_lowercase();
    let stem = n.strip_suffix(".exe").unwrap_or(&n);
    stem == "winbox" || stem == "winbox64"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn winbox_names() {
        for ok in ["WinBox", "winbox64.exe", "WinBox.exe", "winbox"] {
            assert!(is_winbox_name(ok), "{ok}");
        }
        for bad in ["winbox.sh", "notwinbox", "winbox32.exe", ""] {
            assert!(!is_winbox_name(bad), "{bad}");
        }
    }

    #[test]
    fn api_key_is_never_serialized() {
        let s = Settings { ai_api_key: "sk-secret".into(), ai_key_saved: true, ..Default::default() };
        let json = serde_json::to_string(&s).unwrap();
        assert!(!json.contains("sk-secret"), "the key must not reach settings.json or the UI");
        assert!(json.contains("\"ai_key_saved\":true"));
        // the UI sends the key on save; the saved flag is never trusted from outside
        let back: Settings = serde_json::from_str(r#"{"ai_api_key":"typed","ai_key_saved":true}"#).unwrap();
        assert_eq!(back.ai_api_key, "typed");
        assert!(!back.ai_key_saved);
    }
}
