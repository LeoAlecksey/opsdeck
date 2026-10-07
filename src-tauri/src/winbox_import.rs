//! Import of saved routers from WinBox's address list (Addresses.cdb), so 40+ routers do not have
//! to be typed in by hand. The format is undocumented; this follows the layout reverse-engineered
//! for WinBox 4 (github.com/dko-strd/winbox4-cdb-editor):
//!   file   := 0D F0 1D C0 record*
//!   record := size:u32le body[size]
//!   body   := "M2" kind:4 field*      (kind 05 00 00 00 — a saved connection)
//!   string := fid:u24le 21 len:u8 data   (or 09 00 FE 21 len data — the session name)
//! Fields: 0 name, 1 address, 2 login, 3 password, 4 note, 8 group.
//! Passwords never go to the interface: the preview only says whether one is saved.

use crate::{mikrotik::Device, store};
use serde::Serialize;
use std::path::{Path, PathBuf};

const MAGIC: [u8; 4] = [0x0d, 0xf0, 0x1d, 0xc0];
const KIND_CONNECTION: [u8; 4] = [5, 0, 0, 0];

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Saved {
    pub name: String,
    pub address: String,
    pub login: String,
    pub password: String,
    pub note: String,
    pub group: String,
}

/// What the interface sees: no password.
#[derive(Serialize, Debug, PartialEq)]
pub struct Candidate {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub group: String,
    pub has_password: bool,
    /// already in OpsDeck (same address and port)
    pub exists: bool,
}

#[derive(Serialize)]
pub struct Preview {
    pub file: String,
    pub items: Vec<Candidate>,
}

/// String fields of one record body (after "M2" and the kind).
fn fields(body: &[u8]) -> Vec<(u32, String)> {
    let mut out = Vec::new();
    let mut i = 0;
    while i + 5 <= body.len() {
        let fid = if body[i + 3] == 0x21 && body[i + 1] == 0 && body[i + 2] == 0 {
            Some(body[i] as u32)
        } else if body[i..i + 4] == [0x09, 0x00, 0xfe, 0x21] {
            Some(0)
        } else {
            None
        };
        if let Some(fid) = fid {
            let len = body[i + 4] as usize;
            if let Some(data) = body.get(i + 5..i + 5 + len) {
                out.push((fid, String::from_utf8_lossy(data).into_owned()));
                i += 5 + len;
                continue;
            }
        }
        i += 1;
    }
    out
}

pub fn parse_cdb(bytes: &[u8]) -> Result<Vec<Saved>, String> {
    if bytes.len() < 4 || bytes[..4] != MAGIC {
        return Err("это не список адресов WinBox (Addresses.cdb) или он защищён мастер-паролем — снимите пароль в WinBox и повторите".into());
    }
    let mut out = Vec::new();
    let mut i = 4;
    while i + 4 <= bytes.len() {
        let size = u32::from_le_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]) as usize;
        i += 4;
        let Some(body) = bytes.get(i..i + size) else { break };
        i += size;
        if body.len() < 6 || &body[..2] != b"M2" || body[2..6] != KIND_CONNECTION {
            continue;
        }
        let mut s = Saved::default();
        for (fid, v) in fields(&body[6..]) {
            match fid {
                0 => s.name = v,
                1 => s.address = v,
                2 => s.login = v,
                3 => s.password = v,
                4 => s.note = v,
                8 => s.group = v,
                _ => {}
            }
        }
        if !s.address.trim().is_empty() {
            out.push(s);
        }
    }
    Ok(out)
}

/// "10.0.0.1:8292" → ("10.0.0.1", 8292); MAC and IPv6 addresses keep their colons.
pub fn split_port(addr: &str) -> (String, u16) {
    let a = addr.trim();
    if let Some(v6) = a.strip_prefix('[') {
        if let Some((h, rest)) = v6.split_once(']') {
            let port = rest.strip_prefix(':').and_then(|p| p.parse().ok()).unwrap_or(8291);
            return (h.to_string(), port);
        }
    }
    if a.matches(':').count() == 1 {
        if let Some((h, p)) = a.split_once(':') {
            if let Ok(port) = p.parse() {
                return (h.to_string(), port);
            }
        }
    }
    (a.to_string(), 8291)
}

/// Where WinBox keeps the list (WinBox 4 first, then WinBox 3).
fn candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    for base in [dirs::data_dir(), dirs::config_dir()].into_iter().flatten() {
        for dir in ["MikroTik/WinBox", "Mikrotik/Winbox", "MikroTik/Winbox"] {
            out.push(base.join(dir).join("Addresses.cdb"));
        }
    }
    // WinBox 3 under Wine
    if let Some(h) = dirs::home_dir() {
        out.push(h.join(".wine/drive_c/users").join(whoami()).join("AppData/Roaming/Mikrotik/Winbox/Addresses.cdb"));
    }
    out
}

fn whoami() -> String {
    std::env::var("USER").or_else(|_| std::env::var("USERNAME")).unwrap_or_default()
}

fn resolve(path: Option<String>) -> Result<PathBuf, String> {
    match path.map(|p| p.trim().trim_matches(|c| c == '"' || c == '\'').to_string()).filter(|p| !p.is_empty()) {
        Some(p) => {
            let p = crate::editor::expand(&p);
            let p = if p.is_dir() { p.join("Addresses.cdb") } else { p };
            p.is_file().then_some(p.clone()).ok_or_else(|| format!("файл не найден: {}", p.display()))
        }
        None => candidates().into_iter().find(|p| p.is_file()).ok_or_else(|| "список адресов WinBox не найден — укажите файл Addresses.cdb".into()),
    }
}

fn read(path: &Path) -> Result<Vec<Saved>, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    parse_cdb(&bytes)
}

fn display_name(s: &Saved, host: &str) -> String {
    [&s.name, &s.note].into_iter().map(|x| x.trim()).find(|x| !x.is_empty()).unwrap_or(host).to_string()
}

fn preview(items: &[Saved], existing: &[Device]) -> Vec<Candidate> {
    items
        .iter()
        .map(|s| {
            let (host, port) = split_port(&s.address);
            Candidate {
                name: display_name(s, &host),
                exists: existing.iter().any(|d| d.host.eq_ignore_ascii_case(&host) && d.winbox_port == port),
                host,
                port,
                username: s.login.clone(),
                group: s.group.clone(),
                has_password: !s.password.is_empty(),
            }
        })
        .collect()
}

#[tauri::command]
pub fn mt_import_scan(path: Option<String>) -> Result<Preview, String> {
    let file = resolve(path)?;
    let items = read(&file)?;
    if items.is_empty() {
        return Err(format!("в {} нет сохранённых роутеров", file.display()));
    }
    Ok(Preview { file: file.to_string_lossy().into_owned(), items: preview(&items, &crate::mikrotik::list()?) })
}

#[tauri::command]
pub async fn mt_import_pick(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("Список адресов WinBox (Addresses.cdb)")
            .add_filter("WinBox", &["cdb"])
            .blocking_pick_file()
            .and_then(|f| f.into_path().ok())
            .map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .ok()
    .flatten()
}

/// New devices for the chosen routers ("host:port"), skipping invalid and already added
/// addresses; with each one the password to keep, if asked for.
fn merge(items: Vec<Saved>, existing: &[Device], chosen: &[String], passwords: bool) -> Vec<(Device, Option<String>)> {
    let mut out: Vec<(Device, Option<String>)> = Vec::new();
    for s in items {
        let (host, port) = split_port(&s.address);
        if !chosen.contains(&format!("{host}:{port}")) || !crate::tools::valid_host(&host) {
            continue;
        }
        let same = |d: &Device| d.host.eq_ignore_ascii_case(&host) && d.winbox_port == port;
        if existing.iter().any(same) || out.iter().any(|(d, _)| same(d)) {
            continue;
        }
        let secret = (passwords && !s.password.is_empty()).then(|| s.password.clone());
        out.push((
            Device {
                id: uuid::Uuid::new_v4().to_string(),
                name: display_name(&s, &host),
                group: s.group.trim().to_string(),
                username: s.login.clone(),
                auth: if secret.is_some() { "password" } else { "none" }.into(),
                keepass_entry: String::new(),
                winbox_port: port,
                ssh_port: 22,
                host,
            },
            secret,
        ));
    }
    out
}

/// Adds the chosen routers (by "host:port"); passwords go to the OS keyring when asked.
#[tauri::command]
pub fn mt_import(path: String, chosen: Vec<String>, passwords: bool) -> Result<usize, String> {
    let items = read(&resolve(Some(path))?)?;
    let mut list = crate::mikrotik::list()?;
    let new = merge(items, &list, &chosen, passwords);
    let added = new.len();
    for (d, secret) in new {
        if let Some(p) = secret {
            store::secret_set(&crate::mikrotik::secret_key(&d.id), &p)?;
        }
        list.push(d);
    }
    crate::mikrotik::save_all(&list)?;
    Ok(added)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(fid: u8, v: &str) -> Vec<u8> {
        let mut b = vec![fid, 0, 0, 0x21, v.len() as u8];
        b.extend_from_slice(v.as_bytes());
        b
    }
    fn record(kind: [u8; 4], parts: &[Vec<u8>]) -> Vec<u8> {
        let mut body = b"M2".to_vec();
        body.extend_from_slice(&kind);
        for p in parts {
            body.extend_from_slice(p);
        }
        let mut r = (body.len() as u32).to_le_bytes().to_vec();
        r.extend(body);
        r
    }
    /// A file like WinBox 4 writes: two routers, a sub-entry and a bool field in between.
    fn sample() -> Vec<u8> {
        let mut f = MAGIC.to_vec();
        let mut name = vec![0x09, 0x00, 0xfe, 0x21, 4];
        name.extend_from_slice(b"core");
        f.extend(record(KIND_CONNECTION, &[name, s(1, "192.0.2.1"), s(2, "admin"), s(3, "secret"), vec![6, 0, 0, 0x01], s(4, "Ядро"), s(8, "Офис")]));
        f.extend(record([7, 0, 0, 1], &[s(1, "ip services")]));
        f.extend(record(KIND_CONNECTION, &[s(1, "198.51.100.7:8292"), s(2, "noc"), s(4, "Склад")]));
        f.extend(record(KIND_CONNECTION, &[s(1, "E4:8D:8C:00:11:22")]));
        f
    }

    #[test]
    fn parses_saved_routers() {
        let list = parse_cdb(&sample()).unwrap();
        assert_eq!(list.len(), 3);
        assert_eq!(list[0], Saved { name: "core".into(), address: "192.0.2.1".into(), login: "admin".into(), password: "secret".into(), note: "Ядро".into(), group: "Офис".into() });
        assert_eq!(list[1].address, "198.51.100.7:8292");
        assert_eq!(list[1].password, "");
        assert!(parse_cdb(b"\x01\x02\x03\x04junk").unwrap_err().contains("мастер-паролем"));
        // a cut file does not panic
        let full = sample();
        for n in 0..full.len() {
            let _ = parse_cdb(&full[..n]);
        }
    }

    #[test]
    fn ports_and_names() {
        assert_eq!(split_port("10.0.0.1:8292"), ("10.0.0.1".into(), 8292));
        assert_eq!(split_port("router.lan"), ("router.lan".into(), 8291));
        assert_eq!(split_port("E4:8D:8C:00:11:22"), ("E4:8D:8C:00:11:22".into(), 8291));
        assert_eq!(split_port("[2001:db8::1]:8299"), ("2001:db8::1".into(), 8299));
        assert_eq!(split_port("2001:db8::1"), ("2001:db8::1".into(), 8291));
        let list = parse_cdb(&sample()).unwrap();
        let p = preview(&list, &[]);
        assert_eq!(p[0].name, "core");
        assert_eq!(p[1].name, "Склад", "the note when there is no session name");
        assert_eq!(p[2].name, "E4:8D:8C:00:11:22");
        assert!(p[0].has_password && !p[1].has_password);
        let existing = Device { id: "x".into(), name: "x".into(), host: "198.51.100.7".into(), group: String::new(), username: String::new(), auth: "none".into(), keepass_entry: String::new(), winbox_port: 8292, ssh_port: 22 };
        assert!(preview(&list, &[existing])[1].exists);
    }

    #[test]
    fn merge_chosen() {
        let mut items = parse_cdb(&sample()).unwrap();
        items.push(items[0].clone()); // the same router twice in WinBox
        items.push(Saved { address: "bad host!".into(), ..Default::default() });
        let chosen: Vec<String> = ["192.0.2.1:8291", "198.51.100.7:8292", "bad host!:8291"].map(String::from).to_vec();
        let new = merge(items.clone(), &[], &chosen, true);
        assert_eq!(new.len(), 2);
        let (core, pass) = &new[0];
        assert_eq!((core.name.as_str(), core.host.as_str(), core.group.as_str(), core.username.as_str(), core.auth.as_str()), ("core", "192.0.2.1", "Офис", "admin", "password"));
        assert_eq!(pass.as_deref(), Some("secret"));
        assert_eq!((new[1].0.winbox_port, new[1].0.auth.as_str()), (8292, "none"), "no saved password");
        assert!(store::valid_id(&core.id));
        // passwords left behind
        assert!(merge(items.clone(), &[], &chosen, false).iter().all(|(d, p)| p.is_none() && d.auth == "none"));
        // already in OpsDeck
        assert_eq!(merge(items, &[new[0].0.clone()], &chosen, true).len(), 1);
    }
}
