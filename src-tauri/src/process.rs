//! Spawning helper processes from the GUI (no console flash on Windows, full PATH on macOS).

/// Hide the console window when spawning helper processes from the GUI (Windows).
pub fn no_console(cmd: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

/// Same as [`no_console`] for `tokio::process::Command`.
pub fn no_console_tokio(cmd: &mut tokio::process::Command) {
    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

/// Apps started from Finder/Dock on macOS get a minimal PATH without Homebrew, ~/.local/bin and so
/// on: git, terraform, kubectl, claude, opencode would not be found. Take PATH from the user's login
/// shell (1.5 s at most) plus the usual folders, keeping what was there.
// compiled everywhere (so CI on Linux type-checks it), called only on macOS
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn fix_macos_path() {
    use std::{path::PathBuf, process::{Command, Stdio}, time::{Duration, Instant}};
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let marker = "__OPSDECK_PATH__";
    let from_shell = (|| {
        let mut child = Command::new(&shell)
            .args(["-l", "-c", &format!("printf '{marker}%s{marker}' \"$PATH\"")])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let deadline = Instant::now() + Duration::from_millis(1500);
        loop {
            match child.try_wait() {
                Ok(Some(st)) if st.success() => break,
                Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(30)),
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
            }
        }
        let mut out = String::new();
        std::io::Read::read_to_string(&mut child.stdout.take()?, &mut out).ok()?;
        out.split(marker).nth(1).map(str::to_string)
    })();
    let mut paths: Vec<PathBuf> = Vec::new();
    let mut add = |p: PathBuf| {
        if !paths.contains(&p) {
            paths.push(p);
        }
    };
    for p in std::env::split_paths(&from_shell.unwrap_or_default()) {
        add(p);
    }
    let home = dirs::home_dir().unwrap_or_default();
    for p in ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/local/sbin"].map(PathBuf::from)
        .into_iter()
        .chain([".local/bin", ".cargo/bin", ".opencode/bin"].map(|d| home.join(d)))
    {
        if p.is_dir() {
            add(p);
        }
    }
    for p in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        add(p);
    }
    if let Ok(joined) = std::env::join_paths(paths) {
        std::env::set_var("PATH", joined); // before any thread is started
    }
}
