//! MikroTik devices: launch WinBox with credentials, open SSH in a terminal tab.
//! Credentials come from a KeePass entry or from the OS keyring.

use crate::{
    keepass::{self, KeepassState},
    settings, store,
    tools::valid_host,
};
use serde::{Deserialize, Serialize};
use std::process::{Command, Stdio};
use tauri::{AppHandle, State};

const FILE: &str = "mikrotik.json";

#[derive(Serialize, Deserialize, Clone)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub host: String,
    #[serde(default)]
    pub group: String,
    #[serde(default)]
    pub username: String,
    /// keepass | password | none
    #[serde(default = "default_auth")]
    pub auth: String,
    #[serde(default)]
    pub keepass_entry: String,
    #[serde(default = "default_winbox_port")]
    pub winbox_port: u16,
    #[serde(default = "default_ssh_port")]
    pub ssh_port: u16,
}

fn default_auth() -> String {
    "keepass".into()
}
fn default_winbox_port() -> u16 {
    8291
}
fn default_ssh_port() -> u16 {
    22
}

fn secret_key(id: &str) -> String {
    format!("mikrotik:{id}")
}

fn load() -> Result<Vec<Device>, String> {
    store::load_json(FILE)
}

fn find(id: &str) -> Result<Device, String> {
    load()?.into_iter().find(|d| d.id == id).ok_or_else(|| "устройство не найдено".into())
}

/// Username from the device overrides the KeePass entry's one.
fn credentials(kp: &KeepassState, d: &Device) -> Result<(String, String), String> {
    match d.auth.as_str() {
        "keepass" => {
            let (u, p) = keepass::credentials(kp, &d.keepass_entry)?;
            Ok((if d.username.is_empty() { u } else { d.username.clone() }, p))
        }
        "password" => Ok((d.username.clone(), store::secret_get(&secret_key(&d.id)).unwrap_or_default())),
        _ => Ok((d.username.clone(), String::new())),
    }
}

#[tauri::command]
pub fn mt_list() -> Result<Vec<Device>, String> {
    load()
}

#[tauri::command]
pub fn mt_save(device: Device, secret: Option<String>) -> Result<(), String> {
    if !store::valid_id(&device.id) {
        return Err("invalid id".into());
    }
    if !valid_host(&device.host) {
        return Err("некорректный адрес".into());
    }
    if device.auth == "keepass" && device.keepass_entry.is_empty() {
        return Err("выберите запись KeePass".into());
    }
    if let Some(s) = secret.filter(|s| !s.is_empty()) {
        store::secret_set(&secret_key(&device.id), &s)?;
    }
    let mut list = load()?;
    match list.iter_mut().find(|d| d.id == device.id) {
        Some(d) => *d = device,
        None => list.push(device),
    }
    store::save_json(FILE, &list)
}

#[tauri::command]
pub fn mt_delete(id: String) -> Result<(), String> {
    let mut list = load()?;
    list.retain(|d| d.id != id);
    store::secret_delete(&secret_key(&id));
    store::save_json(FILE, &list)
}

/// WinBox 4 CLI: `WinBox <address[:port]> <login> <password>`.
/// Note: like any CLI launch, the password is visible in the process list of this user.
#[tauri::command]
pub async fn mt_winbox(kp: State<'_, KeepassState>, id: String) -> Result<(), String> {
    let d = find(&id)?;
    let (user, pass) = credentials(&kp, &d)?;
    let bin = winbox_bin(&settings::current().await.winbox_path)?;
    let bin = bin.to_string_lossy().into_owned();
    let addr = if d.winbox_port == 8291 { d.host.clone() } else { format!("{}:{}", d.host, d.winbox_port) };
    let mut cmd = Command::new(&bin);
    cmd.arg(addr);
    if !user.is_empty() {
        cmd.arg(&user);
        if !pass.is_empty() {
            cmd.arg(&pass);
        }
    }
    if let Some(dir) = std::path::Path::new(&bin).parent() {
        cmd.current_dir(dir);
    }
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("{bin}: {e}"))?;
    std::thread::spawn(move || child.wait()); // reap, no zombies
    Ok(())
}

/// The WinBox executable from the setting, forgiving what Windows' "Copy as path" adds (quotes)
/// and a folder instead of the file.
fn winbox_bin(raw: &str) -> Result<std::path::PathBuf, String> {
    let s = raw.trim().trim_matches(|c| c == '"' || c == '\'').trim();
    if s.is_empty() {
        return Err("не найден WinBox — укажите путь в ⚙ Настройки".into());
    }
    let p = crate::editor::expand(s);
    if p.is_dir() {
        for name in ["winbox64.exe", "winbox.exe", "WinBox.exe", "WinBox64.exe", "WinBox", "winbox"] {
            if p.join(name).is_file() {
                return Ok(p.join(name));
            }
        }
        return Err(format!("в папке {} нет WinBox — укажите сам файл winbox64.exe", p.display()));
    }
    if !p.is_file() {
        return Err(format!("WinBox не найден по пути {} — проверьте путь в ⚙ Настройки", p.display()));
    }
    Ok(p)
}

#[derive(Serialize)]
pub struct SshSpec {
    program: String,
    args: Vec<String>,
    password_copied: bool,
}

/// Returns what to run in a terminal tab; the password (if known) goes to the clipboard for 30 s.
#[tauri::command]
pub fn mt_ssh(app: AppHandle, kp: State<KeepassState>, id: String) -> Result<SshSpec, String> {
    let d = find(&id)?;
    let (user, pass) = credentials(&kp, &d)?;
    let target = if user.is_empty() { d.host.clone() } else { format!("{user}@{}", d.host) };
    let copied = !pass.is_empty();
    if copied {
        keepass::copy_secret(&app, pass)?;
    }
    Ok(SshSpec {
        program: "ssh".into(),
        args: vec!["-p".into(), d.ssh_port.to_string(), target],
        password_copied: copied,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn winbox_path_forgiving() {
        let dir = std::env::temp_dir().join(format!("opsdeck-winbox-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("winbox64.exe");
        std::fs::write(&exe, b"").unwrap();
        let quoted = format!("  \"{}\"  ", exe.display());
        assert_eq!(winbox_bin(&quoted).unwrap(), exe, "quotes from Copy as path");
        assert_eq!(winbox_bin(&dir.to_string_lossy()).unwrap(), exe, "a folder is enough");
        assert!(winbox_bin("").unwrap_err().contains("укажите путь"));
        assert!(winbox_bin(&dir.join("nope.exe").to_string_lossy()).unwrap_err().contains("не найден по пути"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
