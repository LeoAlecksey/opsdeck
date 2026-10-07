//! Commands the user already knows: shell history (bash/zsh) and commands written down in the
//! notes (```bash blocks and `$ cmd` lines). Feeds the inline suggestion in the terminal and the
//! local AI's context. Cached; rebuilt at most every 30 s.

use crate::notes::{vault, walk};
use serde::Serialize;
use std::{
    collections::HashMap,
    fs,
    path::Path,
    sync::Mutex,
    time::{Duration, Instant},
};

#[derive(Clone, Default)]
struct Index {
    /// command → (times used, last position: bigger = more recent)
    history: HashMap<String, (u32, usize)>,
    /// command → note it came from
    notes: Vec<(String, String)>,
}

static CACHE: Mutex<Option<(Instant, String, Index)>> = Mutex::new(None);

fn shell_history() -> Vec<String> {
    let Some(home) = dirs::home_dir() else { return Vec::new() };
    let mut out = Vec::new();
    for f in [".bash_history", ".zsh_history", ".local/share/fish/fish_history"] {
        let Ok(bytes) = fs::read(home.join(f)) else { continue };
        let text = String::from_utf8_lossy(&bytes);
        for l in text.lines() {
            // zsh extended: ": 1696000000:0;cmd"; fish: "- cmd: cmd"
            let cmd = if let Some(rest) = l.strip_prefix(": ") { rest.split_once(';').map(|(_, c)| c).unwrap_or("") } else if let Some(c) = l.strip_prefix("- cmd: ") { c } else { l };
            let cmd = cmd.trim();
            if cmd.len() >= 2 && !cmd.starts_with('#') && !cmd.starts_with("when: ") {
                out.push(cmd.to_string());
            }
        }
    }
    // PowerShell (PSReadLine): one command per line, a trailing ` continues it
    let ps = if cfg!(windows) {
        dirs::data_dir().map(|d| d.join("Microsoft/Windows/PowerShell/PSReadLine/ConsoleHost_history.txt"))
    } else {
        dirs::data_dir().map(|d| d.join("powershell/PSReadLine/ConsoleHost_history.txt"))
    };
    if let Some(text) = ps.and_then(|p| fs::read(p).ok()) {
        let text = String::from_utf8_lossy(&text);
        let mut cont = String::new();
        for l in text.lines() {
            let l = l.trim_end_matches('\r');
            if let Some(part) = l.strip_suffix('`') {
                cont += part;
                cont.push('\n');
                continue;
            }
            let cmd = std::mem::take(&mut cont) + l;
            let cmd = cmd.trim();
            if cmd.len() >= 2 && !cmd.starts_with('#') {
                out.push(cmd.to_string());
            }
        }
    }
    out
}

const SHELL_LANGS: &[&str] = &["bash", "sh", "shell", "zsh", "console", "terminal", "fish", "powershell", "ps1", "cmd", ""];

fn note_commands(root: &Path) -> Vec<(String, String)> {
    let mut files = Vec::new();
    walk(root, root, &mut files);
    let mut out = Vec::new();
    for rel in files {
        let Ok(text) = fs::read_to_string(root.join(&rel)) else { continue };
        let note = rel.to_string_lossy().trim_end_matches(".md").to_string();
        let mut in_block: Option<bool> = None; // Some(is_shell)
        let mut cont = String::new();
        for l in text.lines() {
            let t = l.trim();
            if let Some(lang) = t.strip_prefix("```") {
                in_block = match in_block {
                    Some(_) => None,
                    None => Some(SHELL_LANGS.contains(&lang.trim().to_lowercase().as_str())),
                };
                continue;
            }
            let cmd = match in_block {
                Some(true) => t.strip_prefix("$ ").unwrap_or(t),
                Some(false) => continue,
                // outside code: only explicit "$ cmd" or `cmd` lines that start with a known tool
                None => match t.strip_prefix("$ ") {
                    Some(c) => c,
                    None => continue,
                },
            };
            if cmd.is_empty() || cmd.starts_with('#') {
                continue;
            }
            // join "\" continuations
            if let Some(part) = cmd.strip_suffix('\\') {
                cont += part.trim_end();
                cont.push(' ');
                continue;
            }
            let full = format!("{cont}{cmd}");
            cont.clear();
            if full.len() >= 3 && full.len() <= 400 {
                out.push((full, note.clone()));
            }
        }
    }
    out
}

async fn index() -> Index {
    let root = vault().await.ok();
    let key = root.as_ref().map(|r| r.to_string_lossy().into_owned()).unwrap_or_default();
    if let Some((at, k, idx)) = CACHE.lock().unwrap().as_ref() {
        if *k == key && at.elapsed() < Duration::from_secs(30) {
            return idx.clone();
        }
    }
    let idx = tauri::async_runtime::spawn_blocking(move || {
        let mut history: HashMap<String, (u32, usize)> = HashMap::new();
        for (i, c) in shell_history().into_iter().enumerate() {
            let e = history.entry(c).or_insert((0, 0));
            e.0 += 1;
            e.1 = i;
        }
        Index { history, notes: root.map(|r| note_commands(&r)).unwrap_or_default() }
    })
    .await
    .unwrap_or_default();
    *CACHE.lock().unwrap() = Some((Instant::now(), key, idx.clone()));
    idx
}

fn tokens(s: &str) -> Vec<String> {
    s.to_lowercase().split(|c: char| !c.is_alphanumeric() && c != '-' && c != '_' && c != '.').filter(|t| t.chars().count() >= 2).map(str::to_string).collect()
}

/// Commands from notes (and history) most related to a request in plain words.
pub async fn related(query: &str, n: usize) -> Vec<String> {
    let idx = index().await;
    let q = tokens(query);
    if q.is_empty() {
        return Vec::new();
    }
    let score = |cmd: &str| {
        let ct = tokens(cmd);
        q.iter().filter(|t| ct.iter().any(|c| c == *t || (t.chars().count() >= 4 && c.starts_with(t.as_str())))).count()
    };
    let mut scored: Vec<(usize, String)> = idx.notes.iter().map(|(c, _)| (score(c) * 2, c.clone())).chain(idx.history.keys().map(|c| (score(c), c.clone()))).filter(|(s, _)| *s > 0).collect();
    scored.sort_by_key(|a| std::cmp::Reverse(a.0));
    let mut out: Vec<String> = Vec::new();
    for (_, c) in scored {
        if !out.contains(&c) {
            out.push(c);
        }
        if out.len() >= n {
            break;
        }
    }
    out
}

#[derive(Serialize)]
pub struct Suggestion {
    command: String,
    /// "history" | "notes"
    source: String,
    note: Option<String>,
}

/// Completions for what is typed so far: history first (frequent + recent), then notes.
#[tauri::command]
pub async fn cmd_suggest(prefix: String, limit: Option<usize>) -> Vec<Suggestion> {
    if prefix.trim().len() < 2 {
        return Vec::new();
    }
    let idx = index().await;
    let mut hist: Vec<(&String, &(u32, usize))> = idx.history.iter().filter(|(c, _)| c.starts_with(&prefix) && c.len() > prefix.len()).collect();
    // frequency matters, recency more
    hist.sort_by(|a, b| (b.1 .1 as f64 + b.1 .0 as f64 * 50.0).total_cmp(&(a.1 .1 as f64 + a.1 .0 as f64 * 50.0)));
    let mut out: Vec<Suggestion> = hist.into_iter().map(|(c, _)| Suggestion { command: c.clone(), source: "history".into(), note: None }).collect();
    for (c, note) in &idx.notes {
        if c.starts_with(&prefix) && c.len() > prefix.len() && !out.iter().any(|s| &s.command == c) {
            out.push(Suggestion { command: c.clone(), source: "notes".into(), note: Some(note.clone()) });
        }
    }
    out.truncate(limit.unwrap_or(8));
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn notes_parse() {
        let dir = std::env::temp_dir().join(format!("opsdeck-cmdindex-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("k8s.md"), "# k8s\n```bash\nkubectl -n stage rollout restart deploy/api\nhelm upgrade app ./chart \\\n  -f values.yaml\n```\n```yaml\nkind: Pod\n```\n$ ssh bastion\n").unwrap();
        let cmds: Vec<String> = super::note_commands(&dir).into_iter().map(|(c, _)| c).collect();
        assert_eq!(cmds, vec!["kubectl -n stage rollout restart deploy/api", "helm upgrade app ./chart -f values.yaml", "ssh bastion"]);
        std::fs::remove_dir_all(&dir).ok();
    }
}
