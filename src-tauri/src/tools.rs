//! Network/DNS utilities. Runs the system binaries (no shell) and streams output line by line.

use crate::process;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, process::Stdio, sync::Mutex};
use tauri::{AppHandle, Emitter, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, BufReader},
    process::Command,
    sync::oneshot,
};

#[derive(Default)]
pub struct ToolState {
    running: Mutex<HashMap<String, oneshot::Sender<()>>>,
}

#[derive(Deserialize)]
pub struct ToolRequest {
    tool: String,
    target: String,
    count: Option<u32>,
    server: Option<String>,
    record: Option<String>,
    port: Option<u16>,
}

#[derive(Serialize, Clone)]
struct Line {
    stream: &'static str,
    text: String,
}

/// Hostnames, IPv4/IPv6 literals. Rejects anything that could be parsed as a flag.
pub fn valid_host(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 253
        && !s.starts_with('-')
        && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '_'))
}

const RECORDS: &[&str] = &["A", "AAAA", "CNAME", "MX", "NS", "TXT", "SOA", "SRV", "PTR", "CAA", "ANY"];

fn build(req: &ToolRequest) -> Result<(&'static str, Vec<String>), String> {
    if !valid_host(&req.target) {
        return Err("invalid target".into());
    }
    let server = match req.server.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) if valid_host(s) => Some(s.to_string()),
        Some(_) => return Err("invalid DNS server".into()),
        None => None,
    };
    let record = req.record.as_deref().unwrap_or("A").to_uppercase();
    if !RECORDS.contains(&record.as_str()) {
        return Err("invalid record type".into());
    }
    let count = req.count.unwrap_or(4).clamp(1, 1000).to_string();
    let t = req.target.clone();

    Ok(match req.tool.as_str() {
        // Windows tools take different flags
        "ping" if cfg!(windows) => ("ping", vec!["-n".into(), count, t]),
        "ping" => ("ping", vec!["-c".into(), count, t]),
        "traceroute" if cfg!(windows) => ("tracert", vec!["-w".into(), "2000".into(), t]),
        "traceroute" => ("traceroute", vec!["-w".into(), "2".into(), t]),
        "mtr" => ("mtr", vec!["-r".into(), "-w".into(), "-b".into(), "-c".into(), count, t]),
        "dig" => {
            let mut a = Vec::new();
            if let Some(s) = server {
                a.push(format!("@{s}"));
            }
            a.extend([t, record]);
            ("dig", a)
        }
        "nslookup" => {
            let mut a = vec![format!("-type={record}"), t];
            a.extend(server);
            ("nslookup", a)
        }
        _ => return Err("unknown tool".into()),
    })
}

#[cfg(windows)]
fn pump<R: AsyncRead + Unpin + Send + 'static>(app: AppHandle, event: String, stream: &'static str, r: R) {
    tauri::async_runtime::spawn(async move {
        // ping/tracert/nslookup write OEM (e.g. CP866), not UTF-8 — lines() would error
        // on the first byte and emit nothing; read raw and decode via CP_OEMCP.
        let mut reader = BufReader::new(r);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf).await {
                Ok(0) => break,
                Ok(_) => {
                    while buf.last().is_some_and(|b| *b == b'\n' || *b == b'\r') {
                        buf.pop();
                    }
                    let text = decode_oem(&buf);
                    let _ = app.emit(&event, Line { stream, text });
                }
                Err(_) => break,
            }
        }
    });
}

#[cfg(windows)]
fn decode_oem(bytes: &[u8]) -> String {
    #[link(name = "kernel32")]
    extern "system" {
        fn MultiByteToWideChar(cp: u32, flags: u32, s: *const u8, cb: i32, w: *mut u16, cw: i32) -> i32;
    }
    const CP_OEMCP: u32 = 1;
    // SAFETY: MultiByteToWideChar with null/sized buffers per Win32 contract
    unsafe {
        let n = MultiByteToWideChar(CP_OEMCP, 0, bytes.as_ptr(), bytes.len() as i32, std::ptr::null_mut(), 0);
        if n > 0 {
            let mut wide = vec![0u16; n as usize];
            let n2 = MultiByteToWideChar(CP_OEMCP, 0, bytes.as_ptr(), bytes.len() as i32, wide.as_mut_ptr(), n);
            if n2 > 0 {
                return String::from_utf16_lossy(&wide[..n2 as usize]);
            }
        }
    }
    String::from_utf8_lossy(bytes).into_owned()
}

#[cfg(not(windows))]
fn pump<R: AsyncRead + Unpin + Send + 'static>(app: AppHandle, event: String, stream: &'static str, r: R) {
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(r).lines();
        while let Ok(Some(text)) = lines.next_line().await {
            let _ = app.emit(&event, Line { stream, text });
        }
    });
}

#[tauri::command]
pub async fn tool_run(
    app: AppHandle,
    state: State<'_, ToolState>,
    run_id: String,
    req: ToolRequest,
) -> Result<String, String> {
    if req.tool == "port" {
        return port_check(app, run_id, req).await;
    }
    let (program, args) = build(&req)?;
    let cmdline = format!("{program} {}", args.join(" "));

    let mut child = {
        let mut cmd = Command::new(program);
        cmd.args(&args)
            .env("LC_ALL", "C")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        process::no_console_tokio(&mut cmd);
        cmd.spawn().map_err(|e| format!("{program}: {e}"))?
    };

    let line_event = format!("tool-line-{run_id}");
    pump(app.clone(), line_event.clone(), "out", child.stdout.take().unwrap());
    pump(app.clone(), line_event, "err", child.stderr.take().unwrap());

    let (tx, rx) = oneshot::channel();
    state.running.lock().unwrap().insert(run_id.clone(), tx);

    tauri::async_runtime::spawn(async move {
        let code = tokio::select! {
            status = child.wait() => status.ok().and_then(|s| s.code()),
            _ = rx => { let _ = child.kill().await; None }
        };
        let _ = app.emit(&format!("tool-exit-{run_id}"), code);
    });
    Ok(cmdline)
}

#[tauri::command]
pub fn tool_stop(state: State<ToolState>, run_id: String) {
    if let Some(tx) = state.running.lock().unwrap().remove(&run_id) {
        let _ = tx.send(());
    }
}

/// TCP connect check done natively (no `nc` needed, works on every OS).
async fn port_check(app: AppHandle, run_id: String, req: ToolRequest) -> Result<String, String> {
    if !valid_host(&req.target) {
        return Err("invalid target".into());
    }
    let port = req.port.ok_or("port required")?;
    let target = req.target.clone();
    let cmdline = format!("tcp connect {target}:{port}");
    tauri::async_runtime::spawn(async move {
        let started = std::time::Instant::now();
        let res = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            tokio::net::TcpStream::connect((target.as_str(), port)),
        )
        .await;
        let ms = started.elapsed().as_millis();
        let (text, code, stream) = match res {
            Ok(Ok(s)) => (format!("{target}:{port} открыт ({}, {ms} мс)", s.peer_addr().map(|a| a.to_string()).unwrap_or_default()), 0, "out"),
            Ok(Err(e)) => (format!("{target}:{port} закрыт или недоступен: {e}"), 1, "err"),
            Err(_) => (format!("{target}:{port}: нет ответа за 3 с (фильтруется?)"), 1, "err"),
        };
        let _ = app.emit(&format!("tool-line-{run_id}"), Line { stream, text });
        let _ = app.emit(&format!("tool-exit-{run_id}"), Some(code));
    });
    Ok(cmdline)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(tool: &str, target: &str) -> ToolRequest {
        ToolRequest { tool: tool.into(), target: target.into(), count: None, server: None, record: None, port: None }
    }

    #[test]
    fn hosts() {
        for ok in ["example.com", "192.0.2.1", "2001:db8::1", "my_host-1.local"] {
            assert!(valid_host(ok), "{ok}");
        }
        for bad in ["", "-c 100", "a b", "a;id", "$(id)", "a/b", &"a".repeat(254)] {
            assert!(!valid_host(bad), "{bad}");
        }
    }

    #[test]
    fn commands() {
        let (prog, args) = build(&req("ping", "example.com")).unwrap();
        assert_eq!(prog, "ping");
        assert_eq!(args.last().unwrap(), "example.com", "the target is always the last, positional argument");
        assert_eq!(args[1], "4", "default count");

        let mut r = req("dig", "example.com");
        r.server = Some("192.0.2.53".into());
        r.record = Some("mx".into());
        assert_eq!(build(&r).unwrap(), ("dig", vec!["@192.0.2.53".to_string(), "example.com".into(), "MX".into()]));

        let mut r = req("nslookup", "example.com");
        r.record = Some("TXT".into());
        assert_eq!(build(&r).unwrap().1, ["-type=TXT", "example.com"]);

        let mut r = req("ping", "example.com");
        r.count = Some(1_000_000);
        assert_eq!(build(&r).unwrap().1[1], "1000", "count is clamped");
    }

    #[test]
    fn rejects() {
        assert!(build(&req("ping", "-f")).is_err());
        assert!(build(&req("rm", "example.com")).is_err());
        let mut r = req("dig", "example.com");
        r.record = Some("A; id".into());
        assert!(build(&r).is_err());
        let mut r = req("dig", "example.com");
        r.server = Some("-x".into());
        assert!(build(&r).is_err());
    }
}
