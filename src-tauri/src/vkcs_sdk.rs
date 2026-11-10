//! Long-lived SDK processes, scoped by CLI installation, configuration and project.
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout},
    sync::Mutex as AsyncMutex,
};

const SCRIPT: &str = include_str!("vkcs_worker.py");
type Slot = Arc<AsyncMutex<Option<Worker>>>;
static WORKERS: OnceLock<Mutex<HashMap<String, Slot>>> = OnceLock::new();

pub fn invalidate(cloud: &str, project: &str) {
    if let Some(workers) = WORKERS.get() {
        let suffix = format!("|{cloud}|{project}");
        workers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|key, _| !key.ends_with(&suffix));
    }
}

struct Worker {
    _child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}

fn python_for(cli: &Path) -> PathBuf {
    if let Some(dir) = cli.parent() {
        // Prefer a pip entry point's own environment over a neighbouring system Python.
        if !cfg!(windows) {
            if let Ok(text) = std::fs::read_to_string(cli) {
                if let Some(path) = text.lines().next().and_then(|s| s.strip_prefix("#!")) {
                    if Path::new(path).is_file() {
                        return path.into();
                    }
                }
            }
        }
        let candidates = if cfg!(windows) {
            vec![dir.join("python.exe"), dir.join("../python.exe")]
        } else {
            vec![dir.join("python3"), dir.join("python")]
        };
        if let Some(path) = candidates.into_iter().find(|p| p.is_file()) {
            return path;
        }
    }
    if cfg!(windows) {
        "python".into()
    } else {
        "python3".into()
    }
}

impl Worker {
    fn start(cli: &Path, config: Option<&Path>) -> std::io::Result<Self> {
        let mut cmd = Command::new(python_for(cli));
        cmd.args(["-u", "-c", SCRIPT])
            .env("PYTHONIOENCODING", "utf-8")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if let Some(path) = config {
            cmd.env("OS_CLIENT_CONFIG_FILE", path);
        }
        crate::process::no_console(&mut cmd);
        Self::spawn(cmd)
    }

    fn spawn(cmd: Command) -> std::io::Result<Self> {
        let mut cmd = tokio::process::Command::from(cmd);
        cmd.kill_on_drop(true);
        let mut child = cmd.spawn()?;
        Ok(Self {
            input: child.stdin.take().unwrap(),
            output: BufReader::new(child.stdout.take().unwrap()),
            _child: child,
        })
    }

    async fn query(&mut self, request: &Value) -> std::io::Result<Value> {
        let mut bytes = serde_json::to_vec(request)?;
        bytes.push(b'\n');
        self.input.write_all(&bytes).await?;
        self.input.flush().await?;
        let mut line = String::new();
        if self.output.read_line(&mut line).await? == 0 {
            return Err(std::io::Error::other("Процесс OpenStack SDK завершился. Проверьте Python и openstacksdk рядом с выбранным CLI."));
        }
        serde_json::from_str(&line).map_err(std::io::Error::other)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn echo_command(delay: bool) -> Command {
        let mut cmd = if cfg!(windows) {
            let mut cmd = Command::new("powershell.exe");
            cmd.args(["-NoProfile", "-NonInteractive", "-Command", if delay {
                "while ($null -ne ($line = [Console]::ReadLine())) { Start-Sleep -Seconds 30; [Console]::WriteLine($line) }"
            } else {
                "while ($null -ne ($line = [Console]::ReadLine())) { [Console]::WriteLine($line) }"
            }]);
            cmd
        } else {
            let mut cmd = Command::new("sh");
            cmd.args([
                "-c",
                if delay {
                    "while IFS= read -r line; do sleep 30; printf '%s\\n' \"$line\"; done"
                } else {
                    "while IFS= read -r line; do printf '%s\\n' \"$line\"; done"
                },
            ]);
            cmd
        };
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        crate::process::no_console(&mut cmd);
        cmd
    }

    #[tokio::test]
    async fn protocol_reuses_process_and_detects_exit() {
        let mut worker = Worker::spawn(echo_command(false)).unwrap();
        let pid = worker._child.id();
        for request in [
            json!({"args": ["network", "list"]}),
            json!({"args": ["token", "issue"]}),
        ] {
            let result = tokio::time::timeout(Duration::from_secs(10), worker.query(&request))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(result, request);
            assert_eq!(worker._child.id(), pid);
        }
        worker._child.kill().await.unwrap();
        assert!(worker.query(&json!({})).await.is_err());
    }

    #[tokio::test]
    async fn stalled_protocol_can_be_cancelled_and_child_reaped() {
        let mut worker = Worker::spawn(echo_command(true)).unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(150), worker.query(&json!({})))
                .await
                .is_err()
        );
        worker._child.kill().await.unwrap();
        assert!(worker._child.id().is_none());
    }
}

pub fn query(
    cli: &Path,
    config: Option<&Path>,
    cloud: &str,
    project: &str,
    args: &[&str],
    timeout: Duration,
) -> Result<Value, String> {
    // Include file metadata so editing credentials/configuration starts a fresh session.
    let stamp = config
        .and_then(|p| std::fs::metadata(p).ok())
        .map(|m| (m.len(), m.modified().ok()));
    let key = format!("{cli:?}|{config:?}|{stamp:?}|{cloud}|{project}");
    let slot = {
        let mut workers = WORKERS
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        // Bound idle processes and remove obsolete configurations. Active requests
        // hold their own Arc and finish before the old process is dropped.
        let prefix = format!("{cli:?}|{config:?}|");
        let current = format!("{prefix}{stamp:?}|");
        workers.retain(|k, _| !k.starts_with(&prefix) || k.starts_with(&current));
        if workers.len() >= 8 && !workers.contains_key(&key) {
            if let Some(idle) = workers
                .iter()
                .find(|(_, slot)| Arc::strong_count(slot) == 1)
                .map(|(key, _)| key.clone())
            {
                workers.remove(&idle);
            }
        }
        workers
            .entry(key)
            .or_insert_with(|| Arc::new(AsyncMutex::new(None)))
            .clone()
    };
    tauri::async_runtime::block_on(async {
        let deadline = tokio::time::Instant::now() + timeout;
        let mut worker = tokio::time::timeout_at(deadline, slot.lock())
            .await
            .map_err(|_| "OpenStack SDK: превышено время ожидания очереди".to_string())?;
        if worker.is_none() {
            *worker = Some(Worker::start(cli, config).map_err(|e| e.to_string())?);
        }
        let request = json!({"cloud": cloud, "project_id": project, "args": args});
        let response =
            tokio::time::timeout_at(deadline, worker.as_mut().unwrap().query(&request)).await;
        match response {
            Ok(Ok(response)) => {
                if let Some(error) = response.get("error").and_then(Value::as_str) {
                    let status = response.get("status").and_then(Value::as_u64);
                    return Err(match status {
                        Some(401) => "OpenStack SDK: 401 Unauthorized".into(),
                        Some(403) => "OpenStack SDK: 403 Forbidden".into(),
                        Some(404) => "OpenStack SDK: 404 Not Found".into(),
                        _ => error.to_string(),
                    });
                }
                response
                    .get("result")
                    .cloned()
                    .ok_or_else(|| "Некорректный ответ OpenStack SDK".into())
            }
            other => {
                // Never replay a request: an interrupted mutation may have succeeded.
                *worker = None;
                Err(match other {
                    Err(_) => "OpenStack SDK: превышено время ожидания; результат операции может быть неизвестен".into(),
                    Ok(Err(e)) => e.to_string(),
                    _ => unreachable!(),
                })
            }
        }
    })
}
