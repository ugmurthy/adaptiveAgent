# Secure Multi-Tenant Fastify SDK WebSocket Specification

## Purpose

Build a secure multi-tenant Fastify server that exposes the Adaptive Agent SDK directly over authenticated WebSockets. The first implementation should expose a small, production-shaped API for real-time runs, reconnect, event replay, interruption, inspection, and user-owned history. Chat, steering, approval, clarification, retry, recovery, and orchestration are layered phases that build on the same tenant and event model.

This specification is implementation guidance only. It does not require CLI subprocesses and should not route execution through the Adaptive Agent CLI. Runtime calls must import and invoke the SDK and core APIs directly.

## Design Priorities

In priority order:

1. Keep the gateway simple and functional against the current `@adaptive-agent/agent-sdk` API.
2. Keep user isolation and credential handling secure by default.
3. Make the WebSocket protocol predictable for browser clients and reconnect UX.
4. Avoid over-engineering the MVP; defer scale-only infrastructure until it is needed.
5. Keep event replay and history efficient enough for common UI flows.

## Scope

### MVP In Scope

- Fastify TypeScript server.
- `@fastify/websocket` for live bidirectional communication.
- Direct `@adaptive-agent/agent-sdk` usage.
- PostgreSQL persistence using the SDK's Postgres runtime mode.
- JWT authentication for HTTP and WebSocket messages.
- Server-owned allowlist of callable agents and SDK configs.
- Per-user isolation for sessions, runs, events, history, and active in-memory state.
- `run.start`, `run.inspect`, `run.interrupt`, `session.subscribe`, `session.unsubscribe`, and `history.list`.
- Gateway-normalized event streaming with replay by session sequence.
- Persistent user-owned history for runs and sessions.
- Browser-client compatibility with React, Next.js, or similar clients.

### Phased Extensions

- Refresh-token rotation for long-lived web sessions.
- Chat transcript persistence and `chat.start` / `chat.message`.
- `run.steer` for mid-run user guidance.
- Approval and clarification flows.
- Retry, resume, continuation, and recovery inspection.
- Orchestration using `createOrchestrationSdk(...)`.
- Swarm-style coordinator, worker, quality, and synthesizer flows when the SDK entrypoint is stable.
- Multi-instance fanout, distributed execution queues, optional RLS, cost limits, and admin observability.

### Out of Scope

- CLI subprocess execution.
- Moving CLI-specific behavior into `@adaptive-agent/core`.
- Making core depend on `@adaptive-agent/agent-sdk`.
- Introducing a separate `swarmId`; use `sessionId` plus `coordinatorRunId`.
- Trusting model output, client-supplied `userId`, or SDK metadata alone for authorization.
- Allowing clients to submit agent configs, model configs, provider credentials, tool lists, delegates, workspace roots, or approval defaults.

## High-Level Architecture

```text
Frontend client
  | HTTPS / WSS
  v
Fastify gateway
  |-- Auth layer
  |   |-- login
  |   |-- JWT verification
  |   |-- refresh token rotation      (optional / phase 2)
  |
  |-- HTTP API
  |   |-- history
  |   |-- session inspection
  |   |-- auth
  |
  |-- WebSocket API
  |   |-- run.start
  |   |-- run.inspect
  |   |-- run.interrupt
  |   |-- session.subscribe
  |   |-- history.list
  |   |-- run.steer                 (phase 2)
  |   |-- chat.message              (phase 2)
  |   |-- run.retry                 (phase 3)
  |   |-- run.approval              (phase 2)
  |   |-- run.clarification         (phase 2)
  |   |-- orchestration.start       (phase 4)
  |   |-- swarm.start               (future)
  |
  |-- Agent execution layer
  |   |-- createAgentSdk(...)
  |   |-- createOrchestrationSdk(...)
  |   |-- event subscription
  |   |-- active run registry
  |
  |-- Persistence layer
      |-- tenant tables
      |-- SDK/core runtime tables
      |-- audit log
  v
PostgreSQL
```

## Package Boundary Rules

- `@adaptive-agent/core` owns runtime semantics: runs, sessions, child runs, retries, continuation, persistence, events, snapshots, leases, and runtime metadata.
- `@adaptive-agent/agent-sdk` owns agent-profile loading, prompt construction, default agent selection, catalog handling, and translating user intent into strict core requests.
- The Fastify gateway owns authentication, authorization, tenant identity, WebSocket routing, connection lifecycle, and user-facing persistence.
- The gateway may prevalidate requests, but core must still validate execution-time data.
- Gateway authorization must not rely only on `metadata.userId`; database ownership checks are mandatory.

## SDK Integration

Use direct SDK imports:

```ts
import {
  createAgentSdk,
  createOrchestrationSdk,
  type AgentEvent,
} from '@adaptive-agent/agent-sdk';
```

Execution mapping:

| Gateway operation | SDK operation |
| --- | --- |
| One-shot run | `sdk.runRaw(goal, options)` |
| Chat turn | `sdk.chatRaw(messages, options)` |
| Retry | `sdk.retryRaw(runId)` |
| Resume | `sdk.resumeRaw(runId)` |
| Recovery options | `sdk.getRecoveryOptions(runId)` |
| Continuation | `sdk.createContinuationRun(options)` then `sdk.continueRunRaw(options)` |
| Interrupt | `sdk.interrupt(runId)` |
| Steer | `sdk.steer(runId, { role, message })` |
| Approval | `sdk.agent.resolveApproval(runId, approved)` then `sdk.resumeRaw(runId)` |
| Clarification | `sdk.agent.resolveClarification(runId, answer)` |
| Inspect | `sdk.inspect(runId)` |
| Streaming | `eventListener` or `sdk.subscribe(listener)` |
| Agent catalog | Server config plus SDK catalog inspection helpers where appropriate |
| Orchestration | `createOrchestrationSdk(...).run(...)` |
| Swarm | Future SDK swarm entrypoint when stable |

All SDK calls must include server-generated or server-verified `sessionId`.

```ts
await sdk.runRaw(goal, {
  sessionId,
  input,
  contentParts,
  context: {
    ...context,
    sessionId,
  },
  metadata: {
    ...metadata,
    tenantSessionId: sessionId,
    userId,
  },
});
```

`metadata.userId` is for traceability only. Authorization must be enforced through database ownership checks and in-memory keying.

### Server-Owned Agent Catalog

The gateway must expose only server-configured agents. The client may choose an `agentId` from an allowlist, but it must not provide or override:

- agent config files
- model provider, model name, base URL, or API key settings
- tool lists, delegate lists, or workspace roots
- approval mode, `autoApproveAll`, or write-tool policy
- runtime mode or persistence options

Recommended catalog shape:

```ts
interface GatewayAgentCatalogEntry {
  agentId: string;
  displayName: string;
  description?: string;
  agentConfigPath?: string;
  enabled: boolean;
  allowedInvocationModes: Array<'run' | 'chat'>;
}
```

The public `GET /api/agents` response should omit config paths and any provider/tool credential details:

```json
{
  "agents": [
    {
      "agentId": "default-agent",
      "displayName": "Default Agent",
      "description": "General-purpose assistant",
      "allowedInvocationModes": ["run", "chat"],
      "capabilities": {
        "modalitiesSupported": ["text"]
      }
    }
  ]
}
```

SDK instances may be cached per agent config and runtime bundle when safe. They should not be recreated for every WebSocket message if a shared Postgres runtime and immutable server-owned config can be reused safely.

## Separation of Concerns

Recommended modules:

- `auth/`: password verification, JWT signing, optional refresh token rotation, auth hooks.
- `transport/http/`: login, optional refresh, history, session inspection, health.
- `transport/ws/`: WebSocket registration, auth handshake, message dispatch, connection registry.
- `agents/`: SDK factory, execution service, event subscription, active run tracking.
- `persistence/`: tenant-aware repositories and ownership checks.
- `security/`: schemas, rate limits, redaction, audit logging, policy checks.
- `config/`: agent catalog, runtime mode, limits, provider configuration.

## Database Schema

The SDK/core Postgres runtime already owns tables such as:

- `agent_runs`
- `agent_events`
- `run_snapshots`
- `plans`
- `plan_steps`
- `plan_executions`
- `tool_executions`
- `run_continuations`

These tables are runtime tables, not a complete tenant authorization model. Add app-owned tenant tables.

### Users

```sql
create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,
  display_name text,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

### Refresh Tokens

This table is required only when refresh-token rotation is enabled. If the MVP uses short-lived access tokens plus reconnect/login, defer this table.

```sql
create table refresh_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index refresh_tokens_user_idx
  on refresh_tokens (user_id, expires_at desc);
```

### Tenant Sessions

```sql
create table tenant_sessions (
  id text primary key,
  user_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in ('run', 'chat', 'orchestration', 'swarm')),
  title text,
  status text not null default 'active',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index tenant_sessions_user_idx
  on tenant_sessions (user_id, created_at desc);

create index tenant_sessions_user_status_idx
  on tenant_sessions (user_id, status, updated_at desc);
```

### Tenant Run Links

```sql
create table tenant_run_links (
  run_id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  session_id text not null references tenant_sessions(id) on delete cascade,
  root_run_id uuid,
  coordinator_run_id uuid,
  kind text not null check (
    kind in ('run', 'chat', 'coordinator', 'worker', 'quality', 'synthesizer', 'child')
  ),
  created_at timestamptz not null default now()
);

create index tenant_run_links_user_session_idx
  on tenant_run_links (user_id, session_id, created_at desc);

create index tenant_run_links_root_idx
  on tenant_run_links (user_id, root_run_id);

create index tenant_run_links_coordinator_idx
  on tenant_run_links (user_id, coordinator_run_id);
```

### Gateway Session Events

The SDK/core runtime owns raw `agent_events`. The gateway should also persist a small client-facing event projection with a monotonically increasing `session_seq` per session. This keeps reconnect and browser replay independent of SDK event internals and allows one session stream to cover parent, child, worker, quality, and synthesizer runs.

```sql
create table gateway_session_events (
  id bigserial primary key,
  session_id text not null references tenant_sessions(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  run_id uuid not null,
  session_seq bigint not null,
  event_type text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique (session_id, session_seq)
);

create index gateway_session_events_replay_idx
  on gateway_session_events (user_id, session_id, session_seq asc);

create index gateway_session_events_run_idx
  on gateway_session_events (user_id, run_id, session_seq asc);
```

`session_seq` must be assigned by the gateway inside the same transaction that stores the projection row. Use a per-session counter or transactional append strategy that cannot assign duplicate sequence numbers under concurrent event delivery. Clients use `afterSeq` against this value, not against raw SDK event ids.

### Gateway Client Requests

Use this table to make `run.start` idempotent across client retries and reconnects. `client_request_id` is client-generated but scoped to one authenticated user and one operation type.

```sql
create table gateway_client_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  client_request_id text not null,
  operation text not null,
  session_id text references tenant_sessions(id) on delete set null,
  run_id uuid,
  status text not null check (status in ('started', 'completed', 'failed')),
  response jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, operation, client_request_id)
);

create index gateway_client_requests_user_idx
  on gateway_client_requests (user_id, created_at desc);
```

### Chat Messages

Use this table if the frontend needs exact transcript history independent of SDK event history.

```sql
create table chat_messages (
  id uuid primary key default gen_random_uuid(),
  session_id text not null references tenant_sessions(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content jsonb not null,
  run_id uuid,
  created_at timestamptz not null default now()
);

create index chat_messages_session_idx
  on chat_messages (user_id, session_id, created_at asc);
```

### Audit Log

```sql
create table audit_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),
  action text not null,
  session_id text,
  run_id uuid,
  ip inet,
  user_agent text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index audit_log_user_idx
  on audit_log (user_id, created_at desc);

create index audit_log_run_idx
  on audit_log (run_id, created_at desc);
```

## Data Isolation

Every operation that references `sessionId` or `runId` must first prove ownership.

Required repository methods:

```ts
async function assertSessionOwner(userId: string, sessionId: string): Promise<void>;
async function assertRunOwner(userId: string, runId: string): Promise<void>;
async function linkRunToUser(params: {
  userId: string;
  sessionId: string;
  runId: string;
  rootRunId?: string;
  coordinatorRunId?: string;
  kind: 'run' | 'chat' | 'coordinator' | 'worker' | 'quality' | 'synthesizer' | 'child';
}): Promise<void>;
async function appendGatewaySessionEvent(params: {
  userId: string;
  sessionId: string;
  runId: string;
  eventType: string;
  payload: unknown;
}): Promise<{ sessionSeq: number }>;
```

Authorization rules:

- A user can list only `tenant_sessions` where `tenant_sessions.user_id = auth.userId`.
- A user can inspect only `runId` values present in `tenant_run_links` for that `userId`.
- A user can stream only events whose `runId` is linked to that `userId`.
- A user can retry, interrupt, approve, or clarify only owned runs.
- A client-supplied `sessionId` is valid only when it already belongs to the authenticated user.
- A missing `sessionId` means the server creates a new opaque id; clients cannot choose ids for new sessions.
- Server code must ignore or reject client-supplied `userId`.
- Server code must strip or reject client metadata fields that would collide with server-owned identity, run, session, orchestration, model, tool, or approval policy fields.
- Event replay reads only `gateway_session_events` filtered by `(user_id, session_id)` and ordered by `session_seq`.

### Optional Row Level Security

MVP authorization should use explicit gateway-owned joins against `tenant_sessions`, `tenant_run_links`, and `gateway_session_events`. Do not modify SDK/core runtime tables for tenant columns in the MVP.

If runtime schema ownership and migration compatibility are settled later, RLS can be added as a defense-in-depth layer by adding `user_id` to `agent_runs` and enabling policies.

```sql
alter table agent_runs
  add column if not exists user_id uuid references users(id);

create index if not exists agent_runs_user_idx
  on agent_runs (user_id, created_at desc);

alter table agent_runs enable row level security;

create policy agent_runs_tenant_isolation on agent_runs
  using (user_id = current_setting('app.user_id', true)::uuid);
```

Each request transaction must set the tenant:

```sql
select set_config('app.user_id', $1, true);
```

Even if RLS is added later, gateway repository methods must still perform explicit ownership checks so authorization does not depend on one database feature being configured correctly.

## Authentication and Authorization Flow

Use:

- `@fastify/jwt`
- `@fastify/cookie` if refresh tokens are cookie-backed
- `@fastify/rate-limit`
- `argon2` or `bcrypt` for password hashing
- `zod` or TypeBox for message validation

### Login

1. `POST /auth/login` receives email and password.
2. Server validates password against `users.password_hash`.
3. Server issues a short-lived access JWT.
4. If refresh tokens are enabled, server issues a refresh token.
5. If refresh tokens are enabled, server stores only a hash of the refresh token.
6. Server writes an audit log entry.

Access token claims:

```ts
interface AccessTokenClaims {
  sub: string;
  email: string;
  sid?: string;
  typ: 'access';
}
```

Recommended lifetimes:

- Access token: 10 to 15 minutes.
- Refresh token, if enabled: 7 to 30 days, rotated on every refresh.

### HTTP Protection

```ts
fastify.decorate('authenticate', async (request, reply) => {
  await request.jwtVerify();
});
```

All non-public HTTP routes must use the auth hook.

### Origin and Cookie Safety

- Validate `Origin` on WebSocket upgrade and browser HTTP requests against an allowlist.
- If refresh tokens use cookies, set `HttpOnly`, `Secure`, and an appropriate `SameSite` value.
- Do not put access tokens in URLs or query strings because they are likely to leak through logs and browser history.
- If cross-site cookies are required, add CSRF protection for refresh/logout endpoints.

### WebSocket Authentication

Browser clients cannot set arbitrary `Authorization` headers during WebSocket upgrade. The default gateway path should therefore be first-message authentication:

1. Accept the socket briefly.
2. Require the first client message to be `auth`.
3. Reject all other messages until authentication succeeds.
4. Close the socket if auth does not complete within 5 seconds.

Optional non-browser clients may authenticate with `Sec-WebSocket-Protocol`, but the first-message path should remain supported for browser UX.

```json
{
  "id": "auth_1",
  "type": "auth",
  "payload": {
    "protocolVersion": 1,
    "accessToken": "eyJ..."
  }
}
```

Successful response:

```json
{
  "id": "auth_1",
  "type": "auth.ok",
  "payload": {
    "protocolVersion": 1,
    "userId": "0f8b...",
    "expiresAt": "2026-06-24T12:15:00.000Z"
  },
  "ts": "2026-06-24T12:00:00.000Z"
}
```

### Token Refresh for Long-Lived WebSockets

- Access token expiry still matters after the socket is connected.
- Track `tokenExp` on each connection.
- Send `auth.expiring` about 60 seconds before expiry when possible.
- After expiry, accept only `auth.refresh`, `ping`, and `session.unsubscribe` during a short grace period.
- Reject privileged messages after token expiry with a stable public error code.
- Client should refresh over HTTPS, then send `auth.refresh` with the new access token or reconnect.
- If refresh tokens are not enabled, close the connection after expiry/grace and require the client to reconnect with a fresh access token.
- Refresh tokens should not be sent over WS unless explicitly supported and tightly validated.

## WebSocket Protocol

All messages use an envelope with a correlation id.

```ts
interface ClientMessage<T = unknown> {
  id: string;
  type: string;
  protocolVersion?: 1;
  payload: T;
}

interface ServerMessage<T = unknown> {
  id?: string;
  type: string;
  payload: T;
  ts: string;
}
```

### Client Message Types

MVP message types:

- `auth`
- `auth.refresh` if refresh tokens are enabled; otherwise reconnect with a fresh access token
- `run.start`
- `run.interrupt`
- `history.list`
- `run.inspect`
- `session.subscribe`
- `session.unsubscribe`
- `ping`

Phased message types:

- `run.steer` (phase 2)
- `chat.start` (phase 2)
- `chat.message` (phase 2)
- `run.approval` (phase 2)
- `run.clarification` (phase 2)
- `run.retry` (phase 3)
- `run.resume` (phase 3)
- `run.recovery_options` (phase 3)
- `run.continue` (phase 3)
- `orchestration.start` (phase 4)
- `swarm.start` (future)

### Server Message Types

- `auth.ok`
- `auth.error`
- `auth.expiring`
- `run.started`
- `run.event`
- `run.result`
- `run.error`
- `run.status`
- `run.approval_required`
- `run.clarification_required`
- `session.history`
- `session.snapshot`
- `session.subscribed`
- `session.unsubscribed`
- `session.replay.started`
- `session.replay.done`
- `rate_limited`
- `server.notice`
- `error`
- `pong`

### Start Run

```json
{
  "id": "run_1",
  "type": "run.start",
  "payload": {
    "clientRequestId": "abc123",
    "agentId": "default-agent",
    "sessionId": "optional-existing-session",
    "goal": "Analyze this repository for test gaps",
    "input": {},
    "metadata": {
      "clientName": "web-dashboard"
    }
  }
}
```

`clientRequestId` is required for browser clients and must be unique per authenticated user and operation type. If the same user retries the same `clientRequestId`, the server returns the original `run.started` response instead of starting a duplicate run.

Server response:

```json
{
  "id": "run_1",
  "type": "run.started",
  "payload": {
    "sessionId": "sess_01J...",
    "runId": "8f3e...",
    "sessionSeq": 1
  },
  "ts": "2026-06-24T12:00:01.000Z"
}
```

### Stream Event

```json
{
  "type": "run.event",
  "payload": {
    "sessionId": "sess_01J...",
    "runId": "8f3e...",
    "sessionSeq": 12,
    "eventType": "tool.completed",
    "stepId": "step_2",
    "toolCallId": "call_1",
    "data": {}
  },
  "ts": "2026-06-24T12:00:04.000Z"
}
```

### Event Sequencing

`sessionSeq` is the public replay cursor. It is assigned by the gateway per `sessionId` after ownership is known and the event has been projected into `gateway_session_events`.

Rules:

- `sessionSeq` is monotonically increasing within one `sessionId`.
- `sessionSeq` is not globally meaningful across sessions.
- `afterSeq` in `session.subscribe` means "send events for this session with `sessionSeq > afterSeq`."
- `run.event` payloads should include both `sessionSeq` and raw SDK identifiers needed for debugging, but clients should store only `sessionSeq` as the replay cursor.
- Event replay must be bounded by a server-side `limit`; if more events remain, the server returns a continuation cursor.

### Terminal Result

When an SDK call reaches a terminal result, emit a compact `run.result` message. Persist a matching gateway session event so reconnecting clients can render terminal state without re-inspecting the run.

```json
{
  "type": "run.result",
  "payload": {
    "sessionId": "sess_01J...",
    "runId": "8f3e...",
    "sessionSeq": 31,
    "status": "success",
    "output": {}
  },
  "ts": "2026-06-24T12:02:04.000Z"
}
```

### Approval

```json
{
  "id": "approve_1",
  "type": "run.approval",
  "payload": {
    "runId": "8f3e...",
    "approved": true
  }
}
```

### Clarification

```json
{
  "id": "clarify_1",
  "type": "run.clarification",
  "payload": {
    "runId": "8f3e...",
    "answer": "Use the TypeScript packages only."
  }
}
```

### Error

```json
{
  "id": "run_1",
  "type": "error",
  "payload": {
    "code": "FORBIDDEN",
    "message": "Run not found or not accessible."
  },
  "ts": "2026-06-24T12:00:00.000Z"
}
```

Do not leak internal stack traces or cross-user existence information.

### Public Error Codes

Use stable public codes so clients can render predictable UI states:

- `UNAUTHENTICATED`
- `TOKEN_EXPIRED`
- `FORBIDDEN`
- `NOT_FOUND`
- `VALIDATION_ERROR`
- `UNKNOWN_MESSAGE_TYPE`
- `UNKNOWN_AGENT`
- `RATE_LIMITED`
- `RUN_START_FAILED`
- `RUN_NOT_ACTIVE`
- `INTERNAL_ERROR`

For unowned or nonexistent sessions/runs, prefer `FORBIDDEN` or a generic `NOT_FOUND` message that does not reveal cross-user existence.

## Connection Lifecycle

1. Accept WebSocket.
2. Authenticate connection.
3. Attach `userId`, `connectionId`, `tokenExp`, roles, and request metadata.
4. Register connection in a connection registry keyed by `userId`.
5. Validate every message.
6. Dispatch to a handler.
7. Check ownership before every run/session operation.
8. Stream only authorized events.
9. Send heartbeat pings.
10. On disconnect, remove connection state but do not kill runs by default.

Runs must survive socket disconnects. Clients should be able to reconnect, subscribe to a session, and replay missed events with `afterSeq`.

## Agent Execution Layer

### Runtime Service

Recommended service shape:

```ts
interface StartRunInput {
  clientRequestId: string;
  agentId: string;
  sessionId?: string;
  goal: string;
  input?: unknown;
  contentParts?: unknown[];
  context?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

class AgentRuntimeService {
  async startRun(userId: string, input: StartRunInput): Promise<{
    sessionId: string;
    runId?: string;
  }> {
    throw new Error('specification only');
  }
}
```

Responsibilities:

- Create or verify `tenant_sessions`.
- Resolve `agentId` through the server-owned allowlisted catalog.
- Create or reuse an SDK instance with Postgres runtime mode.
- Attach an event listener.
- Call the SDK directly.
- Link run ids to `userId` and `sessionId`.
- Project owned SDK events into `gateway_session_events` with `sessionSeq`.
- Track active runs by `userId` and `runId`.
- Persist terminal session status.
- Record `clientRequestId` before starting work so duplicate `run.start` messages do not create duplicate runs.

### Start Run Lifecycle

`run.start` should not wait for the full agent run to finish before responding. The gateway should:

1. Validate input and idempotency.
2. Create or verify the tenant session.
3. Start the SDK call in a managed background task.
4. Resolve `run.started` as soon as the SDK emits or persists the initial run id.
5. Link the run to the user/session before streaming any run event.
6. Continue streaming `run.event` messages until terminal result or failure.
7. Persist terminal session status and the idempotency response.

If the SDK call fails before a run id is known, return `run.error` for the original `run.start` correlation id and mark the client request failed.

### Event Handling

SDK events must pass through an ownership gate before delivery.

```ts
async function handleSdkEvent(userId: string, sessionId: string, event: AgentEvent) {
  await ensureRunLinkedOrLinkFromParent({
    userId,
    sessionId,
    runId: event.runId,
    event,
  });

  if (!(await isRunOwnedByUser(userId, event.runId))) {
    return;
  }

  const projected = await appendGatewaySessionEvent({
    userId,
    sessionId,
    runId: event.runId,
    eventType: event.type,
    payload: normalizeAgentEvent(event),
  });

  connections.sendToUserSession(userId, sessionId, {
    type: 'run.event',
    payload: {
      ...normalizeAgentEvent(event),
      sessionSeq: projected.sessionSeq,
    },
  });
}
```

### Active Run State

In-memory state must be keyed by both `userId` and run/session identifiers.

```ts
type ActiveRunKey = `${string}:${string}`;

interface ActiveRun {
  userId: string;
  sessionId: string;
  runId?: string;
  abortController?: AbortController;
  startedAt: string;
}
```

Never use a global `runId -> socket` map without also validating `userId`.

## Chat Sessions

Chat is a phase 2 feature. The MVP event, tenant, and replay model should not depend on chat being implemented.

Chat is modeled as a durable `tenant_sessions` row with `kind = 'chat'`.

For each user message:

1. Verify session ownership.
2. Persist the user message in `chat_messages`.
3. Call `sdk.chatRaw(...)` with the session id.
4. Stream SDK events.
5. Persist assistant output when the run completes.

The backend may either:

- Store and pass the accumulated transcript to `sdk.chatRaw`.
- Or rely on SDK/runtime context while maintaining a frontend transcript table.

The first option is easier to reason about for UI history.

## Orchestration and Swarm Runs

Orchestration is a phase 4 feature. It should use `createOrchestrationSdk(...).run(...)` and the same gateway session, run-link, and `sessionSeq` event projection used by single-agent runs.

Swarm-specific coordinator/worker/quality/synthesizer protocol support is a future feature unless the SDK exposes a stable swarm entrypoint. Do not design a separate runtime in the gateway.

### Orchestration Rules

- Use `sessionId` as the durable grouping key.
- Create `tenant_sessions.kind = 'orchestration'`.
- Use server-owned agent catalog entries; clients cannot submit per-node agent configs.
- Link every stage run to `tenant_run_links`.
- Stream all owned stage events to subscribers of the same `sessionId`.
- Preserve SDK orchestration metadata for traceability only; authorization still uses tenant tables.

### Swarm Terminology

Swarm execution must preserve repository terminology:

- Use `sessionId` as the durable grouping key.
- Use `coordinatorRunId` for one coordinated swarm execution.
- Do not introduce `swarmId`.
- Worker runs are independent root runs under the same `sessionId`.
- Quality and synthesizer runs are also independent root runs under the same `sessionId`.
- Agent specs remain the source of truth for model, instructions, delegates, and allowed tools.

Gateway responsibilities:

- Validate requested coordinator and worker agent ids.
- Use an allowlisted worker catalog.
- Enforce `maxWorkers`.
- Link every coordinator, worker, quality, and synthesizer run to `tenant_run_links`.
- Stream all owned run events to subscribers of the same `sessionId`.
- Preserve `metadata.orchestration.kind = 'swarm'`.
- Preserve `metadata.orchestration.coordinatorRunId`.

Example swarm request:

```json
{
  "id": "swarm_1",
  "type": "swarm.start",
  "payload": {
    "coordinatorAgentId": "research-coordinator",
    "workerAgentIds": ["repo-analyst", "test-analyst"],
    "qualityAgentId": "quality-agent",
    "synthesizerAgentId": "synthesize-agent",
    "topLevelObjective": "Analyze implementation risks for the gateway",
    "maxWorkers": 2
  }
}
```

## Run Controls

All control messages require run ownership.

### Interrupt

Flow:

1. Validate message.
2. `assertRunOwner(userId, runId)`.
3. Call `sdk.interrupt(runId)`.
4. Audit log the interrupt.
5. Stream resulting events.

### Steer

`run.steer` is a phase 2 UX feature and should be preferred over early retry/recovery work for interactive clients.

```json
{
  "id": "steer_1",
  "type": "run.steer",
  "payload": {
    "runId": "8f3e...",
    "role": "user",
    "message": "Focus on TypeScript packages first."
  }
}
```

Flow:

1. Validate message and require `role` to be `user` or `system`.
2. `assertRunOwner(userId, runId)`.
3. Call `sdk.steer(runId, { role, message })`.
4. Audit log the steer message without storing sensitive raw content unless product policy allows it.
5. Stream resulting events.

### Retry

Flow:

1. Validate message.
2. `assertRunOwner(userId, runId)`.
3. Call `sdk.retryRaw(runId)`.
4. Link continuation/retry run id to the same `userId` and `sessionId`.
5. Stream events and terminal result.

### Resume

Flow:

1. Validate message.
2. `assertRunOwner(userId, runId)`.
3. Call `sdk.resumeRaw(runId)`.
4. Stream resumed events and terminal result.

### Recovery and Continuation

Recovery and continuation are phase 3 features.

Flow:

1. Validate message.
2. `assertRunOwner(userId, fromRunId)`.
3. Call `sdk.getRecoveryOptions(fromRunId)` when the UI needs recovery choices.
4. For continuation, call `sdk.createContinuationRun(options)` or `sdk.continueRunRaw(options)`.
5. Link the new continuation run to the same `userId` and `sessionId` as the source run.
6. Stream events and terminal result.

### Approval

Flow:

1. Validate message.
2. `assertRunOwner(userId, runId)`.
3. Call `sdk.agent.resolveApproval(runId, approved)`.
4. Call `sdk.resumeRaw(runId)`.
5. Stream resumed events.

### Clarification

Flow:

1. Validate message.
2. `assertRunOwner(userId, runId)`.
3. Call `sdk.agent.resolveClarification(runId, answer)`.
4. Stream resumed events.

## HTTP API

Recommended routes:

```text
POST /auth/register
POST /auth/login
POST /auth/refresh
POST /auth/logout

GET  /api/me
GET  /api/agents
GET  /api/sessions
GET  /api/sessions/:sessionId
GET  /api/sessions/:sessionId/runs
GET  /api/sessions/:sessionId/events?afterSeq=0&limit=500
GET  /api/runs/:runId
POST /api/runs/:runId/interrupt
POST /api/runs/:runId/steer       (phase 2)
POST /api/runs/:runId/retry       (phase 3)
```

History response:

```json
{
  "sessions": [
    {
      "sessionId": "sess_01J...",
      "kind": "run",
      "status": "completed",
      "title": "Repository test gap analysis",
      "createdAt": "2026-06-24T12:00:00.000Z",
      "updatedAt": "2026-06-24T12:10:00.000Z",
      "runCount": 7
    }
  ]
}
```

Every route must filter by authenticated `userId`.

## Security Requirements

### Input Validation

- Validate all HTTP bodies, query parameters, path parameters, and WS messages.
- Enforce maximum goal length.
- Enforce maximum chat message length.
- Enforce maximum attachment count and size.
- Reject unknown message types.
- Reject unknown or disabled `agentId` values.
- Reject unknown worker agent ids.
- Reject client-supplied `userId`.
- Reject invalid `sessionId` ownership.
- Reject client-supplied agent config, model config, provider credentials, tools, delegates, workspace root, approval defaults, or runtime settings.
- Require `clientRequestId` on browser-originated `run.start` messages.

### Client Metadata Policy

Client metadata is optional and must be allowlisted. Recommended accepted fields:

- `clientRequestId`
- `clientName`
- `uiContext`
- `tags`

Reject or strip these fields even when nested under `metadata` or `context`:

- `userId`, `tenantId`, `sessionId`, `runId`, `rootRunId`, `coordinatorRunId`
- `orchestration`
- `approvalMode`, `autoApproveAll`
- `provider`, `model`, `apiKey`, `apiKeyEnv`, `baseUrl`
- `tools`, `delegates`, `workspaceRoot`, `shellCwd`

### Rate Limits

Minimum limits:

- Login attempts per IP and email.
- WS messages per connection.
- Run starts per user per minute.
- Active runs per user.
- Queued run starts per user.
- Subscribed sessions per socket.
- Event replay page size.
- Active swarms per user, when swarm support is enabled.
- Max workers per swarm, when swarm support is enabled.
- Tool calls per run, if configurable.

### Provider Credentials

- Keep server provider API keys in environment variables or a secret manager.
- Do not send provider credentials to the browser.
- If user-provided credentials are later supported, encrypt them with envelope encryption.
- Decrypt credentials only inside the execution boundary.
- Redact credentials from events, logs, errors, and audit metadata.

### Prompt Injection and Tool Abuse

- Treat model output as untrusted.
- Keep tool execution validation in core.
- Use server-side `allowedTools` and `forbiddenTools`.
- Do not allow clients to set `autoApproveAll`.
- Require approvals for high-risk tools.
- Limit filesystem tools to per-user workspace roots.
- Do not let a tool access another user's data through shared paths, shared database clients, or unscoped queries.

### Audit Events

Audit at least:

- Login success/failure.
- Refresh token rotation.
- WebSocket auth success/failure.
- Run start.
- Run interrupt.
- Run steer.
- Session subscribe/replay.
- Chat start, when chat is enabled.
- Retry, when retry is enabled.
- Approval accepted/rejected, when approvals are enabled.
- Clarification submitted, when clarification is enabled.
- Orchestration or swarm start, when those features are enabled.
- Authorization failure.
- Tool approval request.
- Terminal run failure.

## Observability

Use structured logging with `pino`. MVP observability can be logs plus a few counters; full metrics and alerting belong in production hardening.

Recommended log fields:

- `requestId`
- `connectionId`
- `userId`
- `sessionId`
- `runId`
- `rootRunId`
- `coordinatorRunId`
- `agentId`
- `eventType`
- `durationMs`
- `status`

Metrics:

MVP metrics:

- Active WebSocket connections.
- Active runs.
- Run duration.
- Event delivery lag.
- Provider errors.

Production metrics:

- Active swarms.
- Queued runs.
- Events per second.
- Token usage.
- Estimated cost.
- Approval wait time.
- Tool failures.
- Provider errors.
- Retry counts.

Alerts:

- High failed auth rate.
- Stuck running sessions.
- Expired leases.
- Rising provider errors.
- Event delivery lag.
- Database connection exhaustion.
- Per-user rate-limit spikes.

## Scalability and Deployment

### Single Instance

Acceptable for MVP:

- Fastify server.
- Postgres.
- In-memory connection registry.
- SDK Postgres runtime mode.
- Gateway event projection in Postgres.
- Idempotent `run.start` handling with `clientRequestId`.

Do not add Redis, distributed queues, or RLS solely for the single-instance MVP unless a concrete deployment requirement demands them.

### Multiple Instances

Required additions:

- Redis or Postgres pub/sub for event fanout.
- Shared job queue or lease system for long-running runs.
- Connection presence store.

Suggested event fanout:

```text
SDK event
  -> persisted agent_events
  -> gateway verifies tenant ownership
  -> gateway_session_events projection with sessionSeq
  -> publish user/session channel
  -> instance with socket receives
  -> send to client
```

### Deployment Options

- Docker container with Bun or Node.
- Fly.io for long-lived WebSockets.
- Railway for simple app plus Postgres deployment.
- Render or ECS for containerized deployment.
- Neon, Supabase, RDS, or Cloud SQL for Postgres.

Use TLS everywhere and expose only `https://` and `wss://`.

## Recovery and Reconnect

Long-running runs must not depend on a live WebSocket.

Reconnect flow:

1. Client reconnects with fresh JWT.
2. Client sends `session.subscribe` with `sessionId`, `afterSeq`, and optional `limit`.
3. Server verifies session ownership.
4. Server sends `session.replay.started`.
5. Server reads missed events from `gateway_session_events`.
6. Server streams replayed `run.event` messages in `sessionSeq` order.
7. Server sends `session.replay.done` with the last delivered `sessionSeq`.
8. Server attaches live subscription for future events.

Example:

```json
{
  "id": "sub_1",
  "type": "session.subscribe",
  "payload": {
    "sessionId": "sess_01J...",
    "afterSeq": 42,
    "limit": 500
  }
}
```

Replay markers:

```json
{
  "type": "session.replay.started",
  "payload": {
    "sessionId": "sess_01J...",
    "afterSeq": 42
  },
  "ts": "2026-06-24T12:00:00.000Z"
}
```

```json
{
  "type": "session.replay.done",
  "payload": {
    "sessionId": "sess_01J...",
    "lastSeq": 87,
    "hasMore": false,
    "live": true
  },
  "ts": "2026-06-24T12:00:01.000Z"
}
```

## Potential Challenges and Mitigations

### Long-Running WebSocket Connections

Mitigations:

- Heartbeats.
- Reconnect support.
- Event replay.
- Short-lived access tokens with refresh/re-auth.
- Run lifetime independent of socket lifetime.

### SDK Event Streaming

Mitigations:

- Normalize all SDK events into gateway envelopes.
- Persist before delivery.
- Filter every event by ownership.
- Support replay from `gateway_session_events` using `sessionSeq`.

### User Isolation Edge Cases

Mitigations:

- Link child runs by parent/root run ownership.
- Link retry and continuation runs from source run ownership.
- Link swarm workers under the same `sessionId` and `coordinatorRunId`.
- Never expose whether an unowned run exists.
- Consider RLS later as defense in depth, not as the primary MVP authorization mechanism.

### Error Handling

Mitigations:

- Stable public error codes.
- Private detailed logs.
- Audit authorization failures.
- Mark tenant sessions failed only after terminal SDK failure.
- Use recovery APIs for interrupted or crashed runs where safe.

## Implementation Phases

### Phase 1: Secure MVP

- Fastify TypeScript app.
- `@fastify/jwt`.
- `@fastify/websocket`.
- Login endpoint and short-lived access JWTs.
- Optional refresh endpoint if the product needs long-lived browser sessions in MVP.
- Browser-compatible first-message WebSocket auth.
- Server-owned agent catalog and `GET /api/agents`.
- Tenant tables: `users`, `tenant_sessions`, `tenant_run_links`, `gateway_session_events`, `gateway_client_requests`, and `audit_log`.
- Direct `createAgentSdk()` run support.
- `run.start` with `clientRequestId` idempotency.
- `run.inspect`.
- `run.interrupt`.
- `history.list`.
- `session.subscribe` and `session.unsubscribe`.
- Event projection with per-session `sessionSeq`.
- Event replay by `afterSeq` and bounded `limit`.
- User-scoped history list.
- Basic rate limits for auth, WS messages, run starts, active runs, subscribed sessions, and replay page size.
- Minimal audit logging for auth, run start, interrupt, subscribe/replay, authorization failures, and terminal failures.

### Phase 2: Chat and Interactive Controls

- Chat sessions.
- `chat_messages`.
- `chat.start`.
- `chat.message`.
- `run.steer`.
- `run.approval`.
- `run.clarification`.
- `auth.refresh` over an existing socket after HTTPS refresh.
- Replay UX markers: `session.replay.started` and `session.replay.done`.

### Phase 3: Retry and Recovery

- Ownership-checked retry.
- Recovery option inspection.
- Continuation run support.
- Source-to-continuation ownership linking.
- Better terminal state tracking.

### Phase 4: Orchestration

- `orchestration.start` using `createOrchestrationSdk(...).run(...)`.
- Server-owned orchestration agent catalog.
- Stage run linking into `tenant_run_links`.
- Session event projection for all stage runs.
- Per-user orchestration concurrency controls.
- Aggregated orchestration progress streaming.

### Future: Swarm Support

- `swarm.start`.
- Worker catalog validation.
- Coordinator, worker, quality, and synthesizer run linking.
- `sessionId` plus `coordinatorRunId` grouping.
- Per-user swarm concurrency controls.
- Aggregated swarm progress streaming.

### Phase 5: Production Hardening

- Optional RLS or tenant-aware runtime store wrappers after runtime schema compatibility is settled.
- Redis or pub/sub fanout.
- Distributed execution queue.
- Cost limits.
- Admin observability.
- Security review.
- Load testing.

## Acceptance Criteria

### MVP Acceptance Criteria

- No CLI subprocesses are used for agent execution.
- All runs and sessions are associated with exactly one authenticated user.
- No HTTP route can read or mutate another user's sessions or runs.
- No WebSocket connection can receive another user's events.
- `run.start` is idempotent by `(userId, operation, clientRequestId)`.
- `run.interrupt` enforces run ownership.
- Run history is persistent and user-scoped.
- WebSocket reconnect can replay missed events from `gateway_session_events` using `sessionSeq`.
- Access token expiry is handled for long-lived sockets.
- Inputs are schema-validated.
- Rate limits are enforced per user.
- Audit logs capture security-sensitive actions.
- Provider credentials are never exposed to the client.
- Clients cannot provide agent configs, model configs, tools, delegates, workspace roots, provider credentials, or approval defaults.

### Later-Phase Acceptance Criteria

- Chat history is persistent and user-scoped when chat is enabled.
- `run.steer`, approval, clarification, retry, resume, and continuation all enforce run ownership when enabled.
- Orchestration stage runs are linked to the same user and session when orchestration is enabled.
- Swarm worker, quality, and synthesizer runs are linked to the same user and session when swarm support is enabled.

## Implementation Notes

- Prefer Bun-native commands and TypeScript.
- Use SDK Postgres runtime mode for durable runtime state.
- Keep tenant authorization in the gateway and database layer.
- Keep core free of CLI, auth, and gateway concepts.
- Keep Agent SDK responsible for agent profile and orchestration setup.
- Preserve terminology: `run`, `sessionId`, `coordinatorRunId`, `top-level objective`, `subObjective`, `worker run`, `quality run`, `synthesizer run`, `child run`, `plan`, `plan execution`, `delegate profile`, and `replan.required`.
