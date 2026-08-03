use serde::Serialize;
use serde_json::{json, Value};
mod registry;
mod shutdown;
mod workbench;
use registry::{CancelAction, RunRecord, RunRegistry, CAPACITY};
use shutdown::{CloseDecision, QuitCoordinator, QuitState};
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
    runs: Vec<RunSummary>,
    occupied_slot_count: usize,
    capacity: usize,
    execution_health: &'static str,
    trace_health: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    trace_error: Option<String>,
    quit_state: QuitState,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunSummary {
    item_id: String,
    run_id: String,
    status: String,
    cancel_requested: bool,
    occupies_slot: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartedRun {
    item_id: String,
    run_id: String,
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
    draining: AtomicBool,
    // false means running; true means one more pass was requested while running.
    reconciling: Mutex<HashMap<String, bool>>,
}

#[derive(Default)]
struct AppState {
    lifecycle: Mutex<()>,
    bridge: Mutex<Option<Arc<Bridge>>>,
    trace: Mutex<Option<Arc<TraceBridge>>>,
    generation: AtomicU64,
    quit: Mutex<QuitCoordinator>,
    shutdown_started: AtomicBool,
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
    fn spawn_process(
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
        Ok(sidecar)
    }

    fn initialize(&self) -> Result<(), String> {
        let initialized=match self.request_wait("initialize",Some(json!({"protocolVersion":"1.0","clientInfo":{"name":"adaptive-agent-desktop","version":"0.1.0"}})),REQUEST_TIMEOUT){Ok(value)=>value,Err(error)=>{self.fail(&error);return Err(error)}};
        if initialized.get("protocolVersion").and_then(Value::as_str) != Some("1.0") {
            let error = "Trace sidecar did not negotiate protocol 1.0.".to_string();
            self.fail(&error);
            return Err(error);
        }
        self.healthy.store(true, Ordering::SeqCst);
        self.emit_state();
        Ok(())
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
        // Complete all fallible persistence reads before creating a child process so every
        // spawned runtime can be published to, and shut down through, the native lifecycle.
        let saved_runs = workbench.load_runs()?;
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
            draining: AtomicBool::new(false),
            reconciling: Mutex::new(HashMap::new()),
        });
        for saved in saved_runs {
            bridge.registry.lock().unwrap().insert(RunRecord {
                run_id: saved.run_id,
                item_id: saved.item_id,
                session_id: saved.session_id,
                invocation_kind: saved.invocation_kind,
                submission_state: saved.submission_state.clone(),
                cached_status: saved.cached_status.clone(),
                root_created: saved.submission_state == "durable"
                    || saved.submission_state == "created",
                cancel_requested: saved.cancel_requested,
                interrupt_pending: saved.interrupt_pending,
                request_active: false,
                startup_recovery: true,
                revision: 0,
                pending_interaction: None,
                occupies_slot: !matches!(
                    saved.submission_state.as_str(),
                    "terminal" | "submission_failed"
                ),
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

    fn initialize(self: &Arc<Self>) -> Result<(), String> {
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

    fn reconcile_saved_runs(self: &Arc<Self>) {
        let ids = self.registry.lock().unwrap().ids_requiring_reconciliation();
        for run_id in ids {
            self.reconcile_run(run_id);
        }
    }

    fn reconcile_run(self: &Arc<Self>, run_id: String) {
        let mut reconciling = self.reconciling.lock().unwrap();
        if let Some(rerun) = reconciling.get_mut(&run_id) {
            *rerun = true;
            return;
        }
        reconciling.insert(run_id.clone(), false);
        drop(reconciling);
        let bridge = self.clone();
        std::thread::spawn(move || {
            let mut attempted_interrupt = false;
            loop {
                let (revision, previous, root_created, definitely_absent) = bridge
                    .registry
                    .lock()
                    .unwrap()
                    .get(&run_id)
                    .map(|record| {
                        (
                            record.revision,
                            record.occupies_slot,
                            record.root_created,
                            record.startup_recovery
                                && !record.request_active
                                && !record.root_created
                                && matches!(
                                    record.submission_state.as_str(),
                                    "reserved" | "submitted"
                                ),
                        )
                    })
                    .unwrap_or((0, false, false, false));
                let inspection = bridge.inspect_for_recovery(&run_id);
                let state = reconciliation_classification(
                    &inspection,
                    previous,
                    root_created,
                    definitely_absent,
                );
                let result = recovered_result(&inspection);
                let mut applied_quiescent = false;
                let mut stale = false;
                let mut persisted = None;
                let mut should_interrupt = false;
                if let Some(record) = bridge.registry.lock().unwrap().get_mut(&run_id) {
                    match apply_run_state(record, &state, Some(revision)) {
                        ApplyState::Accepted => {
                            applied_quiescent = !state.occupies_slot;
                            persisted = Some((
                                record.cached_status.clone(),
                                record.submission_state.clone(),
                            ));
                        }
                        ApplyState::Stale => stale = true,
                        ApplyState::Rejected => {}
                    }
                    should_interrupt = !attempted_interrupt
                        && !stale
                        && record.occupies_slot
                        && record.root_created
                        && record.interrupt_pending;
                }
                if let Some((status, submission)) = persisted {
                    let _ = bridge.workbench.update_run(&run_id, &status, &submission);
                }
                if applied_quiescent && result.is_some() {
                    let _ = bridge
                        .workbench
                        .store_result(&run_id, result.as_ref().unwrap());
                }
                if applied_quiescent {
                    let _ = bridge.workbench.set_interrupt_pending(&run_id, false);
                    if let Some(record) = bridge.registry.lock().unwrap().get_mut(&run_id) {
                        record.interrupt_pending = false;
                    }
                }
                if stale {
                    if let Some(rerun) = bridge.reconciling.lock().unwrap().get_mut(&run_id) {
                        *rerun = true;
                    }
                }
                if should_interrupt {
                    attempted_interrupt = true;
                    if bridge.issue_interrupt(&run_id) {
                        if let Some(rerun) = bridge.reconciling.lock().unwrap().get_mut(&run_id) {
                            *rerun = true;
                        }
                    }
                }
                if applied_quiescent {
                    let _ = bridge.app.emit(
                        "adaptive-agent://run-finished",
                        json!({ "runId": run_id, "result": result }),
                    );
                }
                bridge.emit_state();
                let mut active = bridge.reconciling.lock().unwrap();
                if active.get(&run_id).copied().unwrap_or(false) {
                    active.insert(run_id.clone(), false);
                    continue;
                }
                active.remove(&run_id);
                break;
            }
        });
    }

    fn issue_interrupt(&self, run_id: &str) -> bool {
        let result = self.request_wait(
            "run/interrupt",
            json!({ "runId": run_id }),
            Duration::from_secs(10),
        );
        if result.is_ok() {
            // Acceptance is not quiescence. Reconciliation clears the durable intent.
            true
        } else {
            let _ = self.app.emit(
                "adaptive-agent://control-error",
                json!({ "runId": run_id, "error": result.unwrap_err() }),
            );
            false
        }
    }

    fn arm_interrupt(&self, run_id: &str, retry: bool) -> Result<(), String> {
        loop {
            match self.workbench.set_interrupt_pending(run_id, true) {
                Ok(()) => {
                    if let Some(record) = self.registry.lock().unwrap().get_mut(run_id) {
                        record.interrupt_pending = true;
                        record.revision += 1;
                    }
                    return Ok(());
                }
                Err(error) if retry => {
                    let _ = self.app.emit(
                        "adaptive-agent://control-error",
                        json!({ "runId": run_id, "error": format!("Unable to persist shutdown interrupt; retrying: {error}") }),
                    );
                    std::thread::sleep(Duration::from_millis(200));
                }
                Err(error) => return Err(error),
            }
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
                record.revision += 1;
                record.cancel_requested
            };
            let persisted = self.registry.lock().unwrap().get(run_id).map(|record| {
                (
                    record.cached_status.clone(),
                    record.submission_state.clone(),
                )
            });
            if let Some((status, submission)) = persisted {
                let _ = self.workbench.update_run(run_id, &status, &submission);
            }
            self.emit_state();
            if cancel {
                let bridge = self.clone();
                let run_id = run_id.to_string();
                std::thread::spawn(move || {
                    if bridge
                        .arm_interrupt(&run_id, bridge.draining.load(Ordering::SeqCst))
                        .is_ok()
                        && bridge.issue_interrupt(&run_id)
                    {
                        bridge.reconcile_run(run_id);
                    }
                });
            }
        }
        if kind == "run.status_changed" {
            if let Some(status) = event.pointer("/payload/toStatus").and_then(Value::as_str) {
                let mut registry = self.registry.lock().unwrap();
                let persisted = if let Some(record) = registry.get_mut(run_id) {
                    let state = state_for_durable_status(status, record.occupies_slot);
                    if apply_run_state(record, &state, None) == ApplyState::Accepted {
                        Some((
                            record.cached_status.clone(),
                            record.submission_state.clone(),
                        ))
                    } else {
                        None
                    }
                } else {
                    None
                };
                drop(registry);
                if let Some((cached_status, submission_state)) = persisted {
                    let _ = self
                        .workbench
                        .update_run(run_id, &cached_status, &submission_state);
                }
                self.emit_state();
            }
        }
        if matches!(
            kind,
            "run.completed" | "run.failed" | "run.interrupted" | "replan.required"
        ) {
            self.reconcile_run(run_id.to_owned());
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

    fn start_run(self: &Arc<Self>, task: String) -> Result<StartedRun, String> {
        let _submission = self.submission.lock().unwrap();
        if self.draining.load(Ordering::SeqCst) {
            return Err("The desktop is draining and cannot start new runs.".into());
        }
        if !self.registry.lock().unwrap().has_capacity() {
            return Err(
                "All 3 task slots are occupied. Stop or wait for a run, then try again.".into(),
            );
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
            cancel_requested: false,
            interrupt_pending: false,
        };
        self.registry.lock().unwrap().insert(RunRecord {
            run_id: run_id.clone(),
            item_id: item_id.clone(),
            session_id: None,
            invocation_kind: "run".into(),
            submission_state: "submitted".into(),
            cached_status: "submitted".into(),
            root_created: false,
            cancel_requested: false,
            interrupt_pending: false,
            request_active: true,
            startup_recovery: false,
            revision: 0,
            pending_interaction: None,
            occupies_slot: true,
        });
        if let Err(error) = self.workbench.reserve_task(&reservation) {
            self.registry.lock().unwrap().remove(&run_id);
            return Err(error);
        }
        if let Err(error) = self.workbench.update_run(&run_id, "submitted", "submitted") {
            self.registry.lock().unwrap().remove(&run_id);
            let _ = self.workbench.delete_item(&item_id);
            return Err(error);
        }
        let (_request_id, receiver) =
            match self.request("agent/run", json!({ "runId": run_id, "goal": task })) {
                Ok(request) => request,
                Err(error) => {
                    self.registry.lock().unwrap().terminal(&run_id, "failed");
                    self.registry.lock().unwrap().remove(&run_id);
                    let _ = self.workbench.delete_item(&item_id);
                    return Err(error);
                }
            };
        self.emit_state();
        let bridge = self.clone();
        let started = StartedRun {
            item_id,
            run_id: run_id.clone(),
        };
        std::thread::spawn(move || {
            let response = match receiver.recv_timeout(Duration::from_secs(30)) {
                Ok(response) => response,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    bridge.reconcile_run(run_id.clone());
                    receiver.recv().unwrap_or_else(|_| {
                        Err("The agent runtime exited before returning a result.".into())
                    })
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    Err("The agent runtime exited before returning a result.".into())
                }
            };
            if let Some(record) = bridge.registry.lock().unwrap().get_mut(&run_id) {
                record.request_active = false;
                record.revision += 1;
            }
            match response {
                Ok(result) => {
                    let state = state_for_execution_result(&result);
                    let _ = bridge.workbench.store_result(&run_id, &result);
                    let mut accepted_quiescent = false;
                    if let Some(record) = bridge.registry.lock().unwrap().get_mut(&run_id) {
                        accepted_quiescent = apply_run_state(record, &state, None)
                            == ApplyState::Accepted
                            && !state.occupies_slot;
                    }
                    if let Some(record) = bridge.registry.lock().unwrap().get(&run_id) {
                        let _ = bridge.workbench.update_run(
                            &run_id,
                            &record.cached_status,
                            &record.submission_state,
                        );
                    }
                    if accepted_quiescent {
                        let _ = bridge.app.emit(
                            "adaptive-agent://run-finished",
                            json!({ "runId": run_id, "result": result }),
                        );
                    } else {
                        bridge.reconcile_run(run_id.clone());
                    }
                }
                Err(error) => {
                    let _ = bridge.app.emit(
                        "adaptive-agent://control-error",
                        json!({ "runId": run_id, "error": error }),
                    );
                    bridge.reconcile_run(run_id.clone());
                }
            }
            bridge.emit_state();
        });
        Ok(started)
    }

    fn stop_run(self: &Arc<Self>, run_id: &str) -> Result<(), String> {
        let action = self
            .registry
            .lock()
            .unwrap()
            .request_cancel(run_id)
            .map_err(str::to_owned)?;
        if action == CancelAction::Quiescent {
            return Ok(());
        }
        if action == CancelAction::AlreadyRequested {
            self.reconcile_run(run_id.to_owned());
            return Ok(());
        }
        if let Err(error) = self.workbench.set_cancel_requested(run_id) {
            if let Some(record) = self.registry.lock().unwrap().get_mut(run_id) {
                record.cancel_requested = false;
            }
            return Err(error);
        }
        self.emit_state();
        if action == CancelAction::Interrupt {
            if let Err(error) = self.arm_interrupt(run_id, false) {
                if let Some(record) = self.registry.lock().unwrap().get_mut(run_id) {
                    record.interrupt_pending = false;
                }
                return Err(error);
            }
            if self.issue_interrupt(run_id) {
                self.reconcile_run(run_id.to_owned());
            }
            Ok(())
        } else {
            Ok(())
        }
    }

    fn arm_cancellations(self: &Arc<Self>, run_ids: &[String]) {
        for run_id in run_ids {
            loop {
                match self.workbench.set_cancel_requested(run_id) {
                    Ok(()) => break,
                    Err(error) => {
                        let _ = self.app.emit(
                            "adaptive-agent://control-error",
                            json!({ "runId": run_id, "error": format!("Unable to persist shutdown cancellation; retrying: {error}") }),
                        );
                        std::thread::sleep(Duration::from_millis(200));
                    }
                }
            }
            let action = self.registry.lock().unwrap().request_cancel(run_id);
            if matches!(action, Ok(CancelAction::Interrupt)) {
                let _ = self.arm_interrupt(run_id, true);
                if self.issue_interrupt(run_id) {
                    self.reconcile_run(run_id.clone());
                }
            }
            self.emit_state();
        }
    }

    fn inspect_for_recovery(&self, run_id: &str) -> Response {
        let mut last = Err("Inspection unavailable.".into());
        for _ in 0..3 {
            last = self.request_wait(
                "run/inspect",
                json!({ "runId": run_id }),
                Duration::from_secs(3),
            );
            if last.is_ok() {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        last
    }

    fn snapshot(&self) -> DesktopState {
        let configuration = self.configuration.lock().unwrap().clone();
        let error = self.initialization_error.lock().unwrap().clone();
        let execution_health = if error.is_some() { "error" } else { "ready" };
        let registry = self.registry.lock().unwrap();
        let any_stopping = registry.any_stopping();
        let any_active = registry.any_active();
        let mut runs = registry
            .records()
            .map(|run| RunSummary {
                item_id: run.item_id.clone(),
                run_id: run.run_id.clone(),
                status: run.cached_status.clone(),
                cancel_requested: run.cancel_requested,
                occupies_slot: run.occupies_slot,
            })
            .collect::<Vec<_>>();
        runs.sort_by(|left, right| left.run_id.cmp(&right.run_id));
        DesktopState {
            status: if error.is_some() {
                "error"
            } else if any_stopping {
                "stopping"
            } else if any_active {
                "running"
            } else {
                "ready"
            },
            configuration_valid: error.is_none() && configuration.is_some(),
            configuration,
            error,
            runs,
            occupied_slot_count: registry.occupied_slot_count(),
            capacity: CAPACITY,
            execution_health,
            trace_health: if self.trace_healthy.load(Ordering::SeqCst) {
                "ready"
            } else if self.trace_error.lock().unwrap().is_some() {
                "error"
            } else {
                "starting"
            },
            trace_error: self.trace_error.lock().unwrap().clone(),
            quit_state: self.app.state::<AppState>().quit.lock().unwrap().state(),
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

fn replace_bridge(app: &AppHandle) -> Result<Arc<Bridge>, String> {
    let state = app.state::<AppState>();
    let lifecycle = state.lifecycle.lock().unwrap();
    if state.shutdown_started.load(Ordering::SeqCst)
        || state.quit.lock().unwrap().state() != QuitState::Idle
    {
        return Err("Settings cannot be reloaded while quitting.".into());
    }
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let previous_bridge = state.bridge.lock().unwrap().clone();
    let previous_trace = state.trace.lock().unwrap().clone();
    drop(lifecycle);
    if let Some(previous) = previous_bridge {
        previous.shutdown();
    }
    if let Some(previous) = previous_trace {
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
    let lifecycle = state.lifecycle.lock().unwrap();
    if state.shutdown_started.load(Ordering::SeqCst)
        || state.quit.lock().unwrap().state() != QuitState::Idle
        || state.generation.load(Ordering::SeqCst) != generation
    {
        return Err("Settings replacement was superseded or shutdown has started.".into());
    }
    // Process creation and publication are one lifecycle operation: no child can exist
    // while neither the old nor new bridge is visible to close handling.
    state.bridge.lock().unwrap().take();
    state.trace.lock().unwrap().take();
    let spawn_result = match persistence_error {
        Some(error) => Err(error),
        None => Bridge::spawn(app, workbench.clone()),
    };
    let (bridge, spawn_error) = match spawn_result {
        Ok(bridge) => (bridge, None),
        Err(error) => {
            // A non-running placeholder keeps renderer state and errors restricted to the same API.
            let placeholder = Arc::new(Bridge {
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
                initialization_error: Mutex::new(Some(error.clone())),
                trace_healthy: Arc::new(AtomicBool::new(false)),
                trace_error: Arc::new(Mutex::new(None)),
                draining: AtomicBool::new(false),
                reconciling: Mutex::new(HashMap::new()),
            });
            (placeholder, Some(error))
        }
    };
    *state.bridge.lock().unwrap() = Some(bridge.clone());
    drop(lifecycle);

    if let Some(error) = spawn_error {
        bridge.emit_state();
        return Err(error);
    }
    if bridge.child.lock().unwrap().is_some() {
        if let Err(error) = bridge.initialize() {
            *bridge.initialization_error.lock().unwrap() = Some(error.clone());
            bridge.emit_state();
            return Err(error);
        }
    }
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
                let state = app.state::<AppState>();
                let lifecycle = state.lifecycle.lock().unwrap();
                if state.shutdown_started.load(Ordering::SeqCst)
                    || state.quit.lock().unwrap().state() != QuitState::Idle
                    || state.generation.load(Ordering::SeqCst) != generation
                {
                    return;
                }
                match TraceBridge::spawn_process(
                    &app,
                    &path,
                    target.trace_healthy.clone(),
                    target.trace_error.clone(),
                ) {
                    Ok(trace) => {
                        *state.trace.lock().unwrap() = Some(trace.clone());
                        drop(lifecycle);
                        if let Err(error) = trace.initialize() {
                            let removed = {
                                let _lifecycle = state.lifecycle.lock().unwrap();
                                let mut slot = state.trace.lock().unwrap();
                                if slot
                                    .as_ref()
                                    .is_some_and(|current| Arc::ptr_eq(current, &trace))
                                {
                                    slot.take();
                                    true
                                } else {
                                    false
                                }
                            };
                            if removed {
                                trace.shutdown();
                            }
                            if state.generation.load(Ordering::SeqCst) == generation {
                                *target.trace_error.lock().unwrap() = Some(error);
                                target.emit_state();
                            }
                        }
                    }
                    Err(error) => {
                        drop(lifecycle);
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
    Ok(bridge)
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
    {
        let _lifecycle = state.lifecycle.lock().unwrap();
        if state.quit.lock().unwrap().state() != QuitState::Idle {
            return Err("Settings cannot be reloaded while quitting.".into());
        }
        if state
            .bridge
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|bridge| bridge.registry.lock().unwrap().any_active())
        {
            return Err("Stop the active run before reloading settings.".into());
        }
    }
    Ok(replace_bridge(&app)?.snapshot())
}

#[tauri::command]
fn start_run(task: String, state: tauri::State<'_, AppState>) -> Result<StartedRun, String> {
    if task.trim().is_empty() {
        return Err("Task description is required.".into());
    }
    let _lifecycle = state.lifecycle.lock().unwrap();
    if state.quit.lock().unwrap().state() != QuitState::Idle {
        return Err("The desktop is quitting and cannot start new runs.".into());
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
fn stop_run(run_id: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    state
        .bridge
        .lock()
        .unwrap()
        .as_ref()
        .cloned()
        .ok_or_else(|| "Desktop runtime is not available.".to_string())?
        .stop_run(&run_id)
}

#[tauri::command]
fn get_run_result(
    run_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Option<Value>, String> {
    state
        .bridge
        .lock()
        .unwrap()
        .as_ref()
        .cloned()
        .ok_or_else(|| "Desktop runtime is not available.".to_string())?
        .workbench
        .get_result(&run_id)
}

#[derive(Clone, Copy)]
enum DrainMode {
    Wait,
    Terminate,
}

fn begin_drain(app: &AppHandle, mode: DrainMode) -> Result<DesktopState, String> {
    let state = app.state::<AppState>();
    let lifecycle = state.lifecycle.lock().unwrap();
    let bridge = state
        .bridge
        .lock()
        .unwrap()
        .as_ref()
        .cloned()
        .ok_or_else(|| "Desktop runtime is not available.".to_string())?;
    state.quit.lock().unwrap().drain().map_err(str::to_owned)?;
    bridge.draining.store(true, Ordering::SeqCst);
    let cancellation_targets = bridge.registry.lock().unwrap().occupied_ids();
    drop(lifecycle);
    bridge.emit_state();
    let snapshot = bridge.snapshot();

    let app = app.clone();
    std::thread::spawn(move || {
        if matches!(mode, DrainMode::Terminate) {
            bridge.arm_cancellations(&cancellation_targets);
        }
        loop {
            let ids = bridge.registry.lock().unwrap().occupied_ids();
            if ids.is_empty() {
                break;
            }
            for id in ids {
                bridge.reconcile_run(id);
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        approve_and_exit(&app);
    });
    Ok(snapshot)
}

fn approve_and_exit(app: &AppHandle) {
    let state = app.state::<AppState>();
    let lifecycle = state.lifecycle.lock().unwrap();
    if state.shutdown_started.swap(true, Ordering::SeqCst) {
        return;
    }
    let bridge = state.bridge.lock().unwrap().take();
    let trace = state.trace.lock().unwrap().take();
    drop(lifecycle);
    // Potentially blocking sidecar shutdown and app.exit happen with no native mutex held.
    if let Some(bridge) = bridge {
        bridge.emit_state();
        bridge.shutdown();
    }
    if let Some(trace) = trace {
        trace.shutdown();
    }
    {
        let _lifecycle = state.lifecycle.lock().unwrap();
        let _ = state.quit.lock().unwrap().approve();
    }
    app.exit(0);
}

fn native_close_requested(app: &AppHandle) -> CloseDecision {
    let state = app.state::<AppState>();
    let _lifecycle = state.lifecycle.lock().unwrap();
    let occupied = state.bridge.lock().unwrap().as_ref().map_or(0, |bridge| {
        bridge.registry.lock().unwrap().occupied_slot_count()
    });
    let decision = state.quit.lock().unwrap().close_requested(occupied);
    if let Some(bridge) = state.bridge.lock().unwrap().as_ref() {
        bridge.emit_state();
    }
    decision
}

#[tauri::command]
fn quit_wait(app: AppHandle) -> Result<DesktopState, String> {
    begin_drain(&app, DrainMode::Wait)
}

#[tauri::command]
fn quit_terminate(app: AppHandle) -> Result<DesktopState, String> {
    begin_drain(&app, DrainMode::Terminate)
}

#[tauri::command]
fn quit_cancel(state: tauri::State<'_, AppState>) -> Result<DesktopState, String> {
    state.quit.lock().unwrap().cancel().map_err(str::to_owned)?;
    let bridge = state
        .bridge
        .lock()
        .unwrap()
        .as_ref()
        .cloned()
        .ok_or_else(|| "Desktop runtime is not available.".to_string())?;
    bridge.emit_state();
    Ok(bridge.snapshot())
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
            stop_run,
            get_run_result,
            quit_wait,
            quit_terminate,
            quit_cancel
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                match native_close_requested(window.app_handle()) {
                    CloseDecision::Prevent => api.prevent_close(),
                    CloseDecision::ShutdownNow => {
                        api.prevent_close();
                        approve_and_exit(window.app_handle());
                    }
                    CloseDecision::Allow => {}
                }
            }
        })
        .setup(|app| {
            let _ = replace_bridge(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build AdaptiveAgent desktop");

    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            match native_close_requested(app) {
                CloseDecision::Prevent => api.prevent_exit(),
                CloseDecision::ShutdownNow => {
                    api.prevent_exit();
                    approve_and_exit(app);
                }
                CloseDecision::Allow => {}
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

fn reconciliation_classification(
    inspection: &Response,
    previous_occupancy: bool,
    root_created: bool,
    definitely_absent: bool,
) -> RunState {
    match inspection {
        Ok(value)
            if value.get("run").is_some_and(Value::is_null)
                && value
                    .get("events")
                    .and_then(Value::as_array)
                    .is_some_and(Vec::is_empty)
                && !root_created
                && definitely_absent =>
        {
            submission_failed()
        }
        Ok(value) => value
            .pointer("/run/status")
            .and_then(Value::as_str)
            .map(|status| state_for_durable_status(status, previous_occupancy))
            .unwrap_or_else(|| recovery_required(previous_occupancy)),
        Err(error)
            if !root_created
                && definitely_absent
                && error.to_ascii_lowercase().contains("not found") =>
        {
            submission_failed()
        }
        Err(_) => recovery_required(previous_occupancy),
    }
}

fn submission_failed() -> RunState {
    RunState {
        cached_status: "submission_failed",
        submission_state: "submission_failed",
        pending_interaction: None,
        occupies_slot: false,
        proves_existing: false,
    }
}

fn recovered_result(inspection: &Response) -> Option<Value> {
    inspection
        .as_ref()
        .ok()
        .and_then(|value| value.pointer("/run/result"))
        .cloned()
}

fn recovery_required(previous_occupancy: bool) -> RunState {
    RunState {
        cached_status: "recovery_required",
        submission_state: "recovery_required",
        pending_interaction: None,
        occupies_slot: previous_occupancy,
        proves_existing: false,
    }
}

struct RunState {
    cached_status: &'static str,
    submission_state: &'static str,
    pending_interaction: Option<&'static str>,
    occupies_slot: bool,
    proves_existing: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ApplyState {
    Accepted,
    Stale,
    Rejected,
}

fn apply_run_state(
    record: &mut RunRecord,
    state: &RunState,
    expected_revision: Option<u64>,
) -> ApplyState {
    if expected_revision.is_some_and(|revision| revision != record.revision) {
        return ApplyState::Stale;
    }
    // Once quiescent evidence has been accepted, delayed active/recovery evidence cannot revive it.
    if !record.occupies_slot && state.occupies_slot {
        return ApplyState::Rejected;
    }
    record.cached_status = state.cached_status.into();
    record.submission_state = state.submission_state.into();
    record.pending_interaction = state.pending_interaction.map(str::to_owned);
    record.occupies_slot = state.occupies_slot;
    if state.proves_existing {
        record.root_created = true;
    }
    record.revision += 1;
    ApplyState::Accepted
}

fn state_for_execution_result(result: &Value) -> RunState {
    match result.get("status").and_then(Value::as_str) {
        Some("success") => state_for_durable_status("succeeded", true),
        Some("failure") => match result.get("code").and_then(Value::as_str) {
            Some("INTERRUPTED") => state_for_durable_status("interrupted", true),
            Some("REPLAN_REQUIRED") => state_for_durable_status("replan_required", true),
            _ => state_for_durable_status("failed", true),
        },
        Some("approval_requested") => state_for_durable_status("awaiting_approval", true),
        Some("clarification_requested") => {
            state_for_durable_status("clarification_requested", true)
        }
        _ => recovery_required(true),
    }
}

fn state_for_durable_status(status: &str, previous_occupancy: bool) -> RunState {
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
        submission_state: if quiescent {
            "terminal"
        } else if matches!(
            status,
            "queued" | "planning" | "running" | "awaiting_subagent" | "awaiting_approval"
        ) {
            "durable"
        } else {
            "recovery_required"
        },
        pending_interaction: (status == "awaiting_approval").then_some("approval"),
        occupies_slot: if quiescent {
            false
        } else if matches!(
            status,
            "queued" | "planning" | "running" | "awaiting_subagent" | "awaiting_approval"
        ) {
            true
        } else {
            previous_occupancy
        },
        proves_existing: quiescent
            || matches!(
                status,
                "queued" | "planning" | "running" | "awaiting_subagent" | "awaiting_approval"
            ),
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
        let missing =
            reconciliation_classification(&Err("Run not found".into()), true, false, true);
        assert_eq!(missing.cached_status, "submission_failed");
        let succeeded = reconciliation_classification(
            &Ok(json!({ "run": { "status": "succeeded", "result": "done" } })),
            true,
            true,
            false,
        );
        assert_eq!(succeeded.cached_status, "succeeded");
        assert!(!succeeded.occupies_slot);
        let running = reconciliation_classification(
            &Ok(json!({ "run": { "status": "running" } })),
            true,
            true,
            false,
        );
        assert_eq!(running.cached_status, "running");
        assert!(running.occupies_slot);
        let unavailable =
            reconciliation_classification(&Err("transport unavailable".into()), true, true, false);
        assert_eq!(unavailable.cached_status, "recovery_required");
        assert!(unavailable.occupies_slot);
    }

    #[test]
    fn unknown_and_absent_inspection_semantics() {
        assert!(state_for_durable_status("future_status", true).occupies_slot);
        assert!(!state_for_durable_status("future_status", false).occupies_slot);
        let absent = Ok(json!({ "run": null, "events": [] }));
        assert!(reconciliation_classification(&absent, true, false, false).occupies_slot);
        let startup = reconciliation_classification(&absent, true, false, true);
        assert_eq!(startup.submission_state, "submission_failed");
        assert!(!startup.occupies_slot);
        assert!(reconciliation_classification(&absent, true, true, true).occupies_slot);
    }

    #[test]
    fn guarded_state_application_is_revision_checked_and_monotonic() {
        let mut record = registry::tests_record_for_transition();
        let revision = record.revision;
        record.revision += 1;
        let terminal = state_for_durable_status("succeeded", true);
        assert_eq!(
            apply_run_state(&mut record, &terminal, Some(revision)),
            ApplyState::Stale
        );
        assert!(record.occupies_slot);
        assert_eq!(
            apply_run_state(&mut record, &terminal, None),
            ApplyState::Accepted
        );
        let running = state_for_durable_status("running", false);
        assert_eq!(
            apply_run_state(&mut record, &running, None),
            ApplyState::Rejected
        );
        assert_eq!(record.cached_status, "succeeded");
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

    #[test]
    fn lost_response_recovery_reads_final_output_from_execution_inspection() {
        let inspection = Ok(json!({
            "run": {
                "id": "run-1",
                "status": "succeeded",
                "result": { "answer": 42 }
            }
        }));
        assert_eq!(recovered_result(&inspection), Some(json!({ "answer": 42 })));
        assert_eq!(recovered_result(&Err("transport unavailable".into())), None);
    }
}
