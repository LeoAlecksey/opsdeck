//! Moving OpsDeck to another computer: an archive of the chosen parts — settings and interface,
//! SSH hosts, panels and alert sources, databases, MikroTik, snippets, kubeconfigs, the notes folder.
//! Passwords are never in it: they live in the OS keyring (enter them again after the import).
//! Files are compressed by several threads into partial archives that are merged without
//! recompressing — a notes folder with thousands of files goes fast.

use crate::{settings, store};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Cursor, Read, Seek, Write},
    path::{Component, Path, PathBuf},
};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

const MANIFEST: &str = "opsdeck-export.json";
const UI: &str = "ui.json";

/// A part the user can tick: its config files (relative to the config dir) or the notes folder.
struct PartDef {
    id: &'static str,
    label: &'static str,
    files: &'static [&'static str],
    dirs: &'static [&'static str],
    /// on by default in the dialog
    default: bool,
    /// what the user should know before taking it
    warn: &'static str,
}

const PARTS: &[PartDef] = &[
    PartDef { id: "settings", label: "Настройки и интерфейс", files: &["settings.json", "ai.json", "alerts-config.json", "k8s.json", "vaults.json"], dirs: &[], default: true, warn: "" },
    PartDef { id: "ssh", label: "SSH-хосты и группы", files: &["ssh.json", "ssh_groups.json"], dirs: &[], default: true, warn: "" },
    PartDef { id: "connectors", label: "Веб-панели и источники алертов", files: &["connectors.json"], dirs: &[], default: true, warn: "" },
    PartDef { id: "databases", label: "Базы данных", files: &["databases.json"], dirs: &[], default: true, warn: "" },
    PartDef { id: "mikrotik", label: "MikroTik", files: &["mikrotik.json"], dirs: &[], default: true, warn: "" },
    PartDef { id: "snippets", label: "Сниппеты", files: &["snippets.json"], dirs: &[], default: true, warn: "" },
    PartDef { id: "kubeconfigs", label: "Kubernetes-кластеры (kubeconfig)", files: &[], dirs: &["kubeconfigs"], default: false, warn: "В kubeconfig лежат ключи и токены доступа к кластерам — храните архив как пароль" },
    PartDef { id: "notes", label: "Заметки (папка целиком)", files: &[], dirs: &[], default: true, warn: "" },
];

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Part {
    pub id: String,
    pub label: String,
    pub files: usize,
    pub bytes: u64,
    pub default: bool,
    pub warn: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct Manifest {
    pub app_version: String,
    pub created: String,
    pub os: String,
    pub parts: Vec<Part>,
    /// where the notes were on the old computer (for the import dialog)
    pub notes_root: String,
}

/// Folders inside a notes vault that are not notes.
fn skip_note_dir(name: &str) -> bool {
    matches!(name, ".git" | ".trash" | "node_modules" | ".DS_Store")
}

fn walk(root: &Path, dir: &Path, skip: &dyn Fn(&str) -> bool, out: &mut Vec<(String, PathBuf)>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_symlink() || skip(&name) {
            continue;
        }
        let p = e.path();
        if ft.is_dir() {
            walk(root, &p, skip, out);
        } else if ft.is_file() {
            if let Ok(rel) = p.strip_prefix(root) {
                // archive names always with "/"
                let rel = rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/");
                out.push((rel, p));
            }
        }
    }
}

/// (name in the archive, file on disk) for a part.
fn files_of(part: &PartDef, config: &Path, notes: Option<&Path>) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    for f in part.files {
        let p = config.join(f);
        if p.is_file() {
            out.push((format!("config/{f}"), p));
        }
    }
    for d in part.dirs {
        let mut found = Vec::new();
        walk(&config.join(d), &config.join(d), &|_| false, &mut found);
        out.extend(found.into_iter().map(|(rel, p)| (format!("config/{d}/{rel}"), p)));
    }
    if part.id == "notes" {
        if let Some(root) = notes.filter(|r| r.is_dir()) {
            let mut found = Vec::new();
            walk(root, root, &skip_note_dir, &mut found);
            out.extend(found.into_iter().map(|(rel, p)| (format!("notes/{rel}"), p)));
        }
    }
    out
}

fn notes_root() -> Option<PathBuf> {
    let v = settings::load().obsidian_vault;
    (!v.trim().is_empty()).then(|| crate::editor::expand(v.trim()))
}

fn part_info(def: &PartDef, files: &[(String, PathBuf)]) -> Part {
    Part {
        id: def.id.into(),
        label: def.label.into(),
        files: files.len(),
        bytes: files.iter().filter_map(|(_, p)| fs::metadata(p).ok()).map(|m| m.len()).sum(),
        default: def.default,
        warn: def.warn.into(),
    }
}

/// What can be exported from this computer, with sizes.
#[tauri::command]
pub async fn transfer_parts() -> Result<Vec<Part>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let config = store::config_dir()?;
        let notes = notes_root();
        Ok(PARTS.iter().map(|d| part_info(d, &files_of(d, &config, notes.as_deref()))).collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Compresses `files` into one archive with `threads` workers; returns the archive bytes count.
pub fn write_archive<W: Write + Seek>(out: W, head: &[(&str, Vec<u8>)], files: &[(String, PathBuf)], threads: usize) -> Result<W, String> {
    let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated).large_file(false);
    // balance by size: the biggest files first, each to the lightest worker
    let mut order: Vec<&(String, PathBuf)> = files.iter().collect();
    order.sort_by_key(|(_, p)| std::cmp::Reverse(fs::metadata(p).map(|m| m.len()).unwrap_or(0)));
    let n = threads.clamp(1, 32).min(order.len().max(1));
    let mut buckets: Vec<(u64, Vec<&(String, PathBuf)>)> = (0..n).map(|_| (0, Vec::new())).collect();
    for f in order {
        let size = fs::metadata(&f.1).map(|m| m.len()).unwrap_or(0);
        let b = buckets.iter_mut().min_by_key(|(s, _)| *s).unwrap();
        b.0 += size;
        b.1.push(f);
    }
    let parts: Vec<Result<Vec<u8>, String>> = std::thread::scope(|s| {
        let handles: Vec<_> = buckets
            .iter()
            .map(|(_, list)| {
                s.spawn(move || -> Result<Vec<u8>, String> {
                    let mut z = ZipWriter::new(Cursor::new(Vec::new()));
                    for (name, path) in list {
                        let mut data = Vec::new();
                        fs::File::open(path).and_then(|mut f| f.read_to_end(&mut data)).map_err(|e| format!("{}: {e}", path.display()))?;
                        z.start_file(name.as_str(), opts).map_err(|e| e.to_string())?;
                        z.write_all(&data).map_err(|e| e.to_string())?;
                    }
                    Ok(z.finish().map_err(|e| e.to_string())?.into_inner())
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap_or_else(|_| Err("поток упаковки упал".into()))).collect()
    });
    let mut z = ZipWriter::new(out);
    for (name, data) in head {
        z.start_file(*name, opts).map_err(|e| e.to_string())?;
        z.write_all(data).map_err(|e| e.to_string())?;
    }
    for p in parts {
        let archive = ZipArchive::new(Cursor::new(p?)).map_err(|e| e.to_string())?;
        // already compressed: copied as is
        z.merge_archive(archive).map_err(|e| e.to_string())?;
    }
    z.finish().map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct Exported {
    pub file: String,
    pub files: usize,
    pub bytes: u64,
}

/// Writes the archive of the chosen parts. `ui`: the interface settings of the window (localStorage).
#[tauri::command]
pub async fn transfer_export(app: tauri::AppHandle, parts: Vec<String>, ui: String, dest: Option<String>) -> Result<Option<Exported>, String> {
    let dest = match dest {
        Some(d) => PathBuf::from(d),
        None => {
            use tauri_plugin_dialog::DialogExt;
            let name = format!("opsdeck-{}.zip", chrono::Local::now().format("%Y-%m-%d"));
            let picked = tauri::async_runtime::spawn_blocking(move || {
                app.dialog().file().set_title("Сохранить настройки OpsDeck").set_file_name(&name).add_filter("ZIP", &["zip"]).blocking_save_file()
            })
            .await
            .map_err(|e| e.to_string())?;
            match picked.and_then(|f| f.into_path().ok()) {
                Some(p) => p,
                None => return Ok(None),
            }
        }
    };
    let version = env!("CARGO_PKG_VERSION").to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let config = store::config_dir()?;
        let notes = notes_root();
        let mut all = Vec::new();
        let mut infos = Vec::new();
        for d in PARTS.iter().filter(|d| parts.iter().any(|p| p == d.id)) {
            let files = files_of(d, &config, notes.as_deref());
            infos.push(part_info(d, &files));
            all.extend(files);
        }
        let manifest = Manifest {
            app_version: version,
            created: chrono::Local::now().to_rfc3339(),
            os: std::env::consts::OS.into(),
            parts: infos,
            notes_root: notes.map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
        };
        let mut head = vec![(MANIFEST, serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?)];
        if parts.iter().any(|p| p == "settings") {
            head.push((UI, ui.into_bytes()));
        }
        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
        let tmp = dest.with_extension("zip.part");
        let file = fs::File::create(&tmp).map_err(|e| format!("{}: {e}", tmp.display()))?;
        write_archive(file, &head, &all, threads)?;
        fs::rename(&tmp, &dest).map_err(|e| format!("{}: {e}", dest.display()))?;
        let bytes = fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
        Ok(Some(Exported { file: dest.to_string_lossy().into_owned(), files: all.len(), bytes }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn transfer_pick(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog().file().set_title("Архив настроек OpsDeck").add_filter("ZIP", &["zip"]).blocking_pick_file().and_then(|f| f.into_path().ok()).map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .ok()
    .flatten()
}

fn open(path: &Path) -> Result<ZipArchive<fs::File>, String> {
    let f = fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    ZipArchive::new(f).map_err(|_| "это не архив настроек OpsDeck".to_string())
}

fn read_manifest<R: Read + Seek>(z: &mut ZipArchive<R>) -> Result<Manifest, String> {
    let mut text = String::new();
    z.by_name(MANIFEST).map_err(|_| "это не архив настроек OpsDeck".to_string())?.read_to_string(&mut text).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| format!("архив повреждён: {e}"))
}

#[derive(Serialize)]
pub struct Inspected {
    pub manifest: Manifest,
    /// the current notes folder here: where imported notes go by default
    pub notes_here: String,
}

#[tauri::command]
pub async fn transfer_inspect(path: String) -> Result<Inspected, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut z = open(Path::new(&path))?;
        Ok(Inspected { manifest: read_manifest(&mut z)?, notes_here: notes_root().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default() })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A safe relative path inside the target folder (no "..", no absolute paths: zip slip).
fn safe_rel(name: &str) -> Option<PathBuf> {
    let p = Path::new(name);
    p.components().all(|c| matches!(c, Component::Normal(_))).then(|| p.to_path_buf())
}

#[derive(Serialize, Debug)]
pub struct Imported {
    pub files: usize,
    /// where the replaced files were saved
    pub backup: String,
    /// interface settings to put into the window's localStorage
    pub ui: Option<String>,
}

/// Restores the chosen parts. Files that get replaced are copied to config/backup-<time>/ first.
/// `notes_dest`: folder for the notes (it becomes the notes folder in Settings).
pub fn import_into(archive: &Path, parts: &[String], config: &Path, notes_dest: Option<&Path>) -> Result<Imported, String> {
    let mut z = open(archive)?;
    let manifest = read_manifest(&mut z)?;
    let want = |id: &str| parts.iter().any(|p| p == id) && manifest.parts.iter().any(|p| p.id == id);
    let backup = config.join(format!("backup-{}", chrono::Local::now().format("%Y%m%d-%H%M%S")));
    let mut count = 0;
    let mut ui = None;
    for i in 0..z.len() {
        let mut f = z.by_index(i).map_err(|e| e.to_string())?;
        if f.is_dir() {
            continue;
        }
        let name = f.name().to_string();
        let target = if name == UI {
            if want("settings") {
                let mut s = String::new();
                f.read_to_string(&mut s).map_err(|e| e.to_string())?;
                ui = Some(s);
            }
            continue;
        } else if let Some(rel) = name.strip_prefix("config/") {
            let part = PARTS.iter().find(|d| d.files.contains(&rel) || d.dirs.iter().any(|dir| rel.starts_with(&format!("{dir}/"))));
            match (part, safe_rel(rel)) {
                (Some(d), Some(rel)) if want(d.id) => (config.join(&rel), backup.join("config").join(rel)),
                _ => continue,
            }
        } else if let Some(rel) = name.strip_prefix("notes/") {
            match (notes_dest, safe_rel(rel)) {
                (Some(dest), Some(rel)) if want("notes") => (dest.join(&rel), backup.join("notes").join(rel)),
                _ => continue,
            }
        } else {
            continue;
        };
        let (path, saved) = target;
        if path.is_file() {
            fs::create_dir_all(saved.parent().unwrap()).map_err(|e| e.to_string())?;
            fs::copy(&path, &saved).map_err(|e| format!("{}: {e}", path.display()))?;
        }
        fs::create_dir_all(path.parent().unwrap()).map_err(|e| format!("{}: {e}", path.display()))?;
        let mut data = Vec::new();
        f.read_to_end(&mut data).map_err(|e| e.to_string())?;
        fs::write(&path, data).map_err(|e| format!("{}: {e}", path.display()))?;
        if name.starts_with("config/kubeconfigs/") {
            let _ = store::restrict(&path, 0o600);
        }
        count += 1;
    }
    Ok(Imported { files: count, backup: if backup.exists() { backup.to_string_lossy().into_owned() } else { String::new() }, ui })
}

#[tauri::command]
pub async fn transfer_import(path: String, parts: Vec<String>, notes_dest: Option<String>) -> Result<Imported, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = store::config_dir()?;
        let dest = notes_dest.filter(|d| !d.trim().is_empty()).map(|d| crate::editor::expand(d.trim()));
        let r = import_into(Path::new(&path), &parts, &config, dest.as_deref())?;
        // the notes are where they were put now, not where they were on the old computer
        if let (Some(d), true) = (&dest, parts.iter().any(|p| p == "notes")) {
            let mut s = settings::load();
            s.obsidian_vault = d.to_string_lossy().into_owned();
            store::save_json("settings.json", &s)?;
        }
        Ok(r)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn app_restart(app: tauri::AppHandle) {
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("opsdeck-transfer-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn export_and_import_round_trip() {
        let src = tmp("src");
        let config = src.join("config");
        let notes = src.join("notes");
        fs::create_dir_all(config.join("kubeconfigs")).unwrap();
        fs::write(config.join("ssh.json"), r#"[{"id":"h1"}]"#).unwrap();
        fs::write(config.join("settings.json"), "{}").unwrap();
        fs::write(config.join("kubeconfigs/prod.yaml"), "token: secret").unwrap();
        for i in 0..300 {
            let d = notes.join(format!("dir{}", i % 7));
            fs::create_dir_all(&d).unwrap();
            fs::write(d.join(format!("note{i}.md")), format!("# {i}\n").repeat(i % 50 + 1)).unwrap();
        }
        fs::create_dir_all(notes.join(".git")).unwrap();
        fs::write(notes.join(".git/HEAD"), "ref").unwrap();

        let chosen = ["settings", "ssh", "notes"];
        let mut files = Vec::new();
        let mut infos = Vec::new();
        for d in PARTS.iter().filter(|d| chosen.contains(&d.id)) {
            let f = files_of(d, &config, Some(&notes));
            infos.push(part_info(d, &f));
            files.extend(f);
        }
        assert_eq!(files.len(), 2 + 300, ".git is not a note; kubeconfigs not chosen");
        let manifest = Manifest { app_version: "t".into(), created: "now".into(), os: "linux".into(), parts: infos, notes_root: notes.to_string_lossy().into() };
        let archive = src.join("out.zip");
        write_archive(fs::File::create(&archive).unwrap(), &[(MANIFEST, serde_json::to_vec(&manifest).unwrap()), (UI, b"{\"opsdeck.lang\":\"ru\"}".to_vec())], &files, 4).unwrap();

        let dst = tmp("dst");
        let config2 = dst.join("config");
        fs::create_dir_all(&config2).unwrap();
        fs::write(config2.join("ssh.json"), "old").unwrap();
        let r = import_into(&archive, &["ssh".into(), "notes".into(), "settings".into(), "kubeconfigs".into()], &config2, Some(&dst.join("vault"))).unwrap();
        assert_eq!(r.files, 302);
        assert_eq!(fs::read_to_string(config2.join("ssh.json")).unwrap(), r#"[{"id":"h1"}]"#);
        assert_eq!(fs::read_to_string(Path::new(&r.backup).join("config/ssh.json")).unwrap(), "old", "the replaced file is kept");
        assert_eq!(fs::read_to_string(dst.join("vault/dir3/note10.md")).unwrap(), "# 10\n".repeat(11));
        assert!(!config2.join("kubeconfigs").exists(), "not in the archive");
        assert_eq!(r.ui.as_deref(), Some("{\"opsdeck.lang\":\"ru\"}"));
        // only what was ticked
        let r = import_into(&archive, &["ssh".into()], &config2, Some(&dst.join("vault2"))).unwrap();
        assert_eq!((r.files, r.ui), (1, None));
        assert!(!dst.join("vault2").exists());
        let _ = fs::remove_dir_all(&src);
        let _ = fs::remove_dir_all(&dst);
    }

    #[test]
    fn zip_slip_is_refused() {
        assert!(safe_rel("../../.bashrc").is_none());
        assert!(safe_rel("/etc/passwd").is_none());
        assert_eq!(safe_rel("dir/note.md"), Some(PathBuf::from("dir/note.md")));
        // a crafted archive: the bad entry is skipped, the good one lands inside
        let dir = tmp("slip");
        let archive = dir.join("bad.zip");
        let manifest = Manifest { app_version: "t".into(), created: "".into(), os: "".into(), parts: vec![Part { id: "notes".into(), label: "".into(), files: 2, bytes: 0, default: true, warn: "".into() }], notes_root: "".into() };
        let mut z = ZipWriter::new(fs::File::create(&archive).unwrap());
        let o = SimpleFileOptions::default();
        z.start_file(MANIFEST, o).unwrap();
        z.write_all(&serde_json::to_vec(&manifest).unwrap()).unwrap();
        z.start_file("notes/../../escaped.txt", o).unwrap();
        z.write_all(b"x").unwrap();
        z.start_file("notes/ok.md", o).unwrap();
        z.write_all(b"ok").unwrap();
        z.finish().unwrap();
        let r = import_into(&archive, &["notes".into()], &dir.join("config"), Some(&dir.join("vault"))).unwrap();
        assert_eq!(r.files, 1);
        assert!(!dir.join("escaped.txt").exists() && !std::env::temp_dir().join("escaped.txt").exists());
        assert!(dir.join("vault/ok.md").is_file());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn not_an_export() {
        let dir = tmp("junk");
        let p = dir.join("x.zip");
        fs::write(&p, b"not a zip").unwrap();
        assert!(import_into(&p, &[], &dir, None).unwrap_err().contains("не архив"));
        let _ = fs::remove_dir_all(&dir);
    }
}
