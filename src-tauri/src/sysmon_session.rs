//! Monitoring board on Windows: one long-lived ssh per host instead of a full login on every poll.
//!
//! Windows OpenSSH has no ControlMaster (PowerShell/Win32-OpenSSH#405), so `ssh host PROBE` would
//! log in anew on every refresh: key exchange and authentication on both sides, a line in the
//! server's auth log each time. Here ssh runs a small loop on the remote side instead: every line
//! written to its stdin produces one sample followed by [`END`]. The session ends itself after
//! [`IDLE`] without requests — the same 2 minutes as `ControlPersist=120` elsewhere — or when
//! anything goes wrong; the next request then opens a new one.

use std::{
    collections::HashMap,
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{mpsc, oneshot},
};

/// Line that closes one sample in the output stream.
pub const END: &str = "#opsdeck-probe-end#";
pub const IDLE: Duration = Duration::from_secs(120);
/// ssh's stderr kept for the error message (the tail is what explains the failure).
const STDERR_KEEP: usize = 4096;

/// The remote command: `probe` once per line read from stdin. Run by `sh` explicitly, because the
/// login shell may be fish or csh, where `while … do … done` is not valid; the quoting below is
/// understood by sh, bash, zsh, fish and csh alike as long as `probe` has no `!` (csh expands
/// history even inside single quotes), no backslashes (fish unescapes `\\` there) and no newlines.
/// EOF on stdin (the app closed the session or exited) ends the loop, and ssh with it.
pub fn remote_loop(probe: &str) -> String {
    let body = format!("while read -r req; do {probe}; echo '{END}'; done");
    format!("sh -c '{}'", body.replace('\'', r"'\''"))
}

pub enum Failure {
    /// ssh ended (could not log in, connection lost, the remote side is not a POSIX shell…):
    /// its stderr since the last good sample
    Exited(String),
    /// no complete sample within the timeout; the session was killed
    Timeout,
    Other(String),
}

type Reply = oneshot::Sender<Result<String, Failure>>;

pub struct Sessions {
    map: Mutex<HashMap<String, mpsc::Sender<Reply>>>,
    idle: Duration,
}

impl Default for Sessions {
    fn default() -> Self {
        Self::with_idle(IDLE)
    }
}

impl Sessions {
    fn with_idle(idle: Duration) -> Self {
        Self {
            map: Mutex::default(),
            idle,
        }
    }

    /// One sample from the session `key`, opening it with `cmd` (the whole ssh command, its remote
    /// command being [`remote_loop`]) if there is none.
    pub async fn sample(
        &self,
        key: &str,
        cmd: impl Fn() -> Command,
        timeout: Duration,
    ) -> Result<String, Failure> {
        // the session may end (idle, error) between taking its sender and the request reaching it;
        // then the request is dropped unanswered and a fresh session gets it
        for _ in 0..2 {
            let tx = {
                let mut map = self.map.lock().unwrap();
                match map.get(key) {
                    Some(tx) if !tx.is_closed() => tx.clone(),
                    _ => {
                        map.retain(|_, tx| !tx.is_closed());
                        let (tx, rx) = mpsc::channel(1);
                        tauri::async_runtime::spawn(run(cmd(), rx, timeout, self.idle));
                        map.insert(key.to_string(), tx.clone());
                        log::info!("monitor: ssh session opened ({} open)", map.len());
                        tx
                    }
                }
            };
            let (reply, answer) = oneshot::channel();
            if tx.send(reply).await.is_err() {
                continue;
            }
            if let Ok(res) = answer.await {
                return res;
            }
        }
        Err(Failure::Other(
            "ssh-сессия закрылась во время опроса — повторите".into(),
        ))
    }

    #[cfg(test)]
    fn open(&self) -> usize {
        self.map
            .lock()
            .unwrap()
            .values()
            .filter(|tx| !tx.is_closed())
            .count()
    }
}

/// The requester gave up (its command future was dropped): there is nobody to tell.
fn answer(reply: Reply, res: Result<String, Failure>) {
    if reply.send(res).is_err() {
        log::debug!("monitor: sample ready but nobody waits for it");
    }
}

async fn run(mut cmd: Command, mut rx: mpsc::Receiver<Reply>, timeout: Duration, idle: Duration) {
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let spawned = cmd
        .spawn()
        .map_err(|e| format!("ssh: {e}"))
        .and_then(|mut child| {
            match (child.stdin.take(), child.stdout.take(), child.stderr.take()) {
                (Some(i), Some(o), Some(e)) => Ok((child, i, BufReader::new(o), e)),
                _ => Err("ssh: no pipes".to_string()),
            }
        });
    let (mut child, mut stdin, mut stdout, stderr) = match spawned {
        Ok(s) => s,
        Err(e) => {
            if let Some(reply) = rx.recv().await {
                answer(reply, Err(Failure::Other(e)));
            }
            return;
        }
    };
    // drained all the time: a full pipe would stall ssh (and the remote commands' stderr goes here too)
    let errbuf = Arc::new(Mutex::new(Vec::<u8>::new()));
    let drain = tauri::async_runtime::spawn(drain_stderr(stderr, errbuf.clone()));

    loop {
        let reply = match tokio::time::timeout(idle, rx.recv()).await {
            Ok(Some(reply)) => reply,
            Ok(None) => break,
            Err(_) => {
                log::info!(
                    "monitor: ssh session closed after {} s without polls",
                    idle.as_secs()
                );
                break;
            }
        };
        match tokio::time::timeout(timeout, exchange(&mut stdin, &mut stdout)).await {
            Ok(Ok(text)) => {
                // cleared only here: ssh may die before the first request, and what it said then
                // is the answer to that request
                errbuf.lock().unwrap().clear();
                answer(reply, Ok(text));
            }
            Ok(Err(why)) => {
                // ssh is ending: let it finish writing stderr, which says why
                match tokio::time::timeout(Duration::from_secs(3), child.wait()).await {
                    Ok(Ok(_)) => {}
                    Ok(Err(e)) => log::warn!("monitor: waiting for ssh: {e}"),
                    Err(_) => kill(&mut child).await,
                }
                if tokio::time::timeout(Duration::from_secs(1), drain)
                    .await
                    .is_err()
                {
                    log::warn!("monitor: ssh stderr still open after exit");
                }
                let e = String::from_utf8_lossy(&errbuf.lock().unwrap()).into_owned();
                log::info!("monitor: ssh session ended ({why})");
                answer(reply, Err(Failure::Exited(e)));
                return;
            }
            Err(_) => {
                // a half-read sample would shift every later answer: never reuse the stream
                kill(&mut child).await;
                log::info!(
                    "monitor: ssh session killed: no sample in {} s",
                    timeout.as_secs()
                );
                answer(reply, Err(Failure::Timeout));
                return;
            }
        }
    }
    // EOF on stdin ends the remote loop and ssh exits by itself (the server sees a clean close)
    drop(stdin);
    match tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
        Ok(Ok(_)) => {}
        Ok(Err(e)) => log::warn!("monitor: waiting for ssh: {e}"),
        Err(_) => {
            log::warn!("monitor: ssh did not exit 5 s after its stdin closed, killing it");
            kill(&mut child).await;
        }
    }
}

/// Ask for one sample and read it up to [`END`]. Err — the stream ended (ssh exited).
async fn exchange(
    stdin: &mut ChildStdin,
    stdout: &mut BufReader<ChildStdout>,
) -> Result<String, String> {
    stdin
        .write_all(b"\n")
        .await
        .map_err(|e| format!("write: {e}"))?;
    stdin.flush().await.map_err(|e| format!("write: {e}"))?;
    let mut text = String::new();
    let mut line = String::new();
    loop {
        line.clear();
        if stdout
            .read_line(&mut line)
            .await
            .map_err(|e| format!("read: {e}"))?
            == 0
        {
            return Err("ssh exited".into());
        }
        if line.trim_end() == END {
            return Ok(text);
        }
        text.push_str(&line);
    }
}

async fn drain_stderr(mut stderr: tokio::process::ChildStderr, buf: Arc<Mutex<Vec<u8>>>) {
    let mut chunk = [0u8; 1024];
    loop {
        match stderr.read(&mut chunk).await {
            Ok(0) => return,
            Ok(n) => {
                let mut b = buf.lock().unwrap();
                b.extend_from_slice(&chunk[..n]);
                let extra = b.len().saturating_sub(STDERR_KEEP);
                b.drain(..extra);
            }
            Err(e) => {
                log::warn!("monitor: reading ssh stderr: {e}");
                return;
            }
        }
    }
}

async fn kill(child: &mut Child) {
    if let Err(e) = child.kill().await {
        log::warn!("monitor: killing ssh: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Stands in for `ssh host <remote_loop>`: the same loop, run by a local sh.
    fn local(script: String, spawned: Arc<AtomicUsize>) -> impl Fn() -> Command {
        move || {
            spawned.fetch_add(1, Ordering::SeqCst);
            let mut c = Command::new("sh");
            c.args(["-c", &script]);
            c
        }
    }

    fn text(r: Result<String, Failure>) -> String {
        match r {
            Ok(t) => t,
            Err(Failure::Exited(e)) => panic!("exited: {e}"),
            Err(Failure::Timeout) => panic!("timeout"),
            Err(Failure::Other(e)) => panic!("{e}"),
        }
    }

    #[test]
    fn remote_loop_quoting_survives_sh() {
        let probe = "echo a; echo ---; cut -d' ' -f1 /proc/uptime | grep -E '^[0-9]'";
        let cmd = remote_loop(probe);
        assert!(cmd.starts_with("sh -c '") && cmd.ends_with('\''));
        // what the login shell does with the remote command: one more level of sh
        let out = std::process::Command::new("sh")
            .args(["-c", &format!("printf '\\n\\n' | {cmd}")])
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let out = String::from_utf8_lossy(&out.stdout);
        assert_eq!(
            out.matches(END).count(),
            2,
            "one sample per request line:\n{out}"
        );
        assert!(out.starts_with("a\n---\n"), "{out}");
    }

    #[test]
    fn one_process_serves_many_samples() {
        tauri::async_runtime::block_on(async {
            let spawned = Arc::new(AtomicUsize::new(0));
            let s = Sessions::default();
            let cmd = local(remote_loop("echo n=$$; date +%N"), spawned.clone());
            let first = text(s.sample("h", &cmd, Duration::from_secs(5)).await);
            for _ in 0..5 {
                let again = text(s.sample("h", &cmd, Duration::from_secs(5)).await);
                assert_eq!(
                    first.lines().next(),
                    again.lines().next(),
                    "same remote shell"
                );
                assert_ne!(first, again, "a fresh sample each time");
            }
            assert_eq!(spawned.load(Ordering::SeqCst), 1, "one ssh for six polls");
            text(s.sample("other", &cmd, Duration::from_secs(5)).await);
            assert_eq!(
                (spawned.load(Ordering::SeqCst), s.open()),
                (2, 2),
                "a session per host"
            );
        });
    }

    #[test]
    fn idle_session_closes_and_reopens() {
        tauri::async_runtime::block_on(async {
            let spawned = Arc::new(AtomicUsize::new(0));
            let s = Sessions::with_idle(Duration::from_millis(300));
            let cmd = local(remote_loop("echo x"), spawned.clone());
            assert_eq!(
                text(s.sample("h", &cmd, Duration::from_secs(5)).await),
                "x\n"
            );
            tokio::time::sleep(Duration::from_millis(800)).await;
            assert_eq!(s.open(), 0, "closed after the idle time");
            assert_eq!(
                text(s.sample("h", &cmd, Duration::from_secs(5)).await),
                "x\n"
            );
            assert_eq!(spawned.load(Ordering::SeqCst), 2);
        });
    }

    #[test]
    fn failed_login_reports_stderr_and_next_poll_retries() {
        tauri::async_runtime::block_on(async {
            let spawned = Arc::new(AtomicUsize::new(0));
            let s = Sessions::default();
            let cmd = local(
                "echo 'user@host: Permission denied (publickey).' >&2; exit 255".into(),
                spawned.clone(),
            );
            for n in 1..=2 {
                match s.sample("h", &cmd, Duration::from_secs(5)).await {
                    Err(Failure::Exited(e)) => assert!(e.contains("Permission denied"), "{e}"),
                    _ => panic!("expected the ssh error"),
                }
                assert_eq!(
                    spawned.load(Ordering::SeqCst),
                    n,
                    "a dead session is not reused"
                );
            }
        });
    }

    #[test]
    fn stderr_of_ssh_dead_before_the_request_is_kept() {
        tauri::async_runtime::block_on(async {
            let mut cmd = Command::new("sh");
            cmd.args([
                "-c",
                "echo 'user@host: Permission denied (publickey).' >&2; exit 255",
            ]);
            let (tx, rx) = mpsc::channel(1);
            let session =
                tauri::async_runtime::spawn(run(cmd, rx, Duration::from_secs(5), IDLE));
            // ssh has exited and its stderr has been read before the poll comes
            tokio::time::sleep(Duration::from_millis(300)).await;
            let (reply, answer) = oneshot::channel();
            tx.send(reply).await.unwrap();
            match answer.await.unwrap() {
                Err(Failure::Exited(e)) => assert!(e.contains("Permission denied"), "{e:?}"),
                _ => panic!("expected the ssh error"),
            }
            session.await.unwrap();
        });
    }

    #[test]
    fn hung_sample_kills_the_session() {
        tauri::async_runtime::block_on(async {
            let spawned = Arc::new(AtomicUsize::new(0));
            let s = Sessions::default();
            // the first sample hangs half-way, the next session answers
            let marker =
                std::env::temp_dir().join(format!("opsdeck-mon-hang-{}", std::process::id()));
            if let Err(e) = std::fs::remove_file(&marker) {
                assert_eq!(e.kind(), std::io::ErrorKind::NotFound, "{e}");
            }
            let probe = format!(
                "echo partial; if [ -e {m} ]; then echo ok; else touch {m}; sleep 5; fi",
                m = marker.display()
            );
            let cmd = local(remote_loop(&probe), spawned.clone());
            assert!(matches!(
                s.sample("h", &cmd, Duration::from_millis(500)).await,
                Err(Failure::Timeout)
            ));
            assert_eq!(
                text(s.sample("h", &cmd, Duration::from_secs(5)).await),
                "partial\nok\n",
                "no leftovers of the killed one"
            );
            assert_eq!(spawned.load(Ordering::SeqCst), 2);
            std::fs::remove_file(&marker).unwrap();
        });
    }
}
