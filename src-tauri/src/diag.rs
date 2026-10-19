//! Diagnostics: a log file (tauri-plugin-log, rotated), panics with backtraces, slow synchronous
//! commands (they run on the UI thread) and a watchdog that records UI freezes together with the
//! command that was running at that moment.

use crate::store::err;
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

const SLOW_COMMAND: Duration = Duration::from_millis(200);
const FREEZE: u64 = 2000; // ms

static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
static LAST_TICK: AtomicU64 = AtomicU64::new(0);
/// Synchronous command being executed right now (on the UI thread), for freeze reports.
static CURRENT: Mutex<Option<(String, Instant)>> = Mutex::new(None);
/// Последние запросы интерфейса: (команда, когда вернулась, сколько держала поток).
/// Зависания чаще всего случаются не внутри команды, а сразу после неё — в том, что она запустила
/// (буфер обмена, окно, нативная панель), и тогда сама команда в отчёте уже не видна.
static RECENT: Mutex<VecDeque<(String, u64, u64)>> = Mutex::new(VecDeque::new());
const RECENT_KEEP: usize = 8;

fn now_ms() -> u64 {
    START.get_or_init(Instant::now).elapsed().as_millis() as u64
}

/// Log plugin: file in the app log dir (rotated, 5 files × 5 MB) + stdout in dev.
pub fn log_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    use tauri_plugin_log::{RotationStrategy, Target, TargetKind};
    tauri_plugin_log::Builder::new()
        .clear_targets()
        .target(Target::new(TargetKind::LogDir { file_name: Some("opsdeck".into()) }))
        .target(Target::new(TargetKind::Stdout))
        .level(log::LevelFilter::Info)
        // chatty dependencies: keep their warnings only
        .level_for("tao", log::LevelFilter::Warn)
        .level_for("wry", log::LevelFilter::Warn)
        // kube_client logs every failed request at ERROR without context ("client error (Connect)"),
        // hundreds of lines while a cluster is unreachable; k8s.rs logs failures with the context itself
        .level_for("kube_client", log::LevelFilter::Off)
        .level_for("kube_runtime", log::LevelFilter::Warn)
        .level_for("hyper_util", log::LevelFilter::Warn)
        .level_for("reqwest", log::LevelFilter::Warn)
        // arboard пишет одно и то же предупреждение при каждой инициализации буфера обмена на
        // Wayland без ext-data-control: он молча переходит на X11, и делать с этим нечего
        .level_for("arboard", log::LevelFilter::Error)
        .max_file_size(5_000_000)
        .rotation_strategy(RotationStrategy::KeepSome(5))
        .build()
}

/// Panics go to the log with a backtrace (then the default hook still prints them).
pub fn install_panic_hook() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log::error!("PANIC: {info}\n{}", std::backtrace::Backtrace::force_capture());
        default(info);
    }));
}

/// Wraps the generated command handler: tracks the running sync command and logs slow ones.
pub fn track<F>(handler: F) -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static
where
    F: Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static,
{
    move |invoke| {
        let cmd = invoke.message.command().to_string();
        let started = Instant::now();
        *CURRENT.lock().unwrap() = Some((cmd.clone(), started));
        let handled = handler(invoke);
        CURRENT.lock().unwrap().take();
        // async commands return right away; a long time here means work on the UI thread
        let took = started.elapsed();
        if took > SLOW_COMMAND {
            log::warn!("slow command on UI thread: {cmd} took {} ms", took.as_millis());
        }
        {
            let mut recent = RECENT.lock().unwrap();
            if recent.len() == RECENT_KEEP {
                recent.pop_front();
            }
            recent.push_back((cmd, now_ms(), took.as_millis() as u64));
        }
        handled
    }
}

/// Что интерфейс просил перед зависанием, новое первым: «clip_read 0,4 с назад (2 мс)».
fn recent_commands(now: u64) -> String {
    let recent = RECENT.lock().unwrap();
    let list: Vec<String> = recent
        .iter()
        .rev()
        .take(5)
        .map(|(cmd, at, took)| format!("{cmd} {:.1} с назад ({took} мс)", now.saturating_sub(*at) as f64 / 1000.0))
        .collect();
    if list.is_empty() {
        "команд не было".into()
    } else {
        list.join(", ")
    }
}

/// Every 500 ms asks the UI thread to tick; if it doesn't for 2 s, logs a freeze once and
/// what was running, then logs when it recovers.
pub fn start_watchdog(app: AppHandle) {
    LAST_TICK.store(now_ms(), Ordering::Relaxed);
    std::thread::spawn(move || {
        let mut frozen_since: Option<u64> = None;
        loop {
            std::thread::sleep(Duration::from_millis(500));
            let _ = app.run_on_main_thread(|| LAST_TICK.store(now_ms(), Ordering::Relaxed));
            let lag = now_ms().saturating_sub(LAST_TICK.load(Ordering::Relaxed));
            match frozen_since {
                None if lag > FREEZE => {
                    let running = CURRENT
                        .lock()
                        .unwrap()
                        .as_ref()
                        .map(|(c, t)| format!("{c} (идёт {} мс)", t.elapsed().as_millis()))
                        .unwrap_or_else(|| "нет синхронной команды (JS/рендеринг или системный вызов GTK)".into());
                    log::error!(
                        "UI FREEZE: главный поток не отвечает {lag} мс; выполняется: {running}; до этого: {}",
                        recent_commands(now_ms())
                    );
                    frozen_since = Some(LAST_TICK.load(Ordering::Relaxed));
                }
                Some(since) if lag < 600 => {
                    log::warn!("UI recovered after ~{} ms", now_ms().saturating_sub(since));
                    frozen_since = None;
                }
                _ => {}
            }
        }
    });
}

// ---------- commands ----------

/// Errors from the web UI (uncaught exceptions, failed actions shown as red toasts).
#[tauri::command]
pub fn log_ui(level: String, message: String) {
    let msg: String = message.chars().take(4000).collect();
    match level.as_str() {
        "error" => log::error!(target: "ui", "{msg}"),
        "warn" => log::warn!(target: "ui", "{msg}"),
        _ => log::info!(target: "ui", "{msg}"),
    }
}

fn log_file(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app.path().app_log_dir().map_err(err)?.join("opsdeck.log"))
}

#[tauri::command]
pub fn logs_open(app: AppHandle) -> Result<(), String> {
    let dir = app.path().app_log_dir().map_err(err)?;
    std::fs::create_dir_all(&dir).map_err(err)?;
    crate::store::open_with_system(&dir.to_string_lossy())
}

/// Last lines of the current log (for the viewer in settings), newest last.
#[tauri::command]
pub async fn logs_tail(app: AppHandle, lines: Option<usize>, only_problems: Option<bool>) -> Result<String, String> {
    let path = log_file(&app)?;
    let n = lines.unwrap_or(200).min(5000);
    let only = only_problems.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        let picked: Vec<&str> = text
            .lines()
            .filter(|l| !only || l.contains("[ERROR]") || l.contains("[WARN]") || l.contains("PANIC") || l.contains("FREEZE"))
            .collect();
        Ok(picked[picked.len().saturating_sub(n)..].join("\n"))
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub fn logs_path(app: AppHandle) -> Result<String, String> {
    Ok(log_file(&app)?.to_string_lossy().into_owned())
}
