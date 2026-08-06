use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
mod registry;
mod shutdown;
mod workbench;
use registry::{CancelAction, RunRecord, RunRegistry, CAPACITY};
use shutdown::{CloseDecision, QuitCoordinator, QuitState};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
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
use workbench::{
    now, ChatItem, ChatMessage, PendingApproval, PendingRunRecovery, Reservation, WorkbenchDb,
};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_NDJSON_FRAME_SIZE: usize = 1024 * 1024;
const TRACE_MAX_NDJSON_FRAME_SIZE: usize = 8 * 1024 * 1024;
const TRACE_PRIVACY_SETTING: &str = "trace_privacy";

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
    title: String,
    created_at: String,
    invocation_kind: String,
    status: String,
    cancel_requested: bool,
    occupies_slot: bool,
    steerable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pending_approval: Option<PendingApproval>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartedRun {
    item_id: String,
    run_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatDto {
    #[serde(flatten)]
    chat: ChatItem,
    messages: Vec<ChatMessage>,
    read_only_reason: Option<String>,
    occupied: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
enum ProductDeletionTarget {
    Item { item_id: String },
    Run { run_id: String },
    ChatTurn { item_id: String, ordinal: i64 },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeletionPreview {
    target: ProductDeletionTarget,
    label: String,
    run_count: usize,
    plan_count: usize,
    occupied: bool,
    warning: &'static str,
}

#[derive(Serialize)]
struct WorkspaceArtifact {
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactPreview {
    name: String,
    kind: &'static str,
    mime_type: &'static str,
    content: String,
}

struct Bridge {
    app: AppHandle,
    child: Mutex<Option<CommandChild>>,
    pending: Mutex<HashMap<u64, Sender<Response>>>,
    decoder: Mutex<NdjsonDecoder>,
    generation: u64,
    next_id: AtomicU64,
    registry: Mutex<RunRegistry>,
    run_roots: Mutex<HashMap<String, String>>,
    run_delegates: Mutex<HashMap<String, String>>,
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
    trace_selection: Mutex<TraceSelection>,
    trace_refreshes: Mutex<HashMap<String, TraceRefreshState>>,
}

#[derive(Default)]
struct TraceSelection {
    root_run_id: Option<String>,
    revision: u64,
}

#[derive(Default)]
struct TraceRefreshState {
    pending: bool,
    final_refresh: bool,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct TracePrivacy {
    messages: bool,
    reasoning: bool,
    raw_tool_payloads: bool,
}

struct TraceBridge {
    app: AppHandle,
    child: Mutex<Option<CommandChild>>,
    pending: Mutex<HashMap<u64, Sender<Response>>>,
    decoder: Mutex<NdjsonDecoder>,
    next_id: AtomicU64,
    request_gate: Mutex<()>,
    healthy: Arc<AtomicBool>,
    error: Arc<Mutex<Option<String>>>,
    expected_shutdown: AtomicBool,
}

impl TraceBridge {
    fn spawn_process(
        app: &AppHandle,
        sqlite_path: &str,
        privacy: TracePrivacy,
        healthy: Arc<AtomicBool>,
        error: Arc<Mutex<Option<String>>>,
    ) -> Result<Arc<Self>, String> {
        let mut arguments = vec!["--sqlite-path".to_string(), sqlite_path.to_string()];
        if privacy.messages || privacy.reasoning {
            arguments.push("--allow-messages".into());
        }
        if privacy.reasoning {
            arguments.push("--allow-reasoning".into());
        }
        if privacy.raw_tool_payloads {
            arguments.push("--allow-raw-tool-payloads".into());
        }
        let (mut events, child) = app
            .shell()
            .sidecar("trace-session-sidecar")
            .map_err(|e| format!("Unable to locate trace sidecar: {e}"))?
            .args(arguments)
            .spawn()
            .map_err(|e| format!("Unable to start trace sidecar: {e}"))?;
        let sidecar = Arc::new(Self {
            app: app.clone(),
            child: Mutex::new(Some(child)),
            pending: Mutex::new(HashMap::new()),
            decoder: Mutex::new(NdjsonDecoder::new(TRACE_MAX_NDJSON_FRAME_SIZE)),
            next_id: AtomicU64::new(1),
            request_gate: Mutex::new(()),
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

    fn initialize(&self, privacy: TracePrivacy) -> Result<(), String> {
        let initialized=match self.request_wait("initialize",Some(json!({"protocolVersion":"1.0","clientInfo":{"name":"adaptive-agent-desktop","version":"0.1.0"}})),REQUEST_TIMEOUT){Ok(value)=>value,Err(error)=>{self.fail(&error);return Err(error)}};
        if initialized.get("protocolVersion").and_then(Value::as_str) != Some("1.0") {
            let error = "Trace sidecar did not negotiate protocol 1.0.".to_string();
            self.fail(&error);
            return Err(error);
        }
        if initialized
            .pointer("/backend/readOnly")
            .and_then(Value::as_bool)
            != Some(true)
            || initialized
                .pointer("/capabilities/messages")
                .and_then(Value::as_bool)
                != Some(privacy.messages || privacy.reasoning)
            || initialized
                .pointer("/capabilities/reasoning")
                .and_then(Value::as_bool)
                != Some(privacy.reasoning)
            || initialized
                .pointer("/capabilities/rawToolPayloads")
                .and_then(Value::as_bool)
                != Some(privacy.raw_tool_payloads)
        {
            let error =
                "Trace sidecar capabilities do not match the trusted privacy policy.".to_string();
            self.fail(&error);
            return Err(error);
        }
        self.healthy.store(true, Ordering::SeqCst);
        self.emit_state();
        Ok(())
    }
    fn request_wait(&self, method: &str, params: Option<Value>, timeout: Duration) -> Response {
        let _request = self.request_gate.lock().unwrap();
        if self.expected_shutdown.load(Ordering::SeqCst) {
            return Err("Trace sidecar is shutting down.".into());
        }
        self.request_wait_serialized(method, params, timeout)
    }
    fn request_wait_serialized(
        &self,
        method: &str,
        params: Option<Value>,
        timeout: Duration,
    ) -> Response {
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
        if let Ok(_request) = self.request_gate.try_lock() {
            let _ = self.request_wait_serialized("shutdown", None, SHUTDOWN_TIMEOUT);
        }
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
            run_roots: Mutex::new(HashMap::new()),
            run_delegates: Mutex::new(HashMap::new()),
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
            bridge
                .run_roots
                .lock()
                .unwrap()
                .insert(saved.run_id.clone(), saved.run_id.clone());
            bridge.registry.lock().unwrap().insert(RunRecord {
                run_id: saved.run_id,
                item_id: saved.item_id,
                title: saved.title,
                created_at: saved.created_at,
                session_id: saved.session_id,
                invocation_kind: saved.invocation_kind,
                submission_state: saved.submission_state.clone(),
                cached_status: saved.cached_status.clone(),
                root_created: saved.submission_state == "durable"
                    || saved.submission_state == "created",
                cancel_requested: saved.cancel_requested,
                interrupt_pending: saved.interrupt_pending,
                request_active: false,
                revision: 0,
                pending_interaction: None,
                pending_approval: None,
                occupies_slot: !matches!(
                    saved.submission_state.as_str(),
                    "terminal" | "submission_failed"
                ),
            });
        }
        for approval in bridge.workbench.load_pending_approvals()? {
            bridge.run_roots.lock().unwrap().insert(
                approval.approval_run_id.clone(),
                approval.root_run_id.clone(),
            );
            if let Some(parent_run_id) = approval.parent_run_id.as_ref() {
                bridge
                    .run_roots
                    .lock()
                    .unwrap()
                    .insert(parent_run_id.clone(), approval.root_run_id.clone());
            }
            if let Some(root) = bridge
                .registry
                .lock()
                .unwrap()
                .get_mut(&approval.root_run_id)
            {
                root.pending_approval = Some(approval);
            }
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
        self.prime_run_roots();
        self.reconcile_saved_runs();
        self.recover_pending_run_operations();
        self.recover_pending_approval_operations();
        self.recover_deletion_jobs();
        Ok(())
    }

    fn recover_deletion_jobs(self: &Arc<Self>) {
        let Ok(jobs) = self.workbench.load_deletion_jobs() else {
            return;
        };
        for job in jobs {
            if let Err(error) = self.execute_deletion_job(&job) {
                let _ = self.workbench.fail_deletion_job(&job.id, &error);
            }
        }
    }

    fn recover_pending_run_operations(self: &Arc<Self>) {
        let Ok(operations) = self.workbench.load_run_recovery_operations() else {
            return;
        };
        for operation in operations {
            let bridge = self.clone();
            std::thread::spawn(move || bridge.recover_pending_run_operation(operation));
        }
    }

    fn recover_pending_run_operation(self: &Arc<Self>, operation: PendingRunRecovery) {
        let inspection = match self.inspect_for_recovery(&operation.run_id) {
            Ok(inspection) => inspection,
            Err(error) => {
                let _ = self.app.emit(
                    "adaptive-agent://control-error",
                    json!({"runId":operation.run_id,"error":format!("Unable to inspect pending recovery: {error}")}),
                );
                return;
            }
        };
        let status = inspection
            .pointer("/run/status")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let accepted = recovery_operation_was_accepted(&inspection, &operation);
        if accepted
            && matches!(
                status,
                "succeeded" | "failed" | "cancelled" | "interrupted" | "replan_required"
            )
        {
            self.reconcile_run(operation.run_id);
            return;
        }
        if matches!(status, "awaiting_approval" | "clarification_requested") {
            self.reconcile_run(operation.run_id);
            return;
        }
        if !pending_recovery_can_dispatch(accepted, &operation.requested_action, status) {
            let _ = self.app.emit(
                    "adaptive-agent://control-error",
                    json!({"runId":operation.run_id,"error":format!("Pending {} recovery requires reconciliation from runtime status {status}.",operation.requested_action)}),
                );
            return;
        }
        if let Err(error) = self.dispatch_same_run_recovery(&operation.run_id) {
            let _ = self.app.emit(
                "adaptive-agent://control-error",
                json!({"runId":operation.run_id,"error":format!("Unable to restore pending recovery: {error}")}),
            );
        }
    }

    fn reconcile_saved_runs(self: &Arc<Self>) {
        let ids = self.registry.lock().unwrap().ids_requiring_reconciliation();
        for run_id in ids {
            self.reconcile_run(run_id);
        }
    }

    fn prime_run_roots(&self) {
        let root_run_ids = self.registry.lock().unwrap().ids_requiring_reconciliation();
        for root_run_id in root_run_ids {
            let mut inspection = self.inspect_for_recovery(&root_run_id).ok();
            for _ in 0..16 {
                let Some(run) = inspection.as_ref().and_then(|value| value.get("run")) else {
                    break;
                };
                if let Some(run_id) = run.get("id").and_then(Value::as_str) {
                    self.run_roots
                        .lock()
                        .unwrap()
                        .insert(run_id.into(), root_run_id.clone());
                    if let Some(delegate_name) = run.get("delegateName").and_then(Value::as_str) {
                        self.run_delegates
                            .lock()
                            .unwrap()
                            .insert(run_id.into(), delegate_name.into());
                    }
                }
                let Some(child_run_id) = run
                    .get("currentChildRunId")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                else {
                    break;
                };
                self.run_roots
                    .lock()
                    .unwrap()
                    .insert(child_run_id.clone(), root_run_id.clone());
                inspection = self.inspect_for_recovery(&child_run_id).ok();
            }
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
                            !record.request_active
                                && !record.root_created
                                && matches!(
                                    record.submission_state.as_str(),
                                    "reserved" | "submitted"
                                ),
                        )
                    })
                    .unwrap_or((0, false, false, false));
                let inspection = bridge.inspect_for_recovery(&run_id);
                let mut state = reconciliation_classification(
                    &inspection,
                    previous,
                    root_created,
                    definitely_absent,
                );
                match bridge.workbench.get_run_recovery_operation(&run_id) {
                    Ok(Some(operation)) => {
                        let accepted = inspection
                            .as_ref()
                            .is_ok_and(|value| recovery_operation_was_accepted(value, &operation));
                        if !accepted && !state.occupies_slot {
                            state = recovery_required(true);
                        }
                    }
                    Ok(None) => {}
                    Err(error) => {
                        state = recovery_required(true);
                        let _ = bridge.app.emit(
                            "adaptive-agent://control-error",
                            json!({"runId":run_id,"error":format!("Unable to read pending recovery state: {error}")}),
                        );
                    }
                }
                let result = recovered_result(&inspection);
                let recovered_approval = bridge.discover_pending_approval(&run_id, &inspection);
                let chat_success = bridge
                    .registry
                    .lock()
                    .unwrap()
                    .get(&run_id)
                    .is_some_and(|record| record.invocation_kind == "chat")
                    && state.cached_status == "succeeded";
                if chat_success {
                    let finalized = result
                        .as_ref()
                        .ok_or_else(|| "A succeeded chat has no durable /run/result.".to_string())
                        .and_then(|result| {
                            let output = response_assistant_value(result).ok_or_else(|| {
                                "A succeeded chat has no durable output.".to_string()
                            })?;
                            bridge
                                .workbench
                                .finalize_chat_success(&run_id, result, &value_as_content(&output))
                                .map(|_| ())
                        });
                    if let Err(error) = finalized {
                        state = recovery_required(true);
                        let _=bridge.app.emit("adaptive-agent://control-error",json!({"runId":run_id,"error":format!("Unable to reconcile successful chat turn: {error}")}));
                    }
                }
                let mut task_terminal_finalized = false;
                if !chat_success && !state.occupies_slot {
                    if let Some(result) = result.as_ref() {
                        match bridge.workbench.finalize_recovered_run(
                            &run_id,
                            result,
                            state.cached_status,
                            state.submission_state,
                        ) {
                            Ok(()) => task_terminal_finalized = true,
                            Err(error) => {
                                state = recovery_required(true);
                                let _ = bridge.app.emit(
                                    "adaptive-agent://control-error",
                                    json!({"runId":run_id,"error":format!("Unable to persist terminal run state: {error}")}),
                                );
                            }
                        }
                    }
                }
                let mut applied_quiescent = false;
                let mut stale = false;
                let mut persisted = None;
                let mut persist_approval = None;
                let mut clear_approval_id = None;
                let mut should_interrupt = false;
                if let Some(record) = bridge.registry.lock().unwrap().get_mut(&run_id) {
                    match apply_run_state(record, &state, Some(revision)) {
                        ApplyState::Accepted => {
                            applied_quiescent = !state.occupies_slot;
                            if let Some(mut approval) = recovered_approval.clone() {
                                preserve_approval_operation(
                                    &mut approval,
                                    record.pending_approval.as_ref(),
                                );
                                record.pending_approval = Some(approval.clone());
                                persist_approval = Some(approval);
                            } else if applied_quiescent {
                                clear_approval_id = record
                                    .pending_approval
                                    .as_ref()
                                    .map(|approval| approval.approval_id.clone());
                                record.pending_approval = None;
                            }
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
                let state_persisted = persisted
                    .map(|(status, submission)| {
                        bridge
                            .workbench
                            .update_run(&run_id, &status, &submission)
                            .is_ok()
                    })
                    .unwrap_or(false);
                if let Some(approval) = persist_approval {
                    let _ = bridge.workbench.save_pending_approval(&approval);
                } else if let Some(approval_id) = clear_approval_id {
                    let _ = bridge
                        .workbench
                        .clear_pending_approval(&run_id, Some(&approval_id));
                }
                let mut result_persisted = chat_success || task_terminal_finalized;
                if applied_quiescent && result.is_some() && !chat_success {
                    if !task_terminal_finalized {
                        match bridge
                            .workbench
                            .store_result(&run_id, result.as_ref().unwrap())
                        {
                            Ok(()) => result_persisted = true,
                            Err(error) => {
                                let _ = bridge.app.emit(
                                    "adaptive-agent://control-error",
                                    json!({"runId":run_id,"error":error}),
                                );
                            }
                        }
                    }
                }
                if applied_quiescent {
                    if state_persisted && result_persisted {
                        let _ = bridge.workbench.clear_run_recovery_operation(&run_id);
                    }
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

    fn recovery_plan(&self, run_id: &str) -> Result<Value, String> {
        self.request_wait(
            "run/recover",
            json!({ "runId": run_id, "dryRun": true }),
            Duration::from_secs(10),
        )
    }

    fn steer_run(&self, run_id: &str, message: &str) -> Result<(), String> {
        let registry = self.registry.lock().unwrap();
        let run = registry.get(run_id).ok_or("Run is not known.")?;
        if run.invocation_kind != "run"
            || !run.root_created
            || !run.occupies_slot
            || run.cancel_requested
        {
            return Err("Only an active task run can be steered.".into());
        }
        drop(registry);
        self.request_wait(
            "run/steer",
            json!({ "runId": run_id, "message": message }),
            Duration::from_secs(10),
        )?;
        Ok(())
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
        let request = (|| {
            let mut bytes = serde_json::to_vec(
                &json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }),
            )
            .map_err(|error| error.to_string())?;
            bytes.push(b'\n');
            self.child
                .lock()
                .unwrap()
                .as_mut()
                .ok_or_else(|| "The agent runtime is not running.".to_string())?
                .write(&bytes)
                .map_err(|_| "Unable to write to the agent runtime.".to_string())?;
            Ok(())
        })();
        if request.is_err() {
            self.pending.lock().unwrap().remove(&id);
        }
        request.map(|_| (id, receiver))
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
        let root_run_id = event
            .pointer("/payload/rootRunId")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| self.run_roots.lock().unwrap().get(run_id).cloned())
            .or_else(|| {
                self.registry
                    .lock()
                    .unwrap()
                    .get(run_id)
                    .map(|_| run_id.to_owned())
            });
        if let Some(root_run_id) = root_run_id {
            self.run_roots
                .lock()
                .unwrap()
                .insert(run_id.into(), root_run_id.clone());
            if kind == "run.created" {
                if let Some(delegate_name) = event
                    .pointer("/payload/delegateName")
                    .and_then(Value::as_str)
                {
                    self.run_delegates
                        .lock()
                        .unwrap()
                        .insert(run_id.into(), delegate_name.into());
                }
            } else if kind == "delegate.spawned" {
                if let (Some(child_run_id), Some(delegate_name)) = (
                    event.pointer("/payload/childRunId").and_then(Value::as_str),
                    event
                        .pointer("/payload/delegateName")
                        .and_then(Value::as_str),
                ) {
                    self.run_roots
                        .lock()
                        .unwrap()
                        .insert(child_run_id.into(), root_run_id.clone());
                    self.run_delegates
                        .lock()
                        .unwrap()
                        .insert(child_run_id.into(), delegate_name.into());
                }
            }
            let delegate_name = self.run_delegates.lock().unwrap().get(run_id).cloned();
            if let Some(projected) =
                project_activity_event(event, &root_run_id, delegate_name.as_deref())
            {
                let _ = self.app.emit("adaptive-agent://activity", projected);
            }
            if matches!(
                kind,
                "run.completed" | "run.failed" | "run.interrupted" | "replan.required"
            ) {
                schedule_trace_refresh(&self.app, root_run_id, true);
            }
        }
        let root_created = is_root_run_created(event);
        if kind == "approval.requested" {
            self.capture_pending_approval(event, run_id);
        }
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
                let chat_success = status == "succeeded"
                    && self
                        .registry
                        .lock()
                        .unwrap()
                        .get(run_id)
                        .is_some_and(|record| record.invocation_kind == "chat");
                if chat_success {
                    self.reconcile_run(run_id.to_owned());
                    self.emit_state();
                    return;
                }
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
    }

    fn capture_pending_approval(&self, value: &Value, fallback_root: &str) {
        let payload = value.get("payload").unwrap_or(value);
        let owner = value
            .get("runId")
            .or_else(|| payload.get("runId"))
            .and_then(Value::as_str)
            .unwrap_or(fallback_root);
        let root = payload
            .get("rootRunId")
            .and_then(Value::as_str)
            .unwrap_or(fallback_root);
        let Some(approval_id) = payload.get("approvalId").and_then(Value::as_str) else {
            return;
        };
        let mut approval = PendingApproval {
            root_run_id: root.into(),
            approval_run_id: owner.into(),
            approval_id: approval_id.into(),
            parent_run_id: payload
                .get("parentRunId")
                .and_then(Value::as_str)
                .map(str::to_owned),
            tool_name: payload
                .get("toolName")
                .and_then(Value::as_str)
                .unwrap_or("Tool")
                .into(),
            message: payload
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Approve this tool call?")
                .into(),
            decision_in_flight: false,
            decision: None,
            operation_state: "awaiting_decision".into(),
        };
        {
            let mut registry = self.registry.lock().unwrap();
            let Some(record) = registry.get_mut(root) else {
                return;
            };
            preserve_approval_operation(&mut approval, record.pending_approval.as_ref());
            record.revision += 1;
        }
        if self.workbench.save_pending_approval(&approval).is_ok() {
            if let Some(record) = self.registry.lock().unwrap().get_mut(root) {
                record.pending_approval = Some(approval);
                record.revision += 1;
            }
            self.emit_state();
        }
    }

    fn resolve_approval(
        self: &Arc<Self>,
        root_run_id: String,
        approval_run_id: String,
        approval_id: String,
        approved: bool,
    ) -> Result<(), String> {
        if !self.workbench.begin_approval_decision(
            &root_run_id,
            &approval_run_id,
            &approval_id,
            approved,
        )? {
            return Err("Approval is stale or a decision is already in flight.".into());
        }
        if let Some(p) = self
            .registry
            .lock()
            .unwrap()
            .get_mut(&root_run_id)
            .and_then(|r| r.pending_approval.as_mut())
        {
            p.decision_in_flight = true;
            p.decision = Some(approved);
            p.operation_state = "resolving".into();
        }
        if let Some(record) = self.registry.lock().unwrap().get_mut(&root_run_id) {
            record.revision += 1;
        }
        self.emit_state();
        self.drive_approval_operation(PendingApproval {
            root_run_id,
            approval_run_id,
            approval_id,
            parent_run_id: None,
            tool_name: String::new(),
            message: String::new(),
            decision_in_flight: true,
            decision: Some(approved),
            operation_state: "resolving".into(),
        });
        Ok(())
    }

    fn recover_pending_approval_operations(self: &Arc<Self>) {
        if let Ok(approvals) = self.workbench.load_pending_approvals() {
            for approval in approvals
                .into_iter()
                .filter(|approval| approval.operation_state != "awaiting_decision")
            {
                self.drive_approval_operation(approval);
            }
        }
    }

    fn drive_approval_operation(self: &Arc<Self>, approval: PendingApproval) {
        let bridge = self.clone();
        std::thread::spawn(move || {
            let root_run_id = approval.root_run_id;
            let approval_run_id = approval.approval_run_id;
            let approval_id = approval.approval_id;
            let Some(approved) = approval.decision else {
                return;
            };
            if approval.operation_state == "resolving" {
                let resolved = bridge.request_wait(
                    "interaction/resolveApproval",
                    json!({"runId":approval_run_id,"approvalId":approval_id,"approved":approved}),
                    REQUEST_TIMEOUT,
                );
                if let Err(error) = resolved {
                    let _ = bridge.app.emit(
                        "adaptive-agent://control-error",
                        json!({"runId":root_run_id,"error":format!("Approval outcome is unknown and will be retried after runtime restart: {error}")}),
                    );
                    bridge.reconcile_run(root_run_id.clone());
                    bridge.emit_state();
                    return;
                }
                let _ = bridge.workbench.mark_approval_resolved(
                    &root_run_id,
                    &approval_run_id,
                    &approval_id,
                    approved,
                );
                if let Some(p) = bridge
                    .registry
                    .lock()
                    .unwrap()
                    .get_mut(&root_run_id)
                    .and_then(|record| record.pending_approval.as_mut())
                {
                    p.operation_state = if approved {
                        "resume_pending".into()
                    } else {
                        "rejection_pending".into()
                    };
                }
            }
            if approved {
                match bridge.request("run/resume", json!({"runId":approval_run_id})) {
                    Ok((_, receiver)) => {
                        let bridge2 = bridge.clone();
                        let root = root_run_id.clone();
                        std::thread::spawn(move || {
                            match receiver.recv() {
                                Ok(Ok(_)) => bridge2.reconcile_run(root),
                                Ok(Err(error)) => {
                                    let _ = bridge2.app.emit(
                                        "adaptive-agent://control-error",
                                        json!({"runId":root,"error":error}),
                                    );
                                    bridge2.reconcile_run(root)
                                }
                                Err(_) => bridge2.reconcile_run(root),
                            };
                        });
                    }
                    Err(error) => {
                        let _ = bridge.app.emit(
                            "adaptive-agent://control-error",
                            json!({"runId":root_run_id,"error":error}),
                        );
                        bridge.reconcile_run(root_run_id.clone());
                    }
                }
            } else {
                bridge.reconcile_run(root_run_id.clone());
            }
            bridge.emit_state();
        });
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
        let created_at = now();
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
            created_at: created_at.clone(),
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
            title: task.clone(),
            created_at,
            session_id: None,
            invocation_kind: "run".into(),
            submission_state: "submitted".into(),
            cached_status: "submitted".into(),
            root_created: false,
            cancel_requested: false,
            interrupt_pending: false,
            request_active: true,
            revision: 0,
            pending_interaction: None,
            pending_approval: None,
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
                    let stored_result = canonical_workbench_result(&result);
                    let _ = bridge.workbench.store_result(&run_id, &stored_result);
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
                            json!({ "runId": run_id, "result": stored_result }),
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

    fn current_agent(&self) -> Result<(String, String, String), String> {
        let configuration = self
            .configuration
            .lock()
            .unwrap()
            .clone()
            .ok_or("Settings are invalid.")?;
        let agent = configuration
            .get("agent")
            .ok_or("Resolved agent is missing.")?;
        let value = |key: &str| {
            agent
                .get(key)
                .and_then(Value::as_str)
                .filter(|v| !v.trim().is_empty())
                .map(str::to_owned)
                .ok_or_else(|| format!("Resolved agent {key} is missing."))
        };
        Ok((
            value("id")?,
            value("name")?,
            value("configurationFingerprint")?,
        ))
    }

    fn chat_reason(&self, chat: &ChatItem) -> Option<String> {
        match self.current_agent() {
            Err(_) => Some("The pinned agent is not currently available; this chat is read-only.".into()),
            Ok((id,_,_)) if id != chat.pinned_agent_id => Some("The resolved agent ID no longer matches this chat's pin; this chat is read-only.".into()),
            Ok((_,_,fingerprint)) if fingerprint != chat.pinned_agent_fingerprint => Some("The resolved agent configuration fingerprint no longer matches this chat's pin; this chat is read-only.".into()),
            _ => None,
        }
    }

    fn chat_dto(&self, item_id: &str) -> Result<ChatDto, String> {
        let (chat, messages) = self.workbench.load_chat(item_id)?;
        Ok(ChatDto {
            read_only_reason: self.chat_reason(&chat),
            occupied: self.registry.lock().unwrap().item_is_occupied(item_id),
            chat,
            messages,
        })
    }

    fn deletion_operation(&self, target: &ProductDeletionTarget) -> Result<Value, String> {
        match target {
            ProductDeletionTarget::Item { item_id } => {
                self.workbench.item_deletion_operation(item_id)
            }
            ProductDeletionTarget::Run { run_id } => self.workbench.run_deletion_operation(run_id),
            ProductDeletionTarget::ChatTurn { item_id, ordinal } => self
                .workbench
                .chat_turn_deletion_operation(item_id, *ordinal),
        }
    }

    fn preview_deletion(
        self: &Arc<Self>,
        target: ProductDeletionTarget,
    ) -> Result<DeletionPreview, String> {
        let operation = self.deletion_operation(&target)?;
        let mut run_ids = HashSet::new();
        let mut plan_ids = HashSet::new();
        for runtime_target in operation["runtimeTargets"]
            .as_array()
            .ok_or("Deletion operation has no runtime targets.")?
        {
            let (_, receiver) =
                self.request("history/previewDeletion", json!({"target":runtime_target}))?;
            let response = receiver
                .recv_timeout(REQUEST_TIMEOUT)
                .map_err(|_| "History preview timed out.".to_string())??;
            for id in response["runIds"].as_array().into_iter().flatten() {
                if let Some(id) = id.as_str() {
                    run_ids.insert(id.to_owned());
                }
            }
            for field in ["ownedPlanIds", "preservedPlanIds"] {
                for id in response[field].as_array().into_iter().flatten() {
                    if let Some(id) = id.as_str() {
                        plan_ids.insert(id.to_owned());
                    }
                }
            }
        }
        let registry = self.registry.lock().unwrap();
        let occupied = run_ids
            .iter()
            .any(|id| registry.get(id).is_some_and(|record| record.occupies_slot));
        drop(registry);
        let label = match &target {
            ProductDeletionTarget::Item { .. } => operation["label"]
                .as_str()
                .ok_or("History item has no label.")?
                .to_owned(),
            ProductDeletionTarget::Run { run_id } => format!("run {run_id}"),
            ProductDeletionTarget::ChatTurn { ordinal, .. } => {
                format!("chat from turn {} onward", ordinal / 2 + 1)
            }
        };
        Ok(DeletionPreview {
            target,
            label,
            run_count: run_ids.len(),
            plan_count: plan_ids.len(),
            occupied,
            warning: "This permanently deletes the selected history and its runtime evidence. This cannot be undone.",
        })
    }

    fn execute_deletion_job(self: &Arc<Self>, job: &workbench::DeletionJob) -> Result<(), String> {
        for runtime_target in job.operation["runtimeTargets"]
            .as_array()
            .ok_or("Deletion operation has no runtime targets.")?
        {
            let (_, receiver) = self.request("history/delete", json!({"target":runtime_target}))?;
            receiver
                .recv_timeout(REQUEST_TIMEOUT)
                .map_err(|_| "History deletion timed out.".to_string())??;
        }
        self.workbench.complete_deletion_job(job)?;
        let roots = job.operation["workbenchRunIds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect::<HashSet<_>>();
        let affected = self
            .run_roots
            .lock()
            .unwrap()
            .iter()
            .filter(|(run_id, root_run_id)| roots.contains(*run_id) || roots.contains(*root_run_id))
            .map(|(run_id, _)| run_id.clone())
            .chain(roots.iter().cloned())
            .collect::<HashSet<_>>();
        let mut registry = self.registry.lock().unwrap();
        for run_id in &affected {
            registry.remove(run_id);
        }
        drop(registry);
        self.run_roots
            .lock()
            .unwrap()
            .retain(|run_id, _| !affected.contains(run_id));
        self.run_delegates
            .lock()
            .unwrap()
            .retain(|run_id, _| !affected.contains(run_id));
        self.reconciling
            .lock()
            .unwrap()
            .retain(|run_id, _| !affected.contains(run_id));
        Ok(())
    }

    fn delete_history(self: &Arc<Self>, target: ProductDeletionTarget) -> Result<(), String> {
        let preview = self.preview_deletion(target.clone())?;
        if preview.occupied {
            return Err("Stop or wait for every affected run before deleting history.".into());
        }
        let operation = self.deletion_operation(&target)?;
        let job = self.workbench.create_deletion_job(&operation)?;
        match self.execute_deletion_job(&job) {
            Ok(()) => {
                self.emit_state();
                Ok(())
            }
            Err(error) => {
                let _ = self.workbench.fail_deletion_job(&job.id, &error);
                Err(format!(
                    "Deletion is incomplete and will be retried safely: {error}"
                ))
            }
        }
    }

    fn send_chat(self: &Arc<Self>, item_id: String, content: String) -> Result<StartedRun, String> {
        let _submission = self.submission.lock().unwrap();
        if self.draining.load(Ordering::SeqCst) {
            return Err("The desktop is draining and cannot start new runs.".into());
        }
        let mut registry = self.registry.lock().unwrap();
        if !registry.has_capacity() {
            return Err(
                "All 3 task slots are occupied. Stop or wait for a run, then try again.".into(),
            );
        }
        if registry.item_is_occupied(&item_id) {
            return Err("This chat already has a turn in progress.".into());
        }
        let (chat, _) = self.workbench.load_chat(&item_id)?;
        if let Some(reason) = self.chat_reason(&chat) {
            return Err(reason);
        }
        let run_id = uuid::Uuid::new_v4().to_string();
        let messages = self
            .workbench
            .reserve_chat_turn(&item_id, &run_id, &content)?;
        registry.insert(RunRecord {
            run_id: run_id.clone(),
            item_id: item_id.clone(),
            title: chat.title.clone(),
            created_at: chat.created_at.clone(),
            session_id: Some(chat.session_id.clone()),
            invocation_kind: "chat".into(),
            submission_state: "submitted".into(),
            cached_status: "submitted".into(),
            root_created: false,
            cancel_requested: false,
            interrupt_pending: false,
            request_active: true,
            revision: 0,
            pending_interaction: None,
            pending_approval: None,
            occupies_slot: true,
        });
        drop(registry);
        if let Err(error) = self.workbench.update_run(&run_id, "submitted", "submitted") {
            let _ = self.app.emit("adaptive-agent://control-error", json!({"runId":run_id,"error":format!("The chat reservation is durable, but its redundant submitted update failed: {error}")}));
        }
        let transcript = messages
            .iter()
            .map(|message| json!({"role":message.role,"content":message.content}))
            .collect::<Vec<_>>();
        let receiver = match self.request(
            "agent/chat",
            chat_request_params(&run_id, &chat.session_id, transcript),
        ) {
            Ok((_, receiver)) => receiver,
            Err(error) => {
                if let Some(record) = self.registry.lock().unwrap().get_mut(&run_id) {
                    record.request_active = false;
                    record.revision += 1;
                }
                if self.workbench.mark_submission_failed(&run_id).is_ok() {
                    if let Some(record) = self.registry.lock().unwrap().get_mut(&run_id) {
                        let state = submission_failed();
                        apply_run_state(record, &state, None);
                    }
                } else {
                    let _=self.app.emit("adaptive-agent://control-error",json!({"runId":run_id,"error":"Unable to persist submission failure; retaining the occupied slot for recovery."}));
                    self.reconcile_run(run_id.clone());
                }
                self.emit_state();
                return Err(error);
            }
        };
        self.emit_state();
        let bridge = self.clone();
        let response_run_id = run_id.clone();
        std::thread::spawn(move || {
            let response = loop {
                match receiver.recv_timeout(Duration::from_secs(30)) {
                    Ok(response) => break response,
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        bridge.reconcile_run(response_run_id.clone())
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        break Err("The agent runtime exited before returning a result.".into())
                    }
                }
            };
            if let Some(record) = bridge.registry.lock().unwrap().get_mut(&response_run_id) {
                record.request_active = false;
                record.revision += 1;
            }
            match response {
                Ok(result) => {
                    let state = state_for_execution_result(&result);
                    let stored_result = canonical_workbench_result(&result);
                    if state.cached_status == "succeeded" {
                        let finalized = response_assistant_value(&stored_result)
                            .ok_or_else(|| {
                                "Successful chat response did not include output.".to_string()
                            })
                            .and_then(|output| {
                                let content = value_as_content(&output);
                                bridge
                                    .workbench
                                    .finalize_chat_success(
                                        &response_run_id,
                                        &stored_result,
                                        &content,
                                    )
                                    .map(|_| ())
                            });
                        if let Err(error) = finalized {
                            let _=bridge.app.emit("adaptive-agent://control-error",json!({"runId":response_run_id,"error":format!("Unable to finalize successful chat turn: {error}")}));
                            bridge.reconcile_run(response_run_id.clone());
                            bridge.emit_state();
                            return;
                        }
                    } else if let Err(error) = bridge
                        .workbench
                        .store_result(&response_run_id, &stored_result)
                    {
                        let _ = bridge.app.emit(
                            "adaptive-agent://control-error",
                            json!({"runId":response_run_id,"error":error}),
                        );
                    }
                    if let Some(record) = bridge.registry.lock().unwrap().get_mut(&response_run_id)
                    {
                        let _ = apply_run_state(record, &state, None);
                        if state.cached_status != "succeeded" {
                            if let Err(error) = bridge.workbench.update_run(
                                &response_run_id,
                                &record.cached_status,
                                &record.submission_state,
                            ) {
                                let _ = bridge.app.emit(
                                    "adaptive-agent://control-error",
                                    json!({"runId":response_run_id,"error":error}),
                                );
                            }
                        }
                    }
                    if !state.occupies_slot {
                        let _ = bridge.app.emit(
                            "adaptive-agent://run-finished",
                            json!({"runId":response_run_id,"result":stored_result}),
                        );
                    }
                }
                Err(error) => {
                    let _ = bridge.app.emit(
                        "adaptive-agent://control-error",
                        json!({"runId":response_run_id,"error":error}),
                    );
                    bridge.reconcile_run(response_run_id.clone());
                }
            }
            bridge.emit_state();
        });
        Ok(StartedRun { item_id, run_id })
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

    fn recover_run(
        self: &Arc<Self>,
        run_id: &str,
        expected_status: &str,
        expected_action: &str,
    ) -> Result<(), String> {
        let _submission = self.submission.lock().unwrap();
        if self.draining.load(Ordering::SeqCst) {
            return Err("The desktop is draining and cannot recover runs.".into());
        }
        if !self.registry.lock().unwrap().has_capacity() {
            return Err(
                "All 3 task slots are occupied. Stop or wait for a run, then try again.".into(),
            );
        }

        let plan = self.recovery_plan(run_id)?;
        let action = same_run_recovery_action(&plan, expected_status, expected_action)?;

        let previous = self
            .registry
            .lock()
            .unwrap()
            .get(run_id)
            .cloned()
            .ok_or("Run is not known.")?;
        if previous.invocation_kind != "run" {
            return Err("Only task runs can currently be recovered.".into());
        }
        let inspection = self.inspect_for_recovery(run_id)?;
        let baseline_event_seq = latest_inspection_event_seq(&inspection);
        self.workbench
            .begin_same_run_recovery(run_id, action, baseline_event_seq)?;
        if let Err(error) = self
            .registry
            .lock()
            .unwrap()
            .begin_same_run_recovery(run_id)
        {
            let _ = self.workbench.update_run(
                run_id,
                &previous.cached_status,
                &previous.submission_state,
            );
            return Err(error.into());
        }

        self.dispatch_same_run_recovery(run_id)
    }

    fn dispatch_same_run_recovery(self: &Arc<Self>, run_id: &str) -> Result<(), String> {
        let needs_activation = self
            .registry
            .lock()
            .unwrap()
            .get(run_id)
            .is_some_and(|record| !record.occupies_slot);
        if needs_activation {
            self.workbench.activate_pending_run_recovery(run_id)?;
            self.registry
                .lock()
                .unwrap()
                .begin_same_run_recovery(run_id)
                .map_err(str::to_owned)?;
        }
        {
            let mut registry = self.registry.lock().unwrap();
            let record = registry.get_mut(run_id).ok_or("Run is not known.")?;
            if record.request_active {
                return Err("Run recovery is already active.".into());
            }
            record.request_active = true;
            record.revision += 1;
        }
        let receiver = match self.request(
            "run/recover",
            json!({ "runId": run_id, "strategy": "same_run" }),
        ) {
            Ok((_request_id, receiver)) => receiver,
            Err(error) => {
                if let Some(record) = self.registry.lock().unwrap().get_mut(run_id) {
                    record.request_active = false;
                    record.revision += 1;
                }
                return Err(error);
            }
        };
        self.emit_state();
        let bridge = self.clone();
        let run_id = run_id.to_owned();
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
                    let stored_result = canonical_workbench_result(&result);
                    if !state.occupies_slot {
                        match bridge.workbench.finalize_recovered_run(
                            &run_id,
                            &stored_result,
                            state.cached_status,
                            state.submission_state,
                        ) {
                            Ok(()) => {
                                if let Some(record) =
                                    bridge.registry.lock().unwrap().get_mut(&run_id)
                                {
                                    let _ = apply_run_state(record, &state, None);
                                }
                                let _ = bridge.app.emit(
                                    "adaptive-agent://run-finished",
                                    json!({ "runId": run_id, "result": stored_result }),
                                );
                            }
                            Err(error) => {
                                let _ = bridge.app.emit(
                                    "adaptive-agent://control-error",
                                    json!({"runId":run_id,"error":format!("Unable to persist recovered run: {error}")}),
                                );
                                bridge.reconcile_run(run_id.clone());
                            }
                        }
                        bridge.emit_state();
                        return;
                    }
                    let _ = bridge.workbench.store_result(&run_id, &stored_result);
                    let mut accepted_quiescent = false;
                    if let Some(record) = bridge.registry.lock().unwrap().get_mut(&run_id) {
                        accepted_quiescent = apply_run_state(record, &state, None)
                            == ApplyState::Accepted
                            && !state.occupies_slot;
                    }
                    let state_persisted = if let Some(record) =
                        bridge.registry.lock().unwrap().get(&run_id)
                    {
                        bridge
                            .workbench
                            .update_run(&run_id, &record.cached_status, &record.submission_state)
                            .is_ok()
                    } else {
                        false
                    };
                    if !accepted_quiescent || !state_persisted {
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
        Ok(())
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

    fn discover_pending_approval(
        &self,
        root_run_id: &str,
        root_inspection: &Response,
    ) -> Option<PendingApproval> {
        let mut inspection = root_inspection.as_ref().ok()?.clone();
        for _ in 0..16 {
            let run = inspection.get("run")?;
            if let Some(run_id) = run.get("id").and_then(Value::as_str) {
                self.run_roots
                    .lock()
                    .unwrap()
                    .insert(run_id.into(), root_run_id.into());
                if let Some(delegate_name) = run.get("delegateName").and_then(Value::as_str) {
                    self.run_delegates
                        .lock()
                        .unwrap()
                        .insert(run_id.into(), delegate_name.into());
                }
            }
            match run.get("status").and_then(Value::as_str)? {
                "awaiting_approval" => {
                    return pending_approval_from_inspection(root_run_id, &inspection)
                }
                "awaiting_subagent" => {
                    let child_run_id = run.get("currentChildRunId").and_then(Value::as_str)?;
                    inspection = self.inspect_for_recovery(child_run_id).ok()?;
                }
                _ => return None,
            }
        }
        None
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
                title: run.title.clone(),
                created_at: run.created_at.clone(),
                invocation_kind: run.invocation_kind.clone(),
                status: run.cached_status.clone(),
                cancel_requested: run.cancel_requested,
                occupies_slot: run.occupies_slot,
                steerable: run.invocation_kind == "run"
                    && run.root_created
                    && run.occupies_slot
                    && !run.cancel_requested,
                pending_approval: run.pending_approval.clone(),
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
                run_roots: Mutex::new(HashMap::new()),
                run_delegates: Mutex::new(HashMap::new()),
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
                let privacy = match load_trace_privacy(&target.workbench) {
                    Ok(privacy) => privacy,
                    Err(error) => {
                        *target.trace_error.lock().unwrap() = Some(error);
                        target.emit_state();
                        return;
                    }
                };
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
                    privacy,
                    target.trace_healthy.clone(),
                    target.trace_error.clone(),
                ) {
                    Ok(trace) => {
                        *state.trace.lock().unwrap() = Some(trace.clone());
                        drop(lifecycle);
                        if let Err(error) = trace.initialize(privacy) {
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

fn load_trace_privacy(workbench: &WorkbenchDb) -> Result<TracePrivacy, String> {
    let mut privacy: TracePrivacy = workbench
        .load_setting(TRACE_PRIVACY_SETTING)?
        .map(serde_json::from_value)
        .transpose()
        .map_err(|error| format!("Invalid persisted trace privacy settings: {error}"))?
        .unwrap_or_default();
    if privacy.reasoning {
        privacy.messages = true;
    }
    Ok(privacy)
}

fn request_trace_report(trace: &TraceBridge, privacy: TracePrivacy, root_run_id: &str) -> Response {
    trace.request_wait(
        "trace/get",
        Some(json!({
            "target": { "kind": "root-run", "rootRunId": root_run_id },
            "include": {
                "plans": true,
                "messages": privacy.messages,
                "reasoning": privacy.reasoning,
                "rawToolPayloads": privacy.raw_tool_payloads
            }
        })),
        REQUEST_TIMEOUT,
    )
}

fn queue_trace_refresh(
    refreshes: &mut HashMap<String, TraceRefreshState>,
    root_run_id: &str,
    final_refresh: bool,
) -> bool {
    if let Some(refresh) = refreshes.get_mut(root_run_id) {
        refresh.pending = true;
        refresh.final_refresh |= final_refresh;
        return false;
    }
    refreshes.insert(
        root_run_id.into(),
        TraceRefreshState {
            pending: false,
            final_refresh,
        },
    );
    true
}

fn complete_trace_refresh(
    refreshes: &mut HashMap<String, TraceRefreshState>,
    root_run_id: &str,
) -> bool {
    if refreshes.get_mut(root_run_id).is_some_and(|refresh| {
        if refresh.pending {
            refresh.pending = false;
            true
        } else {
            false
        }
    }) {
        return true;
    }
    refreshes.remove(root_run_id);
    false
}

fn schedule_trace_refresh(app: &AppHandle, root_run_id: String, final_refresh: bool) {
    let state = app.state::<AppState>();
    {
        let mut refreshes = state.trace_refreshes.lock().unwrap();
        if !queue_trace_refresh(&mut refreshes, &root_run_id, final_refresh) {
            return;
        }
    }

    let app = app.clone();
    std::thread::spawn(move || loop {
        let final_refresh = app
            .state::<AppState>()
            .trace_refreshes
            .lock()
            .unwrap()
            .get_mut(&root_run_id)
            .is_some_and(|refresh| std::mem::take(&mut refresh.final_refresh));
        let (privacy, trace, request_revision) = {
            let state = app.state::<AppState>();
            let bridge = state.bridge.lock().unwrap().as_ref().cloned();
            let trace = state.trace.lock().unwrap().as_ref().cloned();
            let privacy = bridge
                .as_ref()
                .and_then(|bridge| load_trace_privacy(&bridge.workbench).ok());
            let selection = state.trace_selection.lock().unwrap();
            let request_revision = (selection.root_run_id.as_deref() == Some(root_run_id.as_str()))
                .then_some(selection.revision);
            (privacy, trace, request_revision)
        };
        let response = match (privacy, trace.as_ref()) {
            (Some(privacy), Some(trace)) => request_trace_report(trace, privacy, &root_run_id),
            _ => Err("Trace inspector is not ready.".into()),
        };
        let state = app.state::<AppState>();
        let selection = state.trace_selection.lock().unwrap();
        if request_revision == Some(selection.revision)
            && selection.root_run_id.as_deref() == Some(root_run_id.as_str())
        {
            let payload = match response.as_ref() {
                Ok(report) => json!({
                    "rootRunId": root_run_id,
                    "revision": selection.revision,
                    "finalRefresh": final_refresh,
                    "report": report
                }),
                Err(error) => json!({
                    "rootRunId": root_run_id,
                    "revision": selection.revision,
                    "finalRefresh": final_refresh,
                    "error": error
                }),
            };
            let _ = app.emit("adaptive-agent://trace", payload);
        }
        drop(selection);
        if let Ok(report) = response {
            let _ = app.emit(
                "adaptive-agent://trace-summary",
                json!({
                    "rootRunId": root_run_id,
                    "summary": report.get("summary"),
                    "usage": report.get("usage"),
                    "rootRuns": report.get("rootRuns")
                }),
            );
        }

        let mut refreshes = state.trace_refreshes.lock().unwrap();
        if complete_trace_refresh(&mut refreshes, &root_run_id) {
            continue;
        }
        break;
    });
}

#[tauri::command]
fn select_trace(root_run_id: Option<String>, app: AppHandle) -> Result<u64, String> {
    let state = app.state::<AppState>();
    let revision = {
        let mut selection = state.trace_selection.lock().unwrap();
        selection.revision += 1;
        selection.root_run_id = root_run_id.clone();
        selection.revision
    };
    let Some(root_run_id) = root_run_id else {
        return Ok(revision);
    };
    schedule_trace_refresh(&app, root_run_id.clone(), false);
    let app = app.clone();
    std::thread::spawn(move || {
        let mut tick = 0_u64;
        loop {
            std::thread::sleep(Duration::from_millis(1_500));
            let state = app.state::<AppState>();
            let selected = {
                let selection = state.trace_selection.lock().unwrap();
                selection.revision == revision
                    && selection.root_run_id.as_deref() == Some(root_run_id.as_str())
            };
            if !selected || state.shutdown_started.load(Ordering::SeqCst) {
                break;
            }
            tick += 1;
            let active = state.bridge.lock().unwrap().as_ref().is_some_and(|bridge| {
                bridge
                    .registry
                    .lock()
                    .unwrap()
                    .get(&root_run_id)
                    .is_some_and(|run| run.occupies_slot)
            });
            if active || tick % 7 == 0 {
                schedule_trace_refresh(&app, root_run_id.clone(), false);
            }
            if tick % 7 == 0 {
                let roots = state
                    .bridge
                    .lock()
                    .unwrap()
                    .as_ref()
                    .map(|bridge| {
                        bridge
                            .registry
                            .lock()
                            .unwrap()
                            .records()
                            .map(|run| run.run_id.clone())
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                let background = roots
                    .into_iter()
                    .filter(|root| root != &root_run_id)
                    .collect::<Vec<_>>();
                if let Some(root) = background.get((tick as usize / 7) % background.len().max(1)) {
                    schedule_trace_refresh(&app, root.clone(), false);
                }
            }
        }
    });
    Ok(revision)
}

#[tauri::command]
fn get_trace_privacy(state: tauri::State<'_, AppState>) -> Result<TracePrivacy, String> {
    let bridge = state
        .bridge
        .lock()
        .unwrap()
        .as_ref()
        .cloned()
        .ok_or("Desktop runtime is starting.")?;
    load_trace_privacy(&bridge.workbench)
}

#[tauri::command]
fn set_trace_privacy(mut privacy: TracePrivacy, app: AppHandle) -> Result<TracePrivacy, String> {
    if privacy.reasoning {
        privacy.messages = true;
    }
    let state = app.state::<AppState>();
    let (bridge, sqlite_path, old_trace) = {
        let _lifecycle = state.lifecycle.lock().unwrap();
        let bridge = state
            .bridge
            .lock()
            .unwrap()
            .as_ref()
            .cloned()
            .ok_or("Desktop runtime is starting.")?;
        let sqlite_path = bridge
            .configuration
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|value| value.pointer("/runtime/sqlitePath"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or("Trace requires an exact SQLite path.")?;
        let old_trace = state.trace.lock().unwrap().as_ref().cloned();
        (bridge, sqlite_path, old_trace)
    };
    if load_trace_privacy(&bridge.workbench)? == privacy && old_trace.is_some() {
        return Ok(privacy);
    }
    let (stopped_trace, selected_root) = {
        let _lifecycle = state.lifecycle.lock().unwrap();
        if state
            .bridge
            .lock()
            .unwrap()
            .as_ref()
            .is_none_or(|current| !Arc::ptr_eq(current, &bridge))
        {
            return Err("Execution runtime changed while trace privacy was updating.".into());
        }
        let stopped_trace = state.trace.lock().unwrap().take();
        let mut selection = state.trace_selection.lock().unwrap();
        selection.revision += 1;
        (stopped_trace, selection.root_run_id.clone())
    };
    bridge.trace_healthy.store(false, Ordering::SeqCst);
    *bridge.trace_error.lock().unwrap() = None;
    bridge.emit_state();
    if let Some(stopped_trace) = stopped_trace {
        stopped_trace.shutdown();
    }

    let replacement = match TraceBridge::spawn_process(
        &app,
        &sqlite_path,
        privacy,
        bridge.trace_healthy.clone(),
        bridge.trace_error.clone(),
    ) {
        Ok(replacement) => replacement,
        Err(error) => {
            *bridge.trace_error.lock().unwrap() = Some(error.clone());
            bridge.emit_state();
            return Err(error);
        }
    };
    if let Err(error) = replacement.initialize(privacy) {
        replacement.shutdown();
        return Err(error);
    }
    if let Err(error) = bridge.workbench.save_setting(
        TRACE_PRIVACY_SETTING,
        &serde_json::to_value(privacy).unwrap(),
    ) {
        replacement.shutdown();
        *bridge.trace_error.lock().unwrap() = Some(error.clone());
        bridge.emit_state();
        return Err(error);
    }
    let runtime_changed = {
        let _lifecycle = state.lifecycle.lock().unwrap();
        if state
            .bridge
            .lock()
            .unwrap()
            .as_ref()
            .is_none_or(|current| !Arc::ptr_eq(current, &bridge))
        {
            true
        } else {
            *state.trace.lock().unwrap() = Some(replacement.clone());
            false
        }
    };
    if runtime_changed {
        replacement.shutdown();
        return Err("Execution runtime changed while trace privacy was updating.".into());
    }
    bridge.trace_healthy.store(true, Ordering::SeqCst);
    *bridge.trace_error.lock().unwrap() = None;
    bridge.emit_state();
    if let Some(root_run_id) = selected_root {
        let _ = select_trace(Some(root_run_id), app.clone());
    }
    Ok(privacy)
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
fn get_run_recovery_plan(
    run_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Value, String> {
    state
        .bridge
        .lock()
        .unwrap()
        .as_ref()
        .cloned()
        .ok_or_else(|| "Desktop runtime is not available.".to_string())?
        .recovery_plan(&run_id)
}

#[tauri::command]
fn recover_run(
    run_id: String,
    expected_status: String,
    expected_action: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    if state.quit.lock().unwrap().state() != QuitState::Idle {
        return Err("The desktop is quitting and cannot recover runs.".into());
    }
    state
        .bridge
        .lock()
        .unwrap()
        .as_ref()
        .cloned()
        .ok_or_else(|| "Desktop runtime is not available.".to_string())?
        .recover_run(&run_id, &expected_status, &expected_action)
}

#[tauri::command]
fn steer_run(
    run_id: String,
    message: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    if message.trim().is_empty() {
        return Err("A steering message is required.".into());
    }
    state
        .bridge
        .lock()
        .unwrap()
        .as_ref()
        .cloned()
        .ok_or_else(|| "Desktop runtime is not available.".to_string())?
        .steer_run(&run_id, message.trim())
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

#[tauri::command]
fn get_run_overview(run_id: String, state: tauri::State<'_, AppState>) -> Result<Value, String> {
    let (privacy, trace) = {
        let bridge = state
            .bridge
            .lock()
            .unwrap()
            .as_ref()
            .cloned()
            .ok_or("Desktop runtime is starting.")?;
        if bridge.registry.lock().unwrap().get(&run_id).is_none() {
            return Err("Run was not found.".into());
        }
        let privacy = load_trace_privacy(&bridge.workbench)?;
        let trace = state
            .trace
            .lock()
            .unwrap()
            .as_ref()
            .cloned()
            .ok_or("Trace inspector is not ready.")?;
        (privacy, trace)
    };
    request_trace_report(&trace, privacy, &run_id)
}

const ARTIFACT_EXTENSIONS: &[&str] = &[
    "pdf", "csv", "json", "md", "markdown", "txt", "log", "xml", "yaml", "yml", "png", "jpg",
    "jpeg", "svg", "htm", "html", "doc", "docx", "xls", "xlsx", "zip", "gif", "webp", "bmp", "mp4",
    "webm", "mov", "m4v", "ogv",
];
const MAX_TEXT_PREVIEW_BYTES: u64 = 5 * 1024 * 1024;
const MAX_MEDIA_PREVIEW_BYTES: u64 = 32 * 1024 * 1024;

fn workspace_paths(state: &tauri::State<'_, AppState>) -> Result<(PathBuf, PathBuf), String> {
    let bridge = state
        .bridge
        .lock()
        .unwrap()
        .as_ref()
        .cloned()
        .ok_or("Desktop runtime is starting.")?;
    let configuration = bridge.configuration.lock().unwrap();
    let root = configuration
        .as_ref()
        .and_then(|value| value.pointer("/workspace/root"))
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .ok_or("The configured workspace root is unavailable.")?;
    let shell_cwd = configuration
        .as_ref()
        .and_then(|value| value.pointer("/workspace/shellCwd"))
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| root.clone());
    Ok((root, shell_cwd))
}

fn collect_workspace_artifacts(directory: &Path, artifacts: &mut Vec<WorkspaceArtifact>) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            if matches!(
                entry.file_name().to_str(),
                Some(".git" | "node_modules" | "target")
            ) {
                continue;
            }
            collect_workspace_artifacts(&path, artifacts);
        } else if file_type.is_file()
            && path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| {
                    ARTIFACT_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str())
                })
        {
            artifacts.push(WorkspaceArtifact {
                path: path.to_string_lossy().into_owned(),
            });
        }
    }
}

fn resolve_artifact_path(
    root: &Path,
    shell_cwd: &Path,
    requested: &str,
) -> Result<PathBuf, String> {
    let root = root
        .canonicalize()
        .map_err(|_| "The configured workspace is unavailable.".to_string())?;
    let requested = Path::new(requested);
    let candidates = if requested.is_absolute() {
        vec![requested.to_path_buf()]
    } else {
        vec![shell_cwd.join(requested), root.join(requested)]
    };
    if let Some(path) = candidates.into_iter().find_map(|candidate| {
        let candidate = candidate.canonicalize().ok()?;
        (candidate.starts_with(&root) && candidate.is_file()).then_some(candidate)
    }) {
        return Ok(path);
    }
    if requested.components().count() == 1 {
        let mut artifacts = Vec::new();
        collect_workspace_artifacts(&root, &mut artifacts);
        let matches = artifacts
            .into_iter()
            .filter(|artifact| Path::new(&artifact.path).file_name() == requested.file_name())
            .collect::<Vec<_>>();
        if matches.len() == 1 {
            return Ok(PathBuf::from(&matches[0].path));
        }
    }
    Err("Artifact file was not found.".into())
}

#[tauri::command]
fn list_workspace_artifacts(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<WorkspaceArtifact>, String> {
    let (root, _) = workspace_paths(&state)?;
    let root = root
        .canonicalize()
        .map_err(|_| "The configured workspace is unavailable.".to_string())?;
    let mut artifacts = Vec::new();
    collect_workspace_artifacts(&root, &mut artifacts);
    artifacts.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(artifacts)
}

#[tauri::command]
async fn read_artifact(
    path: String,
    state: tauri::State<'_, AppState>,
) -> Result<ArtifactPreview, String> {
    let (root, shell_cwd) = workspace_paths(&state)?;
    let path = resolve_artifact_path(&root, &shell_cwd, &path)?;
    tauri::async_runtime::spawn_blocking(move || artifact_preview(&path))
        .await
        .map_err(|_| "Artifact preview could not be prepared.".to_string())?
}

fn artifact_preview(path: &Path) -> Result<ArtifactPreview, String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or("This artifact type cannot be previewed.")?;
    let (kind, mime_type, binary) = match extension.as_str() {
        "md" | "markdown" => ("markdown", "text/markdown", false),
        "htm" | "html" => ("html", "text/html", false),
        "json" => ("json", "application/json", false),
        "txt" | "csv" | "log" | "xml" | "yaml" | "yml" => ("text", "text/plain", false),
        "png" => ("image", "image/png", true),
        "jpg" | "jpeg" => ("image", "image/jpeg", true),
        "gif" => ("image", "image/gif", true),
        "webp" => ("image", "image/webp", true),
        "bmp" => ("image", "image/bmp", true),
        "svg" => ("image", "image/svg+xml", true),
        "mp4" | "m4v" => ("video", "video/mp4", true),
        "webm" => ("video", "video/webm", true),
        "mov" => ("video", "video/quicktime", true),
        "ogv" => ("video", "video/ogg", true),
        _ => return Err("This artifact type cannot be previewed in the app.".into()),
    };
    let max_size = if binary {
        MAX_MEDIA_PREVIEW_BYTES
    } else {
        MAX_TEXT_PREVIEW_BYTES
    };
    if path
        .metadata()
        .map_err(|_| "Artifact file was not found.")?
        .len()
        > max_size
    {
        return Err(if binary {
            "Media preview is limited to 32 MiB."
        } else {
            "Text preview is limited to 5 MiB."
        }
        .into());
    }
    let bytes = std::fs::read(path).map_err(|_| "Artifact file could not be read.")?;
    let content = if binary {
        BASE64.encode(bytes)
    } else {
        String::from_utf8(bytes).map_err(|_| "Artifact is not valid UTF-8 text.")?
    };
    Ok(ArtifactPreview {
        name: path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("Artifact")
            .to_owned(),
        kind,
        mime_type,
        content,
    })
}

#[tauri::command]
fn resolve_approval(
    root_run_id: String,
    approval_run_id: String,
    approval_id: String,
    approved: bool,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state
        .bridge
        .lock()
        .unwrap()
        .as_ref()
        .cloned()
        .ok_or("Desktop runtime is starting.")?
        .resolve_approval(root_run_id, approval_run_id, approval_id, approved)
}

#[tauri::command]
fn create_chat(title: String, state: tauri::State<'_, AppState>) -> Result<ChatDto, String> {
    let _lifecycle = state.lifecycle.lock().unwrap();
    if state.quit.lock().unwrap().state() != QuitState::Idle {
        return Err("The desktop is quitting and cannot create chats.".into());
    }
    let bridge = state
        .bridge
        .lock()
        .unwrap()
        .as_ref()
        .cloned()
        .ok_or("Desktop runtime is starting.")?;
    let (id, name, fingerprint) = bridge.current_agent()?;
    let chat = ChatItem {
        item_id: uuid::Uuid::new_v4().to_string(),
        title: if title.trim().is_empty() {
            "New chat".into()
        } else {
            title.trim().into()
        },
        created_at: now(),
        session_id: uuid::Uuid::new_v4().to_string(),
        pinned_agent_id: id,
        pinned_agent_name: name,
        pinned_agent_fingerprint: fingerprint,
    };
    bridge.workbench.create_chat(&chat)?;
    bridge.chat_dto(&chat.item_id)
}

#[tauri::command]
fn list_chats(state: tauri::State<'_, AppState>) -> Result<Vec<ChatDto>, String> {
    let bridge = state
        .bridge
        .lock()
        .unwrap()
        .as_ref()
        .cloned()
        .ok_or("Desktop runtime is starting.")?;
    bridge
        .workbench
        .list_chats()?
        .iter()
        .map(|chat| bridge.chat_dto(&chat.item_id))
        .collect()
}

#[tauri::command]
fn load_chat(item_id: String, state: tauri::State<'_, AppState>) -> Result<ChatDto, String> {
    state
        .bridge
        .lock()
        .unwrap()
        .as_ref()
        .cloned()
        .ok_or("Desktop runtime is starting.")?
        .chat_dto(&item_id)
}

#[tauri::command]
fn preview_history_deletion(
    target: ProductDeletionTarget,
    state: tauri::State<'_, AppState>,
) -> Result<DeletionPreview, String> {
    state
        .bridge
        .lock()
        .unwrap()
        .as_ref()
        .cloned()
        .ok_or("Desktop runtime is starting.")?
        .preview_deletion(target)
}

#[tauri::command]
fn delete_history(
    target: ProductDeletionTarget,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let _lifecycle = state.lifecycle.lock().unwrap();
    if state.quit.lock().unwrap().state() != QuitState::Idle {
        return Err("The desktop is quitting and cannot delete history.".into());
    }
    state
        .bridge
        .lock()
        .unwrap()
        .as_ref()
        .cloned()
        .ok_or("Desktop runtime is starting.")?
        .delete_history(target)
}

#[tauri::command]
fn send_chat_turn(
    item_id: String,
    content: String,
    state: tauri::State<'_, AppState>,
) -> Result<StartedRun, String> {
    if content.trim().is_empty() {
        return Err("Message is required.".into());
    }
    let _lifecycle = state.lifecycle.lock().unwrap();
    if state.quit.lock().unwrap().state() != QuitState::Idle {
        return Err("The desktop is quitting and cannot start new runs.".into());
    }
    state
        .bridge
        .lock()
        .unwrap()
        .as_ref()
        .cloned()
        .ok_or("Desktop runtime is starting.")?
        .send_chat(item_id, content.trim().into())
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
            get_run_recovery_plan,
            recover_run,
            steer_run,
            get_run_result,
            get_run_overview,
            list_workspace_artifacts,
            read_artifact,
            resolve_approval,
            create_chat,
            list_chats,
            load_chat,
            preview_history_deletion,
            delete_history,
            send_chat_turn,
            select_trace,
            get_trace_privacy,
            set_trace_privacy,
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
    let run = inspection.as_ref().ok()?.get("run")?;
    let run_id = run.get("id")?.as_str()?;
    match run.get("status")?.as_str()? {
        "succeeded" => Some(json!({
            "status": "success",
            "runId": run_id,
            "output": run.get("result").cloned().unwrap_or(Value::Null)
        })),
        "failed" | "interrupted" | "replan_required" | "cancelled" => Some(json!({
            "status": "failure",
            "runId": run_id,
            "error": run.get("errorMessage").and_then(Value::as_str).unwrap_or_else(|| match run.get("status").and_then(Value::as_str) {
                Some("interrupted") | Some("cancelled") => "Run interrupted",
                Some("replan_required") => "Replan required",
                _ => "Run failed",
            }),
            "code": run.get("errorCode").and_then(Value::as_str).unwrap_or_else(|| match run.get("status").and_then(Value::as_str) {
                Some("interrupted") | Some("cancelled") => "INTERRUPTED",
                Some("replan_required") => "REPLAN_REQUIRED",
                _ => "MODEL_ERROR",
            })
        })),
        _ => None,
    }
}

fn latest_inspection_event_seq(inspection: &Value) -> i64 {
    inspection
        .get("events")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|event| event.get("seq").and_then(Value::as_i64))
        .max()
        .unwrap_or(0)
}

fn recovery_operation_was_accepted(inspection: &Value, operation: &PendingRunRecovery) -> bool {
    let accepted_event = if operation.requested_action == "retry" {
        "run.retry_started"
    } else {
        "run.resumed"
    };
    inspection
        .get("events")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|event| {
            event.get("seq").and_then(Value::as_i64).unwrap_or(0) > operation.baseline_event_seq
                && event.get("type").and_then(Value::as_str) == Some(accepted_event)
        })
}

fn pending_recovery_can_dispatch(accepted: bool, requested_action: &str, status: &str) -> bool {
    accepted
        || matches!(
            (requested_action, status),
            ("retry", "failed")
                | ("resume", "interrupted")
                | (_, "queued" | "planning" | "running" | "awaiting_subagent")
        )
}

fn same_run_recovery_action(
    plan: &Value,
    expected_status: &str,
    expected_action: &str,
) -> Result<&'static str, String> {
    if plan.get("executable").and_then(Value::as_bool) != Some(true) {
        return Err(plan
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("Run cannot be recovered.")
            .into());
    }
    let status = plan.get("status").and_then(Value::as_str);
    let action = plan.get("action").and_then(Value::as_str);
    if status != Some(expected_status) || action != Some(expected_action) {
        return Err(
            "Run recovery capability changed; review the refreshed run before trying again.".into(),
        );
    }
    match (status, action) {
        (Some("interrupted"), Some("resume_same_run")) => Ok("resume"),
        (Some("failed"), Some("retry_same_run")) => Ok("retry"),
        (_, Some("continue_new_run")) => {
            Err("Continue as a new run is not available as a failed-run recovery control.".into())
        }
        _ => Err("Run recovery capability no longer matches its status.".into()),
    }
}

fn project_activity_event(
    event: &Value,
    root_run_id: &str,
    cached_delegate_name: Option<&str>,
) -> Option<Value> {
    let event_id = event.get("id").and_then(Value::as_str)?;
    let run_id = event.get("runId").and_then(Value::as_str)?;
    let sequence = event.get("seq").and_then(Value::as_u64)?;
    let kind = event.get("type").and_then(Value::as_str)?;
    let created_at = event.get("createdAt").and_then(Value::as_str)?;
    if !matches!(
        kind,
        "run.created"
            | "run.status_changed"
            | "run.interrupted"
            | "run.steered"
            | "run.resumed"
            | "run.retry_started"
            | "run.completed"
            | "run.failed"
            | "recovery.analyzed"
            | "run.continuation_created"
            | "context.refs.resolved"
            | "plan.created"
            | "plan.execution_started"
            | "step.started"
            | "step.completed"
            | "model.started"
            | "model.retry"
            | "model.tool_call_rejected"
            | "model.completed"
            | "model.failed"
            | "tool.started"
            | "tool.completed"
            | "tool.failed"
            | "delegate.spawned"
            | "approval.requested"
            | "approval.resolved"
            | "clarification.requested"
            | "usage.updated"
            | "snapshot.created"
            | "replan.required"
    ) {
        return None;
    }
    let payload = event.get("payload").and_then(Value::as_object);
    let mut projected = serde_json::Map::from_iter([
        ("eventId".into(), Value::String(event_id.into())),
        ("rootRunId".into(), Value::String(root_run_id.into())),
        ("runId".into(), Value::String(run_id.into())),
        ("seq".into(), Value::Number(sequence.into())),
        ("kind".into(), Value::String(kind.into())),
        ("createdAt".into(), Value::String(created_at.into())),
        (
            "message".into(),
            Value::String(activity_message(kind, payload).into()),
        ),
    ]);
    for key in ["stepId", "toolCallId"] {
        if let Some(value) = event.get(key).and_then(Value::as_str) {
            projected.insert(key.into(), Value::String(value.into()));
        }
    }
    if let Some(payload) = payload {
        for key in [
            "callId",
            "status",
            "toStatus",
            "fromStatus",
            "provider",
            "model",
            "toolName",
            "delegateName",
            "approvalId",
            "parentRunId",
            "startedAt",
            "failureKind",
        ] {
            if let Some(value) = payload.get(key).and_then(Value::as_str) {
                projected.insert(key.into(), Value::String(value.into()));
            }
        }
        if !projected.contains_key("toolName") {
            if let Some(value) = payload.get("requestedToolName").and_then(Value::as_str) {
                projected.insert("toolName".into(), Value::String(value.into()));
            }
        }
        if let Some(value) = payload.get("assistantContent").and_then(Value::as_str) {
            if !value.trim().is_empty() {
                projected.insert("assistantContent".into(), Value::String(value.into()));
            }
        }
        if let Some(context) = activity_tool_context(payload) {
            projected.insert("toolContext".into(), Value::String(context));
        }
        for key in [
            "durationMs",
            "attempt",
            "maxAttempts",
            "nextAttempt",
            "retryDelayMs",
            "statusCode",
        ] {
            if let Some(value) = payload.get(key).and_then(Value::as_f64) {
                if value.is_finite() && value >= 0.0 {
                    if let Some(number) = serde_json::Number::from_f64(value) {
                        projected.insert(key.into(), Value::Number(number));
                    }
                }
            }
        }
        for key in ["retryable", "timedOut", "approved"] {
            if let Some(value) = payload.get(key).and_then(Value::as_bool) {
                projected.insert(key.into(), Value::Bool(value));
            }
        }
        if matches!(kind, "model.retry" | "model.tool_call_rejected") {
            for key in ["reason", "phase"] {
                if let Some(value) = payload.get(key).and_then(Value::as_str) {
                    projected.insert(key.into(), Value::String(value.into()));
                }
            }
        }
    }
    if !projected.contains_key("delegateName") {
        if let Some(delegate_name) = cached_delegate_name {
            projected.insert("delegateName".into(), Value::String(delegate_name.into()));
        }
    }
    Some(Value::Object(projected))
}

fn activity_tool_context(payload: &serde_json::Map<String, Value>) -> Option<String> {
    let tool_name = payload
        .get("toolName")
        .or_else(|| payload.get("requestedToolName"))
        .and_then(Value::as_str)?
        .split('@')
        .next()?;
    let input = payload.get("input")?.as_object()?;
    let input = input
        .get("preview")
        .and_then(Value::as_object)
        .unwrap_or(input);

    let field = |key: &str| {
        input.get(key).and_then(|value| {
            value.as_str().or_else(|| {
                value
                    .as_object()
                    .and_then(|summary| summary.get("preview"))
                    .and_then(Value::as_str)
            })
        })
    };

    match tool_name {
        "web_search" => compact_activity_context(field("query"), 64),
        "read_web_page" | "fetch_page" => field("url").and_then(activity_domain),
        "shell_exec" => compact_activity_context(field("command"), 64),
        name if is_file_activity_tool(name) => field("path")
            .or_else(|| field("filePath"))
            .and_then(activity_basename),
        _ => None,
    }
}

fn is_file_activity_tool(name: &str) -> bool {
    matches!(
        name,
        "read_file"
            | "write_file"
            | "edit_file"
            | "apply_patch"
            | "search_files"
            | "list_directory"
            | "create_file"
            | "delete_file"
    )
}

fn compact_activity_context(value: Option<&str>, max_chars: usize) -> Option<String> {
    let compact = value?.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.is_empty() {
        return None;
    }
    if compact.chars().count() <= max_chars {
        return Some(compact);
    }
    Some(format!(
        "{}...",
        compact.chars().take(max_chars).collect::<String>()
    ))
}

fn activity_basename(value: &str) -> Option<String> {
    let compact = value.trim().trim_end_matches(['/', '\\']);
    let path = compact
        .rsplit_once('#')
        .map(|(_, suffix)| suffix.trim())
        .filter(|suffix| !suffix.is_empty())
        .unwrap_or(compact);
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path).trim();
    (!name.is_empty()).then(|| name.to_string())
}

fn activity_domain(value: &str) -> Option<String> {
    let compact = value.trim();
    if compact.is_empty() {
        return None;
    }
    let authority = compact
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(compact)
        .split(['/', '?', '#'])
        .next()
        .unwrap_or(compact)
        .rsplit('@')
        .next()
        .unwrap_or(compact);
    let host = authority.split(':').next().unwrap_or(authority);
    let host = host.strip_prefix("www.").unwrap_or(host);
    (!host.is_empty()).then(|| host.to_string())
}

fn activity_message(kind: &str, payload: Option<&serde_json::Map<String, Value>>) -> String {
    let name = |key: &str| {
        payload
            .and_then(|value| value.get(key))
            .and_then(Value::as_str)
    };
    match kind {
        "run.created" => "Run started".into(),
        "run.status_changed" => name("toStatus")
            .map(|status| format!("Run is {}", status.replace('_', " ")))
            .unwrap_or_else(|| "Run status changed".into()),
        "plan.created" => "Plan created".into(),
        "plan.execution_started" => "Plan started".into(),
        "step.started" => "Step started".into(),
        "step.completed" => "Step completed".into(),
        "model.started" => match (name("provider"), name("model")) {
            (Some(provider), Some(model)) => format!("Calling {provider} / {model}"),
            _ => "Model call started".into(),
        },
        "model.retry" => "Retrying model call".into(),
        "model.completed" => "Model call completed".into(),
        "model.failed" => "Model call failed".into(),
        "tool.started" => name("toolName")
            .map(|tool| format!("Running {tool}"))
            .unwrap_or_else(|| "Tool started".into()),
        "tool.completed" => name("toolName")
            .map(|tool| format!("{tool} completed"))
            .unwrap_or_else(|| "Tool completed".into()),
        "tool.failed" => name("toolName")
            .map(|tool| format!("{tool} failed"))
            .unwrap_or_else(|| "Tool failed".into()),
        "delegate.spawned" => name("delegateName")
            .map(|delegate| format!("Delegated to {delegate}"))
            .unwrap_or_else(|| "Delegate started".into()),
        "approval.requested" => payload
            .and_then(|value| value.get("message"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| name("toolName").map(|tool| format!("Approval required for {tool}")))
            .unwrap_or_else(|| "Approval required".into()),
        "approval.resolved" => match payload
            .and_then(|value| value.get("approved"))
            .and_then(Value::as_bool)
        {
            Some(true) => "Approval granted".into(),
            Some(false) => "Approval rejected".into(),
            None => "Approval resolved".into(),
        },
        "usage.updated" => "Usage updated".into(),
        "run.completed" => "Run completed".into(),
        "run.failed" => "Run failed".into(),
        "run.interrupted" => "Run interrupted".into(),
        "replan.required" => "Replan required".into(),
        _ => kind.replace('.', " "),
    }
}

fn pending_approval_from_inspection(
    root_run_id: &str,
    inspection: &Value,
) -> Option<PendingApproval> {
    let run = inspection.get("run")?;
    let owner_run_id = run.get("id").and_then(Value::as_str)?;
    let event = inspection
        .get("events")?
        .as_array()?
        .iter()
        .rev()
        .find(|event| event.get("type").and_then(Value::as_str) == Some("approval.requested"))?;
    let payload = event.get("payload")?;
    let approval_id = payload.get("approvalId").and_then(Value::as_str)?;
    Some(PendingApproval {
        root_run_id: root_run_id.into(),
        approval_run_id: owner_run_id.into(),
        approval_id: approval_id.into(),
        parent_run_id: run
            .get("parentRunId")
            .and_then(Value::as_str)
            .map(str::to_owned),
        tool_name: payload
            .get("toolName")
            .and_then(Value::as_str)
            .unwrap_or("Tool")
            .into(),
        message: payload
            .get("message")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| {
                let tool = payload
                    .get("toolName")
                    .and_then(Value::as_str)
                    .unwrap_or("this tool");
                format!("Approval required before invoking {tool}")
            }),
        decision_in_flight: false,
        decision: None,
        operation_state: "awaiting_decision".into(),
    })
}

fn preserve_approval_operation(approval: &mut PendingApproval, current: Option<&PendingApproval>) {
    if let Some(current) = current.filter(|current| current.approval_id == approval.approval_id) {
        approval.decision_in_flight = current.decision_in_flight;
        approval.decision = current.decision;
        approval.operation_state = current.operation_state.clone();
    }
}

fn response_assistant_value(result: &Value) -> Option<Value> {
    (result.get("status").and_then(Value::as_str) == Some("success"))
        .then(|| result.get("output"))
        .flatten()
        .cloned()
}

fn canonical_workbench_result(result: &Value) -> Value {
    match result.get("status").and_then(Value::as_str) {
        Some("success") => json!({
            "status": "success",
            "runId": result.get("runId").cloned().unwrap_or(Value::Null),
            "output": result.get("output").cloned().unwrap_or(Value::Null)
        }),
        Some("failure") => json!({
            "status": "failure",
            "runId": result.get("runId").cloned().unwrap_or(Value::Null),
            "error": if result.get("code").and_then(Value::as_str) == Some("INTERRUPTED") {
                Value::String("Run interrupted".into())
            } else {
                result.get("error").cloned().unwrap_or_else(|| Value::String("Run failed".into()))
            },
            "code": result.get("code").cloned().unwrap_or_else(|| Value::String("MODEL_ERROR".into()))
        }),
        _ => result.clone(),
    }
}

fn value_as_content(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| value.to_string())
}

fn chat_request_params(run_id: &str, session_id: &str, transcript: Vec<Value>) -> Value {
    json!({"runId":run_id,"sessionId":session_id,"transcript":transcript})
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
    fn workspace_artifacts_are_filtered_and_confined_to_the_workspace() {
        let workspace = tempfile::tempdir().unwrap();
        let nested = workspace.path().join("output");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("report.md"), "report").unwrap();
        std::fs::write(nested.join("source.ts"), "source").unwrap();
        std::fs::create_dir(workspace.path().join("node_modules")).unwrap();
        std::fs::write(workspace.path().join("node_modules/ignored.json"), "{}").unwrap();

        let mut artifacts = Vec::new();
        collect_workspace_artifacts(workspace.path(), &mut artifacts);
        assert_eq!(artifacts.len(), 1);
        assert!(artifacts[0].path.ends_with("report.md"));
        let preview = artifact_preview(&nested.join("report.md")).unwrap();
        assert_eq!(preview.kind, "markdown");
        assert_eq!(preview.mime_type, "text/markdown");
        assert_eq!(preview.content, "report");
        std::fs::write(
            nested.join("page.htm"),
            "<style>h1{color:red}</style><h1>Hello</h1>",
        )
        .unwrap();
        let html = artifact_preview(&nested.join("page.htm")).unwrap();
        assert_eq!(html.kind, "html");
        assert_eq!(html.mime_type, "text/html");
        std::fs::write(nested.join("image.png"), [1, 2]).unwrap();
        let image = artifact_preview(&nested.join("image.png")).unwrap();
        assert_eq!(image.kind, "image");
        assert_eq!(image.mime_type, "image/png");
        assert_eq!(image.content, "AQI=");
        assert_eq!(
            resolve_artifact_path(workspace.path(), workspace.path(), "output/report.md").unwrap(),
            nested.join("report.md").canonicalize().unwrap()
        );
        assert_eq!(
            resolve_artifact_path(workspace.path(), workspace.path(), "report.md").unwrap(),
            nested.join("report.md").canonicalize().unwrap()
        );
        std::fs::create_dir(workspace.path().join("archive")).unwrap();
        std::fs::write(workspace.path().join("archive/report.md"), "old report").unwrap();
        assert!(resolve_artifact_path(workspace.path(), workspace.path(), "report.md").is_err());

        let outside = tempfile::NamedTempFile::new().unwrap();
        assert!(resolve_artifact_path(
            workspace.path(),
            workspace.path(),
            outside.path().to_str().unwrap()
        )
        .is_err());
    }

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
        assert_eq!(
            recovered_result(&inspection),
            Some(json!({
                "status": "success",
                "runId": "run-1",
                "output": { "answer": 42 }
            }))
        );
        assert_eq!(recovered_result(&Err("transport unavailable".into())), None);

        let interrupted = Ok(json!({
            "run": { "id": "run-2", "status": "interrupted" }
        }));
        assert_eq!(
            recovered_result(&interrupted),
            Some(canonical_workbench_result(&json!({
                "status": "failure",
                "runId": "run-2",
                "error": "Run interrupted",
                "code": "INTERRUPTED",
                "stepsUsed": 1,
                "usage": {}
            })))
        );
    }

    #[test]
    fn pending_recovery_acceptance_uses_events_after_the_durable_baseline() {
        let operation = PendingRunRecovery {
            run_id: "run-1".into(),
            requested_action: "retry".into(),
            baseline_event_seq: 7,
        };
        let inspection = json!({
            "events": [
                {"seq": 5, "type": "run.retry_started"},
                {"seq": 8, "type": "run.status_changed"},
                {"seq": 9, "type": "run.retry_started"}
            ]
        });
        assert_eq!(latest_inspection_event_seq(&inspection), 9);
        assert!(recovery_operation_was_accepted(&inspection, &operation));
        let before_acceptance = json!({"events":[{"seq":5,"type":"run.retry_started"}]});
        assert!(!recovery_operation_was_accepted(
            &before_acceptance,
            &operation
        ));
    }

    #[test]
    fn pending_recovery_dispatches_across_the_status_event_crash_window() {
        assert!(pending_recovery_can_dispatch(
            false,
            "resume",
            "interrupted"
        ));
        assert!(pending_recovery_can_dispatch(false, "retry", "failed"));
        assert!(pending_recovery_can_dispatch(false, "resume", "running"));
        assert!(pending_recovery_can_dispatch(false, "retry", "planning"));
        assert!(!pending_recovery_can_dispatch(false, "retry", "cancelled"));
        assert!(!pending_recovery_can_dispatch(
            false,
            "resume",
            "awaiting_approval"
        ));
    }

    #[test]
    fn same_run_recovery_action_is_capability_and_status_gated() {
        assert_eq!(
            same_run_recovery_action(
                &json!({
                    "status":"failed","action":"retry_same_run","executable":true
                }),
                "failed",
                "retry_same_run"
            ),
            Ok("retry")
        );
        assert_eq!(
            same_run_recovery_action(
                &json!({
                    "status":"interrupted","action":"resume_same_run","executable":true
                }),
                "interrupted",
                "resume_same_run"
            ),
            Ok("resume")
        );
        assert!(same_run_recovery_action(
            &json!({
                "status":"failed","action":"continue_new_run","executable":true
            }),
            "failed",
            "continue_new_run"
        )
        .unwrap_err()
        .contains("not available"));
        assert!(same_run_recovery_action(
            &json!({
                "status":"failed","action":"resume_same_run","executable":true
            }),
            "failed",
            "resume_same_run"
        )
        .unwrap_err()
        .contains("no longer matches"));
        assert_eq!(
            same_run_recovery_action(
                &json!({
                    "status":"failed","action":"retry_same_run","executable":false,
                    "reason":"Failure is not retryable"
                }),
                "failed",
                "retry_same_run"
            ),
            Err("Failure is not retryable".into())
        );
        assert!(same_run_recovery_action(
            &json!({
                "status":"interrupted","action":"resume_same_run","executable":true
            }),
            "failed",
            "retry_same_run"
        )
        .unwrap_err()
        .contains("capability changed"));
    }

    #[test]
    fn pending_approval_is_rebuilt_from_durable_inspection() {
        let inspection = json!({
            "run": {
                "id": "child-run",
                "rootRunId": "root-run",
                "parentRunId": "root-run",
                "status": "awaiting_approval"
            },
            "events": [{
                "type": "approval.requested",
                "runId": "child-run",
                "payload": {
                    "approvalId": "approval:child-run:step-1:call-1",
                    "toolName": "secure.lookup",
                    "rootRunId": "root-run",
                    "parentRunId": "root-run"
                }
            }]
        });

        assert_eq!(
            pending_approval_from_inspection("root-run", &inspection),
            Some(PendingApproval {
                root_run_id: "root-run".into(),
                approval_run_id: "child-run".into(),
                approval_id: "approval:child-run:step-1:call-1".into(),
                parent_run_id: Some("root-run".into()),
                tool_name: "secure.lookup".into(),
                message: "Approval required before invoking secure.lookup".into(),
                decision_in_flight: false,
                decision: None,
                operation_state: "awaiting_decision".into(),
            })
        );
    }

    #[test]
    fn activity_projection_whitelists_fields_and_removes_sensitive_payloads() {
        let projected = project_activity_event(
            &json!({
                "id": "event-1",
                "runId": "child-run",
                "seq": 4,
                "type": "model.started",
                "createdAt": "2026-01-01T00:00:00.000Z",
                "payload": {
                    "callId": "call-1",
                    "provider": "openai",
                    "model": "gpt-test",
                    "attempt": 1,
                    "input": { "secret": true },
                    "output": "private output",
                    "assistantContent": "private assistant content",
                    "messages": ["private message"],
                    "reasoning": "private reasoning"
                }
            }),
            "root-run",
            Some("researcher"),
        )
        .unwrap();

        assert_eq!(projected.get("eventId"), Some(&json!("event-1")));
        assert_eq!(projected.get("rootRunId"), Some(&json!("root-run")));
        assert_eq!(projected.get("runId"), Some(&json!("child-run")));
        assert_eq!(projected.get("callId"), Some(&json!("call-1")));
        assert_eq!(projected.get("provider"), Some(&json!("openai")));
        assert_eq!(projected.get("delegateName"), Some(&json!("researcher")));
        assert_eq!(
            projected.get("assistantContent"),
            Some(&json!("private assistant content"))
        );
        for forbidden in ["input", "output", "messages", "reasoning", "payload"] {
            assert!(projected.get(forbidden).is_none(), "leaked {forbidden}");
        }
    }

    #[test]
    fn activity_projection_exposes_only_concise_tool_context() {
        let projected = project_activity_event(
            &json!({
                "id": "event-2",
                "runId": "root-run",
                "seq": 5,
                "type": "tool.started",
                "stepId": "step-1",
                "toolCallId": "call-1",
                "createdAt": "2026-01-01T00:00:00.000Z",
                "payload": {
                    "toolName": "read_web_page@1",
                    "input": { "url": "https://www.example.com/private/path?token=secret", "objective": "private" }
                }
            }),
            "root-run",
            None,
        )
        .unwrap();

        assert_eq!(projected.get("stepId"), Some(&json!("step-1")));
        assert_eq!(projected.get("toolCallId"), Some(&json!("call-1")));
        assert_eq!(projected.get("toolContext"), Some(&json!("example.com")));
        assert!(projected.get("input").is_none());
    }

    #[test]
    fn activity_tool_context_formats_search_file_and_shell_inputs() {
        let context = |payload: Value| activity_tool_context(payload.as_object().unwrap());
        assert_eq!(
            context(json!({
                "toolName": "web_search",
                "input": { "preview": { "query": "  adaptive   agent runtime  " } }
            })),
            Some("adaptive agent runtime".into())
        );
        assert_eq!(
            context(json!({
                "toolName": "write_file",
                "input": { "path": "/workspace/packages/core/src/index.ts" }
            })),
            Some("index.ts".into())
        );
        assert_eq!(
            context(json!({
                "toolName": "shell_exec",
                "input": { "command": "bun   test ./src/activity.bun.ts" }
            })),
            Some("bun test ./src/activity.bun.ts".into())
        );
    }

    #[test]
    fn chat_payload_uses_only_transcript_and_preserves_complete_history() {
        let history = vec![
            json!({"role":"user","content":"one"}),
            json!({"role":"assistant","content":"two"}),
            json!({"role":"user","content":"three"}),
        ];
        let payload = chat_request_params("run", "session", history.clone());
        assert_eq!(payload.get("transcript"), Some(&Value::Array(history)));
        assert!(payload.get("messages").is_none());
    }

    #[test]
    fn persisted_trace_reasoning_always_enables_messages() {
        let workbench = WorkbenchDb::open_in_memory().unwrap();
        workbench
            .save_setting(
                TRACE_PRIVACY_SETTING,
                &json!({"messages":false,"reasoning":true,"rawToolPayloads":false}),
            )
            .unwrap();
        assert_eq!(
            load_trace_privacy(&workbench).unwrap(),
            TracePrivacy {
                messages: true,
                reasoning: true,
                raw_tool_payloads: false,
            }
        );
    }

    #[test]
    fn trace_refreshes_coalesce_to_one_pending_pass_and_preserve_final_priority() {
        let mut refreshes = HashMap::new();
        assert!(queue_trace_refresh(&mut refreshes, "root", false));
        assert!(!queue_trace_refresh(&mut refreshes, "root", false));
        assert!(!queue_trace_refresh(&mut refreshes, "root", true));
        assert_eq!(refreshes.len(), 1);
        assert!(refreshes["root"].final_refresh);
        assert!(complete_trace_refresh(&mut refreshes, "root"));
        assert_eq!(refreshes.len(), 1);
        assert!(!complete_trace_refresh(&mut refreshes, "root"));
        assert!(refreshes.is_empty());
    }
}
