//! Commands the user already knows: shell history (bash/zsh) and commands written down in the
//! notes (```bash blocks and `$ cmd` lines). Feeds the inline suggestion in the terminal and the
//! local AI's context. Shared, not copied, by every request; checked at most every 30 s in the
//! background, and only the history and notes whose mtime or size changed are read again.

use crate::notes::{vault, walk};
use serde::Serialize;
use std::{
    collections::HashMap,
    fs, io,
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, Mutex},
    time::{Duration, Instant, SystemTime},
};

#[derive(Default)]
struct Index {
    /// command → (times used, last position: bigger = more recent)
    history: Arc<HashMap<String, (u32, usize)>>,
    /// command → note it came from
    notes: Arc<Vec<(String, String)>>,
}

/// Where the commands come from.
#[derive(Clone, PartialEq)]
struct Sources {
    /// bash, zsh, fish
    shells: Vec<PathBuf>,
    /// PowerShell (PSReadLine): its own format
    powershell: Option<PathBuf>,
    vault: Option<PathBuf>,
}

impl Sources {
    fn current(vault: Option<PathBuf>) -> Self {
        let shells = dirs::home_dir().map(|h| [".bash_history", ".zsh_history", ".local/share/fish/fish_history"].iter().map(|f| h.join(f)).collect()).unwrap_or_default();
        let powershell = if cfg!(windows) {
            dirs::data_dir().map(|d| d.join("Microsoft/Windows/PowerShell/PSReadLine/ConsoleHost_history.txt"))
        } else {
            dirs::data_dir().map(|d| d.join("powershell/PSReadLine/ConsoleHost_history.txt"))
        };
        Sources { shells, powershell, vault }
    }
}

/// What a file looked like when it was read: (mtime, size); `None` — there is no such file.
type Stamp = Option<(SystemTime, u64)>;

fn stamp(p: &Path) -> Stamp {
    match fs::metadata(p).and_then(|m| Ok((m.modified()?, m.len()))) {
        Ok(s) => Some(s),
        Err(e) if e.kind() == io::ErrorKind::NotFound => None,
        Err(e) => {
            log::warn!("command hints: cannot stat {}: {e}", p.display());
            None
        }
    }
}

/// A history file; `None` when there is none (most users have only one shell's).
fn read_history(p: &Path) -> Option<String> {
    match fs::read(p) {
        Ok(bytes) => Some(String::from_utf8_lossy(&bytes).into_owned()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => None,
        Err(e) => {
            log::warn!("command hints: cannot read {}: {e}", p.display());
            None
        }
    }
}

fn shell_history(src: &Sources) -> Vec<String> {
    let mut out = Vec::new();
    for f in &src.shells {
        let Some(text) = read_history(f) else { continue };
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
    if let Some(text) = src.powershell.as_deref().and_then(read_history) {
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

fn note_commands(text: &str) -> Vec<String> {
    let mut out = Vec::new();
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
            out.push(full);
        }
    }
    out
}

/// What the last build read, so the next one reads only what changed. Used by one build at a time.
#[derive(Default)]
struct Builder {
    built: Option<Sources>,
    history_stamps: Vec<Stamp>,
    /// note (relative path) → (stamp, its commands)
    note_files: HashMap<PathBuf, (Stamp, Vec<String>)>,
    /// notes in walk order, as last built
    note_list: Vec<(PathBuf, Stamp)>,
    index: Arc<Index>,
    #[cfg(test)]
    runs: usize,
}

impl Builder {
    /// Index for `src`; the same `Arc` when nothing changed since the last build.
    fn update(&mut self, src: &Sources) -> Arc<Index> {
        #[cfg(test)]
        {
            self.runs += 1;
        }
        let first = self.built.as_ref() != Some(src);
        if self.built.as_ref().is_some_and(|b| b.vault != src.vault) {
            self.note_files.clear();
            self.note_list.clear();
        }

        let history_stamps: Vec<Stamp> = src.shells.iter().chain(&src.powershell).map(|p| stamp(p)).collect();
        let history = if first || history_stamps != self.history_stamps {
            let mut history: HashMap<String, (u32, usize)> = HashMap::new();
            for (i, c) in shell_history(src).into_iter().enumerate() {
                let e = history.entry(c).or_insert((0, 0));
                e.0 += 1;
                e.1 = i;
            }
            self.history_stamps = history_stamps;
            Some(Arc::new(history))
        } else {
            None
        };

        let mut note_list = Vec::new();
        if let Some(root) = &src.vault {
            let mut files = Vec::new();
            walk(root, root, &mut files);
            for rel in files {
                let st = stamp(&root.join(&rel));
                if st.is_none() {
                    continue; // deleted while walking, or not stat-able (warned)
                }
                note_list.push((rel, st));
            }
        }
        let notes = if first || note_list != self.note_list {
            let root = src.vault.as_deref().unwrap_or(Path::new(""));
            // notes that are gone stay behind in `old` and are dropped with it
            let mut old = std::mem::take(&mut self.note_files);
            let mut notes = Vec::new();
            for (rel, st) in &note_list {
                let cmds = match old.remove(rel) {
                    Some((s, cmds)) if s == *st => cmds,
                    _ => match fs::read_to_string(root.join(rel)) {
                        Ok(text) => note_commands(&text),
                        Err(e) => {
                            // kept with its stamp: not read again until the file changes
                            log::warn!("command hints: cannot read note {}: {e}", rel.display());
                            Vec::new()
                        }
                    },
                };
                let name = rel.to_string_lossy().trim_end_matches(".md").to_string();
                notes.extend(cmds.iter().map(|c| (c.clone(), name.clone())));
                self.note_files.insert(rel.clone(), (*st, cmds));
            }
            self.note_list = note_list;
            Some(Arc::new(notes))
        } else {
            None
        };

        if history.is_some() || notes.is_some() {
            self.index = Arc::new(Index { history: history.unwrap_or_else(|| self.index.history.clone()), notes: notes.unwrap_or_else(|| self.index.notes.clone()) });
        }
        self.built = Some(src.clone());
        self.index.clone()
    }
}

struct Published {
    sources: Option<Sources>,
    index: Arc<Index>,
    checked: Instant,
    /// a background check is running
    refreshing: bool,
    #[cfg(test)]
    spawned: usize,
}

struct IndexCache {
    ttl: Duration,
    published: Mutex<Published>,
    /// held while building: builds go one at a time
    builder: Mutex<Builder>,
}

static CACHE: LazyLock<IndexCache> = LazyLock::new(|| IndexCache::new(Duration::from_secs(30)));

/// Clears `refreshing` even if the build panicked, so the next request can try again.
struct RefreshGuard(&'static IndexCache);

impl Drop for RefreshGuard {
    fn drop(&mut self) {
        self.0.published.lock().unwrap().refreshing = false;
    }
}

impl IndexCache {
    fn new(ttl: Duration) -> Self {
        IndexCache { ttl, published: Mutex::new(Published { sources: None, index: Arc::default(), checked: Instant::now(), refreshing: false, #[cfg(test)] spawned: 0 }), builder: Mutex::new(Builder::default()) }
    }

    /// The index for `src`. Waits only when there is none for these sources yet (first request,
    /// another vault); an old one is returned at once and checked for changes in the background.
    async fn get(&'static self, src: Sources) -> Arc<Index> {
        {
            let mut p = self.published.lock().unwrap();
            if p.sources.as_ref() == Some(&src) {
                if p.checked.elapsed() >= self.ttl && !p.refreshing {
                    p.refreshing = true;
                    #[cfg(test)]
                    {
                        p.spawned += 1;
                    }
                    let job = tauri::async_runtime::spawn_blocking(move || {
                        let _guard = RefreshGuard(self);
                        self.build(&src, true);
                    });
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) = job.await {
                            log::warn!("command hints: background index update failed: {e}");
                        }
                    });
                }
                return p.index.clone();
            }
        }
        match tauri::async_runtime::spawn_blocking(move || self.build(&src, false)).await {
            Ok(idx) => idx,
            Err(e) => {
                log::warn!("command hints: building the index failed: {e}");
                Arc::default()
            }
        }
    }

    fn build(&self, src: &Sources, background: bool) -> Arc<Index> {
        let mut b = self.builder.lock().unwrap();
        {
            let p = self.published.lock().unwrap();
            let same = p.sources.as_ref() == Some(src);
            // requests that waited for the same first build, or a check for sources no longer used
            if (same && !background && p.checked.elapsed() < self.ttl) || (background && !same) {
                return p.index.clone();
            }
        }
        let idx = b.update(src);
        let mut p = self.published.lock().unwrap();
        p.sources = Some(src.clone());
        p.index = idx.clone();
        p.checked = Instant::now();
        idx
    }
}

async fn index() -> Arc<Index> {
    CACHE.get(Sources::current(vault().await.ok())).await
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

fn suggest(idx: &Index, prefix: &str, limit: usize) -> Vec<Suggestion> {
    let mut hist: Vec<(&String, &(u32, usize))> = idx.history.iter().filter(|(c, _)| c.starts_with(prefix) && c.len() > prefix.len()).collect();
    // frequency matters, recency more
    hist.sort_by(|a, b| (b.1 .1 as f64 + b.1 .0 as f64 * 50.0).total_cmp(&(a.1 .1 as f64 + a.1 .0 as f64 * 50.0)));
    let mut out: Vec<Suggestion> = hist.into_iter().map(|(c, _)| Suggestion { command: c.clone(), source: "history".into(), note: None }).collect();
    for (c, note) in idx.notes.iter() {
        if c.starts_with(prefix) && c.len() > prefix.len() && !out.iter().any(|s| &s.command == c) {
            out.push(Suggestion { command: c.clone(), source: "notes".into(), note: Some(note.clone()) });
        }
    }
    out.truncate(limit);
    out
}

/// Completions for what is typed so far: history first (frequent + recent), then notes.
#[tauri::command]
pub async fn cmd_suggest(prefix: String, limit: Option<usize>) -> Vec<Suggestion> {
    if prefix.trim().len() < 2 {
        return Vec::new();
    }
    let idx = index().await;
    suggest(&idx, &prefix, limit.unwrap_or(8))
}

#[cfg(test)]
mod tests {
    use super::{Builder, Index, IndexCache, Sources};
    use std::{
        collections::HashMap,
        fs,
        path::PathBuf,
        sync::Arc,
        time::{Duration, Instant},
    };

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("opsdeck-cmdindex-{name}-{}", std::process::id()));
        if d.exists() {
            fs::remove_dir_all(&d).unwrap();
        }
        fs::create_dir_all(d.join("vault")).unwrap();
        d
    }

    fn sources(d: &std::path::Path) -> Sources {
        Sources { shells: vec![d.join(".bash_history")], powershell: None, vault: Some(d.join("vault")) }
    }

    fn cache(ttl: Duration) -> &'static IndexCache {
        Box::leak(Box::new(IndexCache::new(ttl)))
    }

    fn get(c: &'static IndexCache, src: &Sources) -> Arc<Index> {
        // a request that waits for a build fails the test instead of hanging it
        tauri::async_runtime::block_on(async { tokio::time::timeout(Duration::from_secs(5), c.get(src.clone())).await.expect("request waited for the build") })
    }

    fn wait_refreshed(c: &IndexCache) {
        let t = Instant::now();
        while c.published.lock().unwrap().refreshing {
            assert!(t.elapsed() < Duration::from_secs(10), "background update did not finish");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn notes(idx: &Index) -> Vec<&str> {
        idx.notes.iter().map(|(c, _)| c.as_str()).collect()
    }

    #[test]
    fn notes_parse() {
        let d = dir("parse");
        fs::write(d.join("vault/k8s.md"), "# k8s\n```bash\nkubectl -n stage rollout restart deploy/api\nhelm upgrade app ./chart \\\n  -f values.yaml\n```\n```yaml\nkind: Pod\n```\n$ ssh bastion\n").unwrap();
        let idx = Builder::default().update(&sources(&d));
        assert_eq!(notes(&idx), vec!["kubectl -n stage rollout restart deploy/api", "helm upgrade app ./chart -f values.yaml", "ssh bastion"]);
        assert!(idx.notes.iter().all(|(_, n)| n == "k8s"));
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn suggest_order() {
        let history: HashMap<String, (u32, usize)> = [
            ("git status", (1, 10)),
            ("git stash pop", (3, 5)),   // 155: frequency outweighs the newer "git status"
            ("git switch main", (1, 90)), // 140
            ("git", (5, 99)),             // not longer than the prefix
            ("ls -la", (9, 98)),
        ]
        .into_iter()
        .map(|(c, v)| (c.to_string(), v))
        .collect();
        let notes = vec![("git status".to_string(), "a".to_string()), ("git log --oneline".to_string(), "b".to_string()), ("git log --oneline".to_string(), "c".to_string())];
        let idx = Index { history: Arc::new(history), notes: Arc::new(notes) };
        let got: Vec<(String, String, Option<String>)> = super::suggest(&idx, "git", 8).into_iter().map(|s| (s.command, s.source, s.note)).collect();
        let want = [("git stash pop", "history", None), ("git switch main", "history", None), ("git status", "history", None), ("git log --oneline", "notes", Some("b"))];
        assert_eq!(got, want.map(|(c, s, n)| (c.to_string(), s.to_string(), n.map(str::to_string))).to_vec());
        assert_eq!(super::suggest(&idx, "git", 2).len(), 2);
        assert!(super::suggest(&idx, "kubectl", 8).is_empty());
    }

    #[test]
    fn requests_share_the_index() {
        let d = dir("share");
        fs::write(d.join(".bash_history"), "ls -la\ngit status\n").unwrap();
        let c = cache(Duration::from_secs(3600));
        let src = sources(&d);
        let a = get(c, &src);
        let b = get(c, &src);
        assert!(Arc::ptr_eq(&a, &b), "a request must not copy the index");
        assert_eq!(a.history.len(), 2);
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn stale_index_is_served_while_one_update_runs() {
        let d = dir("stale");
        fs::write(d.join(".bash_history"), "ls -la\n").unwrap();
        let c = cache(Duration::ZERO);
        let src = sources(&d);
        let old = get(c, &src);
        fs::write(d.join(".bash_history"), "ls -la\ngit status\n").unwrap();
        {
            // a long build: requests meanwhile get the old index at once and start no more builds
            let building = c.builder.lock().unwrap();
            for _ in 0..20 {
                assert!(Arc::ptr_eq(&get(c, &src), &old));
            }
            assert_eq!(c.published.lock().unwrap().spawned, 1);
            assert_eq!(building.runs, 1);
        }
        wait_refreshed(c);
        assert_eq!(c.builder.lock().unwrap().runs, 2);
        let new = get(c, &src);
        assert!(new.history.contains_key("git status"));
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn update_reads_only_what_changed() {
        let d = dir("mtime");
        let v = d.join("vault");
        fs::write(d.join(".bash_history"), "ls -la\n").unwrap();
        fs::write(v.join("a.md"), "$ ssh alpha\n").unwrap();
        fs::write(v.join("b.md"), "$ ssh bravo\n").unwrap();
        fs::write(v.join("c.md"), "$ ssh charlie\n").unwrap();
        let src = sources(&d);
        let mut b = Builder::default();
        let first = b.update(&src);
        assert!(Arc::ptr_eq(&first, &b.update(&src)), "nothing changed — the same index");

        // same size and mtime: taken as unchanged, not read again
        let mtime = fs::metadata(v.join("a.md")).unwrap().modified().unwrap();
        fs::write(v.join("a.md"), "$ ssh ALPHA\n").unwrap();
        fs::File::options().write(true).open(v.join("a.md")).unwrap().set_modified(mtime).unwrap();
        // changed, added, deleted
        fs::write(v.join("b.md"), "$ ssh bravo2\n").unwrap();
        fs::write(v.join("d.md"), "$ ssh delta\n").unwrap();
        fs::remove_file(v.join("c.md")).unwrap();
        let idx = b.update(&src);
        let mut got = notes(&idx);
        got.sort();
        assert_eq!(got, vec!["ssh alpha", "ssh bravo2", "ssh delta"]);
        assert!(Arc::ptr_eq(&idx.history, &first.history), "history did not change — not read again");

        fs::write(d.join(".bash_history"), "ls -la\ngit status\n").unwrap();
        let idx2 = b.update(&src);
        assert!(idx2.history.contains_key("git status"));
        assert!(Arc::ptr_eq(&idx2.notes, &idx.notes), "notes did not change — not rebuilt");
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn another_vault_is_built_before_answering() {
        let d1 = dir("vault1");
        let d2 = dir("vault2");
        fs::write(d1.join("vault/n.md"), "$ ssh one\n").unwrap();
        fs::write(d2.join("vault/n.md"), "$ ssh two\n").unwrap();
        let c = cache(Duration::from_secs(3600));
        assert_eq!(notes(&get(c, &sources(&d1))), vec!["ssh one"]);
        assert_eq!(notes(&get(c, &sources(&d2))), vec!["ssh two"]);
        fs::remove_dir_all(&d1).unwrap();
        fs::remove_dir_all(&d2).unwrap();
    }
}
