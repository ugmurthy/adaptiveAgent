# AdaptiveAgent Desktop Workbench Implementation Specification

Status: Approved for implementation

## 1. Objective

Extend `@adaptive-agent/desktop-app` from its single-run MVP into a persistent,
single-window agent operations workbench.

The application must let a user:

- Run up to three independent top-level tasks concurrently.
- Create persistent chats whose turns share a session and remain pinned to one
  agent.
- Switch between active and completed work without interrupting execution.
- Follow a readable live activity narrative while execution is in progress.
- See a compact live timer while a model request is processing.
- Render returned output as readable Markdown, including Mermaid diagrams.
- Manually approve or reject risky operations.
- Inspect runs during and after execution, including agents, tools, events,
  tokens, estimated costs, performance, and diagnostics.
- Change trace privacy settings in the application by restarting only the
  trace sidecar.
- Manually delete eligible tasks, chats, and run trees.
- Quit only after every active run has completed or has been explicitly
  terminated and reached a quiescent state.

## 2. Fixed product decisions

| Area | Required behavior |
|---|---|
| Runtime persistence | SQLite |
| Concurrent top-level runs | Maximum three |
| Chat agent | Pinned when the chat is created |
| Approval | Manual approval supported, including delegated child runs |
| Clarification | Deferred; desktop configuration must use `fail` |
| Trace privacy | In-app settings; changes restart only trace-session |
| Deletion | Manual deletion for tasks, chats, and eligible run trees |
| Results | Render returned content first; artifact discovery is deferred |
| Markdown | Sanitized Markdown with Mermaid fenced-block support |
| Windows | One application window |
| Quit | Block exit until all runs finish or are explicitly terminated |
| Agent selection | Initially pin chats to the currently resolved agent |

Changing the configured agent must not silently migrate an existing chat. An
old chat remains readable and can continue only when its pinned agent identity
and configuration fingerprint match the resolved agent.

## 3. Architecture and ownership

```diagram
┌──────────────────────────── Desktop application ────────────────────────────┐
│                                                                            │
│  ┌──────────────────────── Svelte workbench ─────────────────────────────┐  │
│  │ task/chat rail │ activity/result │ inspector │ settings │ quit flow │  │
│  └──────────────────────────────┬─────────────────────────────────────────┘  │
│                                 │ restricted Tauri API                     │
│  ┌──────────────────────────────▼─────────────────────────────────────────┐  │
│  │ Native WorkbenchCoordinator                                          │  │
│  │ run registry | admission | persistence | quit | safe event projection│  │
│  └────────────┬────────────────────┬────────────────────┬─────────────────┘  │
│               │                    │                    │                    │
│      ┌────────▼────────┐  ┌────────▼────────┐  ┌────────▼────────────┐       │
│      │ desktop-bridge │  │ trace-session   │  │ Workbench SQLite   │       │
│      │ execution      │  │ read-only trace │  │ tasks/chats/UI     │       │
│      └────────┬────────┘  └────────┬────────┘  └─────────────────────┘       │
│               └────────────┬───────┘                                       │
│                            ▼                                               │
│                    Runtime SQLite                                          │
└────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Runtime SQLite owns execution semantics

Runtime SQLite remains authoritative for:

- Runs and child runs.
- Events and event sequence.
- Snapshots and plans.
- Tool executions.
- Continuations and recovery state.
- Durable results, failures, approval state, usage, and estimated costs.

Any runtime-data deletion API belongs in `@adaptive-agent/core` and is exposed
through `desktop-bridge`. The renderer and trace sidecar must not issue ad hoc
runtime SQL.

### 3.2 Desktop workbench SQLite owns product state

Use a separate native-managed SQLite database for:

- Task and chat records.
- Stable chat `sessionId` values.
- Pinned agent identity/configuration fingerprint.
- Chat transcript.
- Links between workbench items and runtime `runId` values.
- Cached renderer-safe statuses and activity.
- Trace privacy preferences.
- Recoverable deletion tombstones.

### 3.3 Trace sidecar remains optional and read-only

`trace-session` enriches inspection but must never be required to:

- Start, stop, approve, resume, or recover execution.
- Restore a chat transcript.
- Retrieve the final run result.
- Determine whether the application may exit.

Trace failure degrades only detailed inspection.

## 4. Required implementation phases

Each phase must be validated and committed separately. Do not commit a phase
whose required checks fail. Use a commit message that identifies the completed
phase.

### Phase 0: Execution contracts and concurrency proof

#### 0.1 Host-assigned run identity

The native coordinator must generate and persist every top-level `runId` before
writing an execution request. Bump the desktop protocol and add `runId` to
restricted `agent/run` and `agent/chat` requests. Pass it through Agent SDK to
core.

This removes ambiguity when several submissions produce interleaved
`run.created` events.

#### 0.2 Chat request contract

A stable `sessionId` is correlation, not transcript persistence. Extend the
desktop chat request to accept the complete validated user/assistant transcript.
The workbench must resend that transcript for every new turn.

#### 0.3 Raw interaction semantics

Desktop run/chat execution must use raw SDK methods. The sidecar must never try
to prompt on the same stdin used by JSON-RPC.

Approval resolution and resumption must be separate operations:

1. Resolve the approval decision.
2. For approval, start a separately tracked `run/resume` for the same `runId`.
3. For rejection, wait for the durable failed state.

#### 0.4 Robust NDJSON transport

Replace the Rust assumption that one stdout chunk equals one JSON message with
a reusable bounded NDJSON supervisor supporting:

- Partial lines.
- Multiple lines per chunk.
- Maximum frame size.
- Out-of-order responses.
- Pending requests keyed by JSON-RPC ID.
- A process generation so old responses cannot satisfy new requests.
- Independent execution and trace instances.

#### 0.5 Concurrency integration test

Prove through the sidecar that three SQLite-backed requests enter execution
before any completes. While all are pending, issue interrupt or inspection
control RPCs. Complete requests out of submission order and verify event and
response correlation, SQLite integrity, and unique event sequence.

Phase 0 is a release gate for all later UI work.

Commit message:

```text
feat(desktop): complete phase 0 execution contracts
```

### Phase 1: Native workbench and two-sidecar substrate

#### 1.1 Native workbench persistence

Add a small migration system and tables equivalent to:

```sql
create table workbench_items (
  id text primary key,
  kind text not null check (kind in ('task', 'chat')),
  title text not null,
  session_id text unique,
  pinned_agent_id text not null,
  pinned_agent_name text not null,
  pinned_agent_fingerprint text not null,
  created_at text not null,
  updated_at text not null,
  deletion_state text
);

create table workbench_runs (
  run_id text primary key,
  item_id text not null references workbench_items(id) on delete cascade,
  turn_index integer,
  invocation_kind text not null check (invocation_kind in ('run', 'chat')),
  cached_status text not null,
  submission_state text not null,
  created_at text not null,
  updated_at text not null
);

create table chat_messages (
  id text primary key,
  item_id text not null references workbench_items(id) on delete cascade,
  ordinal integer not null,
  role text not null check (role in ('user', 'assistant')),
  content_json text not null,
  run_id text references workbench_runs(run_id),
  created_at text not null,
  unique (item_id, ordinal)
);

create table desktop_settings (
  key text primary key,
  value_json text not null
);

create table deletion_jobs (
  id text primary key,
  item_id text,
  root_run_id text,
  state text not null,
  last_error text,
  created_at text not null,
  updated_at text not null
);
```

The exact schema may vary if a smaller schema preserves all required invariants.
Persist a work item and run reservation before sending execution.

#### 1.2 Native coordinator

Replace singleton `active`, `activeRunId`, `stopping`, and queued-stop state with
a registry keyed by top-level `runId`. It must track submission, durable status,
late creation, cancel requests, pending interactions, item/session linkage, and
whether the root occupies one of the three slots.

#### 1.3 Package and supervise two sidecars

Update the preparation script and Tauri configuration to package target-specific
binaries for:

- `agent-runtime`
- `trace-session-sidecar`

Initialize execution and migrations first. Start trace against the exact resolved
SQLite path. Supervise and report their health independently.

Commit message:

```text
feat(desktop): complete phase 1 workbench substrate
```

### Phase 2: Concurrent task workflow

Implement an atomic maximum of three top-level occupied slots. Child runs do not
consume separate slots. A fourth submission remains editable but cannot start
until a slot is available; automatic queuing is deferred.

Submission order:

1. Reject if quit/drain has started.
2. Acquire a slot atomically.
3. Generate item and root run IDs.
4. Persist the reservation.
5. Send `agent/run` with the assigned run ID.
6. Reconcile events and response independently.
7. Release the slot only when durable state is quiescent.

If stop is requested before `run.created`, persist `cancelRequested` and issue or
reissue interrupt when creation is observed.

Define desktop status categories without changing core's generic terminal set:

```text
occupies slot:
  queued, planning, running, awaiting_subagent, awaiting_approval

quiescent:
  succeeded, failed, cancelled, interrupted,
  clarification_requested, replan_required
```

Recover lost responses by inspecting the already assigned `runId`. Do not use
trace to recover final output.

Commit message:

```text
feat(desktop): complete phase 2 concurrent run workflow
```

### Phase 3: Guarded close and quit

Intercept both Tauri window close and application exit. Unless exit is approved,
prevent the native close/exit and enter this native-owned state machine:

```text
Idle -> Confirming -> Draining -> Approved
                 \-> Idle on cancel
```

The UI offers:

- Wait for runs.
- Terminate all and quit.
- Cancel.

Both wait and terminate modes reject new submissions. Wait leaves work running.
Terminate records cancellation for every active root, interrupts known roots,
interrupts late-created roots, and waits until all roots are quiescent. Only then
shut down sidecars and call application exit.

Duplicate close requests must be idempotent. Renderer destruction must not bypass
the native coordinator. Test macOS window close and Cmd-Q separately.

Commit message:

```text
feat(desktop): complete phase 3 guarded shutdown
```

### Phase 4: Persistent agent-pinned chat

On chat creation:

- Generate a stable `sessionId`.
- Pin the currently resolved agent ID/name/fingerprint.
- Persist the transcript independently of trace privacy.

On each turn:

- Reject if that chat already has an occupied turn.
- Append the user message and reserve a new root `runId` atomically.
- Send the complete transcript with the same `sessionId`.
- Insert successful assistant output idempotently by `runId`.

Different chats may execute concurrently under the global three-slot limit. Cover
crashes before run creation, after durable completion, and before assistant
message insertion. A changed/missing pinned profile makes a chat read-only rather
than silently changing agents.

Commit message:

```text
feat(desktop): complete phase 4 persistent chat
```

### Phase 5: Manual approval including delegated runs

Permit `approvalMode: manual` in restricted desktop configuration while retaining
`clarificationMode: fail`.

A run awaiting approval continues to occupy its top-level slot. Approval must
resume the same run ID. Rejection must reach durable `APPROVAL_REJECTED`. Support
several approval cycles in one run and restore unresolved approval state after
renderer/application restart.

Delegated approval must pause rather than fail the child. Required behavior:

1. Child reaches `awaiting_approval`.
2. Parent remains `awaiting_subagent`.
3. UI receives the child run requiring approval.
4. Approval resumes the child.
5. Child completion resumes its ancestor chain.
6. Root completes within its original top-level slot.

Add focused core tests before integrating the desktop UI. Duplicate approval
actions must not cause duplicate resumes.

Commit message:

```text
feat(runtime): complete phase 5 manual approval flow
```

### Phase 6: Live activity narrative and model timer

Project core events into a renderer-safe envelope. Whitelist identifiers,
timestamps, statuses, provider/model names, tool names, delegate names, durations,
retry metadata, and approval messages. Do not forward raw inputs, outputs,
assistant content, messages, or reasoning through the default activity stream.

Deduplicate by event ID, order within a run by sequence, and attribute child events
to the correct root.

Pair model spans by `(runId, payload.callId)`. Open on `model.started`; close on the
first matching `model.completed` or `model.failed`. Prefer reported duration, then
timestamp difference. Do not double-count retry delays. Incomplete spans display
as in progress rather than receiving invented durations.

Use compact duration formatting:

- `<1s`: `420ms`
- `1-9.9s`: `3.2s`
- `10-59s`: `38s`
- `1-59m`: `2m 08s`
- `>=1h`: `1h 04m`

Show the current model call and cumulative completed model time for the selected
root, including child agent attribution.

Commit message:

```text
feat(desktop): complete phase 6 activity narrative
```

### Phase 7: Trace inspector and privacy restart

The trace sidecar allows one request in flight. Implement native polling that:

- Serializes trace requests.
- Coalesces repeated refreshes.
- Polls only the selected active item every one to two seconds.
- Refreshes background summaries slowly or on terminal events.
- Discards stale responses after selection changes.
- Performs an immediate final refresh on terminal events.

Implement inspector views in this order:

1. Overview.
2. Timeline.
3. Agents/run tree.
4. Tools.
5. Tokens and estimated cost.
6. Diagnostics.
7. Sensitive messages/reasoning/raw payload views.

Never represent unavailable pricing as `$0.00`; show estimated and unpriced usage
explicitly.

Persist privacy preferences for messages, reasoning, and raw tool payloads.
Changing them stops the old trace process, starts a replacement with trusted
flags, initializes it, verifies capabilities, and publishes the result. Execution
must continue under the same process and run IDs.

Commit message:

```text
feat(desktop): complete phase 7 trace inspection
```

### Phase 8: Manual deletion

Add a core-owned transactional SQLite maintenance API for previewing and deleting
a root run tree or session. Expose only typed product operations through the
execution sidecar. Keep trace read-only.

Deletion must:

1. Use an immediate transaction.
2. Resolve the complete root/child tree.
3. Reject any affected run that occupies an execution slot.
4. Resolve owned plans before deleting runs.
5. Preserve plans referenced by unrelated runs.
6. Delete children before roots where required by the schema.
7. Rely on verified cascades for events, snapshots, tool records, executions, and
   continuations.
8. Commit atomically or roll back completely.

Product semantics:

- Deleting a task deletes all its attempts and child trees.
- Deleting a chat deletes its transcript, turns, and associated run trees.
- Deleting a task run deletes that attempt and child tree.
- Deleting a chat turn deletes that turn and all later turns because later context
  depends on it.

Use a workbench deletion tombstone before runtime deletion and retry incomplete
jobs on startup. Initial deletion is logical SQLite deletion, not a promise of
forensic erasure from free pages or WAL.

Commit message:

```text
feat(runtime): complete phase 8 history deletion
```

### Phase 9: Secure Markdown and Mermaid results

Create a result-renderer boundary for Markdown, plain text, and structured JSON.
String output defaults to Markdown; raw source is always available. Artifact
detection is deferred.

Pipeline:

1. Parse Markdown.
2. Sanitize generated HTML.
3. Detect Mermaid fenced blocks.
4. Render Mermaid with strict security and HTML labels disabled.
5. Sanitize generated SVG with an SVG-specific allowlist.
6. Fall back to source code for malformed or oversized diagrams.

Forbid scripts, `foreignObject`, event attributes, active URL protocols, external
references, and unsafe links. Add source-size and diagram-count limits and unique
diagram IDs. Do not weaken CSP or add `unsafe-eval`.

Commit message:

```text
feat(desktop): complete phase 9 markdown and mermaid rendering
```

### Phase 10: One-window Svelte workbench

Replace the current Run/Settings monolith with a responsive one-window workbench:

- Persistent task/chat rail grouped by status.
- New Task/New Chat composer.
- Selected task or conversation center view.
- Live activity narrative and result renderer.
- Per-run valid actions.
- Approval cards.
- Collapsible run inspector.
- Settings and sidecar health.
- Guarded quit overlay.

Split coherent responsibilities into Svelte components and stores rather than
continuing to grow `App.svelte`. On narrow windows, collapse the rail and use the
inspector as a drawer. Settings must not hide active-work state.

Commit message:

```text
feat(desktop): complete phase 10 workbench interface
```

## 5. Security requirements

- Credentials remain native/sidecar-only; the renderer receives availability
  booleans, never values.
- Renderer commands remain typed and restricted. Do not expose generic sidecar
  JSON-RPC or arbitrary SQL.
- Raw messages, reasoning, and tool payloads require enabled trace capabilities.
- Execution results are retrieved through execution inspection, not trace.
- Markdown and Mermaid content are untrusted and must be sanitized.
- Do not loosen CSP to make a renderer dependency work.
- Deletion requires explicit confirmation and is forbidden for active trees.

## 6. Required tests and acceptance criteria

### 6.1 Bridge and concurrency

- Three requests enter execution before any completes.
- A fourth top-level request is rejected atomically.
- Interrupt, inspection, and approval control RPCs work while three long requests
  are pending.
- Responses arriving out of order satisfy the correct request.
- Partial and combined NDJSON frames decode correctly.
- SQLite produces no duplicate sequence or optimistic-concurrency corruption.

### 6.2 Identity and event races

- Root ID is persisted before request write.
- Events arriving before command completion update the correct item.
- Stop-before-create interrupts after creation.
- Late creation during terminate-all is interrupted.
- Duplicate terminal events are idempotent.
- A lost terminal response is recovered by known ID inspection.

### 6.3 Chat and restoration

- Session and transcript survive full restart.
- Full prior transcript is sent on every turn.
- Chat works with trace message privacy disabled.
- Turns in one chat cannot overlap.
- Separate chats/tasks share the global three-slot limit.
- Agent pins never silently change.
- Crash boundaries do not duplicate assistant messages.

### 6.4 Approval

- No process prompts on JSON-RPC stdin.
- Awaiting approval retains its slot.
- Approval resumes the same run ID.
- Rejection produces durable `APPROVAL_REJECTED`.
- Multiple sequential approvals work.
- Duplicate decisions do not duplicate resume.
- Approval state restores after restart.
- Delegated child approval resumes the child and ancestor chain.

### 6.5 Quit

- Window close and application quit prevent exit during active work.
- Wait mode rejects new work and exits only after completion.
- Terminate mode handles known and late-created roots.
- Duplicate quit requests are idempotent.
- Sidecars stop only after roots are quiescent.
- No native mutex remains held while waiting on process shutdown or app exit.

### 6.6 Trace and SQLite

- Runtime writers and trace reads coexist under WAL without `SQLITE_BUSY`.
- One long trace query does not create an unbounded poll queue.
- Selection changes discard stale trace data.
- Oversized trace results degrade only the inspector.
- Killing/restarting trace leaves execution functional.
- Privacy restart changes only the trace process and capabilities.

### 6.7 Deletion

- Active and awaiting-approval deletion is rejected.
- Complete root trees and owned evidence are removed.
- Shared plans and unrelated runs survive.
- Injected failure rolls back all runtime deletion.
- `PRAGMA foreign_key_check` is empty.
- Tombstones retry after restart.
- Deleting an earlier chat turn removes dependent later turns.

### 6.8 Narrative and timers

- Event IDs deduplicate and per-run sequence orders events.
- Child events map to the correct root.
- Only whitelisted event fields reach the renderer.
- Model spans pair by call ID and do not double-count retry time.
- Late terminal events close the correct timer.
- Three simultaneous timers remain independent.

### 6.9 Markdown and Mermaid

- Markdown scripts, handlers, and unsafe URLs are removed.
- Mermaid click/HTML/foreign-object attacks cannot execute.
- Rendering makes no unexpected network requests.
- No `unsafe-eval` CSP change is introduced.
- Multiple diagrams receive collision-free IDs.
- Malformed/oversized diagrams fall back without hiding surrounding output.
- Packaged webviews are tested where the environment permits.

## 7. Verification commands

Use the narrowest relevant checks during each phase and the following package
checks before declaring the corresponding package complete.

```sh
bun run --cwd packages/core build
bun run --cwd packages/core test

bun run --cwd packages/desktop-bridge typecheck
bun run --cwd packages/desktop-bridge test

bun run --cwd packages/trace-session typecheck
bun run --cwd packages/trace-session test

bun run --cwd packages/desktop-app typecheck
bun run --cwd packages/desktop-app web:build
cargo test --manifest-path packages/desktop-app/src-tauri/Cargo.toml
```

Do not report cross-platform packaged behavior as verified when the executor cannot
run the target platform. Record such checks as outstanding manual verification.

## 8. Implementation discipline

- Work on a dedicated feature branch.
- Read repository guidance before editing.
- Preserve the core/Agent SDK boundary in `AGENTS.md` and
  `CORE-SESSION-SWARM-SPEC.md`.
- Prefer the smallest correct change that establishes each phase contract.
- Do not weaken requirements merely to make a test pass.
- Do not commit unrelated changes.
- Do not commit a phase until its relevant tests pass.
- If a prerequisite is blocked, stop and report evidence rather than skipping it.
- After every successful phase commit, report the phase, commit SHA, commit message,
  tests run, and next phase.

## 9. Definition of done

The implementation is complete when a user can:

1. Start up to three tasks or chat turns concurrently.
2. Switch among them without interrupting execution.
3. Continue a persisted, agent-pinned chat after restart.
4. Follow readable live activity and a compact model-processing timer.
5. Approve or reject risky operations, including delegated operations.
6. Read sanitized Markdown results containing Mermaid diagrams.
7. Inspect timeline, agents, tools, tokens, estimated costs, and diagnostics.
8. Restart trace with different privacy settings without affecting execution.
9. Delete completed or explicitly terminated tasks, chats, and eligible run trees.
10. Quit only after all active work completes or is explicitly terminated.
