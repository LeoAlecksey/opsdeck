//! Built-in IDE: read/write text files (with an on-disk change check), `terraform fmt` with
//! syntax errors, and git data for the side panel (commit graph, diffs).

use crate::{editor::expand, process, store::err};
use serde::Serialize;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::UNIX_EPOCH,
};

const MAX_FILE: u64 = 5 * 1024 * 1024;

#[derive(Serialize)]
pub struct FileText {
    text: String,
    /// modification time in ms; sent back on save to detect edits made elsewhere
    mtime: u64,
}

fn mtime_ms(p: &Path) -> u64 {
    std::fs::metadata(p).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64)
}

#[tauri::command]
pub async fn code_read(path: String) -> Result<FileText, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = expand(&path);
        let meta = std::fs::metadata(&p).map_err(|e| format!("{}: {e}", p.display()))?;
        if meta.len() > MAX_FILE {
            return Err(format!("файл больше {} МБ — откройте его во внешнем редакторе", MAX_FILE / 1024 / 1024));
        }
        let bytes = std::fs::read(&p).map_err(err)?;
        if bytes.iter().take(8000).any(|b| *b == 0) {
            return Err("двоичный файл — не открывается в редакторе".into());
        }
        Ok(FileText { text: String::from_utf8_lossy(&bytes).into_owned(), mtime: mtime_ms(&p) })
    })
    .await
    .map_err(err)?
}

/// Save; refuses when the file changed on disk after `expect_mtime` (unless `force`). Returns the new mtime.
#[tauri::command]
pub async fn code_write(path: String, text: String, expect_mtime: Option<u64>, force: bool) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = expand(&path);
        if let (Some(exp), false) = (expect_mtime, force) {
            let now = mtime_ms(&p);
            if now != 0 && now != exp {
                return Err("CONFLICT: файл изменён на диске после открытия".into());
            }
        }
        // keep the original permissions: write in place
        std::fs::write(&p, text).map_err(|e| format!("{}: {e}", p.display()))?;
        Ok(mtime_ms(&p))
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn code_create(path: String, dir: bool) -> Result<(), String> {
    let p = expand(&path);
    if p.exists() {
        return Err(format!("{} уже существует", p.display()));
    }
    if dir {
        std::fs::create_dir_all(&p).map_err(err)
    } else {
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).map_err(err)?;
        }
        std::fs::write(&p, "").map_err(err)
    }
}

// ---------- tree operations: rename / copy / delete ----------

/// `path` must lie strictly inside the project folder and not walk out through "..": the tree is the only
/// caller, but a bug there must not be able to touch a parent folder, the home folder or a drive root.
fn inside(root: &str, path: &str) -> Result<(PathBuf, PathBuf), String> {
    let (root, p) = (expand(root), expand(path));
    let clean = |x: &Path| !x.as_os_str().is_empty() && x.is_absolute() && !x.components().any(|c| matches!(c, std::path::Component::ParentDir));
    if !clean(&root) || !clean(&p) || p == root || !p.starts_with(&root) {
        return Err(format!("{}: вне папки проекта", p.display()));
    }
    Ok((root, p))
}

fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(from).map_err(|e| format!("{}: {e}", from.display()))?;
    if meta.file_type().is_symlink() {
        return Ok(()); // links are not followed: a loop or a way out of the project
    }
    if meta.is_dir() {
        fs::create_dir_all(to).map_err(|e| format!("{}: {e}", to.display()))?;
        for e in fs::read_dir(from).map_err(|e| format!("{}: {e}", from.display()))?.flatten() {
            copy_tree(&e.path(), &to.join(e.file_name()))?;
        }
        Ok(())
    } else {
        fs::copy(from, to).map(|_| ()).map_err(|e| format!("{}: {e}", to.display()))
    }
}

/// Moves a file or folder (also renames: same folder, new name). The target must not exist.
#[tauri::command]
pub async fn code_rename(root: String, from: String, to: String) -> Result<(), String> {
    let (_, from) = inside(&root, &from)?;
    let (_, to) = inside(&root, &to)?;
    if fs::symlink_metadata(&to).is_ok() {
        return Err(format!("{} уже существует", to.display()));
    }
    if to.starts_with(&from) {
        return Err("нельзя переместить папку в саму себя".into());
    }
    fs::rename(&from, &to).map_err(|e| format!("{}: {e}", from.display()))
}

/// Copies a file or folder (recursively, symlinks skipped). The target must not exist.
#[tauri::command]
pub async fn code_copy(root: String, from: String, to: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (_, from) = inside(&root, &from)?;
        let (_, to) = inside(&root, &to)?;
        if fs::symlink_metadata(&to).is_ok() {
            return Err(format!("{} уже существует", to.display()));
        }
        if to.starts_with(&from) {
            return Err("нельзя скопировать папку в саму себя".into());
        }
        copy_tree(&from, &to)
    })
    .await
    .map_err(err)?
}

/// Deletes a file or a folder with everything in it. There is no trash: the UI asks first.
#[tauri::command]
pub async fn code_delete(root: String, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (root, p) = inside(&root, &path)?;
        if p.starts_with(root.join(".git")) && p.components().count() <= root.components().count() + 1 {
            return Err("папку .git удалять нельзя".into());
        }
        let meta = fs::symlink_metadata(&p).map_err(|e| format!("{}: {e}", p.display()))?;
        let r = if meta.file_type().is_symlink() {
            // the link itself, never what it points to
            fs::remove_file(&p).or_else(|_| fs::remove_dir(&p))
        } else if meta.is_dir() {
            fs::remove_dir_all(&p)
        } else {
            fs::remove_file(&p)
        };
        r.map_err(|e| format!("{}: {e}", p.display()))
    })
    .await
    .map_err(err)?
}

// ---------- terraform fmt ----------

#[derive(Serialize)]
pub struct Diag {
    line: u32,
    message: String,
}

#[derive(Serialize)]
pub struct FmtResult {
    /// formatted text when the file is valid
    text: Option<String>,
    errors: Vec<Diag>,
    /// "terraform" / "tofu", empty when neither is installed
    tool: String,
}

fn find_tool() -> Option<String> {
    ["terraform", "tofu"].into_iter().find(|t| {
        let mut cmd = Command::new(t);
        cmd.arg("version").stdout(Stdio::null()).stderr(Stdio::null());
        process::no_console(&mut cmd);
        cmd.status().is_ok()
    }).map(str::to_string)
}

/// `terraform fmt -` on the buffer: formatted text, or the syntax errors with line numbers.
#[tauri::command]
pub async fn code_tf_fmt(text: String) -> Result<FmtResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(tool) = find_tool() else { return Ok(FmtResult { text: None, errors: Vec::new(), tool: String::new() }) };
        let mut child = {
            let mut cmd = Command::new(&tool);
            cmd.args(["fmt", "-no-color", "-"])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            process::no_console(&mut cmd);
            cmd.spawn().map_err(|e| format!("{tool}: {e}"))?
        };
        let mut stdin = child.stdin.take().ok_or("stdin")?;
        let input = text.clone();
        let writer = std::thread::spawn(move || stdin.write_all(input.as_bytes()));
        let out = child.wait_with_output().map_err(err)?;
        let _ = writer.join();
        if out.status.success() {
            return Ok(FmtResult { text: Some(String::from_utf8_lossy(&out.stdout).into_owned()), errors: Vec::new(), tool });
        }
        Ok(FmtResult { text: None, errors: parse_tf_errors(&String::from_utf8_lossy(&out.stderr)), tool })
    })
    .await
    .map_err(err)?
}

/// Terraform diagnostics: "Error: <summary>" … "on <stdin> line N" … details.
fn parse_tf_errors(stderr: &str) -> Vec<Diag> {
    let mut out = Vec::new();
    let mut cur: Option<(String, u32, Vec<String>)> = None;
    let flush = |cur: &mut Option<(String, u32, Vec<String>)>, out: &mut Vec<Diag>| {
        if let Some((summary, line, detail)) = cur.take() {
            let detail = detail.join(" ").trim().to_string();
            out.push(Diag { line: line.max(1), message: if detail.is_empty() { summary } else { format!("{summary}: {detail}") } });
        }
    };
    for raw in stderr.lines() {
        let l = raw.trim_start_matches(['│', '╷', '╵', ' ']).trim_end();
        if let Some(s) = l.strip_prefix("Error: ") {
            flush(&mut cur, &mut out);
            cur = Some((s.to_string(), 0, Vec::new()));
        } else if let Some((_, _, detail)) = cur.as_mut() {
            if let Some(rest) = l.trim_start().strip_prefix("on <stdin> line ") {
                let n: u32 = rest.split(|c: char| !c.is_ascii_digit()).next().and_then(|n| n.parse().ok()).unwrap_or(0);
                cur.as_mut().unwrap().1 = n;
            } else if !l.is_empty() && !l.trim_start().chars().next().is_some_and(|c| c.is_ascii_digit()) {
                detail.push(l.trim().to_string());
            }
        }
    }
    flush(&mut cur, &mut out);
    if out.is_empty() && !stderr.trim().is_empty() {
        out.push(Diag { line: 1, message: stderr.trim().to_string() });
    }
    out
}

// ---------- git ----------

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(dir).args(args).stdin(Stdio::null());
    process::no_console(&mut cmd);
    let out = cmd.output().map_err(|e| format!("git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[derive(Serialize)]
pub struct Commit {
    hash: String,
    parents: Vec<String>,
    /// "HEAD -> master", "origin/master", "tag: v1.0"
    refs: Vec<String>,
    author: String,
    time: i64,
    subject: String,
}

/// Commits of all branches, newest first, for the graph.
/// The .git directory of a work tree (".git" may be a file "gitdir: …" in worktrees and submodules).
fn git_dir(root: &Path) -> Option<PathBuf> {
    let dot = root.join(".git");
    if dot.is_dir() {
        return Some(dot);
    }
    let text = fs::read_to_string(&dot).ok()?;
    let target = PathBuf::from(text.trim().strip_prefix("gitdir:")?.trim());
    Some(if target.is_absolute() { target } else { root.join(target) })
}

/// Newest modification time under `dir` (refs are small trees).
fn newest(dir: &Path, depth: u8) -> u128 {
    let Ok(rd) = fs::read_dir(dir) else { return 0 };
    rd.flatten()
        .map(|e| {
            let m = e.metadata().ok();
            let t = m.as_ref().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos());
            if depth > 0 && m.is_some_and(|m| m.is_dir()) { t.max(newest(&e.path(), depth - 1)) } else { t }
        })
        .max()
        .unwrap_or(0)
}

/// A cheap fingerprint of the repository state — current branch, refs, index — read from files
/// without running git; the IDE polls it to notice a switch or commit made in a terminal.
#[tauri::command]
pub fn code_git_stamp(root: String) -> String {
    let root = expand(&root);
    let Some(dir) = git_dir(&root) else { return String::new() };
    let mtime = |p: &Path| fs::metadata(p).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos());
    // linked worktrees keep refs in the common dir
    let common = fs::read_to_string(dir.join("commondir")).ok().map(|c| dir.join(c.trim())).unwrap_or_else(|| dir.clone());
    format!(
        "{}|{}|{}|{}",
        fs::read_to_string(dir.join("HEAD")).unwrap_or_default().trim(),
        newest(&common.join("refs"), 6),
        mtime(&common.join("packed-refs")),
        mtime(&dir.join("index")),
    )
}

#[tauri::command]
pub async fn code_git_log(path: String, limit: Option<usize>) -> Result<Vec<Commit>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = expand(&path);
        let n = limit.unwrap_or(300).min(2000).to_string();
        let text = git(&dir, &["log", "--all", "--date-order", "-n", &n, "--format=%H%x1f%P%x1f%D%x1f%an%x1f%at%x1f%s%x1e"])?;
        Ok(text
            .split('\x1e')
            .filter_map(|rec| {
                let f: Vec<&str> = rec.trim_start_matches('\n').split('\x1f').collect();
                (f.len() == 6).then(|| Commit {
                    hash: f[0].to_string(),
                    parents: f[1].split_whitespace().map(str::to_string).collect(),
                    refs: f[2].split(", ").filter(|r| !r.is_empty()).map(str::to_string).collect(),
                    author: f[3].to_string(),
                    time: f[4].parse().unwrap_or(0),
                    subject: f[5].to_string(),
                })
            })
            .collect())
    })
    .await
    .map_err(err)?
}

/// Unified diff of a working-tree file against HEAD (untracked: the whole file as added).
#[tauri::command]
pub async fn code_git_diff(root: String, file: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = expand(&root);
        let d = git(&dir, &["diff", "--no-color", "HEAD", "--", &file])?;
        if !d.trim().is_empty() {
            return Ok(d);
        }
        // untracked or new: diff against /dev/null (exit code 1 means "differs")
        let out = {
            let mut cmd = Command::new("git");
            cmd.arg("-C")
                .arg(&dir)
                .args(["diff", "--no-color", "--no-index", "--", "/dev/null", &file])
                .stdin(Stdio::null());
            process::no_console(&mut cmd);
            cmd.output().map_err(err)?
        };
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    })
    .await
    .map_err(err)?
}

/// One commit: header, stat and patch (trimmed for huge commits).
#[tauri::command]
pub async fn code_git_show(root: String, hash: String) -> Result<String, String> {
    if !hash.chars().all(|c| c.is_ascii_hexdigit()) || hash.len() < 7 {
        return Err("bad hash".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut s = git(&expand(&root), &["show", "--no-color", "--stat", "--patch", "--format=commit %H%nAuthor: %an <%ae>%nDate:   %ad%n%n%B", &hash])?;
        if s.len() > 400_000 {
            s.truncate(400_000);
            s.push_str("\n… (обрезано)");
        }
        Ok(s)
    })
    .await
    .map_err(err)?
}

/// Native "choose folder" dialog; None when cancelled.
#[tauri::command]
pub async fn pick_folder(app: tauri::AppHandle, start: Option<String>) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        let mut d = app.dialog().file().set_title("Папка проекта");
        if let Some(s) = start.filter(|s| !s.is_empty()) {
            let p = expand(&s);
            if p.is_dir() {
                d = d.set_directory(p);
            }
        }
        d.blocking_pick_folder().and_then(|f| f.into_path().ok()).map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .ok()
    .flatten()
}

#[derive(Serialize)]
pub struct Branch {
    name: String,
    upstream: String,
    /// "ahead 2, behind 1" / "gone" / ""
    track: String,
    time: i64,
    subject: String,
}

#[derive(Serialize)]
pub struct Branches {
    current: String,
    local: Vec<Branch>,
    remote: Vec<Branch>,
}

#[tauri::command]
pub async fn code_git_branches(root: String) -> Result<Branches, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = expand(&root);
        let current = git(&dir, &["branch", "--show-current"]).unwrap_or_default().trim().to_string();
        let list = |refs: &str| -> Result<Vec<Branch>, String> {
            let out = git(&dir, &["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)%1f%(upstream:short)%1f%(upstream:track,nobracket)%1f%(committerdate:unix)%1f%(subject)", refs])?;
            Ok(out
                .lines()
                .filter_map(|l| {
                    let f: Vec<&str> = l.split('\x1f').collect();
                    (f.len() == 5 && !f[0].ends_with("/HEAD") && f[0] != "HEAD").then(|| Branch {
                        name: f[0].to_string(),
                        upstream: f[1].to_string(),
                        track: f[2].to_string(),
                        time: f[3].parse().unwrap_or(0),
                        subject: f[4].to_string(),
                    })
                })
                .collect())
        };
        Ok(Branches { current, local: list("refs/heads")?, remote: list("refs/remotes")? })
    })
    .await
    .map_err(err)?
}

/// A branch or ref name that git accepts and that can't be mistaken for an option.
fn valid_ref(name: &str) -> bool {
    !name.is_empty() && !name.starts_with('-') && !name.contains("..") && !name.chars().any(|c| c.is_whitespace() || c.is_control() || "~^:?*[\\".contains(c))
}

/// Branch / sync / commit operations. Output (stdout+stderr) is returned for the UI.
#[tauri::command]
pub async fn code_git_op(root: String, op: String, name: Option<String>, from: Option<String>, message: Option<String>, force: Option<bool>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = expand(&root);
        let name = name.unwrap_or_default();
        let need = |n: &str| if valid_ref(n) { Ok(()) } else { Err(format!("недопустимое имя ветки: «{n}»")) };
        let run = |args: &[&str]| -> Result<String, String> {
            let mut cmd = Command::new("git");
            cmd.arg("-C").arg(&dir).args(args).stdin(Stdio::null()).env("GIT_TERMINAL_PROMPT", "0");
            // never wait for a password prompt that nobody can answer
            if std::env::var_os("GIT_SSH_COMMAND").is_none() {
                cmd.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
            }
            process::no_console(&mut cmd);
            let out = cmd.output().map_err(|e| format!("git: {e}"))?;
            let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)).trim().to_string();
            if out.status.success() { Ok(text) } else { Err(if text.is_empty() { format!("git {} завершился с ошибкой", args[0]) } else { text }) }
        };
        match op.as_str() {
            "switch" => {
                need(&name)?;
                // a remote branch ("origin/feature") becomes a local tracking branch
                match name.split_once('/') {
                    Some((remote, local)) if git(&dir, &["remote"]).unwrap_or_default().lines().any(|r| r == remote) => {
                        if git(&dir, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{local}")]).is_ok() {
                            run(&["switch", local])
                        } else {
                            run(&["switch", "--track", &name])
                        }
                    }
                    _ => run(&["switch", &name]),
                }
            }
            "create" => {
                need(&name)?;
                match from.filter(|f| !f.is_empty()) {
                    Some(f) => {
                        need(&f)?;
                        run(&["switch", "-c", &name, &f])
                    }
                    None => run(&["switch", "-c", &name]),
                }
            }
            "delete" => {
                need(&name)?;
                run(&["branch", if force.unwrap_or(false) { "-D" } else { "-d" }, "--", &name])
            }
            "merge" => {
                need(&name)?;
                run(&["merge", "--no-edit", &name])
            }
            "fetch" => run(&["fetch", "--all", "--prune"]),
            "pull" => run(&["pull", "--ff-only"]),
            "push" => {
                let has_upstream = git(&dir, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).is_ok();
                if has_upstream { run(&["push"]) } else { run(&["push", "-u", "origin", "HEAD"]) }
            }
            "commit" => {
                let msg = message.unwrap_or_default();
                if msg.trim().is_empty() {
                    return Err("пустое сообщение коммита".into());
                }
                run(&["add", "-A"])?;
                run(&["commit", "-m", msg.trim()])
            }
            _ => Err(format!("неизвестная операция {op}")),
        }
    })
    .await
    .map_err(err)?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ref_names() {
        assert!(valid_ref("feature/db-panel"));
        assert!(valid_ref("origin/master"));
        assert!(!valid_ref("-D"));
        assert!(!valid_ref("a..b"));
        assert!(!valid_ref("has space"));
    }

    #[test]
    fn terraform_errors() {
        let stderr = "╷\n│ Error: Invalid expression\n│ \n│   on <stdin> line 3, in resource \"x\" \"y\":\n│    3:   ami = \n│ \n│ Expected the start of an expression, but found an invalid expression token.\n╵\n";
        let d = parse_tf_errors(stderr);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].line, 3);
        assert!(d[0].message.starts_with("Invalid expression: Expected the start"));
    }

    #[test]
    fn git_stamp_follows_branch_switch() {
        let dir = std::env::temp_dir().join(format!("opsdeck-stamp-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join(".git/refs/heads")).unwrap();
        fs::write(dir.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        let root = dir.to_string_lossy().into_owned();
        let a = code_git_stamp(root.clone());
        assert!(a.starts_with("ref: refs/heads/main|"), "{a}");
        fs::write(dir.join(".git/HEAD"), "ref: refs/heads/feature\n").unwrap();
        assert_ne!(code_git_stamp(root.clone()), a, "switching the branch changes the stamp");
        // a worktree: .git is a file pointing at the real git dir
        let wt = dir.join("wt");
        fs::create_dir_all(&wt).unwrap();
        fs::write(wt.join(".git"), format!("gitdir: {}\n", dir.join(".git").display())).unwrap();
        assert!(code_git_stamp(wt.to_string_lossy().into_owned()).starts_with("ref: refs/heads/feature|"));
        assert_eq!(code_git_stamp(std::env::temp_dir().join("opsdeck-no-such").to_string_lossy().into_owned()), "");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn tree_operations_stay_inside_the_project() {
        let base = std::env::temp_dir().join(format!("opsdeck-tree-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let root = base.join("proj");
        fs::create_dir_all(root.join("a/b")).unwrap();
        fs::write(root.join("a/b/f.txt"), "x").unwrap();
        fs::write(base.join("outside.txt"), "keep").unwrap();
        let (r, f, o) = (root.to_string_lossy().into_owned(), |p: &str| root.join(p).to_string_lossy().into_owned(), base.join("outside.txt").to_string_lossy().into_owned());
        macro_rules! rt {
            ($f:expr) => {
                tauri::async_runtime::block_on($f)
            };
        }
        // copy a folder, then rename the copy
        rt!(code_copy(r.clone(), f("a"), f("a2"))).unwrap();
        assert_eq!(fs::read_to_string(root.join("a2/b/f.txt")).unwrap(), "x");
        assert!(rt!(code_copy(r.clone(), f("a"), f("a2"))).unwrap_err().contains("уже существует"));
        assert!(rt!(code_copy(r.clone(), f("a"), f("a/b/in"))).unwrap_err().contains("саму себя"));
        rt!(code_rename(r.clone(), f("a2"), f("c"))).unwrap();
        assert!(root.join("c/b/f.txt").is_file() && !root.join("a2").exists());
        // nothing outside the project, the project itself or ".." can be touched
        assert!(rt!(code_delete(r.clone(), o.clone())).is_err());
        assert!(rt!(code_delete(r.clone(), r.clone())).is_err());
        assert!(rt!(code_delete(r.clone(), format!("{r}/../outside.txt"))).is_err());
        assert!(rt!(code_rename(r.clone(), f("c"), o.clone())).is_err());
        assert_eq!(fs::read_to_string(base.join("outside.txt")).unwrap(), "keep");
        // .git stays
        fs::create_dir_all(root.join(".git")).unwrap();
        assert!(rt!(code_delete(r.clone(), f(".git"))).is_err());
        // a link is removed itself, not its target
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&base, root.join("link")).unwrap();
            rt!(code_delete(r.clone(), f("link"))).unwrap();
            assert!(base.join("outside.txt").is_file() && !root.join("link").exists());
        }
        rt!(code_delete(r.clone(), f("c"))).unwrap();
        assert!(!root.join("c").exists() && root.join("a/b/f.txt").is_file());
        let _ = fs::remove_dir_all(&base);
    }
}

