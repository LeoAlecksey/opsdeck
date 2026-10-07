//! Port tools for the "Сеть и DNS" view: TCP scan of a host (open / closed / filtered + what
//! answers there) and the listening sockets of this machine with their processes.

use crate::{store::err, tools::valid_host};
use serde::Serialize;
use std::{collections::HashMap, net::SocketAddr, sync::Arc, time::Duration};
use tauri::{AppHandle, Emitter};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::Semaphore,
};

const MAX_PORTS: usize = 4096;
const CONCURRENCY: usize = 256;

/// Well-known TCP services (what usually listens on a port).
fn service_name(port: u16) -> &'static str {
    match port {
        20 | 21 => "ftp", 22 => "ssh", 23 => "telnet", 25 => "smtp", 53 => "dns", 80 => "http", 110 => "pop3",
        111 => "rpcbind", 135 => "msrpc", 139 => "netbios", 143 => "imap", 179 => "bgp", 389 => "ldap",
        443 => "https", 445 => "smb", 465 => "smtps", 514 => "syslog", 587 => "submission", 636 => "ldaps",
        873 => "rsync", 993 => "imaps", 995 => "pop3s", 1433 => "mssql", 1521 => "oracle", 1883 => "mqtt",
        2049 => "nfs", 2375 | 2376 => "docker", 2379 | 2380 => "etcd", 3000 => "grafana / dev http",
        3128 => "squid", 3306 => "mysql", 3389 => "rdp", 4222 => "nats", 5000 => "registry / dev http",
        5044 => "logstash beats", 5432 => "postgres", 5601 => "kibana", 5672 => "amqp", 5900 => "vnc",
        6379 => "redis", 6443 => "kubernetes api", 8000 | 8080 | 8081 | 8888 => "http alt", 8006 => "proxmox",
        8123 => "clickhouse http", 8200 => "vault", 8291 => "winbox", 8443 => "https alt", 8500 => "consul",
        8728 | 8729 => "routeros api", 9000 => "minio / sonarqube", 9042 => "cassandra", 9090 => "prometheus",
        9092 => "kafka", 9093 => "alertmanager", 9100 => "node_exporter", 9200 | 9300 => "elasticsearch",
        10250 => "kubelet", 11211 => "memcached", 15672 => "rabbitmq ui", 27017 => "mongodb",
        _ => "",
    }
}

/// "22,80,443,8000-8100" → sorted unique ports.
fn parse_ports(spec: &str) -> Result<Vec<u16>, String> {
    let mut out = Vec::new();
    for part in spec.split([',', ' ', ';']).map(str::trim).filter(|p| !p.is_empty()) {
        let (a, b) = part.split_once('-').unwrap_or((part, part));
        let a: u16 = a.trim().parse().map_err(|_| format!("не порт: {part}"))?;
        let b: u16 = b.trim().parse().map_err(|_| format!("не порт: {part}"))?;
        if a == 0 || b < a {
            return Err(format!("неверный диапазон: {part}"));
        }
        out.extend(a..=b);
        if out.len() > MAX_PORTS {
            return Err(format!("слишком много портов (максимум {MAX_PORTS})"));
        }
    }
    out.sort_unstable();
    out.dedup();
    if out.is_empty() {
        return Err("укажите порты".into());
    }
    Ok(out)
}

#[derive(Serialize, Clone)]
struct PortResult {
    port: u16,
    /// open | closed | filtered
    state: &'static str,
    service: &'static str,
    /// what answered: banner / Server header / "TLS"
    banner: String,
    ms: u64,
}

fn printable(bytes: &[u8]) -> String {
    let s = String::from_utf8_lossy(bytes);
    s.lines().next().unwrap_or("").chars().filter(|c| !c.is_control()).take(120).collect::<String>().trim().to_string()
}

/// Identify what listens on an open port: wait for a greeting (ssh/smtp/ftp/…), otherwise poke
/// with an HTTP HEAD and read the status line + Server header.
async fn probe(mut s: TcpStream) -> String {
    let mut buf = vec![0u8; 1024];
    if let Ok(Ok(n)) = tokio::time::timeout(Duration::from_millis(800), s.read(&mut buf)).await {
        if n > 0 {
            return printable(&buf[..n]);
        }
        return String::new(); // closed right away
    }
    if s.write_all(b"HEAD / HTTP/1.0\r\nHost: opsdeck\r\nUser-Agent: OpsDeck\r\n\r\n").await.is_err() {
        return String::new();
    }
    let Ok(Ok(n)) = tokio::time::timeout(Duration::from_millis(1500), s.read(&mut buf)).await else { return String::new() };
    let data = &buf[..n];
    if n > 0 && (data[0] == 0x15 || data[0] == 0x16) {
        return "TLS (ответил TLS-алертом на HTTP)".into();
    }
    let text = String::from_utf8_lossy(data);
    if text.starts_with("HTTP/") {
        let status = text.lines().next().unwrap_or("").trim().to_string();
        let server = text
            .lines()
            .find_map(|l| l.split_once(':').filter(|(k, _)| k.eq_ignore_ascii_case("server")).map(|(_, v)| v.trim().to_string()));
        return match server {
            Some(sv) => format!("{status} · {sv}"),
            None => status,
        };
    }
    printable(data)
}

async fn check(addr: SocketAddr, timeout: Duration) -> PortResult {
    let started = std::time::Instant::now();
    let res = tokio::time::timeout(timeout, TcpStream::connect(addr)).await;
    let ms = started.elapsed().as_millis() as u64;
    let (state, banner) = match res {
        Ok(Ok(s)) => ("open", probe(s).await),
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::ConnectionRefused => ("closed", String::new()),
        Ok(Err(_)) | Err(_) => ("filtered", String::new()),
    };
    PortResult { port: addr.port(), state, service: service_name(addr.port()), banner, ms }
}

/// Streams `port-scan-{id}` events: {type:"result", ...} per port, then {type:"done", open, closed, filtered}.
#[tauri::command]
pub async fn ports_scan(app: AppHandle, id: String, target: String, ports: String, timeout_ms: Option<u64>) -> Result<usize, String> {
    if !valid_host(&target) {
        return Err("некорректный адрес".into());
    }
    let ports = parse_ports(&ports)?;
    let ip = tokio::net::lookup_host((target.as_str(), 0))
        .await
        .map_err(|e| format!("не удалось разрешить {target}: {e}"))?
        .next()
        .ok_or("адрес не найден")?
        .ip();
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(1200).clamp(200, 10000));
    let total = ports.len();
    let event = format!("port-scan-{id}");
    tauri::async_runtime::spawn(async move {
        let sem = Arc::new(Semaphore::new(CONCURRENCY));
        let mut tasks = tokio::task::JoinSet::new();
        for port in ports {
            let permit = sem.clone().acquire_owned().await;
            tasks.spawn(async move {
                let _permit = permit;
                check(SocketAddr::new(ip, port), timeout).await
            });
        }
        let mut counts: HashMap<&str, usize> = HashMap::new();
        while let Some(Ok(r)) = tasks.join_next().await {
            *counts.entry(r.state).or_default() += 1;
            let mut v = serde_json::to_value(&r).unwrap_or_default();
            v["type"] = "result".into();
            let _ = app.emit(&event, v);
        }
        let _ = app.emit(&event, serde_json::json!({
            "type": "done", "ip": ip.to_string(),
            "open": counts.get("open").copied().unwrap_or(0),
            "closed": counts.get("closed").copied().unwrap_or(0),
            "filtered": counts.get("filtered").copied().unwrap_or(0),
        }));
    });
    Ok(total)
}

#[derive(Serialize)]
pub struct Listener {
    proto: &'static str,
    addr: String,
    port: u16,
    pid: Option<u32>,
    process: String,
    service: &'static str,
}

/// Sockets this machine listens on (TCP LISTEN, bound UDP) with owning processes where visible
/// (processes of other users need root to be resolved on Linux).
#[tauri::command]
pub async fn ports_listening() -> Result<Vec<Listener>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        use netstat2::{get_sockets_info, AddressFamilyFlags, ProtocolFlags, ProtocolSocketInfo, TcpState};
        let sockets = get_sockets_info(AddressFamilyFlags::IPV4 | AddressFamilyFlags::IPV6, ProtocolFlags::TCP | ProtocolFlags::UDP)
            .map_err(err)?;
        let mut sys = sysinfo::System::new();
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        let name = |pid: u32| sys.process(sysinfo::Pid::from_u32(pid)).map(|p| p.name().to_string_lossy().into_owned()).unwrap_or_default();
        let mut out: Vec<Listener> = sockets
            .into_iter()
            .filter_map(|s| {
                let pid = s.associated_pids.first().copied();
                let (proto, addr, port) = match s.protocol_socket_info {
                    ProtocolSocketInfo::Tcp(t) if t.state == TcpState::Listen => ("tcp", t.local_addr, t.local_port),
                    ProtocolSocketInfo::Udp(u) => ("udp", u.local_addr, u.local_port),
                    _ => return None,
                };
                Some(Listener { proto, addr: addr.to_string(), port, pid, process: pid.map(name).unwrap_or_default(), service: service_name(port) })
            })
            .collect();
        out.sort_by(|a, b| (a.port, a.proto, &a.addr).cmp(&(b.port, b.proto, &b.addr)));
        out.dedup_by(|a, b| a.port == b.port && a.proto == b.proto && a.addr == b.addr);
        Ok(out)
    })
    .await
    .map_err(err)?
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn port_lists() {
        assert_eq!(parse_ports("443, 22,80;22").unwrap(), [22, 80, 443], "sorted and unique");
        assert_eq!(parse_ports("8000-8003").unwrap(), [8000, 8001, 8002, 8003]);
        assert!(parse_ports("").is_err());
        assert!(parse_ports("0").is_err());
        assert!(parse_ports("90-80").is_err());
        assert!(parse_ports("http").is_err());
        assert!(parse_ports("70000").is_err());
        assert!(parse_ports("1-65535").is_err(), "too many ports at once");
    }

    #[test]
    fn names_and_banners() {
        assert_eq!(service_name(22), "ssh");
        assert_eq!(service_name(6443), "kubernetes api");
        assert_eq!(service_name(12345), "");
        assert_eq!(printable(b"SSH-2.0-OpenSSH_9.6\r\nsecond line"), "SSH-2.0-OpenSSH_9.6");
        assert_eq!(printable(b"\x1b[31mred\x07"), "[31mred", "control characters are dropped");
        assert_eq!(printable(&[b'x'; 500]).len(), 120);
    }
}
