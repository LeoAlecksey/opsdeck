//! Алерты на телефон через ntfy или Gotify: те же алерты, о которых OpsDeck показывает уведомление
//! на рабочем столе, уходят на свой (или публичный) сервер, а с него — в приложение на телефоне.
//! Адрес и топик лежат в настройках алертов, токен — в keyring ОС. Текст алерта уходит на сервер,
//! который указал человек, и больше никуда.

use crate::{alerts::Alert, store};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

const TOKEN_KEY: &str = "alerts:push";
/// Больше пяти отдельных пушей подряд — шум: остальные одним сообщением «ещё N».
const MAX_EACH: usize = 5;

#[derive(Serialize, Deserialize, Clone, Default, PartialEq, Debug)]
#[serde(default)]
pub struct PushConfig {
    /// "" — выключено, "ntfy" или "gotify"
    pub kind: String,
    /// адрес сервера: https://ntfy.sh, https://gotify.example.com
    pub url: String,
    /// ntfy: топик; у Gotify топика нет — приложение задаёт токен
    pub topic: String,
}

/// Одно сообщение, ещё не привязанное к серверу.
#[derive(Debug, PartialEq)]
pub struct Msg {
    pub title: String,
    pub body: String,
    /// 0 — восстановился, 1 — находка ИИ / прочее, 2 — firing, 3 — critical
    pub level: u8,
    pub click: Option<String>,
}

fn level(a: &Alert) -> u8 {
    if a.status == "resolved" {
        0
    } else if a.kind == "ai" {
        1
    } else if a.severity.to_lowercase().contains("crit") {
        3
    } else {
        2
    }
}

/// Ссылка, по которой пуш откроет алерт: дашборд, панель или правило, только http(s).
fn click(a: &Alert) -> Option<String> {
    [&a.panel_url, &a.dashboard_url, &a.generator_url]
        .into_iter()
        .find(|u| u.starts_with("https://") || u.starts_with("http://"))
        .cloned()
}

/// Что отправить по новым алертам: по одному на первые пять, остальные — одной сводкой.
pub fn messages(shown: &[&Alert]) -> Vec<Msg> {
    let mut out: Vec<Msg> = shown
        .iter()
        .take(MAX_EACH)
        .map(|a| {
            let body = [a.summary.as_str(), a.description.as_str(), a.value.as_str()]
                .into_iter()
                .find(|x| !x.is_empty())
                .unwrap_or(&a.source)
                .chars()
                .take(500)
                .collect::<String>();
            let state = if a.status == "resolved" { "✅ " } else { "" };
            Msg { title: format!("{state}{} · {}", a.name, a.source), body, level: level(a), click: click(a) }
        })
        .collect();
    if shown.len() > MAX_EACH {
        let rest = &shown[MAX_EACH..];
        let more = rest.len().to_string();
        out.push(Msg {
            title: crate::i18n::tr("🔔 Ещё {} алертов", &[&more]),
            body: rest.iter().map(|a| a.name.as_str()).collect::<Vec<_>>().join(", ").chars().take(500).collect(),
            level: rest.iter().map(|a| level(a)).max().unwrap_or(2),
            click: None,
        });
    }
    out
}

/// Топик ntfy: латиница, цифры, `-` и `_` — иначе сервер поймёт адрес по-своему.
fn valid_topic(t: &str) -> bool {
    !t.is_empty() && t.len() <= 64 && t.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Настройки, с которыми можно отправлять; текст ошибки — для человека.
pub fn check(cfg: &PushConfig) -> Result<(), String> {
    if cfg.kind.is_empty() {
        return Ok(());
    }
    if !matches!(cfg.kind.as_str(), "ntfy" | "gotify") {
        return Err(format!("неизвестный сервис уведомлений: {}", cfg.kind));
    }
    let url = reqwest::Url::parse(cfg.url.trim()).map_err(|_| "адрес сервера уведомлений: нужен вида https://ntfy.sh".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("адрес сервера уведомлений должен начинаться с https://".into());
    }
    if cfg.kind == "ntfy" && !valid_topic(&cfg.topic) {
        return Err("топик ntfy: латиница, цифры, - и _, до 64 символов".into());
    }
    Ok(())
}

/// Адрес и тело запроса. ntfy принимает JSON на корень сервера (так заголовки с кириллицей не
/// нужны), Gotify — на /message.
pub fn request(cfg: &PushConfig, m: &Msg) -> (String, Value) {
    let base = cfg.url.trim().trim_end_matches('/');
    match cfg.kind.as_str() {
        "gotify" => {
            let priority = [2, 4, 6, 9][m.level as usize];
            let mut body = json!({ "title": m.title, "message": m.body, "priority": priority });
            if let Some(u) = &m.click {
                body["extras"] = json!({ "client::notification": { "click": { "url": u } } });
            }
            (format!("{base}/message"), body)
        }
        _ => {
            let tag = ["white_check_mark", "robot", "warning", "rotating_light"][m.level as usize];
            let priority = [2, 3, 4, 5][m.level as usize];
            let mut body = json!({ "topic": cfg.topic, "title": m.title, "message": m.body, "priority": priority, "tags": [tag] });
            if let Some(u) = &m.click {
                body["click"] = json!(u);
            }
            (base.to_string(), body)
        }
    }
}

/// Ответ сервера → понятная причина. Токен в тексте не появляется никогда.
fn explain(kind: &str, status: reqwest::StatusCode) -> String {
    match status.as_u16() {
        401 | 403 if kind == "gotify" => "Gotify не принял токен приложения: проверьте его в настройках алертов".into(),
        401 | 403 => "ntfy не пустил в топик: нужен токен доступа (tk_…) или другой топик".into(),
        404 => "по этому адресу нет сервера уведомлений: проверьте URL".into(),
        429 => "сервер уведомлений просит отправлять реже (429)".into(),
        s => format!("сервер уведомлений ответил {s}"),
    }
}

pub fn token() -> Option<String> {
    store::secret_get(TOKEN_KEY).filter(|t| !t.is_empty())
}

/// Some(непустой) — заменить, Some("") — убрать, None — не трогать.
pub fn set_token(token: Option<String>) -> Result<(), String> {
    match token {
        Some(t) if t.trim().is_empty() => {
            store::secret_delete(TOKEN_KEY);
            Ok(())
        }
        Some(t) => store::secret_set(TOKEN_KEY, t.trim()),
        None => Ok(()),
    }
}

pub async fn send(cfg: &PushConfig, msgs: &[Msg]) -> Result<(), String> {
    check(cfg)?;
    let token = token();
    if cfg.kind == "gotify" && token.is_none() {
        return Err("для Gotify нужен токен приложения".into());
    }
    // без переадресаций: X-Gotify-Key при редиректе на чужой хост ушёл бы туда же
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    for m in msgs {
        let (url, body) = request(cfg, m);
        let mut req = client.post(&url).json(&body);
        if let Some(t) = &token {
            req = if cfg.kind == "gotify" { req.header("X-Gotify-Key", t) } else { req.bearer_auth(t) };
        }
        let r = req.send().await.map_err(|e| {
            if e.is_timeout() {
                "сервер уведомлений не ответил за 15 с".to_string()
            } else {
                "не удалось связаться с сервером уведомлений: проверьте адрес".to_string()
            }
        })?;
        if !r.status().is_success() {
            return Err(explain(&cfg.kind, r.status()));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn alert(name: &str, severity: &str, status: &str) -> Alert {
        Alert {
            name: name.into(),
            severity: severity.into(),
            status: status.into(),
            source: "prod grafana".into(),
            summary: format!("{name}: something"),
            kind: "alert".into(),
            ..Default::default()
        }
    }

    #[test]
    fn ntfy_gets_json_with_topic_priority_and_click() {
        let cfg = PushConfig { kind: "ntfy".into(), url: "https://ntfy.example.com/".into(), topic: "ops-alerts".into() };
        let mut a = alert("HighCPU", "critical", "firing");
        a.dashboard_url = "https://grafana.example.com/d/x".into();
        let m = messages(&[&a]);
        let (url, body) = request(&cfg, &m[0]);
        assert_eq!(url, "https://ntfy.example.com");
        assert_eq!(body["topic"], "ops-alerts");
        assert_eq!(body["title"], "HighCPU · prod grafana");
        assert_eq!(body["priority"], 5);
        assert_eq!(body["tags"][0], "rotating_light");
        assert_eq!(body["click"], "https://grafana.example.com/d/x");
    }

    #[test]
    fn gotify_posts_to_message_and_resolved_is_quiet() {
        let cfg = PushConfig { kind: "gotify".into(), url: "https://gotify.example.com".into(), topic: String::new() };
        let m = messages(&[&alert("DiskFull", "warning", "resolved")]);
        let (url, body) = request(&cfg, &m[0]);
        assert_eq!(url, "https://gotify.example.com/message");
        assert_eq!(body["title"], "✅ DiskFull · prod grafana");
        assert_eq!(body["priority"], 2);
        assert!(body.get("extras").is_none(), "no link — no click action");
    }

    #[test]
    fn many_alerts_become_five_and_a_summary() {
        let list: Vec<Alert> = (0..8).map(|i| alert(&format!("A{i}"), if i == 7 { "critical" } else { "warning" }, "firing")).collect();
        let refs: Vec<&Alert> = list.iter().collect();
        let m = messages(&refs);
        assert_eq!(m.len(), 6);
        assert_eq!(m[5].body, "A5, A6, A7");
        assert_eq!(m[5].level, 3, "the summary is as loud as its worst alert");
    }

    #[test]
    fn settings_are_checked() {
        assert!(check(&PushConfig::default()).is_ok(), "off is fine");
        let ok = PushConfig { kind: "ntfy".into(), url: "https://ntfy.sh".into(), topic: "my_alerts-1".into() };
        assert!(check(&ok).is_ok());
        assert!(check(&PushConfig { topic: "a/b".into(), ..ok.clone() }).is_err());
        assert!(check(&PushConfig { topic: String::new(), ..ok.clone() }).is_err());
        assert!(check(&PushConfig { url: "ftp://ntfy.sh".into(), ..ok.clone() }).is_err());
        assert!(check(&PushConfig { url: "ntfy.sh".into(), ..ok.clone() }).is_err());
        assert!(check(&PushConfig { kind: "slack".into(), ..ok }).is_err());
        let gotify = PushConfig { kind: "gotify".into(), url: "https://gotify.example.com".into(), topic: String::new() };
        assert!(check(&gotify).is_ok(), "Gotify has no topic");
    }

    #[test]
    fn errors_are_explained_without_the_token() {
        assert!(explain("gotify", reqwest::StatusCode::UNAUTHORIZED).contains("токен"));
        assert!(explain("ntfy", reqwest::StatusCode::FORBIDDEN).contains("топик"));
        assert!(explain("ntfy", reqwest::StatusCode::NOT_FOUND).contains("URL"));
    }
}
