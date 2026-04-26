# Dashboard API

The gateway exposes persisted run-inspection routes for a root-run dashboard. These routes are intended for a future web dashboard and are separate from the WebSocket protocol used to start runs, stream live events, and drive the chat UI.

## Requirements

- Routes require gateway HTTP authentication.
- The authenticated principal must have the `admin` role.
- Routes require PostgreSQL runtime stores. When the gateway is not booted with a PostgreSQL trace client, dashboard routes return `503 trace_store_unavailable`.
- Dashboard list and trace data is root-run centric. A root run is included even when it has no linked gateway session.

## Authentication

Send the same bearer token style used by the gateway HTTP status route:

```txt
Authorization: Bearer <jwt>
```

Failure responses use the gateway error envelope:

```json
{
  "type": "error",
  "code": "session_forbidden",
  "message": "Gateway dashboard routes require the admin role.",
  "requestType": "upgrade",
  "details": {
    "requiredRole": "admin"
  }
}
```

## List Runs

```txt
GET /api/runs
```

Returns paginated root-run rows for dashboard tables and filters.

### Query Parameters

| Parameter | Values | Description |
| --- | --- | --- |
| `from` | ISO date or timestamp | Include runs created at or after this time. |
| `to` | ISO date or timestamp | Include runs created at or before this time. |
| `status` | comma-separated strings | Filter by root run status, for example `running,failed`. |
| `session` | `any`, `linked`, `sessionless` | Filter by whether a gateway run session is linked. |
| `sessionId` | string | Filter by a specific gateway session id. |
| `rootRunId` | string | Filter to one root run id. |
| `runId` | string | Include the root run that contains this run id. |
| `delegateName` | string | Include root runs containing a child run with this delegate name. |
| `requiresApproval` | `true`, `false` | Filter root runs by `awaiting_approval` status. |
| `q` | string | Text search over root goal, error message, and result JSON text. |
| `sort` | `created_desc`, `updated_desc`, `duration_desc`, `cost_desc` | Sort order. Defaults to `created_desc`. |
| `limit` | integer | Page size. Defaults to `50`; maximum is `200`. |
| `offset` | integer | Offset for pagination. Defaults to `0`. |

### Example

```txt
GET /api/runs?from=2026-04-01T00:00:00.000Z&to=2026-04-23T23:59:59.000Z&status=failed,running&session=linked&requiresApproval=true&limit=25&offset=0
```

### Response

```ts
interface DashboardRunListResult {
  items: DashboardRunListItem[];
  limit: number;
  offset: number;
  nextOffset: number | null;
}

interface DashboardRunListItem {
  rootRunId: string;
  sessionId: string | null;
  status: string | null;
  goalPreview: string | null;
  agentId: string | null;
  modelProvider: string | null;
  modelName: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  childRunCount: number;
  toolCallCount: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalReasoningTokens: number | null;
  estimatedCostUSD: number;
  pendingApproval: DashboardPendingApproval | null;
}

interface DashboardPendingApproval {
  runId: string;
  rootRunId: string;
  sessionId: string | null;
  toolName?: string;
  reason?: string;
}
```

`nextOffset` is `null` when there are no more rows. Otherwise, pass it as the next `offset`.

## Inspect Root Run

```txt
GET /api/runs/:rootRunId
```

Returns a persisted trace report for one root run. This route wraps the same trace data path used by `trace-session`.

### Query Parameters

| Parameter | Values | Description |
| --- | --- | --- |
| `includePlans` | `true`, `false` | Include persisted plan rows. Defaults to `true`. |
| `messages` | `true`, `false` | Include snapshot-backed `messages[]`. Defaults to `true`. |
| `messagesView` | `compact`, `delta`, `full` | Message rendering mode hint. Defaults to `compact`. |
| `focusRunId` | string | Focus the report on a run and its descendants. |

### Response

The response is a `TraceReport`:

```ts
interface TraceReport {
  target: TraceTarget;
  session: SessionOverview | null;
  rootRuns: RootRun[];
  usage: SessionUsageSummary;
  timeline: TimelineEntry[];
  milestones?: MilestoneEntry[];
  llmMessages: RunMessageTrace[];
  runTree?: RunTreeEntry[];
  snapshotSummaries?: RunSnapshotSummary[];
  totalSteps?: number | null;
  delegates: DelegateRow[];
  plans: PlanRow[];
  summary: {
    status: 'succeeded' | 'failed' | 'blocked' | 'unknown';
    reason: string;
  };
  warnings: string[];
}
```

Use this endpoint when the UI wants one request to hydrate an inspect screen.

## Inspect Messages

```txt
GET /api/runs/:rootRunId/messages
```

Returns only the message-focused parts of the trace report.

Supported query parameters:

- `messagesView=compact|delta|full`
- `focusRunId=<run id>`

Response:

```ts
interface DashboardMessagesResponse {
  target: TraceTarget;
  warnings: string[];
  messages: RunMessageTrace[];
}
```

## Inspect Tool Timeline

```txt
GET /api/runs/:rootRunId/timeline
```

Returns persisted tool timeline rows for the run tree.

Response:

```ts
interface DashboardTimelineResponse {
  target: TraceTarget;
  warnings: string[];
  timeline: TimelineEntry[];
}
```

## Inspect Plans

```txt
GET /api/runs/:rootRunId/plans
```

Returns persisted plan execution rows for the root run.

Response:

```ts
interface DashboardPlansResponse {
  target: TraceTarget;
  warnings: string[];
  plans: PlanRow[];
}
```

## Delete Empty Sessions

```txt
DELETE /api/sessions/empty
```

Deletes gateway sessions that have no linked root runs in `gateway_session_run_links`.

Associated gateway transcript rows are deleted. `gateway_cron_runs.session_id` and `gateway_run_admissions.session_id` are cleared because those columns are not FK-cascaded. Runtime records in `agent_runs`, `agent_events`, `run_snapshots`, `plans`, `plan_executions`, and `tool_executions` are not affected because no run link exists.

Response:

```ts
interface DashboardDeleteEmptySessionsResult {
  deletedSessions: number;
  deletedTranscriptMessages: number;
  clearedCronRuns: number;
  clearedRunAdmissions: number;
}
```

## Delete Session

```txt
DELETE /api/sessions/:sessionId
```

Deletes one gateway session by id.

Associated gateway records:

- `gateway_transcript_messages` rows for the session are deleted.
- `gateway_session_run_links` rows for the session are deleted.
- `gateway_cron_runs.session_id` is cleared.
- `gateway_run_admissions.session_id` is cleared.

Runtime run records are intentionally preserved. If the session had linked runs, those runs become sessionless from the dashboard perspective.

The route rejects active sessions with `409 session_active` when the session status is `running` or `awaiting_approval`.

Response:

```ts
interface DashboardDeleteSessionResult {
  sessionId: string;
  deletedSessions: number;
  deletedTranscriptMessages: number;
  deletedSessionRunLinks: number;
  clearedCronRuns: number;
  clearedRunAdmissions: number;
}
```

## Delete Sessionless Run

```txt
DELETE /api/runs/:rootRunId
```

Deletes a root run tree only when it is sessionless. The route first verifies that no `gateway_session_run_links` row exists for the requested `rootRunId`.

Associated runtime records:

- child and root rows in `agent_runs` are deleted;
- `agent_events`, `run_snapshots`, `tool_executions`, and `plan_executions` are deleted by cascade;
- plans created from runs in the tree are deleted, which also deletes `plan_steps`;
- `gateway_cron_runs` and `gateway_run_admissions` rows for the root run are deleted.

The route rejects linked root runs with `409 run_linked_to_session`. It also rejects non-terminal run trees with `409 run_not_terminal`; all runs in the tree must be one of `succeeded`, `failed`, `clarification_requested`, `replan_required`, or `cancelled`.

Response:

```ts
interface DashboardDeleteSessionlessRunResult {
  rootRunId: string;
  deletedRuns: number;
  deletedPlans: number;
  deletedCronRuns: number;
  deletedRunAdmissions: number;
}
```

## Replay Root Run

```txt
POST /api/runs/:rootRunId/replay
```

Reconnects the latest linked gateway run session for a root run and restores the latest known runtime state for that session.

This route is intended for dashboard replay buttons on linked runs. Sessionless runs are rejected.

Response:

```ts
interface DashboardReplayRunResult {
  sessionId: string;
  rootRunId: string;
  runId: string | null;
  status: string;
  policy: string;
  replayedFrameType: 'run.output' | 'approval.requested' | null;
  pendingApproval: DashboardPendingApproval | null;
}
```

Typical `policy` values mirror gateway reconnect behavior such as `terminal_result`, `terminal_replay`, `pending_approval`, `resumed`, or `session_only`.

When no linked run session exists, the route returns:

```json
{
  "type": "error",
  "code": "replay_session_unavailable",
  "message": "No gateway run session is linked to root run \"...\". Replay is not available from the dashboard for sessionless runs."
}
```

## Retry Run

```txt
POST /api/runs/:runId/retry
```

Bridges to the existing gateway `run.retry` flow. The `:runId` parameter may be either:

- a failed run id linked to a gateway run session
- a linked root run id, in which case the gateway resolves the latest run-session link for that root run

The dashboard should normally call this route with the row's `rootRunId`.

Response:

```ts
type DashboardRetryRunResult =
  | RunOutputFrame
  | ApprovalRequestedFrame;
```

## Resolve Approval

```txt
POST /api/runs/:runId/approval
Content-Type: application/json
```

Request:

```json
{
  "approved": true
}
```

Optional request metadata may be included:

```json
{
  "approved": false,
  "metadata": {
    "source": "dashboard"
  }
}
```

This route bridges to the existing gateway approval resolution flow. It can resolve approvals when the run or root run is linked to a gateway run session.

If no linked session exists, the route returns:

```json
{
  "type": "error",
  "code": "approval_session_unavailable",
  "message": "No gateway run session is linked to run \"...\". Sessionless approval resolution is not available through the gateway dashboard yet."
}
```

Sessionless approval resolution is intentionally not inferred yet, because the current gateway approval contract still requires a session-bound `approval.resolve`.

## Error Responses

Common dashboard errors:

| HTTP Status | Code | Meaning |
| --- | --- | --- |
| `400` | `invalid_frame` | Query or body validation failed. |
| `401` | `auth_required` | Missing authenticated principal. |
| `403` | `session_forbidden` | Authenticated principal is not an admin. |
| `409` | `approval_session_unavailable` | Approval cannot be resolved without a linked gateway session. |
| `409` | `replay_session_unavailable` | Replay was requested for a root run with no linked gateway run session. |
| `409` | `session_active` | Session deletion was requested for a running or approval-blocked session. |
| `409` | `run_linked_to_session` | Sessionless run deletion was requested for a root run linked to a gateway session. |
| `409` | `run_not_terminal` | Sessionless run deletion was requested for a root run tree with non-terminal runs. |
| `503` | `trace_store_unavailable` | Gateway is not using PostgreSQL runtime stores for trace data. |
| `503` | `agent_registry_unavailable` | Approval resolution was requested but no agent registry is available. |

## UI Guidance

A dashboard should use `GET /api/runs` for the table and quick filters. Use `GET /api/runs/:rootRunId` for the first inspect request when the user selects a row. The narrower `/messages`, `/timeline`, and `/plans` routes are useful for lazy-loading tabs or refreshing one panel without rehydrating the full trace.

Good default filters:

- Last 24 hours or last 7 days.
- `requiresApproval=true` for a needs-attention view.
- `session=sessionless` for isolated runs not visible in session history.
- `status=failed` for failure review.
