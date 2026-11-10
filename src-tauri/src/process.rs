//! Spawning helper processes from the GUI (no console flash on Windows, full PATH on macOS).

/// Hide the console window when spawning helper processes from the GUI (Windows);
/// in an AppImage, also give them the system environment (see [`host_env`]).
pub fn no_console(cmd: &mut std::process::Command) {
    host_env(cmd);
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
    host_env_tokio(cmd);
    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

/// AppImage запускает OpsDeck со своим окружением: `LD_LIBRARY_PATH`, `PATH`, `XDG_DATA_DIRS`,
/// GTK-переменные указывают внутрь смонтированного образа (`/tmp/.mount_…`). Дочерние процессы
/// наследуют его, и системные программы цепляют библиотеки из образа: fish, eza, git падают с
/// «libpcre2-8.so.0: no version information available». Самому приложению эти пути нужны
/// (процессы WebKit грузят библиотеки из образа), поэтому чистим только окружение детей.
/// Что поменять: `Some` — новое значение, `None` — убрать переменную.
fn without_appdir(appdir: &str, vars: impl IntoIterator<Item = (String, String)>) -> Vec<(String, Option<String>)> {
    let appdir = appdir.trim_end_matches('/');
    if appdir.is_empty() {
        return Vec::new();
    }
    let inside = |p: &str| p == appdir || p.strip_prefix(appdir).is_some_and(|rest| rest.starts_with('/'));
    vars.into_iter()
        .filter(|(_, v)| v.contains(appdir))
        .filter_map(|(k, v)| {
            // списки путей через «:» теряют только папки образа; одиночный путь в образ — вся переменная
            let kept: Vec<&str> = v.split(':').filter(|p| !p.is_empty() && !inside(p)).collect();
            let new = (!kept.is_empty()).then(|| kept.join(":"));
            (new.as_deref() != Some(v.as_str())).then_some((k, new))
        })
        .collect()
}

/// Поправки к окружению дочернего процесса; вне AppImage (и не на Linux) — пусто.
fn host_env_fixes() -> Vec<(String, Option<String>)> {
    if !cfg!(target_os = "linux") || std::env::var_os("APPIMAGE").is_none() {
        return Vec::new();
    }
    std::env::var("APPDIR").map(|dir| without_appdir(&dir, std::env::vars())).unwrap_or_default()
}

/// Окружение системы, а не образа AppImage, для `std::process::Command`.
pub fn host_env(cmd: &mut std::process::Command) {
    for (k, v) in host_env_fixes() {
        match v {
            Some(v) => cmd.env(k, v),
            None => cmd.env_remove(k),
        };
    }
}

/// То же для `tokio::process::Command`.
pub fn host_env_tokio(cmd: &mut tokio::process::Command) {
    for (k, v) in host_env_fixes() {
        match v {
            Some(v) => cmd.env(k, v),
            None => cmd.env_remove(k),
        };
    }
}

/// То же для вкладки терминала (portable-pty).
pub fn host_env_pty(cmd: &mut portable_pty::CommandBuilder) {
    for (k, v) in host_env_fixes() {
        match v {
            Some(v) => cmd.env(k, v),
            None => cmd.env_remove(k),
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
        let mut login = Command::new(&shell);
        // PATH, который человек видит в терминале, а не тот, что подложил образ AppImage
        host_env(&mut login);
        let mut child = login
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

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(list: &[(&str, &str)]) -> Vec<(String, String)> {
        list.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    /// Окружение, с которым AppImage запускает OpsDeck: из него fish и eza брали libpcre2 образа.
    #[test]
    fn appimage_paths_do_not_reach_child_processes() {
        let dir = "/tmp/.mount_OpsDecFeEKeJ";
        let env = vars(&[
            ("LD_LIBRARY_PATH", "/tmp/.mount_OpsDecFeEKeJ/usr/lib:/tmp/.mount_OpsDecFeEKeJ/usr/lib/x86_64-linux-gnu"),
            ("PATH", "/tmp/.mount_OpsDecFeEKeJ/usr/bin:/home/demo/.local/bin:/usr/bin"),
            ("XDG_DATA_DIRS", "/tmp/.mount_OpsDecFeEKeJ/usr/share:/usr/local/share:/usr/share"),
            ("GSETTINGS_SCHEMA_DIR", "/tmp/.mount_OpsDecFeEKeJ/usr/share/glib-2.0/schemas"),
            ("APPDIR", "/tmp/.mount_OpsDecFeEKeJ"),
            ("HOME", "/home/demo"),
            ("APPIMAGE", "/home/demo/Apps/OpsDeck.AppImage"),
        ]);
        let mut fixes = without_appdir(dir, env);
        fixes.sort();
        assert_eq!(
            fixes,
            vec![
                ("APPDIR".to_string(), None),
                ("GSETTINGS_SCHEMA_DIR".to_string(), None),
                ("LD_LIBRARY_PATH".to_string(), None),
                ("PATH".to_string(), Some("/home/demo/.local/bin:/usr/bin".to_string())),
                ("XDG_DATA_DIRS".to_string(), Some("/usr/local/share:/usr/share".to_string())),
            ]
        );
    }

    #[test]
    fn only_paths_inside_the_image_are_dropped() {
        // соседняя папка с тем же началом имени — не образ
        let env = vars(&[("PATH", "/tmp/.mount_OpsDec2/bin:/tmp/.mount_OpsDec/usr/bin"), ("LANG", "ru_RU.UTF-8")]);
        assert_eq!(without_appdir("/tmp/.mount_OpsDec/", env), vec![("PATH".to_string(), Some("/tmp/.mount_OpsDec2/bin".to_string()))]);
        // без AppDir ничего не трогаем
        assert!(without_appdir("", vars(&[("PATH", "/usr/bin")])).is_empty());
    }
}
