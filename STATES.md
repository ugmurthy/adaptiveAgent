# Resumable Session State Plan

This plan tracks the work needed to make run and gateway session state robust across process failures, restarts, reconnects, and repeated resume attempts.

## Progress

- [x] Capture the implementation plan in this file.
- [x] Define and validate a versioned runtime `ExecutionStateV1` snapshot shape.
- [x] Keep legacy snapshots loadable during the v1 transition.
- [x] Implement durable Postgres runtime stores for `agent_runs`, `agent_events`, `run_snapshots`, plans, and plan executions.
  - [x] Add `PostgresRunStore`, `PostgresEventStore`, and `PostgresSnapshotStore`.
  - [x] Add `PostgresPlanStore`.
- [x] Add a durable tool-call ledger keyed by `runId`, `stepId`, `toolCallId`, and `idempotencyKey`.
- [x] Make critical run transitions transactional.
  - [x] Transactional initial run creation, `run.created`, initial snapshot, and `snapshot.created`.
  - [x] Transactional terminal root run update, final snapshot, and terminal event.
  - [x] Transactional non-terminal continuation snapshots and `snapshot.created`.
  - [x] Transactional tool completion ledger update, tool event, and continuation snapshot.
    - [x] Tool completion/failure ledger updates and matching tool events share a transaction.
    - [x] Tool completion continuation snapshot is folded into the same transaction boundary.
  - [x] Transactional child run creation, parent awaiting state, waiting snapshot, and `delegate.spawned`.
  - [x] Transactional child terminal resolution back into parent delegate state.
- [x] Harden parent/child delegation resume and recovery edge cases.
- [x] Add a recovery scanner for expired leases and inconsistent waiting states.
- [x] Connect gateway session reconnect to runtime resume policy.
- [x] Add crash-window and repeated-resume tests.
- [x] Document the final operational semantics and guarantees.

## Activity Log

- 2026-04-13: Added this plan and progress tracker.
- 2026-04-13: Started implementation with versioned runtime snapshot state. New snapshots write `schemaVersion: 1`; unversioned legacy snapshots still load; incompatible future snapshot versions fail explicitly during resume.
- 2026-04-13: Verified the first implementation slice with `bunx vitest run packages/core/src/adaptive-agent.test.ts`.
- 2026-04-13: Added durable Postgres runtime stores for `agent_runs`, `agent_events`, and `run_snapshots`, exported them from core, and covered them with mocked-client unit tests.
- 2026-04-13: Verified the runtime-store slice with `bunx vitest run packages/core/src/postgres-runtime-stores.test.ts` and `bun run build` in `packages/core`.
- 2026-04-13: Added `PostgresPlanStore` for `plans`, `plan_steps`, and `plan_executions`, included it in `createPostgresRuntimeStores`, and extended mocked-client coverage.
- 2026-04-13: Added `ToolExecutionStore`, `InMemoryToolExecutionStore`, and `PostgresToolExecutionStore`; wired the runtime to reuse completed ledger entries by `idempotencyKey` before re-executing tools.
- 2026-04-13: Verified ledger reuse with `bunx vitest run packages/core/src/adaptive-agent.test.ts packages/core/src/postgres-runtime-stores.test.ts` and `bun run build` in `packages/core`.
- 2026-04-13: Verified the full core Vitest suite with `bunx vitest run` in `packages/core`. `bun test` is not a valid substitute yet because existing tests use Vitest-only `vi.stubGlobal` and `vi.unstubAllGlobals` helpers.
- 2026-04-13: Started transactional critical transitions by adding an optional `RuntimeTransactionStore`, implementing `PostgresRuntimeStoreBundle.runInTransaction`, and routing initial run creation, `run.created`, initial snapshot, and `snapshot.created` through one transaction when a transactional store is configured.
- 2026-04-13: Verified the transactional-run-creation slice with `bunx vitest run packages/core/src/postgres-runtime-stores.test.ts packages/core/src/adaptive-agent.test.ts` and `bun run build` in `packages/core`.
- 2026-04-13: Extended transactional critical transitions to terminal root run persistence: `succeeded`/`failed` run updates, final snapshots, and terminal events now share one transaction when a transactional store is configured.
- 2026-04-13: Verified the terminal-transition slice with `bunx vitest run packages/core/src/adaptive-agent.test.ts packages/core/src/postgres-runtime-stores.test.ts` and `bun run build` in `packages/core`.
- 2026-04-13: Extended transactional snapshot persistence so non-terminal continuation snapshots, including model tool-call queue snapshots, persist `run_snapshots` and `snapshot.created` in one transaction when a transactional store is configured.
- 2026-04-13: Verified the transactional-snapshot slice with `bunx vitest run packages/core/src/adaptive-agent.test.ts packages/core/src/postgres-runtime-stores.test.ts` and `bun run build` in `packages/core`.
- 2026-04-13: Extended transactional tool persistence so tool completion/failure ledger updates and matching `tool.completed`/`tool.failed` events share one transaction when a transactional store and tool execution store are configured.
- 2026-04-13: Verified the transactional-tool-event slice with `bunx vitest run packages/core/src/adaptive-agent.test.ts packages/core/src/postgres-runtime-stores.test.ts` and `bun run build` in `packages/core`.
- 2026-04-13: Folded successful tool-call continuation persistence into one transaction: ledger completion, `tool.completed`, `step.completed`, and the continuation snapshot now commit together when the transactional runtime includes `toolExecutionStore`.
- 2026-04-13: Verified the combined tool-continuation slice with `bunx vitest run packages/core/src/adaptive-agent.test.ts packages/core/src/postgres-runtime-stores.test.ts` and `bun run build` in `packages/core`.
- 2026-04-13: Extended transactional delegation persistence so child spawn, parent `awaiting_subagent`, waiting snapshot, `delegate.spawned`, and child `run.created` share one transaction when configured; parent delegate resolution now updates parent state and emits the parent delegate tool event in one transaction.
- 2026-04-13: Verified the delegation transaction slice with `bunx vitest run packages/core/src/adaptive-agent.test.ts packages/core/src/postgres-runtime-stores.test.ts` and `bun run build` in `packages/core`.
- 2026-04-13: Hardened delegation resume recovery so a parent with a stale waiting snapshot and already-resolved child consumes the existing child result instead of spawning a duplicate child; parent/child linkage mismatches now fail explicitly during resume.
- 2026-04-13: Verified the delegation recovery slice with `bunx vitest run packages/core/src/adaptive-agent.test.ts`, the full core suite via `bunx vitest run` in `packages/core`, and `bun run build` in `packages/core`.
- 2026-04-13: Added `PostgresRecoveryScanner` for expired leases, `awaiting_subagent` parents with terminal/missing/mismatched children, stale `running` runs, optional approval/clarification reattachment candidates, and orphan child rows; `resume()` now takes the run lease before parent/child recovery.
- 2026-04-13: Verified the recovery-scanner slice with `bun --cwd packages/core test src/postgres-runtime-stores.test.ts`, `bun --cwd packages/core test src/adaptive-agent.test.ts`, and `bun run build` in `packages/core`.
- 2026-04-13: Connected gateway reconnect to runtime policy: active sessions now inspect runtime run state, settle terminal runs, preserve pending approval/clarification state, resume expired active runs when supported, and otherwise reattach as observers.
- 2026-04-13: Added crash-window and repeated-resume coverage for reconnect recovery, queued tool-call snapshots, completed tool-ledger reuse, and repeated terminal resume attempts.
- 2026-04-13: Documented final operational semantics and guarantees in the v1.4 contracts and runtime algorithm docs, including transaction boundaries, tool ledger resume, terminal repeated resume, delegation idempotency, recovery scanner ownership, and gateway reconnect policy.

## Target Guarantees

- A run can resume from the latest valid snapshot after a restart.
- Gateway reconnect can reattach to the current run, pending approval, pending clarification, or terminal result.
- Parent and child run resolution is idempotent.
- Repeated `resume()` calls do not double-complete a parent delegate step.
- Tool calls are not re-executed after a completed durable ledger record exists.
- External side effects are exactly-once only when tools honor the runtime `idempotencyKey`.
- Invalid or incompatible snapshot state fails explicitly instead of silently rebuilding context.

## Implementation Phases

### 1. Version Runtime Snapshot State

Define `ExecutionStateV1` with:

```ts
interface ExecutionStateV1 {
  schemaVersion: 1;
  messages: ModelMessage[];
  stepsUsed: number;
  outputSchema?: JsonSchema;
  pendingToolCalls: PendingToolCallState[];
  approvedToolCallIds: string[];
  waitingOnChildRunId?: UUID;
}
```

New snapshots should write `schemaVersion: 1`. Snapshot loading should validate the shape and keep existing unversioned snapshots loadable as legacy v1-compatible state.

### 2. Add Durable Runtime Stores

Implement Postgres-backed stores that satisfy the runtime contracts:

- `PostgresRunStore`
- `PostgresEventStore`
- `PostgresSnapshotStore`
- `PostgresPlanStore`

These stores should implement optimistic `version` checks, lease acquisition, heartbeat extension, release, ordered per-run event sequences, and latest-snapshot lookup.

### 3. Add A Tool-Call Ledger

Add durable tool execution records with:

```sql
run_id
step_id
tool_call_id
tool_name
idempotency_key
status
input_hash
output
error_code
error_message
started_at
completed_at
```

Resume policy:

- Reuse completed tool outputs.
- Retry or fail incomplete tool calls according to tool policy.
- Require side-effecting tools to use `idempotencyKey` for external exactly-once behavior.

### 4. Transactional Critical Transitions

Make these transitions atomic:

- run creation, initial snapshot, and `run.created`
- model tool-call queue snapshot
- tool completion, ledger completion, event, and snapshot
- child run creation, parent `awaiting_subagent`, waiting snapshot, and `delegate.spawned`
- child terminal state, parent delegate resolution, parent event, and snapshot
- terminal run update, final snapshot, and terminal event

After each transaction, the database should describe exactly one valid continuation path.

### 5. Harden Delegation Resume

Handle these states explicitly:

- parent waiting with valid child
- parent waiting with missing child
- parent waiting with terminal child
- child terminal while parent still waits
- child running with expired lease
- child interrupted
- child approval or clarification in non-interactive mode
- parent/child linkage mismatch

Resolution must be idempotent.

### 6. Recovery Scanner

Add a recovery service that scans for:

- non-terminal runs with expired leases
- `awaiting_subagent` parents with terminal children
- stale `running` runs
- pending approvals or clarifications needing session reattachment
- orphan child runs

The scanner must acquire a lease before modifying a run.

### 7. Gateway Reconnect Policy

On reconnect:

1. Load the gateway session.
2. Load `currentRunId` and `currentRootRunId`.
3. If terminal, return stored status/result.
4. If awaiting approval or clarification, re-present that state.
5. If running or awaiting child with an expired lease, trigger or offer resume.
6. If actively leased elsewhere, reattach as observer.

### 8. Verification

Add tests for:

- crash after initial run creation
- crash after model tool-call response
- crash after side-effecting tool completion but before snapshot
- crash after `delegate.spawned`
- crash while child is running
- crash after child terminal before parent resolution
- concurrent repeated `resume(parentRunId)`
- missing or corrupt snapshot state
- stale lease takeover
- gateway reconnect to pending approval
- gateway reconnect to waiting child run

## Operational Semantics

- Durable stores provide at-least-once execution by default.
- Completed ledger entries give runtime-level exactly-once tool result reuse.
- External side effects are exactly-once only when the tool honors `idempotencyKey`.
- Model calls may replay unless their response was durably snapshotted before tool execution.
- Delegation resolution must be idempotent.
- Terminal repeated `resume()` calls return stored results without re-entering execution.
- Gateway reconnect settles terminal runs, re-presents pending interaction states, resumes expired active leases when supported, and otherwise reattaches as an observer.
