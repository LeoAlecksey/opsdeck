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
    },
    Model {
        id: "qwen3.5-4b",
        title: "Средняя — Qwen3.5 4B",
        file: "Qwen3.5-4B-Q4_K_M.gguf",
        url: "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf",
        sha256: "00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4",
        size: 2_740_937_888,
        ram_gb: 8,
    },
    Model {
        id: "qwen3.5-9b",
        title: "Мощная — Qwen3.5 9B",
        file: "Qwen3.5-9B-Q4_K_M.gguf",
        url: "https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q4_K_M.gguf",
        sha256: "03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8",
        size: 5_680_522_464,
        ram_gb: 16,
    },
    Model {
        id: "qwen3.6-35b-a3b",
        title: "Большая — Qwen3.6 35B-A3B (MoE)",
        file: "Qwen3.6-35B-A3B-UD-Q4_K_M.gguf",
        url: "https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF/resolve/main/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf",
        sha256: "ac0e2c1189e055faa36eff361580e79c5bd6f8e76bffb4ce547f167d53e31a61",
        size: 22_134_528_992,
        ram_gb: 32,
    },
];
const CUSTOM: &str = "custom";
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
    AiModels {
        models: MODELS.iter().map(|m| AiModelInfo { id: m.id, title: m.title, size: m.size, ram_gb: m.ram_gb, installed: preset_ready(m) }).collect(),
        selected: match selected() {
            Selected::Preset(m) => m.id.to_string(),
            Selected::Custom(_) => CUSTOM.to_string(),
        },
        custom_path: c.custom_path,
        ram_total: sys.total_memory(),
        gpu: c.gpu,
        gpu_supported: vulkan_asset().is_some(),
        vulkan_found: vulkan_found(),
        metal: cfg!(target_os = "macos"),
        gpu_failed: state.gpu_failed.load(std::sync::atomic::Ordering::Relaxed),
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

/// Stream `url` to `dest` (via a .part file), checking sha256 when given. Cancellable.
async fn download(app: &AppHandle, url: &str, dest: &Path, sha256: Option<&str>, stage: &str, cancel: &std::sync::atomic::AtomicBool) -> Result<(), String> {
    let client = reqwest::Client::builder().user_agent(concat!("OpsDeck/", env!("CARGO_PKG_VERSION"))).connect_timeout(Duration::from_secs(20)).build().map_err(err)?;
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
async fn ensure_server(app: &AppHandle) -> Result<u16, String> {
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
    let client = reqwest::Client::new();
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
    Some(if host.starts_with("http://") || host.starts_with("https://") {
        host.trim_end_matches('/').to_string()
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
    let mut req = reqwest::Client::new().post(format!("{base}/v1/chat/completions")).timeout(Duration::from_secs(120)).json(&body);
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
    let mut req = reqwest::Client::new().get(format!("{base}/v1/models")).timeout(Duration::from_secs(10));
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

/// Plain-words request → one shell command. `context` = cwd, recent commands, shell.
#[tauri::command]
pub async fn ai_command(app: AppHandle, request: String, cwd: Option<String>, recent: Vec<String>, shell: Option<String>) -> Result<AiAnswer, String> {
    let started = Instant::now();
    let notes = crate::cmdindex::related(&request, 8).await;
    let mut context = String::new();
    if let Some(c) = cwd.filter(|c| !c.is_empty()) {
        context += &format!("Текущая папка: {c}\n");
    }
    context += &format!("Shell: {}, ОС: {}\n", shell.unwrap_or_else(|| "bash".into()), std::env::consts::OS);
    if !recent.is_empty() {
        context += "Недавние команды пользователя:\n";
        for r in recent.iter().rev().take(10).rev() {
            context += &format!("  {r}\n");
        }
    }
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
fn clean_command(raw: &str) -> String {
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
    use super::*;
    use crate::settings::Settings;

    fn settings(host: &str, port: &str, model: &str, key: &str) -> Settings {
        let mut s = Settings::default();
        s.ai_host = host.into();
        s.ai_port = port.into();
        s.ai_model = model.into();
        s.ai_api_key = key.into();
        s
    }

    #[test]
    fn base_url() {
        assert_eq!(remote_base("192.168.1.10", "11434"), Some("http://192.168.1.10:11434".into()));
        assert_eq!(remote_base("localhost", ""), Some("http://localhost:11434".into()));
        assert_eq!(remote_base("host", "нет"), Some("http://host:11434".into()));
        assert_eq!(remote_base("http://x.local/", ""), Some("http://x.local".into()));
        assert_eq!(remote_base("  ", ""), None);
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
    }

    #[test]
    fn clean() {
        assert_eq!(super::clean_command("```bash\n$ kubectl get pods -n prod\n```"), "kubectl get pods -n prod");
        assert_eq!(super::clean_command("`ls -la`"), "ls -la");
        assert_eq!(super::clean_command("<think>\nсписок подов\n</think>\n\nkubectl get pods -A"), "kubectl get pods -A");
    }
}
