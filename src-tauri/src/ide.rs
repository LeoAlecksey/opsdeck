//! Claude Code IDE bridge. OpsDeck advertises itself the way editor extensions do:
//! a lock file `~/.claude/ide/<port>.lock` (workspaceFolders, authToken, transport "ws") and an
//! MCP server over WebSocket on 127.0.0.1:<port>. `claude` started inside OpsDeck gets
//! CLAUDE_CODE_SSE_PORT and connects on its own; it then sees note selections / @-mentions and
//! can ask OpsDeck to open a note.

use crate::store::err;
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    sync::{Mutex, OnceLock},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{net::TcpListener, sync::mpsc};
use tokio_tungstenite::{
    accept_hdr_async,
    tungstenite::{
        handshake::server::{ErrorResponse, Request, Response},
        http, Message,
    },
};

static PORT: OnceLock<u16> = OnceLock::new();

pub fn port() -> Option<u16> {
    PORT.get().copied()
}

pub struct IdeState {
    token: String,
    clients: Mutex<Vec<mpsc::UnboundedSender<String>>>,
    selection: Mutex<Option<Value>>,
    editor: Mutex<Option<Value>>,
    lock_path: Mutex<Option<PathBuf>>,
}

impl Default for IdeState {
    fn default() -> Self {
        Self {
            token: uuid::Uuid::new_v4().to_string(),
            clients: Mutex::default(),
            selection: Mutex::default(),
            editor: Mutex::default(),
            lock_path: Mutex::default(),
        }
    }
}

fn lock_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("ide"))
}

#[cfg(target_os = "linux")]
fn process_alive(pid: u64) -> bool {
    PathBuf::from(format!("/proc/{pid}")).exists()
}

/// Without /proc we can't tell cheaply: keep the file (claude also checks the port is open).
#[cfg(not(target_os = "linux"))]
fn process_alive(_pid: u64) -> bool {
    true
}

/// Drop lock files left by previous OpsDeck runs that crashed.
fn remove_stale_locks(dir: &std::path::Path) {
    for e in fs::read_dir(dir).into_iter().flatten().flatten() {
        let p = e.path();
        let Ok(v) = fs::read_to_string(&p).map(|s| serde_json::from_str::<Value>(&s).unwrap_or_default()) else { continue };
        let pid = v["pid"].as_u64().unwrap_or(0);
        if v["ideName"] == "OpsDeck" && !process_alive(pid) {
            let _ = fs::remove_file(p);
        }
    }
}

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let listener = match TcpListener::bind("127.0.0.1:0").await {
            Ok(l) => l,
            Err(e) => {
                log::error!("ide bridge: {e}");
                return;
            }
        };
        let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
        let _ = PORT.set(port);
        if let Err(e) = write_lock(&app, port) {
            log::warn!("ide bridge lock file: {e}");
        }
        while let Ok((stream, _)) = listener.accept().await {
            let app = app.clone();
            tauri::async_runtime::spawn(async move { connection(app, stream).await });
        }
    });
}

fn write_lock(app: &AppHandle, port: u16) -> Result<(), String> {
    let dir = lock_dir().ok_or("no home dir")?;
    fs::create_dir_all(&dir).map_err(err)?;
    remove_stale_locks(&dir);
    let home = dirs::home_dir().unwrap_or_default().to_string_lossy().into_owned();
    let state = app.state::<IdeState>();
    let lock = json!({
        "pid": std::process::id(),
        "workspaceFolders": [home],
        "ideName": "OpsDeck",
        "transport": "ws",
        "authToken": state.token,
    });
    let path = dir.join(format!("{port}.lock"));
    fs::write(&path, lock.to_string()).map_err(err)?;
    crate::store::restrict(&path, 0o600)?;
    *state.lock_path.lock().unwrap() = Some(path);
    Ok(())
}

pub fn cleanup(app: &AppHandle) {
    if let Some(p) = app.state::<IdeState>().lock_path.lock().unwrap().take() {
        let _ = fs::remove_file(p);
    }
}

// the handshake callback type is tungstenite's: its error is a whole HTTP response
#[allow(clippy::result_large_err)]
async fn connection(app: AppHandle, stream: tokio::net::TcpStream) {
    let token = app.state::<IdeState>().token.clone();
    // only the CLI with the token from the lock file; browsers always send Origin
    let check = move |req: &Request, mut resp: Response| -> Result<Response, ErrorResponse> {
        let h = req.headers();
        let authed = h
            .get("x-claude-code-ide-authorization")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|t| crate::store::ct_eq(t, &token));
        if authed && h.get("origin").is_none() {
            // claude opens the socket with subprotocol "mcp" and drops it if the server doesn't echo it
            let wants_mcp = h
                .get("sec-websocket-protocol")
                .and_then(|v| v.to_str().ok())
                .is_some_and(|p| p.split(',').any(|x| x.trim() == "mcp"));
            if wants_mcp {
                resp.headers_mut().insert("sec-websocket-protocol", http::HeaderValue::from_static("mcp"));
            }
            Ok(resp)
        } else {
            Err(http::Response::builder().status(401).body(None).unwrap())
        }
    };
    let Ok(ws) = accept_hdr_async(stream, check).await else { return };
    let (mut sink, mut source) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    app.state::<IdeState>().clients.lock().unwrap().push(tx.clone());
    emit_status(&app);

    let writer = tauri::async_runtime::spawn(async move {
        while let Some(m) = rx.recv().await {
            if sink.send(Message::Text(m.into())).await.is_err() {
                break;
            }
        }
    });
    while let Some(Ok(msg)) = source.next().await {
        match msg {
            Message::Text(t) => {
                let Ok(v) = serde_json::from_str::<Value>(&t) else { continue };
                if let Some(reply) = handle(&app, &v) {
                    let _ = tx.send(reply.to_string());
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
    drop(tx);
    writer.abort();
    app.state::<IdeState>().clients.lock().unwrap().retain(|c| !c.is_closed());
    emit_status(&app);
}

fn clients(app: &AppHandle) -> usize {
    let state = app.state::<IdeState>();
    let mut c = state.clients.lock().unwrap();
    c.retain(|c| !c.is_closed());
    c.len()
}

fn emit_status(app: &AppHandle) {
    let _ = app.emit("ide-status", clients(app));
}

fn broadcast(state: &IdeState, method: &str, params: Value) {
    let msg = json!({ "jsonrpc": "2.0", "method": method, "params": params }).to_string();
    state.clients.lock().unwrap().retain(|c| c.send(msg.clone()).is_ok());
}

fn handle(app: &AppHandle, msg: &Value) -> Option<Value> {
    let method = msg["method"].as_str()?; // replies from the client are ignored
    let result: Result<Value, (i64, String)> = match method {
        "initialize" => Ok(json!({
            "protocolVersion": msg["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
            "capabilities": { "tools": { "listChanged": false } },
            "serverInfo": { "name": "opsdeck", "version": env!("CARGO_PKG_VERSION") },
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tools() })),
        "tools/call" => call_tool(app, &msg["params"]),
        m if m.starts_with("notifications/") => return None,
        _ => Err((-32601, format!("method not found: {method}"))),
    };
    let id = msg.get("id")?.clone();
    Some(match result {
        Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
        Err((code, message)) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }),
    })
}

fn tools() -> Value {
    let obj = |props: Value, required: &[&str]| json!({ "type": "object", "properties": props, "required": required });
    let path = json!({ "filePath": { "type": "string" } });
    json!([
        { "name": "getWorkspaceFolders", "description": "Get workspace folders", "inputSchema": obj(json!({}), &[]) },
        { "name": "getOpenEditors", "description": "Get the note open in OpsDeck", "inputSchema": obj(json!({}), &[]) },
        { "name": "getCurrentSelection", "description": "Get the current text selection in OpsDeck", "inputSchema": obj(json!({}), &[]) },
        { "name": "getLatestSelection", "description": "Get the most recent text selection in OpsDeck", "inputSchema": obj(json!({}), &[]) },
        { "name": "openFile", "description": "Open a note (file inside the Obsidian vault) in OpsDeck",
          "inputSchema": obj(json!({ "filePath": { "type": "string" }, "preview": { "type": "boolean" },
            "startText": { "type": "string" }, "endText": { "type": "string" }, "makeFrontmost": { "type": "boolean" } }), &["filePath"]) },
        { "name": "getDiagnostics", "description": "Get diagnostics (none in OpsDeck)", "inputSchema": obj(json!({ "uri": { "type": "string" } }), &[]) },
        { "name": "checkDocumentDirty", "description": "Check if a document has unsaved changes", "inputSchema": obj(path.clone(), &["filePath"]) },
        { "name": "saveDocument", "description": "Save a document", "inputSchema": obj(path, &["filePath"]) },
        { "name": "close_tab", "description": "Close a tab", "inputSchema": obj(json!({ "tab_name": { "type": "string" } }), &["tab_name"]) },
        { "name": "closeAllDiffTabs", "description": "Close all diff tabs", "inputSchema": obj(json!({}), &[]) },
    ])
}

fn text(v: impl Into<String>) -> Value {
    json!({ "content": [{ "type": "text", "text": v.into() }] })
}

fn call_tool(app: &AppHandle, params: &Value) -> Result<Value, (i64, String)> {
    let state = app.state::<IdeState>();
    let args = &params["arguments"];
    let home = dirs::home_dir().unwrap_or_default().to_string_lossy().into_owned();
    Ok(match params["name"].as_str().unwrap_or_default() {
        "getWorkspaceFolders" => text(json!({
            "success": true,
            "folders": [{ "name": "home", "uri": format!("file://{home}"), "path": home }],
            "rootPath": home,
        }).to_string()),
        "getOpenEditors" => {
            let tabs: Vec<Value> = state.editor.lock().unwrap().iter().cloned().collect();
            text(json!({ "tabs": tabs }).to_string())
        }
        "getCurrentSelection" | "getLatestSelection" => match state.selection.lock().unwrap().clone() {
            Some(s) => text(json!({ "success": true, "text": s["text"], "filePath": s["filePath"], "selection": s["selection"] }).to_string()),
            None => text(json!({ "success": false, "message": "No active editor found" }).to_string()),
        },
        "openFile" => {
            let path = args["filePath"].as_str().unwrap_or_default().to_string();
            let _ = app.emit("ide-open-file", &path);
            text(format!("Opened file: {path}"))
        }
        "getDiagnostics" => text("[]"),
        "checkDocumentDirty" => text(json!({ "success": true, "filePath": args["filePath"], "isDirty": false, "isUntitled": false }).to_string()),
        "saveDocument" => text(json!({ "success": true, "filePath": args["filePath"], "saved": true, "message": "Document saved" }).to_string()),
        "close_tab" => text("TAB_CLOSED"),
        "closeAllDiffTabs" => text("CLOSED_0_DIFF_TABS"),
        other => return Err((-32602, format!("unknown tool: {other}"))),
    })
}

// ---------- commands from the UI ----------

/// Selection in a note: {text, filePath, fileUrl, selection:{start:{line,character}, end:{...}, isEmpty}}.
#[tauri::command]
pub fn ide_selection(state: State<IdeState>, selection: Value) {
    *state.selection.lock().unwrap() = Some(selection.clone());
    broadcast(&state, "selection_changed", selection);
}

/// The note currently open in the editor (or null).
#[tauri::command]
pub fn ide_editor(state: State<IdeState>, editor: Option<Value>) {
    *state.editor.lock().unwrap() = editor;
}

/// Puts `@file#Lx-y` into Claude's prompt.
#[tauri::command]
pub fn ide_at_mention(state: State<IdeState>, file_path: String, line_start: Option<u32>, line_end: Option<u32>) -> Result<(), String> {
    if state.clients.lock().unwrap().is_empty() {
        return Err("Claude Code не подключён: запустите claude в AI-панели или терминале OpsDeck".into());
    }
    broadcast(&state, "at_mentioned", json!({ "filePath": file_path, "lineStart": line_start, "lineEnd": line_end }));
    Ok(())
}

#[tauri::command]
pub fn ide_status(app: AppHandle) -> Value {
    json!({ "port": port(), "clients": clients(&app) })
}
