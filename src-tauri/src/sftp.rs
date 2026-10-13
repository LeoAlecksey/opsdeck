//! Файлы на хостах: двухпанельный обмен (#78). Работает через системный `sftp` в пакетном режиме и
//! `scp -3` для переноса между двумя хостами — то есть через тот же OpenSSH, что и терминал, поэтому
//! применяются `~/.ssh/config`, ProxyJump и ключи. Вход только по ключу (BatchMode): пароль sftp
//! читает с терминала, в пакетном режиме его взять негде.

use crate::{process, ssh};
use serde::Serialize;
use std::{
    io::Write,
    process::{Command, Stdio},
};

/// Строка листинга sftp: права, ссылки, uid, gid, размер, дата (3 поля), имя.
#[derive(Serialize, PartialEq, Debug)]
pub struct Entry {
    pub name: String,
    pub dir: bool,
    pub link: bool,
    pub size: u64,
    /// как показал sftp: «Oct 13 18:00» или «Apr  4  2024»
    pub modified: String,
    pub perms: String,
    /// куда ведёт символическая ссылка (пусто, если это не ссылка)
    pub target: String,
}

#[derive(Serialize)]
pub struct Listing {
    /// абсолютный путь, который в итоге прочитали (пустой запрос — домашняя папка)
    pub path: String,
    pub entries: Vec<Entry>,
}

/// Путь в команду sftp: пакетный режим читает двойные кавычки с экранированием.
fn quote(path: &str) -> String {
    format!("\"{}\"", path.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Опции ssh под sftp/scp: порт у них `-P`, остальное (`-i`, `-J`) совпадает.
fn sftp_args(dest: &[String]) -> Vec<String> {
    let mut out = Vec::with_capacity(dest.len());
    let mut it = dest.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "-p" => {
                out.push("-P".into());
                if let Some(v) = it.next() {
                    out.push(v.clone());
                }
            }
            s => out.push(s.to_string()),
        }
    }
    out
}

/// Одна строка `ls -lan` из sftp → запись. Первые пять полей и дата из трёх полей разбираются по
/// пробелам, имя — весь остаток строки, поэтому пробелы в именах сохраняются.
fn parse_ls_line(line: &str) -> Option<Entry> {
    let perms = line.split_whitespace().next()?;
    if perms.len() < 10 || !matches!(perms.as_bytes()[0], b'-' | b'd' | b'l' | b'c' | b'b' | b'p' | b's') {
        return None;
    }
    // конец восьмого поля: за ним начинается имя
    let mut end = 0;
    let mut fields = 0;
    let mut in_field = false;
    for (i, c) in line.char_indices() {
        if c == ' ' || c == '\t' {
            if in_field {
                fields += 1;
                end = i;
                in_field = false;
                if fields == 8 {
                    break;
                }
            }
        } else {
            in_field = true;
        }
    }
    if fields < 8 {
        return None;
    }
    let f: Vec<&str> = line[..end].split_whitespace().collect();
    let name_raw = line[end..].trim_start();
    if name_raw.is_empty() || name_raw == "." || name_raw == ".." {
        return None;
    }
    let (name, target) = match name_raw.split_once(" -> ") {
        Some((n, t)) => (n, t),
        None => (name_raw, ""),
    };
    Some(Entry {
        dir: perms.starts_with('d'),
        link: perms.starts_with('l'),
        size: f[4].parse().unwrap_or(0),
        modified: f[5..8].join(" "),
        perms: perms.to_string(),
        name: name.to_string(),
        target: target.to_string(),
    })
}

/// Домашняя папка из ответа sftp на `pwd`.
fn parse_pwd(out: &str) -> Option<String> {
    out.lines().find_map(|l| l.split("Remote working directory: ").nth(1).map(|p| p.trim().to_string()))
}

/// Текст ошибки sftp — последняя содержательная строка, без эха команд.
fn explain(stderr: &str, stdout: &str) -> String {
    let pick = |s: &str| {
        s.lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with("sftp>"))
            .rfind(|l| !l.starts_with("Remote working directory"))
            .map(|l| l.chars().take(300).collect::<String>())
    };
    let line = pick(stderr).or_else(|| pick(stdout)).unwrap_or_else(|| "sftp не ответил".into());
    if line.contains("Permission denied") || line.contains("publickey") {
        return "нет входа по ключу — добавьте ключ (ssh-copy-id) или укажите его в профиле SSH".into();
    }
    if line.contains("Host key verification failed") {
        return "ключ хоста ещё не принят — подключитесь к нему один раз из терминала".into();
    }
    line
}

/// Пакет команд sftp на хост.
fn run_batch(target: &str, script: &str) -> Result<String, String> {
    let dest = crate::sysmon::sanitize_ssh_args(&ssh::probe_args(target)?)?;
    let mut cmd = Command::new("sftp");
    cmd.args(["-b", "-", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8"])
        .args(sftp_args(&dest))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // LC_ALL=C: даты в листинге всегда одинаковые, без локализованных месяцев
        .env("LC_ALL", "C");
    process::no_console(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("не удалось запустить sftp: {e}"))?;
    child.stdin.take().ok_or("sftp: нет stdin")?.write_all(script.as_bytes()).map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    if !out.status.success() {
        return Err(explain(&String::from_utf8_lossy(&out.stderr), &stdout));
    }
    Ok(stdout)
}

/// Содержимое папки на хосте («» — домашняя).
#[tauri::command]
pub async fn sftp_list(target: String, path: String) -> Result<Listing, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = if path.trim().is_empty() { ".".to_string() } else { path };
        let out = run_batch(&target, &format!("cd {0}\npwd\nls -lan\n", quote(&dir)))?;
        let mut entries: Vec<Entry> = out.lines().filter_map(parse_ls_line).collect();
        entries.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| crate::editor::natural_cmp(&a.name, &b.name)));
        Ok(Listing { path: parse_pwd(&out).unwrap_or(dir), entries })
    })
    .await
    .map_err(crate::store::err)?
}

/// Скачать файлы или папки с хоста в локальную папку.
#[tauri::command]
pub async fn sftp_get(target: String, remote: Vec<String>, local_dir: String) -> Result<usize, String> {
    let n = remote.len();
    tauri::async_runtime::spawn_blocking(move || {
        let dst = crate::editor::expand(&local_dir);
        if !dst.is_dir() {
            return Err(format!("нет папки {}", dst.display()));
        }
        let script: String = remote
            .iter()
            .map(|r| format!("get -pr {} {}\n", quote(r), quote(&dst.to_string_lossy())))
            .collect();
        run_batch(&target, &script).map(|_| n)
    })
    .await
    .map_err(crate::store::err)?
}

/// Загрузить локальные файлы или папки на хост.
#[tauri::command]
pub async fn sftp_put(target: String, local: Vec<String>, remote_dir: String) -> Result<usize, String> {
    let n = local.len();
    tauri::async_runtime::spawn_blocking(move || {
        let script: String = local
            .iter()
            .map(|l| format!("put -pr {} {}\n", quote(&crate::editor::expand(l).to_string_lossy()), quote(&remote_dir)))
            .collect();
        run_batch(&target, &script).map(|_| n)
    })
    .await
    .map_err(crate::store::err)?
}

#[tauri::command]
pub async fn sftp_mkdir(target: String, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || run_batch(&target, &format!("mkdir {}\n", quote(&path))).map(|_| ()))
        .await
        .map_err(crate::store::err)?
}

#[tauri::command]
pub async fn sftp_rename(target: String, from: String, to: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_batch(&target, &format!("rename {} {}\n", quote(&from), quote(&to))).map(|_| ())
    })
    .await
    .map_err(crate::store::err)?
}

/// Удалить файл или папку (папка — рекурсивно, как `rm -r` в sftp начиная с OpenSSH 9.x: пишем
/// `rm -r`, а если sftp постарше и его не понял — пробуем `rmdir`).
#[tauri::command]
pub async fn sftp_delete(target: String, path: String, dir: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let q = quote(&path);
        if !dir {
            return run_batch(&target, &format!("rm {q}\n")).map(|_| ());
        }
        match run_batch(&target, &format!("rm -r {q}\n")) {
            Ok(_) => Ok(()),
            Err(e) => run_batch(&target, &format!("rmdir {q}\n")).map(|_| ()).map_err(|e2| format!("{e}; rmdir: {e2}")),
        }
    })
    .await
    .map_err(crate::store::err)?
}

/// Перенос между двумя хостами: `scp -3` ведёт оба соединения через нас, так что хостам не нужно
/// видеть друг друга и ключи остаются здесь.
#[tauri::command]
pub async fn sftp_between(from_target: String, paths: Vec<String>, to_target: String, to_dir: String) -> Result<usize, String> {
    let n = paths.len();
    tauri::async_runtime::spawn_blocking(move || {
        let src = crate::sysmon::sanitize_ssh_args(&ssh::probe_args(&from_target)?)?;
        let dst = crate::sysmon::sanitize_ssh_args(&ssh::probe_args(&to_target)?)?;
        let (src_opts, src_host) = split_dest(&src)?;
        let (dst_opts, dst_host) = split_dest(&dst)?;
        if !src_opts.is_empty() || !dst_opts.is_empty() {
            // scp -3 умеет только общие опции на оба конца: порт/ключ одного хоста применился бы к обоим
            return Err("для переноса между хостами с нестандартным портом, ключом или jump-хостом скачайте файлы к себе, а потом загрузите".into());
        }
        let mut cmd = Command::new("scp");
        cmd.args(["-3", "-p", "-r", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8"]);
        for p in &paths {
            cmd.arg(format!("{src_host}:{p}"));
        }
        cmd.arg(format!("{dst_host}:{to_dir}")).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        process::no_console(&mut cmd);
        let out = cmd.output().map_err(|e| format!("не удалось запустить scp: {e}"))?;
        if !out.status.success() {
            return Err(explain(&String::from_utf8_lossy(&out.stderr), &String::from_utf8_lossy(&out.stdout)));
        }
        Ok(n)
    })
    .await
    .map_err(crate::store::err)?
}

/// Опции и адрес по отдельности: адрес у `probe_args` всегда последний.
fn split_dest(dest: &[String]) -> Result<(Vec<String>, String), String> {
    let (host, opts) = dest.split_last().ok_or("нет адреса")?;
    // порт 22 и так по умолчанию — такой хост считается обычным
    let opts: Vec<String> = match opts {
        [p, v] if p == "-p" && v == "22" => Vec::new(),
        rest => rest.to_vec(),
    };
    Ok((opts, host.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_are_quoted_for_the_batch() {
        assert_eq!(quote("/var/log/syslog"), "\"/var/log/syslog\"");
        assert_eq!(quote("/tmp/с пробелом"), "\"/tmp/с пробелом\"");
        assert_eq!(quote("/tmp/\"ка\\вычки\""), "\"/tmp/\\\"ка\\\\вычки\\\"\"");
    }

    /// Порт у sftp и scp — `-P`, а `-p` у них значит «сохранить время»: с чужой опцией sftp
    /// молча ходил бы на 22-й порт.
    #[test]
    fn the_port_option_is_translated() {
        let dest = vec!["-p".to_string(), "2222".into(), "-i".into(), "~/.ssh/id".into(), "-J".into(), "bastion".into(), "ops@h".into()];
        assert_eq!(sftp_args(&dest), ["-P", "2222", "-i", "~/.ssh/id", "-J", "bastion", "ops@h"]);
        assert_eq!(sftp_args(&["h".to_string()]), ["h"]);
    }

    #[test]
    fn listing_lines_are_parsed() {
        let out = "sftp> cd \"/srv\"\nRemote working directory: /srv\ndrwxr-xr-x    5 1000     1000         4096 Oct 13 18:00 .\ndrwxr-xr-x   22 0        0            4096 Oct  1 09:12 ..\n-rw-r--r--    1 1000     1000      1048576 Apr  4  2024 dump 1.sql\nlrwxrwxrwx    1 0        0               9 Oct 13 18:00 current -> releases/7\ndrwxr-xr-x    2 1000     1000         4096 Oct 13 17:00 releases\n";
        assert_eq!(parse_pwd(out).as_deref(), Some("/srv"));
        let e: Vec<Entry> = out.lines().filter_map(parse_ls_line).collect();
        assert_eq!(e.len(), 3, "«.» и «..» пропускаются");
        assert_eq!(
            e[0],
            Entry { name: "dump 1.sql".into(), dir: false, link: false, size: 1048576, modified: "Apr 4 2024".into(), perms: "-rw-r--r--".into(), target: String::new() },
            "пробел в имени не ломает разбор"
        );
        assert_eq!(e[1].name, "current");
        assert!(e[1].link && e[1].target == "releases/7");
        assert!(e[2].dir);
        // эхо команд и приглашения записями не считаются
        assert!(parse_ls_line("sftp> ls -lan").is_none());
        assert!(parse_ls_line("").is_none());
        assert!(parse_ls_line("Connected to h.").is_none());
    }

    #[test]
    fn errors_are_explained() {
        assert!(explain("ops@h: Permission denied (publickey).", "").contains("ssh-copy-id"));
        assert!(explain("Host key verification failed.", "").contains("из терминала"));
        assert_eq!(explain("", "sftp> ls\nCouldn't stat remote file: No such file or directory"), "Couldn't stat remote file: No such file or directory");
    }

    #[test]
    fn a_plain_host_can_be_copied_host_to_host() {
        assert_eq!(split_dest(&["-p".to_string(), "22".into(), "ops@h".into()]).unwrap(), (vec![], "ops@h".to_string()));
        let (opts, host) = split_dest(&["-p".to_string(), "2222".into(), "ops@h".into()]).unwrap();
        assert_eq!((opts.len(), host.as_str()), (2, "ops@h"), "нестандартный порт остаётся опцией");
        assert!(split_dest(&[]).is_err());
    }
}
