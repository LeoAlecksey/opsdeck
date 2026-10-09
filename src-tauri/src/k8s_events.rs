//! Kubernetes event history (#55, the idea from rubick): Kubernetes keeps events about an hour, so
//! "what fell over at night" is gone by morning. For the clusters the user turns it on for, OpsDeck
//! watches Events of all namespaces while it runs and keeps them for a week, a repeat folded into
//! one row (×N, first and last time). Stored next to the settings, one file per cluster.

use crate::{
    k8s::{client, Ctx, K8sState},
    store,
};
use futures::StreamExt;
use k8s_openapi::api::core::v1::Event;
use kube::{
    runtime::{watcher, WatchStreamExt},
    Api,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, State};
use tokio::sync::oneshot;

const CONFIG: &str = "k8s-events.json";
const KEEP: Duration = Duration::from_secs(7 * 24 * 3600);
const MAX_ROWS: usize = 20_000;

#[derive(Serialize, Deserialize, Default, Clone)]
struct Config {
    /// (kubeconfig file, context) the history is recorded for
    enabled: Vec<(String, String)>,
}

type Key = (String, String);

#[derive(Default)]
pub struct EventsState {
    running: Mutex<HashMap<Key, oneshot::Sender<()>>>,
    rows: Mutex<HashMap<Key, Vec<Value>>>,
    dirty: Mutex<std::collections::HashSet<Key>>,
}

fn config() -> Config {
    store::load_json(CONFIG).unwrap_or_default()
}

fn file_of(key: &Key) -> Result<PathBuf, String> {
    let dir = store::config_dir()?.join("k8s-events");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // stable and filesystem-safe: the context name plus a hash of the kubeconfig path
    let mut h: u64 = 0xcbf29ce484222325;
    for b in key.0.bytes() {
        h = (h ^ u64::from(b)).wrapping_mul(0x100000001b3);
    }
    let name: String = key.1.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') { c } else { '_' }).take(60).collect();
    Ok(dir.join(format!("{name}-{h:016x}.json")))
}

fn now() -> SystemTime {
    SystemTime::now()
}

/// Seconds since the epoch of an RFC 3339 time ("" → 0).
fn secs(t: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(t).map(|d| d.timestamp()).unwrap_or(0)
}

/// The row kept for an event: the fields the event table shows, in the Event's own shape.
pub fn row_of(e: &Event) -> Option<Value> {
    let uid = e.metadata.uid.clone()?;
    let last = e
        .last_timestamp
        .as_ref()
        .map(|t| t.0.to_string())
        .or_else(|| e.event_time.as_ref().map(|t| t.0.to_string()))
        .or_else(|| e.metadata.creation_timestamp.as_ref().map(|t| t.0.to_string()))
        .unwrap_or_default();
    let first = e.first_timestamp.as_ref().map(|t| t.0.to_string()).unwrap_or_else(|| last.clone());
    Some(json!({
        "metadata": { "uid": uid, "name": e.metadata.name, "namespace": e.metadata.namespace, "creationTimestamp": first },
        "type": e.type_,
        "reason": e.reason,
        "message": e.message,
        "count": e.count.unwrap_or(1),
        "firstTimestamp": first,
        "lastTimestamp": last,
        "involvedObject": { "kind": e.involved_object.kind, "name": e.involved_object.name, "namespace": e.involved_object.namespace },
    }))
}

/// Adds or updates a row (same uid: the event repeated); keeps the week and at most MAX_ROWS.
pub fn upsert(rows: &mut Vec<Value>, row: Value, now_secs: i64) {
    upsert_max(rows, row, now_secs, MAX_ROWS)
}

fn upsert_max(rows: &mut Vec<Value>, row: Value, now_secs: i64, max: usize) {
    let uid = row["metadata"]["uid"].clone();
    match rows.iter_mut().find(|r| r["metadata"]["uid"] == uid) {
        Some(r) => *r = row,
        None => rows.push(row),
    }
    let oldest = now_secs - KEEP.as_secs() as i64;
    rows.retain(|r| secs(r["lastTimestamp"].as_str().unwrap_or("")) >= oldest);
    if rows.len() > max {
        rows.sort_by_key(|r| secs(r["lastTimestamp"].as_str().unwrap_or("")));
        let extra = rows.len() - max;
        rows.drain(..extra);
    }
}

fn load_rows(key: &Key) -> Vec<Value> {
    file_of(key).ok().and_then(|f| std::fs::read_to_string(f).ok()).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn save_rows(app: &AppHandle) {
    let st = app.state::<EventsState>();
    let keys: Vec<Key> = st.dirty.lock().unwrap().drain().collect();
    for key in keys {
        let rows = st.rows.lock().unwrap().get(&key).cloned().unwrap_or_default();
        if let Ok(f) = file_of(&key) {
            let _ = std::fs::write(f, serde_json::to_vec(&rows).unwrap_or_default());
        }
    }
}

fn start(app: &AppHandle, key: Key) {
    let st = app.state::<EventsState>();
    if st.running.lock().unwrap().contains_key(&key) {
        return;
    }
    st.rows.lock().unwrap().entry(key.clone()).or_insert_with(|| load_rows(&key));
    let (tx, mut stop) = oneshot::channel();
    st.running.lock().unwrap().insert(key.clone(), tx);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let ctx = Ctx { file: key.0.clone(), context: key.1.clone() };
        // the cluster may be unreachable now (VPN off): try again every minute until stopped
        let api: Api<Event> = loop {
            match client(&app.state::<K8sState>(), &ctx).await {
                Ok(c) => break Api::all(c),
                Err(e) => {
                    log::warn!("k8s event history {}: {e}", key.1);
                    tokio::select! { _ = &mut stop => return, _ = tokio::time::sleep(Duration::from_secs(60)) => {} }
                }
            }
        };
        let mut stream = watcher(api, watcher::Config::default()).default_backoff().boxed();
        loop {
            tokio::select! {
                _ = &mut stop => break,
                ev = stream.next() => match ev {
                    None => break,
                    Some(Ok(watcher::Event::Apply(e) | watcher::Event::InitApply(e))) => {
                        if let Some(row) = row_of(&e) {
                            let st = app.state::<EventsState>();
                            let t = now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
                            upsert(st.rows.lock().unwrap().entry(key.clone()).or_default(), row, t);
                            st.dirty.lock().unwrap().insert(key.clone());
                        }
                    }
                    // deleted from the cluster (its hour is over): exactly what the history keeps
                    Some(Ok(_)) => {}
                    Some(Err(e)) => log::debug!("k8s event history {}: {e}", key.1),
                }
            }
        }
    });
}

fn stop(app: &AppHandle, key: &Key) {
    if let Some(tx) = app.state::<EventsState>().running.lock().unwrap().remove(key) {
        let _ = tx.send(());
    }
}

/// At startup: recorders for the clusters it is on for, and saving every 30 s.
pub fn spawn(app: AppHandle) {
    for key in config().enabled {
        start(&app, key);
    }
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;
            save_rows(&app);
        }
    });
}

/// Before exit: what came in since the last save.
pub fn flush(app: &AppHandle) {
    save_rows(app);
}

#[derive(Serialize)]
pub struct History {
    enabled: bool,
    rows: Vec<Value>,
}

/// The history of a cluster, newest first; `warnings`: only Warning events.
#[tauri::command]
pub fn k8s_history(state: State<EventsState>, ctx: Ctx, warnings: bool) -> History {
    let key = (ctx.file, ctx.context);
    let enabled = config().enabled.contains(&key);
    let mut rows = state.rows.lock().unwrap().get(&key).cloned().unwrap_or_else(|| load_rows(&key));
    if warnings {
        rows.retain(|r| r["type"] == "Warning");
    }
    rows.sort_by_key(|r| std::cmp::Reverse(secs(r["lastTimestamp"].as_str().unwrap_or(""))));
    rows.truncate(5000);
    History { enabled, rows }
}

#[tauri::command]
pub fn k8s_history_set(app: AppHandle, ctx: Ctx, on: bool) -> Result<(), String> {
    let key = (ctx.file, ctx.context);
    let mut cfg = config();
    cfg.enabled.retain(|k| *k != key);
    if on {
        cfg.enabled.push(key.clone());
        start(&app, key);
    } else {
        stop(&app, &key);
    }
    store::save_json(CONFIG, &cfg)
}

/// Forgets the recorded events of a cluster (recording, if on, goes on).
#[tauri::command]
pub fn k8s_history_clear(app: AppHandle, ctx: Ctx) -> Result<(), String> {
    let key = (ctx.file, ctx.context);
    app.state::<EventsState>().rows.lock().unwrap().insert(key.clone(), Vec::new());
    let f = file_of(&key)?;
    if f.exists() {
        std::fs::remove_file(f).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::{
        api::core::v1::ObjectReference,
        apimachinery::pkg::apis::meta::v1::{ObjectMeta, Time},
        jiff::Timestamp,
    };

    fn event(uid: &str, reason: &str, count: i32, at: i64) -> Event {
        Event {
            metadata: ObjectMeta { uid: Some(uid.into()), name: Some(format!("x.{uid}")), namespace: Some("shop".into()), ..Default::default() },
            type_: Some("Warning".into()),
            reason: Some(reason.into()),
            message: Some("Back-off restarting failed container".into()),
            count: Some(count),
            first_timestamp: Some(Time(Timestamp::from_second(at - 600).unwrap())),
            last_timestamp: Some(Time(Timestamp::from_second(at).unwrap())),
            involved_object: ObjectReference { kind: Some("Pod".into()), name: Some("worker-1".into()), namespace: Some("shop".into()), ..Default::default() },
            ..Default::default()
        }
    }

    #[test]
    fn repeats_fold_and_old_ones_go() {
        let now = 1_791_400_000;
        let mut rows = Vec::new();
        upsert(&mut rows, row_of(&event("a", "BackOff", 1, now - 100)).unwrap(), now);
        upsert(&mut rows, row_of(&event("b", "OOMKilling", 1, now - 50)).unwrap(), now);
        // the same event again, with a bigger count
        upsert(&mut rows, row_of(&event("a", "BackOff", 7, now - 10)).unwrap(), now);
        assert_eq!(rows.len(), 2);
        let a = rows.iter().find(|r| r["metadata"]["uid"] == "a").unwrap();
        assert_eq!((a["count"].as_i64(), a["involvedObject"]["name"].as_str()), (Some(7), Some("worker-1")));
        assert!(secs(a["firstTimestamp"].as_str().unwrap()) < secs(a["lastTimestamp"].as_str().unwrap()));
        // a week and a day later the first ones are gone
        let later = now + 8 * 24 * 3600;
        upsert(&mut rows, row_of(&event("c", "FailedScheduling", 1, later)).unwrap(), later);
        assert_eq!(rows.iter().map(|r| r["reason"].as_str().unwrap()).collect::<Vec<_>>(), ["FailedScheduling"]);
        assert!(row_of(&Event::default()).is_none(), "no uid — nothing to fold repeats by");
    }

    #[test]
    fn bounded() {
        let mut rows = Vec::new();
        let now = 1_791_400_000;
        for i in 0..150 {
            upsert_max(&mut rows, row_of(&event(&format!("e{i}"), "BackOff", 1, now - 1000 + i)).unwrap(), now, 100);
        }
        assert_eq!(rows.len(), 100);
        assert!(rows.iter().all(|r| r["metadata"]["uid"].as_str().unwrap()[1..].parse::<i64>().unwrap() >= 50), "the oldest go first");
    }

    #[test]
    fn file_names_are_safe() {
        let f = file_of(&("/home/u/.kube/a config".into(), "arn:aws:eks:eu/prod".into())).unwrap();
        let name = f.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with("arn_aws_eks_eu_prod-") && name.ends_with(".json"), "{name}");
        assert_ne!(f, file_of(&("/other".into(), "arn:aws:eks:eu/prod".into())).unwrap(), "same context name, other file");
    }
}
