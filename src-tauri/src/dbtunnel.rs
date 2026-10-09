//! SSH tunnels for database profiles that are reachable only through a bastion ("jump host"):
//! `ssh -N -L 127.0.0.1:<free port>:<db host>:<db port> <bastion>`, one per profile, kept until the
//! profile changes or OpsDeck exits. The bastion is an SSH profile or a Host from ~/.ssh/config (so its
//! ProxyJump / IdentityFile apply); login is by key, like the monitoring board.

use crate::sysmon::sanitize_ssh_args;
use std::{collections::HashMap, process::Stdio, time::Duration};
use tokio::{io::AsyncReadExt, net::TcpStream};

const READY_TIMEOUT: Duration = Duration::from_secs(12);

#[derive(Default)]
pub struct TunnelState {
    map: tokio::sync::Mutex<HashMap<String, Tunnel>>,
}

struct Tunnel {
    /// what the tunnel was made for: a changed profile gets a new one
    spec: String,
    port: u16,
    child: tokio::process::Child,
}

/// `-L` target; an IPv6 address goes in brackets.
fn forward(local: u16, host: &str, port: u16) -> String {
    let h = if host.contains(':') { format!("[{host}]") } else { host.to_string() };
    format!("127.0.0.1:{local}:{h}:{port}")
}

/// The whole ssh command line; `dest` is what `probe_args` gave (options, then the destination).
fn ssh_args(local: u16, host: &str, port: u16, dest: &[String], extra: &[String]) -> Vec<String> {
    let mut a: Vec<String> = ["-N", "-T", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3"]
        .map(String::from)
        .into();
    a.extend(extra.iter().cloned());
    a.push("-L".into());
    a.push(forward(local, host, port));
    a.extend(dest.iter().cloned());
    a
}

fn explain(stderr: &str) -> String {
    if stderr.contains("Host key verification failed") {
        return "ключ хоста ещё не принят — подключитесь к jump-хосту один раз из терминала".into();
    }
    if stderr.contains("Permission denied") || stderr.contains("batch mode") {
        return "нет входа на jump-хост по ключу — добавьте ключ (ssh-copy-id) в профиль SSH".into();
    }
    let line = stderr.lines().map(str::trim).rfind(|l| !l.is_empty()).unwrap_or("ssh завершился");
    format!("jump-хост: {}", line.chars().take(300).collect::<String>())
}

fn free_port() -> Result<u16, String> {
    let l = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    l.local_addr().map(|a| a.port()).map_err(|e| e.to_string())
}

/// Local port that leads to `host:port` through `jump` ("alias:<Host>" or "id:<SSH profile>").
pub async fn open(state: &TunnelState, id: &str, jump: &str, host: &str, port: u16) -> Result<u16, String> {
    open_with(state, id, jump, host, port, &[]).await
}

/// `extra`: more ssh options before the forward (tests point ssh at their own config with `-F`).
async fn open_with(state: &TunnelState, id: &str, jump: &str, host: &str, port: u16, extra: &[String]) -> Result<u16, String> {
    let spec = format!("{jump}|{host}|{port}");
    let mut map = state.map.lock().await;
    if let Some(t) = map.get_mut(id) {
        if t.spec == spec && matches!(t.child.try_wait(), Ok(None)) {
            return Ok(t.port);
        }
        map.remove(id); // dropped: kill_on_drop ends the old ssh
    }
    let dest = sanitize_ssh_args(&crate::ssh::probe_args(jump)?)?;
    let local = free_port()?;
    let mut cmd = tokio::process::Command::new("ssh");
    cmd.args(ssh_args(local, host, port, &dest, extra)).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped()).kill_on_drop(true);
    crate::process::no_console_tokio(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("не удалось запустить ssh: {e}"))?;
    let mut stderr = child.stderr.take();
    let started = std::time::Instant::now();
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            let mut text = String::new();
            if let Some(s) = stderr.as_mut() {
                let _ = tokio::time::timeout(Duration::from_secs(1), s.read_to_string(&mut text)).await;
            }
            return Err(if text.trim().is_empty() { format!("ssh завершился с кодом {status}") } else { explain(&text) });
        }
        // the port is opened by ssh only after the login: connecting means the tunnel is up
        if TcpStream::connect(("127.0.0.1", local)).await.is_ok() {
            break;
        }
        if started.elapsed() > READY_TIMEOUT {
            return Err(format!("jump-хост не ответил за {} с", READY_TIMEOUT.as_secs()));
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    if let Some(mut s) = stderr {
        // keep the pipe empty so a chatty ssh never blocks on it
        tokio::spawn(async move {
            let _ = tokio::io::copy(&mut s, &mut tokio::io::sink()).await;
        });
    }
    map.insert(id.to_string(), Tunnel { spec, port: local, child });
    Ok(local)
}

/// The profile is gone: its tunnel goes too (skipped if one is being opened right now; it ends with the app).
pub fn close(state: &TunnelState, id: &str) {
    if let Ok(mut m) = state.map.try_lock() {
        m.remove(id);
    }
}

/// On exit: no ssh left behind.
pub fn close_all(state: &TunnelState) {
    if let Ok(mut m) = state.map.try_lock() {
        m.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forward_target_and_command_line() {
        assert_eq!(forward(5433, "db.internal", 5432), "127.0.0.1:5433:db.internal:5432");
        assert_eq!(forward(6380, "fd00::5", 6379), "127.0.0.1:6380:[fd00::5]:6379");
        let dest = vec!["-p".to_string(), "2222".into(), "ops@bastion".into()];
        let a = ssh_args(5433, "db", 5432, &dest, &[]);
        assert_eq!(a.last().unwrap(), "ops@bastion", "the destination is last");
        assert!(a.windows(2).any(|w| w == ["-L", "127.0.0.1:5433:db:5432"]));
        for must in ["-N", "BatchMode=yes", "ExitOnForwardFailure=yes"] {
            assert!(a.iter().any(|x| x == must), "{must}");
        }
    }

    #[test]
    fn errors_are_explained() {
        assert!(explain("ops@h: Permission denied (publickey).").contains("ssh-copy-id"));
        assert!(explain("Host key verification failed.").contains("один раз"));
        assert_eq!(explain("\n\nssh: Could not resolve hostname x\n"), "jump-хост: ssh: Could not resolve hostname x");
    }

    /// A real `ssh` is not needed: a missing host makes probe_args fail before anything starts.
    #[test]
    fn an_unknown_jump_host_is_an_error() {
        let st = TunnelState::default();
        let r = tauri::async_runtime::block_on(open(&st, "p1", "bogus", "db", 5432));
        assert!(r.is_err());
        let r = tauri::async_runtime::block_on(open(&st, "p1", "alias:-oProxyCommand=x", "db", 5432));
        assert!(r.is_err(), "an option can't hide in the host name");
    }

    /// Real sshd (a throwaway one on a high port, key login) and a real "database" (an echo server):
    /// `cargo test --lib dbtunnel_live -- --ignored`. Needs sshd and ssh-keygen; changes $HOME for the process.
    #[test]
    #[ignore = "starts sshd"]
    fn dbtunnel_live() {
        use std::process::Command;
        let t = std::env::temp_dir().join(format!("opsdeck-tunnel-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&t);
        std::fs::create_dir_all(t.join("home/.ssh")).unwrap();
        let keygen = |f: &str| assert!(Command::new("ssh-keygen").args(["-q", "-t", "ed25519", "-N", "", "-f", f]).status().unwrap().success());
        keygen(t.join("hostkey").to_str().unwrap());
        keygen(t.join("id").to_str().unwrap());
        std::fs::copy(t.join("id.pub"), t.join("authorized_keys")).unwrap();
        let sshd_port = free_port().unwrap();
        std::fs::write(
            t.join("sshd_config"),
            format!("Port {sshd_port}\nListenAddress 127.0.0.1\nHostKey {0}/hostkey\nAuthorizedKeysFile {0}/authorized_keys\nPidFile {0}/pid\nStrictModes no\nPasswordAuthentication no\nAllowTcpForwarding yes\n", t.display()),
        )
        .unwrap();
        let mut sshd = Command::new("/usr/sbin/sshd").args(["-D", "-f"]).arg(t.join("sshd_config")).spawn().unwrap();
        let user = std::env::var("USER").unwrap();
        std::fs::write(
            t.join("ssh_config"),
            format!("Host jt\n HostName 127.0.0.1\n Port {sshd_port}\n User {user}\n IdentityFile {0}/id\n IdentitiesOnly yes\n StrictHostKeyChecking no\n UserKnownHostsFile {0}/known_hosts\n", t.display()),
        )
        .unwrap();
        // OpenSSH reads the passwd home, not $HOME: the config is passed with -F; opsdeck's own lookup of the alias uses $HOME
        std::fs::create_dir_all(t.join("home/.ssh")).unwrap();
        std::fs::write(t.join("home/.ssh/config"), "Host jt\n HostName 127.0.0.1\n").unwrap();
        std::env::set_var("HOME", t.join("home"));
        let cfg = vec!["-F".to_string(), t.join("ssh_config").to_string_lossy().into_owned()];
        tauri::async_runtime::block_on(async {
            // the "database": answers what it gets
            let db = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let db_port = db.local_addr().unwrap().port();
            tokio::spawn(async move {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                loop {
                    let Ok((mut s, _)) = db.accept().await else { return };
                    tokio::spawn(async move {
                        let mut buf = [0u8; 64];
                        while let Ok(n) = s.read(&mut buf).await {
                            if n == 0 || s.write_all(&buf[..n]).await.is_err() {
                                return;
                            }
                        }
                    });
                }
            });
            tokio::time::sleep(Duration::from_millis(500)).await; // sshd is listening
            let st = TunnelState::default();
            let port = open_with(&st, "p1", "alias:jt", "127.0.0.1", db_port, &cfg).await.expect("tunnel");
            assert_eq!(open_with(&st, "p1", "alias:jt", "127.0.0.1", db_port, &cfg).await.unwrap(), port, "the tunnel is reused");
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let mut c = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            c.write_all(b"ping").await.unwrap();
            let mut buf = [0u8; 4];
            c.read_exact(&mut buf).await.unwrap();
            assert_eq!(&buf, b"ping");
            // another target = another tunnel
            let other = open_with(&st, "p1", "alias:jt", "127.0.0.1", db_port + 1, &cfg).await.unwrap();
            assert_ne!(other, port);
            close_all(&st);
            tokio::time::sleep(Duration::from_millis(500)).await;
            assert!(TcpStream::connect(("127.0.0.1", other)).await.is_err(), "ssh is gone after close_all");
        });
        let _ = sshd.kill();
        let _ = sshd.wait();
        let _ = std::fs::remove_dir_all(&t);
    }
}
