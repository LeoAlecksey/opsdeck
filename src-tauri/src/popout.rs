//! Раздел в отдельном окне: та же страница приложения, открытая на одном модуле.
//!
//! Окно получает метку `pop-<раздел>`; фронтенд читает её у себя и монтирует только этот модуль,
//! без боковой колонки. Запрошенный раздел сверяем со списком ниже: из метки получается имя окна,
//! а из него — права в capabilities, поэтому произвольную строку туда пускать нельзя.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tauri::Emitter;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder};

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
    ("agent", "ИИ-агент"),
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
    let monitors = monitor_areas(app);
    // мониторы не удалось получить — верим сохранённому месту
    (monitors.is_empty() || visible_on(&spot, &monitors)).then_some(spot)
}

/// Прямоугольник в логических точках: x, y, ширина, высота.
type Area = (f64, f64, f64, f64);

/// Мониторы в логических точках, основной — первым: на него уходят окна, которым больше некуда.
fn monitor_areas(app: &AppHandle) -> Vec<Area> {
    let primary = app.primary_monitor().ok().flatten().map(|m| *m.position());
    let mut list: Vec<(bool, Area)> = app
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let p = m.position().to_logical::<f64>(m.scale_factor());
            let s = m.size().to_logical::<f64>(m.scale_factor());
            (Some(*m.position()) == primary, (p.x, p.y, s.width, s.height))
        })
        .collect();
    list.sort_by_key(|(is_primary, _)| !is_primary);
    list.into_iter().map(|(_, a)| a).collect()
}

fn overlap(a: Area, b: Area) -> f64 {
    let w = (a.0 + a.2).min(b.0 + b.2) - a.0.max(b.0);
    let h = (a.1 + a.3).min(b.1 + b.3) - a.1.max(b.1);
    if w > 0.0 && h > 0.0 {
        w * h
    } else {
        0.0
    }
}

/// Куда переставить окно после смены мониторов. Отключили внешний экран — окно осталось в его
/// координатах (развернуть его из панели задач можно, но на экране его нет) или размером с него.
/// Тогда ставим его по центру монитора, где окна больше всего (иначе основного), и ужимаем до экрана.
/// `None` — окно на месте: заголовок виден и почти всё окно лежит на мониторах (растянутое на два
/// экрана — тоже на месте).
fn refit(win: Area, monitors: &[Area]) -> Option<Area> {
    if monitors.is_empty() || win.2 <= 0.0 || win.3 <= 0.0 {
        return None;
    }
    let area = win.2 * win.3;
    let title = (win.0, win.1, win.2, win.3.min(48.0));
    let title_seen = monitors.iter().any(|m| overlap(title, *m) > 0.0);
    let covered = monitors.iter().map(|m| overlap(win, *m)).sum::<f64>().min(area);
    if title_seen && covered >= 0.75 * area {
        return None;
    }
    let target = monitors
        .iter()
        .copied()
        .filter(|m| overlap(win, *m) > 0.0)
        .max_by(|a, b| overlap(win, *a).total_cmp(&overlap(win, *b)))
        .unwrap_or(monitors[0]);
    let (w, h) = (win.2.min(target.2), win.3.min(target.3));
    Some((target.0 + (target.2 - w) / 2.0, target.1 + (target.3 - h) / 2.0, w, h))
}

/// Вернуть окно на экран, если после смены мониторов оно оказалось за его пределами.
fn bring_on_screen(w: &tauri::WebviewWindow, monitors: &[Area]) {
    // свёрнутое окно отдаёт чужие координаты; поправим, когда его развернут и оно получит фокус
    if w.is_minimized().unwrap_or(true) {
        return;
    }
    let Ok(scale) = w.scale_factor() else { return };
    let (Ok(pos), Ok(outer), Ok(inner)) = (w.outer_position(), w.outer_size(), w.inner_size()) else { return };
    let (p, o, i) = (pos.to_logical::<f64>(scale), outer.to_logical::<f64>(scale), inner.to_logical::<f64>(scale));
    let Some((x, y, width, height)) = refit((p.x, p.y, o.width, o.height), monitors) else { return };
    log::info!("window {}: off screen after a monitor change, moved to {x:.0},{y:.0} {width:.0}x{height:.0}", w.label());
    let maximized = w.is_maximized().unwrap_or(false);
    if maximized {
        let _ = w.unmaximize();
    }
    // set_size задаёт внутренний размер, а уместить на экране нужно окно с рамкой
    let _ = w.set_size(LogicalSize::new((width - (o.width - i.width)).max(1.0), (height - (o.height - i.height)).max(1.0)));
    let _ = w.set_position(LogicalPosition::new(x, y));
    // развёрнутое окно разворачиваем заново — уже по размеру оставшегося экрана
    if maximized {
        let _ = w.maximize();
    }
}

/// Проверить окно не на UI-потоке: геттеры окна ходят в главный цикл, а он сейчас занят событием.
fn check_on_screen(app: &AppHandle, label: &str) {
    let (app, label) = (app.clone(), label.to_string());
    std::thread::spawn(move || {
        if let Some(w) = app.get_webview_window(&label) {
            bring_on_screen(&w, &monitor_areas(&app));
        }
    });
}

/// Мониторы подключают и отключают на ходу, а события об этом у Tauri нет: раз в две секунды
/// сверяем список и при изменении возвращаем окна на экран. Окно, свёрнутое в этот момент,
/// проверяется, когда получит фокус (см. `install` и `window_popout`).
fn watch_monitors(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let mut last = monitor_areas(&app);
        loop {
            std::thread::sleep(Duration::from_secs(2));
            let now = monitor_areas(&app);
            if now == last || now.is_empty() {
                continue;
            }
            log::info!("monitors changed: {} → {}", last.len(), now.len());
            last = now;
            for (label, w) in app.webview_windows() {
                if label == "main" || label.starts_with("pop-") {
                    bring_on_screen(&w, &last);
                }
            }
        }
    });
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
        .title(format!("{} — {}", crate::i18n::tr(title, &[]), crate::profile::app_title()))
        .inner_size(spot.map_or(1100.0, |s| s.w), spot.map_or(720.0, |s| s.h))
        .min_inner_size(MIN_W, MIN_H);
    builder = match spot {
        Some(s) => builder.position(s.x, s.y),
        None => builder.center(),
    };
    // та же страница, что у главного окна: ей нужны то же окружение и те же данные вебвью
    builder = crate::profile::isolate_window(builder).initialization_script(crate::profile::init_script());
    let window = builder.build().map_err(crate::store::err)?;
    let (handle, id, lbl) = (app.clone(), view.clone(), label.clone());
    window.on_window_event(move |e| match e {
        tauri::WindowEvent::CloseRequested { .. } => {
            remember(&handle, &id, &lbl);
            close_sessions(&handle, &lbl);
        }
        tauri::WindowEvent::Focused(true) => check_on_screen(&handle, &lbl),
        _ => {}
    });
    Ok(())
}

/// Терминалы закрытого окна: без этого его оболочки остались бы работать до выхода
/// из приложения — их вкладок уже нет, а процессы есть.
fn close_sessions(app: &AppHandle, label: &str) {
    crate::pty::kill_window(&app.state::<crate::pty::PtyState>(), label);
}

/// Вкладка терминала, которую одно окно отдаёт другому: кому и что. Лежит здесь, пока адресат не
/// заберёт. Через события такое не передать: окно может ещё не открыться, а сессия уже отдана.
static HANDOFF: Mutex<Option<(String, serde_json::Value)>> = Mutex::new(None);

#[tauri::command]
pub fn term_handoff_put(app: AppHandle, to: String, payload: serde_json::Value) -> Result<(), String> {
    *HANDOFF.lock().map_err(crate::store::err)? = Some((to.clone(), payload));
    // окно, которое уже открыто, заберёт сразу; только что созданное — когда смонтируется
    let _ = app.emit("term-handoff", to);
    Ok(())
}

#[tauri::command]
pub fn term_handoff_take(window: tauri::WebviewWindow) -> Option<serde_json::Value> {
    let mut held = HANDOFF.lock().ok()?;
    match held.as_ref() {
        Some((to, _)) if to == window.label() => held.take().map(|(_, payload)| payload),
        _ => None,
    }
}

/// Вынесенное окно просит показать раздел, которого в нём нет: поднимаем главное.
#[tauri::command]
pub fn window_focus_main(app: AppHandle) -> Result<(), String> {
    let w = app.get_webview_window("main").ok_or("нет главного окна")?;
    let _ = w.unminimize();
    w.set_focus().map_err(crate::store::err)
}

/// Главное окно закрыли — вынесенные окна закрываем вместе с ним: без боковой колонки
/// вернуться в приложение из них нельзя. Здесь же — слежение за мониторами.
pub fn install(app: &AppHandle) {
    let Some(main) = app.get_webview_window("main") else { return };
    watch_monitors(app);
    let handle = app.clone();
    main.on_window_event(move |e| {
        if matches!(e, tauri::WindowEvent::Focused(true)) {
            check_on_screen(&handle, "main");
        }
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

    #[test]
    fn a_window_left_on_an_unplugged_monitor_comes_back() {
        let laptop = [(0.0, 0.0, 1920.0, 1080.0)];
        // окно стояло на внешнем экране справа
        assert_eq!(refit((2300.0, 100.0, 1100.0, 720.0), &laptop), Some((410.0, 180.0, 1100.0, 720.0)));
        // развёрнутое на 2560×1440: заголовок виден, но окно больше экрана — ужимаем
        assert_eq!(refit((0.0, 0.0, 2560.0, 1440.0), &laptop), Some((0.0, 0.0, 1920.0, 1080.0)));
        // обычное окно на месте не трогаем, и развёрнутое с рамкой за краем (Windows) — тоже
        assert_eq!(refit((100.0, 80.0, 1100.0, 720.0), &laptop), None);
        assert_eq!(refit((-8.0, -8.0, 1936.0, 1096.0), &laptop), None);
        // мониторы не получены — ничего не делаем
        assert_eq!(refit((5000.0, 0.0, 800.0, 600.0), &[]), None);
    }

    #[test]
    fn a_window_across_two_monitors_stays() {
        let screens = [(0.0, 0.0, 1920.0, 1080.0), (1920.0, 0.0, 1920.0, 1080.0)];
        assert_eq!(refit((1000.0, 100.0, 2000.0, 800.0), &screens), None);
        // уехало наполовину за нижний край второго — возвращаем на него, а не на основной
        assert_eq!(refit((2000.0, 700.0, 1000.0, 800.0), &screens), Some((2380.0, 140.0, 1000.0, 800.0)));
    }
}
