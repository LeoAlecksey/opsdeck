//! gopass — хранилище паролей на GPG и git (`pass`-совместимое), только чтение: как Passbolt.
//! Всё через CLI `gopass`: список — `gopass ls --flat`, запись — `gopass show -f -n -- <путь>`.
//! Расшифровывает gpg-agent, пароль от ключа спрашивает его pinentry — OpsDeck пароля ключа не видит.
//!
//! Расшифрованное держится в памяти недолго: фоновый опрос алертов с источником из gopass не должен
//! раз в минуту поднимать pinentry, поэтому он берёт только то, что недавно открывал сам человек.

use crate::keepass::{self, Use};
use serde::Serialize;
use std::{
    collections::HashMap,
    process::Stdio,
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};
use tauri::AppHandle;
use zeroize::Zeroizing;

/// Сколько фоновые опросы могут пользоваться секретом, который расшифровал человек.
const KEEP: Duration = Duration::from_secs(30 * 60);
/// gpg-agent может ждать ввода пароля в pinentry: даём человеку время.
const SHOW_TIMEOUT: Duration = Duration::from_secs(120);

/// Расшифровано когда, пароль, логин.
type Cached = (Instant, Zeroizing<String>, String);
static CACHE: LazyLock<Mutex<HashMap<String, Cached>>> = LazyLock::new(Default::default);

#[derive(Serialize, Clone, PartialEq, Debug)]
pub struct Entry {
    /// путь в хранилище: `infra/prod/grafana`
    pub id: String,
    pub title: String,
    pub folder: String,
}

#[derive(Serialize)]
pub struct Status {
    pub installed: bool,
    pub version: String,
    /// хранилище есть и читается (`gopass ls` прошёл)
    pub ready: bool,
    pub error: String,
}

/// Путь записи: как его печатает `gopass ls --flat`. Без ведущего дефиса (иначе это флаг),
/// без `..` и управляющих символов.
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 512
        && !id.starts_with('-')
        && !id.starts_with('/')
        && !id.split('/').any(|p| p.is_empty() || p == "..")
        && !id.chars().any(|c| c.is_control())
}

/// `gopass ls --flat`: по записи на строку; пустые строки и мусор отбрасываются.
fn parse_list(out: &str) -> Vec<Entry> {
    let mut v: Vec<Entry> = out
        .lines()
        .map(str::trim)
        .filter(|l| valid_id(l))
        .map(|id| {
            let (folder, title) = id.rsplit_once('/').unwrap_or(("", id));
            Entry { id: id.to_string(), title: title.to_string(), folder: folder.to_string() }
        })
        .collect();
    v.sort_by(|a, b| a.id.cmp(&b.id));
    v.dedup_by(|a, b| a.id == b.id);
    v
}

/// Содержимое записи: первая строка — пароль, дальше `ключ: значение` (как пишут gopass и pass,
/// в том числе после разделителя `---`). Логин — из user / username / login.
fn parse_secret(text: &str) -> (Zeroizing<String>, String) {
    let mut lines = text.lines();
    let password = Zeroizing::new(lines.next().unwrap_or_default().trim_end_matches('\r').to_string());
    let user = lines
        .filter_map(|l| l.split_once(':'))
        .find(|(k, _)| matches!(k.trim().to_ascii_lowercase().as_str(), "user" | "username" | "login"))
        .map(|(_, v)| v.trim().to_string())
        .unwrap_or_default();
    (password, user)
}

/// Ошибка gopass → по-человечески. Сам stderr не показываем: в нём бывают пути и id ключей.
fn explain(stderr: &str) -> String {
    let s = stderr.to_lowercase();
    if s.contains("not initialized") || s.contains("no stores") || s.contains("gopass init") {
        "хранилище gopass не создано: выполните gopass init или gopass clone".into()
    } else if s.contains("not found") || s.contains("does not exist") || s.contains("not in the password store") {
        "записи нет в gopass (переименовали или удалили?)".into()
    } else if s.contains("decrypt") || s.contains("pinentry") || s.contains("no secret key") || s.contains("cancel") {
        "gopass не смог расшифровать запись: пароль ключа GPG не введён или ключа нет на этом компьютере".into()
    } else {
        "gopass завершился с ошибкой — подробности в выводе gopass в терминале".into()
    }
}

async fn run(args: &[&str], timeout: Duration) -> Result<String, String> {
    let mut cmd = tokio::process::Command::new("gopass");
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    // без цвета и без вопросов в терминал: отвечать в нём некому
    cmd.env("GOPASS_NO_NOTIFY", "true").env("NO_COLOR", "1").env("GOPASS_NO_REMINDER", "1");
    crate::process::no_console_tokio(&mut cmd);
    let child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "gopass не найден: установите его (gopass.pw) и откройте OpsDeck заново".to_string()
        } else {
            format!("не удалось запустить gopass: {e}")
        }
    })?;
    let out = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| "gopass не ответил: возможно, ждёт пароль ключа GPG в окне pinentry".to_string())?
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        log::warn!("gopass {}: exit {:?}", args.first().unwrap_or(&""), out.status.code());
        return Err(explain(&err));
    }
    String::from_utf8(out.stdout).map_err(|_| "gopass вернул не UTF-8".to_string())
}

/// Расшифровать запись (по просьбе человека) или взять недавно расшифрованную (в фоне).
async fn secret(id: &str, used: Use) -> Result<(Zeroizing<String>, String), String> {
    if !valid_id(id) {
        return Err("некорректный путь записи gopass".into());
    }
    {
        let mut cache = CACHE.lock().unwrap();
        cache.retain(|_, (at, _, _)| at.elapsed() < KEEP);
        if used == Use::Background {
            return cache
                .get(id)
                .map(|(_, p, u)| (p.clone(), u.clone()))
                .ok_or_else(|| "gopass в фоне не спрашивает пароль ключа: откройте эту запись или панель вручную".to_string());
        }
    }
    let text = Zeroizing::new(run(&["show", "-f", "-n", "--", id], SHOW_TIMEOUT).await?);
    let (password, user) = parse_secret(&text);
    CACHE.lock().unwrap().insert(id.to_string(), (Instant::now(), password.clone(), user.clone()));
    Ok((password, user))
}

/// Логин и пароль для SSH, баз, MikroTik и веб-панелей.
pub async fn credentials(id: &str, used: Use) -> Result<(String, String), String> {
    let (p, u) = secret(id, used).await?;
    Ok((u, p.to_string()))
}

#[tauri::command]
pub async fn gp_status() -> Status {
    let version = match run(&["--version"], Duration::from_secs(10)).await {
        Ok(v) => v.lines().next().unwrap_or_default().trim().to_string(),
        Err(e) => return Status { installed: false, version: String::new(), ready: false, error: e },
    };
    match run(&["ls", "--flat"], Duration::from_secs(30)).await {
        Ok(_) => Status { installed: true, version, ready: true, error: String::new() },
        Err(e) => Status { installed: true, version, ready: false, error: e },
    }
}

#[tauri::command]
pub async fn gp_entries(query: Option<String>) -> Result<Vec<Entry>, String> {
    let all = parse_list(&run(&["ls", "--flat"], Duration::from_secs(30)).await?);
    let q = query.unwrap_or_default().to_lowercase();
    Ok(all.into_iter().filter(|e| q.is_empty() || e.id.to_lowercase().contains(&q)).collect())
}

/// field: password | username. В буфер обмена на 30 с, как у KeePass и Passbolt.
#[tauri::command]
pub async fn gp_copy(app: AppHandle, id: String, field: String) -> Result<(), String> {
    let (password, user) = secret(&id, Use::User).await?;
    let value = match field.as_str() {
        "password" => password.to_string(),
        "username" if !user.is_empty() => user,
        "username" => return Err("в записи нет строки user:, username: или login:".into()),
        _ => return Err("unknown field".into()),
    };
    keepass::copy_secret(&app, value)
}

/// Логин записи (для подписи в списке и в выборе записи) — после расшифровки.
#[tauri::command]
pub async fn gp_username(id: String) -> Result<String, String> {
    Ok(secret(&id, Use::User).await?.1)
}

/// Забыть всё расшифрованное (кнопка «Заблокировать» в разделе).
#[tauri::command]
pub fn gp_forget() {
    CACHE.lock().unwrap().clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_list_is_paths_with_folders() {
        let out = "infra/prod/grafana\ninfra/prod/db-main\nmail\n\n  infra/stage/argocd  \n-oops\n../etc\ninfra//x\n";
        let v = parse_list(out);
        assert_eq!(v.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), ["infra/prod/db-main", "infra/prod/grafana", "infra/stage/argocd", "mail"]);
        assert_eq!(v[1], Entry { id: "infra/prod/grafana".into(), title: "grafana".into(), folder: "infra/prod".into() });
        assert_eq!(v[3].folder, "");
    }

    #[test]
    fn password_is_the_first_line_and_the_login_comes_from_the_body() {
        let (p, u) = parse_secret("s3cr3t: with colon\nurl: https://grafana.example.com\nUsername: ops\n");
        assert_eq!(p.as_str(), "s3cr3t: with colon", "the first line is the password even with a colon");
        assert_eq!(u, "ops");
        let (p, u) = parse_secret("pw\n---\nlogin: deploy\n");
        assert_eq!((p.as_str(), u.as_str()), ("pw", "deploy"));
        let (p, u) = parse_secret("only-password");
        assert_eq!((p.as_str(), u.as_str()), ("only-password", ""));
        let (p, _) = parse_secret("crlf\r\nuser: x\r\n");
        assert_eq!(p.as_str(), "crlf");
    }

    #[test]
    fn a_path_cannot_be_a_flag_or_leave_the_store() {
        assert!(valid_id("infra/prod/grafana"));
        assert!(valid_id("Почта/личная"));
        assert!(!valid_id("-c"));
        assert!(!valid_id("--clip"));
        assert!(!valid_id("/etc/passwd"));
        assert!(!valid_id("infra/../../x"));
        assert!(!valid_id("a\nb"));
        assert!(!valid_id(""));
    }

    #[test]
    fn errors_are_explained_without_stderr() {
        assert!(explain("Error: failed to decrypt: gpg: decryption failed: No secret key").contains("расшифровать"));
        assert!(explain("Error: entry is not in the password store").contains("записи нет"));
        assert!(explain("Error: password store is not initialized. Try 'gopass init'").contains("gopass init"));
        assert!(!explain("Error: something /home/demo/.password-store/x.gpg").contains("/home"));
    }

    #[test]
    fn the_background_never_asks_for_the_key_password() {
        let r = tauri::async_runtime::block_on(secret("infra/never-opened", Use::Background));
        assert!(r.unwrap_err().contains("в фоне"));
    }
}
