//! HTTP-клиент для запросов «к себе».
//!
//! В корпоративной сети в окружении обычно стоит `http_proxy`/`HTTPS_PROXY`, и reqwest уважает их
//! для любого адреса, включая 127.0.0.1. Прокси до петли, разумеется, не дотягивается: из отчёта —
//! «Папка в web» считала, что раздача не ответила, хотя туннель был живой, а локальный ИИ на том же
//! компьютере мог не отвечать по той же причине. Поэтому к петле ходим мимо прокси, а к чужим
//! адресам — как настроено в системе.

/// Адрес ведёт на эту же машину (петля), пусть даже записан именем.
pub fn loopback(url: &str) -> bool {
    let rest = url.split("://").nth(1).unwrap_or(url);
    let host = rest.split('/').next().unwrap_or("");
    let host = host.rsplit('@').next().unwrap_or(host);
    // [::1]:8080 → ::1, 127.0.0.1:8080 → 127.0.0.1
    let host = if let Some(end) = host.strip_prefix('[').and_then(|h| h.split(']').next()) {
        end
    } else {
        host.split(':').next().unwrap_or(host)
    };
    let host = host.to_ascii_lowercase();
    // «127.example.com» — обычный домен, а не петля: сравниваем как адрес, а не как строку
    host == "localhost" || host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

/// Клиент для этого адреса: к петле — мимо системного прокси.
pub fn client_for(url: &str) -> reqwest::ClientBuilder {
    let b = reqwest::Client::builder();
    if loopback(url) {
        b.no_proxy()
    } else {
        b
    }
}

#[cfg(test)]
mod tests {
    use super::loopback;

    #[test]
    fn loopback_is_recognised_with_port_user_and_brackets() {
        for url in ["http://127.0.0.1:8080/health", "http://localhost/v1/models", "http://[::1]:11434/", "https://127.0.0.5:9000", "http://user@localhost:3000/x"] {
            assert!(loopback(url), "{url}");
        }
        for url in ["http://172.21.255.30:8611/", "https://ollama.example.com/v1", "http://127.example.com/", "http://10.0.0.1/"] {
            assert!(!loopback(url), "{url}");
        }
    }
}
