//! Windows: which shells are installed (PowerShell 5.1/7, Git Bash, cmd, WSL distributions), for the
//! "Windows" block in Settings and the WSL button in the terminal. Elsewhere the list is empty.

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Shell {
    /// stable id for the setting: "powershell", "pwsh", "gitbash", "cmd", "wsl:<distro>"
    pub id: String,
    pub label: String,
    pub program: String,
    pub args: Vec<String>,
}

/// `wsl.exe -l -q` prints UTF-16LE (with a BOM sometimes) and blank lines.
pub fn parse_wsl_list(bytes: &[u8]) -> Vec<String> {
    let text = if bytes.len() >= 2 && bytes.len().is_multiple_of(2) && bytes.iter().skip(1).step_by(2).filter(|b| **b == 0).count() * 2 >= bytes.len() / 2 {
        let units: Vec<u16> = bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    };
    text.trim_start_matches('\u{feff}')
        .lines()
        .map(|l| l.trim_matches(|c: char| c.is_whitespace() || c == '\0').to_string())
        .filter(|l| !l.is_empty() && !l.starts_with("docker-desktop"))
        .collect()
}

/// The first existing file among candidates.
fn first(candidates: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    candidates.into_iter().find(|p| p.is_file())
}

/// A program found in PATH.
fn in_path(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|p| std::env::split_paths(&p).map(|d| d.join(name)).find(|f| f.is_file()))
}

/// Git Bash next to git.exe: <Git>\cmd\git.exe → <Git>\bin\bash.exe.
fn git_bash(program_files: &[PathBuf]) -> Option<PathBuf> {
    let from_git = in_path("git.exe").and_then(|g| g.parent()?.parent().map(|root| root.join("bin").join("bash.exe")));
    first(from_git.into_iter().chain(program_files.iter().map(|d| d.join("Git").join("bin").join("bash.exe"))))
}

#[tauri::command]
pub async fn win_shells() -> Vec<Shell> {
    if !cfg!(windows) {
        return Vec::new();
    }
    tauri::async_runtime::spawn_blocking(detect).await.unwrap_or_default()
}

fn detect() -> Vec<Shell> {
    let mut out = detect_local();
    out.extend(detect_wsl());
    out
}

/// Everything but WSL (no process is started).
fn detect_local() -> Vec<Shell> {
    let windir = PathBuf::from(std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into()));
    let program_files: Vec<PathBuf> = ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"]
        .iter()
        .filter_map(|v| std::env::var_os(v).map(PathBuf::from))
        .collect();
    let shell = |id: &str, label: &str, program: &Path, args: &[&str]| Shell {
        id: id.into(),
        label: label.into(),
        program: program.to_string_lossy().into_owned(),
        args: args.iter().map(|s| s.to_string()).collect(),
    };
    let mut out = Vec::new();
    let ps5 = windir.join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
    if ps5.is_file() {
        out.push(shell("powershell", "Windows PowerShell 5.1", &ps5, &[]));
    }
    if let Some(p) = in_path("pwsh.exe").or_else(|| first(program_files.iter().map(|d| d.join(r"PowerShell\7\pwsh.exe")))) {
        out.push(shell("pwsh", "PowerShell 7", &p, &[]));
    }
    if let Some(p) = git_bash(&program_files) {
        out.push(shell("gitbash", "Git Bash", &p, &[]));
    }
    let cmd = windir.join(r"System32\cmd.exe");
    if cmd.is_file() {
        out.push(shell("cmd", "Командная строка (cmd)", &cmd, &[]));
    }
    out
}

fn detect_wsl() -> Vec<Shell> {
    let mut out = Vec::new();
    let wsl = PathBuf::from(std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into())).join(r"System32\wsl.exe");
    let shell = |id: &str, label: &str, program: &Path, args: &[&str]| Shell {
        id: id.into(),
        label: label.into(),
        program: program.to_string_lossy().into_owned(),
        args: args.iter().map(|s| s.to_string()).collect(),
    };
    if wsl.is_file() {
        let mut c = std::process::Command::new(&wsl);
        c.args(["-l", "-q"]).stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        crate::process::no_console(&mut c);
        if let Ok(o) = c.output() {
            for d in parse_wsl_list(&o.stdout) {
                out.push(shell(&format!("wsl:{d}"), &format!("WSL: {d}"), &wsl, &["-d", &d, "--cd", "~"]));
            }
        }
    }
    out
}

/// The shell chosen in Settings, if it is still installed (Windows only). Built from its id
/// without listing WSL again, so opening a tab stays fast.
pub fn chosen(id: &str) -> Option<Shell> {
    if id.is_empty() || !cfg!(windows) {
        return None;
    }
    if let Some(d) = id.strip_prefix("wsl:") {
        let wsl = PathBuf::from(std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into())).join(r"System32\wsl.exe");
        return wsl.is_file().then(|| Shell {
            id: id.into(),
            label: format!("WSL: {d}"),
            program: wsl.to_string_lossy().into_owned(),
            args: vec!["-d".into(), d.into(), "--cd".into(), "~".into()],
        });
    }
    detect_local().into_iter().find(|s| s.id == id)
}

/// Where Windows Terminal keeps settings.json (Store, Preview and unpackaged installs).
fn wt_candidates(local_app_data: &Path) -> Vec<PathBuf> {
    let pkg = |name: &str| local_app_data.join("Packages").join(name).join("LocalState").join("settings.json");
    vec![
        pkg("Microsoft.WindowsTerminal_8wekyb3d8bbwe"),
        pkg("Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe"),
        local_app_data.join("Microsoft").join("Windows Terminal").join("settings.json"),
    ]
}

/// Text of Windows Terminal's settings.json, for importing its colour schemes.
#[tauri::command]
pub fn wt_settings() -> Result<String, String> {
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).ok_or("Windows Terminal не найден")?;
    let file = first(wt_candidates(&base)).ok_or("Windows Terminal не найден: settings.json нет — вставьте JSON схемы вручную")?;
    std::fs::read_to_string(&file).map_err(|e| format!("{}: {e}", file.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wsl_list_utf16() {
        let text = "\u{feff}Ubuntu-24.04\r\n\r\nDebian\r\ndocker-desktop\r\n";
        let bytes: Vec<u8> = text.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        assert_eq!(parse_wsl_list(&bytes), ["Ubuntu-24.04", "Debian"]);
        assert_eq!(parse_wsl_list(b"Ubuntu\nkali-linux\n"), ["Ubuntu", "kali-linux"], "UTF-8 output of newer wsl.exe");
        assert!(parse_wsl_list(b"").is_empty());
    }

    #[test]
    fn nothing_outside_windows() {
        if !cfg!(windows) {
            assert!(chosen("pwsh").is_none());
        }
    }

    #[test]
    fn windows_terminal_settings_paths() {
        let c = wt_candidates(Path::new("L"));
        assert!(c[0].ends_with("Packages/Microsoft.WindowsTerminal_8wekyb3d8bbwe/LocalState/settings.json"));
        assert!(c[2].ends_with("Microsoft/Windows Terminal/settings.json"));
    }
}
