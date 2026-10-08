//! The local AI as a chat in the terminal's AI panel (next to Claude Code, Codex…): the built-in
//! llama-server or the external OpenAI-compatible server from Settings, answers streamed as they
//! are generated. Commands in the answer are only suggested — the UI inserts one into the terminal
//! on a click, nothing runs by itself.

use crate::{
    ai::{self, AiProvider},
    settings,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::oneshot;

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
pub struct ChatMsg {
    pub role: String,
    pub content: String,
}

#[derive(Default)]
pub struct ChatState {
    running: Mutex<HashMap<String, oneshot::Sender<()>>>,
}

#[derive(Serialize, Clone)]
struct Delta {
    text: String,
}

#[derive(Serialize, Clone)]
struct Done {
    error: Option<String>,
    elapsed_ms: u64,
}

const SYSTEM: &str = "Ты — помощник DevOps-инженера, встроенный в терминал OpsDeck. Отвечай кратко и по делу, на языке пользователя. \
Команды давай в блоках ```bash (или ```powershell на Windows) — пользователь вставит их в терминал кнопкой; не утверждай, что выполнил что-то сам. \
Перед опасными командами (удаление, перезапуск, изменения в проде) предупреждай. Если не уверен — скажи, что проверить.";

/// The conversation as sent to the model: system prompt with the terminal's context, then the
/// last turns (small local models have a short context window).
pub fn build_messages(history: &[ChatMsg], cwd: Option<&str>, shell: Option<&str>, os: &str) -> Vec<ChatMsg> {
    let mut system = SYSTEM.to_string();
    system += &format!("\nОС: {os}.");
    if let Some(s) = shell.filter(|s| !s.is_empty()) {
        system += &format!(" Shell: {s}.");
    }
    if let Some(c) = cwd.filter(|c| !c.is_empty()) {
        system += &format!(" Текущая папка терминала: {c}.");
    }
    let mut out = vec![ChatMsg { role: "system".into(), content: system }];
    let turns: Vec<&ChatMsg> = history.iter().filter(|m| m.role == "user" || m.role == "assistant").collect();
    out.extend(turns[turns.len().saturating_sub(20)..].iter().map(|m| (*m).clone()));
    out
}

/// Text pieces of an OpenAI-style SSE stream; `buf` keeps an unfinished line between chunks.
pub fn sse_deltas(buf: &mut String, chunk: &str) -> (Vec<String>, bool) {
    buf.push_str(chunk);
    let mut out = Vec::new();
    let mut done = false;
    while let Some(i) = buf.find('\n') {
        let line: String = buf.drain(..=i).collect();
        let line = line.trim();
        let Some(data) = line.strip_prefix("data:") else { continue };
        let data = data.trim();
        if data == "[DONE]" {
            done = true;
            continue;
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(data) {
            if let Some(t) = v["choices"][0]["delta"]["content"].as_str().filter(|t| !t.is_empty()) {
                out.push(t.to_string());
            }
        }
    }
    (out, done)
}

#[tauri::command]
pub async fn ai_chat(app: AppHandle, state: State<'_, ChatState>, id: String, messages: Vec<ChatMsg>, cwd: Option<String>, shell: Option<String>) -> Result<(), String> {
    let provider = ai::provider_for(&settings::current().await);
    let (base, model, key) = match &provider {
        AiProvider::Local => (format!("http://127.0.0.1:{}", ai::ensure_server(&app).await?), None, String::new()),
        AiProvider::Remote { base, model, api_key } => (base.clone(), Some(model.clone()), api_key.clone()),
    };
    let mut body = serde_json::json!({
        "messages": build_messages(&messages, cwd.as_deref(), shell.as_deref(), std::env::consts::OS),
        "temperature": 0.3,
        "max_tokens": 1500,
        "stream": true
    });
    match &model {
        Some(m) => body["model"] = serde_json::json!(m),
        // our own Qwen: answer, don't think aloud (an external server may not know this field)
        None => body["chat_template_kwargs"] = serde_json::json!({ "enable_thinking": false }),
    }
    let mut req = reqwest::Client::new().post(format!("{base}/v1/chat/completions")).timeout(Duration::from_secs(600)).json(&body);
    if !key.is_empty() {
        req = req.bearer_auth(&key);
    }
    let (tx, mut rx) = oneshot::channel();
    state.running.lock().unwrap().insert(id.clone(), tx);
    let local = matches!(provider, AiProvider::Local);
    tauri::async_runtime::spawn(async move {
        let started = Instant::now();
        let ev = format!("ai-chat-{id}");
        let result: Result<(), String> = async {
            let mut resp = tokio::select! {
                r = req.send() => r.map_err(|e| if local { format!("локальный ИИ не ответил: {e}") } else { format!("сервер ИИ не ответил: {e}") })?,
                _ = &mut rx => return Ok(()),
            };
            if !resp.status().is_success() {
                let code = resp.status().as_u16();
                let text = resp.text().await.unwrap_or_default();
                return Err(format!("HTTP {code}: {}", text.chars().take(300).collect::<String>()));
            }
            let mut buf = String::new();
            loop {
                let chunk = tokio::select! {
                    c = resp.chunk() => c.map_err(|e| e.to_string())?,
                    _ = &mut rx => return Ok(()), // stopped by the user
                };
                let Some(chunk) = chunk else { break };
                let (deltas, done) = sse_deltas(&mut buf, &String::from_utf8_lossy(&chunk));
                for text in deltas {
                    let _ = app.emit(&ev, Delta { text });
                }
                if local {
                    ai::touch(&app);
                }
                if done {
                    break;
                }
            }
            Ok(())
        }
        .await;
        app.state::<ChatState>().running.lock().unwrap().remove(&id);
        let _ = app.emit(&format!("ai-chat-done-{id}"), Done { error: result.err(), elapsed_ms: started.elapsed().as_millis() as u64 });
    });
    Ok(())
}

#[tauri::command]
pub fn ai_chat_stop(state: State<ChatState>, id: String) {
    if let Some(tx) = state.running.lock().unwrap().remove(&id) {
        let _ = tx.send(());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(role: &str, content: &str) -> ChatMsg {
        ChatMsg { role: role.into(), content: content.into() }
    }

    #[test]
    fn stream_pieces() {
        let mut buf = String::new();
        let (a, done) = sse_deltas(&mut buf, "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"kub\"}}]}\n\ndata: {\"choi");
        assert_eq!((a, done), (vec!["kub".to_string()], false));
        let (b, done) = sse_deltas(&mut buf, "ces\":[{\"delta\":{\"content\":\"ectl\"}}]}\n\ndata: [DONE]\n\n");
        assert_eq!((b, done), (vec!["ectl".to_string()], true));
        assert!(buf.is_empty());
        // keep-alive comments and junk are ignored
        assert_eq!(sse_deltas(&mut String::new(), ": ping\n\ndata: not json\n\n"), (vec![], false));
    }

    #[test]
    fn conversation_for_the_model() {
        let mut history = vec![m("system", "injected"), m("user", "hi"), m("assistant", "hello")];
        let out = build_messages(&history, Some("/srv/app"), Some("bash"), "linux");
        assert_eq!(out[0].role, "system");
        assert!(out[0].content.contains("/srv/app") && out[0].content.contains("bash") && out[0].content.contains("linux"));
        assert_eq!(out[1..], [m("user", "hi"), m("assistant", "hello")], "a system message from the UI is dropped");
        for i in 0..40 {
            history.push(m("user", &format!("q{i}")));
        }
        let out = build_messages(&history, None, None, "linux");
        assert_eq!(out.len(), 21, "system + the last 20 turns");
        assert_eq!(out.last().unwrap().content, "q39");
    }
}
