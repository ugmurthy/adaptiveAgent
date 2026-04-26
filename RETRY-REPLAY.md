# Retry / Replay Proposal

## Scope

This document proposes a minimal `delegate retry in place` design for `@adaptive-agent/core`.

The goal is to improve retry efficiency when a delegated child run fails due to timeouts, retryable tool failures, or transient runtime interruptions, without introducing a general replay engine.

## Problem

Today the runtime already has useful recovery primitives:

- `resume(runId)` reloads the latest snapshot state and continues execution.
- `retry(runId)` retries certain failed runs.
- `ToolExecutionStore` can reuse completed tool executions by idempotency key.
- Delegation persists a parent/child boundary through `awaiting_subagent`, `currentChildRunId`, and `waitingOnChildRunId` snapshot state.

However, the current behavior is still inefficient for delegated work:

- a failed delegate step often leads to retrying at the parent boundary instead of continuing the existing child run
- completed work inside the failed child run is not always reused efficiently
- child retry-in-place is currently special-cased only for `MAX_STEPS`
- generic retryability for synthetic `delegate.*` steps is too narrow

This is especially expensive when a delegate has already spent many tool calls before failing.

## Goals

- Retry an existing delegated child run in place when it is safe.
- Reuse successful work already completed inside that child run.
- Keep the parent run on the same pending delegate step boundary.
- Avoid respawning a replacement child run unless there is no recoverable linked child.
- Avoid schema changes and avoid introducing a general event replay system.

## Non-Goals

- No generic step replay for arbitrary tools.
- No full event-log replay or reducer-based recovery.
- No gateway protocol changes.
- No new database tables for step journaling.
- No attempt to solve ambiguous replay of side-effecting tools after timeout/crash.

## Current Runtime Behavior

### Parent retry and resume

- `resume(runId)` loads the latest snapshot state and, when needed, resolves an existing delegation boundary before entering the main execution loop.
- `retry(runId)` validates retryability, flips the run back to `running`, and continues execution.
- `retry(runId)` is run-level, not step-level.

### Delegation boundary

When a parent invokes `delegate.<name>`:

- a child run is created
- the parent is moved to `awaiting_subagent`
- the parent stores `currentChildRunId`
- snapshot state stores `waitingOnChildRunId`
- `ToolExecutionStore` stores `childRunId` against the delegate tool execution

When recovering a waiting parent:

- the runtime can resolve the parent directly from the linked child run if the child is already terminal
- the runtime can resume an in-progress child
- the runtime can fail the parent if the linkage is inconsistent

### Existing limitation

Child retry-in-place already exists, but only for `child.status === failed` with `child.errorCode === MAX_STEPS`.

That means transient child failures like timeout, network, rate-limit, or retryable tool failure do not benefit from the same in-place retry path.

## Minimal Proposal

### Core idea

Treat parent retry of a failed delegate step as:

- first try to continue the existing child run in place
- only respawn a new child if there is no valid linked child to recover

This keeps the retry boundary inside the child run, where the child's own snapshots and completed tool executions already exist.

### Recovery order

When a parent run is retried or resumed and its current pending step is `delegate.*`:

1. Identify the linked child run.
2. Validate that the child is still correctly linked to the parent.
3. Attempt child-local recovery.
4. Resolve the parent from the existing child result.
5. Only if no recoverable child exists, fall back to current behavior.

### Child lookup order

The runtime should resolve the child run using the following sources in order:

1. `run.currentChildRunId`
2. `state.waitingOnChildRunId`
3. `ToolExecutionStore.getByIdempotencyKey(...).childRunId`

This avoids losing linkage if one persisted source is stale while another is still intact.

### Child recovery behavior

If a linked child run is found:

- if child status is `queued`, `planning`, `running`, `awaiting_subagent`, or `interrupted`, call `resume(childRunId)`
- if child status is `failed` and the child run itself is retryable, call `retry(childRunId)`
- if child status is `succeeded`, resolve the parent immediately from the child result
- if child status is terminal and non-retryable, fail the parent as today

### Parent step behavior

While child recovery is happening:

- keep the parent on the same pending `delegate.*` step
- do not remove the pending delegate tool call
- do not clear `waitingOnChildRunId`
- do not spawn a new child run

After the child reaches a terminal state:

- resolve the parent through the existing delegation resolution path
- emit the same `tool.completed` or `tool.failed` event shape the parent would already expect
- advance the parent step only once

## Proposed Code Changes

## 1. Reuse delegate-boundary recovery from `retry()`

Current issue:

- `resume()` resolves a waiting delegate boundary before entering the execution loop
- `retry()` transitions the run to `running` and enters the loop directly

Minimal change:

- extract the shared pre-loop continuation behavior into a helper
- have both `resume()` and `retry()` call that helper

Example shape:

```ts
private async continueRunFromState(
  run: AgentRun,
  state: ExecutionState,
  options: { retryFailedChild: boolean },
): Promise<RunResult>
```

Behavior:

- if `shouldResolveWaitingDelegateSnapshot(state)` is true, resolve the delegate boundary first
- then enter `executionLoop()`

This is the key change that prevents parent retry from immediately replaying the delegate tool call.

## 2. Generalize child retry-in-place

Current issue:

- `resumeAwaitingParent()` only retries a failed child run when the child failed with `MAX_STEPS`

Minimal change:

- replace the `MAX_STEPS` special case with a general child retryability check
- if the child run is failed and the child run itself is retryable, call `childAgent.retry(child.id)`

This should reuse the child's own retry rules instead of duplicating policy in the parent.

## 3. Delegate-aware retryability in the parent

Current issue:

- parent retryability for `delegate.*` steps currently goes through generic tool retry policy checks
- synthetic `delegate.*` tools do not carry a useful retry policy by default

Minimal change:

- add a delegate-specific branch to parent retryability checks
- parent retry is allowed when:
  - the current pending tool is `delegate.*`
  - a valid linked child run exists
  - that child can be resumed or retried in place

Parent retry should be rejected when:

- the linked child is missing
- linkage is invalid
- the child is terminal and non-retryable

## 4. Linkage validation remains mandatory

The runtime should continue to validate:

- child `parentRunId`
- child `rootRunId`
- child `parentStepId`

If any of these mismatch, fail closed rather than retrying the wrong child.

## Retry Policy Rules

For the minimal design, child retryability should remain conservative:

- `MODEL_ERROR` is retryable only for transient failure kinds already recognized as retryable
- `TOOL_ERROR` is retryable only if the child's current pending tool is retryable by tool policy
- `MAX_STEPS` remains retryable as it is today
- `REPLAN_REQUIRED` is not retryable
- `APPROVAL_REJECTED` is not retryable
- non-retryable `TOOL_ERROR` remains non-retryable

The parent should not bypass the child's own retry policy.

## Why This Is Minimal

This design deliberately reuses existing runtime state instead of adding new abstractions.

It relies on data that already exists:

- snapshot state for pending delegate boundaries
- `currentChildRunId` on the parent run
- `childRunId` in `ToolExecutionStore`
- existing child run snapshots and completed tool execution records

That means:

- no schema migration
- no new public API
- no event replay reducer
- no new generic replay semantics for tools

## Why This Improves Efficiency

Retrying the existing child run in place means:

- completed child tool calls remain reusable by idempotency key
- child-local model context remains in the child snapshot
- the parent does not need to recreate a fresh child run and repeat prior delegated reasoning

This directly addresses the most expensive inefficiency in the current design.

## Risks

### Ambiguous tool side effects inside the child

If the child failed because a tool timed out, the tool may still have committed an external side effect after the runtime declared failure.

This proposal does not solve that problem generically.

Mitigation:

- keep child retryability conservative
- continue relying on tool-level retry policy for retryable tool failures
- do not claim generic replay safety

### Parent/child divergence

If different persisted sources disagree about the linked child, the runtime could recover the wrong run.

Mitigation:

- strict linkage validation
- fail closed on mismatch

### Retry loops

If parent retry delegates to child retry without bounded child policy, repeated retries could loop.

Mitigation:

- keep child retry bounded by existing retry-attempt policy
- do not add parent-side bypasses

### Concurrency races

If another worker is already recovering the child, parent-side recovery could race it.

Mitigation:

- rely on existing lease acquisition inside `resume()` and `retry()`
- keep recovery inside the child run boundary

## Test Plan

Add focused regression tests in `packages/core/src/adaptive-agent.test.ts`.

### Required tests

- parent retry of a failed delegate child retries the same child run instead of spawning a second one
- parent resume of a waiting delegate child resumes the same child run and resolves the parent without respawn
- parent retry succeeds when the child failed with a retryable timeout/model failure and the child can be retried in place
- parent retry fails when the linked child is terminal and non-retryable
- parent recovery can find `childRunId` from `ToolExecutionStore` when `currentChildRunId` is absent
- linkage mismatch still fails closed

### Existing behavior to preserve

- current `MAX_STEPS` child retry behavior should keep working
- existing reconnect resume behavior should remain unchanged
- existing completed tool execution reuse should remain unchanged

## Suggested Implementation Order

1. Extract a shared `continue from state` helper used by both `resume()` and `retry()`.
2. Generalize child retry-in-place beyond `MAX_STEPS`.
3. Add delegate-aware parent retryability checks.
4. Add fallback child lookup via `ToolExecutionStore.childRunId`.
5. Add regression tests.

## Out Of Scope Follow-Up Work

If future work needs broader replay efficiency, that should be a separate design:

- step-attempt metadata
- explicit step journals
- generic ambiguous tool replay contracts
- recovery worker automation using `PostgresRecoveryScanner`
- event-log-based state reconstruction

Those changes are intentionally not part of this minimal proposal.

## Recommendation

Proceed with this minimal design first.

It gives the highest efficiency gain for delegated failures while keeping correctness risk contained and preserving the current runtime model.
