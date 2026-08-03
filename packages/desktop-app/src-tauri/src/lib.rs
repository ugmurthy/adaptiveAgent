use serde::Serialize;
use serde_json::{json, Value};
mod registry;
mod workbench;
use registry::{RunRecord, RunRegistry};
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
use workbench::{Reservation, WorkbenchDb};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_NDJSON_FRAME_SIZE: usize = 1024 * 1024;
const TRACE_MAX_NDJSON_FRAME_SIZE: usize = 8 * 1024 * 1024;

type Response = Result<Value, String>;

struct NdjsonDecoder {
    buffer: Vec<u8>,
    max_frame_size: usize,
}

impl NdjsonDecoder {
    fn new(max_frame_size: usize) -> Self {
        Self {
            buffer: Vec::new(),
            max_frame_size,
        }
    }

    fn push(&mut self, bytes: &[u8]) -> Result<Vec<Value>, String> {
        self.buffer.extend_from_slice(bytes);
        let mut frames = Vec::new();
        while let Some(end) = self.buffer.iter().position(|byte| *byte == b'\n') {
            if end > self.max_frame_size {
                self.buffer.drain(..=end);
                return Err("Sidecar NDJSON frame exceeded the maximum size.".into());
            }
            let line: Vec<u8> = self.buffer.drain(..=end).take(end).collect();
            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            frames.push(
                serde_json::from_slice(&line)
                    .map_err(|_| "Sidecar emitted invalid NDJSON.".to_string())?,
            );
        }
        if self.buffer.len() > self.max_frame_size {
            self.buffer.clear();
            return Err("Sidecar NDJSON frame exceeded the maximum size.".into());
        }
        Ok(frames)
    }
}

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
    execution_health: &'static str,
    trace_health: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    trace_error: Option<String>,
}

struct Bridge {
    app: AppHandle,
    child: Mutex<Option<CommandChild>>,
    pending: Mutex<HashMap<u64, Sender<Response>>>,
    decoder: Mutex<NdjsonDecoder>,
    generation: u64,
    next_id: AtomicU64,
    registry: Mutex<RunRegistry>,
    submission: Mutex<()>,
    workbench: Arc<WorkbenchDb>,
    expected_shutdown: AtomicBool,
    configuration: Mutex<Option<Value>>,
    initialization_error: Mutex<Option<String>>,
    trace_healthy: Arc<AtomicBool>,
    trace_error: Arc<Mutex<Option<String>>>,
}

#[derive(Default)]
struct AppState {
    bridge: Mutex<Option<Arc<Bridge>>>,
    trace: Mutex<Option<Arc<TraceBridge>>>,
    generation: AtomicU64,
}

struct TraceBridge {
    app: AppHandle,
    child: Mutex<Option<CommandChild>>,
    pending: Mutex<HashMap<u64, Sender<Response>>>,
    decoder: Mutex<NdjsonDecoder>,
    next_id: AtomicU64,
    healthy: Arc<AtomicBool>,
    error: Arc<Mutex<Option<String>>>,
    expected_shutdown: AtomicBool,
}

impl TraceBridge {
    fn spawn(
        app: &AppHandle,
        sqlite_path: &str,
        healthy: Arc<AtomicBool>,
        error: Arc<Mutex<Option<String>>>,
    ) -> Result<Arc<Self>, String> {
        let (mut events, child) = app
            .shell()
            .sidecar("trace-session-sidecar")
            .map_err(|e| format!("Unable to locate trace sidecar: {e}"))?
            .args(["--sqlite-path", sqlite_path])
            .spawn()
            .map_err(|e| format!("Unable to start trace sidecar: {e}"))?;
        let sidecar = Arc::new(Self {
            app: app.clone(),
            child: Mutex::new(Some(child)),
            pending: Mutex::new(HashMap::new()),
            decoder: Mutex::new(NdjsonDecoder::new(TRACE_MAX_NDJSON_FRAME_SIZE)),
            next_id: AtomicU64::new(1),
            healthy,
            error,
            expected_shutdown: AtomicBool::new(false),
        });
        let reader = sidecar.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(event) = events.recv().await {
                match event {
                    CommandEvent::Stdout(bytes) => reader.stdout(&bytes),
                    CommandEvent::Terminated(_) | CommandEvent::Error(_) => {
                        reader.fail("Trace sidecar exited unexpectedly.");
                        break;
                    }
                    _ => {}
                }
            }
        });
        let initialized=match sidecar.request_wait("initialize",Some(json!({"protocolVersion":"1.0","clientInfo":{"name":"adaptive-agent-desktop","version":"0.1.0"}})),REQUEST_TIMEOUT){Ok(value)=>value,Err(error)=>{sidecar.fail(&error);return Err(error)}};
        if initialized.get("protocolVersion").and_then(Value::as_str) != Some("1.0") {
            let error = "Trace sidecar did not negotiate protocol 1.0.".to_string();
            sidecar.fail(&error);
            return Err(error);
        }
        sidecar.healthy.store(true, Ordering::SeqCst);
        sidecar.emit_state();
        Ok(sidecar)
    }
    fn request_wait(&self, method: &str, params: Option<Value>, timeout: Duration) -> Response {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(id, tx);
        let message = match params {
            Some(params) => json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}),
            None => json!({"jsonrpc":"2.0","id":id,"method":method}),
        };
        let mut bytes = serde_json::to_vec(&message).map_err(|e| e.to_string())?;
        bytes.push(b'\n');
        let write = self
            .child
            .lock()
            .unwrap()
            .as_mut()
            .ok_or("Trace sidecar is not running.")
            .and_then(|child| {
                child
                    .write(&bytes)
                    .map_err(|_| "Unable to write to trace sidecar.")
            });
        if let Err(error) = write {
            self.pending.lock().unwrap().remove(&id);
            self.fail(error);
            return Err(error.into());
        }
        match rx.recv_timeout(timeout) {
            Ok(response) => response,
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                let error = "Trace sidecar request timed out.";
                self.fail(error);
                Err(error.into())
            }
        }
    }
    fn stdout(&self, bytes: &[u8]) {
        let frames = self.decoder.lock().unwrap().push(bytes);
        match frames {
            Ok(messages) => {
                for message in messages {
                    if let Some(id) = message.get("id").and_then(Value::as_u64) {
                        if let Some(sender) = self.pending.lock().unwrap().remove(&id) {
                            let response = if let Some(error) = message.get("error") {
                                Err(error
                                    .get("message")
                                    .and_then(Value::as_str)
                                    .unwrap_or("Trace request failed.")
                                    .into())
                            } else {
                                Ok(message.get("result").cloned().unwrap_or(Value::Null))
                            };
                            let _ = sender.send(response);
                        }
                    }
                }
            }
            Err(error) => self.fail(&error),
        }
    }
    fn fail(&self, message: &str) {
        if self.expected_shutdown.load(Ordering::SeqCst) {
            return;
        }
        self.healthy.store(false, Ordering::SeqCst);
        *self.error.lock().unwrap() = Some(message.into());
        for (_, sender) in self.pending.lock().unwrap().drain() {
            let _ = sender.send(Err(message.into()));
        }
        if let Some(child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
        }
        self.emit_state();
    }
    fn emit_state(&self) {
        if let Some(bridge) = self.app.state::<AppState>().bridge.lock().unwrap().as_ref() {
            bridge.emit_state();
        }
    }
    fn shutdown(&self) {
        self.expected_shutdown.store(true, Ordering::SeqCst);
        let _ = self.request_wait("shutdown", None, SHUTDOWN_TIMEOUT);
        if let Some(child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
        }
        for (_, sender) in self.pending.lock().unwrap().drain() {
            let _ = sender.send(Err("Trace sidecar was shut down.".into()));
        }
    }
}

impl Bridge {
    fn spawn(app: &AppHandle, workbench: Arc<WorkbenchDb>) -> Result<Arc<Self>, String> {
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
            decoder: Mutex::new(NdjsonDecoder::new(MAX_NDJSON_FRAME_SIZE)),
            generation: 1,
            next_id: AtomicU64::new(1),
            registry: Mutex::new(RunRegistry::default()),
            workbench,
            submission: Mutex::new(()),
            expected_shutdown: AtomicBool::new(false),
            configuration: Mutex::new(None),
            initialization_error: Mutex::new(None),
            trace_healthy: Arc::new(AtomicBool::new(false)),
            trace_error: Arc::new(Mutex::new(None)),
        });
        for saved in bridge.workbench.load_runs()? {
            bridge.registry.lock().unwrap().insert(RunRecord {
                run_id: saved.run_id,
                item_id: saved.item_id,
                session_id: saved.session_id,
                invocation_kind: saved.invocation_kind,
                submission_state: saved.submission_state.clone(),
                cached_status: saved.cached_status.clone(),
                root_created: false,
                cancel_requested: false,
                pending_interaction: None,
                occupies_slot: false,
            });
        }
        let reader = bridge.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(event) = events.recv().await {
                match event {
                    CommandEvent::Stdout(bytes) => reader.handle_stdout(1, &bytes),
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
            json!({ "protocolVersion": "1.12", "clientInfo": { "name": "adaptive-agent-desktop", "version": "0.1.0" } }),
            REQUEST_TIMEOUT,
        )?;
        if negotiated.get("protocolVersion").and_then(Value::as_str) != Some("1.12") {
            return Err("The sidecar did not negotiate desktop protocol 1.12.".into());
        }
        let initialized = self.request_wait(
            "runtime/initialize",
            json!({ "configurationDriven": true }),
            REQUEST_TIMEOUT,
        )?;
        let configuration = initialized
            .get("resolvedConfiguration")
            .cloned()
            .ok_or_else(|| {
                "The sidecar did not return a safe resolved configuration.".to_string()
            })?;
        *self.configuration.lock().unwrap() = Some(configuration);
        *self.initialization_error.lock().unwrap() = None;
        self.reconcile_saved_runs();
        Ok(())
    }

    fn reconcile_saved_runs(&self) {
        let ids = self.registry.lock().unwrap().ids_requiring_reconciliation();
        for run_id in ids {
            let inspection =
                self.request_wait("run/inspect", json!({ "runId": run_id }), REQUEST_TIMEOUT);
            let classification = reconciliation_classification(&inspection);
            if let Some(record) = self.registry.lock().unwrap().get_mut(&run_id) {
                record.cached_status = classification.0.into();
                record.submission_state = classification.1.into();
                record.occupies_slot = false;
            }
            let _ = self
                .workbench
                .update_run(&run_id, classification.0, classification.1);
        }
    }

    fn request(&self, method: &str, params: Value) -> Result<(u64, Receiver<Response>), String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = mpsc::channel();
        self.pending.lock().unwrap().insert(id, sender);
        let mut bytes = serde_json::to_vec(
            &json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }),
        )
        .map_err(|error| error.to_string())?;
        bytes.push(b'\n');
        let write_result = self
            .child
            .lock()
            .unwrap()
            .as_mut()
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

    fn handle_stdout(self: &Arc<Self>, generation: u64, bytes: &[u8]) {
        if generation != self.generation {
            return;
        }
        let messages = match self.decoder.lock().unwrap().push(bytes) {
            Ok(messages) => messages,
            Err(error) => {
                self.fail_all(&error);
                return;
            }
        };
        for message in messages {
            self.handle_message(message);
        }
    }

    fn handle_message(self: &Arc<Self>, message: Value) {
        if message.get("method").and_then(Value::as_str) == Some("agent/event") {
            self.handle_agent_event(message.get("params").unwrap_or(&Value::Null));
            return;
        }
        let Some(id) = message.get("id").and_then(Value::as_u64) else {
            return;
        };
        let Some(sender) = self.pending.lock().unwrap().remove(&id) else {
            return;
        };
        let response = if let Some(error) = message.get("error") {
            Err(error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Agent runtime request failed.")
                .to_string())
        } else {
            Ok(message.get("result").cloned().unwrap_or(Value::Null))
        };
        let _ = sender.send(response);
    }

    fn handle_agent_event(self: &Arc<Self>, event: &Value) {
        let Some(run_id) = event.get("runId").and_then(Value::as_str) else {
            return;
        };
        let kind = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("run.progress");
        let root_created = is_root_run_created(event);
        if root_created {
            let cancel = {
                let mut registry = self.registry.lock().unwrap();
                let Some(record) = registry.get_mut(run_id) else {
                    return;
                };
                record.root_created = true;
                record.cancel_requested
            };
            let _ = self.workbench.update_run(run_id, "running", "created");
            self.emit_state();
            if cancel {
                let bridge = self.clone();
                let run_id = run_id.to_string();
                std::thread::spawn(move || {
                    if let Err(error) = bridge.request_wait(
                        "run/interrupt",
                        json!({ "runId": run_id }),
                        Duration::from_secs(10),
                    ) {
                        let _ = bridge
                            .app
                            .emit("adaptive-agent://run-finished", json!({ "error": error }));
                    }
                });
            }
        }
        if kind == "run.status_changed" {
            if let Some(status) = event.pointer("/payload/toStatus").and_then(Value::as_str) {
                let state = state_for_durable_status(status);
                if let Some(record) = self.registry.lock().unwrap().get_mut(run_id) {
                    record.cached_status = state.cached_status.into();
                    record.submission_state = state.submission_state.into();
                    record.pending_interaction = state.pending_interaction.map(str::to_owned);
                    record.occupies_slot = state.occupies_slot;
                }
                let _ =
                    self.workbench
                        .update_run(run_id, state.cached_status, state.submission_state);
                self.emit_state();
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
        let _ = self.app.emit(
            "adaptive-agent://progress",
            json!({ "runId": run_id, "kind": kind, "message": message }),
        );
    }

    fn start_run(self: &Arc<Self>, task: String) -> Result<(), String> {
        let _submission = self.submission.lock().unwrap();
        if self.registry.lock().unwrap().any_active() {
            return Err("A run is already active.".into());
        }
        let run_id = uuid::Uuid::new_v4().to_string();
        let item_id = uuid::Uuid::new_v4().to_string();
        let configuration = self
            .configuration
            .lock()
            .unwrap()
            .clone()
            .ok_or("Settings are invalid.")?;
        let agent = configuration
            .get("agent")
            .ok_or("Resolved agent is missing.")?;
        let required_agent_value = |key| {
            agent
                .get(key)
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(str::to_owned)
                .ok_or_else(|| format!("Resolved agent {key} is missing."))
        };
        let reservation = Reservation {
            item_id: item_id.clone(),
            run_id: run_id.clone(),
            title: task.clone(),
            session_id: None,
            agent_id: required_agent_value("id")?,
            agent_name: required_agent_value("name")?,
            agent_fingerprint: required_agent_value("configurationFingerprint")?,
            invocation_kind: "run".into(),
            cached_status: "reserved".into(),
            submission_state: "reserved".into(),
        };
        self.workbench.reserve_task(&reservation)?;
        self.registry.lock().unwrap().insert(RunRecord {
            run_id: run_id.clone(),
            item_id,
            session_id: None,
            invocation_kind: "run".into(),
            submission_state: "submitted".into(),
            cached_status: "submitted".into(),
            root_created: false,
            cancel_requested: false,
            pending_interaction: None,
            occupies_slot: true,
        });
        self.workbench
            .update_run(&run_id, "submitted", "submitted")?;
        let (_, receiver) =
            match self.request("agent/run", json!({ "runId": run_id, "goal": task })) {
                Ok(request) => request,
                Err(error) => {
                    self.registry.lock().unwrap().terminal(&run_id, "failed");
                    let _ = self.workbench.update_run(&run_id, "failed", "write_failed");
                    return Err(error);
                }
            };
        self.emit_state();
        let bridge = self.clone();
        std::thread::spawn(move || {
            let response = receiver.recv().unwrap_or_else(|_| {
                Err("The agent runtime exited before returning a result.".into())
            });
            let state = match &response {
                Ok(result) => state_for_execution_result(result),
                Err(_) => RunState {
                    cached_status: "failed",
                    submission_state: "terminal",
                    pending_interaction: None,
                    occupies_slot: false,
                },
            };
            if let Some(record) = bridge.registry.lock().unwrap().get_mut(&run_id) {
                record.cached_status = state.cached_status.into();
                record.submission_state = state.submission_state.into();
                record.pending_interaction = state.pending_interaction.map(str::to_owned);
                record.occupies_slot = state.occupies_slot;
            }
            let _ =
                bridge
                    .workbench
                    .update_run(&run_id, state.cached_status, state.submission_state);
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
        let run_id = self
            .registry
            .lock()
            .unwrap()
            .active_id()
            .ok_or("No run is active.")?;
        let root_created = {
            let mut registry = self.registry.lock().unwrap();
            let record = registry.get_mut(&run_id).unwrap();
            record.cancel_requested = true;
            record.root_created
        };
        self.emit_state();
        if root_created {
            self.request_wait(
                "run/interrupt",
                json!({ "runId": run_id }),
                Duration::from_secs(10),
            )
            .map(|_| ())
        } else {
            Ok(())
        }
    }

    fn snapshot(&self) -> DesktopState {
        let configuration = self.configuration.lock().unwrap().clone();
        let error = self.initialization_error.lock().unwrap().clone();
        let execution_health = if error.is_some() { "error" } else { "ready" };
        DesktopState {
            status: if error.is_some() {
                "error"
            } else if self.registry.lock().unwrap().any_stopping() {
                "stopping"
            } else if self.registry.lock().unwrap().any_active() {
                "running"
            } else {
                "ready"
            },
            configuration_valid: error.is_none() && configuration.is_some(),
            configuration,
            error,
            active_run_id: self.registry.lock().unwrap().active_id(),
            execution_health,
            trace_health: if self.trace_healthy.load(Ordering::SeqCst) {
                "ready"
            } else if self.trace_error.lock().unwrap().is_some() {
                "error"
            } else {
                "starting"
            },
            trace_error: self.trace_error.lock().unwrap().clone(),
        }
    }

    fn emit_state(&self) {
        let _ = self.app.emit("adaptive-agent://state", self.snapshot());
    }

    fn fail_all(&self, message: &str) {
        for (_, sender) in self.pending.lock().unwrap().drain() {
            let _ = sender.send(Err(message.into()));
        }
    }

    fn transport_failed(&self) {
        if self.expected_shutdown.load(Ordering::SeqCst) {
            return;
        }
        self.fail_all("The agent runtime exited unexpectedly.");
        *self.configuration.lock().unwrap() = None;
        *self.initialization_error.lock().unwrap() =
            Some("The agent runtime exited unexpectedly. Reload Settings to restart it.".into());
        self.emit_state();
    }

    fn shutdown(&self) {
        self.expected_shutdown.store(true, Ordering::SeqCst);
        if let Ok((_, receiver)) = self.request("runtime/shutdown", json!({})) {
            let _ = receiver.recv_timeout(SHUTDOWN_TIMEOUT);
        }
        if let Some(child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
        }
        self.fail_all("The agent runtime was shut down.");
    }
}

fn replace_bridge(app: &AppHandle) -> Arc<Bridge> {
    let state = app.state::<AppState>();
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    if let Some(previous) = state.bridge.lock().unwrap().take() {
        previous.shutdown();
    }
    if let Some(previous) = state.trace.lock().unwrap().take() {
        previous.shutdown();
    }
    let workbench_result = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Unable to resolve desktop application data: {error}"))
        .and_then(|directory| {
            WorkbenchDb::open(directory.join("workbench.sqlite"))
                .map_err(|error| format!("Unable to open workbench persistence: {error}"))
        });
    let (workbench, persistence_error) = match workbench_result {
        Ok(workbench) => (Arc::new(workbench), None),
        Err(error) => (
            Arc::new(
                WorkbenchDb::open_in_memory()
                    .expect("in-memory error-state workbench database must open"),
            ),
            Some(error),
        ),
    };
    let bridge_result = match persistence_error {
        Some(error) => Err(error),
        None => Bridge::spawn(app, workbench.clone()),
    };
    let bridge = match bridge_result {
        Ok(bridge) => bridge,
        Err(error) => {
            // A non-running placeholder keeps renderer state and errors restricted to the same API.
            Arc::new(Bridge {
                app: app.clone(),
                child: Mutex::new(None),
                pending: Mutex::new(HashMap::new()),
                decoder: Mutex::new(NdjsonDecoder::new(MAX_NDJSON_FRAME_SIZE)),
                generation: 1,
                next_id: AtomicU64::new(1),
                registry: Mutex::new(RunRegistry::default()),
                workbench,
                submission: Mutex::new(()),
                expected_shutdown: AtomicBool::new(true),
                configuration: Mutex::new(None),
                initialization_error: Mutex::new(Some(error)),
                trace_healthy: Arc::new(AtomicBool::new(false)),
                trace_error: Arc::new(Mutex::new(None)),
            })
        }
    };
    if bridge.child.lock().unwrap().is_some() {
        if let Err(error) = bridge.initialize() {
            *bridge.initialization_error.lock().unwrap() = Some(error);
        }
    }
    *state.bridge.lock().unwrap() = Some(bridge.clone());
    bridge.emit_state();
    if bridge.initialization_error.lock().unwrap().is_none() {
        let path = bridge
            .configuration
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|configuration| configuration.pointer("/runtime/sqlitePath"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        if let Some(path) = path {
            let app = app.clone();
            let target = bridge.clone();
            std::thread::spawn(move || {
                match TraceBridge::spawn(
                    &app,
                    &path,
                    target.trace_healthy.clone(),
                    target.trace_error.clone(),
                ) {
                    Ok(trace)
                        if app.state::<AppState>().generation.load(Ordering::SeqCst)
                            == generation =>
                    {
                        *app.state::<AppState>().trace.lock().unwrap() = Some(trace);
                    }
                    Ok(trace) => trace.shutdown(),
                    Err(error) => {
                        if app.state::<AppState>().generation.load(Ordering::SeqCst) == generation {
                            *target.trace_error.lock().unwrap() = Some(error);
                            target.emit_state();
                        }
                    }
                }
            });
        } else {
            *bridge.trace_error.lock().unwrap() = Some(
                "Execution did not resolve an exact SQLite path; trace is unavailable.".into(),
            );
            bridge.emit_state();
        }
    } else {
        *bridge.trace_error.lock().unwrap() =
            Some("Execution configuration is invalid; trace is unavailable.".into());
        bridge.emit_state();
    }
    bridge
}

#[tauri::command]
fn desktop_state(state: tauri::State<'_, AppState>) -> Result<DesktopState, String> {
    state
        .bridge
        .lock()
        .unwrap()
        .as_ref()
        .map(|bridge| bridge.snapshot())
        .ok_or_else(|| "Desktop runtime is starting.".into())
}

#[tauri::command]
fn reload_settings(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<DesktopState, String> {
    if state
        .bridge
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|bridge| bridge.registry.lock().unwrap().any_active())
    {
        return Err("Stop the active run before reloading settings.".into());
    }
    Ok(replace_bridge(&app).snapshot())
}

#[tauri::command]
fn start_run(task: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    if task.trim().is_empty() {
        return Err("Task description is required.".into());
    }
    let bridge = state
        .bridge
        .lock()
        .unwrap()
        .as_ref()
        .cloned()
        .ok_or_else(|| "Desktop runtime is starting.".to_string())?;
    if !bridge.snapshot().configuration_valid {
        return Err(bridge
            .snapshot()
            .error
            .unwrap_or_else(|| "Settings are invalid.".into()));
    }
    bridge.start_run(task)
}

#[tauri::command]
fn stop_run(state: tauri::State<'_, AppState>) -> Result<(), String> {
    state
        .bridge
        .lock()
        .unwrap()
        .as_ref()
        .cloned()
        .ok_or_else(|| "Desktop runtime is not available.".to_string())?
        .stop_run()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            desktop_state,
            reload_settings,
            start_run,
            stop_run
        ])
        .setup(|app| {
            replace_bridge(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build AdaptiveAgent desktop");

    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { .. } = event {
            if let Some(bridge) = app.state::<AppState>().bridge.lock().unwrap().take() {
                bridge.shutdown();
            }
            if let Some(trace) = app.state::<AppState>().trace.lock().unwrap().take() {
                trace.shutdown();
            }
        }
    });
}

fn is_root_run_created(event: &Value) -> bool {
    event.get("type").and_then(Value::as_str) == Some("run.created")
        && event
            .pointer("/payload/delegationDepth")
            .and_then(Value::as_u64)
            == Some(0)
        && event.pointer("/payload/rootRunId").and_then(Value::as_str)
            == event.get("runId").and_then(Value::as_str)
}

fn reconciliation_classification(inspection: &Response) -> (&'static str, &'static str) {
    match inspection {
        Ok(value) => match value.pointer("/run/status").and_then(Value::as_str) {
            Some("succeeded") => ("succeeded", "terminal"),
            Some("failed") => ("failed", "terminal"),
            Some("cancelled") => ("cancelled", "terminal"),
            Some("interrupted") => ("interrupted", "terminal"),
            Some("clarification_requested") => ("clarification_requested", "terminal"),
            Some("replan_required") => ("replan_required", "terminal"),
            Some(_) | None => ("recovery_required", "recovery_required"),
        },
        Err(error) if error.to_ascii_lowercase().contains("not found") => {
            ("submission_failed", "submission_failed")
        }
        Err(_) => ("recovery_required", "recovery_required"),
    }
}

struct RunState {
    cached_status: &'static str,
    submission_state: &'static str,
    pending_interaction: Option<&'static str>,
    occupies_slot: bool,
}

fn state_for_execution_result(result: &Value) -> RunState {
    match result.get("status").and_then(Value::as_str) {
        Some("success") => state_for_durable_status("succeeded"),
        Some("failure") => match result.get("code").and_then(Value::as_str) {
            Some("INTERRUPTED") => state_for_durable_status("interrupted"),
            Some("REPLAN_REQUIRED") => state_for_durable_status("replan_required"),
            _ => state_for_durable_status("failed"),
        },
        Some("approval_requested") => state_for_durable_status("awaiting_approval"),
        Some("clarification_requested") => state_for_durable_status("clarification_requested"),
        _ => RunState {
            cached_status: "recovery_required",
            submission_state: "recovery_required",
            pending_interaction: None,
            occupies_slot: false,
        },
    }
}

fn state_for_durable_status(status: &str) -> RunState {
    let quiescent = matches!(
        status,
        "succeeded"
            | "failed"
            | "cancelled"
            | "interrupted"
            | "clarification_requested"
            | "replan_required"
    );
    RunState {
        cached_status: match status {
            "queued" => "queued",
            "planning" => "planning",
            "running" => "running",
            "awaiting_subagent" => "awaiting_subagent",
            "awaiting_approval" => "awaiting_approval",
            "succeeded" => "succeeded",
            "failed" => "failed",
            "cancelled" => "cancelled",
            "interrupted" => "interrupted",
            "clarification_requested" => "clarification_requested",
            "replan_required" => "replan_required",
            _ => "recovery_required",
        },
        submission_state: if quiescent { "terminal" } else { "durable" },
        pending_interaction: (status == "awaiting_approval").then_some("approval"),
        occupies_slot: !quiescent,
    }
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

    #[test]
    fn ndjson_decoder_handles_partial_and_multiple_out_of_order_frames() {
        let mut decoder = NdjsonDecoder::new(128);
        assert!(decoder.push(b"{\"id\":2").unwrap().is_empty());
        let frames = decoder.push(b"}\n{\"id\":1}\n").unwrap();
        assert_eq!(frames, vec![json!({ "id": 2 }), json!({ "id": 1 })]);
    }

    #[test]
    fn ndjson_decoder_rejects_oversized_frames_and_recovers() {
        let mut decoder = NdjsonDecoder::new(8);
        assert!(decoder
            .push(b"123456789")
            .unwrap_err()
            .contains("maximum size"));
        assert_eq!(
            decoder.push(b"{\"a\":1}\n").unwrap(),
            vec![json!({ "a": 1 })]
        );
        assert!(decoder
            .push(b"{}\n123456789")
            .unwrap_err()
            .contains("maximum size"));
    }

    #[test]
    fn reconciliation_classifies_missing_terminal_and_nonterminal_runs_as_quiescent() {
        assert_eq!(
            reconciliation_classification(&Err("Run not found".into())),
            ("submission_failed", "submission_failed")
        );
        assert_eq!(
            reconciliation_classification(&Ok(json!({ "run": { "status": "succeeded" } }))),
            ("succeeded", "terminal")
        );
        assert_eq!(
            reconciliation_classification(&Ok(json!({ "run": { "status": "running" } }))),
            ("recovery_required", "recovery_required")
        );
        assert_eq!(
            reconciliation_classification(&Err("transport unavailable".into())),
            ("recovery_required", "recovery_required")
        );
    }

    #[test]
    fn execution_results_preserve_approval_occupancy_and_terminal_statuses() {
        let approval = state_for_execution_result(&json!({ "status": "approval_requested" }));
        assert_eq!(approval.cached_status, "awaiting_approval");
        assert_eq!(approval.pending_interaction, Some("approval"));
        assert!(approval.occupies_slot);

        let success = state_for_execution_result(&json!({ "status": "success" }));
        assert_eq!(success.cached_status, "succeeded");
        assert!(!success.occupies_slot);

        let interrupted =
            state_for_execution_result(&json!({ "status": "failure", "code": "INTERRUPTED" }));
        assert_eq!(interrupted.cached_status, "interrupted");
        assert!(!interrupted.occupies_slot);
    }
}
