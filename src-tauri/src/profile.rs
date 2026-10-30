//! Окружения (профили): несколько независимых рабочих мест в одной установке.
//!
//! Окружение — это отдельный экземпляр приложения со своей папкой настроек, своими ключами в
//! keyring и своими данными вебвью. Основное живёт там же, где жило всегда (~/.config/opsdeck),
//! остальные — в ~/.config/opsdeck/profiles/<id>. Внутри одного процесса окружение не меняется:
//! все `tauri::State` и фоновые задачи принадлежат ему одному, поэтому смешать хосты, кластеры и
//! секреты двух окружений нельзя даже по ошибке. Второе окружение — второй процесс
//! (`opsdeck --profile <id>`).
//!
//! Общими остаются только тяжёлые ИИ-модели (они не в папке настроек) и, по умолчанию, папка
//! заметок: новое пустое окружение берёт её у основного, а дальше её можно сменить в настройках.

use crate::store::{self, err};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};

/// Имя основного окружения в командной строке (`--profile default`).
pub const DEFAULT_ID: &str = "default";
/// Описание окружения внутри его собственной папки настроек.
const META: &str = "profile.json";
/// Что открывать при запуске, когда окружений несколько; лежит в папке основного.
const START: &str = "profiles.json";
const LOCK: &str = "instance.lock";

/// Окружение этого процесса: None — основное. Задаётся один раз, до сборки приложения.
static CURRENT: OnceLock<Option<String>> = OnceLock::new();
/// Как запущен процесс: Some(причина) — окно выбора окружения вместо рабочего места.
static PICKER: OnceLock<Option<String>> = OnceLock::new();
/// Открытая блокировка окружения: пока процесс жив, второй экземпляр того же окружения не запустится.
static HELD: OnceLock<fs::File> = OnceLock::new();

pub fn current() -> Option<&'static str> {
    CURRENT.get().and_then(|c| c.as_deref())
}

fn picker() -> Option<&'static str> {
    PICKER.get().and_then(|p| p.as_deref())
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default)]
pub struct Meta {
    pub name: String,
    /// цвет метки окружения в боковой колонке, `#rrggbb`
    pub color: String,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
struct Start {
    /// окружение, которое открывать без вопроса ("" — спрашивать)
    open: String,
}

/// Имя окружения из аргументов: `--profile x` или `--profile=x`.
pub fn parse_arg<I: IntoIterator<Item = String>>(args: I) -> Option<String> {
    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        if a == "--profile" {
            return it.next();
        }
        if let Some(v) = a.strip_prefix("--profile=") {
            return Some(v.to_string());
        }
    }
    None
}

/// Идентификатор окружения: он попадает в путь, в ключ keyring и в аргумент запуска,
/// поэтому только латиница, цифры и дефис, и не с дефиса — иначе он похож на флаг.
pub fn valid(id: &str) -> bool {
    store::valid_id(id) && !id.starts_with('-') && id != DEFAULT_ID
}

/// Папка окружения внутри общей папки приложения.
pub fn dir_of(base: &Path, id: Option<&str>) -> PathBuf {
    match id {
        None => base.to_path_buf(),
        Some(id) => base.join("profiles").join(id),
    }
}

/// Ключ в keyring: у основного окружения он прежний, у остальных — с префиксом окружения.
/// Без префикса окружение, созданное копией, делило бы с исходным пароли хостов: id в ssh.json
/// совпадают, и удаление хоста в одном стёрло бы пароль в другом.
pub fn keyring_key(profile: Option<&str>, key: &str) -> String {
    match profile {
        None => key.to_string(),
        Some(p) => format!("{p}/{key}"),
    }
}

/// Что делать при запуске.
#[derive(Debug, PartialEq)]
pub enum Launch {
    /// открыть окружение (None — основное)
    Run(Option<String>),
    /// показать окно выбора; строка — почему не открылось запрошенное ("" — просто выбор)
    Pick(String),
}

/// Решение при запуске: `arg` — из командной строки, `known` — созданные окружения,
/// `start` — запомненный выбор.
pub fn decide(arg: Option<&str>, known: &[String], start: &str) -> Launch {
    let exists = |id: &str| known.iter().any(|k| k == id);
    match arg {
        Some(DEFAULT_ID) => Launch::Run(None),
        Some(id) if valid(id) && exists(id) => Launch::Run(Some(id.to_string())),
        Some(id) => Launch::Pick(format!("нет окружения «{id}»")),
        None if known.is_empty() => Launch::Run(None),
        None if start == DEFAULT_ID => Launch::Run(None),
        None if !start.is_empty() && exists(start) => Launch::Run(Some(start.to_string())),
        None => Launch::Pick(String::new()),
    }
}

/// Идентификатор для нового окружения из его названия: «Stage EU» → stage-eu. Кириллица и прочее
/// не переводятся, тогда берётся env-N. Повторы получают номер.
pub fn slug(name: &str, taken: &[String]) -> String {
    let mut s = String::new();
    for c in name.trim().chars() {
        if c.is_ascii_alphanumeric() {
            s.push(c.to_ascii_lowercase());
        } else if !s.is_empty() && !s.ends_with('-') {
            s.push('-');
        }
    }
    let mut s: String = s.trim_end_matches('-').chars().take(32).collect();
    s = s.trim_end_matches('-').to_string();
    if s.is_empty() {
        s = "env".into();
    }
    let free = |id: &str| valid(id) && !taken.iter().any(|t| t == id);
    if free(&s) {
        return s;
    }
    (2..).map(|n| format!("{s}-{n}")).find(|id| free(id)).expect("free id")
}

/// Файлы, которые переносит «копия текущего»: настройка рабочего места. История (алерты, чаты,
/// события k8s), окна и учётная запись Passbolt не копируются; пароли из keyring тоже — их
/// вводят в новом окружении заново (ссылки на KeePass продолжают работать).
pub const COPIED: &[&str] = &[
    "settings.json",
    "vaults.json",
    "ssh.json",
    "ssh_groups.json",
    "ssh_notes.json",
    "snippets.json",
    "mikrotik.json",
    "k8s.json",
    "databases.json",
    "connectors.json",
    "yc.json",
    "alerts-config.json",
    "agent.json",
    "knowledge.md",
];

/// Стабильные 16 байт из идентификатора: хранилище данных WKWebView на macOS выбирается по UUID,
/// и у окружения он должен быть одним и тем же от запуска к запуску (DefaultHasher этого не обещает).
pub fn store_uuid(id: &str) -> [u8; 16] {
    let fnv = |seed: u64| {
        id.bytes().fold(seed, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3))
    };
    let (a, b) = (fnv(0xcbf29ce484222325), fnv(0x84222325cbf29ce4));
    let mut out = [0u8; 16];
    out[..8].copy_from_slice(&a.to_be_bytes());
    out[8..].copy_from_slice(&b.to_be_bytes());
    out
}

/// Короткая метка окружения для путей с ограничением длины (сокеты ssh на macOS — до 104 байт).
pub fn short_tag(id: &str) -> String {
    store_uuid(id)[..4].iter().map(|b| format!("{b:02x}")).collect()
}

/// Имя файла журнала: у основного прежнее, у окружения своё — два процесса в один файл с
/// ротацией писать не могут.
pub fn log_name(profile: Option<&str>) -> String {
    match profile {
        None => "opsdeck".into(),
        Some(id) => format!("opsdeck-{id}"),
    }
}

/// Чем перезапускать себя. Внутри AppImage `current_exe` лежит на смонтированном образе, который
/// пропадает, как только завершится запустивший его процесс: запускать надо сам файл AppImage.
pub fn relaunch_exe(appimage: Option<PathBuf>, current: PathBuf) -> PathBuf {
    appimage.filter(|p| p.is_file()).unwrap_or(current)
}

// ---------- диск ----------

fn known() -> Vec<String> {
    let Ok(base) = store::base_dir() else { return Vec::new() };
    let Ok(rd) = fs::read_dir(base.join("profiles")) else { return Vec::new() };
    let mut out: Vec<String> = rd
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .filter(|id| valid(id))
        .collect();
    out.sort();
    out
}

fn dir(id: Option<&str>) -> Result<PathBuf, String> {
    Ok(dir_of(&store::base_dir()?, id))
}

fn meta_of(id: Option<&str>) -> Meta {
    dir(id)
        .ok()
        .and_then(|d| fs::read_to_string(d.join(META)).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn start() -> Start {
    dir(None).ok().and_then(|d| fs::read_to_string(d.join(START)).ok()).and_then(|r| serde_json::from_str(&r).ok()).unwrap_or_default()
}

fn write_file(path: &Path, data: &str) -> Result<(), String> {
    fs::write(path, data).map_err(err)?;
    store::restrict(path, 0o600)
}

/// Занята ли блокировка окружения другим процессом. Открытый файл не удерживается.
fn locked_elsewhere(id: Option<&str>) -> bool {
    if current() == id && HELD.get().is_some() {
        return false;
    }
    let Ok(d) = dir(id) else { return false };
    let Ok(f) = fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(d.join(LOCK)) else { return false };
    matches!(f.try_lock(), Err(fs::TryLockError::WouldBlock))
}

fn take_lock(id: Option<&str>) -> bool {
    let Ok(d) = dir(id) else { return true };
    let _ = fs::create_dir_all(&d);
    let Ok(f) = fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(d.join(LOCK)) else {
        // нет доступа к файлу блокировки: не мешаем работать, как было до окружений
        return true;
    };
    match f.try_lock() {
        Ok(()) => {
            let _ = HELD.set(f);
            true
        }
        Err(fs::TryLockError::WouldBlock) => false,
        Err(fs::TryLockError::Error(e)) => {
            log::warn!("profile: could not lock the environment: {e}");
            true
        }
    }
}

/// Выбор окружения при запуске. Вызывается до сборки приложения: от него зависят папка настроек,
/// имя журнала и данные вебвью.
pub fn init() {
    let arg = parse_arg(std::env::args().skip(1));
    let launch = decide(arg.as_deref(), &known(), &start().open);
    let (profile, why) = match launch {
        Launch::Run(p) => {
            if take_lock(p.as_deref()) {
                (p, None)
            } else {
                let name = display_name(p.as_deref(), &meta_of(p.as_deref()));
                (None, Some(format!("окружение «{name}» уже открыто")))
            }
        }
        Launch::Pick(why) => (None, Some(why)),
    };
    let _ = CURRENT.set(profile);
    let _ = PICKER.set(why);
}

pub fn is_picker() -> bool {
    PICKER.get().is_some_and(|p| p.is_some())
}

/// Окружений больше одного: тогда у окон появляется имя окружения.
pub fn several() -> bool {
    !known().is_empty()
}

fn display_name(id: Option<&str>, meta: &Meta) -> String {
    if !meta.name.trim().is_empty() {
        return meta.name.trim().to_string();
    }
    match id {
        None => crate::i18n::tr("Основное", &[]),
        Some(id) => id.to_string(),
    }
}

/// Имя приложения в заголовках окон: «OpsDeck» или «OpsDeck · Прод», когда окружений несколько.
pub fn app_title() -> String {
    if is_picker() || !several() {
        return "OpsDeck".into();
    }
    format!("OpsDeck · {}", display_name(current(), &meta_of(current())))
}

/// Каталог данных вебвью окружения (localStorage, cookies панелей Grafana и прочих). У основного —
/// прежний, у остальных — свой: иначе раскладка, вкладки и входы в веб-панели были бы общими.
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn webview_dir() -> Option<PathBuf> {
    let id = current()?;
    Some(dirs::data_local_dir()?.join("opsdeck").join("profiles").join(id).join("webview"))
}

/// Данные вебвью окружения для окна. На macOS каталог не задаётся, там хранилище выбирается по
/// идентификатору, и только с macOS 14: на более старых окна окружений делят localStorage.
pub fn isolate_window<'a, R: tauri::Runtime, M: Manager<R>>(b: tauri::WebviewWindowBuilder<'a, R, M>) -> tauri::WebviewWindowBuilder<'a, R, M> {
    let Some(id) = current() else { return b };
    #[cfg(target_os = "macos")]
    let b = b.data_store_identifier(store_uuid(id));
    #[cfg(not(target_os = "macos"))]
    let b = match webview_dir() {
        Some(d) => b.data_directory(d),
        None => b,
    };
    let _ = id;
    b
}

/// То же для webview, встроенного в окно (веб-панели).
pub fn isolate_webview<R: tauri::Runtime>(b: tauri::webview::WebviewBuilder<R>) -> tauri::webview::WebviewBuilder<R> {
    let Some(id) = current() else { return b };
    #[cfg(target_os = "macos")]
    let b = b.data_store_identifier(store_uuid(id));
    #[cfg(not(target_os = "macos"))]
    let b = match webview_dir() {
        Some(d) => b.data_directory(d),
        None => b,
    };
    let _ = id;
    b
}

/// Сведения для страницы до первого вызова IPC: вставляются в окно скриптом инициализации,
/// чтобы фронтенд сразу знал, рисовать рабочее место или выбор окружения.
pub fn init_script() -> String {
    #[derive(Serialize)]
    struct Boot<'a> {
        id: &'a str,
        name: String,
        color: String,
        several: bool,
        picker: bool,
        notice: &'a str,
    }
    let meta = meta_of(current());
    let boot = Boot {
        id: current().unwrap_or(DEFAULT_ID),
        name: meta.name.trim().to_string(),
        color: meta.color,
        several: several(),
        picker: is_picker(),
        notice: picker().unwrap_or(""),
    };
    format!("window.__OPSDECK_PROFILE__ = {};", serde_json::to_string(&boot).unwrap_or_else(|_| "null".into()))
}

/// Подписать главное окно: язык интерфейса приходит позже сборки окна (`set_lang`).
pub fn retitle(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_title(&app_title());
    }
}

// ---------- команды ----------

#[derive(Serialize)]
pub struct ProfileInfo {
    id: String,
    name: String,
    color: String,
    current: bool,
    /// открыто в другом окне
    open: bool,
}

#[derive(Serialize)]
pub struct Profiles {
    profiles: Vec<ProfileInfo>,
    /// окружение, которое открывается без вопроса ("" — спрашивать)
    start: String,
    picker: bool,
}

fn info(id: Option<&str>) -> ProfileInfo {
    let meta = meta_of(id);
    ProfileInfo {
        id: id.unwrap_or(DEFAULT_ID).to_string(),
        name: meta.name.trim().to_string(),
        color: meta.color,
        current: !is_picker() && current() == id,
        open: locked_elsewhere(id),
    }
}

fn list() -> Profiles {
    let mut profiles = vec![info(None)];
    profiles.extend(known().iter().map(|id| info(Some(id))));
    Profiles { profiles, start: start().open, picker: is_picker() }
}

#[tauri::command]
pub async fn profiles_list() -> Result<Profiles, String> {
    tauri::async_runtime::spawn_blocking(list).await.map_err(err)
}

/// `#rrggbb` или пусто: цвет попадает в style разметки.
fn color_ok(c: &str) -> bool {
    c.is_empty() || (c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|ch| ch.is_ascii_hexdigit()))
}

fn clean_meta(name: &str, color: &str) -> Result<Meta, String> {
    let name: String = name.trim().chars().filter(|c| !c.is_control()).take(40).collect();
    if !color_ok(color) {
        return Err("цвет задаётся как #rrggbb".into());
    }
    Ok(Meta { name, color: color.to_lowercase() })
}

fn create(name: &str, color: &str, copy: bool) -> Result<String, String> {
    let meta = clean_meta(name, color)?;
    if meta.name.is_empty() {
        return Err("введите название окружения".into());
    }
    let id = slug(&meta.name, &known());
    let to = dir(Some(&id))?;
    fs::create_dir_all(&to).map_err(err)?;
    store::restrict(&to, 0o700)?;
    let from = store::config_dir()?;
    // список папок заметок нужен и пустому окружению: заметки по умолчанию общие
    let files: &[&str] = if copy { COPIED } else { &["vaults.json"] };
    for f in files {
        let src = from.join(f);
        if src.is_file() {
            fs::copy(&src, to.join(f)).map_err(|e| format!("{f}: {e}"))?;
            store::restrict(&to.join(f), 0o600)?;
        }
    }
    if copy {
        copy_dir(&from.join("kubeconfigs"), &to.join("kubeconfigs"))?;
    }
    write_file(&to.join(META), &serde_json::to_string_pretty(&meta).map_err(err)?)?;
    Ok(id)
}

fn copy_dir(from: &Path, to: &Path) -> Result<(), String> {
    let Ok(rd) = fs::read_dir(from) else { return Ok(()) };
    fs::create_dir_all(to).map_err(err)?;
    store::restrict(to, 0o700)?;
    for e in rd.flatten() {
        let p = e.path();
        // только обычные файлы: ссылки могут вести куда угодно
        if e.file_type().map(|t| t.is_file()).unwrap_or(false) {
            let dst = to.join(e.file_name());
            fs::copy(&p, &dst).map_err(err)?;
            store::restrict(&dst, 0o600)?;
        }
    }
    Ok(())
}

/// Создать окружение: пустое (общая только папка заметок) или копией текущего.
#[tauri::command]
pub async fn profile_create(name: String, color: String, copy: bool) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || create(&name, &color, copy)).await.map_err(err)?
}

/// Название и цвет текущего окружения.
#[tauri::command]
pub async fn profile_update(app: AppHandle, name: String, color: String) -> Result<(), String> {
    if is_picker() {
        return Err("окружение ещё не выбрано".into());
    }
    let meta = clean_meta(&name, &color)?;
    tauri::async_runtime::spawn_blocking(move || {
        let d = store::config_dir()?;
        write_file(&d.join(META), &serde_json::to_string_pretty(&meta).map_err(err)?)?;
        retitle(&app);
        Ok(())
    })
    .await
    .map_err(err)?
}

/// Открывать окружение без вопроса ("" — спрашивать при каждом запуске).
#[tauri::command]
pub async fn profile_start_set(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !id.is_empty() && id != DEFAULT_ID && !(valid(&id) && known().contains(&id)) {
            return Err(format!("нет окружения «{id}»"));
        }
        let d = dir(None)?;
        fs::create_dir_all(&d).map_err(err)?;
        write_file(&d.join(START), &serde_json::to_string_pretty(&Start { open: id }).map_err(err)?)
    })
    .await
    .map_err(err)?
}

fn launch(id: &str) -> Result<(), String> {
    let target = if id == DEFAULT_ID { None } else { Some(id) };
    if let Some(t) = target {
        if !valid(t) || !known().iter().any(|k| k == t) {
            return Err(format!("нет окружения «{id}»"));
        }
    }
    if !is_picker() && current() == target {
        return Err("это окружение уже открыто в этом окне".into());
    }
    if locked_elsewhere(target) {
        return Err("это окружение уже открыто в другом окне".into());
    }
    let exe = relaunch_exe(std::env::var_os("APPIMAGE").map(PathBuf::from), std::env::current_exe().map_err(err)?);
    let mut child = std::process::Command::new(exe).arg("--profile").arg(id).spawn().map_err(|e| format!("не удалось запустить окружение: {e}"))?;
    std::thread::spawn(move || child.wait());
    Ok(())
}

/// Открыть другое окружение в своём окне; текущее продолжает работать.
#[tauri::command]
pub async fn profile_open(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || launch(&id)).await.map_err(err)?
}

/// Окно выбора: открыть окружение и закрыться.
#[tauri::command]
pub async fn profile_pick(app: AppHandle, id: String) -> Result<(), String> {
    if !is_picker() {
        return Err("окружение уже выбрано".into());
    }
    tauri::async_runtime::spawn_blocking(move || launch(&id)).await.map_err(err)??;
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(s: &[&str]) -> Vec<String> {
        s.iter().map(|a| a.to_string()).collect()
    }

    #[test]
    fn profile_argument() {
        assert_eq!(parse_arg(args(&["--profile", "stage"])), Some("stage".into()));
        assert_eq!(parse_arg(args(&["-psn_0_123", "--profile=prod"])), Some("prod".into()));
        assert_eq!(parse_arg(args(&["--profile"])), None);
        assert_eq!(parse_arg(args(&[])), None);
    }

    #[test]
    fn ids() {
        for ok in ["stage", "prod-eu", "env-2"] {
            assert!(valid(ok), "{ok}");
        }
        // дефис в начале выглядел бы флагом; default занят основным окружением
        for bad in ["", "-x", "--profile", "default", "../x", "a/b", "прод", &"a".repeat(65)] {
            assert!(!valid(bad), "{bad}");
        }
    }

    #[test]
    fn ids_from_names() {
        assert_eq!(slug("Stage EU", &[]), "stage-eu");
        assert_eq!(slug("  prod / k8s  ", &[]), "prod-k8s");
        assert_eq!(slug("Прод", &[]), "env");
        assert_eq!(slug("Прод", &args(&["env", "env-2"])), "env-3");
        assert_eq!(slug("stage", &args(&["stage"])), "stage-2");
        assert_eq!(slug("Default", &[]), "default-2");
        assert!(slug(&"x".repeat(100), &[]).len() <= 32);
    }

    #[test]
    fn what_opens_at_start() {
        let known = args(&["stage"]);
        // одно окружение — как до появления окружений: сразу рабочее место
        assert_eq!(decide(None, &[], ""), Launch::Run(None));
        assert_eq!(decide(None, &known, ""), Launch::Pick(String::new()));
        assert_eq!(decide(None, &known, "stage"), Launch::Run(Some("stage".into())));
        assert_eq!(decide(None, &known, "default"), Launch::Run(None));
        // запомненное окружение удалили — снова спрашиваем
        assert_eq!(decide(None, &known, "gone"), Launch::Pick(String::new()));
        assert_eq!(decide(Some("stage"), &known, ""), Launch::Run(Some("stage".into())));
        assert_eq!(decide(Some("default"), &known, "stage"), Launch::Run(None));
        assert!(matches!(decide(Some("gone"), &known, ""), Launch::Pick(w) if w.contains("gone")));
        assert!(matches!(decide(Some("../x"), &known, ""), Launch::Pick(_)));
    }

    #[test]
    fn folders_and_keyring_keys() {
        let base = Path::new("/home/u/.config/opsdeck");
        assert_eq!(dir_of(base, None), base);
        assert_eq!(dir_of(base, Some("stage")), base.join("profiles").join("stage"));
        // у основного ключи прежние: уже сохранённые пароли остаются на месте
        assert_eq!(keyring_key(None, "ai-api-key"), "ai-api-key");
        assert_eq!(keyring_key(Some("stage"), "ai-api-key"), "stage/ai-api-key");
        assert_ne!(keyring_key(Some("stage"), "ssh-1"), keyring_key(None, "ssh-1"));
    }

    #[test]
    fn webview_store_is_stable_per_profile() {
        assert_eq!(store_uuid("stage"), store_uuid("stage"));
        assert_ne!(store_uuid("stage"), store_uuid("prod"));
        // сокет ssh: ~/.opsdeck/run/<tag>/ssh-<40 hex> должен уложиться в 104 байта и с длинным id
        assert_eq!(short_tag(&"a".repeat(64)).len(), 8);
        assert_ne!(short_tag("stage"), short_tag("prod"));
    }

    #[test]
    fn each_profile_logs_to_its_own_file() {
        assert_eq!(log_name(None), "opsdeck");
        assert_eq!(log_name(Some("stage")), "opsdeck-stage");
    }

    #[test]
    fn appimage_relaunches_the_image_itself() {
        let tmp = std::env::temp_dir().join(format!("opsdeck-appimage-{}", std::process::id()));
        fs::write(&tmp, "").unwrap();
        let mounted = PathBuf::from("/tmp/.mount_opsdeck/usr/bin/opsdeck");
        assert_eq!(relaunch_exe(Some(tmp.clone()), mounted.clone()), tmp);
        assert_eq!(relaunch_exe(None, mounted.clone()), mounted);
        assert_eq!(relaunch_exe(Some("/nonexistent/x.AppImage".into()), mounted.clone()), mounted);
        let _ = fs::remove_file(tmp);
    }

    #[test]
    fn colors() {
        assert!(color_ok("") && color_ok("#1a2B3c"));
        for bad in ["red", "#12345", "#1234567", "#12345g", "\"><script>"] {
            assert!(!color_ok(bad), "{bad}");
        }
        assert!(clean_meta("x", "#ABCDEF").unwrap().color == "#abcdef");
    }

    /// Копия переносит настройку рабочего места, но не историю и не учётную запись Passbolt.
    #[test]
    fn copy_takes_the_setup_not_the_history() {
        for f in ["settings.json", "ssh.json", "k8s.json", "connectors.json", "vaults.json"] {
            assert!(COPIED.contains(&f), "{f}");
        }
        for f in ["alerts.json", "ai-chats.json", "agent-audit.jsonl", "passbolt-account.json", "windows.json", "profile.json"] {
            assert!(!COPIED.contains(&f), "{f}");
        }
    }
}
