//! Resource bar under the terminal: this machine (sysinfo) or, while the active tab is in an SSH
//! session, the remote Linux host. Remote numbers are read over the session's own connection:
//! OpsDeck starts ssh with ControlMaster, and the probe reuses that master (no second login,
//! works for password logins too).

use crate::store::err;
use serde::Serialize;
use std::{collections::HashMap, path::PathBuf, sync::Mutex, time::Duration};
use sysinfo::{Disks, System};
use tauri::State;

#[derive(Default)]
pub struct SysState {
    sys: Mutex<Option<System>>,
    /// last /proc/stat (busy, total) per remote target, for CPU% between two samples
    prev: Mutex<HashMap<String, (u64, u64)>>,
}

#[derive(Serialize, Default)]
pub struct Stats {
    host: String,
    remote: bool,
    cpu: Option<f32>,
    cores: usize,
    load: Option<[f64; 3]>,
    mem_used: u64,
    mem_total: u64,
    swap_used: u64,
    swap_total: u64,
    disk_mount: String,
    disk_used: u64,
    disk_total: u64,
    uptime: u64,
}

/// ControlPath shared by OpsDeck's ssh sessions and the probe (%C = hash of host/port/user).
/// A short path without spaces: the config dir on macOS is "Library/Application Support" (the space
/// broke ssh's option parsing) and sockets there must stay under 104 bytes.
pub fn control_path() -> Option<String> {
    let dir = match dirs::runtime_dir() {
        Some(run) => run.join("opsdeck"),
        None => dirs::home_dir()?.join(".opsdeck").join("run"),
    };
    std::fs::create_dir_all(&dir).ok()?;
    crate::store::restrict(&dir, 0o700).ok()?;
    Some(dir.join("ssh-%C").to_string_lossy().into_owned())
}

/// Options OpsDeck adds to interactive ssh so the resource probe can ride the same connection.
pub fn ssh_master_opts() -> Vec<String> {
    if cfg!(windows) {
        return Vec::new(); // Windows OpenSSH has no connection multiplexing
    }
    match control_path() {
        Some(cp) => vec![
            "-o".into(), "ControlMaster=auto".into(),
            "-o".into(), format!("ControlPath=\"{cp}\""),
            "-o".into(), "ControlPersist=60".into(),
        ],
        None => Vec::new(),
    }
}

#[tauri::command]
pub fn sys_local(state: State<SysState>) -> Stats {
    local(&state)
}

fn local(state: &SysState) -> Stats {
    let mut guard = state.sys.lock().unwrap();
    let sys = guard.get_or_insert_with(System::new);
    // CPU usage is the delta since the previous call (the bar polls every ~2 s)
    sys.refresh_cpu_usage();
    sys.refresh_memory();
    let load = System::load_average();
    // the disk holding the home directory (most relevant for "is my disk full")
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
    let disks = Disks::new_with_refreshed_list();
    let disk = disks
        .list()
        .iter()
        .filter(|d| home.starts_with(d.mount_point()))
        .max_by_key(|d| d.mount_point().as_os_str().len());
    Stats {
        host: System::host_name().unwrap_or_default(),
        remote: false,
        cpu: Some(sys.global_cpu_usage()),
        cores: sys.cpus().len(),
        load: (!cfg!(windows)).then_some([load.one, load.five, load.fifteen]),
        mem_used: sys.used_memory(),
        mem_total: sys.total_memory(),
        swap_used: sys.used_swap(),
        swap_total: sys.total_swap(),
        disk_mount: disk.map(|d| d.mount_point().to_string_lossy().into_owned()).unwrap_or_default(),
        disk_used: disk.map(|d| d.total_space() - d.available_space()).unwrap_or(0),
        disk_total: disk.map(|d| d.total_space()).unwrap_or(0),
        uptime: System::uptime(),
    }
}

/// Only these ssh options are passed on to the probe (no -o, so no ProxyCommand/LocalCommand).
fn sanitize_ssh_args(args: &[String]) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    let mut it = args.iter();
    let mut dest = None;
    while let Some(a) = it.next() {
        match a.as_str() {
            "-p" | "-l" | "-i" | "-J" => {
                let v = it.next().ok_or("missing option value")?;
                if v.starts_with('-') {
                    return Err("bad option value".into());
                }
                out.extend([a.clone(), v.clone()]);
            }
            s if s.starts_with('-') => return Err(format!("unsupported ssh option {s}")),
            s => {
                if dest.is_some() {
                    return Err("only one destination".into());
                }
                dest = Some(s.to_string());
            }
        }
    }
    let dest = dest.ok_or("no destination")?;
    out.push(dest);
    Ok(out)
}

const PROBE: &str = "cat /proc/loadavg; echo ---; nproc; echo ---; \
grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo; echo ---; \
df -Pk / | tail -1; echo ---; head -1 /proc/stat; echo ---; hostname; echo ---; cut -d' ' -f1 /proc/uptime";

#[tauri::command]
pub async fn sys_remote(state: State<'_, SysState>, args: Vec<String>) -> Result<Stats, String> {
    if cfg!(windows) {
        return Err("на Windows метрики удалённой машины недоступны".into());
    }
    let args = sanitize_ssh_args(&args)?;
    let key = args.join(" ");
    let cp = control_path().ok_or("no control path")?;
    let mut cmd = tokio::process::Command::new("ssh");
    cmd.args(["-o", "ControlMaster=no", "-o", &format!("ControlPath=\"{cp}\""), "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-T"])
        .args(&args)
        .arg(PROBE)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    let out = tokio::time::timeout(Duration::from_secs(8), cmd.output())
        .await
        .map_err(|_| "удалённая машина не ответила за 8 с".to_string())?
        .map_err(err)?;
    if !out.status.success() {
        let e = String::from_utf8_lossy(&out.stderr);
        return Err(if e.contains("Permission denied") || e.contains("batch mode") || e.contains("Control socket") {
            "нет общего соединения — метрики появятся для сессий, открытых в OpsDeck".into()
        } else {
            e.lines().last().unwrap_or("ssh error").to_string()
        });
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let parts: Vec<&str> = text.split("---\n").collect();
    if parts.len() < 7 {
        return Err("не Linux или нет /proc".into());
    }
    let nums = |s: &str| s.split_whitespace().filter_map(|x| x.parse::<f64>().ok()).collect::<Vec<_>>();
    let l = nums(parts[0]);
    let mut meminfo: HashMap<&str, u64> = HashMap::new();
    for line in parts[2].lines() {
        let mut f = line.split_whitespace();
        if let (Some(k), Some(v)) = (f.next(), f.next()) {
            meminfo.insert(k.trim_end_matches(':'), v.parse::<u64>().unwrap_or(0) * 1024);
        }
    }
    let df: Vec<&str> = parts[3].split_whitespace().collect();
    let kb = |i: usize| df.get(i).and_then(|v| v.parse::<u64>().ok()).unwrap_or(0) * 1024;
    // cpu  user nice system idle iowait irq softirq steal …
    let cpu_fields: Vec<u64> = parts[4].split_whitespace().skip(1).filter_map(|v| v.parse().ok()).collect();
    let total: u64 = cpu_fields.iter().sum();
    let idle = cpu_fields.get(3).copied().unwrap_or(0) + cpu_fields.get(4).copied().unwrap_or(0);
    let busy = total.saturating_sub(idle);
    let cpu = {
        let mut prev = state.prev.lock().unwrap();
        let pct = prev.get(&key).and_then(|&(b0, t0)| {
            let dt = total.saturating_sub(t0);
            (dt > 0).then(|| 100.0 * busy.saturating_sub(b0) as f32 / dt as f32)
        });
        prev.insert(key, (busy, total));
        pct
    };
    let mem_total = meminfo.get("MemTotal").copied().unwrap_or(0);
    let swap_total = meminfo.get("SwapTotal").copied().unwrap_or(0);
    Ok(Stats {
        host: parts[5].trim().to_string(),
        remote: true,
        cpu,
        cores: parts[1].trim().parse().unwrap_or(0),
        load: (l.len() >= 3).then(|| [l[0], l[1], l[2]]),
        mem_used: mem_total.saturating_sub(meminfo.get("MemAvailable").copied().unwrap_or(0)),
        mem_total,
        swap_used: swap_total.saturating_sub(meminfo.get("SwapFree").copied().unwrap_or(0)),
        swap_total,
        disk_mount: df.get(5).map(|s| s.to_string()).unwrap_or_else(|| "/".into()),
        disk_used: kb(2),
        disk_total: kb(1),
        uptime: parts[6].trim().parse::<f64>().unwrap_or(0.0) as u64,
    })
}


#[cfg(test)]
mod tests {
    use super::*;

    fn v(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn control_path_is_quoted_and_has_no_spaces() {
        let Some(cp) = control_path() else { return };
        assert!(!cp.contains(' '), "{cp}");
        if !cfg!(windows) {
            assert!(ssh_master_opts().contains(&format!("ControlPath=\"{cp}\"")));
        }
    }

    #[test]
    fn ssh_args_for_the_probe() {
        assert_eq!(sanitize_ssh_args(&v(&["-p", "2222", "-J", "bastion", "ops@host"])).unwrap(), v(&["-p", "2222", "-J", "bastion", "ops@host"]));
        assert!(sanitize_ssh_args(&v(&["-o", "ProxyCommand=sh", "host"])).is_err(), "no -o: ProxyCommand would run a command");
        assert!(sanitize_ssh_args(&v(&["-p", "-oX", "host"])).is_err());
        assert!(sanitize_ssh_args(&v(&["host", "other"])).is_err(), "one destination only");
        assert!(sanitize_ssh_args(&v(&["-p", "22"])).is_err(), "a destination is required");
        assert!(sanitize_ssh_args(&v(&["-i"])).is_err());
    }
}
