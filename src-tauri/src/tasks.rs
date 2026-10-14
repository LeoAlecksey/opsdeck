//! Tasks live inside the notes, one per line, in the Obsidian Tasks format, so a vault stays usable
//! in Obsidian:  `- [ ] Обновить сертификат 📅 2026-10-05 ⏰ 10:00 ⏫ #infra`
//! (📅 due date, ⏰ reminder time on that date, ⏫/🔼/🔽 priority, ✅ date when done).
//! This module lists them across the active vault, edits them in place and pops up reminders.

use crate::{
    notes::{resolve, vault, walk},
    store::{self, err},
};
use chrono::{Local, NaiveDate, NaiveDateTime, NaiveTime};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, SystemTime},
};
use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Task {
    /// vault-relative note path
    path: String,
    /// 1-based line number
    line: usize,
    /// the whole line as in the file (used to check nothing changed before editing)
    raw: String,
    /// text without the markers
    text: String,
    done: bool,
    due: Option<String>,
    time: Option<String>,
    /// 3 highest, 2 high, 1 medium, 0 none, -1 low
    priority: i8,
    tags: Vec<String>,
    done_date: Option<String>,
}

/// `- [ ] …` / `* [x] …` → Task (without path/line).
fn parse(line: &str) -> Option<Task> {
    let t = line.trim_start();
    let rest = t.strip_prefix("- [").or_else(|| t.strip_prefix("* [")).or_else(|| t.strip_prefix("+ ["))?;
    let mut chars = rest.chars();
    let mark = chars.next()?;
    let rest = chars.as_str().strip_prefix("] ")?;
    let done = matches!(mark, 'x' | 'X');
    if !done && mark != ' ' {
        return None; // [-] cancelled, [>] forwarded…: not ours
    }
    let mut task = Task { path: String::new(), line: 0, raw: line.trim_end().to_string(), text: String::new(), done, due: None, time: None, priority: 0, tags: Vec::new(), done_date: None };
    let mut words: Vec<&str> = Vec::new();
    let mut it = rest.split_whitespace().peekable();
    while let Some(w) = it.next() {
        match w {
            "📅" | "🗓" | "🗓️" => task.due = it.next().filter(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").is_ok()).map(str::to_string),
            "⏰" => task.time = it.next().filter(|d| NaiveTime::parse_from_str(d, "%H:%M").is_ok()).map(str::to_string),
            "✅" => task.done_date = it.next().map(str::to_string),
            "🔺" => task.priority = 3,
            "⏫" => task.priority = 2,
            "🔼" => task.priority = 1,
            "🔽" | "⏬" => task.priority = -1,
            // other Tasks-plugin dates (start, scheduled, created): keep in text
            _ => {
                if let Some(tag) = w.strip_prefix('#').filter(|t| !t.is_empty() && !t.chars().all(|c| c.is_ascii_digit())) {
                    task.tags.push(tag.trim_end_matches([',', '.', ';']).to_string());
                }
                words.push(w);
            }
        }
    }
    task.text = words.join(" ");
    Some(task)
}

/// The marker part of a task line, in a stable order.
fn markers(due: Option<&str>, time: Option<&str>, priority: i8, done_date: Option<&str>) -> String {
    let mut s = String::new();
    match priority {
        3 => s += " 🔺",
        2 => s += " ⏫",
        1 => s += " 🔼",
        -1 => s += " 🔽",
        _ => {}
    }
    if let Some(d) = due {
        s += &format!(" 📅 {d}");
        if let Some(t) = time {
            s += &format!(" ⏰ {t}");
        }
    }
    if let Some(d) = done_date {
        s += &format!(" ✅ {d}");
    }
    s
}

/// Rebuild a line: same indentation and bullet, new state and markers, text kept.
fn render(raw: &str, t: &Task) -> String {
    let indent: String = raw.chars().take_while(|c| c.is_whitespace()).collect();
    let bullet = raw.trim_start().chars().next().unwrap_or('-');
    format!("{indent}{bullet} [{}] {}{}", if t.done { "x" } else { " " }, t.text, markers(t.due.as_deref(), t.time.as_deref(), t.priority, t.done_date.as_deref()))
}

// ---------- scanning with a per-file cache ----------

type Cache = HashMap<PathBuf, (SystemTime, Vec<Task>)>;
static CACHE: Mutex<Option<(PathBuf, Cache)>> = Mutex::new(None);

fn scan(root: &Path) -> Vec<Task> {
    let mut files = Vec::new();
    walk(root, root, &mut files);
    let mut guard = CACHE.lock().unwrap();
    if guard.as_ref().is_none_or(|(r, _)| r != root) {
        *guard = Some((root.to_path_buf(), HashMap::new()));
    }
    let cache = &mut guard.as_mut().unwrap().1;
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for rel in files {
        let full = root.join(&rel);
        let Ok(mtime) = fs::metadata(&full).and_then(|m| m.modified()) else { continue };
        seen.insert(full.clone());
        if let Some((m, tasks)) = cache.get(&full) {
            if *m == mtime {
                out.extend(tasks.iter().cloned());
                continue;
            }
        }
        let Ok(text) = fs::read_to_string(&full) else { continue };
        let path = rel.to_string_lossy().into_owned();
        let mut fence = false;
        let tasks: Vec<Task> = text
            .lines()
            .enumerate()
            .filter_map(|(i, l)| {
                if l.trim_start().starts_with("```") {
                    fence = !fence;
                }
                if fence {
                    return None;
                }
                parse(l).map(|mut t| {
                    t.path = path.clone();
                    t.line = i + 1;
                    t
                })
            })
            .collect();
        out.extend(tasks.iter().cloned());
        cache.insert(full, (mtime, tasks));
    }
    cache.retain(|k, _| seen.contains(k));
    out
}

#[tauri::command]
pub async fn tasks_list() -> Result<Vec<Task>, String> {
    let root = vault().await?;
    tauri::async_runtime::spawn_blocking(move || scan(&root)).await.map_err(err)
}

/// Replace one line of a note if it still is `expect`. Keeps the file's line endings.
fn edit_line(full: &Path, line: usize, expect: &str, new: &str) -> Result<(), String> {
    let text = fs::read_to_string(full).map_err(err)?;
    let crlf = text.contains("\r\n");
    let mut lines: Vec<&str> = text.split('\n').collect();
    let cur = lines.get(line.wrapping_sub(1)).map(|l| l.trim_end_matches('\r').trim_end()).ok_or("строки уже нет")?;
    if cur != expect.trim_end() {
        return Err("заметка изменилась — список задач обновлён, попробуйте ещё раз".into());
    }
    let replacement = if crlf { format!("{new}\r") } else { new.to_string() };
    lines[line - 1] = &replacement;
    fs::write(full, lines.join("\n")).map_err(err)
}

#[derive(Deserialize)]
pub struct TaskChange {
    done: Option<bool>,
    /// Some("") clears the date
    due: Option<String>,
    time: Option<String>,
    priority: Option<i8>,
    text: Option<String>,
}

/// Edit a task in its note: done / due date / time / priority / text. Returns the updated task.
#[tauri::command]
pub async fn task_update(path: String, line: usize, raw: String, change: TaskChange) -> Result<Task, String> {
    let root = vault().await?;
    let full = resolve(&root, &path)?;
    let mut t = parse(&raw).ok_or("это не задача")?;
    if let Some(d) = change.done {
        t.done = d;
        t.done_date = d.then(|| Local::now().format("%Y-%m-%d").to_string());
    }
    if let Some(d) = change.due {
        t.due = (!d.is_empty()).then_some(d);
        if t.due.is_none() {
            t.time = None;
        }
    }
    if let Some(tm) = change.time {
        t.time = (!tm.is_empty()).then_some(tm);
    }
    if let Some(p) = change.priority {
        t.priority = p.clamp(-1, 3);
    }
    if let Some(text) = change.text.filter(|s| !s.trim().is_empty()) {
        t.text = text.trim().to_string();
    }
    let new = render(&raw, &t);
    edit_line(&full, line, &raw, &new)?;
    let mut out = parse(&new).ok_or("не удалось разобрать задачу")?;
    out.path = path;
    out.line = line;
    Ok(out)
}

/// Removes a task's line from its note. `raw` must still be what is on that line, so a note edited
/// elsewhere never loses the wrong line.
#[tauri::command]
pub async fn task_delete(path: String, line: usize, raw: String) -> Result<(), String> {
    let root = vault().await?;
    let full = resolve(&root, &path)?;
    let text = fs::read_to_string(&full).map_err(err)?;
    let mut lines: Vec<&str> = text.split('\n').collect();
    let cur = lines.get(line.wrapping_sub(1)).map(|l| l.trim_end_matches('\r').trim_end()).ok_or("строки уже нет")?;
    if cur != raw.trim_end() {
        return Err("заметка изменилась — список задач обновлён, попробуйте ещё раз".into());
    }
    lines.remove(line - 1);
    fs::write(&full, lines.join("\n")).map_err(err)
}

/// The text of a new task line (also used by the "＋ Задача" dialog in a note).
#[tauri::command]
pub fn task_format(text: String, due: Option<String>, time: Option<String>, priority: Option<i8>, tags: Vec<String>) -> Result<String, String> {
    let text = text.trim().replace('\n', " ");
    if text.is_empty() {
        return Err("пустая задача".into());
    }
    let tags: String = tags.iter().map(|t| t.trim().trim_start_matches('#').replace(' ', "-")).filter(|t| !t.is_empty()).map(|t| format!(" #{t}")).collect();
    let due = due.filter(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").is_ok());
    // "9:5" → "09:05"
    let time = time.and_then(|t| NaiveTime::parse_from_str(&t, "%H:%M").ok()).map(|t| t.format("%H:%M").to_string());
    Ok(format!("- [ ] {text}{tags}{}", markers(due.as_deref(), time.as_deref(), priority.unwrap_or(0), None)))
}

/// Append a task line to a note (default: "Задачи.md" in the vault root). Returns the note path.
#[tauri::command]
pub async fn task_add(path: Option<String>, line: String) -> Result<String, String> {
    let root = vault().await?;
    let path = path.filter(|p| !p.is_empty()).unwrap_or_else(|| "Задачи.md".into());
    let full = resolve(&root, &path)?;
    let mut text = fs::read_to_string(&full).unwrap_or_else(|_| "# Задачи\n\n".into());
    if !text.ends_with('\n') && !text.is_empty() {
        text.push('\n');
    }
    text.push_str(line.trim_end());
    text.push('\n');
    if let Some(dir) = full.parent() {
        fs::create_dir_all(dir).map_err(err)?;
    }
    fs::write(&full, text).map_err(err)?;
    Ok(path)
}

// ---------- reminders ----------

const FIRED: &str = "reminders_fired.json";
static SNOOZED: Mutex<Option<HashMap<String, NaiveDateTime>>> = Mutex::new(None);

fn key(t: &Task) -> String {
    format!("{}|{}|{} {}", t.path, t.text, t.due.as_deref().unwrap_or(""), t.time.as_deref().unwrap_or(""))
}

#[derive(Serialize, Clone)]
struct Reminder {
    key: String,
    task: Task,
}

/// Show the reminder again in `minutes`.
#[tauri::command]
pub fn task_snooze(key: String, minutes: u32) {
    let until = Local::now().naive_local() + chrono::Duration::minutes(i64::from(minutes.clamp(1, 24 * 60)));
    SNOOZED.lock().unwrap().get_or_insert_with(HashMap::new).insert(key, until);
}

/// Every 30 s: tasks with ⏰ whose time has come pop up once (system notification + in-app card
/// with "done / snooze"); once a day after 9:00 a summary of what is due today.
pub fn spawn_reminders(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut fired: Vec<String> = store::load_json(FIRED).unwrap_or_default();
        let mut tick = tokio::time::interval(Duration::from_secs(30));
        loop {
            tick.tick().await;
            let Ok(root) = vault().await else { continue };
            let Ok(tasks) = tauri::async_runtime::spawn_blocking(move || scan(&root)).await else { continue };
            let now = Local::now().naive_local();
            let today = now.date().format("%Y-%m-%d").to_string();
            let mut changed = false;
            for t in tasks.iter().filter(|t| !t.done) {
                let (Some(d), Some(tm)) = (&t.due, &t.time) else { continue };
                let Ok(at) = NaiveDateTime::parse_from_str(&format!("{d} {tm}"), "%Y-%m-%d %H:%M") else { continue };
                let k = key(t);
                let snoozed_until = SNOOZED.lock().unwrap().as_ref().and_then(|m| m.get(&k).copied());
                let due_now = match snoozed_until {
                    Some(u) => now >= u,
                    // missed while OpsDeck was closed: still remind if less than 12 h late
                    None => now >= at && now - at < chrono::Duration::hours(12) && !fired.contains(&k),
                };
                if !due_now {
                    continue;
                }
                if snoozed_until.is_some() {
                    SNOOZED.lock().unwrap().as_mut().map(|m| m.remove(&k));
                }
                if !fired.contains(&k) {
                    fired.push(k.clone());
                    changed = true;
                }
                let _ = app.notification().builder().title(format!("⏰ {}", t.text)).body(format!("{} · {}", tm, t.path.trim_end_matches(".md"))).show();
                let _ = app.emit("task-reminder", Reminder { key: k, task: t.clone() });
            }
            // morning summary
            let digest = format!("digest|{today}");
            if now.time() >= NaiveTime::from_hms_opt(9, 0, 0).unwrap() && !fired.contains(&digest) {
                let due_today: Vec<&Task> = tasks.iter().filter(|t| !t.done && t.due.as_deref() == Some(&today)).collect();
                let overdue = tasks.iter().filter(|t| !t.done && t.due.as_deref().is_some_and(|d| d < today.as_str())).count();
                if !due_today.is_empty() || overdue > 0 {
                    let mut body: Vec<String> = due_today.iter().take(5).map(|t| format!("• {}", t.text)).collect();
                    if overdue > 0 {
                        body.push(crate::i18n::tr("просрочено: {}", &[&overdue.to_string()]));
                    }
                    let _ = app.notification().builder().title(crate::i18n::tr("📋 Задачи на сегодня: {}", &[&due_today.len().to_string()])).body(body.join("\n")).show();
                }
                fired.push(digest);
                changed = true;
            }
            if changed {
                if fired.len() > 1000 {
                    fired.drain(..fired.len() - 1000);
                }
                let _ = store::save_json(FIRED, &fired);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deleting removes exactly that line, and only while the line is still the task it was.
    #[tokio::test]
    async fn delete_takes_the_right_line() {
        let _guard = crate::store::SETTINGS_TEST_LOCK.lock();
        let dir = std::env::temp_dir().join(format!("opsdeck-task-del-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        crate::store::save_json(
            "settings.json",
            &crate::settings::Settings { obsidian_vault: dir.to_string_lossy().into_owned(), ..Default::default() },
        )
        .unwrap();
        let note = dir.join("Задачи.md");
        std::fs::write(&note, "# Задачи\n\n- [ ] первая\n- [ ] вторая\n- [ ] третья\n").unwrap();

        assert!(task_delete("Задачи.md".into(), 4, "- [ ] вторая".into()).await.is_ok());
        assert_eq!(std::fs::read_to_string(&note).unwrap(), "# Задачи\n\n- [ ] первая\n- [ ] третья\n");
        // the line is no longer what the UI saw: nothing is removed
        let e = task_delete("Задачи.md".into(), 4, "- [ ] вторая".into()).await.unwrap_err();
        assert!(e.contains("заметка изменилась"), "{e}");
        assert!(task_delete("../outside.md".into(), 1, "- [ ] x".into()).await.is_err());
        assert_eq!(std::fs::read_to_string(&note).unwrap(), "# Задачи\n\n- [ ] первая\n- [ ] третья\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parse_and_render() {
        let t = parse("  - [ ] Обновить сертификат ⏫ 📅 2026-10-05 ⏰ 10:00 #infra").unwrap();
        assert_eq!(t.text, "Обновить сертификат #infra");
        assert_eq!(t.due.as_deref(), Some("2026-10-05"));
        assert_eq!(t.time.as_deref(), Some("10:00"));
        assert_eq!(t.priority, 2);
        assert_eq!(t.tags, vec!["infra"]);
        let mut d = t.clone();
        d.done = true;
        d.done_date = Some("2026-10-04".into());
        assert_eq!(render(&t.raw, &d), "  - [x] Обновить сертификат #infra ⏫ 📅 2026-10-05 ⏰ 10:00 ✅ 2026-10-04");
        assert!(parse("- [-] cancelled").is_none());
        assert!(parse("- обычный пункт").is_none());
        assert!(parse("* [x] готово ✅ 2026-01-01").unwrap().done);
    }

    #[test]
    fn format_new() {
        let l = task_format("Позвонить".into(), Some("2026-10-05".into()), Some("9:5".into()), Some(1), vec!["#дом".into(), "срочно".into()]).unwrap();
        assert_eq!(l, "- [ ] Позвонить #дом #срочно 🔼 📅 2026-10-05 ⏰ 09:05");
    }
}
