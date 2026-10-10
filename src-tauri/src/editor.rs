//! "Файлы" panel of the terminal: directory listing with git status, and opening files/folders
//! in an IDE or editor (detected on this machine), optionally at a line.

use crate::{process, store::err};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

const MAX_ENTRIES: usize = 5000;

#[derive(Serialize)]
pub struct Entry {
    name: String,
    dir: bool,
    link: bool,
    size: u64,
}

pub(crate) fn expand(path: &str) -> PathBuf {
    let mut s = path.trim();
    if (s.starts_with('"') && s.ends_with('"')) || (s.starts_with('\'') && s.ends_with('\'')) {
        s = s[1..s.len() - 1].trim();
    }
    let s = s.trim_matches(|c| c == '"' || c == '\'').trim();
    if s.is_empty() {
        return PathBuf::new();
    }
    let mut clean = s.to_string();
    if let Some(rest) = clean.strip_prefix("file://") {
        clean = rest.replace("%20", " ");
        #[cfg(windows)]
        if clean.starts_with('/') && clean.chars().nth(2) == Some(':') {
            clean = clean.trim_start_matches('/').to_string();
        }
    }
    #[cfg(not(windows))]
    if clean.contains(r"\ ") {
        clean = clean.replace(r"\ ", " ");
    }
    match clean.strip_prefix("~") {
        Some(rest) if rest.is_empty() || rest.starts_with('/') || rest.starts_with('\\') => {
            dirs::home_dir().unwrap_or_default().join(rest.trim_start_matches(['/', '\\']))
        }
        _ => PathBuf::from(clean),
    }
}

/// Natural order for names, case-insensitive: "file2" < "file10", "TL-9" < "TL-10".
pub(crate) fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let (mut a, mut b) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (a.peek().copied(), b.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let num = |it: &mut std::iter::Peekable<std::str::Chars>| {
                    let mut s = String::new();
                    while let Some(c) = it.next_if(char::is_ascii_digit) {
                        s.push(c);
                    }
                    s.trim_start_matches('0').to_string()
                };
                let (na, nb) = (num(&mut a), num(&mut b));
                // longer number = bigger; same length compares digit by digit
                let o = na.len().cmp(&nb.len()).then_with(|| na.cmp(&nb));
                if o != Ordering::Equal {
                    return o;
                }
            }
            (Some(x), Some(y)) => {
                let o = x.to_lowercase().cmp(y.to_lowercase());
                if o != Ordering::Equal {
                    return o;
                }
                a.next();
                b.next();
            }
        }
    }
}

/// One directory level: folders first, then files, case-insensitive by name.
#[tauri::command]
pub async fn fs_list(path: String, hidden: bool) -> Result<Vec<Entry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = expand(&path);
        let mut out: Vec<Entry> = std::fs::read_dir(&dir)
            .map_err(|e| format!("{}: {e}", dir.display()))?
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                if !hidden && name.starts_with('.') {
                    return None;
                }
                let link = e.file_type().map(|t| t.is_symlink()).unwrap_or(false);
                let meta = std::fs::metadata(e.path()).ok(); // follows symlinks
                Some(Entry { dir: meta.as_ref().is_some_and(|m| m.is_dir()), size: meta.map_or(0, |m| m.len()), link, name })
            })
            .take(MAX_ENTRIES)
            .collect();
        out.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| natural_cmp(&a.name, &b.name)));
        Ok(out)
    })
    .await
    .map_err(err)?
}

#[derive(Serialize, Default)]
pub struct GitStatus {
    /// repository root (absolute), empty when `path` is not inside a repo
    root: String,
    branch: String,
    /// path relative to root → two-letter porcelain code ("M ", " M", "??", "A ", "D ", …)
    files: HashMap<String, String>,
    /// why there is no repo when it is not simply "not a repository" (git missing, unsafe folder)
    #[serde(skip_serializing_if = "String::is_empty")]
    error: String,
}

/// `git status` for the repo containing `path` (nothing if git is missing or it's not a repo).
#[tauri::command]
pub async fn fs_git_status(path: String) -> GitStatus {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = expand(&path);
        let git = |args: &[&str]| {
            let mut cmd = Command::new("git");
            cmd.arg("-C").arg(&dir).args(args).stdin(Stdio::null()).stderr(Stdio::null());
            process::no_console(&mut cmd);
            cmd.output().ok().filter(|o| o.status.success())
        };
        let Some(root) = git(&["rev-parse", "--show-toplevel"]) else {
            // say why, when it is not just "not a repository"
            let mut cmd = Command::new("git");
            cmd.arg("-C").arg(&dir).args(["rev-parse", "--show-toplevel"]).stdin(Stdio::null());
            process::no_console(&mut cmd);
            let error = match cmd.output() {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => "git не найден — установите Git (на Windows: Git for Windows) и перезапустите OpsDeck".to_string(),
                Ok(o) if String::from_utf8_lossy(&o.stderr).contains("dubious ownership") =>
                    "git не доверяет этой папке (dubious ownership): выполните git config --global --add safe.directory <папка>".to_string(),
                _ => String::new(),
            };
            return GitStatus { error, ..Default::default() };
        };
        let root = String::from_utf8_lossy(&root.stdout).trim().to_string();
        let mut st = GitStatus { root, ..Default::default() };
        let Some(out) = git(&["status", "--porcelain=v1", "-b", "-z", "--untracked-files=normal"]) else { return st };
        let text = String::from_utf8_lossy(&out.stdout);
        let mut parts = text.split('\0');
        while let Some(rec) = parts.next() {
            if let Some(b) = rec.strip_prefix("## ") {
                st.branch = b.split("...").next().unwrap_or(b).trim().to_string();
                continue;
            }
            if rec.len() < 4 {
                continue;
            }
            let (code, file) = rec.split_at(2);
            // renames/copies carry the old name as the next record
            if code.contains('R') || code.contains('C') {
                parts.next();
            }
            st.files.insert(file[1..].trim_end_matches('/').to_string(), code.to_string());
        }
        st
    })
    .await
    .unwrap_or_default()
}

/// Which of `candidates` (as printed in the terminal, relative to `cwd` or absolute) exist.
/// Returns candidate → absolute path. Used for Ctrl+click on paths in terminal output.
#[tauri::command]
pub async fn fs_resolve(cwd: String, candidates: Vec<String>) -> HashMap<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = expand(&cwd);
        candidates
            .into_iter()
            .take(64)
            .filter_map(|c| {
                let p = expand(&c);
                let abs = if p.is_absolute() { p } else { base.join(p) };
                abs.exists().then(|| (c, abs.to_string_lossy().into_owned()))
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// Reveal a file/folder in the system file manager.
#[tauri::command]
pub fn fs_reveal(path: String) -> Result<(), String> {
    let p = expand(&path);
    let dir = if p.is_dir() { p } else { p.parent().map(Path::to_path_buf).unwrap_or(p) };
    crate::store::open_with_system(&dir.to_string_lossy())
}

// ---------- editors ----------

/// How an editor takes "open at line".
#[derive(Clone, Copy)]
enum Goto {
    /// code/cursor/codium/windsurf: -g file:line
    VsCode,
    /// zed, subl: file:line
    Colon,
    /// JetBrains: --line N file
    JetBrains,
    /// kate: -l N file
    Kate,
    /// gedit, vim, nvim, nano, micro(+N): +N file
    Plus,
    /// helix: file:line
    Helix,
}

struct Known {
    id: &'static str,
    name: &'static str,
    bins: &'static [&'static str],
    goto: Goto,
    /// runs inside a terminal (opened as an OpsDeck terminal tab)
    tui: bool,
}

const KNOWN: &[Known] = &[
    Known { id: "vscode", name: "VS Code", bins: &["code"], goto: Goto::VsCode, tui: false },
    Known { id: "cursor", name: "Cursor", bins: &["cursor"], goto: Goto::VsCode, tui: false },
    Known { id: "codium", name: "VSCodium", bins: &["codium", "vscodium"], goto: Goto::VsCode, tui: false },
    Known { id: "windsurf", name: "Windsurf", bins: &["windsurf"], goto: Goto::VsCode, tui: false },
    Known { id: "zed", name: "Zed", bins: &["zed", "zeditor"], goto: Goto::Colon, tui: false },
    Known { id: "subl", name: "Sublime Text", bins: &["subl"], goto: Goto::Colon, tui: false },
    Known { id: "idea", name: "IntelliJ IDEA", bins: &["idea", "idea.sh", "intellij-idea-ultimate", "intellij-idea-community"], goto: Goto::JetBrains, tui: false },
    Known { id: "pycharm", name: "PyCharm", bins: &["pycharm", "pycharm.sh", "pycharm-professional", "pycharm-community"], goto: Goto::JetBrains, tui: false },
    Known { id: "goland", name: "GoLand", bins: &["goland", "goland.sh"], goto: Goto::JetBrains, tui: false },
    Known { id: "rustrover", name: "RustRover", bins: &["rustrover", "rustrover.sh"], goto: Goto::JetBrains, tui: false },
    Known { id: "webstorm", name: "WebStorm", bins: &["webstorm", "webstorm.sh"], goto: Goto::JetBrains, tui: false },
    Known { id: "clion", name: "CLion", bins: &["clion", "clion.sh"], goto: Goto::JetBrains, tui: false },
    Known { id: "kate", name: "Kate", bins: &["kate"], goto: Goto::Kate, tui: false },
    Known { id: "gedit", name: "gedit", bins: &["gedit", "gnome-text-editor"], goto: Goto::Plus, tui: false },
    Known { id: "nvim", name: "Neovim", bins: &["nvim"], goto: Goto::Plus, tui: true },
    Known { id: "vim", name: "Vim", bins: &["vim"], goto: Goto::Plus, tui: true },
    Known { id: "hx", name: "Helix", bins: &["hx", "helix"], goto: Goto::Helix, tui: true },
    Known { id: "micro", name: "micro", bins: &["micro"], goto: Goto::Plus, tui: true },
    Known { id: "nano", name: "nano", bins: &["nano"], goto: Goto::Plus, tui: true },
];

/// Extra places where IDE launchers live besides PATH (JetBrains Toolbox, snaps, macOS apps).
fn extra_dirs() -> Vec<PathBuf> {
    let home = dirs::home_dir().unwrap_or_default();
    let mut v = vec![
        home.join(".local/share/JetBrains/Toolbox/scripts"),
        home.join(".local/bin"),
        PathBuf::from("/snap/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/opt/homebrew/bin"),
    ];
    if cfg!(target_os = "macos") {
        v.push(home.join("Library/Application Support/JetBrains/Toolbox/scripts"));
        v.push(PathBuf::from("/Applications/Visual Studio Code.app/Contents/Resources/app/bin"));
        v.push(PathBuf::from("/Applications/Cursor.app/Contents/Resources/app/bin"));
        v.push(PathBuf::from("/Applications/Zed.app/Contents/MacOS/cli"));
    }
    if cfg!(windows) {
        if let Some(local) = dirs::data_local_dir() {
            v.push(local.join("Programs/Microsoft VS Code/bin"));
            v.push(local.join("Programs/cursor/resources/app/bin"));
            v.push(local.join("JetBrains/Toolbox/scripts"));
        }
    }
    v
}

fn find_bin(name: &str) -> Option<PathBuf> {
    let exts: Vec<String> = if cfg!(windows) { vec![".cmd".into(), ".exe".into(), ".bat".into(), String::new()] } else { vec![String::new()] };
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path).chain(extra_dirs()).find_map(|d| {
        exts.iter().map(|e| d.join(format!("{name}{e}"))).find(|p| p.is_file())
    })
}

#[derive(Serialize)]
pub struct EditorInfo {
    id: &'static str,
    name: &'static str,
    tui: bool,
}

/// Editors available on this machine, GUI ones first.
#[tauri::command]
pub async fn editors_detect() -> Vec<EditorInfo> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut v: Vec<EditorInfo> = KNOWN
            .iter()
            .filter(|k| k.bins.iter().any(|b| find_bin(b).is_some()))
            .map(|k| EditorInfo { id: k.id, name: k.name, tui: k.tui })
            .collect();
        v.sort_by_key(|e| e.tui);
        v
    })
    .await
    .unwrap_or_default()
}

#[derive(Serialize)]
pub struct TermSpec {
    program: String,
    args: Vec<String>,
    cwd: String,
    title: String,
}

/// Opens `path` (file or folder) in `editor`, at `line` for files when given. GUI editors are
/// started detached; terminal editors come back as a spec for a new terminal tab.
/// `editor` = "custom" uses `custom`: a command line with {path}, {line}, {dir} placeholders.
#[tauri::command]
pub fn editor_open(editor: String, path: String, line: Option<u32>, custom: Option<String>) -> Result<Option<TermSpec>, String> {
    let p = expand(&path);
    if !p.exists() {
        return Err(format!("нет такого пути: {}", p.display()));
    }
    let file = p.to_string_lossy().into_owned();
    let dir = if p.is_dir() { p.clone() } else { p.parent().map(Path::to_path_buf).unwrap_or_default() };
    let line = line.filter(|_| p.is_file());

    if editor == "custom" {
        let tpl = custom.unwrap_or_default();
        let mut words = tpl.split_whitespace();
        let program = words.next().ok_or("команда редактора не задана")?.to_string();
        let args: Vec<String> = words
            .map(|w| {
                w.replace("{path}", &file)
                    .replace("{line}", &line.unwrap_or(1).to_string())
                    .replace("{dir}", &dir.to_string_lossy())
            })
            .collect();
        return spawn_detached(&program, &args, &dir).map(|_| None);
    }

    let k = KNOWN.iter().find(|k| k.id == editor).ok_or("неизвестный редактор")?;
    let bin = k.bins.iter().find_map(|b| find_bin(b)).ok_or_else(|| format!("{} не найден", k.name))?;
    let args: Vec<String> = match (line, k.goto) {
        (None, _) => vec![file.clone()],
        (Some(n), Goto::VsCode) => vec!["-g".into(), format!("{file}:{n}")],
        (Some(n), Goto::Colon | Goto::Helix) => vec![format!("{file}:{n}")],
        (Some(n), Goto::JetBrains) => vec!["--line".into(), n.to_string(), file.clone()],
        (Some(n), Goto::Kate) => vec!["-l".into(), n.to_string(), file.clone()],
        (Some(n), Goto::Plus) => vec![format!("+{n}"), file.clone()],
    };
    if k.tui {
        let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        return Ok(Some(TermSpec {
            program: bin.to_string_lossy().into_owned(),
            args,
            cwd: dir.to_string_lossy().into_owned(),
            title: format!("{} {name}", k.bins[0]),
        }));
    }
    spawn_detached(&bin.to_string_lossy(), &args, &dir).map(|_| None)
}

fn spawn_detached(program: &str, args: &[String], cwd: &Path) -> Result<(), String> {
    let mut cmd = Command::new(program);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    process::no_console(&mut cmd);
    if cwd.is_dir() {
        cmd.current_dir(cwd);
    }
    let mut child = cmd.spawn().map_err(|e| format!("не удалось запустить {program}: {e}"))?;
    std::thread::spawn(move || child.wait()); // reap; the editor keeps running on its own
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn natural_order_of_names() {
        let mut v = vec!["TL-10", "tl-2", "TL-1", "b", "A", "file010", "file9", "file10", "TL-11", "TL-9"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(v, ["A", "b", "file9", "file010", "file10", "TL-1", "tl-2", "TL-9", "TL-10", "TL-11"]);
    }

    use super::*;

    #[test]
    fn tilde() {
        let home = dirs::home_dir().unwrap_or_default();
        assert_eq!(expand("~"), home);
        assert_eq!(expand("~/notes/a.md"), home.join("notes/a.md"));
        assert_eq!(expand("~user/x"), PathBuf::from("~user/x"), "other users' homes are not guessed");
        assert_eq!(expand("/etc/hosts"), PathBuf::from("/etc/hosts"));
        assert_eq!(expand("rel/path"), PathBuf::from("rel/path"));
        assert_eq!(expand("  \"~/notes/a.md\"  "), home.join("notes/a.md"));
        assert_eq!(expand("'/etc/hosts'"), PathBuf::from("/etc/hosts"));
    }
}
