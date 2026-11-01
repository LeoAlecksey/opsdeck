//! Backend side of the interface language: the same locales/en.json as the UI, for texts the
//! backend shows itself (desktop notifications). Error strings go to the UI and are translated there.

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        OnceLock,
    },
};

static ENGLISH: AtomicBool = AtomicBool::new(false);

fn dict() -> &'static HashMap<String, String> {
    static D: OnceLock<HashMap<String, String>> = OnceLock::new();
    D.get_or_init(|| serde_json::from_str(include_str!("../../locales/en.json")).unwrap_or_default())
}

/// The UI tells the backend its language at startup.
#[tauri::command]
pub async fn set_lang(app: tauri::AppHandle, lang: String) {
    use_lang(&lang);
    // в заголовке окна имя основного окружения переводится; заголовок читается с диска
    let _ = tauri::async_runtime::spawn_blocking(move || crate::profile::retitle(&app)).await;
}

fn use_lang(lang: &str) {
    ENGLISH.store(lang == "en", Ordering::Relaxed);
}

/// Translate a text that has `{}` placeholders, then fill them with `args`.
/// `tr("Задачи на сегодня: {}", &[&n.to_string()])`
pub fn tr(template: &str, args: &[&str]) -> String {
    let t = if ENGLISH.load(Ordering::Relaxed) { dict().get(template).map(String::as_str).unwrap_or(template) } else { template };
    let mut out = String::new();
    let mut parts = t.split("{}");
    out += parts.next().unwrap_or("");
    for (i, p) in parts.enumerate() {
        out += args.get(i).copied().unwrap_or("");
        out += p;
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn fills_placeholders() {
        assert_eq!(super::tr("просрочено: {}", &["3"]), "просрочено: 3");
        super::use_lang("en");
        assert_eq!(super::tr("просрочено: {}", &["3"]), "overdue: 3");
        super::use_lang("ru");
    }
}
