# Desktop Agent Studio Implementation Plan

## Outcome

Evolve the current single-agent desktop workbench into an Agent Studio with:

- a parent window that displays locally owned specialist agents as icons/cards;
- one reusable native OS window per opened agent;
- the existing history, task/chat, artifacts, and inspector experience in every agent window;
- durable agent profiles stored as JSON files;
- three concurrent runs per agent;
- at most three open agent windows by default, configurable with `ADAPTIVE_AGENT_MAX_WINDOWS`;
- natural-language agent generation through the existing `adaptive-agent agent-create` command;
- JSON export, archive, and restore without deleting run history or artifacts.

This remains a local, single-user product. Sharing, multi-user access control, and cross-agent data permissions are out of scope.

## Target architecture

```text
+--------------------------------------------+
| Main window: Agent Studio                  |
| Catalog | status | recent work | launcher  |
+---------------------+----------------------+
                      | open/focus by agent ID
          +-----------+-----------+
          |                       |
          v                       v
+-------------------+   +-------------------+
| Agent window A    |   | Agent window B    |
| History           |   | History           |
| Task/chat         |   | Task/chat         |
| Inspector         |   | Inspector         |
+---------+---------+   +---------+---------+
          | agentId               | agentId
          +-----------+-----------+
                      v
+--------------------------------------------+
| Tauri AgentRuntimeManager                  |
| agentId -> sidecar/runtime/run registry    |
| Each agent has three execution slots       |
+--------------------------------------------+
```

Use one frontend bundle with two window modes. The main Tauri window renders the Agent Studio; dynamically created agent windows render the existing workbench scoped to an immutable `agentId`.

The critical dependency is replacing the current singleton desktop bridge with agent-scoped runtime instances. Adding native windows before runtime scoping would create visually separate windows that still share one agent configuration and one global three-run registry.

## Product decisions

### Agent identity and lifecycle

- An agent is a durable JSON profile in a configured agent directory.
- Profile edits affect new runs and new chats only.
- Existing runs continue with their original configuration fingerprint.
- Existing chats remain pinned to their original agent fingerprint.
- An agent can be archived without deleting its history or artifacts.
- Users can export the exact agent JSON file.

### Windows

- Clicking an agent opens a native OS window.
- Clicking an already-open agent restores and focuses its existing window.
- The same agent cannot have duplicate windows.
- The default maximum is three agent windows, excluding the parent window.
- `ADAPTIVE_AGENT_MAX_WINDOWS` can override the default with a positive integer.
- Closing an agent window frees the window slot but does not stop active runs.
- The parent continues to show active and recent run status for closed windows.

### Runtime

- Every agent has three concurrent run slots.
- Agents have equal scheduling priority.
- Budgets and model/tool limits remain part of the agent profile and core runtime semantics.
- Window capacity and run capacity are independent.

## Phase 1: Agent catalog and durable ownership

### Goal

Introduce durable agent discovery and associate all desktop data with an agent without changing the current single-window experience.

### Work

1. Add an Agent SDK-owned catalog API that discovers JSON profiles through existing `agents.dirs` settings and validates them with the existing Agent SDK validators.
2. Return desktop-safe descriptors containing:
   - `id`;
   - `name`;
   - `description`;
   - `configPath`;
   - `configurationFingerprint`;
   - optional avatar metadata;
   - archive and validation state.
3. Detect invalid profiles and duplicate IDs without crashing desktop startup.
4. Add `agent_id`, `agent_config_path`, and `agent_fingerprint` to persisted task, chat, and run-attempt ownership.
5. Backfill existing records with the currently configured agent.
6. Represent archive non-destructively by moving profiles under an archive directory such as `agents/.archive/`.

### Acceptance criteria

- Existing history migrates without data loss.
- Every new task, chat, and run records its owning agent.
- Invalid profiles produce catalog diagnostics.
- Archived profiles are hidden from the default catalog while history and artifacts remain available.

## Phase 2: Agent-scoped runtime manager

### Goal

Allow multiple agents to execute independently before exposing multiple native windows.

### Work

1. Replace the singleton Tauri bridge with an `AgentRuntimeManager` keyed by agent ID.
2. Give each agent runtime its own:
   - resolved profile and fingerprint;
   - desktop bridge sidecar;
   - run registry;
   - three-run capacity;
   - execution and trace health;
   - pending request state.
3. Add `agentId` to all agent-scoped Tauri commands, including run, chat, artifact, trace, recovery, approval, deletion, and settings operations.
4. Validate command agent IDs against the catalog.
5. Include `agentId` in state, activity, completion, and trace event envelopes, or emit directly to deterministic agent window labels.
6. Keep runtimes alive while runs are active even if their agent windows close.
7. Extend application quit coordination across all active runtimes.

### Acceptance criteria

- Two agents can each occupy three run slots concurrently.
- A fourth run is rejected only for the full agent.
- Settings, history, traces, and events cannot leak between agents.
- Closing an agent window does not terminate its runs.
- Application quit detects active runs across every agent.

## Phase 3: Parent Agent Studio

### Goal

Turn the main window into the parent catalog and status surface.

### Work

1. Split the frontend into `AgentStudio` and agent-scoped `AgentWorkspace` entry modes.
2. Reuse the current workbench components rather than duplicating them.
3. Render catalog cards with:
   - identity and role;
   - `0/3` through `3/3` run utilization;
   - active, needs-input, failed, and recent-completion states;
   - open/focus action;
   - edit, export, and archive menu.
4. Add cross-agent recent work and attention lists.
5. Subscribe the parent to summary events for all agents.
6. Add an archived-agent filter.

### Acceptance criteria

- Every valid non-archived profile appears in the parent.
- Agent status updates without opening a workspace.
- Existing history appears under the correct agent.
- Active, needs-input, failed, and completed states are distinguishable.

## Phase 4: Native agent windows

### Goal

Open or focus one native workspace window per agent.

### Work

1. Use deterministic Tauri labels such as `agent:<encoded-agent-id>`.
2. On selection:
   - restore and focus the matching window when it exists;
   - otherwise count open agent windows;
   - reject creation at the configured limit;
   - create a new window carrying immutable agent bootstrap context.
3. Make Tauri's window registry authoritative rather than maintaining only a frontend map.
4. Parse `ADAPTIVE_AGENT_MAX_WINDOWS` once at startup:
   - default to `3`;
   - accept positive integers;
   - fall back to `3` with a diagnostic for invalid values.
5. Persist simple per-window presentation state: size, position, inspector width/open state, and last selected item.
6. Do not automatically reopen previously closed agent windows in the first release.
7. Make child-window close independent from application-wide quit handling.

### Acceptance criteria

- First selection creates a native window.
- Repeated selection focuses the same window.
- Three distinct agent windows can be open by default.
- A fourth selection shows a clear limit message.
- Closing a child frees one window slot without stopping runs.
- Closing the parent or quitting the application retains global active-run confirmation.

## Phase 5: Full agent-scoped workbench

### Goal

Provide the existing left/middle/right experience in every specialist window.

### Work

1. Scope the existing history rail, task/chat surface, artifacts, and run inspector to the window's immutable agent context.
2. Have the desktop API client inherit `agentId` from window bootstrap state instead of letting each component supply arbitrary IDs.
3. Preserve history search and filtered artifact behavior.
4. Display independent per-agent run capacity.
5. Apply profile edits by configuration generation:
   - active runs remain on their original generation;
   - new runs and new chats use the newest fingerprint;
   - old runtime generations retire after becoming idle.
6. Preserve current fingerprint-pinned chat behavior rather than silently changing an existing conversation's agent.

### Acceptance criteria

- Each window displays only its agent's history, artifacts, and traces.
- Search and artifact filtering retain current behavior.
- Each agent independently reports its three execution slots.
- Profile changes do not alter active runs or existing chats.
- New runs and chats use the updated profile.

## Phase 6: Agent builder

### Goal

Create locally stored specialist profiles from natural language or direct JSON.

### Work

1. Use the existing command:

   ```text
   adaptive-agent agent-create "<agent description>"
   ```

2. Do not add a duplicate `create-agent` implementation.
3. Implement a two-step natural-language flow:
   - generate a dry-run structured draft;
   - display profile, notes, and recommendations;
   - allow review and editing;
   - validate and save only after confirmation.
4. Invoke the CLI through the existing argv-based executor or expose typed bridge methods around Agent SDK `agent-create`; do not construct shell strings.
5. Add a direct JSON path with schema validation, duplicate-ID detection, output-path preview, and explicit overwrite confirmation.
6. Keep templates as prefilled descriptions or JSON, not a separate profile format.

### Acceptance criteria

- A plain-language brief produces a reviewable profile draft.
- Generation does not write before confirmation.
- Invalid JSON cannot be saved.
- Duplicate IDs require explicit resolution.
- Saved profiles immediately appear in the parent catalog.
- Generated files load through the standard Agent SDK without desktop-specific transformation.

## Phase 7: Export, archive, and restore

### Goal

Complete the local profile lifecycle.

### Work

1. Export the exact JSON profile through a native save dialog.
2. Archive profiles with an atomic move into the configured archive directory.
3. Keep archived history and artifacts queryable.
4. Allow already-active archived runs to finish.
5. Prevent new work for archived agents until restore.
6. Add restore support and archived-agent catalog views.

### Acceptance criteria

- Exported JSON is semantically equivalent to the stored profile.
- Archive removes the agent from the default launcher without deleting data.
- Active work can finish after archive.
- Archived agents cannot start new work.
- Restore returns the profile to the normal catalog.

## Phase 8: Hardening and release

### Automated verification

- Catalog discovery, invalid profiles, and duplicate IDs.
- Persistence migration and backfill.
- Per-agent run-capacity isolation.
- Event and command routing by agent ID.
- Native window reuse and configurable limit.
- Child-window close with active runs.
- Runtime generation rollover after profile edits.
- Builder dry-run, validation, confirmation, and save.
- Export, archive, and restore without history deletion.
- Existing desktop workbench regression tests.

### Native manual verification

Test macOS, Windows, and Linux for:

- focus, restore, and close behavior;
- multi-monitor placement;
- child close versus application quit;
- application quit with active runs whose windows are closed;
- environment-variable parsing;
- native import/export dialogs;
- three agents executing concurrent work.

### Rollout

1. Ship Agent Studio as one atomic compatibility unit: renderer, Rust host, desktop
   sidecar protocol 1.16, and forward-only SQLite migrations.
2. Promote the same packaged build through internal, canary, and broad distribution
   cohorts using the distribution channel's release controls.
3. Do not provide a runtime switch back to legacy single-agent writers after
   `workbench.sqlite` has been opened and migrated.
4. Halt further rollout by withdrawing the package. Forward-fix installations that
   already upgraded; downgrade only by restoring matching pre-upgrade application data
   together with the previous package.
5. Treat the former same-window, native-window, and lifecycle stages as validation gates,
   not independently toggleable runtime modes.

## Release cuts

Releases A-C are development and validation cuts. They are not independently distributable
packages that may mix renderer, host, protocol, or database compatibility versions.

### Release A: Multi-agent foundation

Phases 1-3: catalog, ownership, agent-scoped runtime, and parent status UI.

### Release B: Native specialist desktop

Phases 4-5: native windows and the complete independent workbench.

### Release C: Self-service agent management

Phases 6-7: natural-language generation, direct JSON editing, export, archive, and restore.

### Release D: Production hardening

Phase 8: cross-platform lifecycle verification, migration confidence, and removal of legacy assumptions.
