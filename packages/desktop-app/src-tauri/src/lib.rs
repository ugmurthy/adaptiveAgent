use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
mod attachments;
mod registry;
mod shutdown;
mod workbench;
use attachments::{AttachmentDraft, MAX_ATTACHMENT_COUNT, MAX_SUBMISSION_BYTES};
use registry::{CancelAction, RunRecord, RunRegistry, CAPACITY};
use shutdown::{CloseDecision, QuitCoordinator, QuitState};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, Receiver, Sender},
        Arc, Mutex, Weak,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
use workbench::{
    now, AgentCatalogMapping, ChatItem, ChatMessage, PendingApproval, PendingRunRecovery,
    Reservation, WorkbenchDb,
};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_NDJSON_FRAME_SIZE: usize = 1024 * 1024;
const TRACE_MAX_NDJSON_FRAME_SIZE: usize = 8 * 1024 * 1024;
const TRACE_PRIVACY_SETTING: &str = "trace_privacy";
const RECENT_WORK_LIMIT: usize = 10;
const DEFAULT_MAX_AGENT_WINDOWS: usize = 3;
const AGENT_WINDOW_PREFIX: &str = "agent:";

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
    agent_id: String,
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
    artifacts_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    artifacts_unavailable_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pending_approval: Option<PendingApproval>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopCatalogStatus {
    current_agent_id: Option<String>,
    diagnostics: Vec<Value>,
    agents: Vec<DesktopCatalogAgent>,
    quit_state: QuitState,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowPresentation {
    x: Option<i32>,
    y: Option<i32>,
    width: Option<u32>,
    height: Option<u32>,
    inspector_width: Option<u32>,
    #[serde(default)]
    inspector_open: bool,
    selection: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowPresentationUi {
    inspector_width: u32,
    inspector_open: bool,
    selection: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentWindowOpen {
    agent_id: String,
    disposition: &'static str,
    open_windows: usize,
    max_windows: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopWindowBootstrap {
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    state: Option<DesktopState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    presentation: Option<WindowPresentation>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopCatalogAgent {
    id: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    config_path: String,
    archived: bool,
    validation_state: String,
    configuration_fingerprint: String,
    status: &'static str,
    occupied_slots: usize,
    capacity: usize,
    attention: &'static str,
    recent_work: Vec<RecentWork>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecentWork {
    item_id: String,
    run_id: String,
    title: String,
    status: String,
    created_at: String,
    invocation_kind: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartedRun {
    item_id: String,
    run_id: String,
    execution_id: String,
    mode: String,
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
    agent_id: String,
    agent_config_path: String,
    agent_fingerprint: String,
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
    attachment_root: PathBuf,
    expected_shutdown: AtomicBool,
    configuration: Mutex<Option<Value>>,
    initialization_error: Mutex<Option<String>>,
    trace_healthy: Arc<AtomicBool>,
    trace_error: Arc<Mutex<Option<String>>>,
    draining: AtomicBool,
    // false means running; true means one more pass was requested while running.
    reconciling: Mutex<HashMap<String, bool>>,
}

struct AppState {
    manager: AgentRuntimeManager,
    lifecycle: Mutex<()>,
    reconfiguring: AtomicBool,
    quit: Mutex<QuitCoordinator>,
    shutdown_started: AtomicBool,
    max_agent_windows: usize,
    window_limit_diagnostic: Option<Value>,
    closing_agent_windows: Mutex<HashSet<String>>,
    window_presentation: Mutex<()>,
}

struct ManagedRuntime {
    bridge: Mutex<Option<Arc<Bridge>>>,
    trace: Mutex<Option<Arc<TraceBridge>>>,
    trace_starting: AtomicBool,
    trace_generation: AtomicU64,
    trace_selection: Mutex<TraceSelection>,
    trace_refreshes: Mutex<HashMap<String, TraceRefreshState>>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct CatalogDescriptor {
    id: String,
    name: String,
    #[serde(default)]
    description: Option<String>,
    configuration_fingerprint: String,
    config_path: String,
    validation_state: String,
    #[serde(default)]
    archived: bool,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogInspect {
    agents: Vec<CatalogDescriptor>,
    #[serde(default)]
    diagnostics: Vec<Value>,
    current_agent: Option<CatalogDescriptor>,
}

struct AgentRuntimeManager {
    app: AppHandle,
    workbench: Arc<WorkbenchDb>,
    attachment_root: PathBuf,
    catalog: Mutex<CatalogPublication>,
    runtimes: Mutex<HashMap<String, Arc<ManagedRuntime>>>,
    lifecycle: Mutex<()>,
    shutdown: AtomicBool,
    catalog_diagnostics: Mutex<Vec<Value>>,
    bootstrap_error: Mutex<Option<String>>,
}

#[derive(Default)]
struct CatalogPublication {
    agents: HashMap<String, CatalogDescriptor>,
    current_agent_id: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
enum RuntimeConvergence {
    Replace,
    Retire,
}

impl AgentRuntimeManager {
    fn unique_catalog_descriptors(
        descriptors: &[CatalogDescriptor],
    ) -> HashMap<String, CatalogDescriptor> {
        let mut counts = HashMap::<String, usize>::new();
        for descriptor in descriptors {
            *counts.entry(descriptor.id.clone()).or_default() += 1;
        }
        descriptors
            .iter()
            .filter(|descriptor| {
                !descriptor.id.trim().is_empty()
                    && !descriptor.config_path.trim().is_empty()
                    && !descriptor.configuration_fingerprint.trim().is_empty()
                    && counts.get(&descriptor.id) == Some(&1)
            })
            .map(|descriptor| (descriptor.id.clone(), descriptor.clone()))
            .collect()
    }

    fn new(app: &AppHandle) -> Result<Self, String> {
        let directory = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("Unable to resolve desktop application data: {error}"))?;
        let workbench = Arc::new(
            WorkbenchDb::open(directory.join("workbench.sqlite"))
                .map_err(|error| format!("Unable to open workbench persistence: {error}"))?,
        );
        let attachment_root = directory.join("attachments");
        std::fs::create_dir_all(&attachment_root)
            .map_err(|error| format!("Unable to create attachment store: {error}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&attachment_root, std::fs::Permissions::from_mode(0o700))
                .map_err(|error| format!("Unable to secure attachment store: {error}"))?;
        }
        cleanup_attachments(&workbench, &attachment_root)?;
        cleanup_attachment_orphans(&workbench, &attachment_root)?;
        Ok(Self {
            app: app.clone(),
            workbench,
            attachment_root,
            catalog: Mutex::new(CatalogPublication::default()),
            runtimes: Mutex::new(HashMap::new()),
            lifecycle: Mutex::new(()),
            shutdown: AtomicBool::new(false),
            catalog_diagnostics: Mutex::new(Vec::new()),
            bootstrap_error: Mutex::new(None),
        })
    }

    fn validate_catalog(
        inspection: CatalogInspect,
    ) -> Result<(HashMap<String, CatalogDescriptor>, CatalogDescriptor), String> {
        let _diagnostics = inspection.diagnostics;
        let current = inspection
            .current_agent
            .ok_or("The catalog did not identify a current agent.")?;
        let catalog = Self::unique_catalog_descriptors(&inspection.agents);
        let exact = catalog
            .get(&current.id)
            .filter(|candidate| **candidate == current)
            .cloned()
            .ok_or("The current agent descriptor is not unique in the catalog.")?;
        Self::creation_allowed(&exact, true)?;
        Ok((catalog, exact))
    }

    fn creation_allowed(
        descriptor: &CatalogDescriptor,
        allow_archived: bool,
    ) -> Result<(), String> {
        if descriptor.validation_state != "valid" {
            return Err(format!("Agent '{}' is not valid.", descriptor.id));
        }
        if descriptor.archived && !allow_archived {
            return Err(format!(
                "Agent '{}' is archived and cannot start new work.",
                descriptor.id
            ));
        }
        Ok(())
    }

    fn bootstrap(&self) -> Result<Arc<ManagedRuntime>, String> {
        if let Err(error) = self.refresh_catalog() {
            *self.bootstrap_error.lock().unwrap() = Some(error.clone());
            return Err(error);
        }
        let current_runtime = match self.current() {
            Ok(runtime) => runtime,
            Err(error) => {
                *self.bootstrap_error.lock().unwrap() = Some(error.clone());
                return Err(error);
            }
        };
        let current_id = self
            .catalog
            .lock()
            .unwrap()
            .current_agent_id
            .clone()
            .unwrap();
        for agent_id in self.workbench.active_agent_ids()? {
            if agent_id != current_id {
                if let Err(error) = self.ensure_runtime(&agent_id, true) {
                    eprintln!(
                        "Unable to bind persisted active work for agent '{agent_id}': {error}"
                    );
                }
            }
        }
        *self.bootstrap_error.lock().unwrap() = None;
        Ok(current_runtime)
    }

    fn inspect_catalog(&self) -> Result<CatalogInspect, String> {
        let probe_selection = CatalogDescriptor {
            id: "__catalog_probe__".into(),
            name: String::new(),
            description: None,
            configuration_fingerprint: "probe".into(),
            config_path: "probe".into(),
            validation_state: "valid".into(),
            archived: false,
        };
        let probe = Bridge::spawn(
            &self.app,
            self.workbench.clone(),
            self.attachment_root.clone(),
            &probe_selection,
        )?;
        let result = (|| {
            let negotiated = probe.request_wait("initialize", json!({ "protocolVersion": "1.14", "clientInfo": { "name": "adaptive-agent-desktop", "version": "0.1.0" } }), REQUEST_TIMEOUT)?;
            if negotiated.get("protocolVersion").and_then(Value::as_str) != Some("1.14") {
                return Err("The sidecar did not negotiate desktop protocol 1.14.".into());
            }
            let value = probe.request_wait("catalog/inspect", json!({}), REQUEST_TIMEOUT)?;
            serde_json::from_value(value)
                .map_err(|error| format!("Invalid catalog response: {error}"))
        })();
        probe.shutdown();
        result
    }

    fn refresh_catalog(&self) -> Result<(), String> {
        let _lifecycle = self.lifecycle.lock().unwrap();
        self.refresh_catalog_locked()
    }

    fn refresh_catalog_locked(&self) -> Result<(), String> {
        if self.shutdown.load(Ordering::SeqCst) {
            return Err("Desktop runtime manager is shut down.".into());
        }
        let inspection = self.inspect_catalog()?;
        let diagnostics = inspection.diagnostics.clone();
        let reported_current_id = inspection
            .current_agent
            .as_ref()
            .map(|agent| agent.id.clone());
        let (catalog, current) = match Self::validate_catalog(inspection.clone()) {
            Ok(validated) => validated,
            Err(error) => {
                let catalog = Self::unique_catalog_descriptors(&inspection.agents);
                let mappings = catalog
                    .values()
                    .filter(|agent| agent.validation_state == "valid")
                    .map(|agent| AgentCatalogMapping {
                        agent_id: agent.id.clone(),
                        fingerprint: agent.configuration_fingerprint.clone(),
                        config_path: agent.config_path.clone(),
                    })
                    .collect::<Vec<_>>();
                self.workbench.reconcile_agent_catalog(&mappings)?;
                *self.catalog_diagnostics.lock().unwrap() = diagnostics;
                *self.catalog.lock().unwrap() = CatalogPublication {
                    agents: catalog,
                    current_agent_id: reported_current_id,
                };
                return Err(error);
            }
        };
        let mappings = catalog
            .values()
            .filter(|agent| agent.validation_state == "valid")
            .map(|agent| AgentCatalogMapping {
                agent_id: agent.id.clone(),
                fingerprint: agent.configuration_fingerprint.clone(),
                config_path: agent.config_path.clone(),
            })
            .collect::<Vec<_>>();
        self.workbench.reconcile_agent_catalog(&mappings)?;
        // Publish only after the complete probe and durable reconciliation succeeded.
        *self.catalog.lock().unwrap() = CatalogPublication {
            agents: catalog,
            current_agent_id: Some(current.id.clone()),
        };
        *self.catalog_diagnostics.lock().unwrap() = diagnostics;
        *self.bootstrap_error.lock().unwrap() = None;
        let _ = self.app.emit(
            "adaptive-agent://catalog-status-changed",
            json!({ "agentId": current.id }),
        );
        Ok(())
    }

    fn ensure_runtime(
        &self,
        agent_id: &str,
        allow_archived: bool,
    ) -> Result<Arc<ManagedRuntime>, String> {
        let _lifecycle = self.lifecycle.lock().unwrap();
        self.ensure_runtime_locked(agent_id, allow_archived)
    }

    fn ensure_runtime_locked(
        &self,
        agent_id: &str,
        allow_archived: bool,
    ) -> Result<Arc<ManagedRuntime>, String> {
        Self::publication_allowed(self.shutdown.load(Ordering::SeqCst))?;
        let descriptor = self
            .catalog
            .lock()
            .unwrap()
            .agents
            .get(agent_id)
            .cloned()
            .ok_or_else(|| format!("Unknown agent '{agent_id}'."))?;
        Self::creation_allowed(&descriptor, allow_archived)?;
        let cached = self.runtimes.lock().unwrap().get(agent_id).cloned();
        if let Some(runtime) = cached {
            let matches = runtime
                .bridge
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|bridge| Self::bridge_matches_descriptor(bridge, &descriptor));
            if matches {
                return Ok(runtime);
            }
            self.runtimes.lock().unwrap().remove(agent_id);
            Self::shutdown_runtime(&runtime);
        }
        let bridge = Bridge::spawn(
            &self.app,
            self.workbench.clone(),
            self.attachment_root.clone(),
            &descriptor,
        )?;
        if let Err(error) = bridge.initialize() {
            bridge.shutdown();
            return Err(error);
        }
        let runtime = Arc::new(ManagedRuntime {
            bridge: Mutex::new(Some(bridge)),
            trace: Mutex::new(None),
            trace_starting: AtomicBool::new(false),
            trace_generation: AtomicU64::new(0),
            trace_selection: Mutex::new(TraceSelection::default()),
            trace_refreshes: Mutex::new(HashMap::new()),
        });
        self.runtimes
            .lock()
            .unwrap()
            .insert(agent_id.into(), runtime.clone());
        Ok(runtime)
    }

    fn current(&self) -> Result<Arc<ManagedRuntime>, String> {
        let id = self
            .catalog
            .lock()
            .unwrap()
            .current_agent_id
            .clone()
            .ok_or("Desktop runtime is starting.")?;
        self.ensure_runtime(&id, true)
    }

    fn shutdown_all(&self) {
        let runtimes = {
            let _lifecycle = self.lifecycle.lock().unwrap();
            self.shutdown.store(true, Ordering::SeqCst);
            self.runtimes
                .lock()
                .unwrap()
                .drain()
                .map(|(_, runtime)| runtime)
                .collect::<Vec<_>>()
        };
        for runtime in runtimes {
            Self::shutdown_runtime(&runtime);
        }
    }

    fn runtime_bridges(&self) -> Vec<Arc<Bridge>> {
        let runtimes = self
            .runtimes
            .lock()
            .unwrap()
            .values()
            .cloned()
            .collect::<Vec<_>>();
        runtimes
            .into_iter()
            .filter_map(|runtime| runtime.bridge.lock().unwrap().as_ref().cloned())
            .collect()
    }

    fn convergence_action(descriptor: Option<&CatalogDescriptor>) -> RuntimeConvergence {
        match descriptor {
            Some(descriptor) if Self::creation_allowed(descriptor, true).is_ok() => {
                RuntimeConvergence::Replace
            }
            _ => RuntimeConvergence::Retire,
        }
    }

    fn bridge_matches_descriptor(bridge: &Bridge, descriptor: &CatalogDescriptor) -> bool {
        Self::immutable_selection_matches(
            &bridge.agent_config_path,
            &bridge.agent_fingerprint,
            descriptor,
        )
    }

    fn immutable_selection_matches(
        config_path: &str,
        fingerprint: &str,
        descriptor: &CatalogDescriptor,
    ) -> bool {
        config_path == descriptor.config_path && fingerprint == descriptor.configuration_fingerprint
    }

    fn shutdown_runtime(runtime: &Arc<ManagedRuntime>) {
        if let Some(trace) = runtime.trace.lock().unwrap().take() {
            trace.shutdown();
        }
        if let Some(bridge) = runtime.bridge.lock().unwrap().take() {
            bridge.shutdown();
        }
    }

    /// Refreshes the catalog and converges every runtime that existed before the refresh.
    /// All old runtimes are removed before replacements are attempted, so failures cannot
    /// leave stale immutable selections routable.
    fn converge_after_catalog_refresh(&self) -> Result<Vec<String>, String> {
        let _lifecycle = self.lifecycle.lock().unwrap();
        let instantiated = self.instantiated_agent_ids();
        if let Err(error) = self.refresh_catalog_locked() {
            // Settings may already be durable. Fail closed: no runtime using the previous
            // catalog generation may remain routable after refresh fails.
            let stale = self
                .runtimes
                .lock()
                .unwrap()
                .drain()
                .map(|(_, runtime)| runtime)
                .collect::<Vec<_>>();
            self.catalog.lock().unwrap().agents.clear();
            *self.bootstrap_error.lock().unwrap() = Some(error.clone());
            for runtime in stale {
                Self::shutdown_runtime(&runtime);
            }
            return Err(error);
        }
        let catalog = self.catalog.lock().unwrap();
        let actions = instantiated
            .into_iter()
            .map(|id| {
                let action = Self::convergence_action(catalog.agents.get(&id));
                (id, action)
            })
            .collect::<Vec<_>>();
        drop(catalog);

        let old = {
            let mut runtimes = self.runtimes.lock().unwrap();
            actions
                .iter()
                .filter_map(|(id, _)| runtimes.remove(id))
                .collect::<Vec<_>>()
        };
        for runtime in old {
            Self::shutdown_runtime(&runtime);
        }

        let mut failures = Vec::new();
        for (id, action) in actions {
            if action == RuntimeConvergence::Replace {
                if let Err(error) = self.ensure_runtime_locked(&id, true) {
                    failures.push(format!("{id}: {error}"));
                }
            }
        }
        let agent_id = self.catalog.lock().unwrap().current_agent_id.clone();
        let _ = self.app.emit(
            "adaptive-agent://catalog-status-changed",
            json!({ "agentId": agent_id }),
        );
        Ok(failures)
    }

    fn error_snapshot(&self, quit_state: QuitState) -> DesktopState {
        DesktopState {
            agent_id: self
                .catalog
                .lock()
                .unwrap()
                .current_agent_id
                .clone()
                .unwrap_or_default(),
            status: "error",
            configuration_valid: false,
            configuration: None,
            error: Some(
                self.bootstrap_error
                    .lock()
                    .unwrap()
                    .clone()
                    .unwrap_or_else(|| "No runnable current agent is available.".into()),
            ),
            runs: Vec::new(),
            occupied_slot_count: 0,
            capacity: CAPACITY,
            execution_health: "error",
            trace_health: "error",
            trace_error: Some("Trace is unavailable until agent configuration is valid.".into()),
            quit_state,
        }
    }

    fn instantiated_agent_ids(&self) -> Vec<String> {
        self.runtimes.lock().unwrap().keys().cloned().collect()
    }

    fn catalog_status(
        &self,
        quit_state: QuitState,
        window_limit_diagnostic: Option<Value>,
    ) -> Result<DesktopCatalogStatus, String> {
        let (current_agent_id, mut descriptors) = {
            let catalog = self.catalog.lock().unwrap();
            (
                catalog.current_agent_id.clone(),
                catalog.agents.values().cloned().collect::<Vec<_>>(),
            )
        };
        descriptors.sort_by(|left, right| left.id.cmp(&right.id));
        let runtimes = self.runtimes.lock().unwrap().clone();
        let mut agents = Vec::with_capacity(descriptors.len());
        for descriptor in descriptors {
            let snapshot = runtimes.get(&descriptor.id).and_then(|runtime| {
                runtime
                    .bridge
                    .lock()
                    .unwrap()
                    .as_ref()
                    .map(|bridge| bridge.snapshot())
            });
            let (status, occupied_slots, error, mut recent_work, approval, recovery) =
                if let Some(snapshot) = snapshot {
                    let approval = snapshot.runs.iter().any(|run| {
                        run.pending_approval.is_some() || run.status == "awaiting_approval"
                    });
                    let recovery = snapshot.runs.iter().any(|run| recovery_status(&run.status));
                    let work: Vec<RecentWork> = snapshot
                        .runs
                        .into_iter()
                        .map(|run| RecentWork {
                            item_id: run.item_id,
                            run_id: run.run_id,
                            title: run.title,
                            status: run.status,
                            created_at: run.created_at,
                            invocation_kind: run.invocation_kind,
                        })
                        .collect();
                    (
                        snapshot.status,
                        snapshot.occupied_slot_count,
                        snapshot.error.is_some(),
                        work,
                        approval,
                        recovery,
                    )
                } else {
                    let runs = self.workbench.load_runs_for_agent(&descriptor.id)?;
                    let occupied = runs
                        .iter()
                        .filter(|run| durable_run_occupies_slot(run))
                        .count();
                    let stopping = runs
                        .iter()
                        .any(|run| durable_run_occupies_slot(run) && run.cancel_requested);
                    let approval = runs
                        .iter()
                        .any(|run| run.cached_status == "awaiting_approval");
                    let recovery = runs.iter().any(|run| {
                        recovery_status(&run.cached_status)
                            || run.submission_state == "recovery_required"
                    });
                    let status = if descriptor.validation_state != "valid" {
                        "error"
                    } else if descriptor.archived {
                        "unavailable"
                    } else if stopping {
                        "stopping"
                    } else if occupied > 0 {
                        "running"
                    } else {
                        "ready"
                    };
                    let work: Vec<RecentWork> = runs
                        .into_iter()
                        .map(|run| RecentWork {
                            item_id: run.item_id,
                            run_id: run.run_id,
                            title: run.title,
                            status: run.cached_status,
                            created_at: run.created_at,
                            invocation_kind: run.invocation_kind,
                        })
                        .collect();
                    (
                        status,
                        occupied,
                        descriptor.validation_state != "valid",
                        work,
                        approval,
                        recovery,
                    )
                };
            recent_work.sort_by(|left, right| {
                right
                    .created_at
                    .cmp(&left.created_at)
                    .then_with(|| right.run_id.cmp(&left.run_id))
            });
            recent_work.truncate(RECENT_WORK_LIMIT);
            agents.push(DesktopCatalogAgent {
                id: descriptor.id,
                name: descriptor.name,
                description: descriptor.description,
                config_path: descriptor.config_path,
                archived: descriptor.archived,
                validation_state: descriptor.validation_state,
                configuration_fingerprint: descriptor.configuration_fingerprint,
                status,
                occupied_slots,
                capacity: CAPACITY,
                attention: fleet_attention(error, approval, recovery),
                recent_work,
            });
        }
        let mut diagnostics = self.catalog_diagnostics.lock().unwrap().clone();
        if let Some(diagnostic) = window_limit_diagnostic {
            diagnostics.push(diagnostic);
        }
        Ok(DesktopCatalogStatus {
            current_agent_id,
            diagnostics,
            agents,
            quit_state,
        })
    }

    fn publication_allowed(shutdown: bool) -> Result<(), String> {
        if shutdown {
            Err("Desktop runtime manager is shut down.".into())
        } else {
            Ok(())
        }
    }
}

fn durable_run_occupies_slot(run: &Reservation) -> bool {
    !matches!(
        run.submission_state.as_str(),
        "terminal" | "submission_failed"
    )
}

fn recovery_status(status: &str) -> bool {
    matches!(status, "recovery_required" | "recovering" | "interrupted")
}

fn fleet_attention(error: bool, approval: bool, recovery: bool) -> &'static str {
    if error {
        "error"
    } else if approval {
        "approval"
    } else if recovery {
        "recovery"
    } else {
        "none"
    }
}

fn parse_agent_window_limit(value: Option<&str>) -> (usize, Option<Value>) {
    match value {
        None => (DEFAULT_MAX_AGENT_WINDOWS, None),
        Some(value) => match value.trim().parse::<usize>() {
            Ok(limit) if limit > 0 => (limit, None),
            _ => (
                DEFAULT_MAX_AGENT_WINDOWS,
                Some(json!({
                    "code": "invalid-agent-window-limit",
                    "message": format!(
                        "ADAPTIVE_AGENT_MAX_WINDOWS must be a positive integer; using {DEFAULT_MAX_AGENT_WINDOWS}."
                    )
                })),
            ),
        },
    }
}

fn agent_window_label(agent_id: &str) -> String {
    let encoded = agent_id
        .as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("{AGENT_WINDOW_PREFIX}{encoded}")
}

fn agent_id_from_window_label(label: &str) -> Option<String> {
    let encoded = label.strip_prefix(AGENT_WINDOW_PREFIX)?;
    if encoded.is_empty() || encoded.len() % 2 != 0 {
        return None;
    }
    let bytes = (0..encoded.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&encoded[index..index + 2], 16).ok())
        .collect::<Option<Vec<_>>>()?;
    String::from_utf8(bytes).ok()
}

fn window_presentation_key(agent_id: &str) -> String {
    format!("window_presentation/{agent_id}")
}

fn open_agent_window_count(app: &AppHandle, state: &AppState) -> usize {
    let closing = state.closing_agent_windows.lock().unwrap();
    app.webview_windows()
        .keys()
        .filter(|label| label.starts_with(AGENT_WINDOW_PREFIX) && !closing.contains(*label))
        .count()
}

fn ensure_agent_window_visible(window: &WebviewWindow) -> Result<(), String> {
    let position = window
        .outer_position()
        .map_err(|error| format!("Unable to read agent window position: {error}"))?;
    let size = window
        .outer_size()
        .map_err(|error| format!("Unable to read agent window size: {error}"))?;
    let monitors = window
        .available_monitors()
        .map_err(|error| format!("Unable to inspect available monitors: {error}"))?;
    let right = i64::from(position.x) + i64::from(size.width);
    let bottom = i64::from(position.y) + i64::from(size.height);
    let visible = monitors.iter().any(|monitor| {
        let monitor_position = monitor.position();
        let monitor_size = monitor.size();
        let monitor_right = i64::from(monitor_position.x) + i64::from(monitor_size.width);
        let monitor_bottom = i64::from(monitor_position.y) + i64::from(monitor_size.height);
        let overlap_width =
            right.min(monitor_right) - i64::from(position.x).max(i64::from(monitor_position.x));
        let overlap_height =
            bottom.min(monitor_bottom) - i64::from(position.y).max(i64::from(monitor_position.y));
        overlap_width >= 80 && overlap_height >= 40
    });
    if !visible {
        window
            .center()
            .map_err(|error| format!("Unable to center agent window: {error}"))?;
    }
    Ok(())
}

fn runtime_for(
    state: &AppState,
    agent_id: &str,
    allow_archived: bool,
) -> Result<Arc<ManagedRuntime>, String> {
    let runtime = state.manager.ensure_runtime(agent_id, allow_archived)?;
    let bridge = runtime
        .bridge
        .lock()
        .unwrap()
        .as_ref()
        .cloned()
        .ok_or("Desktop runtime is starting.")?;
    start_trace_for_runtime(agent_id, runtime.clone(), bridge)?;
    Ok(runtime)
}

fn bridge_for(
    state: &AppState,
    agent_id: &str,
    allow_archived: bool,
) -> Result<Arc<Bridge>, String> {
    let runtime = runtime_for(state, agent_id, allow_archived)?;
    let bridge = runtime
        .bridge
        .lock()
        .unwrap()
        .as_ref()
        .cloned()
        .ok_or("Desktop runtime is starting.")?;
    bridge.assert_agent_id(agent_id)?;
    Ok(bridge)
}

fn canonical_path(path: &str) -> Result<PathBuf, String> {
    std::fs::canonicalize(path)
        .map_err(|error| format!("Unable to resolve agent configuration path '{path}': {error}"))
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
    owning_bridge: Weak<Bridge>,
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
        owning_bridge: Weak<Bridge>,
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
            owning_bridge,
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
        if let Some(bridge) = self.owning_bridge.upgrade() {
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
    fn control_error_payload(&self, run_id: &str, error: impl ToString) -> Value {
        json!({ "agentId": self.agent_id, "runId": run_id, "error": error.to_string() })
    }

    fn emit_control_error(&self, run_id: &str, error: impl ToString) {
        let _ = self.app.emit(
            "adaptive-agent://control-error",
            self.control_error_payload(run_id, error),
        );
    }

    fn assert_agent_id(&self, agent_id: &str) -> Result<(), String> {
        if self.agent_id == agent_id {
            Ok(())
        } else {
            Err("The selected agent does not own this runtime.".into())
        }
    }

    fn validated_drafts(&self, ids: &[String]) -> Result<Vec<AttachmentDraft>, String> {
        if ids.len() > MAX_ATTACHMENT_COUNT {
            return Err("ATTACHMENT_TOO_LARGE: At most 8 attachments are allowed.".into());
        }
        let mut unique = HashSet::new();
        if ids.iter().any(|id| !unique.insert(id)) {
            return Err("Duplicate attachment ID.".into());
        }
        let drafts = self.workbench.get_drafts_for_agent(&self.agent_id, ids)?;
        let mut total = 0;
        for draft in &drafts {
            attachments::validate_staged(&self.attachment_root, draft)?;
            total += draft.size_bytes;
        }
        if total > MAX_SUBMISSION_BYTES {
            return Err("ATTACHMENT_TOO_LARGE: Attachments exceed 40 MiB total.".into());
        }
        Ok(drafts)
    }
    fn spawn(
        app: &AppHandle,
        workbench: Arc<WorkbenchDb>,
        attachment_root: PathBuf,
        selection: &CatalogDescriptor,
    ) -> Result<Arc<Self>, String> {
        // Complete all fallible persistence reads before creating a child process so every
        // spawned runtime can be published to, and shut down through, the native lifecycle.
        let saved_runs = workbench.load_runs_for_agent(&selection.id)?;
        let (mut events, child) = app
            .shell()
            .sidecar("agent-runtime")
            .map_err(|error| format!("Unable to locate the packaged agent runtime: {error}"))?
            .spawn()
            .map_err(|error| format!("Unable to start the agent runtime: {error}"))?;
        let bridge = Arc::new(Self {
            app: app.clone(),
            agent_id: selection.id.clone(),
            agent_config_path: selection.config_path.clone(),
            agent_fingerprint: selection.configuration_fingerprint.clone(),
            child: Mutex::new(Some(child)),
            pending: Mutex::new(HashMap::new()),
            decoder: Mutex::new(NdjsonDecoder::new(MAX_NDJSON_FRAME_SIZE)),
            generation: 1,
            next_id: AtomicU64::new(1),
            registry: Mutex::new(RunRegistry::default()),
            run_roots: Mutex::new(HashMap::new()),
            run_delegates: Mutex::new(HashMap::new()),
            workbench,
            attachment_root,
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
                workspace_root: saved.workspace_root,
                shell_cwd: saved.shell_cwd,
            });
        }
        for approval in bridge
            .workbench
            .load_pending_approvals_for_agent(&bridge.agent_id)?
        {
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
            json!({ "protocolVersion": "1.14", "clientInfo": { "name": "adaptive-agent-desktop", "version": "0.1.0" } }),
            REQUEST_TIMEOUT,
        )?;
        if negotiated.get("protocolVersion").and_then(Value::as_str) != Some("1.14") {
            return Err("The sidecar did not negotiate desktop protocol 1.14.".into());
        }
        let initialized = self.request_wait(
            "runtime/initialize",
            json!({
                "configurationDriven": true,
                "managedAttachmentRoot": self.attachment_root,
                "agentSelection": {
                    "id": self.agent_id,
                    "configPath": self.agent_config_path,
                    "configurationFingerprint": self.agent_fingerprint
                }
            }),
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
        let Ok(jobs) = self.workbench.load_deletion_jobs_for_agent(&self.agent_id) else {
            return;
        };
        for job in jobs {
            if let Err(error) = self.execute_deletion_job(&job) {
                let _ = self.workbench.fail_deletion_job(&job.id, &error);
            }
        }
    }

    fn recover_pending_run_operations(self: &Arc<Self>) {
        let Ok(operations) = self
            .workbench
            .load_run_recovery_operations_for_agent(&self.agent_id)
        else {
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
                self.emit_control_error(
                    &operation.run_id,
                    format!("Unable to inspect pending recovery: {error}"),
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
            self.emit_control_error(
                &operation.run_id,
                format!(
                    "Pending {} recovery requires reconciliation from runtime status {status}.",
                    operation.requested_action
                ),
            );
            return;
        }
        if let Err(error) = self.dispatch_same_run_recovery(&operation.run_id) {
            self.emit_control_error(
                &operation.run_id,
                format!("Unable to restore pending recovery: {error}"),
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
                        bridge.emit_control_error(
                            &run_id,
                            format!("Unable to read pending recovery state: {error}"),
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
                        bridge.emit_control_error(
                            &run_id,
                            format!("Unable to reconcile successful chat turn: {error}"),
                        );
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
                                bridge.emit_control_error(
                                    &run_id,
                                    format!("Unable to persist terminal run state: {error}"),
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
                                bridge.emit_control_error(&run_id, error);
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
                        json!({ "agentId": bridge.agent_id, "runId": run_id, "result": result }),
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
            self.emit_control_error(run_id, result.unwrap_err());
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
                    self.emit_control_error(
                        run_id,
                        format!("Unable to persist shutdown interrupt; retrying: {error}"),
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
            if let Some(mut projected) =
                project_activity_event(event, &root_run_id, delegate_name.as_deref())
            {
                redact_managed_attachment_paths(&mut projected, &self.attachment_root);
                if let Some(object) = projected.as_object_mut() {
                    object.insert("agentId".into(), Value::String(self.agent_id.clone()));
                }
                let _ = self.app.emit("adaptive-agent://activity", projected);
            }
            if matches!(
                kind,
                "run.completed" | "run.failed" | "run.interrupted" | "replan.required"
            ) {
                schedule_trace_refresh(&self.app, self.agent_id.clone(), root_run_id, true);
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
        if let Ok(approvals) = self
            .workbench
            .load_pending_approvals_for_agent(&self.agent_id)
        {
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
                    bridge.emit_control_error(&root_run_id, format!("Approval outcome is unknown and will be retried after runtime restart: {error}"));
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
                                    bridge2.emit_control_error(&root, error);
                                    bridge2.reconcile_run(root)
                                }
                                Err(_) => bridge2.reconcile_run(root),
                            };
                        });
                    }
                    Err(error) => {
                        bridge.emit_control_error(&root_run_id, error);
                        bridge.reconcile_run(root_run_id.clone());
                    }
                }
            } else {
                bridge.reconcile_run(root_run_id.clone());
            }
            bridge.emit_state();
        });
    }

    fn start_run(
        self: &Arc<Self>,
        task: String,
        attachment_ids: Vec<String>,
    ) -> Result<StartedRun, String> {
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
        let drafts = self.validated_drafts(&attachment_ids)?;
        reject_unsupported_media(&drafts)?;
        let mode = "direct";
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
            agent_config_path: agent
                .get("configPath")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(str::to_owned),
            invocation_kind: "run".into(),
            cached_status: "reserved".into(),
            submission_state: "reserved".into(),
            cancel_requested: false,
            interrupt_pending: false,
            workspace_root: configuration
                .pointer("/workspace/root")
                .and_then(Value::as_str)
                .map(str::to_owned),
            shell_cwd: configuration
                .pointer("/workspace/shellCwd")
                .and_then(Value::as_str)
                .map(str::to_owned),
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
            workspace_root: reservation.workspace_root.clone(),
            shell_cwd: reservation.shell_cwd.clone(),
        });
        if let Err(error) = self
            .workbench
            .reserve_task_with_attachments(&reservation, &attachment_ids)
        {
            self.registry.lock().unwrap().remove(&run_id);
            return Err(error);
        }
        if let Err(error) = self.workbench.update_run(&run_id, "submitted", "submitted") {
            if let Some(record) = self.registry.lock().unwrap().get_mut(&run_id) {
                record.request_active = false;
                record.revision += 1;
            }
            self.reconcile_run(run_id.clone());
            return Err(format!("SUBMISSION_CLAIMED: The task reservation is durable but could not be submitted: {error}"));
        }
        let (_request_id, receiver) =
            match self.request("agent/run", json!({ "executionId": run_id, "goal": task, "attachments":trusted_descriptors(&drafts) })) {
                Ok(request) => request,
                Err(error) => {
                    if let Some(record) = self.registry.lock().unwrap().get_mut(&run_id) {
                        record.request_active = false;
                        let state = submission_failed();
                        apply_run_state(record, &state, None);
                    }
                    if self.workbench.mark_submission_failed(&run_id).is_err() {
                        self.reconcile_run(run_id.clone());
                    }
                    self.emit_state();
                    return Err(format!("SUBMISSION_CLAIMED: The task reservation is durable but could not be submitted: {error}"));
                }
            };
        self.emit_state();
        let bridge = self.clone();
        let started = StartedRun {
            item_id,
            run_id: run_id.clone(),
            execution_id: run_id.clone(),
            mode: mode.into(),
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
                    let stored_result =
                        canonical_workbench_result(&result, Some(&bridge.attachment_root));
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
                            json!({ "agentId": bridge.agent_id, "runId": run_id, "result": stored_result }),
                        );
                    } else {
                        bridge.reconcile_run(run_id.clone());
                    }
                }
                Err(error) => {
                    bridge.emit_control_error(&run_id, error);
                    bridge.reconcile_run(run_id.clone());
                }
            }
            bridge.emit_state();
        });
        Ok(started)
    }

    fn current_agent(&self) -> Result<(String, String, String, Option<String>), String> {
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
            agent
                .get("configPath")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(str::to_owned),
        ))
    }

    fn chat_reason(&self, chat: &ChatItem) -> Option<String> {
        let configuration = self.configuration.lock().unwrap();
        let current_workspace = configuration
            .as_ref()
            .and_then(|configuration| configuration.pointer("/workspace/root"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let current_shell_cwd = configuration
            .as_ref()
            .and_then(|configuration| configuration.pointer("/workspace/shellCwd"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        drop(configuration);
        match self.current_agent() {
            Err(_) => Some("The pinned agent is not currently available; this chat is read-only.".into()),
            Ok((id,_,_,_)) if id != chat.pinned_agent_id => Some("The resolved agent ID no longer matches this chat's pin; this chat is read-only.".into()),
            Ok((_,_,fingerprint,_)) if fingerprint != chat.pinned_agent_fingerprint => Some("The resolved agent configuration fingerprint no longer matches this chat's pin; this chat is read-only.".into()),
            Ok(_) if chat.workspace_root.is_none() || chat.shell_cwd.is_none() => Some("This chat predates durable workspace provenance and is read-only.".into()),
            Ok(_) if chat.workspace_root != current_workspace || chat.shell_cwd != current_shell_cwd => Some("The resolved workspace no longer matches this chat's pin; this chat is read-only.".into()),
            _ => None,
        }
    }

    fn chat_dto(&self, item_id: &str) -> Result<ChatDto, String> {
        let (chat, messages) = self
            .workbench
            .load_chat_for_agent(&self.agent_id, item_id)?;
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

    fn assert_deletion_owner(&self, target: &ProductDeletionTarget) -> Result<(), String> {
        match target {
            ProductDeletionTarget::Item { item_id }
            | ProductDeletionTarget::ChatTurn { item_id, .. } => {
                self.workbench.assert_item_owner(&self.agent_id, item_id)
            }
            ProductDeletionTarget::Run { run_id } => {
                self.workbench.assert_run_owner(&self.agent_id, run_id)
            }
        }
    }

    fn preview_deletion(
        self: &Arc<Self>,
        target: ProductDeletionTarget,
    ) -> Result<DeletionPreview, String> {
        self.assert_deletion_owner(&target)?;
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
        let job = self
            .workbench
            .create_deletion_job_for_agent(&self.agent_id, &operation)?;
        match self.execute_deletion_job(&job) {
            Ok(()) => {
                let _ = cleanup_attachments(&self.workbench, &self.attachment_root);
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

    fn send_chat(
        self: &Arc<Self>,
        item_id: String,
        content: String,
        attachment_ids: Vec<String>,
    ) -> Result<StartedRun, String> {
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
        let drafts = self.validated_drafts(&attachment_ids)?;
        reject_unsupported_media(&drafts)?;
        let mode = "direct";
        let messages = self.workbench.reserve_chat_turn_with_attachments(
            &item_id,
            &run_id,
            &content,
            &attachment_ids,
        )?;
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
            workspace_root: chat.workspace_root.clone(),
            shell_cwd: chat.shell_cwd.clone(),
        });
        drop(registry);
        if let Err(error) = self.workbench.update_run(&run_id, "submitted", "submitted") {
            self.emit_control_error(&run_id, format!("The chat reservation is durable, but its redundant submitted update failed: {error}"));
        }
        let transcript = messages
            .iter()
            .map(|message| json!({"role":message.role,"text":message.content,"attachments":trusted_descriptors(&message.attachments)}))
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
                    self.emit_control_error(&run_id, "Unable to persist submission failure; retaining the occupied slot for recovery.");
                    self.reconcile_run(run_id.clone());
                }
                self.emit_state();
                return Err(format!("SUBMISSION_CLAIMED: The chat turn is durable but could not be submitted: {error}"));
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
                    let stored_result =
                        canonical_workbench_result(&result, Some(&bridge.attachment_root));
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
                            bridge.emit_control_error(
                                &response_run_id,
                                format!("Unable to finalize successful chat turn: {error}"),
                            );
                            bridge.reconcile_run(response_run_id.clone());
                            bridge.emit_state();
                            return;
                        }
                    } else if let Err(error) = bridge
                        .workbench
                        .store_result(&response_run_id, &stored_result)
                    {
                        bridge.emit_control_error(&response_run_id, error);
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
                                bridge.emit_control_error(&response_run_id, error);
                            }
                        }
                    }
                    if !state.occupies_slot {
                        let _ = bridge.app.emit(
                            "adaptive-agent://run-finished",
                            json!({"agentId":bridge.agent_id,"runId":response_run_id,"result":stored_result}),
                        );
                    }
                }
                Err(error) => {
                    bridge.emit_control_error(&response_run_id, error);
                    bridge.reconcile_run(response_run_id.clone());
                }
            }
            bridge.emit_state();
        });
        Ok(StartedRun {
            item_id,
            execution_id: run_id.clone(),
            run_id,
            mode: mode.into(),
        })
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
        self.validate_same_run_recovery(run_id)?;
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
        self.validate_same_run_recovery(run_id)?;
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
                    let stored_result =
                        canonical_workbench_result(&result, Some(&bridge.attachment_root));
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
                                    json!({ "agentId": bridge.agent_id, "runId": run_id, "result": stored_result }),
                                );
                            }
                            Err(error) => {
                                bridge.emit_control_error(
                                    &run_id,
                                    format!("Unable to persist recovered run: {error}"),
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
                    bridge.emit_control_error(&run_id, error);
                    bridge.reconcile_run(run_id.clone());
                }
            }
            bridge.emit_state();
        });
        Ok(())
    }

    fn validate_same_run_recovery(&self, run_id: &str) -> Result<(), String> {
        let record = self
            .registry
            .lock()
            .unwrap()
            .get(run_id)
            .cloned()
            .ok_or("Run is not known.")?;
        let configuration = self.configuration.lock().unwrap();
        let current_workspace = configuration
            .as_ref()
            .and_then(|value| value.pointer("/workspace/root"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let current_shell_cwd = configuration
            .as_ref()
            .and_then(|value| value.pointer("/workspace/shellCwd"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        if record.workspace_root.is_none()
            || record.shell_cwd.is_none()
            || record.workspace_root != current_workspace
            || record.shell_cwd != current_shell_cwd
        {
            return Err("WORKSPACE_PROVENANCE_CHANGED: The run cannot be recovered under different workspace settings.".into());
        }
        drop(configuration);
        for attachment in self.workbench.task_attachments_for_run(run_id)? {
            attachments::validate_staged(&self.attachment_root, &attachment)
                .map_err(|error| format!("ATTACHMENT_UNRECOVERABLE: {error}"))?;
        }
        Ok(())
    }

    fn arm_cancellations(self: &Arc<Self>, run_ids: &[String]) {
        for run_id in run_ids {
            loop {
                match self.workbench.set_cancel_requested(run_id) {
                    Ok(()) => break,
                    Err(error) => {
                        self.emit_control_error(
                            run_id,
                            format!("Unable to persist shutdown cancellation; retrying: {error}"),
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
        let current_workspace = configuration.as_ref().and_then(|value| {
            Some((
                value.pointer("/workspace/root")?.as_str()?,
                value.pointer("/workspace/shellCwd")?.as_str()?,
            ))
        });
        let any_stopping = registry.any_stopping();
        let any_active = registry.any_active();
        let mut runs = registry
            .records()
            .map(|run| {
                let (artifacts_available, artifacts_unavailable_reason) = match (&run.workspace_root, &run.shell_cwd, current_workspace) {
                    (None, _, _) | (_, None, _) => (false, Some("Artifacts are unavailable because this legacy run has no workspace provenance.".into())),
                    (Some(root), Some(cwd), Some((current_root, current_cwd))) if root == current_root && cwd == current_cwd => (true, None),
                    (Some(_), Some(_), _) => (false, Some("Artifacts are unavailable because this run used different workspace paths.".into())),
                };
                RunSummary {
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
                    artifacts_available,
                    artifacts_unavailable_reason,
                    pending_approval: run.pending_approval.clone(),
                }
            })
            .collect::<Vec<_>>();
        runs.sort_by(|left, right| left.run_id.cmp(&right.run_id));
        DesktopState {
            agent_id: self
                .current_agent()
                .map(|agent| agent.0)
                .unwrap_or_default(),
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
        let _ = self.app.emit(
            "adaptive-agent://catalog-status-changed",
            json!({ "agentId": self.agent_id }),
        );
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

fn trusted_descriptors(drafts: &[AttachmentDraft]) -> Vec<Value> {
    drafts
        .iter()
        .map(|draft| {
            let mut descriptor = json!({
                "attachmentId": draft.id,
                "kind": draft.kind,
                "stagedRelativePath": draft.staged_relative_path,
                "name": draft.name,
                "sizeBytes": draft.size_bytes,
                "sha256": draft.sha256,
            });
            if let Some(mime_type) = &draft.mime_type {
                descriptor["mimeType"] = json!(mime_type);
            }
            if let Some(audio_format) = &draft.audio_format {
                descriptor["audioFormat"] = json!(audio_format);
            }
            descriptor
        })
        .collect()
}

fn cleanup_attachments(workbench: &WorkbenchDb, root: &Path) -> Result<(), String> {
    for (id, relative) in workbench.attachment_cleanup_candidates()? {
        let first = Path::new(&relative).components().next();
        if let Some(std::path::Component::Normal(directory)) = first {
            // Removal is idempotent; only delete the row after the managed directory is absent.
            std::fs::remove_dir_all(root.join(directory))
                .or_else(|error| {
                    if error.kind() == std::io::ErrorKind::NotFound {
                        Ok(())
                    } else {
                        Err(error)
                    }
                })
                .map_err(|error| error.to_string())?;
            workbench.finish_attachment_cleanup(&id)?;
        }
    }
    Ok(())
}

fn cleanup_attachment_orphans(workbench: &WorkbenchDb, root: &Path) -> Result<(), String> {
    let known = workbench
        .attachment_managed_directories()?
        .into_iter()
        .collect::<HashSet<_>>();
    for entry in std::fs::read_dir(root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if known.contains(&name) || uuid::Uuid::parse_str(&name).is_err() {
            continue;
        }
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if file_type.is_dir() {
            std::fs::remove_dir_all(entry.path()).map_err(|error| error.to_string())?;
        } else {
            std::fs::remove_file(entry.path()).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn trace_publication_allowed(
    runtime_is_registered: bool,
    bridge_is_current: bool,
    generation: u64,
    expected_generation: u64,
    trace_exists: bool,
) -> bool {
    runtime_is_registered && bridge_is_current && generation == expected_generation && !trace_exists
}

fn start_trace_for_runtime(
    agent_id: &str,
    runtime: Arc<ManagedRuntime>,
    bridge: Arc<Bridge>,
) -> Result<(), String> {
    bridge.assert_agent_id(agent_id)?;
    bridge.emit_state();
    if runtime.trace.lock().unwrap().is_some() {
        return Ok(());
    }
    if runtime
        .trace_starting
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Ok(());
    }
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
            let app = bridge.app.clone();
            let target = bridge.clone();
            let runtime_target = runtime.clone();
            let agent_id = agent_id.to_owned();
            let generation = runtime.trace_generation.load(Ordering::SeqCst);
            std::thread::spawn(move || {
                let privacy = match load_trace_privacy(&target.workbench, &agent_id) {
                    Ok(privacy) => privacy,
                    Err(error) => {
                        runtime_target.trace_starting.store(false, Ordering::SeqCst);
                        *target.trace_error.lock().unwrap() = Some(error);
                        target.emit_state();
                        return;
                    }
                };
                match TraceBridge::spawn_process(
                    &app,
                    &path,
                    privacy,
                    target.trace_healthy.clone(),
                    target.trace_error.clone(),
                    Arc::downgrade(&target),
                ) {
                    Ok(trace) => {
                        if let Err(error) = trace.initialize(privacy) {
                            trace.shutdown();
                            runtime_target.trace_starting.store(false, Ordering::SeqCst);
                            *target.trace_error.lock().unwrap() = Some(error);
                            target.emit_state();
                            return;
                        }
                        let state = app.state::<AppState>();
                        let registered = state
                            .manager
                            .runtimes
                            .lock()
                            .unwrap()
                            .get(&agent_id)
                            .is_some_and(|candidate| Arc::ptr_eq(candidate, &runtime_target));
                        let published = {
                            let owns_target = runtime_target
                                .bridge
                                .lock()
                                .unwrap()
                                .as_ref()
                                .is_some_and(|bridge| Arc::ptr_eq(bridge, &target));
                            let mut current_trace = runtime_target.trace.lock().unwrap();
                            if !trace_publication_allowed(
                                registered,
                                owns_target,
                                runtime_target.trace_generation.load(Ordering::SeqCst),
                                generation,
                                current_trace.is_some(),
                            ) {
                                false
                            } else {
                                *current_trace = Some(trace.clone());
                                true
                            }
                        };
                        runtime_target.trace_starting.store(false, Ordering::SeqCst);
                        if !published {
                            trace.shutdown();
                        } else {
                            target.emit_state();
                        }
                    }
                    Err(error) => {
                        runtime_target.trace_starting.store(false, Ordering::SeqCst);
                        *target.trace_error.lock().unwrap() = Some(error);
                        target.emit_state();
                    }
                }
            });
        } else {
            runtime.trace_starting.store(false, Ordering::SeqCst);
            *bridge.trace_error.lock().unwrap() = Some(
                "Execution did not resolve an exact SQLite path; trace is unavailable.".into(),
            );
            bridge.emit_state();
        }
    } else {
        runtime.trace_starting.store(false, Ordering::SeqCst);
        *bridge.trace_error.lock().unwrap() =
            Some("Execution configuration is invalid; trace is unavailable.".into());
        bridge.emit_state();
    }
    Ok(())
}

fn trace_privacy_setting(agent_id: &str) -> String {
    format!("{TRACE_PRIVACY_SETTING}/{agent_id}")
}

fn load_trace_privacy(workbench: &WorkbenchDb, agent_id: &str) -> Result<TracePrivacy, String> {
    let persisted = match workbench.load_setting(&trace_privacy_setting(agent_id))? {
        Some(scoped) => Some(scoped),
        None => workbench.load_setting(TRACE_PRIVACY_SETTING)?,
    };
    let mut privacy: TracePrivacy = persisted
        .map(serde_json::from_value)
        .transpose()
        .map_err(|error| format!("Invalid persisted trace privacy settings: {error}"))?
        .unwrap_or_default();
    if privacy.reasoning {
        privacy.messages = true;
    }
    Ok(privacy)
}

fn request_trace_report(
    trace: &TraceBridge,
    privacy: TracePrivacy,
    root_run_id: &str,
    attachment_root: &Path,
) -> Response {
    let mut report = trace.request_wait(
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
    )?;
    redact_managed_attachment_paths(&mut report, attachment_root);
    Ok(report)
}

fn redact_managed_attachment_paths(value: &mut Value, attachment_root: &Path) {
    let root = attachment_root.to_string_lossy();
    match value {
        Value::String(text) if text.contains(root.as_ref()) => {
            *text = text.replace(root.as_ref(), "[MANAGED_ATTACHMENT]");
        }
        Value::Array(values) => {
            for value in values {
                redact_managed_attachment_paths(value, attachment_root);
            }
        }
        Value::Object(object) => {
            for value in object.values_mut() {
                redact_managed_attachment_paths(value, attachment_root);
            }
        }
        _ => {}
    }
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

fn schedule_trace_refresh(
    app: &AppHandle,
    agent_id: String,
    root_run_id: String,
    final_refresh: bool,
) {
    let state = app.state::<AppState>();
    let Ok(runtime) = runtime_for(&state, &agent_id, true) else {
        return;
    };
    {
        let mut refreshes = runtime.trace_refreshes.lock().unwrap();
        if !queue_trace_refresh(&mut refreshes, &root_run_id, final_refresh) {
            return;
        }
    }

    let app = app.clone();
    std::thread::spawn(move || loop {
        let state = app.state::<AppState>();
        let Ok(runtime) = runtime_for(&state, &agent_id, true) else {
            return;
        };
        let final_refresh = runtime
            .trace_refreshes
            .lock()
            .unwrap()
            .get_mut(&root_run_id)
            .is_some_and(|refresh| std::mem::take(&mut refresh.final_refresh));
        let (privacy, trace, attachment_root, request_revision) = {
            let bridge = runtime.bridge.lock().unwrap().as_ref().cloned();
            let trace = runtime.trace.lock().unwrap().as_ref().cloned();
            let privacy = bridge
                .as_ref()
                .and_then(|bridge| load_trace_privacy(&bridge.workbench, &agent_id).ok());
            let attachment_root = bridge.as_ref().map(|bridge| bridge.attachment_root.clone());
            let selection = runtime.trace_selection.lock().unwrap();
            let request_revision = (selection.root_run_id.as_deref() == Some(root_run_id.as_str()))
                .then_some(selection.revision);
            (privacy, trace, attachment_root, request_revision)
        };
        let response = match (privacy, trace.as_ref(), attachment_root.as_deref()) {
            (Some(privacy), Some(trace), Some(attachment_root)) => {
                request_trace_report(trace, privacy, &root_run_id, attachment_root)
            }
            _ => Err("Trace inspector is not ready.".into()),
        };
        let selection = runtime.trace_selection.lock().unwrap();
        if request_revision == Some(selection.revision)
            && selection.root_run_id.as_deref() == Some(root_run_id.as_str())
        {
            let payload = match response.as_ref() {
                Ok(report) => json!({
                    "agentId": agent_id,
                    "rootRunId": root_run_id,
                    "revision": selection.revision,
                    "finalRefresh": final_refresh,
                    "report": report
                }),
                Err(error) => json!({
                    "agentId": agent_id,
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
                    "agentId": agent_id,
                    "rootRunId": root_run_id,
                    "summary": report.get("summary"),
                    "usage": report.get("usage"),
                    "rootRuns": report.get("rootRuns")
                }),
            );
        }

        let mut refreshes = runtime.trace_refreshes.lock().unwrap();
        if complete_trace_refresh(&mut refreshes, &root_run_id) {
            continue;
        }
        break;
    });
}

#[tauri::command]
fn select_trace(
    agent_id: String,
    root_run_id: Option<String>,
    app: AppHandle,
) -> Result<u64, String> {
    let state = app.state::<AppState>();
    let runtime = runtime_for(&state, &agent_id, true)?;
    let revision = {
        let mut selection = runtime.trace_selection.lock().unwrap();
        selection.revision += 1;
        selection.root_run_id = root_run_id.clone();
        selection.revision
    };
    let Some(root_run_id) = root_run_id else {
        return Ok(revision);
    };
    let bridge = bridge_for(&state, &agent_id, true)?;
    bridge.workbench.assert_run_owner(&agent_id, &root_run_id)?;
    schedule_trace_refresh(&app, agent_id.clone(), root_run_id.clone(), false);
    let app = app.clone();
    std::thread::spawn(move || {
        let mut tick = 0_u64;
        loop {
            std::thread::sleep(Duration::from_millis(1_500));
            let state = app.state::<AppState>();
            let Ok(runtime) = runtime_for(&state, &agent_id, true) else {
                break;
            };
            let selected = {
                let selection = runtime.trace_selection.lock().unwrap();
                selection.revision == revision
                    && selection.root_run_id.as_deref() == Some(root_run_id.as_str())
            };
            if !selected || state.shutdown_started.load(Ordering::SeqCst) {
                break;
            }
            tick += 1;
            let active = runtime
                .bridge
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|bridge| {
                    bridge
                        .registry
                        .lock()
                        .unwrap()
                        .get(&root_run_id)
                        .is_some_and(|run| run.occupies_slot)
                });
            if active || tick % 7 == 0 {
                schedule_trace_refresh(&app, agent_id.clone(), root_run_id.clone(), false);
            }
            if tick % 7 == 0 {
                let roots = runtime
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
                    schedule_trace_refresh(&app, agent_id.clone(), root.clone(), false);
                }
            }
        }
    });
    Ok(revision)
}

#[tauri::command]
fn get_trace_privacy(
    agent_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<TracePrivacy, String> {
    let bridge = bridge_for(&state, &agent_id, true)?;
    load_trace_privacy(&bridge.workbench, &agent_id)
}

#[tauri::command]
fn set_trace_privacy(
    agent_id: String,
    mut privacy: TracePrivacy,
    app: AppHandle,
) -> Result<TracePrivacy, String> {
    if privacy.reasoning {
        privacy.messages = true;
    }
    let state = app.state::<AppState>();
    let runtime = runtime_for(&state, &agent_id, false)?;
    let (bridge, sqlite_path, old_trace, trace_generation) = {
        let _lifecycle = state.lifecycle.lock().unwrap();
        if state.reconfiguring.load(Ordering::SeqCst) {
            return Err(
                "Trace privacy cannot be changed while settings are being reloaded.".into(),
            );
        }
        let trace_generation = runtime.trace_generation.fetch_add(1, Ordering::SeqCst) + 1;
        let bridge = runtime
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
        let old_trace = runtime.trace.lock().unwrap().as_ref().cloned();
        (bridge, sqlite_path, old_trace, trace_generation)
    };
    if load_trace_privacy(&bridge.workbench, &agent_id)? == privacy && old_trace.is_some() {
        return Ok(privacy);
    }
    let (stopped_trace, selected_root) = {
        let _lifecycle = state.lifecycle.lock().unwrap();
        if runtime
            .bridge
            .lock()
            .unwrap()
            .as_ref()
            .is_none_or(|current| !Arc::ptr_eq(current, &bridge))
            || runtime.trace_generation.load(Ordering::SeqCst) != trace_generation
        {
            return Err("Execution runtime changed while trace privacy was updating.".into());
        }
        let stopped_trace = runtime.trace.lock().unwrap().take();
        let mut selection = runtime.trace_selection.lock().unwrap();
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
        Arc::downgrade(&bridge),
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
        &trace_privacy_setting(&agent_id),
        &serde_json::to_value(privacy).unwrap(),
    ) {
        replacement.shutdown();
        *bridge.trace_error.lock().unwrap() = Some(error.clone());
        bridge.emit_state();
        return Err(error);
    }
    let runtime_changed = {
        let _lifecycle = state.lifecycle.lock().unwrap();
        if runtime
            .bridge
            .lock()
            .unwrap()
            .as_ref()
            .is_none_or(|current| !Arc::ptr_eq(current, &bridge))
            || runtime.trace_generation.load(Ordering::SeqCst) != trace_generation
        {
            true
        } else {
            *runtime.trace.lock().unwrap() = Some(replacement.clone());
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
        let _ = select_trace(agent_id, Some(root_run_id), app.clone());
    }
    Ok(privacy)
}

#[tauri::command]
fn desktop_state(
    agent_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<DesktopState, String> {
    match bridge_for(&state, &agent_id, true) {
        Ok(bridge) => Ok(bridge.snapshot()),
        Err(error)
            if state
                .manager
                .catalog
                .lock()
                .unwrap()
                .current_agent_id
                .as_deref()
                == Some(agent_id.as_str()) =>
        {
            *state.manager.bootstrap_error.lock().unwrap() = Some(error);
            Ok(state
                .manager
                .error_snapshot(state.quit.lock().unwrap().state()))
        }
        Err(error) => Err(error),
    }
}

#[tauri::command]
fn desktop_catalog_status(
    state: tauri::State<'_, AppState>,
) -> Result<DesktopCatalogStatus, String> {
    let quit_state = state.quit.lock().unwrap().state();
    state
        .manager
        .catalog_status(quit_state, state.window_limit_diagnostic.clone())
}

#[tauri::command]
async fn open_agent_window(
    agent_id: String,
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<AgentWindowOpen, String> {
    let _lifecycle = state.lifecycle.lock().unwrap();
    if state.reconfiguring.load(Ordering::SeqCst) {
        return Err("Settings are being reloaded; try again when the runtime is ready.".into());
    }
    if state.quit.lock().unwrap().state() != QuitState::Idle {
        return Err("The desktop is quitting and cannot open an agent workspace.".into());
    }
    let label = agent_window_label(&agent_id);
    if state.closing_agent_windows.lock().unwrap().contains(&label) {
        return Err(format!(
            "Agent window for '{agent_id}' is closing; try again."
        ));
    }
    if let Some(window) = app.get_webview_window(&label) {
        window
            .unminimize()
            .map_err(|error| format!("Unable to restore agent window: {error}"))?;
        ensure_agent_window_visible(&window)?;
        window
            .show()
            .map_err(|error| format!("Unable to show agent window: {error}"))?;
        window
            .set_focus()
            .map_err(|error| format!("Unable to focus agent window: {error}"))?;
        let open_windows = open_agent_window_count(&app, state.inner());
        return Ok(AgentWindowOpen {
            agent_id,
            disposition: "focused",
            open_windows,
            max_windows: state.max_agent_windows,
        });
    }
    let open_windows = open_agent_window_count(&app, state.inner());
    if open_windows >= state.max_agent_windows {
        return Err(format!(
            "Agent window limit reached ({}/{}). Close an agent window before opening another.",
            open_windows, state.max_agent_windows
        ));
    }
    let runtime = state.manager.ensure_runtime(&agent_id, false)?;
    let bridge = runtime
        .bridge
        .lock()
        .unwrap()
        .as_ref()
        .cloned()
        .ok_or("Desktop runtime is unavailable.")?;
    start_trace_for_runtime(&agent_id, runtime, bridge)?;
    let descriptor = state
        .manager
        .catalog
        .lock()
        .unwrap()
        .agents
        .get(&agent_id)
        .cloned()
        .ok_or_else(|| format!("Unknown agent '{agent_id}'."))?;
    let presentation = state
        .manager
        .workbench
        .load_setting(&window_presentation_key(&agent_id))?
        .map(serde_json::from_value::<WindowPresentation>)
        .transpose()
        .map_err(|error| format!("Invalid saved window presentation: {error}"))?
        .unwrap_or_default();
    let builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title(format!("{} — AdaptiveAgent", descriptor.name))
        .inner_size(
            presentation.width.unwrap_or(1180).max(680) as f64,
            presentation.height.unwrap_or(780).max(600) as f64,
        )
        .min_inner_size(680.0, 600.0)
        .resizable(true)
        .visible(false);
    let window = builder
        .build()
        .map_err(|error| format!("Unable to create agent window: {error}"))?;
    if let (Some(x), Some(y)) = (presentation.x, presentation.y) {
        window
            .set_position(tauri::PhysicalPosition::new(x, y))
            .map_err(|error| format!("Unable to restore agent window position: {error}"))?;
    }
    ensure_agent_window_visible(&window)?;
    window
        .show()
        .map_err(|error| format!("Unable to show agent window: {error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("Unable to focus agent window: {error}"))?;
    Ok(AgentWindowOpen {
        agent_id,
        disposition: "created",
        open_windows: open_windows + 1,
        max_windows: state.max_agent_windows,
    })
}

#[tauri::command]
fn desktop_window_bootstrap(
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<DesktopWindowBootstrap, String> {
    let Some(agent_id) = agent_id_from_window_label(window.label()) else {
        return Ok(DesktopWindowBootstrap {
            kind: "studio",
            agent_id: None,
            state: None,
            presentation: None,
        });
    };
    let runtime = state.manager.ensure_runtime(&agent_id, true)?;
    let bridge = runtime
        .bridge
        .lock()
        .unwrap()
        .as_ref()
        .cloned()
        .ok_or("Desktop runtime is unavailable.")?;
    let presentation = state
        .manager
        .workbench
        .load_setting(&window_presentation_key(&agent_id))?
        .map(serde_json::from_value)
        .transpose()
        .map_err(|error| format!("Invalid saved window presentation: {error}"))?;
    Ok(DesktopWindowBootstrap {
        kind: "agent",
        agent_id: Some(agent_id),
        state: Some(bridge.snapshot()),
        presentation,
    })
}

#[tauri::command]
fn save_window_presentation(
    presentation: WindowPresentationUi,
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let agent_id = agent_id_from_window_label(window.label())
        .ok_or("Window presentation is only available to agent windows.")?;
    let _presentation = state.window_presentation.lock().unwrap();
    let key = window_presentation_key(&agent_id);
    let mut saved = state
        .manager
        .workbench
        .load_setting(&key)?
        .map(serde_json::from_value::<WindowPresentation>)
        .transpose()
        .map_err(|error| format!("Invalid saved window presentation: {error}"))?
        .unwrap_or_default();
    saved.inspector_width = Some(presentation.inspector_width.clamp(320, 720));
    saved.inspector_open = presentation.inspector_open;
    saved.selection = Some(presentation.selection);
    state.manager.workbench.save_setting(
        &key,
        &serde_json::to_value(saved).map_err(|error| error.to_string())?,
    )
}

/// Compatibility bootstrap for the single-window renderer. Native callers should bind
/// subsequent operations to the returned agent ID rather than trusting renderer state.
#[tauri::command]
fn desktop_bootstrap(state: tauri::State<'_, AppState>) -> Result<Value, String> {
    let snapshot = match state.manager.current() {
        Ok(runtime) => runtime
            .bridge
            .lock()
            .unwrap()
            .as_ref()
            .map(|bridge| bridge.snapshot())
            .unwrap_or_else(|| {
                state
                    .manager
                    .error_snapshot(state.quit.lock().unwrap().state())
            }),
        Err(error) => {
            *state.manager.bootstrap_error.lock().unwrap() = Some(error);
            state
                .manager
                .error_snapshot(state.quit.lock().unwrap().state())
        }
    };
    Ok(json!({ "currentAgentId": snapshot.agent_id, "state": snapshot }))
}

#[tauri::command]
fn reload_settings(
    agent_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<DesktopState, String> {
    if state
        .reconfiguring
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("Settings are already being reloaded.".into());
    }
    let result = (|| {
        let _lifecycle = state.lifecycle.lock().unwrap();
        if state.quit.lock().unwrap().state() != QuitState::Idle {
            return Err("Settings cannot be reloaded while quitting.".into());
        }
        let bridges = state.manager.runtime_bridges();
        if bridges
            .iter()
            .any(|bridge| bridge.registry.lock().unwrap().any_active())
        {
            return Err("Stop all active runs before reloading global settings.".into());
        }
        drop(_lifecycle);
        let failures = state
            .manager
            .converge_after_catalog_refresh()
            .map_err(|error| format!("RUNTIME_RESTART_FAILED: {error}"))?;
        if !failures.is_empty() {
            return Err(format!("RUNTIME_RESTART_FAILED: {}", failures.join("; ")));
        }
        let runtime = state.manager.ensure_runtime(&agent_id, false)?;
        let bridge = runtime
            .bridge
            .lock()
            .unwrap()
            .as_ref()
            .cloned()
            .ok_or("Desktop runtime is unavailable.")?;
        start_trace_for_runtime(&agent_id, runtime, bridge.clone())?;
        Ok(bridge.snapshot())
    })();
    state.reconfiguring.store(false, Ordering::SeqCst);
    result
}

#[tauri::command]
fn save_settings(
    agent_id: String,
    settings: Value,
    state: tauri::State<'_, AppState>,
) -> Result<DesktopState, String> {
    if state
        .reconfiguring
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("Settings are already being reloaded.".into());
    }
    let result = (|| {
        let _lifecycle = state.lifecycle.lock().unwrap();
        if state.quit.lock().unwrap().state() != QuitState::Idle {
            return Err("Settings cannot be saved while quitting.".into());
        }
        let bridge = bridge_for(&state, &agent_id, false)?;
        if state
            .manager
            .runtime_bridges()
            .iter()
            .any(|candidate| candidate.registry.lock().unwrap().any_active())
        {
            return Err("Stop all active runs before saving global settings.".into());
        }
        let supplied_id = settings
            .pointer("/agent/id")
            .and_then(Value::as_str)
            .ok_or("Settings must include agent.id.")?;
        if supplied_id != agent_id {
            return Err("Settings cannot switch away from the addressed agent.".into());
        }
        let supplied_path = settings
            .pointer("/agent/configPath")
            .and_then(Value::as_str)
            .unwrap_or("");
        let expected_path = state
            .manager
            .catalog
            .lock()
            .unwrap()
            .agents
            .get(&agent_id)
            .map(|d| d.config_path.clone())
            .ok_or_else(|| format!("Unknown agent '{agent_id}'."))?;
        if canonical_path(supplied_path)? != canonical_path(&expected_path)? {
            return Err("Settings cannot change the addressed agent configuration path.".into());
        }
        drop(_lifecycle);
        bridge.request_wait(
            "settings/update",
            json!({ "settings": settings }),
            REQUEST_TIMEOUT,
        )?;
        let failures = state
            .manager
            .converge_after_catalog_refresh()
            .map_err(|error| format!("SETTINGS_SAVED_RUNTIME_RESTART_FAILED: {error}"))?;
        if !failures.is_empty() {
            return Err(format!(
                "SETTINGS_SAVED_RUNTIME_RESTART_FAILED: {}",
                failures.join("; ")
            ));
        }
        let runtime = state
            .manager
            .ensure_runtime(&agent_id, false)
            .map_err(|error| {
                format!("SETTINGS_SAVED_RUNTIME_RESTART_FAILED: {agent_id}: {error}")
            })?;
        let bridge = runtime
            .bridge
            .lock()
            .unwrap()
            .as_ref()
            .cloned()
            .ok_or("Desktop runtime is unavailable.")?;
        start_trace_for_runtime(&agent_id, runtime, bridge.clone())?;
        Ok(bridge.snapshot())
    })();
    state.reconfiguring.store(false, Ordering::SeqCst);
    result
}

#[tauri::command]
fn start_run(
    agent_id: String,
    task: String,
    attachment_ids: Option<Vec<String>>,
    state: tauri::State<'_, AppState>,
) -> Result<StartedRun, String> {
    if task.trim().is_empty() {
        return Err("Task description is required.".into());
    }
    let _lifecycle = state.lifecycle.lock().unwrap();
    if state.reconfiguring.load(Ordering::SeqCst) {
        return Err("Settings are being reloaded; try again when the runtime is ready.".into());
    }
    if state.quit.lock().unwrap().state() != QuitState::Idle {
        return Err("The desktop is quitting and cannot start new runs.".into());
    }
    let bridge = bridge_for(&state, &agent_id, false)?;
    if !bridge.snapshot().configuration_valid {
        return Err(bridge
            .snapshot()
            .error
            .unwrap_or_else(|| "Settings are invalid.".into()));
    }
    bridge.start_run(task, attachment_ids.unwrap_or_default())
}

#[tauri::command]
fn select_attachments(
    agent_id: String,
    app: AppHandle,
    existing_attachment_ids: Option<Vec<String>>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AttachmentDraft>, String> {
    let bridge = bridge_for(&state, &agent_id, false)?;
    let selected = app
        .dialog()
        .file()
        .blocking_pick_files()
        .unwrap_or_default();
    let existing = bridge.validated_drafts(&existing_attachment_ids.unwrap_or_default())?;
    if selected.len() + existing.len() > MAX_ATTACHMENT_COUNT {
        return Err("At most 8 attachments may be selected.".into());
    }
    let mut drafts = Vec::new();
    let mut total = existing.iter().map(|draft| draft.size_bytes).sum::<u64>();
    for selected in selected {
        let path = match selected.into_path() {
            Ok(path) => path,
            Err(_) => {
                discard_imported_drafts(&bridge, &drafts);
                return Err("ATTACHMENT_PATH_INVALID".into());
            }
        };
        let draft = match attachments::import_file(&bridge.attachment_root, &path) {
            Ok(draft) => draft,
            Err(error) => {
                discard_imported_drafts(&bridge, &drafts);
                return Err(error);
            }
        };
        total += draft.size_bytes;
        if total > MAX_SUBMISSION_BYTES {
            let _ = std::fs::remove_dir_all(bridge.attachment_root.join(&draft.id));
            discard_imported_drafts(&bridge, &drafts);
            return Err("Attachments exceed 40 MiB total.".into());
        }
        if let Err(error) = bridge
            .workbench
            .insert_draft_for_agent(&bridge.agent_id, &draft)
        {
            let _ = std::fs::remove_dir_all(bridge.attachment_root.join(&draft.id));
            discard_imported_drafts(&bridge, &drafts);
            return Err(error);
        }
        drafts.push(draft);
    }
    Ok(drafts)
}

fn discard_imported_drafts(bridge: &Bridge, drafts: &[AttachmentDraft]) {
    for draft in drafts {
        if bridge
            .workbench
            .discard_draft_for_agent(&bridge.agent_id, &draft.id)
            .is_ok()
            && std::fs::remove_dir_all(bridge.attachment_root.join(&draft.id)).is_ok()
        {
            let _ = bridge.workbench.finish_attachment_cleanup(&draft.id);
        }
    }
}

#[tauri::command]
fn discard_attachment_draft(
    agent_id: String,
    attachment_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let bridge = bridge_for(&state, &agent_id, true)?;
    if let Some(relative) = bridge
        .workbench
        .discard_draft_for_agent(&agent_id, &attachment_id)?
    {
        if let Some(std::path::Component::Normal(directory)) =
            Path::new(&relative).components().next()
        {
            std::fs::remove_dir_all(bridge.attachment_root.join(directory))
                .or_else(|error| {
                    if error.kind() == std::io::ErrorKind::NotFound {
                        Ok(())
                    } else {
                        Err(error)
                    }
                })
                .map_err(|error| error.to_string())?;
            bridge.workbench.finish_attachment_cleanup(&attachment_id)?;
        }
    }
    Ok(())
}

#[tauri::command]
fn stop_run(
    agent_id: String,
    run_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let bridge = bridge_for(&state, &agent_id, true)?;
    bridge.workbench.assert_run_owner(&agent_id, &run_id)?;
    bridge.stop_run(&run_id)
}

#[tauri::command]
fn get_run_recovery_plan(
    agent_id: String,
    run_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Value, String> {
    let bridge = bridge_for(&state, &agent_id, true)?;
    bridge.workbench.assert_run_owner(&agent_id, &run_id)?;
    bridge.recovery_plan(&run_id)
}

#[tauri::command]
fn recover_run(
    agent_id: String,
    run_id: String,
    expected_status: String,
    expected_action: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let _lifecycle = state.lifecycle.lock().unwrap();
    if state.reconfiguring.load(Ordering::SeqCst) {
        return Err("Settings are being reloaded; try again when the runtime is ready.".into());
    }
    if state.quit.lock().unwrap().state() != QuitState::Idle {
        return Err("The desktop is quitting and cannot recover runs.".into());
    }
    let bridge = bridge_for(&state, &agent_id, true)?;
    bridge.workbench.assert_run_owner(&agent_id, &run_id)?;
    bridge.recover_run(&run_id, &expected_status, &expected_action)
}

#[tauri::command]
fn steer_run(
    agent_id: String,
    run_id: String,
    message: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    if message.trim().is_empty() {
        return Err("A steering message is required.".into());
    }
    let bridge = bridge_for(&state, &agent_id, true)?;
    bridge.workbench.assert_run_owner(&agent_id, &run_id)?;
    bridge.steer_run(&run_id, message.trim())
}

#[tauri::command]
fn get_run_result(
    agent_id: String,
    run_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Option<Value>, String> {
    let bridge = bridge_for(&state, &agent_id, true)?;
    bridge.workbench.assert_run_owner(&agent_id, &run_id)?;
    bridge.workbench.get_result(&run_id)
}

#[tauri::command]
fn get_run_overview(
    agent_id: String,
    run_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Value, String> {
    let runtime = runtime_for(&state, &agent_id, true)?;
    let (privacy, trace, attachment_root) = {
        let bridge = bridge_for(&state, &agent_id, true)?;
        bridge.workbench.assert_run_owner(&agent_id, &run_id)?;
        let privacy = load_trace_privacy(&bridge.workbench, &agent_id)?;
        let trace = runtime
            .trace
            .lock()
            .unwrap()
            .as_ref()
            .cloned()
            .ok_or("Trace inspector is not ready.")?;
        (privacy, trace, bridge.attachment_root.clone())
    };
    request_trace_report(&trace, privacy, &run_id, &attachment_root)
}

const ARTIFACT_EXTENSIONS: &[&str] = &[
    "pdf", "csv", "json", "md", "markdown", "txt", "log", "xml", "yaml", "yml", "png", "jpg",
    "jpeg", "svg", "htm", "html", "doc", "docx", "xls", "xlsx", "zip", "gif", "webp", "bmp", "mp4",
    "webm", "mov", "m4v", "ogv",
];
const MAX_TEXT_PREVIEW_BYTES: u64 = 5 * 1024 * 1024;
const MAX_MEDIA_PREVIEW_BYTES: u64 = 32 * 1024 * 1024;

fn workspace_paths(state: &AppState, agent_id: &str) -> Result<(PathBuf, PathBuf), String> {
    let bridge = bridge_for(state, agent_id, true)?;
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
    agent_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<WorkspaceArtifact>, String> {
    let (root, _) = workspace_paths(&state, &agent_id)?;
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
    agent_id: String,
    path: String,
    state: tauri::State<'_, AppState>,
) -> Result<ArtifactPreview, String> {
    let (root, shell_cwd) = workspace_paths(&state, &agent_id)?;
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
    agent_id: String,
    root_run_id: String,
    approval_run_id: String,
    approval_id: String,
    approved: bool,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let bridge = bridge_for(&state, &agent_id, true)?;
    bridge.workbench.assert_pending_approval_owner(
        &agent_id,
        &root_run_id,
        &approval_run_id,
        &approval_id,
    )?;
    bridge.resolve_approval(root_run_id, approval_run_id, approval_id, approved)
}

#[tauri::command]
fn create_chat(
    agent_id: String,
    title: String,
    state: tauri::State<'_, AppState>,
) -> Result<ChatDto, String> {
    let _lifecycle = state.lifecycle.lock().unwrap();
    if state.reconfiguring.load(Ordering::SeqCst) {
        return Err("Settings are being reloaded; try again when the runtime is ready.".into());
    }
    if state.quit.lock().unwrap().state() != QuitState::Idle {
        return Err("The desktop is quitting and cannot create chats.".into());
    }
    let bridge = bridge_for(&state, &agent_id, false)?;
    let (id, name, fingerprint, config_path) = bridge.current_agent()?;
    let configuration = bridge.configuration.lock().unwrap();
    let workspace_root = configuration
        .as_ref()
        .and_then(|configuration| configuration.pointer("/workspace/root"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let shell_cwd = configuration
        .as_ref()
        .and_then(|configuration| configuration.pointer("/workspace/shellCwd"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    drop(configuration);
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
        pinned_agent_config_path: config_path,
        workspace_root,
        shell_cwd,
    };
    bridge.workbench.create_chat(&chat)?;
    bridge.chat_dto(&chat.item_id)
}

#[tauri::command]
fn list_chats(agent_id: String, state: tauri::State<'_, AppState>) -> Result<Vec<ChatDto>, String> {
    let bridge = bridge_for(&state, &agent_id, true)?;
    bridge
        .workbench
        .list_chats_for_agent(&agent_id)?
        .iter()
        .map(|chat| bridge.chat_dto(&chat.item_id))
        .collect()
}

#[tauri::command]
fn load_chat(
    agent_id: String,
    item_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<ChatDto, String> {
    bridge_for(&state, &agent_id, true)?.chat_dto(&item_id)
}

#[tauri::command]
fn preview_history_deletion(
    agent_id: String,
    target: ProductDeletionTarget,
    state: tauri::State<'_, AppState>,
) -> Result<DeletionPreview, String> {
    bridge_for(&state, &agent_id, true)?.preview_deletion(target)
}

#[tauri::command]
fn delete_history(
    agent_id: String,
    target: ProductDeletionTarget,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let _lifecycle = state.lifecycle.lock().unwrap();
    if state.quit.lock().unwrap().state() != QuitState::Idle {
        return Err("The desktop is quitting and cannot delete history.".into());
    }
    bridge_for(&state, &agent_id, true)?.delete_history(target)
}

#[tauri::command]
fn send_chat_turn(
    agent_id: String,
    item_id: String,
    content: String,
    attachment_ids: Option<Vec<String>>,
    state: tauri::State<'_, AppState>,
) -> Result<StartedRun, String> {
    if content.trim().is_empty() {
        return Err("Message is required.".into());
    }
    let _lifecycle = state.lifecycle.lock().unwrap();
    if state.reconfiguring.load(Ordering::SeqCst) {
        return Err("Settings are being reloaded; try again when the runtime is ready.".into());
    }
    if state.quit.lock().unwrap().state() != QuitState::Idle {
        return Err("The desktop is quitting and cannot start new runs.".into());
    }
    let bridge = bridge_for(&state, &agent_id, false)?;
    bridge.workbench.assert_item_owner(&agent_id, &item_id)?;
    bridge.send_chat(
        item_id,
        content.trim().into(),
        attachment_ids.unwrap_or_default(),
    )
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
        .manager
        .current()?
        .bridge
        .lock()
        .unwrap()
        .as_ref()
        .cloned()
        .ok_or_else(|| "Desktop runtime is not available.".to_string())?;
    let bridges = state.manager.runtime_bridges();
    state.quit.lock().unwrap().drain().map_err(str::to_owned)?;
    for candidate in &bridges {
        candidate.draining.store(true, Ordering::SeqCst);
    }
    let cancellation_targets = bridges
        .iter()
        .map(|candidate| {
            (
                candidate.clone(),
                candidate.registry.lock().unwrap().occupied_ids(),
            )
        })
        .collect::<Vec<_>>();
    drop(lifecycle);
    for candidate in &bridges {
        candidate.emit_state();
    }
    let snapshot = bridge.snapshot();

    let app = app.clone();
    std::thread::spawn(move || {
        if matches!(mode, DrainMode::Terminate) {
            for (candidate, ids) in &cancellation_targets {
                candidate.arm_cancellations(ids);
            }
        }
        loop {
            let outstanding = bridges
                .iter()
                .map(|candidate| {
                    (
                        candidate.clone(),
                        candidate.registry.lock().unwrap().occupied_ids(),
                    )
                })
                .collect::<Vec<_>>();
            if outstanding.iter().all(|(_, ids)| ids.is_empty()) {
                break;
            }
            for (candidate, ids) in outstanding {
                for id in ids {
                    candidate.reconcile_run(id);
                }
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
    drop(lifecycle);
    for window in app.webview_windows().values() {
        if let Err(error) = persist_agent_window_bounds(window, &state) {
            eprintln!(
                "Unable to persist agent window '{}' during shutdown: {error}",
                window.label()
            );
        }
    }
    // Every execution and trace child is discoverable through the manager.
    state.manager.shutdown_all();
    {
        let _lifecycle = state.lifecycle.lock().unwrap();
        let _ = state.quit.lock().unwrap().approve();
    }
    app.exit(0);
}

fn native_close_requested(app: &AppHandle) -> CloseDecision {
    let state = app.state::<AppState>();
    let _lifecycle = state.lifecycle.lock().unwrap();
    let bridges = state.manager.runtime_bridges();
    let occupied = bridges
        .iter()
        .map(|bridge| bridge.registry.lock().unwrap().occupied_slot_count())
        .sum();
    let decision = state.quit.lock().unwrap().close_requested(occupied);
    for bridge in bridges {
        bridge.emit_state();
    }
    decision
}

fn focus_parent_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn persist_agent_window_bounds(window: &WebviewWindow, state: &AppState) -> Result<(), String> {
    let Some(agent_id) = agent_id_from_window_label(window.label()) else {
        return Ok(());
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let position = window
        .outer_position()
        .map_err(|error| format!("Unable to read agent window position: {error}"))?;
    let size = window
        .inner_size()
        .map_err(|error| format!("Unable to read agent window size: {error}"))?;
    let _presentation = state.window_presentation.lock().unwrap();
    let key = window_presentation_key(&agent_id);
    let mut presentation = state
        .manager
        .workbench
        .load_setting(&key)?
        .map(serde_json::from_value::<WindowPresentation>)
        .transpose()
        .map_err(|error| format!("Invalid saved window presentation: {error}"))?
        .unwrap_or_default();
    presentation.x = Some(position.x);
    presentation.y = Some(position.y);
    presentation.width = Some((size.width as f64 / scale).round() as u32);
    presentation.height = Some((size.height as f64 / scale).round() as u32);
    state.manager.workbench.save_setting(
        &key,
        &serde_json::to_value(presentation).map_err(|error| error.to_string())?,
    )
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
    for candidate in state.manager.runtime_bridges() {
        candidate.emit_state();
    }
    match state.manager.current() {
        Ok(runtime) => runtime
            .bridge
            .lock()
            .unwrap()
            .as_ref()
            .map(|bridge| bridge.snapshot())
            .ok_or_else(|| "Desktop runtime is not available.".into()),
        Err(error) => {
            *state.manager.bootstrap_error.lock().unwrap() = Some(error);
            Ok(state
                .manager
                .error_snapshot(state.quit.lock().unwrap().state()))
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            desktop_bootstrap,
            desktop_window_bootstrap,
            desktop_state,
            desktop_catalog_status,
            open_agent_window,
            save_window_presentation,
            reload_settings,
            save_settings,
            start_run,
            select_attachments,
            discard_attachment_draft,
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
                if agent_id_from_window_label(window.label()).is_some() {
                    window
                        .app_handle()
                        .state::<AppState>()
                        .closing_agent_windows
                        .lock()
                        .unwrap()
                        .insert(window.label().into());
                    let persistence = window
                        .app_handle()
                        .get_webview_window(window.label())
                        .ok_or_else(|| "Agent webview window is unavailable.".to_string())
                        .and_then(|webview| {
                            persist_agent_window_bounds(
                                &webview,
                                &window.app_handle().state::<AppState>(),
                            )
                        });
                    if let Err(error) = persistence {
                        eprintln!("Unable to persist agent window presentation: {error}");
                    }
                    return;
                }
                match native_close_requested(window.app_handle()) {
                    CloseDecision::Prevent => api.prevent_close(),
                    CloseDecision::ShutdownNow => {
                        api.prevent_close();
                        approve_and_exit(window.app_handle());
                    }
                    CloseDecision::Allow => {}
                }
            } else if matches!(event, tauri::WindowEvent::Destroyed)
                && agent_id_from_window_label(window.label()).is_some()
            {
                window
                    .app_handle()
                    .state::<AppState>()
                    .closing_agent_windows
                    .lock()
                    .unwrap()
                    .remove(window.label());
            }
        })
        .setup(|app| {
            let manager = AgentRuntimeManager::new(app.handle())?;
            let (max_agent_windows, window_limit_diagnostic) = parse_agent_window_limit(
                std::env::var("ADAPTIVE_AGENT_MAX_WINDOWS").ok().as_deref(),
            );
            app.manage(AppState {
                manager,
                lifecycle: Mutex::new(()),
                reconfiguring: AtomicBool::new(false),
                quit: Mutex::new(QuitCoordinator::default()),
                shutdown_started: AtomicBool::new(false),
                max_agent_windows,
                window_limit_diagnostic,
                closing_agent_windows: Mutex::new(HashSet::new()),
                window_presentation: Mutex::new(()),
            });
            let state = app.state::<AppState>();
            if let Err(error) = state.manager.bootstrap() {
                *state.manager.bootstrap_error.lock().unwrap() = Some(error);
            }
            let runtimes = state
                .manager
                .runtimes
                .lock()
                .unwrap()
                .iter()
                .map(|(agent_id, runtime)| (agent_id.clone(), runtime.clone()))
                .collect::<Vec<_>>();
            for (agent_id, runtime) in runtimes {
                if let Some(bridge) = runtime.bridge.lock().unwrap().as_ref().cloned() {
                    let _ = start_trace_for_runtime(&agent_id, runtime.clone(), bridge);
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build AdaptiveAgent desktop");

    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            match native_close_requested(app) {
                CloseDecision::Prevent => {
                    api.prevent_exit();
                    focus_parent_window(app);
                }
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
    let result = execution_payload(result);
    (result.get("status").and_then(Value::as_str) == Some("success"))
        .then(|| result.get("output"))
        .flatten()
        .cloned()
}

fn canonical_workbench_result(result: &Value, attachment_root: Option<&Path>) -> Value {
    let result = execution_payload(result);
    let mut canonical = match result.get("status").and_then(Value::as_str) {
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
    };
    if let Some(attachment_root) = attachment_root {
        redact_managed_attachment_paths(&mut canonical, attachment_root);
    }
    canonical
}

fn value_as_content(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| value.to_string())
}

fn chat_request_params(run_id: &str, session_id: &str, transcript: Vec<Value>) -> Value {
    json!({"executionId":run_id,"chatSessionId":session_id,"transcript":transcript})
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
    let result = execution_payload(result);
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

fn execution_payload(result: &Value) -> &Value {
    result
        .get("result")
        .filter(|value| value.is_object())
        .unwrap_or(result)
}

fn reject_unsupported_media(drafts: &[AttachmentDraft]) -> Result<(), String> {
    if drafts.iter().any(|draft| draft.kind != "file") {
        return Err("UNSUPPORTED_ATTACHMENT_KIND: Desktop currently supports generic file attachments only.".into());
    }
    Ok(())
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

    fn descriptor(id: &str, state: &str, archived: bool) -> CatalogDescriptor {
        CatalogDescriptor {
            id: id.into(),
            name: id.into(),
            description: Some(format!("{id} description")),
            configuration_fingerprint: format!("fingerprint-{id}"),
            config_path: format!("/agents/{id}.json"),
            validation_state: state.into(),
            archived,
        }
    }

    #[test]
    fn catalog_rejects_duplicate_current_identity() {
        let current = descriptor("agent", "valid", false);
        let result = AgentRuntimeManager::validate_catalog(CatalogInspect {
            agents: vec![current.clone(), current.clone()],
            diagnostics: vec![],
            current_agent: Some(current),
        });
        assert!(result.unwrap_err().contains("not unique"));
    }

    #[test]
    fn shutdown_rejects_new_runtime_publication() {
        assert!(AgentRuntimeManager::publication_allowed(false).is_ok());
        assert!(AgentRuntimeManager::publication_allowed(true)
            .unwrap_err()
            .contains("shut down"));
    }

    #[test]
    fn runtime_selection_must_match_descriptor_path_and_fingerprint() {
        let descriptor = descriptor("agent", "valid", false);
        assert!(AgentRuntimeManager::immutable_selection_matches(
            "/agents/agent.json",
            "fingerprint-agent",
            &descriptor
        ));
        assert!(!AgentRuntimeManager::immutable_selection_matches(
            "/agents/other.json",
            "fingerprint-agent",
            &descriptor
        ));
        assert!(!AgentRuntimeManager::immutable_selection_matches(
            "/agents/agent.json",
            "old-fingerprint",
            &descriptor
        ));
    }

    #[test]
    fn convergence_replaces_valid_archived_runtime_and_retires_unusable_descriptors() {
        assert_eq!(
            AgentRuntimeManager::convergence_action(Some(&descriptor("old", "valid", true))),
            RuntimeConvergence::Replace
        );
        assert_eq!(
            AgentRuntimeManager::convergence_action(Some(&descriptor("bad", "invalid", false))),
            RuntimeConvergence::Retire
        );
        assert_eq!(
            AgentRuntimeManager::convergence_action(None),
            RuntimeConvergence::Retire
        );
    }

    #[test]
    fn current_catalog_publication_is_dynamically_replaceable() {
        let mut publication = CatalogPublication::default();
        publication.current_agent_id = Some("first".into());
        assert_eq!(publication.current_agent_id.as_deref(), Some("first"));
        publication.current_agent_id = Some("replacement".into());
        assert_eq!(publication.current_agent_id.as_deref(), Some("replacement"));
    }

    #[test]
    fn catalog_keeps_all_unique_valid_active_and_archived_profiles() {
        let current = descriptor("current", "valid", false);
        let archived = descriptor("archived", "valid", true);
        let invalid = descriptor("invalid", "invalid", false);
        let (catalog, _) = AgentRuntimeManager::validate_catalog(CatalogInspect {
            agents: vec![current.clone(), archived, invalid],
            diagnostics: vec![json!({"message":"preserved by refresh"})],
            current_agent: Some(current),
        })
        .unwrap();
        assert_eq!(catalog.len(), 3);
        assert!(catalog["archived"].archived);
    }

    #[test]
    fn archived_and_invalid_profiles_are_blocked_for_new_work() {
        assert!(
            AgentRuntimeManager::creation_allowed(&descriptor("old", "valid", true), false)
                .is_err()
        );
        assert!(
            AgentRuntimeManager::creation_allowed(&descriptor("old", "valid", true), true).is_ok()
        );
        assert!(AgentRuntimeManager::creation_allowed(
            &descriptor("dup", "duplicate-id", false),
            true
        )
        .is_err());
    }

    #[test]
    fn fleet_attention_uses_error_approval_recovery_priority() {
        assert_eq!(fleet_attention(false, false, false), "none");
        assert_eq!(fleet_attention(false, false, true), "recovery");
        assert_eq!(fleet_attention(false, true, true), "approval");
        assert_eq!(fleet_attention(true, true, true), "error");
    }

    #[test]
    fn agent_window_labels_are_deterministic_and_round_trip_utf8() {
        let label = agent_window_label("research/日本語:agent");
        assert!(label.starts_with(AGENT_WINDOW_PREFIX));
        assert_eq!(
            agent_id_from_window_label(&label).as_deref(),
            Some("research/日本語:agent")
        );
        assert_eq!(agent_window_label("agent"), agent_window_label("agent"));
        assert!(agent_id_from_window_label("main").is_none());
        assert!(agent_id_from_window_label("agent:xyz").is_none());
    }

    #[test]
    fn agent_window_limit_defaults_and_rejects_non_positive_values() {
        assert_eq!(parse_agent_window_limit(None).0, 3);
        assert_eq!(parse_agent_window_limit(Some(" 5 ")).0, 5);
        assert!(parse_agent_window_limit(Some("5")).1.is_none());
        for invalid in ["", "0", "-1", "many"] {
            let (limit, diagnostic) = parse_agent_window_limit(Some(invalid));
            assert_eq!(limit, 3);
            assert_eq!(
                diagnostic.as_ref().and_then(|value| value["code"].as_str()),
                Some("invalid-agent-window-limit")
            );
        }
    }

    #[test]
    fn trusted_generic_descriptor_omits_inapplicable_optional_fields() {
        let descriptor = trusted_descriptors(&[AttachmentDraft {
            id: "attachment".into(),
            name: "notes.bin".into(),
            kind: "file".into(),
            size_bytes: 3,
            mime_type: None,
            staged_relative_path: "attachment/notes.bin".into(),
            sha256: "a".repeat(64),
            audio_format: None,
        }]);
        assert_eq!(descriptor[0].get("mimeType"), None);
        assert_eq!(descriptor[0].get("audioFormat"), None);
        assert_eq!(descriptor[0]["stagedRelativePath"], "attachment/notes.bin");
    }

    #[test]
    fn workbench_results_redact_managed_attachment_paths() {
        let result = canonical_workbench_result(
            &json!({
                "status": "success",
                "runId": "run",
                "output": { "message": "Read /private/attachments/id/notes.txt" }
            }),
            Some(Path::new("/private/attachments")),
        );
        assert_eq!(
            result["output"]["message"],
            "Read [MANAGED_ATTACHMENT]/id/notes.txt"
        );
    }

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
            Some(canonical_workbench_result(
                &json!({
                    "status": "failure",
                    "runId": "run-2",
                    "error": "Run interrupted",
                    "code": "INTERRUPTED",
                    "stepsUsed": 1,
                    "usage": {}
                }),
                None
            ))
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
    fn activity_projection_redacts_managed_attachment_paths_before_emission() {
        let root = Path::new("/private/app/attachments");
        let mut projected = project_activity_event(
            &json!({
                "id": "event-attachment",
                "runId": "root-run",
                "seq": 5,
                "type": "model.completed",
                "createdAt": "2026-01-01T00:00:00.000Z",
                "payload": {
                    "assistantContent": "/private/app/attachments/attachment-1/notes.txt"
                }
            }),
            "root-run",
            None,
        )
        .unwrap();

        redact_managed_attachment_paths(&mut projected, root);

        assert_eq!(
            projected.get("assistantContent"),
            Some(&json!("[MANAGED_ATTACHMENT]/attachment-1/notes.txt"))
        );
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
            load_trace_privacy(&workbench, "agent-a").unwrap(),
            TracePrivacy {
                messages: true,
                reasoning: true,
                raw_tool_payloads: false,
            }
        );
    }

    #[test]
    fn scoped_trace_privacy_overrides_legacy_without_affecting_other_agents() {
        let workbench = WorkbenchDb::open_in_memory().unwrap();
        workbench
            .save_setting(
                TRACE_PRIVACY_SETTING,
                &json!({"messages":true,"reasoning":false,"rawToolPayloads":false}),
            )
            .unwrap();
        workbench
            .save_setting(
                &trace_privacy_setting("agent-a"),
                &json!({"messages":false,"reasoning":false,"rawToolPayloads":true}),
            )
            .unwrap();

        assert!(
            load_trace_privacy(&workbench, "agent-a")
                .unwrap()
                .raw_tool_payloads
        );
        assert!(load_trace_privacy(&workbench, "agent-b").unwrap().messages);
        assert!(
            !load_trace_privacy(&workbench, "agent-b")
                .unwrap()
                .raw_tool_payloads
        );
    }

    #[test]
    fn trace_publication_requires_exact_runtime_bridge_and_generation() {
        assert!(trace_publication_allowed(true, true, 4, 4, false));
        assert!(!trace_publication_allowed(false, true, 4, 4, false));
        assert!(!trace_publication_allowed(true, false, 4, 4, false));
        assert!(!trace_publication_allowed(true, true, 5, 4, false));
        assert!(!trace_publication_allowed(true, true, 4, 4, true));
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
