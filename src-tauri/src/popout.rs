//! Раздел в отдельном окне: та же страница приложения, открытая на одном модуле.
//!
//! Окно получает метку `pop-<раздел>`; фронтенд читает её у себя и монтирует только этот модуль,
//! без боковой колонки. Запрошенный раздел сверяем со списком ниже: из метки получается имя окна,
//! а из него — права в capabilities, поэтому произвольную строку туда пускать нельзя.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// Что можно вынести: идентификатор раздела и заголовок окна (он же ключ перевода).
/// Раздела `web` (Grafana · ArgoCD · GitLab) здесь нет: его страницы — нативные webview,
/// встроенные в главное окно.
const VIEWS: &[(&str, &str)] = &[
    ("terminal", "Терминал + AI"),
    ("k8s", "Kubernetes"),
    ("alerts", "Алерты"),
    ("net", "Сеть и DNS"),
    ("ssh", "SSH"),
    ("monitor", "Мониторинг хостов"),
    ("sftp", "Файлы на хостах"),
    ("yc", "Yandex Cloud"),
    ("code", "IDE: код и git"),
    ("db", "Базы данных"),
    ("notes", "Заметки"),
    ("tasks", "Задачи и напоминания"),
    ("vault", "KeePass"),
    ("passbolt", "Passbolt"),
    ("winbox", "MikroTik / WinBox"),
];

/// Заголовок раздела или `None`, если выносить его нельзя.
fn title_of(view: &str) -> Option<&'static str> {
    VIEWS.iter().find(|(id, _)| *id == view).map(|(_, title)| *title)
}

/// Размер и место окна в логических точках (физические пиксели разъехались бы при другом масштабе).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
struct Spot {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

const FILE: &str = "windows.json";
const MIN_W: f64 = 640.0;
const MIN_H: f64 = 420.0;

/// Окно, которое не видно ни на одном мониторе (отключили второй экран), открываем по центру.
fn visible_on(spot: &Spot, monitors: &[(f64, f64, f64, f64)]) -> bool {
    spot.w >= MIN_W
        && spot.h >= MIN_H
        // достаточно, чтобы на экран попадал заголовок: за него окно можно вытащить
        && monitors.iter().any(|(mx, my, mw, mh)| spot.x + spot.w > *mx && spot.x < mx + mw && spot.y + 48.0 > *my && spot.y < my + mh)
}

fn saved_spot(app: &AppHandle, view: &str) -> Option<Spot> {
    let saved: HashMap<String, Spot> = crate::store::load_json(FILE).unwrap_or_default();
    let spot = *saved.get(view)?;
    let monitors: Vec<(f64, f64, f64, f64)> = app
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let p = m.position().to_logical::<f64>(m.scale_factor());
            let s = m.size().to_logical::<f64>(m.scale_factor());
            (p.x, p.y, s.width, s.height)
        })
        .collect();
    // мониторы не удалось получить — верим сохранённому месту
    (monitors.is_empty() || visible_on(&spot, &monitors)).then_some(spot)
}

/// Куда окно поставили и каким его растянули — чтобы в следующий раз открылось там же.
fn remember(app: &AppHandle, view: &str, label: &str) {
    let Some(w) = app.get_webview_window(label) else { return };
    let Ok(scale) = w.scale_factor() else { return };
    let (Ok(pos), Ok(size)) = (w.outer_position(), w.inner_size()) else { return };
    let (p, s) = (pos.to_logical::<f64>(scale), size.to_logical::<f64>(scale));
    if s.width < MIN_W || s.height < MIN_H {
        return; // свёрнутое окно отдаёт нули
    }
    let mut saved: HashMap<String, Spot> = crate::store::load_json(FILE).unwrap_or_default();
    saved.insert(view.to_string(), Spot { x: p.x, y: p.y, w: s.width, h: s.height });
    if let Err(e) = crate::store::save_json(FILE, &saved) {
        log::warn!("popout: {e}");
    }
}

/// Какие разделы можно вынести: интерфейс спрашивает это, чтобы не предлагать невозможное.
#[tauri::command]
pub fn popout_views() -> Vec<&'static str> {
    VIEWS.iter().map(|(id, _)| *id).collect()
}

/// Открыть раздел в отдельном окне (или вернуть фокус уже открытому).
/// Асинхронная: на Windows сборка окна из синхронной команды подвешивает приложение.
#[tauri::command]
pub async fn window_popout(app: AppHandle, view: String) -> Result<(), String> {
    let title = title_of(&view).ok_or_else(|| crate::i18n::tr("этот раздел нельзя вынести в отдельное окно: {}", &[&view]))?;
    let label = format!("pop-{view}");
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.unminimize();
        return w.set_focus().map_err(crate::store::err);
    }
    let spot = saved_spot(&app, &view);
    let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title(format!("{} — OpsDeck", crate::i18n::tr(title, &[])))
        .inner_size(spot.map_or(1100.0, |s| s.w), spot.map_or(720.0, |s| s.h))
        .min_inner_size(MIN_W, MIN_H);
    builder = match spot {
        Some(s) => builder.position(s.x, s.y),
        None => builder.center(),
    };
    let window = builder.build().map_err(crate::store::err)?;
    let (handle, id, lbl) = (app.clone(), view.clone(), label.clone());
    window.on_window_event(move |e| {
        if matches!(e, tauri::WindowEvent::CloseRequested { .. }) {
            remember(&handle, &id, &lbl);
            close_sessions(&handle, &lbl);
        }
    });
    Ok(())
}

/// Терминалы закрытого окна: без этого его оболочки остались бы работать до выхода
/// из приложения — их вкладок уже нет, а процессы есть.
fn close_sessions(app: &AppHandle, label: &str) {
    crate::pty::kill_window(&app.state::<crate::pty::PtyState>(), label);
}

/// Вынесенное окно просит показать раздел, которого в нём нет: поднимаем главное.
#[tauri::command]
pub fn window_focus_main(app: AppHandle) -> Result<(), String> {
    let w = app.get_webview_window("main").ok_or("нет главного окна")?;
    let _ = w.unminimize();
    w.set_focus().map_err(crate::store::err)
}

/// Главное окно закрыли — вынесенные окна закрываем вместе с ним: без боковой колонки
/// вернуться в приложение из них нельзя.
pub fn install(app: &AppHandle) {
    let Some(main) = app.get_webview_window("main") else { return };
    let handle = app.clone();
    main.on_window_event(move |e| {
        if !matches!(e, tauri::WindowEvent::CloseRequested { .. }) {
            return;
        }
        for (label, w) in handle.webview_windows() {
            if label.starts_with("pop-") {
                if let Some(view) = label.strip_prefix("pop-") {
                    remember(&handle, view, &label);
                }
                close_sessions(&handle, &label);
                let _ = w.close();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_views() {
        assert_eq!(title_of("terminal"), Some("Терминал + AI"));
        // веб-панели живут в главном окне, их выносить нельзя
        assert_eq!(title_of("web"), None);
        assert_eq!(title_of("settings"), None);
        assert_eq!(title_of("../../etc/passwd"), None);
        assert_eq!(title_of(""), None);
    }

    #[test]
    fn a_window_off_screen_opens_centered() {
        let screen = [(0.0, 0.0, 1920.0, 1080.0)];
        let ok = Spot { x: 100.0, y: 80.0, w: 1100.0, h: 720.0 };
        assert!(visible_on(&ok, &screen));
        // второй монитор отключили: сохранённое место осталось за пределами экрана
        assert!(!visible_on(&Spot { x: 2200.0, y: 100.0, w: 1100.0, h: 720.0 }, &screen));
        // наполовину за краем — всё ещё видно, за заголовок вытащить можно
        assert!(visible_on(&Spot { x: 1500.0, y: 900.0, w: 1100.0, h: 720.0 }, &screen));
        // выше верхней кромки: заголовка не видно
        assert!(!visible_on(&Spot { x: 100.0, y: -800.0, w: 1100.0, h: 720.0 }, &screen));
        // чепуха в файле не должна открывать окно размером в точку
        assert!(!visible_on(&Spot { x: 0.0, y: 0.0, w: 10.0, h: 10.0 }, &screen));
    }

    #[test]
    fn two_monitors() {
        let screens = [(0.0, 0.0, 1920.0, 1080.0), (1920.0, -200.0, 2560.0, 1440.0)];
        assert!(visible_on(&Spot { x: 2200.0, y: 100.0, w: 1100.0, h: 720.0 }, &screens));
    }
}
