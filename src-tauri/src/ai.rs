//! Local AI under the hood: llama.cpp's `llama-server` + a model chosen in Settings (Qwen2.5-Coder
//! 1.5B by default, bigger Qwen models or the user's own .gguf), downloaded on demand
//! from Settings (nothing is bundled into the installer) into the app's data folder, started in
//! the background on first use and stopped after a while without requests.
//! Used to turn a request in plain words into a shell command, with the user's notes as context.

use crate::{
    process,
    settings::{self, Settings},
    store,
    store::err,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};

/// Pinned llama.cpp build: a known-good one instead of whatever nightly is newest.
const ENGINE_TAG: &str = "b11351";

/// Models offered in Settings: Q4_K_M quantizations, sha256 pinned (from Hugging Face LFS metadata).
struct Model {
    id: &'static str,
    title: &'static str,
    file: &'static str,
    url: &'static str,
    sha256: &'static str,
    size: u64,
    /// recommended RAM, GB
    ram_gb: u32,
    /// parameters working per token, billions: what decides the speed on a CPU (an MoE model is
    /// big on disk but quick, a dense one is as slow as it is big)
    active_b: f32,
}

const MODELS: &[Model] = &[
    Model {
        id: "qwen2.5-coder-1.5b",
        title: "Лёгкая — Qwen2.5-Coder 1.5B",
        file: "qwen2.5-coder-1.5b-instruct-q4_k_m.gguf",
        url: "https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf",
        sha256: "cc324af070c2ecbfd324a30884d2f951a7ff756aba85cb811a6ec436933bb046",
        size: 1_117_320_768,
        ram_gb: 4,
        active_b: 1.5,
    },
    Model {
        id: "qwen3.5-4b",
        title: "Средняя — Qwen3.5 4B",
        file: "Qwen3.5-4B-Q4_K_M.gguf",
        url: "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf",
        sha256: "00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4",
        size: 2_740_937_888,
        ram_gb: 8,
        active_b: 4.0,
    },
    Model {
        id: "qwen3.5-9b",
        title: "Мощная — Qwen3.5 9B",
        file: "Qwen3.5-9B-Q4_K_M.gguf",
        url: "https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q4_K_M.gguf",
        sha256: "03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8",
        size: 5_680_522_464,
        ram_gb: 16,
        active_b: 9.0,
    },
    // Qwen3.8 27B (август 2026, Apache-2.0): плотная, архитектура qwen3_5 — та же, что у Qwen3.5,
    // поэтому закреплённый движок её запускает. Qwen3.8-Flash-Next (125B MoE, ≈100 ГБ в 4 битах,
    // несколько файлов, архитектура Qwen4) для настольного ПК не годится и в список не входит.
    Model {
        id: "qwen3.8-27b",
        title: "Сильная — Qwen3.8 27B",
        file: "Qwen3.8-27B-UD-Q4_K_M.gguf",
        url: "https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/resolve/main/Qwen3.8-27B-UD-Q4_K_M.gguf",
        sha256: "322e194ff79741c7baa497c240f677f54b201b0efab44ca8e50f122b39123482",
        size: 16_464_440_224,
        ram_gb: 24,
        active_b: 27.0,
    },
    Model {
        id: "qwen3.6-35b-a3b",
        title: "Большая — Qwen3.6 35B-A3B (MoE)",
        file: "Qwen3.6-35B-A3B-UD-Q4_K_M.gguf",
        url: "https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF/resolve/main/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf",
        sha256: "ac0e2c1189e055faa36eff361580e79c5bd6f8e76bffb4ce547f167d53e31a61",
        size: 22_134_528_992,
        ram_gb: 32,
        active_b: 3.0,
    },
];
const CUSTOM: &str = "custom";

// ----- потянет ли этот компьютер модель -----

const GIB: u64 = 1 << 30;

#[derive(Serialize, PartialEq, Debug, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum FitLevel {
    /// хватает памяти, скорость нормальная
    Good,
    /// запустится, но на процессоре будет медленно
    Slow,
    /// памяти меньше рекомендованного: запустится, но потеснит остальное
    Tight,
    /// не запустится или не скачается
    No,
}

#[derive(Serialize, PartialEq, Debug, Clone)]
pub struct Fit {
    pub level: FitLevel,
    /// почему, словами — пусто, если всё хорошо
    pub why: String,
}

/// Что ждёт модель на этом компьютере. Память — по факту (размер файла плюс контекст и система),
/// диск — если её ещё надо скачать, скорость — по числу активных параметров: на процессоре без
/// видеокарты плотная модель на десятки миллиардов отвечает по несколько слов в секунду.
pub fn fit(size: u64, ram_gb: u32, active_b: f32, ram_total: u64, disk_free: Option<u64>, accel: bool, installed: bool) -> Fit {
    let gb = |b: u64| format!("{:.0}", b as f64 / GIB as f64);
    if !installed {
        if let Some(free) = disk_free {
            let need = size + GIB;
            if free < need {
                return Fit { level: FitLevel::No, why: format!("на диске свободно {} ГБ, а нужно около {} ГБ", gb(free), gb(need)) };
            }
        }
    }
    // файл модели целиком в памяти + контекст и сама система
    let min = size + 5 * GIB / 2;
    if ram_total < min {
        return Fit { level: FitLevel::No, why: format!("модели нужно не меньше {} ГБ памяти, а в компьютере {} ГБ", gb(min), gb(ram_total)) };
    }
    // ОС показывает чуть меньше памяти, чем стоит в компьютере: небольшой запас
    if (ram_total as f64) < ram_gb as f64 * GIB as f64 * 0.9 {
        return Fit { level: FitLevel::Tight, why: format!("памяти впритык: {} ГБ при рекомендованных {} ГБ — остальные программы будут потеснены, ответы медленнее", gb(ram_total), ram_gb) };
    }
    if !accel && active_b >= 14.0 {
        return Fit { level: FitLevel::Slow, why: "на процессоре такая модель отвечает медленно — несколько слов в секунду; с ускорением на видеокарте в разы быстрее".into() };
    }
    Fit { level: FitLevel::Good, why: String::new() }
}

/// Свободное место там, куда скачиваются модели.
fn disk_free(dir: &Path) -> Option<u64> {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    disks.list().iter().filter(|d| dir.starts_with(d.mount_point())).max_by_key(|d| d.mount_point().as_os_str().len()).map(|d| d.available_space())
}
/// The user's choice, in ~/.config/opsdeck.
const CHOICE_FILE: &str = "ai.json";
/// Engine archive, roughly (shown in the download size).
const ENGINE_SIZE: u64 = 40 * 1024 * 1024;
/// Stop the server after this long without requests (frees the model's RAM).
const IDLE_STOP: Duration = Duration::from_secs(15 * 60);

fn ai_dir() -> Result<PathBuf, String> {
    let d = dirs::data_local_dir().ok_or("no data dir")?.join("opsdeck").join("ai");
    fs::create_dir_all(&d).map_err(err)?;
    Ok(d)
}

/// The engine archive for this OS/CPU: the CPU build, or the Vulkan one (any NVIDIA/AMD/Intel GPU)
/// when GPU acceleration is on. macOS builds always include Metal.
fn engine_asset() -> Result<&'static str, String> {
    if use_gpu() {
        if let Some(a) = vulkan_asset() {
            return Ok(a);
        }
    }
    Ok(match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => "bin-ubuntu-x64.tar.gz",
        ("linux", "aarch64") => "bin-ubuntu-arm64.tar.gz",
        ("macos", "aarch64") => "bin-macos-arm64.tar.gz",
        ("macos", "x86_64") => "bin-macos-x64.tar.gz",
        ("windows", "x86_64") => "bin-win-cpu-x64.zip",
        ("windows", "aarch64") => "bin-win-cpu-arm64.zip",
        (os, arch) => return Err(format!("локальный ИИ пока не поддерживается на {os}/{arch}")),
    })
}

fn vulkan_asset() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Some("bin-ubuntu-vulkan-x64.tar.gz"),
        ("linux", "aarch64") => Some("bin-ubuntu-vulkan-arm64.tar.gz"),
        ("windows", "x86_64") => Some("bin-win-vulkan-x64.zip"),
        _ => None,
    }
}

/// The Vulkan loader the GPU build links against (installed with the video driver).
fn vulkan_found() -> bool {
    #[cfg(windows)]
    {
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        return Path::new(&root).join("System32").join("vulkan-1.dll").exists();
    }
    #[cfg(not(windows))]
    ["/usr/lib/x86_64-linux-gnu", "/usr/lib/aarch64-linux-gnu", "/usr/lib64", "/usr/lib", "/lib/x86_64-linux-gnu", "/lib64"]
        .iter()
        .any(|d| Path::new(d).join("libvulkan.so.1").exists())
}

/// GPU acceleration chosen in Settings and possible here (macOS: Metal, always on).
fn use_gpu() -> bool {
    choice().gpu && vulkan_asset().is_some()
}

fn server_name() -> &'static str {
    if cfg!(windows) { "llama-server.exe" } else { "llama-server" }
}

/// llama-server somewhere inside the unpacked engine folder.
fn find_server(dir: &Path) -> Option<PathBuf> {
    let rd = fs::read_dir(dir).ok()?;
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            if let Some(f) = find_server(&p) {
                return Some(f);
            }
        } else if p.file_name().is_some_and(|n| n == server_name()) {
            return Some(p);
        }
    }
    None
}

/// CPU and Vulkan engines live side by side, switching does not re-download.
fn engine_dir() -> Result<PathBuf, String> {
    Ok(ai_dir()?.join(format!("llama-{ENGINE_TAG}{}", if use_gpu() { "-vulkan" } else { "" })))
}
fn cpu_engine_dir() -> Result<PathBuf, String> {
    Ok(ai_dir()?.join(format!("llama-{ENGINE_TAG}")))
}

#[derive(Serialize, Deserialize, Default)]
struct Choice {
    model: String,
    custom_path: String,
    /// run on the GPU (Vulkan build of the engine)
    #[serde(default)]
    gpu: bool,
}

enum Selected {
    Preset(&'static Model),
    Custom(PathBuf),
}

fn choice() -> Choice {
    store::load_json(CHOICE_FILE).unwrap_or_default()
}

fn selected() -> Selected {
    let c = choice();
    if c.model == CUSTOM && !c.custom_path.is_empty() {
        return Selected::Custom(PathBuf::from(c.custom_path));
    }
    Selected::Preset(MODELS.iter().find(|m| m.id == c.model).unwrap_or(&MODELS[0]))
}

fn preset_path(m: &Model) -> Result<PathBuf, String> {
    Ok(ai_dir()?.join(m.file))
}

fn preset_ready(m: &Model) -> bool {
    preset_path(m).ok().and_then(|p| p.metadata().ok()).is_some_and(|md| md.len() == m.size)
}

/// The model file to run, if it is there.
fn model_path() -> Result<PathBuf, String> {
    match selected() {
        Selected::Preset(m) => preset_path(m),
        Selected::Custom(p) => Ok(p),
    }
}

fn model_ready() -> bool {
    match selected() {
        Selected::Preset(m) => preset_ready(m),
        Selected::Custom(p) => p.is_file(),
    }
}

fn stop_server(state: &AiState) {
    if let Some(mut s) = state.server.lock().unwrap().take() {
        let _ = s.child.kill();
        let _ = s.child.wait();
    }
}

struct Server {
    child: Child,
    port: u16,
    last_used: Instant,
}

#[derive(Default)]
pub struct AiState {
    server: Mutex<Option<Server>>,
    /// a download in progress (cancel flag)
    installing: Mutex<Option<std::sync::Arc<std::sync::atomic::AtomicBool>>>,
    /// the GPU did not start this session: run on the CPU (reset when acceleration is switched)
    gpu_failed: std::sync::atomic::AtomicBool,
}

impl Drop for AiState {
    fn drop(&mut self) {
        if let Some(mut s) = self.server.lock().unwrap().take() {
            let _ = s.child.kill();
        }
    }
}

#[derive(Serialize)]
pub struct AiStatus {
    engine: bool,
    model: bool,
    running: bool,
    installing: bool,
    /// bytes on disk
    size: u64,
    download_size: u64,
    dir: String,
    supported: bool,
    /// the selected model, for the UI
    model_title: String,
}

fn dir_size(p: &Path) -> u64 {
    match fs::metadata(p) {
        Ok(m) if m.is_dir() => fs::read_dir(p).map(|rd| rd.flatten().map(|e| dir_size(&e.path())).sum()).unwrap_or(0),
        Ok(m) => m.len(),
        Err(_) => 0,
    }
}

#[tauri::command]
pub fn ai_status(state: tauri::State<AiState>) -> Result<AiStatus, String> {
    let dir = ai_dir()?;
    let engine = engine_dir().ok().and_then(|d| find_server(&d)).is_some();
    let model = model_ready();
    let (model_title, model_size) = match selected() {
        Selected::Preset(m) => (m.title.to_string(), if model { 0 } else { m.size }),
        Selected::Custom(p) => (format!("свой файл: {}", p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()), 0),
    };
    Ok(AiStatus {
        engine,
        model,
        running: state.server.lock().unwrap().is_some(),
        installing: state.installing.lock().unwrap().is_some(),
        size: dir_size(&dir),
        download_size: model_size + if engine { 0 } else { ENGINE_SIZE },
        dir: dir.to_string_lossy().into_owned(),
        supported: engine_asset().is_ok(),
        model_title,
    })
}

#[derive(Serialize)]
pub struct AiModelInfo {
    id: &'static str,
    title: &'static str,
    size: u64,
    ram_gb: u32,
    installed: bool,
    fit: Fit,
}

#[derive(Serialize)]
pub struct AiModels {
    models: Vec<AiModelInfo>,
    selected: String,
    custom_path: String,
    /// this machine's RAM, bytes (for the "fits your PC" hint)
    ram_total: u64,
    gpu: bool,
    /// Vulkan build exists for this OS/CPU
    gpu_supported: bool,
    /// the Vulkan loader is installed (video driver)
    vulkan_found: bool,
    /// macOS: Metal is used anyway
    metal: bool,
    /// the GPU did not start this session, the model runs on the CPU
    gpu_failed: bool,
}

#[tauri::command]
pub fn ai_models(state: tauri::State<AiState>) -> AiModels {
    let c = choice();
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    let ram = sys.total_memory();
    let free = ai_dir().ok().and_then(|d| disk_free(&d));
    let gpu_failed = state.gpu_failed.load(std::sync::atomic::Ordering::Relaxed);
    // видеокарта работает: на ней и плотная модель отвечает быстро
    let accel = cfg!(target_os = "macos") || (c.gpu && vulkan_found() && !gpu_failed);
    AiModels {
        models: MODELS
            .iter()
            .map(|m| {
                let installed = preset_ready(m);
                AiModelInfo { id: m.id, title: m.title, size: m.size, ram_gb: m.ram_gb, installed, fit: fit(m.size, m.ram_gb, m.active_b, ram, free, accel, installed) }
            })
            .collect(),
        selected: match selected() {
            Selected::Preset(m) => m.id.to_string(),
            Selected::Custom(_) => CUSTOM.to_string(),
        },
        custom_path: c.custom_path,
        ram_total: ram,
        gpu: c.gpu,
        gpu_supported: vulkan_asset().is_some(),
        vulkan_found: vulkan_found(),
        metal: cfg!(target_os = "macos"),
        gpu_failed,
    }
}

/// GPU acceleration on/off. The engine for the new mode is downloaded by "Установить".
#[tauri::command]
pub fn ai_set_gpu(state: tauri::State<AiState>, on: bool) -> Result<(), String> {
    if on && vulkan_asset().is_none() {
        return Err("для этой системы сборки движка под видеокарту нет".into());
    }
    let mut c = choice();
    c.gpu = on;
    store::save_json(CHOICE_FILE, &c)?;
    state.gpu_failed.store(false, std::sync::atomic::Ordering::Relaxed);
    stop_server(&state);
    Ok(())
}

/// Pick a model (`custom` + a path to a .gguf file). The running server is stopped, so the
/// next request starts with the new model.
#[tauri::command]
pub fn ai_select(state: tauri::State<AiState>, model: String, custom_path: Option<String>) -> Result<(), String> {
    let mut c = choice();
    if model == CUSTOM {
        let p = PathBuf::from(custom_path.unwrap_or_default().trim());
        if !p.is_file() || p.extension().is_none_or(|e| !e.eq_ignore_ascii_case("gguf")) {
            return Err("нужен существующий файл модели .gguf".into());
        }
        c.custom_path = p.to_string_lossy().into_owned();
    } else if !MODELS.iter().any(|m| m.id == model) {
        return Err(format!("нет такой модели: {model}"));
    }
    c.model = model;
    store::save_json(CHOICE_FILE, &c)?;
    stop_server(&state);
    Ok(())
}

/// Native "choose a .gguf file" dialog; None when cancelled.
#[tauri::command]
pub async fn ai_pick_model(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("Файл модели .gguf")
            .add_filter("GGUF", &["gguf"])
            .blocking_pick_file()
            .and_then(|f| f.into_path().ok())
            .map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .ok()
    .flatten()
}

/// Delete one downloaded model (the engine and other models stay).
#[tauri::command]
pub fn ai_remove_model(state: tauri::State<AiState>, id: String) -> Result<(), String> {
    let m = MODELS.iter().find(|m| m.id == id).ok_or("нет такой модели")?;
    stop_server(&state);
    let p = preset_path(m)?;
    if p.exists() {
        fs::remove_file(&p).map_err(err)?;
    }
    Ok(())
}

fn progress(app: &AppHandle, stage: &str, done: u64, total: u64) {
    let _ = app.emit("ai-progress", serde_json::json!({ "stage": stage, "done": done, "total": total }));
}

/// Проверка контрольной суммы уже скачанного файла: прогресс тот же, но интерфейс пишет «проверка».
fn progress_check(app: &AppHandle, stage: &str, done: u64, total: u64) {
    let _ = app.emit("ai-progress", serde_json::json!({ "stage": stage, "done": done, "total": total, "check": true }));
}

/// Сколько соединений открывать и с какого размера файла это вообще имеет смысл.
const DL_PARTS: u64 = 4;
const DL_MIN_SPLIT: u64 = 64 * 1024 * 1024;

/// Что уже лежит в .part: по каждой части — сколько байт дошло до диска. Обрыв загрузки (сеть,
/// выход из приложения) больше не стоит всей модели: при следующем запуске части продолжаются
/// с того места, где остановились.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
struct DlState {
    url: String,
    total: u64,
    /// по части: начало, конец (включительно) и сколько от начала уже записано
    parts: Vec<(u64, u64, u64)>,
}

fn state_path(part: &Path) -> PathBuf {
    part.with_extension("part.state")
}

/// Сохранённое состояние, если оно про этот же файл и совпадает по размеру.
fn load_state(part: &Path, url: &str, total: u64) -> Option<DlState> {
    let st: DlState = serde_json::from_str(&fs::read_to_string(state_path(part)).ok()?).ok()?;
    let same_file = st.url == url && st.total == total && fs::metadata(part).ok()?.len() == total;
    // диапазоны должны быть те же: иначе это состояние от другого числа соединений
    let sane = st.parts.iter().all(|(a, b, d)| b >= a && *d <= b - a + 1);
    (same_file && sane && !st.parts.is_empty()).then_some(st)
}

fn save_state(part: &Path, st: &DlState) {
    if let Ok(text) = serde_json::to_string(st) {
        let _ = fs::write(state_path(part), text);
    }
}

fn drop_state(part: &Path) {
    let _ = fs::remove_file(state_path(part));
}

/// Границы диапазонов (включительно) для `Range: bytes=a-b`. Последняя часть забирает остаток.
fn ranges(total: u64, parts: u64) -> Vec<(u64, u64)> {
    if total == 0 || parts <= 1 {
        return vec![(0, total.saturating_sub(1))];
    }
    // частей не больше, чем байт: иначе шаг нулевой и диапазоны вывернутся
    let parts = parts.min(total);
    let step = total / parts;
    (0..parts)
        .map(|i| (i * step, if i + 1 == parts { total - 1 } else { (i + 1) * step - 1 }))
        .collect()
}

/// Сервер отдаёт куски по Range? Ответ на пробный запрос «первый байт» — 206 и размер целого файла.
fn range_total(status: u16, content_range: Option<&str>) -> Option<u64> {
    if status != 206 {
        return None;
    }
    // «bytes 0-0/5680522464»
    content_range?.rsplit('/').next()?.trim().parse().ok().filter(|n| *n > 0)
}

/// sha256 уже записанного файла: считать на ходу нельзя, части приходят вразнобой.
fn sha_of(path: &Path, cancel: &std::sync::atomic::AtomicBool, on_progress: &dyn Fn(u64)) -> Result<String, String> {
    use std::io::Read;
    let mut f = fs::File::open(path).map_err(err)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 4 * 1024 * 1024];
    let mut done = 0u64;
    let mut last = Instant::now();
    loop {
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            return Err("установка отменена".into());
        }
        let n = f.read(&mut buf).map_err(err)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        done += n as u64;
        if last.elapsed() > Duration::from_millis(250) {
            on_progress(done);
            last = Instant::now();
        }
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Файл в несколько соединений: каждая часть пишется на своё место в одном файле (позиционная
/// запись), прогресс — сумма по частям. Нужен сервер, умеющий Range; иначе остаётся обычный поток.
async fn download_parts(
    client: &reqwest::Client,
    url: &str,
    part: &Path,
    total: u64,
    parts: u64,
    cancel: &std::sync::atomic::AtomicBool,
    on_progress: &(dyn Fn(u64) + Send + Sync),
) -> Result<(), String> {
    // продолжаем прежний .part, если он про этот же файл; иначе начинаем заново
    let resumed = load_state(part, url, total).filter(|st| st.parts.len() as u64 == parts.min(total.max(1)));
    if resumed.is_none() {
        let f = fs::File::create(part).map_err(err)?;
        f.set_len(total).map_err(err)?;
        drop(f);
        drop_state(part);
    }
    let plan: Vec<(u64, u64, u64)> = resumed
        .map(|st| st.parts)
        .filter(|p| p.len() as u64 == parts.min(total.max(1)))
        .unwrap_or_else(|| ranges(total, parts).into_iter().map(|(a, b)| (a, b, 0)).collect());
    let already: u64 = plan.iter().map(|(.., d)| *d).sum();

    // по части: сколько записано (для интерфейса) и сколько из этого доведено до диска (для докачки)
    let live: Vec<_> = plan.iter().map(|(.., d)| std::sync::Arc::new(std::sync::atomic::AtomicU64::new(*d))).collect();
    let safe: Vec<_> = live.iter().map(|d| std::sync::Arc::new(std::sync::atomic::AtomicU64::new(d.load(std::sync::atomic::Ordering::Relaxed)))).collect();
    let sum = |xs: &[std::sync::Arc<std::sync::atomic::AtomicU64>]| xs.iter().map(|x| x.load(std::sync::atomic::Ordering::Relaxed)).sum::<u64>();
    let snapshot = |xs: &[std::sync::Arc<std::sync::atomic::AtomicU64>]| DlState {
        url: url.to_string(),
        total,
        parts: plan.iter().zip(xs).map(|((a, b, _), d)| (*a, *b, d.load(std::sync::atomic::Ordering::Relaxed))).collect(),
    };

    let mut set = tokio::task::JoinSet::new();
    for (i, &(from, to, done_before)) in plan.iter().enumerate() {
        if from + done_before > to {
            continue; // эта часть уже целиком скачана в прошлый раз
        }
        let (client, url, path) = (client.clone(), url.to_string(), part.to_path_buf());
        let (live, safe) = (live[i].clone(), safe[i].clone());
        set.spawn(async move {
            let start = from + done_before;
            let mut resp = client.get(&url).header(reqwest::header::RANGE, format!("bytes={start}-{to}")).send().await.map_err(|e| format!("загрузка {url}: {e}"))?;
            if !resp.status().is_success() {
                return Err(format!("загрузка {url}: {}", resp.status()));
            }
            let mut f = fs::OpenOptions::new().write(true).open(&path).map_err(err)?;
            let mut at = start;
            let mut unsynced = 0u64;
            // в состояние для докачки попадает только то, что уже на диске: иначе после жёсткого
            // обрыва мы считали бы скачанным хвост, оставшийся в кэше
            let publish = |f: &mut fs::File, at: u64| {
                let _ = f.sync_data();
                safe.store(at - from, std::sync::atomic::Ordering::Relaxed);
            };
            loop {
                let chunk = match resp.chunk().await {
                    Ok(Some(c)) => c,
                    Ok(None) => break,
                    // обрыв: то, что успели записать, остаётся для следующей попытки
                    Err(e) => {
                        publish(&mut f, at);
                        return Err(format!("загрузка прервалась: {e}"));
                    }
                };
                write_at(&mut f, at, &chunk)?;
                at += chunk.len() as u64;
                unsynced += chunk.len() as u64;
                live.store(at - from, std::sync::atomic::Ordering::Relaxed);
                if unsynced >= 2 * 1024 * 1024 {
                    publish(&mut f, at);
                    unsynced = 0;
                }
            }
            publish(&mut f, at);
            if at <= to {
                return Err(format!("соединение закрылось на {at} из {}", to + 1));
            }
            Ok(())
        });
    }
    // прогресс, состояние для докачки и отмена, пока части качаются
    let mut saved = Instant::now();
    loop {
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            set.shutdown().await;
            save_state(part, &snapshot(&safe));
            return Err("установка отменена".into());
        }
        let step = tokio::time::timeout(Duration::from_millis(250), set.join_next()).await;
        let all_done = matches!(step, Ok(None));
        if let Ok(Some(res)) = step {
            let failed = match res {
                Err(e) => Some(format!("загрузка прервалась: {e}")),
                Ok(Err(e)) => Some(e),
                Ok(Ok(())) => None,
            };
            if let Some(e) = failed {
                set.shutdown().await;
                // то, что скачано, остаётся: следующая попытка продолжит с этого места
                save_state(part, &snapshot(&safe));
                return Err(e);
            }
        }
        on_progress(already.min(total).max(sum(&live)));
        if saved.elapsed() > Duration::from_secs(2) {
            save_state(part, &snapshot(&safe));
            saved = Instant::now();
        }
        if all_done {
            break;
        }
    }
    let got = sum(&live);
    if got != total {
        save_state(part, &snapshot(&safe));
        return Err(format!("скачано {got} из {total} байт — соединение оборвалось"));
    }
    drop_state(part);
    on_progress(total);
    Ok(())
}

/// Запись по смещению: на Unix write_at, на Windows seek_write (оба из std).
fn write_at(f: &mut fs::File, at: u64, buf: &[u8]) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileExt;
        let mut off = at;
        let mut rest = buf;
        while !rest.is_empty() {
            let n = f.write_at(rest, off).map_err(err)?;
            if n == 0 {
                return Err("запись в файл не удалась".into());
            }
            off += n as u64;
            rest = &rest[n..];
        }
        Ok(())
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileExt;
        let mut off = at;
        let mut rest = buf;
        while !rest.is_empty() {
            let n = f.seek_write(rest, off).map_err(err)?;
            if n == 0 {
                return Err("запись в файл не удалась".into());
            }
            off += n as u64;
            rest = &rest[n..];
        }
        Ok(())
    }
    #[cfg(not(any(unix, windows)))]
    {
        use std::io::{Seek, SeekFrom, Write};
        f.seek(SeekFrom::Start(at)).map_err(err)?;
        f.write_all(buf).map_err(err)
    }
}

/// Stream `url` to `dest` (via a .part file), checking sha256 when given. Cancellable.
/// Крупный файл с сервера, понимающего Range, качается в несколько соединений: у CDN на одно
/// соединение часто стоит ограничение, и модель на несколько гигабайт ползла часами.
async fn download(app: &AppHandle, url: &str, dest: &Path, sha256: Option<&str>, stage: &str, cancel: &std::sync::atomic::AtomicBool) -> Result<(), String> {
    let client = reqwest::Client::builder().user_agent(concat!("OpsDeck/", env!("CARGO_PKG_VERSION"))).connect_timeout(Duration::from_secs(20)).build().map_err(err)?;
    // пробный запрос одного байта: сразу видно и размер, и умеет ли сервер отдавать куски
    let probe = client.get(url).header(reqwest::header::RANGE, "bytes=0-0").send().await.map_err(|e| format!("загрузка {url}: {e}"))?;
    let whole = range_total(probe.status().as_u16(), probe.headers().get(reqwest::header::CONTENT_RANGE).and_then(|v| v.to_str().ok()));
    drop(probe);
    // Сервер умеет Range — идём этим путём всегда: крупный файл в несколько соединений, мелкий в
    // одно, и в обоих случаях обрыв можно докачать (состояние лежит рядом с .part).
    if let Some(total) = whole {
        let part = dest.with_extension("part");
        let parts = if total >= DL_MIN_SPLIT { DL_PARTS } else { 1 };
        download_parts(&client, url, &part, total, parts, cancel, &|done| progress(app, stage, done, total)).await?;
        if let Some(expected) = sha256 {
            let got = sha_of(&part, cancel, &|done| progress_check(app, stage, done, total))?;
            if !got.eq_ignore_ascii_case(expected) {
                let _ = fs::remove_file(&part);
                return Err(format!("контрольная сумма не совпала ({stage}) — файл повреждён или подменён, установка остановлена"));
            }
        }
        return fs::rename(&part, dest).map_err(err);
    }
    let mut resp = client.get(url).send().await.map_err(|e| format!("загрузка {url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("загрузка {url}: {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let part = dest.with_extension("part");
    let mut f = fs::File::create(&part).map_err(err)?;
    let mut hasher = Sha256::new();
    let mut done = 0u64;
    let mut last = Instant::now();
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("загрузка прервалась: {e}"))? {
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            drop(f);
            let _ = fs::remove_file(&part);
            return Err("установка отменена".into());
        }
        f.write_all(&chunk).map_err(err)?;
        hasher.update(&chunk);
        done += chunk.len() as u64;
        if last.elapsed() > Duration::from_millis(250) {
            progress(app, stage, done, total);
            last = Instant::now();
        }
    }
    f.flush().map_err(err)?;
    drop(f);
    progress(app, stage, done, total);
    if let Some(expected) = sha256 {
        let got = format!("{:x}", hasher.finalize());
        if !got.eq_ignore_ascii_case(expected) {
            let _ = fs::remove_file(&part);
            return Err(format!("контрольная сумма не совпала ({stage}) — файл повреждён или подменён, установка остановлена"));
        }
    }
    fs::rename(&part, dest).map_err(err)
}

fn unpack(archive: &Path, into: &Path) -> Result<(), String> {
    let _ = fs::remove_dir_all(into);
    fs::create_dir_all(into).map_err(err)?;
    let name = archive.to_string_lossy();
    if name.ends_with(".zip") {
        let mut z = zip::ZipArchive::new(fs::File::open(archive).map_err(err)?).map_err(err)?;
        z.extract(into).map_err(err)?;
    } else {
        let gz = flate2::read::GzDecoder::new(fs::File::open(archive).map_err(err)?);
        let mut t = tar::Archive::new(gz);
        t.set_preserve_permissions(true);
        t.unpack(into).map_err(err)?;
    }
    #[cfg(unix)]
    if let Some(bin) = find_server(into) {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&bin, fs::Permissions::from_mode(0o755));
    }
    Ok(())
}

/// Downloads the engine and the model in the background; progress: `ai-progress`, end: `ai-installed`.
#[tauri::command]
pub fn ai_install(app: AppHandle, state: tauri::State<AiState>) -> Result<(), String> {
    let asset_suffix = engine_asset()?;
    // место проверяем до начала: модель на 17 ГБ, оборвавшаяся на 15-м, — потерянные полчаса
    if let Selected::Preset(m) = selected() {
        if !preset_ready(m) {
            if let Some(free) = ai_dir().ok().and_then(|d| disk_free(&d)) {
                let f = fit(m.size, m.ram_gb, m.active_b, u64::MAX, Some(free), true, false);
                if f.level == FitLevel::No {
                    return Err(format!("не хватит места: {}", f.why));
                }
            }
        }
    }
    let cancel = {
        let mut g = state.installing.lock().unwrap();
        if g.is_some() {
            return Err("установка уже идёт".into());
        }
        let c = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        *g = Some(c.clone());
        c
    };
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let res: Result<(), String> = async {
            let dir = ai_dir()?;
            // 1. engine (small) — its sha256 comes from the GitHub release metadata
            if engine_dir().ok().and_then(|d| find_server(&d)).is_none() {
                let name = format!("llama-{ENGINE_TAG}-{asset_suffix}");
                let meta: serde_json::Value = reqwest::Client::builder()
                    .user_agent("OpsDeck")
                    .build()
                    .map_err(err)?
                    .get(format!("https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/{ENGINE_TAG}"))
                    .send()
                    .await
                    .map_err(err)?
                    .json()
                    .await
                    .map_err(err)?;
                let asset = meta["assets"].as_array().into_iter().flatten().find(|a| a["name"] == name).ok_or(format!("в релизе llama.cpp {ENGINE_TAG} нет {name}"))?;
                let url = asset["browser_download_url"].as_str().ok_or("нет ссылки на движок")?;
                let digest = asset["digest"].as_str().and_then(|d| d.strip_prefix("sha256:")).map(str::to_string);
                let archive = dir.join(&name);
                download(&app2, url, &archive, digest.as_deref(), "engine", &cancel).await?;
                let into = engine_dir()?;
                let a = archive.clone();
                tauri::async_runtime::spawn_blocking(move || unpack(&a, &into)).await.map_err(err)??;
                let _ = fs::remove_file(&archive);
                if engine_dir().ok().and_then(|d| find_server(&d)).is_none() {
                    return Err("в архиве движка не найден llama-server".into());
                }
            }
            // 2. the selected model, pinned sha256 (an own .gguf file needs no download)
            if let Selected::Preset(m) = selected() {
                if !preset_ready(m) {
                    download(&app2, m.url, &preset_path(m)?, Some(m.sha256), "model", &cancel).await?;
                }
            }
            Ok(())
        }
        .await;
        app2.state::<AiState>().installing.lock().unwrap().take();
        match res {
            Ok(()) => {
                log::info!("ai: engine {ENGINE_TAG}{} and model installed", if use_gpu() { " (vulkan)" } else { "" });
                let _ = app2.emit("ai-installed", serde_json::json!({ "ok": true }));
            }
            Err(e) => {
                log::warn!("ai install: {e}");
                let _ = app2.emit("ai-installed", serde_json::json!({ "ok": false, "error": e }));
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub fn ai_cancel(state: tauri::State<AiState>) {
    if let Some(c) = state.installing.lock().unwrap().as_ref() {
        c.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

/// Remove the engine and all downloaded models.
#[tauri::command]
pub fn ai_remove(state: tauri::State<AiState>) -> Result<(), String> {
    stop_server(&state);
    let dir = ai_dir()?;
    fs::remove_dir_all(&dir).map_err(err)
}

fn free_port() -> Result<u16, String> {
    let l = std::net::TcpListener::bind("127.0.0.1:0").map_err(err)?;
    Ok(l.local_addr().map_err(err)?.port())
}

/// The running server's port; starts it (and waits until the model is loaded) if needed.
/// The built-in engine was just used: it is unloaded only after IDLE_STOP without use.
pub(crate) fn touch(app: &AppHandle) {
    if let Some(s) = app.state::<AiState>().server.lock().unwrap().as_mut() {
        s.last_used = Instant::now();
    }
}

pub(crate) async fn ensure_server(app: &AppHandle) -> Result<u16, String> {
    let state = app.state::<AiState>();
    {
        let mut g = state.server.lock().unwrap();
        if let Some(s) = g.as_mut() {
            if s.child.try_wait().ok().flatten().is_none() {
                s.last_used = Instant::now();
                return Ok(s.port);
            }
            *g = None; // it died: start again
        }
    }
    let model = model_path()?;
    if !model_ready() {
        return Err("модель не скачана — ⚙ Настройки → Локальный ИИ".into());
    }
    let gpu = use_gpu() && !state.gpu_failed.load(std::sync::atomic::Ordering::Relaxed);
    let bin = engine_dir().ok().and_then(|d| find_server(&d)).ok_or("локальный ИИ не установлен — ⚙ Настройки → Локальный ИИ")?;
    if !gpu {
        return launch(app, &bin, &model, Device::Default).await;
    }
    match launch(app, &bin, &model, Device::Gpu).await {
        Ok(port) => Ok(port),
        Err(e) => {
            // the GPU did not work out (no driver, no device, too little video memory):
            // run on the CPU instead, until acceleration is switched again in Settings
            log::warn!("ai: GPU start failed ({e}), falling back to CPU");
            state.gpu_failed.store(true, std::sync::atomic::Ordering::Relaxed);
            let cpu_bin = cpu_engine_dir().ok().and_then(|d| find_server(&d)).unwrap_or(bin);
            let port = launch(app, &cpu_bin, &model, Device::Cpu).await.map_err(|e| {
                format!("видеокарта недоступна, а на процессоре модель тоже не запустилась ({e}) — выберите «Процессор» в ⚙ → Локальный ИИ и нажмите «Установить»")
            })?;
            let _ = app.emit("ai-fallback", ());
            Ok(port)
        }
    }
}

#[derive(Clone, Copy)]
enum Device {
    /// CPU, or Metal on macOS
    Default,
    Gpu,
    /// CPU only, even with a GPU build of the engine
    Cpu,
}

/// Start llama-server and wait until the model is loaded.
async fn launch(app: &AppHandle, bin: &Path, model: &Path, device: Device) -> Result<u16, String> {
    let state = app.state::<AiState>();
    // big models take a while to read from disk: ~15 s per GB on top of the base 90 s
    let load_limit = Duration::from_secs(90 + model.metadata().map(|m| m.len() / 1_073_741_824 * 15).unwrap_or(0));
    let port = free_port()?;
    let threads = std::thread::available_parallelism().map(|n| n.get().clamp(2, 8)).unwrap_or(4);
    let mut cmd = Command::new(bin);
    cmd.arg("-m")
        .arg(model)
        .args(["--host", "127.0.0.1", "--port", &port.to_string(), "-c", "4096", "-t", &threads.to_string()])
        .args(["--reasoning-budget", "0"])
        .current_dir(bin.parent().unwrap_or(Path::new(".")))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    match device {
        // as many layers as fit in video memory (llama.cpp's --fit is on by default)
        Device::Gpu => cmd.args(["-ngl", "auto"]),
        Device::Cpu => cmd.args(["-ngl", "0", "--device", "none"]),
        Device::Default => cmd.args(["-ngl", if cfg!(target_os = "macos") { "auto" } else { "0" }]),
    };
    process::no_console(&mut cmd);
    let child = cmd.spawn().map_err(|e| format!("не удалось запустить llama-server: {e}"))?;
    *state.server.lock().unwrap() = Some(Server { child, port, last_used: Instant::now() });
    let client = crate::net::client_for("http://127.0.0.1").build().map_err(err)?;
    let started = Instant::now();
    loop {
        if let Ok(r) = client.get(format!("http://127.0.0.1:{port}/health")).send().await {
            if r.status().is_success() {
                break;
            }
        }
        let dead = state.server.lock().unwrap().as_mut().is_none_or(|s| s.child.try_wait().ok().flatten().is_some());
        if dead {
            state.server.lock().unwrap().take();
            return Err("llama-server завершился при запуске (не хватает памяти или библиотек?) — подробности: запустите его из терминала".into());
        }
        if started.elapsed() > load_limit {
            if let Some(mut s) = state.server.lock().unwrap().take() {
                let _ = s.child.kill();
            }
            return Err(format!("модель не загрузилась за {} с", load_limit.as_secs()));
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    log::info!("ai: llama-server on 127.0.0.1:{port}");
    Ok(port)
}

/// On app exit: Tauri does not drop managed state, so stop llama-server explicitly
/// (otherwise it would keep running and holding ~1.5 GB after OpsDeck is closed).
pub fn shutdown(app: &AppHandle) {
    if let Some(mut s) = app.state::<AiState>().server.lock().unwrap().take() {
        let _ = s.child.kill();
        let _ = s.child.wait();
    }
}

/// Background: stop the server after IDLE_STOP without requests.
pub fn spawn_idle_stop(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let state = app.state::<AiState>();
            let mut g = state.server.lock().unwrap();
            if g.as_ref().is_some_and(|s| s.last_used.elapsed() > IDLE_STOP) {
                if let Some(mut s) = g.take() {
                    let _ = s.child.kill();
                    let _ = s.child.wait();
                    log::info!("ai: llama-server stopped after idle");
                }
            }
        }
    });
}

// ---------------------------------------------------------------- providers

/// Кто отвечает на запросы: встроенный llama-server или внешний сервер
/// (Ollama, vLLM, LM Studio, OpenAI — любой с OpenAI-совместимым /v1).
#[derive(Clone, Debug)]
pub enum AiProvider {
    Local,
    Remote { base: String, model: String, api_key: String },
}

/// Базовый URL внешнего сервера: `http://host:port` (полный URL — как есть).
/// Порт по умолчанию Ollama (11434), если порт пустой или не число.
pub fn remote_base(host: &str, port: &str) -> Option<String> {
    let host = host.trim();
    if host.is_empty() {
        return None;
    }
    // the base is the server itself: "/v1/…" is added to it, so an address copied together with
    // "/v1" (as most services show it) or with "/v1/chat/completions" would become ".../v1/v1/..." (#58)
    let strip = |u: &str| -> String {
        let mut u = u.trim_end_matches('/');
        for tail in ["/chat/completions", "/completions", "/models", "/v1"] {
            if let Some(rest) = u.strip_suffix(tail) {
                u = rest.trim_end_matches('/');
            }
        }
        u.to_string()
    };
    Some(if host.starts_with("http://") || host.starts_with("https://") {
        strip(host)
    } else if host.contains('/') {
        // "ohmylama.ru/v1": a host with a path but no scheme — https, the port is in the URL if any
        strip(&format!("https://{host}"))
    } else {
        format!("http://{host}:{}", port.trim().parse::<u16>().unwrap_or(11434))
    })
}

/// Настройки → провайдер: заполнены адрес и модель — внешний сервер,
/// иначе — встроенный движок.
pub fn provider_for(s: &Settings) -> AiProvider {
    if let (Some(base), model) = (remote_base(&s.ai_host, &s.ai_port), s.ai_model.trim()) {
        if !model.is_empty() {
            // the key lives in the OS keyring; `ai_api_key` is only set for a key typed just now (and in tests)
            let key = if s.ai_api_key.trim().is_empty() { settings::ai_api_key() } else { s.ai_api_key.trim().to_string() };
            return AiProvider::Remote { base, model: model.to_string(), api_key: key };
        }
    }
    AiProvider::Local
}

/// Самая лёгкая модель хороша для «подскажи команду», но для многошагового расследования
/// слабовата: путает флаги и теряет нить. Об этом честно пишем в настройках агента.
fn weak_model(id: &str) -> bool {
    id == MODELS[0].id
}

/// Чем агент будет думать — то, что видит человек в настройках.
#[derive(Serialize, PartialEq, Debug)]
pub struct Brain {
    /// «app» или «server»
    pub source: String,
    /// «Внешний сервер: qwen2.5-coder:14b» / «Встроенная — Средняя Qwen3.5 4B»
    pub title: String,
    /// слабовата для расследования
    pub weak: bool,
    /// чего не хватает, чтобы это заработало
    pub problem: String,
}

/// Собственно решение, отдельно от чтения настроек: так его проверяет тест.
fn brain_of(choice: &crate::agent::ModelChoice, app: &Settings, local_title: &str, local_id: &str, local_ready: bool) -> Brain {
    if choice.source == "server" {
        let base = remote_base(&choice.host, &choice.port);
        let name = choice.name.trim();
        return Brain {
            source: "server".into(),
            title: match (&base, name.is_empty()) {
                (Some(b), false) => format!("Внешний сервер {b}: {name}"),
                _ => "Внешний сервер".into(),
            },
            weak: false,
            problem: match (base, name.is_empty()) {
                (None, _) => "не указан адрес сервера".into(),
                (Some(_), true) => "не указано имя модели".into(),
                _ => String::new(),
            },
        };
    }
    match provider_for(app) {
        AiProvider::Remote { base, model, .. } => Brain {
            source: "app".into(),
            title: format!("Как в настройках: внешний сервер {base}: {model}"),
            weak: false,
            problem: String::new(),
        },
        AiProvider::Local => Brain {
            source: "app".into(),
            title: format!("Как в настройках: встроенная модель — {local_title}"),
            weak: weak_model(local_id),
            problem: if local_ready { String::new() } else { "модель ещё не установлена (⚙ → Локальный ИИ)".into() },
        },
    }
}

pub fn agent_brain(choice: &crate::agent::ModelChoice) -> Brain {
    let (title, id, ready) = match selected() {
        Selected::Preset(m) => (m.title.to_string(), m.id.to_string(), preset_ready(m)),
        Selected::Custom(p) => (format!("свой файл: {}", p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()), String::new(), p.is_file()),
    };
    brain_of(choice, &settings::load(), &title, &id, ready)
}

/// Чем выполнять запросы агента: его собственный сервер или то, что настроено в приложении.
pub fn agent_provider(choice: &crate::agent::ModelChoice) -> AiProvider {
    if choice.source == "server" {
        if let (Some(base), name) = (remote_base(&choice.host, &choice.port), choice.name.trim()) {
            if !name.is_empty() {
                return AiProvider::Remote { base, model: name.to_string(), api_key: settings::ai_api_key() };
            }
        }
    }
    provider_for(&settings::load())
}

/// Системная инструкция: из plain-words запроса — одна shell-команда.
const SYSTEM_PROMPT: &str = "Ты помощник DevOps-инженера в терминале. На запрос отвечай ровно одной командой shell (можно с | и &&), без пояснений, без markdown и без $ в начале. Если в контексте есть похожие команды пользователя — бери оттуда имена хостов, неймспейсов, контекстов и флаги. Не придумывай опасных команд (rm -rf /, удаление без запроса).";

/// One chat completion at an OpenAI-compatible `/v1/chat/completions`
/// (Ollama, llama.cpp, vLLM… share this API).
async fn chat_completion(base: &str, api_key: &str, model: Option<&str>, user: &str) -> Result<String, String> {
    let remote = model.is_some();
    let mut body = serde_json::json!({
        "messages": [
            { "role": "system", "content": SYSTEM_PROMPT },
            { "role": "user", "content": user }
        ],
        "temperature": 0.1,
        "max_tokens": 160,
        "stream": false
    });
    if let Some(m) = model {
        body["model"] = serde_json::json!(m); // локальный llama-server на это не смотрит
    }
    if !remote {
        // Qwen3.x think aloud by default: a command is needed, not reasoning. Only for our own
        // llama-server: OpenAI's API rejects unknown fields (a remote model's <think> is cut by clean_command)
        body["chat_template_kwargs"] = serde_json::json!({ "enable_thinking": false });
    }
    let mut req = crate::net::client_for(base).build().map_err(err)?.post(format!("{base}/v1/chat/completions")).timeout(Duration::from_secs(120)).json(&body);
    if !api_key.is_empty() {
        req = req.header(reqwest::header::AUTHORIZATION, format!("Bearer {api_key}"));
    }
    let resp: serde_json::Value = req
        .send()
        .await
        .map_err(|e| if remote { format!("сервер ИИ не ответил: {e}") } else { format!("локальный ИИ не ответил: {e}") })?
        .json()
        .await
        .map_err(err)?;
    Ok(resp["choices"][0]["message"]["content"].as_str().unwrap_or("").to_string())
}

/// Проверка связи с внешним сервером: список моделей из `/v1/models`.
#[derive(Serialize)]
pub struct AiTest {
    models: Vec<String>,
}

#[tauri::command]
pub async fn ai_test(host: String, port: String, api_key: String) -> Result<AiTest, String> {
    let base = remote_base(&host, &port).ok_or("укажите адрес сервера")?;
    let mut req = crate::net::client_for(&base).build().map_err(err)?.get(format!("{base}/v1/models")).timeout(Duration::from_secs(10));
    // the field is empty when the key is already saved: use the saved one
    let key = if api_key.trim().is_empty() { settings::ai_api_key() } else { api_key.trim().to_string() };
    if !key.is_empty() {
        req = req.header(reqwest::header::AUTHORIZATION, format!("Bearer {key}"));
    }
    let resp = req.send().await.map_err(|e| format!("нет ответа из {base}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("сервер {base}: HTTP {}", resp.status()));
    }
    let v: serde_json::Value = resp.json().await.map_err(err)?;
    // Ollama и llama-server отвечают {"data": [{"id": …}]}
    let models = v["data"]
        .as_array()
        .map(|a| a.iter().filter_map(|m| m["id"].as_str().or_else(|| m["name"].as_str())).map(str::to_string).collect())
        .unwrap_or_default();
    Ok(AiTest { models })
}

#[derive(Serialize)]
pub struct AiAnswer {
    command: String,
    /// commands from notes that were given to the model as context
    from_notes: Vec<String>,
    elapsed_ms: u64,
}

/// The "Shell, OS" line of the AI context. `shell` is the pane's shell by program name
/// ("pwsh", "bash", ...) or "wsl:<distro>": a WSL tab runs Linux even though OpsDeck runs on Windows.
fn shell_context(shell: Option<&str>, os: &str) -> String {
    match shell {
        Some(s) if s.starts_with("wsl:") || s == "wsl" => {
            let distro = s
                .strip_prefix("wsl:")
                .filter(|d| !d.is_empty())
                .unwrap_or("по умолчанию");
            format!("Shell: shell Linux в WSL (дистрибутив {distro}), ОС: linux\n")
        }
        Some(s) => format!("Shell: {s}, ОС: {os}\n"),
        None => format!("Shell: bash, ОС: {os}\n"),
    }
}

/// Plain-words request → one shell command. `context` = cwd, recent commands, shell.
#[tauri::command]
pub async fn ai_command(app: AppHandle, request: String, cwd: Option<String>, recent: Vec<String>, shell: Option<String>) -> Result<AiAnswer, String> {
    let started = Instant::now();
    let notes = crate::cmdindex::related(&request, 8).await;
    let mut context = String::new();
    if let Some(c) = cwd.filter(|c| !c.is_empty()) {
        context += &format!("Текущая папка: {c}\n");
    }
    context += &shell_context(shell.as_deref(), std::env::consts::OS);
    if !recent.is_empty() {
        context += "Недавние команды пользователя:\n";
        for r in recent.iter().rev().take(10).rev() {
            context += &format!("  {r}\n");
        }
    }
    // база знаний: проверенные команды по теме запроса — чтобы флаги были настоящими, а не выдуманными
    context += &crate::kb::hint(&crate::kb::load(), &request, 2, 6);
    if !notes.is_empty() {
        context += "Команды из заметок пользователя (используй их стиль, имена хостов, неймспейсов и ресурсов):\n";
        for n in &notes {
            context += &format!("  {n}\n");
        }
    }
    let user = format!("{context}\nЗапрос: {request}");
    let provider = provider_for(&settings::current().await);
    let (base, model, key) = match &provider {
        AiProvider::Local => {
            let port = ensure_server(&app).await?;
            (format!("http://127.0.0.1:{port}"), None, String::new())
        }
        AiProvider::Remote { base, model, api_key } => (base.clone(), Some(model.clone()), api_key.clone()),
    };
    let raw = chat_completion(&base, &key, model.as_deref(), &user).await?;
    if matches!(provider, AiProvider::Local) {
        if let Some(s) = app.state::<AiState>().server.lock().unwrap().as_mut() {
            s.last_used = Instant::now();
        }
    }
    Ok(AiAnswer { command: clean_command(&raw), from_notes: notes, elapsed_ms: started.elapsed().as_millis() as u64 })
}

/// Models like to wrap the answer in ``` or prefix it with "$ ".
pub(crate) fn clean_command(raw: &str) -> String {
    // a reasoning model may still prepend <think>…</think>
    let raw = raw.rsplit_once("</think>").map(|(_, after)| after).unwrap_or(raw);
    let mut s = raw.trim();
    if let Some(rest) = s.strip_prefix("```") {
        s = rest.split_once('\n').map(|(_, b)| b).unwrap_or(rest);
        s = s.trim_end().trim_end_matches("```");
    }
    s.lines()
        .map(|l| l.trim().trim_start_matches("$ ").trim_matches('`'))
        .filter(|l| !l.is_empty())
        .take(3)
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    /// Чем думает агент: подсказка в настройках должна быть честной, включая то, что лёгкая
    /// модель для многошагового расследования слабовата.
    #[test]
    fn the_agent_brain_is_named_honestly() {
        use super::{brain_of, MODELS};
        use crate::agent::ModelChoice;
        use crate::settings::Settings;
        let app = Settings::default();
        let light = &MODELS[0];
        let mid = &MODELS[1];

        // как в настройках, встроенная лёгкая: работает, но предупреждаем
        let b = brain_of(&ModelChoice::default(), &app, light.title, light.id, true);
        assert!(b.title.contains(light.title));
        assert!(b.weak);
        assert!(b.problem.is_empty());

        // модель покрупнее и установлена — замечаний нет
        let b = brain_of(&ModelChoice::default(), &app, mid.title, mid.id, true);
        assert!(!b.weak && b.problem.is_empty());

        // выбрана, но ещё не скачана
        let b = brain_of(&ModelChoice::default(), &app, mid.title, mid.id, false);
        assert!(b.problem.contains("не установлена"));

        // внешний сервер приложения — его и возьмёт агент
        let remote = Settings { ai_host: "ollama.example.com".into(), ai_port: "11434".into(), ai_model: "qwen2.5-coder:14b".into(), ..Settings::default() };
        let b = brain_of(&ModelChoice::default(), &remote, light.title, light.id, true);
        assert!(b.title.contains("qwen2.5-coder:14b"), "{}", b.title);
        assert!(!b.weak, "у внешнего сервера своя модель, лёгкая встроенная тут ни при чём");

        // свой сервер агента: без адреса или без имени модели он не заработает
        let own = ModelChoice { source: "server".into(), host: "ai.example.com".into(), port: "11434".into(), name: "llama3.3".into() };
        let b = brain_of(&own, &app, light.title, light.id, true);
        assert!(b.title.contains("llama3.3") && b.problem.is_empty());
        let b = brain_of(&ModelChoice { host: String::new(), ..own.clone() }, &app, light.title, light.id, true);
        assert_eq!(b.problem, "не указан адрес сервера");
        let b = brain_of(&ModelChoice { name: String::new(), ..own }, &app, light.title, light.id, true);
        assert_eq!(b.problem, "не указано имя модели");
    }

    /// Сборка файла из частей целиком: свой маленький сервер с поддержкой Range, четыре соединения,
    /// позиционная запись. Если бы диапазоны или смещения разъехались, sha256 это сразу покажет.
    #[test]
    fn four_connections_assemble_the_same_file() {
        use std::io::{Read, Write};
        // «модель»: байты с предсказуемым содержимым, чтобы перепутанные куски были видны
        let body: Vec<u8> = (0..300_000u32).flat_map(|i| i.to_le_bytes()).collect();
        let expected = {
            let mut h = Sha256::new();
            h.update(&body);
            format!("{:x}", h.finalize())
        };
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let served = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let srv = {
            let body = body.clone();
            let served = served.clone();
            std::thread::spawn(move || {
                let mut served_n = 0;
                while served_n < 4 {
                    let Ok((mut s, _)) = listener.accept() else { return };
                    let Some(req) = read_request(&mut s) else { continue };
                    served_n += 1;
                    let range = req
                        .lines()
                        .find(|l| l.to_ascii_lowercase().starts_with("range:"))
                        .and_then(|l| l.split('=').nth(1).map(str::trim).map(str::to_string));
                    let (from, to) = match range.as_deref().and_then(|r| r.split_once('-')) {
                        Some((a, b)) => (a.parse::<usize>().unwrap(), b.parse::<usize>().unwrap()),
                        None => (0, body.len() - 1),
                    };
                    let slice = &body[from..=to];
                    let head = format!(
                        "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {from}-{to}/{}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
                        slice.len(),
                        body.len()
                    );
                    let _ = s.write_all(head.as_bytes()).and_then(|_| s.write_all(slice));
                    served.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }
            })
        };

        let dir = std::env::temp_dir().join(format!("opsdeck-dl-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let part = dir.join("model.part");
        let cancel = std::sync::atomic::AtomicBool::new(false);
        let seen = std::sync::Mutex::new(Vec::<u64>::new());
        let client = reqwest::Client::new();
        let url = format!("http://127.0.0.1:{port}/model.gguf");
        tauri::async_runtime::block_on(download_parts(&client, &url, &part, body.len() as u64, 4, &cancel, &|done| {
            seen.lock().unwrap().push(done)
        }))
        .unwrap();
        srv.join().unwrap();

        assert_eq!(served.load(std::sync::atomic::Ordering::SeqCst), 4, "каждая часть — своё соединение");
        let mut got = Vec::new();
        fs::File::open(&part).unwrap().read_to_end(&mut got).unwrap();
        assert_eq!(got.len(), body.len());
        assert_eq!(sha_of(&part, &cancel, &|_| {}).unwrap(), expected, "файл собран не так, как отдавал сервер");
        assert_eq!(*seen.lock().unwrap().last().unwrap(), body.len() as u64, "в конце прогресс — весь размер");
        fs::remove_dir_all(&dir).unwrap();
    }

    /// Запрос целиком: один read может принести половину заголовков, а пустое соединение (клиент
    /// открыл и закрыл) запросом не считается.
    #[cfg(test)]
    fn read_request(s: &mut std::net::TcpStream) -> Option<String> {
        use std::io::Read;
        let mut req = String::new();
        let mut buf = [0u8; 1024];
        loop {
            match s.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => req.push_str(&String::from_utf8_lossy(&buf[..n])),
            }
            if req.contains("\r\n\r\n") {
                break;
            }
        }
        (!req.trim().is_empty()).then_some(req)
    }

    /// Обрыв не стоит всей модели: при следующей попытке части продолжаются с того места, где
    /// остановились, и собранный файл совпадает с отданным сервером.
    #[test]
    fn an_interrupted_download_resumes_where_it_stopped() {
        use std::io::{Read, Write};
        let body: Vec<u8> = (0..200_000u32).flat_map(|i| i.to_le_bytes()).collect();
        let expected = {
            let mut h = Sha256::new();
            h.update(&body);
            format!("{:x}", h.finalize())
        };
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let asked: std::sync::Arc<std::sync::Mutex<Vec<(u64, u64)>>> = Default::default();
        // первая попытка: каждая часть отдаёт только четверть своего диапазона и обрывается
        let srv = {
            let (body, asked) = (body.clone(), asked.clone());
            std::thread::spawn(move || {
                let mut round = 0;
                while round < 8 {
                    let Ok((mut s, _)) = listener.accept() else { return };
                    let Some(req) = read_request(&mut s) else { continue };
                    let r = req.lines().find(|l| l.to_ascii_lowercase().starts_with("range:")).and_then(|l| l.split('=').nth(1).map(str::trim).map(str::to_string)).unwrap();
                    let (a, b) = r.split_once('-').unwrap();
                    let (from, to) = (a.parse::<u64>().unwrap(), b.parse::<u64>().unwrap());
                    asked.lock().unwrap().push((from, to));
                    round += 1;
                    let cut = if round <= 4 { (to - from + 1) / 4 } else { to - from + 1 };
                    let slice = &body[from as usize..(from + cut) as usize];
                    // длину объявляем полную, а отдаём кусок и закрываем: для клиента это обрыв
                    let head = format!(
                        "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {from}-{to}/{}\r\nConnection: close\r\n\r\n",
                        to - from + 1,
                        body.len()
                    );
                    let _ = s.write_all(head.as_bytes()).and_then(|_| s.write_all(slice));
                }
            })
        };

        let dir = std::env::temp_dir().join(format!("opsdeck-resume-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let part = dir.join("model.part");
        let cancel = std::sync::atomic::AtomicBool::new(false);
        // без пула: первую порцию соединений сервер закрывает нарочно, и переиспользование уже
        // закрытого соединения во второй попытке иногда ломало сам тест (macOS в CI)
        let client = reqwest::Client::builder().pool_max_idle_per_host(0).build().unwrap();
        let url = format!("http://127.0.0.1:{port}/model.gguf");
        let total = body.len() as u64;

        // первая попытка обрывается, но состояние остаётся
        let first = tauri::async_runtime::block_on(download_parts(&client, &url, &part, total, 4, &cancel, &|_| {}));
        assert!(first.is_err(), "сервер оборвал отдачу — загрузка должна была не дойти");
        let st = load_state(&part, &url, total).expect("состояние докачки не сохранилось");
        let got_before: u64 = st.parts.iter().map(|(.., d)| *d).sum();
        assert!(got_before > 0 && got_before < total, "скачано {got_before} из {total}");

        // вторая попытка: спрашиваются только остатки
        asked.lock().unwrap().clear();
        tauri::async_runtime::block_on(download_parts(&client, &url, &part, total, 4, &cancel, &|_| {})).unwrap();
        srv.join().unwrap();
        let second = asked.lock().unwrap().clone();
        assert_eq!(second.len(), 4);
        let again: u64 = second.iter().map(|(a, b)| b - a + 1).sum();
        assert_eq!(again, total - got_before, "докачивается ровно остаток, а не файл заново");

        let mut got = Vec::new();
        fs::File::open(&part).unwrap().read_to_end(&mut got).unwrap();
        assert_eq!(got.len(), body.len());
        assert_eq!(sha_of(&part, &cancel, &|_| {}).unwrap(), expected, "после докачки файл собран верно");
        assert!(load_state(&part, &url, total).is_none(), "состояние убирается, когда файл дошёл целиком");
        fs::remove_dir_all(&dir).unwrap();
    }

    /// Модель на несколько гигабайт качается в несколько соединений: границы диапазонов не должны
    /// ни пересекаться, ни оставлять дыр, иначе файл соберётся битым.
    #[test]
    fn ranges_cover_the_file_exactly() {
        let r = ranges(1000, 4);
        assert_eq!(r, [(0, 249), (250, 499), (500, 749), (750, 999)]);
        // нечётный размер: остаток забирает последняя часть
        let r = ranges(1003, 4);
        assert_eq!(r.last().unwrap(), &(750, 1002));
        for w in r.windows(2) {
            assert_eq!(w[1].0, w[0].1 + 1, "дыра или наложение: {w:?}");
        }
        assert_eq!(r.iter().map(|(a, b)| b - a + 1).sum::<u64>(), 1003);
        // вырожденные случаи
        assert_eq!(ranges(10, 1), [(0, 9)]);
        assert_eq!(ranges(0, 4), [(0, 0)]);
        assert_eq!(ranges(3, 4).iter().map(|(a, b)| b - a + 1).sum::<u64>(), 3);
    }

    #[test]
    fn the_probe_tells_the_size_only_for_a_real_range_answer() {
        assert_eq!(range_total(206, Some("bytes 0-0/5680522464")), Some(5680522464));
        assert_eq!(range_total(206, Some("bytes 0-0/*")), None, "размер неизвестен");
        assert_eq!(range_total(200, Some("bytes 0-0/100")), None, "сервер отдал весь файл — куски он не умеет");
        assert_eq!(range_total(206, None), None);
    }

    use super::*;
    use crate::settings::Settings;

    fn settings(host: &str, port: &str, model: &str, key: &str) -> Settings {
        Settings { ai_host: host.into(), ai_port: port.into(), ai_model: model.into(), ai_api_key: key.into(), ..Default::default() }
    }

    #[test]
    fn base_url() {
        assert_eq!(remote_base("192.168.1.10", "11434"), Some("http://192.168.1.10:11434".into()));
        assert_eq!(remote_base("localhost", ""), Some("http://localhost:11434".into()));
        assert_eq!(remote_base("host", "нет"), Some("http://host:11434".into()));
        assert_eq!(remote_base("http://x.local/", ""), Some("http://x.local".into()));
        assert_eq!(remote_base("  ", ""), None);
        // #58: an address copied with /v1 or the whole endpoint
        assert_eq!(remote_base("https://ohmylama.ru/v1", ""), Some("https://ohmylama.ru".into()));
        assert_eq!(remote_base("https://ohmylama.ru/v1/", ""), Some("https://ohmylama.ru".into()));
        assert_eq!(remote_base("https://api.example.com/v1/chat/completions", ""), Some("https://api.example.com".into()));
        assert_eq!(remote_base("https://gw.example.com/openai/v1", ""), Some("https://gw.example.com/openai".into()), "a path before /v1 stays");
        assert_eq!(remote_base("ohmylama.ru/v1", ""), Some("https://ohmylama.ru".into()));
        assert_eq!(remote_base("http://10.0.0.5:8000/v1", ""), Some("http://10.0.0.5:8000".into()));
    }

    #[test]
    fn provider() {
        assert!(matches!(provider_for(&settings("", "", "", "")), AiProvider::Local));
        assert!(matches!(provider_for(&settings("h", "", "", "")), AiProvider::Local)); // нет модели
        match provider_for(&settings("10.0.0.2", "9999", " qwen ", " sk ")) {
            AiProvider::Remote { base, model, api_key } => {
                assert_eq!((base.as_str(), model.as_str(), api_key.as_str()), ("http://10.0.0.2:9999", "qwen", "sk"));
            }
            _ => panic!("remote"),
        }
    }

    #[test]
    fn model_catalog() {
        let mut ids = std::collections::HashSet::new();
        let mut files = std::collections::HashSet::new();
        for m in MODELS {
            assert!(ids.insert(m.id), "duplicate id {}", m.id);
            assert!(files.insert(m.file), "duplicate file {}", m.file);
            assert_eq!(m.sha256.len(), 64, "{}", m.id);
            assert!(m.sha256.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()), "{}", m.id);
            assert!(m.url.starts_with("https://huggingface.co/") && m.url.ends_with(m.file), "{}", m.url);
            assert!(m.size > 500_000_000, "{}", m.id);
        }
        assert_eq!(MODELS[0].id, "qwen2.5-coder-1.5b", "the light model stays the default");
        assert!(MODELS.windows(2).all(|w| w[0].ram_gb <= w[1].ram_gb && w[0].size < w[1].size), "ordered from light to large");
        assert!(MODELS.iter().all(|m| m.active_b > 0.0), "активные параметры указаны у всех");
    }

    #[test]
    fn will_this_pc_run_the_model() {
        let g = GIB;
        let q27 = MODELS.iter().find(|m| m.id == "qwen3.8-27b").expect("Qwen3.8 27B в списке");
        let moe = MODELS.iter().find(|m| m.id == "qwen3.6-35b-a3b").unwrap();
        let run = |m: &Model, ram: u64, disk: u64, accel: bool| fit(m.size, m.ram_gb, m.active_b, ram * g, Some(disk * g), accel, false);
        // 32 ГБ и видеокарта — хорошо; на процессоре плотная 27B медленная, а MoE 35B-A3B — нет
        assert_eq!(run(q27, 32, 500, true).level, FitLevel::Good);
        assert_eq!(run(q27, 32, 500, false).level, FitLevel::Slow);
        assert_eq!(run(moe, 32, 500, false).level, FitLevel::Good);
        // 20 ГБ: файл влезает, но меньше рекомендованных 24 — впритык
        let tight = run(q27, 20, 500, true);
        assert_eq!(tight.level, FitLevel::Tight);
        assert!(tight.why.contains("20 ГБ") && tight.why.contains("24 ГБ"), "{}", tight.why);
        // 16 ГБ: файл 16,5 ГБ в память не поместится
        let no = run(q27, 16, 500, true);
        assert_eq!(no.level, FitLevel::No);
        assert!(no.why.contains("памяти"), "{}", no.why);
        // места на диске мало — не скачается; уже скачанной модели место не нужно
        let disk = run(q27, 64, 10, true);
        assert_eq!(disk.level, FitLevel::No);
        assert!(disk.why.contains("на диске свободно 10 ГБ"), "{}", disk.why);
        assert_eq!(fit(q27.size, q27.ram_gb, q27.active_b, 64 * g, Some(10 * g), true, true).level, FitLevel::Good);
        // место неизвестно — не мешаем
        assert_eq!(fit(q27.size, q27.ram_gb, q27.active_b, 64 * g, None, true, false).level, FitLevel::Good);
        // лёгкая модель идёт везде
        assert_eq!(run(&MODELS[0], 8, 20, false).level, FitLevel::Good);
    }

    #[test]
    fn clean() {
        assert_eq!(super::clean_command("```bash\n$ kubectl get pods -n prod\n```"), "kubectl get pods -n prod");
        assert_eq!(super::clean_command("`ls -la`"), "ls -la");
        assert_eq!(super::clean_command("<think>\nсписок подов\n</think>\n\nkubectl get pods -A"), "kubectl get pods -A");
    }

    #[test]
    fn shell_line() {
        assert_eq!(shell_context(None, "linux"), "Shell: bash, ОС: linux\n");
        assert_eq!(
            shell_context(Some("pwsh"), "windows"),
            "Shell: pwsh, ОС: windows\n"
        );
        assert_eq!(
            shell_context(Some("wsl:Ubuntu-24.04"), "windows"),
            "Shell: shell Linux в WSL (дистрибутив Ubuntu-24.04), ОС: linux\n"
        );
        assert_eq!(
            shell_context(Some("wsl"), "windows"),
            "Shell: shell Linux в WSL (дистрибутив по умолчанию), ОС: linux\n"
        );
    }
}
