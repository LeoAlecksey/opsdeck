//! PTY sessions: the terminal tabs and the AI side panel (claude, codex, ...) both run here.

use base64::{engine::general_purpose::STANDARD, Engine};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Deserialize;
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::Mutex,
};
use tauri::{AppHandle, Emitter, Manager, State};

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    recorder: Recorder,
}

/// Session log shared with the reader thread; `None` while not recording.
type Recorder = std::sync::Arc<Mutex<Option<Recording>>>;

struct Recording {
    file: std::io::BufWriter<std::fs::File>,
    path: std::path::PathBuf,
}

impl Recording {
    /// Terminal output → readable text: escape sequences removed, CRLF → LF, bare CR dropped.
    fn write(&mut self, bytes: &[u8]) {
        let plain = strip_ansi_escapes::strip(bytes);
        let text: Vec<u8> = plain.into_iter().filter(|&b| b != b'\r' && (b >= 0x20 || b == b'\n' || b == b'\t')).collect();
        let _ = self.file.write_all(&text);
        let _ = self.file.flush();
    }
    fn finish(mut self) -> std::path::PathBuf {
        let _ = writeln!(self.file, "\n# --- запись остановлена {} ---", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"));
        let _ = self.file.flush();
        self.path
    }
}

#[derive(Default)]
pub struct PtyState {
    sessions: Mutex<HashMap<String, Session>>,
}

#[derive(Deserialize)]
pub struct SpawnRequest {
    id: String,
    program: Option<String>,
    args: Option<Vec<String>>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    cols: u16,
    rows: u16,
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[tauri::command]
pub fn pty_spawn(app: AppHandle, state: State<PtyState>, req: SpawnRequest) -> Result<(), String> {
    let pair = native_pty_system()
        .openpty(PtySize { rows: req.rows, cols: req.cols, pixel_width: 0, pixel_height: 0 })
        .map_err(err)?;

    let plain_shell = req.program.is_none();
    let program = req
        .program
        .unwrap_or_else(default_shell);
    let mut cmd = CommandBuilder::new(&program);
    if plain_shell {
        // best effort: without integration the tab still works, just without command blocks
        let _ = shell_integration(&program, &mut cmd);
    }
    let is_ssh = std::path::Path::new(&program).file_stem().is_some_and(|n| n == "ssh");
    if is_ssh {
        // lets the resource bar reuse this session's connection (see sysmon.rs)
        cmd.args(crate::sysmon::ssh_master_opts());
    }
    cmd.args(req.args.unwrap_or_default());
    let cwd = req.cwd.map(Into::into).or_else(dirs::home_dir);
    if let Some(cwd) = cwd {
        cmd.cwd(cwd);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "OpsDeck");
    if let Ok(path) = std::env::var("PATH") {
        cmd.env("PATH", path);
    }
    if let Some(port) = crate::ide::port() {
        // lets `claude` started in this terminal find OpsDeck's IDE bridge
        cmd.env("CLAUDE_CODE_SSE_PORT", port.to_string());
        cmd.env("ENABLE_IDE_INTEGRATION", "true");
    }
    if let Some(kc) = crate::k8s::terminal_kubeconfig() {
        cmd.env("KUBECONFIG", kc);
    }
    for (k, v) in req.env.unwrap_or_default() {
        cmd.env(k, v);
    }

    let child = pair.slave.spawn_command(cmd).map_err(err)?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(err)?;
    let writer = pair.master.take_writer().map_err(err)?;

    let id = req.id.clone();
    let recorder: Recorder = Default::default();
    let rec = recorder.clone();
    let ended = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    // the reader and the Windows exit watcher both report the end; only the first one counts
    let finish = {
        let (app, id, rec, ended) = (app.clone(), id.clone(), rec.clone(), ended.clone());
        move || {
            if ended.swap(true, std::sync::atomic::Ordering::SeqCst) {
                return;
            }
            if let Some(r) = rec.lock().unwrap().take() {
                let _ = app.emit(&format!("pty-record-{id}"), r.finish().to_string_lossy().into_owned());
            }
            let _ = app.emit(&format!("pty-exit-{id}"), ());
        }
    };
    if cfg!(windows) {
        watch_exit(app.clone(), id.clone(), finish.clone());
    }
    std::thread::spawn(move || {
        let mut buf = [0u8; 16384];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                // base64 keeps multi-byte UTF-8 sequences split across reads intact
                Ok(n) => {
                    let _ = app.emit(&format!("pty-data-{id}"), STANDARD.encode(&buf[..n]));
                    if let Some(r) = rec.lock().unwrap().as_mut() {
                        r.write(&buf[..n]);
                    }
                }
            }
        }
        finish();
    });

    state
        .sessions
        .lock()
        .unwrap()
        .insert(req.id, Session { master: pair.master, writer, child, recorder });
    Ok(())
}

/// ConPTY keeps the output pipe open after the shell exits (`exit` in PowerShell), so the reader
/// never sees EOF. Poll the child instead; dropping the session closes the pseudo console.
fn watch_exit(app: AppHandle, id: String, finish: impl FnOnce() + Send + 'static) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(300));
        let state = app.state::<PtyState>();
        let mut sessions = state.sessions.lock().unwrap();
        let Some(s) = sessions.get_mut(&id) else { return }; // killed from the UI
        if matches!(s.child.try_wait(), Ok(Some(_))) {
            let s = sessions.remove(&id);
            drop(sessions);
            finish();
            drop(s); // may block until ConPTY flushes: off the lock
            return;
        }
    });
}

/// $SHELL on Unix; PowerShell on Windows.
fn default_shell() -> String {
    #[cfg(windows)]
    return "powershell.exe".into();
    #[cfg(not(windows))]
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into())
}

const BASH_SI: &str = include_str!("../shell/bash-integration.sh");
const ZSH_ENV: &str = include_str!("../shell/zshenv");
const ZSH_RC: &str = include_str!("../shell/zshrc");

/// Hooks OSC 133/7 marks into bash (--rcfile) or zsh (ZDOTDIR) so the UI can build command blocks.
fn shell_integration(program: &str, cmd: &mut CommandBuilder) -> Result<(), String> {
    let dir = crate::store::config_dir()?.join("shell");
    std::fs::create_dir_all(&dir).map_err(err)?;
    match std::path::Path::new(program).file_name().and_then(|n| n.to_str()) {
        Some("bash") => {
            let rc = dir.join("bash-integration.sh");
            std::fs::write(&rc, BASH_SI).map_err(err)?;
            cmd.args(["--rcfile".as_ref(), rc.as_os_str(), "-i".as_ref()]);
        }
        Some("zsh") => {
            let zdir = dir.join("zsh");
            std::fs::create_dir_all(&zdir).map_err(err)?;
            std::fs::write(zdir.join(".zshenv"), ZSH_ENV).map_err(err)?;
            std::fs::write(zdir.join(".zshrc"), ZSH_RC).map_err(err)?;
            if let Ok(orig) = std::env::var("ZDOTDIR") {
                cmd.env("OPSDECK_ORIG_ZDOTDIR", orig);
            }
            cmd.env("OPSDECK_SI_DIR", &zdir);
            cmd.env("ZDOTDIR", &zdir);
            #[cfg(target_os = "macos")]
            cmd.arg("-l");
        }
        _ => return Ok(()),
    }
    cmd.env("OPSDECK_SHELL_INTEGRATION", "1");
    if let Some(cp) = crate::sysmon::control_path() {
        cmd.env("OPSDECK_SSH_CP", cp); // used by the ssh() wrapper in the shell integration
    }
    Ok(())
}

#[tauri::command]
pub fn pty_write(state: State<PtyState>, id: String, data: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    let s = sessions.get_mut(&id).ok_or("no such pty")?;
    s.writer.write_all(data.as_bytes()).map_err(err)
}

#[tauri::command]
pub fn pty_resize(state: State<PtyState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    let s = sessions.get(&id).ok_or("no such pty")?;
    s.master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(err)
}

#[tauri::command]
pub fn pty_kill(state: State<PtyState>, id: String) -> Result<(), String> {
    let session = state.sessions.lock().unwrap().remove(&id);
    // killing waits for the shell to react to SIGHUP (~200 ms): not on the UI thread
    if let Some(mut s) = session {
        std::thread::spawn(move || {
            let _ = s.child.kill();
            let _ = s.child.wait(); // reap: no zombie shells
            drop(s);
        });
    }
    Ok(())
}

fn records_dir() -> Result<std::path::PathBuf, String> {
    let base = dirs::document_dir().or_else(dirs::home_dir).ok_or("no home dir")?;
    let dir = base.join("OpsDeck").join("sessions");
    std::fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir)
}

/// Start writing this terminal's output to a text file; returns its path.
#[tauri::command]
pub fn pty_record_start(state: State<PtyState>, id: String, title: String) -> Result<String, String> {
    let sessions = state.sessions.lock().unwrap();
    let s = sessions.get(&id).ok_or("no such pty")?;
    let mut rec = s.recorder.lock().unwrap();
    if let Some(r) = rec.as_ref() {
        return Ok(r.path.to_string_lossy().into_owned());
    }
    let now = chrono::Local::now();
    let safe: String = title.chars().map(|c| if c.is_alphanumeric() || matches!(c, '-' | '_' | '.') { c } else { '_' }).take(40).collect();
    let path = records_dir()?.join(format!("{}_{}.log", now.format("%Y-%m-%d_%H-%M-%S"), safe.trim_matches('_')));
    let file = std::fs::File::create(&path).map_err(err)?;
    crate::store::restrict(&path, 0o600)?;
    let mut file = std::io::BufWriter::new(file);
    let _ = writeln!(file, "# OpsDeck — запись терминала «{title}», начата {}\n", now.format("%Y-%m-%d %H:%M:%S"));
    *rec = Some(Recording { file, path: path.clone() });
    Ok(path.to_string_lossy().into_owned())
}

/// Stop recording; returns the log path (None if it wasn't recording).
#[tauri::command]
pub fn pty_record_stop(state: State<PtyState>, id: String) -> Option<String> {
    let sessions = state.sessions.lock().unwrap();
    let r = sessions.get(&id)?.recorder.lock().unwrap().take()?;
    Some(r.finish().to_string_lossy().into_owned())
}

#[tauri::command]
pub fn pty_records_open() -> Result<(), String> {
    crate::store::open_with_system(&records_dir()?.to_string_lossy())
}

/// Names the shell can run (commands in PATH, aliases, functions, builtins, keywords) for
/// highlighting the command line as it's typed. Asks the user's shell itself (so aliases from
/// ~/.bashrc / ~/.zshrc count), with a 4 s limit; falls back to scanning PATH.
#[tauri::command]
pub async fn shell_commands() -> Vec<String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut names = from_shell().unwrap_or_default();
        if names.is_empty() {
            names = path_commands();
        }
        names.sort_unstable();
        names.dedup();
        names
    })
    .await
    .unwrap_or_default()
}

#[cfg(unix)]
fn from_shell() -> Option<Vec<String>> {
    use std::{io::Read, process::Stdio, time::Duration};
    let shell = default_shell();
    let script = if shell.ends_with("zsh") {
        "print -rl -- ${(k)commands} ${(k)aliases} ${(k)functions} ${(k)builtins} ${(k)reswords}"
    } else if shell.ends_with("bash") {
        "compgen -c"
    } else {
        return None;
    };
    let mut child = std::process::Command::new(&shell)
        .args(["-ic", script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut out = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = out.read_to_string(&mut s);
        s
    });
    let deadline = std::time::Instant::now() + Duration::from_secs(4);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let text = reader.join().ok()?;
    Some(text.lines().map(str::trim).filter(|l| !l.is_empty()).map(String::from).collect())
}

#[cfg(not(unix))]
fn from_shell() -> Option<Vec<String>> {
    None
}

fn path_commands() -> Vec<String> {
    let exts: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT").unwrap_or(".EXE;.CMD;.BAT;.PS1".into()).split(';').map(|e| e.to_lowercase()).collect()
    } else {
        Vec::new()
    };
    let Some(path) = std::env::var_os("PATH") else { return Vec::new() };
    std::env::split_paths(&path)
        .filter_map(|d| std::fs::read_dir(d).ok())
        .flatten()
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if cfg!(windows) {
                let lower = name.to_lowercase();
                exts.iter().find(|x| lower.ends_with(x.as_str())).map(|x| name[..name.len() - x.len()].to_string())
            } else {
                Some(name)
            }
        })
        .collect()
}
