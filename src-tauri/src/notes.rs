//! Notes vaults (an Obsidian vault or any folder of .md): several vaults, create/open/switch;
//! list / search / read / write notes, tags; open a note in Obsidian.
//! All note paths are relative to the active vault and must stay inside it.

use crate::{settings, store, store::err};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::{
    fs,
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};
use tauri::Url;

pub(crate) async fn vault() -> Result<PathBuf, String> {
    let v = settings::current().await.obsidian_vault;
    if v.trim().is_empty() {
        return Err("не задана папка с заметками — укажите путь в настройках".into());
    }
    let p = crate::editor::expand(&v);
    if !p.exists() {
        return Err(format!("папка с заметками не найдена: «{}»", v.trim()));
    }
    if !p.is_dir() {
        return Err(format!("путь к заметкам указывает на файл, а не папку: «{}»", v.trim()));
    }
    p.canonicalize().map(crate::store::clean_path_buf).map_err(err)
}

/// Relative, no `..`, stays inside the vault even through symlinks.
pub(crate) fn resolve(vault: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel_path = Path::new(rel);
    if rel.is_empty() || !rel_path.components().all(|c| matches!(c, Component::Normal(_))) {
        return Err("недопустимый путь".into());
    }
    let full = vault.join(rel_path);
    // canonicalize the deepest existing ancestor to catch symlinks pointing outside
    let mut probe = full.clone();
    while !probe.exists() {
        probe = probe.parent().ok_or("недопустимый путь")?.to_path_buf();
    }
    if !probe.canonicalize().map_err(err)?.starts_with(vault) {
        return Err("путь вне vault".into());
    }
    Ok(full)
}

fn is_md(p: &Path) -> bool {
    p.extension().is_some_and(|e| e.eq_ignore_ascii_case("md"))
}

pub(crate) fn walk(root: &Path, dir: &Path, out: &mut Vec<PathBuf>) {
    walk_all(root, dir, out, &mut Vec::new());
}

/// Notes and (non-hidden) folders, relative to `root`; folders are listed so empty ones show in the tree.
fn walk_all(root: &Path, dir: &Path, out: &mut Vec<PathBuf>, dirs: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let name = e.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue; // .obsidian, .trash, .git
        }
        let p = e.path();
        match e.file_type() {
            Ok(t) if t.is_dir() => {
                dirs.push(p.strip_prefix(root).unwrap_or(&p).to_path_buf());
                walk_all(root, &p, out, dirs)
            }
            Ok(t) if t.is_file() && is_md(&p) => out.push(p.strip_prefix(root).unwrap_or(&p).to_path_buf()),
            _ => {}
        }
    }
}

#[derive(Serialize)]
pub struct NoteInfo {
    path: String,
    mtime: u64,
}

#[derive(Serialize)]
pub struct VaultInfo {
    root: String,
    name: String,
    notes: Vec<NoteInfo>,
    folders: Vec<String>,
}

#[tauri::command]
pub async fn notes_list() -> Result<VaultInfo, String> {
    let root = vault().await?;
    tauri::async_runtime::spawn_blocking(move || {
        let (mut files, mut dirs) = (Vec::new(), Vec::new());
        walk_all(&root, &root, &mut files, &mut dirs);
        let notes = files
            .into_iter()
            .map(|rel| {
                let mtime = fs::metadata(root.join(&rel))
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map_or(0, |d| d.as_secs());
                NoteInfo { path: rel.to_string_lossy().replace('\\', "/"), mtime }
            })
            .collect();
        VaultInfo {
            name: root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            root: root.to_string_lossy().into_owned(),
            notes,
            folders: dirs.into_iter().map(|d| d.to_string_lossy().replace('\\', "/")).collect(),
        }
    })
    .await
    .map_err(err)
}

#[tauri::command]
pub async fn note_read(path: String) -> Result<String, String> {
    let full = resolve(&vault().await?, &path)?;
    fs::read_to_string(full).map_err(err)
}

#[tauri::command]
pub async fn note_write(path: String, content: String) -> Result<(), String> {
    let full = resolve(&vault().await?, &path)?;
    if !is_md(&full) {
        return Err("можно сохранять только .md".into());
    }
    if let Some(dir) = full.parent() {
        fs::create_dir_all(dir).map_err(err)?;
    }
    fs::write(full, content).map_err(err)
}

/// Move/rename a note or a whole folder inside the vault. Never overwrites.
#[tauri::command]
pub async fn note_move(from: String, to: String) -> Result<(), String> {
    let root = vault().await?;
    let src = resolve(&root, &from)?;
    let dst = resolve(&root, &to)?;
    if !src.exists() {
        return Err(format!("«{from}» не найден"));
    }
    if dst.exists() {
        return Err(format!("«{to}» уже существует"));
    }
    if src.is_dir() {
        if dst.starts_with(&src) {
            return Err("нельзя переместить папку внутрь неё самой".into());
        }
    } else if !is_md(&src) || !is_md(&dst) {
        return Err("перемещать можно только .md и папки".into());
    }
    if let Some(dir) = dst.parent() {
        fs::create_dir_all(dir).map_err(err)?;
    }
    fs::rename(&src, &dst).map_err(err)
}

#[derive(Serialize)]
pub struct Hit {
    path: String,
    line: usize,
    text: String,
}

#[tauri::command]
pub async fn note_search(query: String) -> Result<Vec<Hit>, String> {
    let root = vault().await?;
    let q = query.trim().to_lowercase();
    if q.len() < 2 {
        return Ok(Vec::new());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut files = Vec::new();
        walk(&root, &root, &mut files);
        let mut hits = Vec::new();
        'files: for rel in files {
            let path = rel.to_string_lossy().into_owned();
            if path.to_lowercase().contains(&q) {
                hits.push(Hit { path: path.clone(), line: 0, text: String::new() });
            }
            let Ok(text) = fs::read_to_string(root.join(&rel)) else { continue };
            for (i, l) in text.lines().enumerate() {
                if l.to_lowercase().contains(&q) {
                    hits.push(Hit { path: path.clone(), line: i + 1, text: l.trim().chars().take(200).collect() });
                    if hits.len() >= 300 {
                        break 'files;
                    }
                }
            }
        }
        hits
    })
    .await
    .map_err(err)
}

/// Opens the note in the Obsidian app via its URI scheme.
#[tauri::command]
pub async fn note_open_obsidian(path: String) -> Result<(), String> {
    let root = vault().await?;
    resolve(&root, &path)?;
    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let file = path.strip_suffix(".md").unwrap_or(&path);
    let url = Url::parse_with_params("obsidian://open", &[("vault", name.as_str()), ("file", file)]).map_err(err)?;
    crate::store::open_with_system(url.as_str())
}

/// Today's daily note (Obsidian "Daily notes" plugin settings: folder + YYYY/MM/DD format).
/// Creates the file if it does not exist; returns its vault-relative path.
#[tauri::command]
pub async fn note_daily() -> Result<String, String> {
    let root = vault().await?;
    let cfg: serde_json::Value = fs::read_to_string(root.join(".obsidian/daily-notes.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let folder = cfg["folder"].as_str().unwrap_or("").trim_matches('/');
    let format = cfg["format"].as_str().filter(|f| !f.is_empty()).unwrap_or("YYYY-MM-DD");
    let now = chrono::Local::now();
    let name = format
        .replace("YYYY", &now.format("%Y").to_string())
        .replace("MM", &now.format("%m").to_string())
        .replace("DD", &now.format("%d").to_string());
    let rel = if folder.is_empty() { format!("{name}.md") } else { format!("{folder}/{name}.md") };
    let full = resolve(&root, &rel)?;
    if !full.exists() {
        if let Some(dir) = full.parent() {
            fs::create_dir_all(dir).map_err(err)?;
        }
        fs::write(&full, format!("# {name}\n\n")).map_err(err)?;
    }
    Ok(rel)
}

/// Delete a note or a folder: moved into the vault's `.trash` (like Obsidian), so it can be restored.
#[tauri::command]
pub async fn note_delete(path: String) -> Result<String, String> {
    let root = vault().await?;
    let src = resolve(&root, &path)?;
    if !src.exists() {
        return Err(format!("«{path}» не найден"));
    }
    if src.is_file() && !is_md(&src) {
        return Err("удалять можно только .md и папки".into());
    }
    let trash = root.join(".trash");
    fs::create_dir_all(&trash).map_err(err)?;
    let name = src.file_name().ok_or("недопустимый путь")?.to_string_lossy().into_owned();
    // never overwrite something already in the trash
    let mut dst = trash.join(&name);
    let mut n = 1;
    while dst.exists() {
        let p = Path::new(&name);
        let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        dst = trash.join(match p.extension() {
            Some(ext) if src.is_file() => format!("{stem} ({n}).{}", ext.to_string_lossy()),
            _ => format!("{name} ({n})"),
        });
        n += 1;
    }
    fs::rename(&src, &dst).map_err(err)?;
    Ok(dst.strip_prefix(&root).unwrap_or(&dst).to_string_lossy().into_owned())
}

// ---------- several vaults ----------

const VAULTS: &str = "vaults.json";

#[derive(Serialize, Deserialize, Clone)]
struct VaultRef {
    name: String,
    path: String,
}

#[derive(Serialize)]
pub struct VaultEntry {
    name: String,
    path: String,
    exists: bool,
    /// has a .obsidian folder (opens in Obsidian too)
    obsidian: bool,
    /// found on disk but never opened in OpsDeck
    found: bool,
}

#[derive(Serialize)]
pub struct Vaults {
    active: String,
    vaults: Vec<VaultEntry>,
}

fn known() -> Vec<VaultRef> {
    store::load_json(VAULTS).unwrap_or_default()
}

fn dir_name(p: &str) -> String {
    Path::new(p).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.to_string())
}

pub(crate) fn remember(path: &str, name: Option<&str>) -> Result<(), String> {
    let mut list = known();
    match list.iter_mut().find(|v| v.path == path) {
        Some(v) => {
            if let Some(n) = name {
                v.name = n.to_string();
            }
        }
        None => list.push(VaultRef { name: name.map(str::to_string).unwrap_or_else(|| dir_name(path)), path: path.to_string() }),
    }
    store::save_json(VAULTS, &list)
}

fn activate(path: &str) -> Result<(), String> {
    let mut s = settings::load();
    s.obsidian_vault = path.to_string();
    settings::settings_set(s)
}

#[tauri::command]
pub async fn vaults_list() -> Result<Vaults, String> {
    let active = settings::current().await.obsidian_vault;
    tauri::async_runtime::spawn_blocking(move || {
        let mut list = known();
        if !active.is_empty() && !list.iter().any(|v| v.path == active) {
            list.insert(0, VaultRef { name: dir_name(&active), path: active.clone() });
        }
        let mut out: Vec<VaultEntry> = list
            .into_iter()
            .map(|v| {
                let p = Path::new(&v.path);
                VaultEntry { exists: p.is_dir(), obsidian: p.join(".obsidian").is_dir(), found: false, name: v.name, path: v.path }
            })
            .collect();
        // Obsidian vaults found in $HOME that aren't in the list yet
        for d in settings::detect().obsidian {
            if !out.iter().any(|v| v.path == d) {
                out.push(VaultEntry { name: dir_name(&d), exists: true, obsidian: true, found: true, path: d });
            }
        }
        Ok(Vaults { active, vaults: out })
    })
    .await
    .map_err(err)?
}

/// Open an existing folder as a vault (an Obsidian vault or any folder with .md) and make it active.
#[tauri::command]
pub fn vault_open(path: String, name: Option<String>) -> Result<(), String> {
    let p = crate::editor::expand(&path);
    if !p.exists() {
        return Err(format!("папка «{}» не найдена", path.trim()));
    }
    if !p.is_dir() {
        return Err(format!("«{}» указывает на файл, а не папку", path.trim()));
    }
    let path = p.canonicalize().map(crate::store::clean_path_buf).map_err(err)?.to_string_lossy().into_owned();
    remember(&path, name.as_deref().filter(|n| !n.trim().is_empty()))?;
    activate(&path)
}

#[derive(Serialize)]
pub struct VaultCheck {
    pub ok: bool,
    pub exists: bool,
    pub is_dir: bool,
    pub is_obsidian: bool,
    pub md_count: usize,
    pub path: String,
    pub err: Option<String>,
}

#[tauri::command]
pub async fn vault_validate_path(path: String) -> Result<VaultCheck, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let raw = path.trim();
        if raw.is_empty() {
            return Ok(VaultCheck { ok: false, exists: false, is_dir: false, is_obsidian: false, md_count: 0, path: String::new(), err: Some("путь не указан".into()) });
        }
        let p = crate::editor::expand(raw);
        if !p.exists() {
            return Ok(VaultCheck { ok: false, exists: false, is_dir: false, is_obsidian: false, md_count: 0, path: p.to_string_lossy().into_owned(), err: Some(format!("папка не существует: {}", p.display())) });
        }
        if !p.is_dir() {
            return Ok(VaultCheck { ok: false, exists: true, is_dir: false, is_obsidian: false, md_count: 0, path: p.to_string_lossy().into_owned(), err: Some("указан файл, а не папка".into()) });
        }
        let canon = p.canonicalize().map(crate::store::clean_path_buf).unwrap_or_else(|_| p.clone());
        let is_obsidian = canon.join(".obsidian").is_dir();
        let mut md_count = 0;
        let mut stack = vec![canon.clone()];
        while let Some(dir) = stack.pop() {
            if let Ok(rd) = fs::read_dir(&dir) {
                for entry in rd.flatten() {
                    let ep = entry.path();
                    if entry.file_name().to_string_lossy().starts_with('.') { continue; }
                    if ep.is_dir() && stack.len() < 30 { stack.push(ep); }
                    else if ep.is_file() && is_md(&ep) { md_count += 1; }
                }
            }
        }
        Ok(VaultCheck { ok: true, exists: true, is_dir: true, is_obsidian, md_count, path: canon.to_string_lossy().into_owned(), err: None })
    })
    .await
    .map_err(err)?
}

/// New vault: `parent/name`, with a first note; becomes active.
#[tauri::command]
pub fn vault_create(parent: String, name: String) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.contains('/') || name.starts_with('.') {
        return Err("недопустимое имя хранилища".into());
    }
    let dir = crate::editor::expand(&parent).join(name);
    if dir.exists() && fs::read_dir(&dir).map_err(err)?.next().is_some() {
        return Err(format!("{} уже существует и не пустая — выберите «Открыть папку»", dir.display()));
    }
    fs::create_dir_all(&dir).map_err(err)?;
    fs::write(
        dir.join("Начало.md"),
        format!(
            "# {name}\n\nЭто новое хранилище заметок OpsDeck — обычная папка с .md, её можно открыть и в Obsidian.\n\n\
             ## Теги\nДобавляются кнопкой «＋ тег» над заметкой или прямо в тексте: #идея #infra\n\n\
             ## Задачи\nКнопка «＋ Задача» вставит строку вроде этой; все задачи из всех заметок — в разделе «Задачи».\n\n\
             - [ ] Разобраться с OpsDeck 📅 {}\n",
            chrono::Local::now().format("%Y-%m-%d")
        ),
    )
    .map_err(err)?;
    let path = dir.canonicalize().map(crate::store::clean_path_buf).map_err(err)?.to_string_lossy().into_owned();
    remember(&path, Some(name))?;
    activate(&path)?;
    Ok(path)
}

#[tauri::command]
pub fn vault_activate(path: String) -> Result<(), String> {
    if !Path::new(&path).is_dir() {
        return Err(format!("папки {path} больше нет"));
    }
    remember(&path, None)?;
    activate(&path)
}

/// Remove from the list only; the folder stays on disk.
#[tauri::command]
pub fn vault_forget(path: String) -> Result<(), String> {
    let mut list = known();
    list.retain(|v| v.path != path);
    store::save_json(VAULTS, &list)
}

// ---------- tags ----------

/// `#tag` in text (not in code, not headings, not pure numbers) + `tags:` from the front matter.
pub(crate) fn tags_of(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |t: &str| {
        let t = t.trim().trim_start_matches('#').trim_matches(|c| c == '"' || c == '\'').trim();
        if !t.is_empty() && !t.chars().all(|c| c.is_ascii_digit()) && !out.iter().any(|x| x == t) {
            out.push(t.to_string());
        }
    };
    let mut lines = text.lines().peekable();
    // front matter
    if lines.peek().map(|l| l.trim()) == Some("---") {
        lines.next();
        let mut in_tags = false;
        for l in lines.by_ref() {
            if l.trim() == "---" {
                break;
            }
            if let Some(rest) = l.strip_prefix("tags:").or_else(|| l.strip_prefix("tag:")) {
                let rest = rest.trim();
                in_tags = rest.is_empty();
                for t in rest.trim_matches(|c| c == '[' || c == ']').split(',') {
                    push(t);
                }
            } else if in_tags && l.trim_start().starts_with("- ") {
                push(&l.trim_start()[2..]);
            } else {
                in_tags = false;
            }
        }
    }
    let mut fence = false;
    for l in lines {
        if l.trim_start().starts_with("```") {
            fence = !fence;
            continue;
        }
        if fence {
            continue;
        }
        let chars: Vec<char> = l.chars().collect();
        let mut i = 0;
        let mut code = false;
        while i < chars.len() {
            let c = chars[i];
            if c == '`' {
                code = !code;
            } else if c == '#' && !code && (i == 0 || chars[i - 1].is_whitespace() || chars[i - 1] == '(') {
                let start = i + 1;
                let mut j = start;
                while j < chars.len() && (chars[j].is_alphanumeric() || "_-/".contains(chars[j])) {
                    j += 1;
                }
                if j > start {
                    push(&chars[start..j].iter().collect::<String>());
                }
                i = j;
                continue;
            }
            i += 1;
        }
    }
    out
}

#[derive(Serialize)]
pub struct TagInfo {
    tag: String,
    notes: Vec<String>,
}

#[tauri::command]
pub async fn notes_tags() -> Result<Vec<TagInfo>, String> {
    let root = vault().await?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut files = Vec::new();
        walk(&root, &root, &mut files);
        let mut map: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for rel in files {
            let Ok(text) = fs::read_to_string(root.join(&rel)) else { continue };
            let path = rel.to_string_lossy().into_owned();
            for t in tags_of(&text) {
                map.entry(t).or_default().push(path.clone());
            }
        }
        let mut out: Vec<TagInfo> = map.into_iter().map(|(tag, notes)| TagInfo { tag, notes }).collect();
        out.sort_by(|a, b| b.notes.len().cmp(&a.notes.len()).then_with(|| a.tag.to_lowercase().cmp(&b.tag.to_lowercase())));
        out
    })
    .await
    .map_err(err)
}

#[cfg(test)]
mod tests {
    use super::tags_of;

    #[test]
    fn tags() {
        let t = tags_of("---\ntags: [infra, \"k8s\"]\n---\n# Заголовок\nтекст #идея и #infra/dns, `#notatag`, #123\n```\n#nope\n```\n");
        assert_eq!(t, vec!["infra", "k8s", "идея", "infra/dns"]);
        assert_eq!(tags_of("---\ntags:\n  - a\n  - b\n---\n"), vec!["a", "b"]);
    }

    #[tokio::test]
    async fn validate_path() {
        let dir = std::env::temp_dir().join(format!("opsdeck-test-vault-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("test.md"), "# Test\n").unwrap();

        let check = super::vault_validate_path(dir.to_string_lossy().into_owned()).await.unwrap();
        assert!(check.ok && check.exists && check.is_dir && check.md_count == 1 && !check.is_obsidian);
        assert!(!super::vault_validate_path("   ".into()).await.unwrap().ok);
        assert!(!super::vault_validate_path(dir.join("nope").to_string_lossy().into_owned()).await.unwrap().ok);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
