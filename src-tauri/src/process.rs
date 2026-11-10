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

/// Give ConPTY children a hidden parent console so kubectl/ssh/shell do not flash a window.
/// Release Windows only (`windows_subsystem = "windows"`): without this, spawning a console
/// app via portable-pty briefly shows conhost. Do **not** use CREATE_NO_WINDOW on ConPTY
/// CreateProcess — it breaks pseudoconsole I/O.
#[cfg(all(windows, not(debug_assertions)))]
pub fn hide_console_for_conpty() {
    type HWND = *mut std::ffi::c_void;
    type BOOL = i32;
    const SW_HIDE: i32 = 0;
    #[link(name = "kernel32")]
    extern "system" {
        fn AllocConsole() -> BOOL;
        fn GetConsoleWindow() -> HWND;
    }
    #[link(name = "user32")]
    extern "system" {
        fn ShowWindow(hwnd: HWND, cmd: i32) -> BOOL;
    }
    // SAFETY: Win32 AllocConsole / ShowWindow; no other threads touch the console yet
    unsafe {
        if AllocConsole() == 0 {
            return;
        }
        let hwnd = GetConsoleWindow();
        if !hwnd.is_null() {
            ShowWindow(hwnd, SW_HIDE);
        }
    }
}

/// Приложение, запущенное из меню (Finder, Dock, ярлык в Linux), получает PATH сеанса, а не тот,
/// что человек видит в терминале: установщики дописывают свои папки в ~/.bashrc или ~/.zshrc
/// (yc, kubectl, terraform, claude, opencode, Homebrew, ~/.local/bin). Берём PATH из login-шелла
/// (не дольше 1,5 с) плюс привычные папки, сохраняя то, что уже было.
// compiled everywhere (so CI type-checks it), called on macOS and Linux
#[cfg_attr(windows, allow(dead_code))]
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
    for p in ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/local/sbin", "/snap/bin"].map(PathBuf::from)
        .into_iter()
        .chain([".local/bin", ".cargo/bin", ".opencode/bin", "bin", "yandex-cloud/bin"].map(|d| home.join(d)))
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
