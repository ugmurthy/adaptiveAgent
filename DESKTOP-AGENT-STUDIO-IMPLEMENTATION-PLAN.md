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

Phase 8 is a gated hardening sequence, not one final test pass. Establish the baseline before
changing behavior, implement Hardening Phases 1-5 in serial order, and keep the relevant
targeted and package-level checks green at the end of every phase.

Tests are part of each phase. Hardening Phase 5 repeats and extends them against the integrated
packaged application; it must not be the first time the complete suites are run.

### Delivery rules

1. Record the branch commit, packaged build identifier, test fixtures, and baseline failures.
2. Add a failing regression or characterization test before each behavior change when the
   behavior can be exercised automatically.
3. Make the smallest change that establishes the intended ownership or data contract.
4. Run the phase's targeted tests first, then its package gate.
5. Do not begin the next phase until the current phase's required gate is green or an explicit,
   documented exception has been accepted.
6. Keep behavior-preserving extraction separate from behavior changes.
7. Preserve exact `agentId`, configuration path, fingerprint, runtime generation, run ownership,
   and workspace provenance across every boundary.
8. Record manual GUI scenarios that were not exercised; compilation is not a substitute for the
   original workflow.

### Baseline before Hardening Phase 1

#### Goal

Create reproducible evidence for the identified hotspots before changing concurrency,
threading, persistence, or rendering behavior.

#### Work

1. Capture the current automated results for Rust, frontend, desktop bridge, and Agent SDK.
2. Add characterization fixtures for:
   - a delayed workbench refresh while state events continue to arrive;
   - database failure during task, chat, and recovery completion;
   - runtime initialization racing settings reload and application shutdown;
   - sidecar shutdown response and clean process exit;
   - ISO, numeric, epoch-millisecond string, blank, and invalid timestamps;
   - a large and deeply nested workspace;
   - historical artifacts after workspace settings change;
   - duplicate artifact basenames and symlink escape attempts.
3. Record the expected state transition and visible DOM outcome for loading, initializing,
   saving, run completion, and shutdown workflows.
4. Preserve realistic pre-Agent-Studio and current `workbench.sqlite` fixture copies. Never run
   forward migrations against the only copy of a fixture.
5. Classify each hotspot as a reproduced defect, a statically verified contract violation, or a
   risk requiring a targeted native test. Do not call an unobserved risk a confirmed cause.

#### Baseline commands

```sh
source "$HOME/.cargo/env"
cargo fmt --manifest-path packages/desktop-app/src-tauri/Cargo.toml -- --check
cargo test --manifest-path packages/desktop-app/src-tauri/Cargo.toml --lib
cargo check --manifest-path packages/desktop-app/src-tauri/Cargo.toml

cd packages/desktop-app
bun run test
bun run typecheck
bun run web:build

cd ../desktop-bridge
bun run test
bun run build

cd ../agent-sdk
bun run test
bun run build
```

#### Exit criteria

- Existing failures are recorded without being hidden or weakened.
- Every high-priority hotspot has either a reproducer or a documented evidence gap.
- The test fixtures can be recreated without relying on a developer's application data.
- No production behavior has changed.

### Hardening Phase 1: Concurrency and refresh correctness

#### Goal

Remove known lock-lifetime hazards and make renderer refreshes converge under overlapping events.

#### Work

1. Replace workbench generation-based refresh cancellation with:
   - one request in flight;
   - one coalesced trailing refresh;
   - application of every completed valid response;
   - polling only as a missed-event fallback.
2. In task, chat, and recovery completion paths, copy the required registry state, release the
   guard, and only then perform database work, state publication, tracing, or UI event emission.
3. Shorten chat submission critical sections so registry locks are not held across chat loading,
   attachment validation, or durable reservation.
4. Take trace, bridge, child-process, and pending-request values out of their mutexes before
   shutdown, process termination, or waiter notification.
5. Replace lifecycle locks that span sidecar startup or shutdown with an explicit initializing,
   ready, draining, or failed ownership transition. Preserve single-owner runtime creation and
   per-agent capacity.
6. Keep sidecar response routing independent from notification processing and lifecycle work.

#### Main risks

- replacing deadlocks with duplicate initialization or lost updates;
- exceeding per-agent capacity under simultaneous submissions;
- publishing a stale runtime generation;
- allowing new work after drain or shutdown starts;
- dropping a trailing refresh or applying state to the wrong selected item.

#### Required tests

- delayed refresh plus a sustained event stream converges to the newest durable state;
- simultaneous task and chat submissions never exceed three slots per agent;
- two requests for the same runtime produce one exact runtime owner;
- injected persistence failure does not block reconciliation or state publication;
- settings reload, runtime initialization, and shutdown have deterministic winners;
- transport failure and shutdown release all pending callers;
- task, chat, recovery, and quit workflows preserve exact agent and generation identity.

#### Phase gate

Run the Rust checks and the complete `packages/desktop-app` test, typecheck, and web-build commands
from the baseline. Run `packages/desktop-bridge` tests when sidecar shutdown, request routing, or
transport handling changes.

#### Exit criteria

- no outward database, sidecar, event, callback, or shutdown operation occurs while holding the
  affected registry, lifecycle, trace, bridge, child, or pending-request guard;
- refresh has one in-flight request and at most one trailing pass;
- concurrency regressions are covered by deterministic tests;
- the phase gate is green.

### Hardening Phase 2: Native responsiveness and blocking boundaries

#### Goal

Keep blocking filesystem, database, dialog, lifecycle, and synchronous sidecar waits off the
Tauri UI thread and off executors needed to route their completion.

#### Work

1. Inventory every Tauri command by its blocking behavior and thread-affinity requirements.
2. Make recovery planning, run recovery inspection, steering, stopping, trace overview, runtime
   bootstrap, and other synchronous sidecar waits asynchronous at the command boundary.
3. Move genuinely blocking work to `spawn_blocking` without moving response-demultiplexing tasks
   onto the same constrained executor.
4. Make workspace artifact traversal asynchronous and bounded by depth, result count, and a
   documented time or cancellation policy.
5. Avoid a second unbounded workspace traversal for basename resolution.
6. Isolate native save dialogs and file writes according to the dialog plugin's platform
   thread-affinity contract.
7. Preserve timeout cleanup, transport error propagation, and expected-shutdown behavior across
   every blocking-task boundary.

#### Main risks

- changing Tauri command request or response contracts;
- introducing non-`Send` futures or invalid state lifetimes;
- invoking native dialogs from an unsupported thread;
- starving sidecar response routing with blocking workers;
- leaving pending request entries after timeout or cancellation;
- changing response ordering observed by the renderer.

#### Required tests

- a slow sidecar request does not block unrelated desktop commands;
- notification load does not delay matching responses beyond their timeout;
- timeout, EOF, malformed frame, stderr, and unexpected exit unblock every caller;
- large and deep workspaces stop at the configured bounds;
- artifact listing remains deterministic within those bounds;
- export cancellation and write failure return actionable errors;
- packaged save dialogs are smoke-tested on macOS, Windows, and Linux when available.

#### Phase gate

Run Rust formatting, tests, and checks; the full desktop bridge test and build; and desktop app
tests, typecheck, and web build. Perform at least one packaged native interaction for every
changed dialog or window-thread boundary and record unavailable platforms.

#### Exit criteria

- no identified synchronous command waits on a sidecar or performs unbounded filesystem work on
  the UI thread;
- pending requests are removed on every terminal transport path;
- native command contracts remain compatible;
- the phase gate is green.

### Hardening Phase 3: Persisted data and projection consistency

#### Goal

Normalize persisted values centrally and reconcile durable, live, trace, artifact, and rendered
projections without losing provenance.

#### Work

1. Define one timestamp normalization contract for ISO strings, numbers, epoch-millisecond
   strings, blank values, and invalid values.
2. Use the same normalized value for sorting, comparison, activity timing, and display in Agent
   Studio, the workbench rail, and the inspector.
3. Ensure invalid dates render a stable fallback and cannot throw during component rendering.
4. Address artifact listing and preview by run or item where historical provenance matters.
5. Resolve historical artifacts against persisted `workspace_root` and `shell_cwd`, not silently
   against the agent's current workspace.
6. Preserve workspace confinement after canonicalization and reject ambiguous duplicate basenames.
7. Keep durable results as a fallback when trace data is absent and deduplicate only against
   actual resolved files.
8. Convert general JSON parser positions to actionable line and column diagnostics while keeping
   valid smart punctuation inside strings.

#### Main risks

- reordering existing history;
- changing fallback text or introducing locale-dependent tests;
- resolving an artifact from the wrong workspace or runtime generation;
- weakening path confinement through symlinks or canonicalization races;
- treating an empty trace as proof that no result exists;
- rejecting valid profile text while improving JSON diagnostics.

#### Required tests

- every supported timestamp form produces the same sort and display semantics;
- blank and invalid timestamps render without exceptions;
- timestamp fixtures are exercised through mounted Svelte components;
- historical artifacts remain tied to their persisted workspace after settings change;
- duplicate basenames remain ambiguous instead of selecting arbitrarily;
- absolute, relative, missing, moved, and symlinked artifact paths remain confined;
- durable results render when trace reports are empty or unavailable;
- malformed JSON reports line and column, while smart punctuation inside valid strings remains
  accepted.

#### Phase gate

Run Rust formatting, tests, and checks plus desktop app tests, component tests, typecheck, and web
build. Re-run migration and historical-workspace fixtures against copies of persisted data.

#### Exit criteria

- one timestamp normalizer owns sorting and display semantics;
- malformed persisted records cannot strand the UI in a pending state;
- artifact access preserves run identity and workspace provenance;
- JSON diagnostics are actionable and non-destructive;
- the phase gate is green.

### Hardening Phase 4: Renderer lifecycle and ownership cleanup

#### Goal

Make listener, timer, and component ownership explicit, then extract only responsibilities whose
boundaries are proven by the preceding tests.

This phase is behavior-preserving. Do not combine it with new product behavior.

#### Work

1. Track and remove pointer listeners when the workbench unmounts during inspector resize.
2. Verify teardown for catalog/state subscriptions, polling timers, delayed refreshes, trace
   selection, artifact previews, and builder validation.
3. Ignore or safely dispose responses received after a component or window has closed.
4. After characterization coverage is in place, consider extracting coherent owners for:
   - runtime lifecycle and generation transitions;
   - artifact discovery and preview;
   - workbench refresh coordination;
   - shutdown coordination.
5. Do not split files merely to reduce line count. Extract only when the new module owns a clear
   invariant and reduces lock or lifecycle complexity.

#### Main risks

- changing behavior during structural refactoring;
- leaking or double-removing listeners;
- applying a late response to a new component instance;
- introducing circular ownership between runtime, workbench, and Tauri command modules;
- obscuring previously visible lock ordering.

#### Required tests

- mount and unmount during inspector resize leaves no window listeners;
- repeated window open and close does not accumulate subscriptions or timers;
- a refresh or artifact preview completing after teardown is ignored safely;
- component remount starts from durable state rather than stale module state;
- command, event, persistence, and protocol contracts remain unchanged;
- all prior characterization and regression tests remain green without weakened assertions.

#### Phase gate

Run all automated baseline commands. Review the diff specifically for behavior changes, lock-order
changes, new public types, and duplicated ownership. Repeat representative create, run, chat,
inspect, settings, archive, restore, and close workflows.

#### Exit criteria

- listeners and timers have explicit teardown owners;
- late asynchronous responses cannot mutate disposed views;
- any extraction has a documented invariant and unchanged external contract;
- the phase gate is green.

### Hardening Phase 5: Integrated release validation

#### Goal

Validate the complete compatibility unit with realistic persisted data and packaged native
workflows before distribution.

#### Automated verification

Run the complete baseline command set and retain its output with the release candidate. The
combined suites must cover:

- catalog discovery, invalid profiles, duplicate IDs, and per-agent initialization errors;
- forward SQLite migrations, provenance backfill, and history preservation;
- per-agent run-capacity isolation and exact runtime generation routing;
- event, command, attachment, artifact, trace, recovery, approval, deletion, and settings
  ownership by `agentId`;
- refresh convergence and renderer recovery from malformed persisted records;
- sidecar response progress, timeout cleanup, shutdown response, and unexpected exit;
- native window reuse, configurable limits, and child-window close with active runs;
- builder dry-run, validation, confirmation, overwrite protection, and save;
- export, archive, and restore without history deletion;
- durable result fallback and run-scoped artifact provenance.

#### Packaged workflow verification

Use the full realistic payload and a copied application-data directory. Verify:

1. Agent Studio leaves loading state after successful and failed catalog initialization.
2. A selected agent opens the exact matching runtime and native window.
3. Three agents execute concurrently without identity, event, history, or artifact leakage.
4. Task and chat completion survive delayed persistence and state refresh.
5. Recovery, approval, steering, interruption, and deletion converge after restart.
6. Profile edit, export, archive, restore, and generation retirement preserve existing work.
7. Historical results and artifacts remain associated with their original workspace provenance.
8. Child close preserves active runs; parent close follows the global quit flow.
9. Wait, terminate, cancellation, and clean sidecar shutdown complete without expected-shutdown
   noise or orphaned processes.
10. Full payload rendering completes without renderer exceptions or stale pending DOM.

#### Native matrix

Record the packaged build identifier and tester for each completed column.

| Scenario | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Agent window create, focus, restore, and reuse | [ ] | [ ] | [ ] |
| Multi-monitor placement and scaling | [ ] | [ ] | [ ] |
| Child close preserves active runs | [ ] | [ ] | [ ] |
| Parent quit handles closed child windows with active runs | [ ] | [ ] | [ ] |
| Three agents execute concurrently | [ ] | [ ] | [ ] |
| Native profile export dialog | [ ] | [ ] | [ ] |
| Large workspace remains responsive | [ ] | [ ] | [ ] |
| Initialization failure remains attributable to one profile | [ ] | [ ] | [ ] |
| Clean shutdown leaves no sidecars | [ ] | [ ] | [ ] |

#### Main risks

- relying on unit tests that never exercise packaged binaries;
- flaky GUI timing hiding deterministic state-machine failures;
- platform-specific dialog, window, path, or process behavior;
- testing only fresh databases rather than forward migrations;
- treating screenshots as proof without exercising the interaction;
- releasing an untested combination of renderer, Rust host, protocol, and schema versions.

#### Exit criteria

- all automated commands pass on the release commit;
- the original reported workflows pass with full realistic payloads;
- migration is verified against a copy of pre-upgrade application data;
- every native matrix gap is recorded and accepted before distribution;
- no unresolved high-severity concurrency, identity, persistence, or shutdown finding remains;
- renderer, Rust host, desktop sidecar protocol, and forward-only migrations are released as one
  compatibility unit.

### Rollout

1. Ship Agent Studio as one atomic compatibility unit: renderer, Rust host, desktop sidecar
   protocol, and forward-only SQLite migrations.
2. Promote the same packaged build through internal, canary, and broad distribution cohorts using
   the distribution channel's release controls.
3. Do not provide a runtime switch back to legacy single-agent writers after `workbench.sqlite`
   has been opened and migrated.
4. Halt further rollout by withdrawing the package. Forward-fix installations that already
   upgraded; downgrade only by restoring matching pre-upgrade application data together with the
   previous package.
5. Treat same-window, native-window, builder, and lifecycle milestones as validation gates, not
   independently toggleable runtime modes.

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

Phase 8 baseline and Hardening Phases 1-5: concurrency, responsiveness, persisted-data
normalization, ownership cleanup, cross-platform packaged verification, and migration confidence.
