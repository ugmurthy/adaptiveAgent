use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, Receiver, Sender},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);

type Response = Result<Value, String>;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopState {
    status: &'static str,
    configuration_valid: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    configuration: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    active_run_id: Option<String>,
}

struct Bridge {
    app: AppHandle,
    child: Mutex<Option<CommandChild>>,
    pending: Mutex<HashMap<u64, Sender<Response>>>,
    next_id: AtomicU64,
    active: AtomicBool,
    stopping: AtomicBool,
    queued_stop: AtomicBool,
    expected_shutdown: AtomicBool,
    active_run_id: Mutex<Option<String>>,
    configuration: Mutex<Option<Value>>,
    initialization_error: Mutex<Option<String>>,
}

#[derive(Default)]
struct AppState {
    bridge: Mutex<Option<Arc<Bridge>>>,
}

impl Bridge {
    fn spawn(app: &AppHandle) -> Result<Arc<Self>, String> {
        let (mut events, child) = app
            .shell()
            .sidecar("agent-runtime")
            .map_err(|error| format!("Unable to locate the packaged agent runtime: {error}"))?
            .spawn()
            .map_err(|error| format!("Unable to start the agent runtime: {error}"))?;
        let bridge = Arc::new(Self {
            app: app.clone(),
            child: Mutex::new(Some(child)),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            active: AtomicBool::new(false),
            stopping: AtomicBool::new(false),
            queued_stop: AtomicBool::new(false),
            expected_shutdown: AtomicBool::new(false),
            active_run_id: Mutex::new(None),
            configuration: Mutex::new(None),
            initialization_error: Mutex::new(None),
        });
        let reader = bridge.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(event) = events.recv().await {
                match event {
                    CommandEvent::Stdout(bytes) => reader.handle_stdout(&bytes),
                    CommandEvent::Stderr(_) => {
                        // Sidecar diagnostics stay native and are deliberately not logged or sent to the webview.
                    }
                    CommandEvent::Error(_) => reader.transport_failed(),
                    CommandEvent::Terminated(_) => {
                        reader.transport_failed();
                        break;
                    }
                    _ => {}
                }
            }
            reader.transport_failed();
        });
        Ok(bridge)
    }

    fn initialize(&self) -> Result<(), String> {
        let negotiated = self.request_wait(
            "initialize",
            json!({ "protocolVersion": "1.11", "clientInfo": { "name": "adaptive-agent-desktop", "version": "0.1.0" } }),
            REQUEST_TIMEOUT,
        )?;
        if negotiated.get("protocolVersion").and_then(Value::as_str) != Some("1.11") {
            return Err("The sidecar did not negotiate desktop protocol 1.11.".into());
        }
        let initialized = self.request_wait(
            "runtime/initialize",
            json!({ "configurationDriven": true }),
            REQUEST_TIMEOUT,
        )?;
        let configuration = initialized
            .get("resolvedConfiguration")
            .cloned()
            .ok_or_else(|| "The sidecar did not return a safe resolved configuration.".to_string())?;
        *self.configuration.lock().unwrap() = Some(configuration);
        *self.initialization_error.lock().unwrap() = None;
        Ok(())
    }

    fn request(&self, method: &str, params: Value) -> Result<(u64, Receiver<Response>), String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = mpsc::channel();
        self.pending.lock().unwrap().insert(id, sender);
        let mut bytes = serde_json::to_vec(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
            .map_err(|error| error.to_string())?;
        bytes.push(b'\n');
        let write_result = self.child.lock().unwrap().as_mut()
            .ok_or_else(|| "The agent runtime is not running.".to_string())?
            .write(&bytes)
            .map_err(|_| "Unable to write to the agent runtime.".to_string());
        if write_result.is_err() {
            self.pending.lock().unwrap().remove(&id);
        }
        write_result.map(|_| (id, receiver))
    }

    fn request_wait(&self, method: &str, params: Value, timeout: Duration) -> Response {
        let (id, receiver) = self.request(method, params)?;
        receiver.recv_timeout(timeout).map_err(|_| {
            self.pending.lock().unwrap().remove(&id);
            format!("The agent runtime timed out while handling {method}.")
        })?
    }

    fn handle_stdout(self: &Arc<Self>, bytes: &[u8]) {
        let Ok(message) = serde_json::from_slice::<Value>(bytes) else { return };
        if message.get("method").and_then(Value::as_str) == Some("agent/event") {
            self.handle_agent_event(message.get("params").unwrap_or(&Value::Null));
            return;
        }
        let Some(id) = message.get("id").and_then(Value::as_u64) else { return };
        let Some(sender) = self.pending.lock().unwrap().remove(&id) else { return };
        let response = if let Some(error) = message.get("error") {
            Err(error.get("message").and_then(Value::as_str).unwrap_or("Agent runtime request failed.").to_string())
        } else {
            Ok(message.get("result").cloned().unwrap_or(Value::Null))
        };
        let _ = sender.send(response);
    }

    fn handle_agent_event(self: &Arc<Self>, event: &Value) {
        let Some(run_id) = event.get("runId").and_then(Value::as_str) else { return };
        let kind = event.get("type").and_then(Value::as_str).unwrap_or("run.progress");
        let root_created = is_root_run_created(event);
        if root_created {
            *self.active_run_id.lock().unwrap() = Some(run_id.to_string());
            self.emit_state();
            if self.queued_stop.swap(false, Ordering::SeqCst) {
                let bridge = self.clone();
                let run_id = run_id.to_string();
                std::thread::spawn(move || {
                    if let Err(error) = bridge.request_wait("run/interrupt", json!({ "runId": run_id }), Duration::from_secs(10)) {
                        let _ = bridge.app.emit("adaptive-agent://run-finished", json!({ "error": error }));
                    }
                });
            }
        }
        let message = match kind {
            "run.created" => "Run started",
            "plan.execution_started" => "Plan started",
            "model.started" => "Thinking",
            "model.retry" => "Retrying inference",
            "tool.started" => "Tool started",
            "tool.completed" => "Tool completed",
            "tool.failed" => "Tool failed",
            "run.completed" => "Run completed",
            "run.failed" => "Run failed",
            "run.interrupted" => "Run interrupted",
            _ => return,
        };
        let _ = self.app.emit("adaptive-agent://progress", json!({ "runId": run_id, "kind": kind, "message": message }));
    }

    fn start_run(self: &Arc<Self>, task: String) -> Result<(), String> {
        if self.active.swap(true, Ordering::SeqCst) {
            return Err("A run is already active.".into());
        }
        *self.active_run_id.lock().unwrap() = None;
        let (_, receiver) = match self.request("agent/run", json!({ "goal": task })) {
            Ok(request) => request,
            Err(error) => { self.active.store(false, Ordering::SeqCst); return Err(error); }
        };
        self.emit_state();
        let bridge = self.clone();
        std::thread::spawn(move || {
            let response = receiver.recv().unwrap_or_else(|_| Err("The agent runtime exited before returning a result.".into()));
            let run_id = bridge.active_run_id.lock().unwrap().clone();
            bridge.active.store(false, Ordering::SeqCst);
            bridge.stopping.store(false, Ordering::SeqCst);
            bridge.queued_stop.store(false, Ordering::SeqCst);
            *bridge.active_run_id.lock().unwrap() = None;
            let payload = match response {
                Ok(result) => json!({ "runId": run_id, "result": result }),
                Err(error) => json!({ "runId": run_id, "error": error }),
            };
            let _ = bridge.app.emit("adaptive-agent://run-finished", payload);
            bridge.emit_state();
        });
        Ok(())
    }

    fn stop_run(&self) -> Result<(), String> {
        if !self.active.load(Ordering::SeqCst) { return Err("No run is active.".into()); }
        self.stopping.store(true, Ordering::SeqCst);
        self.queued_stop.store(true, Ordering::SeqCst);
        self.emit_state();
        let Some(run_id) = self.active_run_id.lock().unwrap().clone() else {
            return Ok(());
        };
        if self.queued_stop.swap(false, Ordering::SeqCst) {
            self.request_wait("run/interrupt", json!({ "runId": run_id }), Duration::from_secs(10)).map(|_| ())
        } else {
            Ok(())
        }
    }

    fn snapshot(&self) -> DesktopState {
        let configuration = self.configuration.lock().unwrap().clone();
        let error = self.initialization_error.lock().unwrap().clone();
        DesktopState {
            status: if error.is_some() { "error" } else if self.stopping.load(Ordering::SeqCst) { "stopping" } else if self.active.load(Ordering::SeqCst) { "running" } else { "ready" },
            configuration_valid: error.is_none() && configuration.is_some(),
            configuration,
            error,
            active_run_id: self.active_run_id.lock().unwrap().clone(),
        }
    }

    fn emit_state(&self) { let _ = self.app.emit("adaptive-agent://state", self.snapshot()); }

    fn fail_all(&self, message: &str) {
        for (_, sender) in self.pending.lock().unwrap().drain() { let _ = sender.send(Err(message.into())); }
    }

    fn transport_failed(&self) {
        if self.expected_shutdown.load(Ordering::SeqCst) { return; }
        self.fail_all("The agent runtime exited unexpectedly.");
        *self.configuration.lock().unwrap() = None;
        *self.initialization_error.lock().unwrap() = Some("The agent runtime exited unexpectedly. Reload Settings to restart it.".into());
        self.emit_state();
    }

    fn shutdown(&self) {
        self.expected_shutdown.store(true, Ordering::SeqCst);
        if let Ok((_, receiver)) = self.request("runtime/shutdown", json!({})) {
            let _ = receiver.recv_timeout(SHUTDOWN_TIMEOUT);
        }
        if let Some(child) = self.child.lock().unwrap().take() { let _ = child.kill(); }
        self.fail_all("The agent runtime was shut down.");
    }
}

fn replace_bridge(app: &AppHandle) -> Arc<Bridge> {
    let state = app.state::<AppState>();
    if let Some(previous) = state.bridge.lock().unwrap().take() { previous.shutdown(); }
    let bridge = match Bridge::spawn(app) {
        Ok(bridge) => bridge,
        Err(error) => {
            // A non-running placeholder keeps renderer state and errors restricted to the same API.
            Arc::new(Bridge {
                app: app.clone(), child: Mutex::new(None), pending: Mutex::new(HashMap::new()), next_id: AtomicU64::new(1),
                active: AtomicBool::new(false), stopping: AtomicBool::new(false), queued_stop: AtomicBool::new(false),
                expected_shutdown: AtomicBool::new(true), active_run_id: Mutex::new(None),
                configuration: Mutex::new(None), initialization_error: Mutex::new(Some(error)),
            })
        }
    };
    if bridge.child.lock().unwrap().is_some() {
        if let Err(error) = bridge.initialize() { *bridge.initialization_error.lock().unwrap() = Some(error); }
    }
    *state.bridge.lock().unwrap() = Some(bridge.clone());
    bridge.emit_state();
    bridge
}

#[tauri::command]
fn desktop_state(state: tauri::State<'_, AppState>) -> Result<DesktopState, String> {
    state.bridge.lock().unwrap().as_ref().map(|bridge| bridge.snapshot()).ok_or_else(|| "Desktop runtime is starting.".into())
}

#[tauri::command]
fn reload_settings(app: AppHandle, state: tauri::State<'_, AppState>) -> Result<DesktopState, String> {
    if state.bridge.lock().unwrap().as_ref().is_some_and(|bridge| bridge.active.load(Ordering::SeqCst)) {
        return Err("Stop the active run before reloading settings.".into());
    }
    Ok(replace_bridge(&app).snapshot())
}

#[tauri::command]
fn start_run(task: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    if task.trim().is_empty() { return Err("Task description is required.".into()); }
    let bridge = state.bridge.lock().unwrap().as_ref().cloned().ok_or_else(|| "Desktop runtime is starting.".to_string())?;
    if !bridge.snapshot().configuration_valid { return Err(bridge.snapshot().error.unwrap_or_else(|| "Settings are invalid.".into())); }
    bridge.start_run(task)
}

#[tauri::command]
fn stop_run(state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.bridge.lock().unwrap().as_ref().cloned().ok_or_else(|| "Desktop runtime is not available.".to_string())?.stop_run()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![desktop_state, reload_settings, start_run, stop_run])
        .setup(|app| { replace_bridge(app.handle()); Ok(()) })
        .build(tauri::generate_context!())
        .expect("failed to build AdaptiveAgent desktop");

    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { .. } = event {
            if let Some(bridge) = app.state::<AppState>().bridge.lock().unwrap().take() { bridge.shutdown(); }
        }
    });
}

fn is_root_run_created(event: &Value) -> bool {
    event.get("type").and_then(Value::as_str) == Some("run.created")
        && event.pointer("/payload/delegationDepth").and_then(Value::as_u64) == Some(0)
        && event.pointer("/payload/rootRunId").and_then(Value::as_str)
            == event.get("runId").and_then(Value::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifies_only_top_level_run_creation() {
        let root = json!({ "type": "run.created", "runId": "root", "payload": { "rootRunId": "root", "delegationDepth": 0 } });
        let child = json!({ "type": "run.created", "runId": "child", "payload": { "rootRunId": "root", "delegationDepth": 1 } });
        assert!(is_root_run_created(&root));
        assert!(!is_root_run_created(&child));
    }
}
