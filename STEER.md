# Steer API Short Spec

Implement a steering model where steering targets the active execution leaf by default, while preserving exact-run steering as an explicit mode.

## Goal

Users should be able to steer "the thing currently running" without needing to know whether execution is on a root run or delegated child run.

## Current Problem

Today `steer(runId, ...)` applies to the exact run row identified by `runId`. This is confusing when a parent run is `awaiting_subagent` and the active work is happening in `currentChildRunId`.

## Required Behavior

- Default steering behavior must resolve to the active execution leaf.
- Exact-run steering must remain supported as an explicit mode.
- Session-oriented steering must be supported so clients can steer the active run in a run session without manually providing a child run id.

## Definitions

- `exact`: steer only the specified run id.
- `leaf`: steer the active descendant leaf under the specified run id.
- `session-active`: steer the active run for a session, then resolve to its active leaf.

## Resolution Rules

For `leaf` resolution:

1. If the target run is `running`, `planning`, or `queued`, steer that run.
2. If the target run is `awaiting_subagent`, follow `currentChildRunId`.
3. Repeat recursively until a non-`awaiting_subagent` run is reached.
4. If `currentChildRunId` is missing while `awaiting_subagent`, return a conflict/error.
5. If the resolved run is terminal, return an error.

## Status Handling

- `running`, `planning`, `queued`: steering allowed.
- `awaiting_subagent`: resolve to child leaf.
- `awaiting_approval`: reject with clear message directing caller to approval flow.
- `clarification_requested`: reject with clear message directing caller to clarification flow.
- terminal statuses: reject.

## HTTP/API Changes

Support:

- `POST /api/runs/:runId/steer`
  Default mode: `leaf`
- `POST /api/runs/:runId/steer?mode=exact`
- `POST /api/runs/:runId/steer?mode=leaf`
- `POST /api/sessions/:sessionId/steer`
  Default mode: `session-active`

Request body remains:

```json
{
  "message": "string",
  "role": "user|system",
  "metadata": {}
}
```

## Authorization

- Steering over HTTP must be authorized against the gateway session that owns the targeted run or session.
- The caller must have the same role and principal identity as the one that initiated the session.
- `POST /api/sessions/:sessionId/steer` must reject callers that did not initiate `:sessionId`.
- `POST /api/runs/:runId/steer` must resolve the owning session for `:runId` and reject callers that do not match the initiator of that session.
- Admin or elevated roles may be supported only if the existing gateway authorization model already allows them for session-bound run actions.
- Authorization failures should return a clear forbidden/auth error rather than falling through to run-resolution errors.

## Response Shape

Return both requested and resolved target ids.

Example:

```json
{
  "status": "steered",
  "requestedRunId": "parent-run-id",
  "resolvedTargetRunId": "child-run-id",
  "resolution": "leaf",
  "role": "user"
}
```

For session steering:

```json
{
  "status": "steered",
  "sessionId": "session-id",
  "requestedRunId": "root-or-active-run-id",
  "resolvedTargetRunId": "leaf-run-id",
  "resolution": "session-active",
  "role": "user"
}
```

## CLI/TUI Expectations

- `/steer <message>` must steer the active run in the current run session using `session-active` resolution.
- `/steer <runId> <message>` should use leaf semantics by default.
- Add explicit escape hatch for exact steering, e.g. `/steer --exact <runId> <message>`.

## Non-Goals

- Do not fan out one steer message to multiple runs.
- Do not remove exact-run steering.
- Do not change delegation architecture or run hierarchy semantics.

## Implementation Notes

- Introduce a reusable resolver that maps a run id or session id to a steerable target run id.
- Reuse existing hierarchy fields, especially `currentChildRunId`.
- Ensure returned metadata makes the final steer target observable to clients and logs.

## Tests Required

- steer root run with no child
- steer parent run with active child
- steer nested delegated child chain
- exact mode steers parent even when child is active
- steering session targets active leaf
- reject steering when caller is not the principal/role that initiated the session
- reject when target is awaiting approval
- reject when target is clarification requested
- reject when target is terminal
- reject ambiguous session-active resolution if multiple active runs exist
- handle missing `currentChildRunId` while `awaiting_subagent` with explicit error
