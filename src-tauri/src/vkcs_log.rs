//! In-memory history of CLI invocations. Never record stdout/stderr: token issue returns a secret.

use serde::Serialize;
use std::{
    collections::VecDeque,
    process::{Command, Output},
    sync::{Mutex, OnceLock},
};
use tauri::Emitter;

const LIMIT: usize = 500;
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
static LOG: Mutex<CommandLog> = Mutex::new(CommandLog {
    revision: 0,
    entries: VecDeque::new(),
});

#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Running,
    Success,
    Error,
    Timeout,
}

#[derive(Clone, Serialize, Debug)]
pub struct Entry {
    pub id: u64,
    pub revision: u64,
    pub timestamp: String,
    pub command: String,
    pub transport: &'static str,
    pub phase: Phase,
    pub exit_code: Option<i32>,
}

struct CommandLog {
    revision: u64,
    entries: VecDeque<Entry>,
}

impl CommandLog {
    fn start(&mut self, command: String) -> Entry {
        self.revision += 1;
        let entry = Entry {
            id: self.revision,
            revision: self.revision,
            timestamp: chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            command,
            transport: "cli",
            phase: Phase::Running,
            exit_code: None,
        };
        self.entries.push_back(entry.clone());
        while self.entries.len() > LIMIT {
            self.entries.pop_front();
        }
        entry
    }

    fn finish(&mut self, id: u64, result: &std::io::Result<Output>) -> Option<Entry> {
        let entry = self.entries.iter_mut().find(|entry| entry.id == id)?;
        self.revision += 1;
        entry.revision = self.revision;
        entry.phase = match result {
            Ok(out) if out.status.success() => Phase::Success,
            Ok(_) => Phase::Error,
            Err(err) if err.kind() == std::io::ErrorKind::TimedOut => Phase::Timeout,
            Err(_) => Phase::Error,
        };
        entry.exit_code = result.as_ref().ok().and_then(|out| out.status.code());
        Some(entry.clone())
    }
}

pub fn init(app: tauri::AppHandle) {
    let _ = APP.set(app);
}

fn emit(entry: &Entry) {
    if let Some(app) = APP.get() {
        let _ = app.emit("vkcs-command-log", entry);
    }
}

// Render a pasteable command for the local default shell, preserving spaces and apostrophes.
fn quote(value: &str, windows: bool) -> String {
    if !value.is_empty() && value.chars().all(|c| c.is_ascii_alphanumeric() || "-_/.:=@+".contains(c)) {
        return value.into();
    }
    let escaped = if windows { value.replace('\'', "''") } else { value.replace('\'', "'\\''") };
    format!("'{escaped}'")
}

fn command_text(cmd: &Command, windows: bool) -> String {
    let program = quote(&cmd.get_program().to_string_lossy(), windows);
    let prefix = if windows && program.starts_with('\'') { "& " } else { "" };
    let config = cmd.get_envs().find(|(key, _)| *key == "OS_CLIENT_CONFIG_FILE").and_then(|(_, value)| value);
    let env_prefix = config
        .map(|path| {
            let value = if windows {
                format!("'{}'", path.to_string_lossy().replace('\'', "''"))
            } else {
                quote(&path.to_string_lossy(), false)
            };
            if windows {
                format!("$env:OS_CLIENT_CONFIG_FILE = {value}; ")
            } else {
                format!("OS_CLIENT_CONFIG_FILE={value} ")
            }
        })
        .unwrap_or_default();
    let mut text = format!("{env_prefix}{prefix}{program}");
    for arg in cmd.get_args() {
        text.push(' ');
        text.push_str(&quote(&arg.to_string_lossy(), windows));
    }
    text
}

pub fn start(cmd: &Command) -> u64 {
    let entry = LOG.lock().unwrap_or_else(|e| e.into_inner()).start(command_text(cmd, cfg!(windows)));
    emit(&entry);
    entry.id
}

pub fn start_sdk(cmd: &Command) -> u64 {
    let entry = {
        let mut log = LOG.lock().unwrap_or_else(|e| e.into_inner());
        let mut entry = log.start(command_text(cmd, cfg!(windows)));
        entry.transport = "sdk";
        if let Some(saved) = log.entries.back_mut() { saved.transport = "sdk"; }
        entry
    };
    emit(&entry);
    entry.id
}

pub fn finish(id: u64, result: &std::io::Result<Output>) {
    let entry = LOG.lock().unwrap_or_else(|e| e.into_inner()).finish(id, result);
    if let Some(entry) = entry {
        emit(&entry);
    }
}

pub fn finish_sdk(id: u64, result: &Result<serde_json::Value, String>) {
    let entry = {
        let mut log = LOG.lock().unwrap_or_else(|e| e.into_inner());
        log.revision += 1;
        let revision = log.revision;
        log.entries.iter_mut().find(|entry| entry.id == id).map(|entry| {
            entry.revision = revision;
            entry.phase = match result {
                Ok(_) => Phase::Success,
                Err(error) if error.contains("превышено время ожидания") => Phase::Timeout,
                Err(_) => Phase::Error,
            };
            entry.exit_code = None;
            entry.clone()
        })
    };
    if let Some(entry) = entry { emit(&entry); }
}

#[tauri::command]
pub fn vkcs_command_log() -> Vec<Entry> {
    LOG.lock().unwrap_or_else(|e| e.into_inner()).entries.iter().cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_are_pasteable_in_each_shell() {
        let mut cmd = Command::new("/opt/cloud tools/openstack");
        cmd.args(["--os-cloud", "team's cloud", "server", "list", "-f", "json"]);
        assert_eq!(
            command_text(&cmd, false),
            "'/opt/cloud tools/openstack' --os-cloud 'team'\\''s cloud' server list -f json"
        );
        let mut cmd = Command::new("C:\\Program Files\\Python\\openstack.exe");
        cmd.args(["--os-cloud", "team's cloud", "server", "list"]);
        assert_eq!(
            command_text(&cmd, true),
            "& 'C:\\Program Files\\Python\\openstack.exe' --os-cloud 'team''s cloud' server list"
        );
        cmd.env("OS_CLIENT_CONFIG_FILE", "C:\\Cloud Config\\clouds.yaml");
        assert!(command_text(&cmd, true).starts_with("$env:OS_CLIENT_CONFIG_FILE = 'C:\\Cloud Config\\clouds.yaml'; & "));
        cmd.env("OS_CLIENT_CONFIG_FILE", "C:/clouds.yaml");
        assert!(command_text(&cmd, true).starts_with("$env:OS_CLIENT_CONFIG_FILE = 'C:/clouds.yaml'; & "));
        let mut cmd = Command::new("openstack");
        cmd.env("OS_CLIENT_CONFIG_FILE", "/home/u/cloud config/clouds.yaml");
        cmd.env("OS_PASSWORD", "secret-password");
        assert_eq!(command_text(&cmd, false), "OS_CLIENT_CONFIG_FILE='/home/u/cloud config/clouds.yaml' openstack");
    }

    #[test]
    fn history_is_bounded_and_old_completions_are_ignored() {
        let mut log = CommandLog {
            revision: 0,
            entries: VecDeque::new(),
        };
        let first = log.start("openstack server list".into());
        for _ in 0..LIMIT {
            log.start("openstack network list".into());
        }
        assert_eq!(log.entries.len(), LIMIT);
        assert!(log.finish(first.id, &Err(std::io::ErrorKind::TimedOut.into())).is_none());
        let last = log.entries.back().unwrap().clone();
        let done = log.finish(last.id, &Err(std::io::ErrorKind::TimedOut.into())).unwrap();
        assert_eq!(done.phase, Phase::Timeout);
        assert!(done.revision > last.revision);
        assert!(chrono::DateTime::parse_from_rfc3339(&done.timestamp).is_ok());
    }

    #[test]
    fn output_and_tokens_do_not_enter_the_history() {
        let mut log = CommandLog {
            revision: 0,
            entries: VecDeque::new(),
        };
        let entry = log.start("openstack token issue -c id -f value".into());
        let result = Output {
            status: success_status(),
            stdout: b"secret-token".to_vec(),
            stderr: b"secret-error".to_vec(),
        };
        let done = log.finish(entry.id, &Ok(result)).unwrap();
        assert_eq!(done.phase, Phase::Success);
        assert_eq!(done.exit_code, Some(0));
        let json = serde_json::to_string(&done).unwrap();
        assert!(!json.contains("secret"));
        assert_eq!(done.id, entry.id);
    }

    fn success_status() -> std::process::ExitStatus {
        #[cfg(unix)]
        use std::os::unix::process::ExitStatusExt;
        #[cfg(windows)]
        use std::os::windows::process::ExitStatusExt;
        std::process::ExitStatus::from_raw(0)
    }
}
