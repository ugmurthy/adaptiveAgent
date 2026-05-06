# @adaptive-agent/gateway-fastify

A Bun + Fastify WebSocket gateway for AdaptiveAgent with deterministic routing, gateway-owned sessions, run orchestration, channel fanout, hooks, and scheduled ingress.

## Quick Start

```bash
# Install dependencies
bun install

# Build
bun run build

# Run tests
bun test

# Typecheck
bun run typecheck

# Run Docker-backed Postgres restart integration tests
bun run test:postgres-integration
```

## Local Development

### Storage Backends

The gateway supports three storage backends:

| Backend | Use case | Config / Factory |
| ------- | -------- | ---------------- |
| In-memory | Tests, prototyping | `stores.kind: "memory"` or `createInMemoryGatewayStores()` |
| File-backed | Local dev | `stores.kind: "file"` or `createFileGatewayStores({ baseDir })` |
| PostgreSQL | Restart-safe gateway + runtime durability | `stores.kind: "postgres"` or `bootstrapGateway({ postgresClient })` |

```ts
import { bootstrapGateway, createFileGatewayStores } from '@adaptive-agent/gateway-fastify';

// In-memory (default)
const gw = await bootstrapGateway();

// File-backed (survives restarts)
const gw = await bootstrapGateway({
  stores: createFileGatewayStores({ baseDir: './data/gateway' }),
});
```

`memory` is convenient, but it is not restart-safe. A gateway restart loses sessions, transcripts, session-run links, cron state, and all core runtime run state.

`file` only makes the gateway-owned stores durable. It preserves sessions and transcripts, but it does not make core runtime state durable, so completed run outputs, retry snapshots, leases, and resumability still disappear on restart.

Use `postgres` when you need reconnect, retry, resume, and terminal run replay to survive a gateway restart.

### PostgreSQL Setup

Configure the gateway with a Postgres-backed store bundle:

```json
{
  "stores": {
    "kind": "postgres",
    "urlEnv": "DATABASE_URL",
    "ssl": false
  }
}
```

You can also inline a connection string with `stores.connectionString`, but `DATABASE_URL` is the normal path.

When `stores.kind` is `postgres`, `bootstrapGateway()` applies the packaged migrations by default before constructing stores:

- `packages/gateway-fastify/migrations/001_gateway_postgres.sql`
- `packages/core/migrations/001_runtime_postgres.sql`

Those migrations create both the gateway-owned tables and the core runtime durability tables. Set `stores.autoMigrate: false` if you want to manage those SQL files externally.

If you provide a custom `agentFactory` while using `stores.kind: "postgres"`, the bootstrap path passes the shared durable runtime bundle on `entry.runtime`. The custom factory must use that runtime bundle if you want restart-safe run recovery.

For an end-to-end restart check against a real Docker Postgres instance, run `bun run test:postgres-integration` from `packages/gateway-fastify`.

### Starting the Server

```ts
import { startGateway } from '@adaptive-agent/gateway-fastify';

const gateway = await startGateway({
  gatewayConfigPath: 'config/gateway.json',
  agentConfigDir: 'config/agents',
});
// Listening on http://{host}:{port}
```

### Managed Local Launcher

This package also includes a Bun launcher that creates the requested local config and file-backed store directories under `~/.adaptiveAgent`, then starts the gateway on port `8959`.

From the repository root:

```bash
bun run gateway:start
```

From `packages/gateway-fastify/`:

```bash
bun run start:local
```

Mint a matching local dev JWT:

```bash
bun run gateway:mint-jwt
bun run gateway:mint-jwt --sub alice --tenant acme --role admin
```

Run the local WebSocket client:

```bash
bun run gateway:ws-client
bun run gateway:ws-client --message "Hello there"
bun run gateway:ws-client --run "Summarize this repository"
```

The launcher uses these paths:

- gateway store base dir: `~/.adaptiveAgent/data/gateway`
- file tool root: `~/.adaptiveAgent/artifacts`
- gateway config: `~/.adaptiveAgent/config/gateway.json`
- agent config dir: `~/.adaptiveAgent/agents`
- default agent config: `~/.adaptiveAgent/agents/default-agent.json`
- log agent config: `~/.adaptiveAgent/agents/log-agent.json`

The generated default agent uses:

- `provider: "mesh"`
- `model: "qwen/qwen3.5-27b"`
- `apiKey: process.env.MESH_API_KEY` at generation time
- `systemInstructions: "You are a helpful assistant and you names is adaptiveAgent "`
- built-in local tools rooted at `~/.adaptiveAgent/artifacts`: `read_file`, `list_directory`, `write_file`, `shell_exec`, `web_search`, `read_web_page`
- delegate loading from `~/.adaptiveAgent/gateway/skills`
- gateway auth provider `jwt` with `secret: process.env.GATEWAY_JWT_SECRET ?? "adaptive-agent-local-dev-secret"`

The launcher also creates a `log-agent` by copying the default agent shape, setting `workspaceRoot` to `$HOME/.adaptiveAgent`, and enabling the built-in local tools for that agent. Agent `workspaceRoot` values expand environment variables such as `$HOME` and `${HOME}` when the agent is materialized. That makes `read_file`, `list_directory`, `write_file`, and `shell_exec` default to the adaptive-agent home while leaving the default agent rooted at `~/.adaptiveAgent/artifacts`.

The JWT helper reads `auth.secret`, `auth.issuer`, `auth.audience`, `auth.tenantIdClaim`, and `auth.rolesClaim` from the local gateway config when present, so minted tokens stay aligned with your local auth configuration.

The WebSocket client auto-mints a matching local JWT unless you pass `--token`, connects with Bun's WebSocket client using an `Authorization: Bearer ...` header, opens a chat session, and supports an interactive prompt with `/run`, `/retry`, `/approve`, `/clarify`, `/events on|off`, `/ping`, `/session`, and `/exit`. Realtime `agent.event` frames are shown by default in interactive mode, and `/events off` hides them until you re-enable them. Interactive `/run` commands use a separate dedicated run session so chat and structured-run traffic do not collide with the gateway's session mode pinning.

The launcher updates an existing gateway config when the auth block is missing, and it also flattens older `auth.settings`-style configs into the runtime shape the code actually reads.

---

## Gateway Config

File: `config/gateway.json`

```json
{
  "server": {
    "host": "0.0.0.0",
    "port": 3000,
    "websocketPath": "/ws",
    "healthPath": "/health",
    "requestLogger": false,
    "requestLogging": "info",
    "requestLoggingDestination": "both"
  },
  "stores": {
    "kind": "postgres",
    "urlEnv": "DATABASE_URL",
    "ssl": false
  },
  "agentRuntimeLogging": {
    "enabled": true,
    "level": "info",
    "destination": "file"
  },
  "auth": {
    "provider": "jwt",
    "secret": "your-jwt-secret",
    "issuer": "https://auth.example.com",
    "audience": "adaptive-agent-gateway",
    "tenantIdClaim": "tenantId",
    "rolesClaim": "roles"
  },
  "cron": {
    "enabled": true,
    "schedulerLeaseMs": 60000,
    "maxConcurrentJobs": 5
  },
  "concurrency": {
    "maxActiveRuns": 16,
    "maxActiveRunsPerTenant": 8,
    "maxActiveRunsPerAgent": 8,
    "runAdmissionLeaseMs": 1800000
  },
  "transcript": {
    "recentMessageWindow": 20,
    "summaryTriggerWindow": 40,
    "summaryMaxMessages": 100,
    "summaryLineMaxLength": 200
  },
  "channels": {
    "defaults": { "sessionConcurrency": 1 },
    "list": [
      { "id": "web", "name": "Web Chat" },
      { "id": "api", "name": "API Channel", "allowedInvocationModes": ["run"] },
      { "id": "public", "name": "Public", "isPublic": true }
    ]
  },
  "bindings": [
    { "match": { "channelId": "web" }, "agentId": "support-agent" },
    { "match": { "tenantId": "acme" }, "agentId": "acme-agent" },
    { "match": { "roles": ["admin"] }, "agentId": "admin-agent" }
  ],
  "defaultAgentId": "general-agent",
  "hooks": {
    "failurePolicy": "warn",
    "modules": [],
    "onAuthenticate": [],
    "onSessionResolve": [],
    "beforeRoute": [],
    "beforeInboundMessage": [],
    "beforeRunStart": [],
    "afterRunResult": [],
    "onAgentEvent": [],
    "beforeOutboundFrame": [],
    "onDisconnect": [],
    "onError": []
  }
}
```

### Config Fields

| Field | Required | Description |
| ----- | -------- | ----------- |
| `server.host` | Yes | Bind address |
| `server.port` | Yes | Listen port |
| `server.websocketPath` | Yes | WebSocket upgrade path (must start with `/`) |
| `server.healthPath` | No | HTTP health endpoint path |
| `server.requestLogger` | No | Enable HTTP request/response logs; defaults to `false` |
| `server.requestLogging` | No | Request log level: `debug`, `info`, `warn`, or `silent`; `true` maps to `info` and `false` maps to `silent` for backward compatibility |
| `server.requestLoggingDestination` | No | Request log sink: `console`, `file`, or `both`; defaults to `console` when request logging is enabled |
| `stores.kind` | No | Storage backend: `memory`, `file`, or `postgres`; defaults to `memory` |
| `stores.baseDir` | No | Required when `stores.kind` is `file` |
| `stores.urlEnv` | No | Environment variable to read for the Postgres connection string; defaults to `DATABASE_URL` |
| `stores.connectionString` | No | Inline Postgres connection string override |
| `stores.ssl` | No | Enable Postgres SSL client mode |
| `stores.autoMigrate` | No | Disable bootstrap auto-migration when `false` |
| `agentRuntimeLogging.enabled` | No | Pass a core AdaptiveAgent logger into runtime agent instances |
| `agentRuntimeLogging.level` | No | Runtime log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal`, or `silent`; defaults to `info` when enabled |
| `agentRuntimeLogging.destination` | No | Runtime log sink: `console`, `file`, or `both`; defaults to `file` when enabled |
| `agentRuntimeLogging.filePath` | No | Runtime log base path for file logging; defaults to `data/gateway/logs/agent-runtime.log` |
| `auth.provider` | No | Auth provider name (e.g., `jwt`) |
| `auth.secret` | No | Shared JWT secret for the built-in `jwt` auth provider |
| `auth.issuer` | No | Expected JWT issuer |
| `auth.audience` | No | Expected JWT audience |
| `auth.tenantIdClaim` | No | Claim name used for tenant routing; defaults to `tenantId` |
| `auth.rolesClaim` | No | Claim name used for roles; defaults to `roles` |
| `cron.enabled` | No | Enable the scheduler loop |
| `cron.schedulerLeaseMs` | No | Lease duration for cron claiming |
| `cron.maxConcurrentJobs` | No | Max concurrent cron dispatches |
| `concurrency.maxActiveRuns` | No | Gateway-wide limit for active independent root runs; defaults to `16` |
| `concurrency.maxActiveRunsPerTenant` | No | Active root-run limit for one tenant; defaults to `8` |
| `concurrency.maxActiveRunsPerAgent` | No | Active root-run limit for one agent; defaults to `8` |
| `concurrency.runAdmissionLeaseMs` | No | Admission lease duration for active-run accounting; defaults to `1800000` |
| `transcript` | No | Transcript replay policy overrides |
| `channels.list[]` | No | Named channel definitions |
| `bindings[]` | No | Routing bindings (channel, tenant, roles → agentId) |
| `defaultAgentId` | No | Fallback agent when no binding matches |
| `hooks` | Yes | Hook slot configuration |

Set `server.requestLogger` to `true` to enable HTTP request/response logs. When it is omitted or `false`, the gateway skips the HTTP `onRequest` and `onResponse` log entries.

`server.requestLogger` only affects HTTP request/response entries. It does not change whether other gateway transport logs, such as WebSocket frame logs, are emitted; those still follow `server.requestLogging`.

When `server.requestLogger` is `true` and `server.requestLogging` is `debug`, the gateway emits debug, info, warn, and error request logs. `info` emits info, warn, and error logs. `warn` emits warn and error logs. `silent` disables gateway request logging entirely.

When `server.requestLoggingDestination` is `file` or `both`, the gateway writes newline-delimited JSON logs to `data/gateway/logs/gateway-YYYY-MM-DD.log` relative to the current working directory by default. The local `gateway:start` launcher writes these logs under `~/.adaptiveAgent/data/gateway/logs`.

When `agentRuntimeLogging.destination` is `file` or `both`, the gateway passes `data/gateway/logs/agent-runtime.log` to the core AdaptiveAgent logger by default. The local `gateway:start` launcher uses `~/.adaptiveAgent/data/gateway/logs/agent-runtime.log`. The core logger applies its date and numbered rotation convention, so the resulting files are named `agent-runtime-YYYY-MM-DD.log`, `agent-runtime-YYYY-MM-DD-2.log`, and so on.

`stores.kind: "postgres"` is the only built-in mode that makes both gateway state and core runtime state durable across restarts. `stores.kind: "file"` is still useful for local single-node development, but it is not full run recovery.

---

## Agent Config

File: `config/agents/<agent-id>.json`

```json
{
  "id": "support-agent",
  "name": "Support Agent",
  "invocationModes": ["chat", "run"],
  "defaultInvocationMode": "chat",
  "model": {
    "provider": "openrouter",
    "model": "anthropic/claude-sonnet-4-20250514",
    "apiKey": "${OPENROUTER_API_KEY}"
  },
  "systemInstructions": "You are a helpful support agent.",
  "tools": ["search", "create-ticket"],
  "delegates": [],
  "defaults": {
    "maxSteps": 10,
    "toolTimeoutMs": 30000
  },
  "routing": {
    "allowedChannels": ["web"],
    "requiredRoles": ["member"]
  }
}
```

### Manager Agents And Delegates

Gateway bindings route a session or isolated run to one root agent. That root agent can act as a manager by declaring `systemInstructions` and a list of delegate names:

```json
{
  "id": "strategy-manager",
  "name": "Strategy Manager",
  "invocationModes": ["run"],
  "defaultInvocationMode": "run",
  "model": {
    "provider": "openrouter",
    "model": "anthropic/claude-sonnet-4-20250514"
  },
  "systemInstructions": "You are a strategy manager. Delegate evidence gathering to delegate.researcher, delegate file inspection to delegate.file-analyst when useful, and synthesize the final answer yourself.",
  "tools": ["read_file", "list_directory"],
  "delegates": ["researcher", "file-analyst"]
}
```

The gateway still routes only to `strategy-manager`. The listed delegates are resolved from the module registry and exposed inside the selected AdaptiveAgent as synthetic tools such as `delegate.researcher` and `delegate.file-analyst`. Delegate calls create child runs under the same `rootRunId`; they do not trigger a second gateway route, binding match, or `beforeRunStart` hook.

Root-agent `systemInstructions` should describe when to delegate and who owns the final answer. Delegate instructions should describe the specialist behavior and bounded tool scope for the child run.

For local gateway startup, installed skills are discovered from `~/.adaptiveAgent/gateway/skills`. The repository's `examples/skills` directory is for demos and tests and is not trusted by the gateway by default. An installed skill appearing in the launcher output only means the gateway detected it; an agent still needs to list that delegate name in its own `delegates` array before `delegate.<name>` is exposed to that agent. Skill model overrides must use environment-backed credentials such as `model.apiKeyEnv: MESH_API_KEY`; inline `model.apiKey` values are rejected.

### Agent Config Fields

| Field | Required | Description |
| ----- | -------- | ----------- |
| `id` | Yes | Stable agent identifier |
| `name` | Yes | Human-readable name |
| `invocationModes` | Yes | Supported modes: `chat`, `run` |
| `defaultInvocationMode` | Yes | Default when not specified |
| `model` | Yes | Model adapter configuration |
| `model.provider` | Yes | One of: `openrouter`, `ollama`, `mistral`, `mesh` |
| `model.model` | Yes | Model identifier |
| `systemInstructions` | No | System prompt for the root agent; for manager agents this should describe delegation strategy and final-answer ownership |
| `tools` | Yes | Tool names (resolved via module registry) |
| `delegates` | Yes | Delegate names resolved via module registry and exposed to this root agent as `delegate.*` tools |
| `defaults` | No | Runtime defaults (maxSteps, timeouts, etc.) |
| `routing` | No | Channel, tenant, and role constraints |

---

## WebSocket Protocol

### Connection

Connect via WebSocket to the configured `websocketPath`. Authentication is performed on upgrade:

```
GET /ws?channelId=web
Authorization: Bearer <jwt-token>
```

Public channels (configured with `isPublic: true`) skip JWT validation.

### Inbound Frames (Client → Gateway)

All frames are JSON objects with a `type` field.

#### `session.open`

Create or reattach a session.

```json
{ "type": "session.open", "channelId": "web" }
{ "type": "session.open", "channelId": "web", "sessionId": "existing-id" }
```

#### `message.send`

Send a chat message through the routed agent.

```json
{ "type": "message.send", "sessionId": "s-1", "content": "Hello" }
```

#### `run.start`

Start a structured run (session-bound or isolated).

```json
{ "type": "run.start", "sessionId": "s-1", "goal": "Summarize data" }
{ "type": "run.start", "goal": "Process batch", "input": { "ids": [1, 2, 3] } }
```

#### `run.retry`

Retry a failed session-bound structured run from its latest persisted snapshot. This is run-session only.

```json
{ "type": "run.retry", "sessionId": "s-1", "runId": "r-1" }
```

#### `approval.resolve`

Approve or reject a paused run.

```json
{ "type": "approval.resolve", "sessionId": "s-1", "runId": "r-1", "approved": true }
```

#### `clarification.resolve`

Provide clarification text back to a session-bound structured run that previously asked a question.

```json
{ "type": "clarification.resolve", "sessionId": "s-1", "runId": "r-1", "message": "Use markdown output." }
```

#### `channel.subscribe`

Subscribe to event channels. Format: `scope:id`.

```json
{ "type": "channel.subscribe", "channels": ["session:s-1", "agent:support-agent"] }
```

Supported scopes: `session`, `run`, `root-run`, `agent`.

When a connection has one or more active subscriptions, realtime `agent.event` delivery is filtered to matching subscriptions only. Reconnect automatically restores the relevant subscriptions for the reattached session.

#### `session.close`

```json
{ "type": "session.close", "sessionId": "s-1" }
```

#### `ping`

```json
{ "type": "ping", "id": "p-1" }
```

### Outbound Frames (Gateway → Client)

#### `session.opened`

```json
{ "type": "session.opened", "sessionId": "s-1", "channelId": "web", "agentId": "support-agent", "status": "idle" }
```

#### `session.updated`

```json
{ "type": "session.updated", "sessionId": "s-1", "status": "running", "transcriptVersion": 5, "activeRunId": "r-1", "activeRootRunId": "r-1" }
```

#### `message.output`

```json
{ "type": "message.output", "sessionId": "s-1", "runId": "r-1", "rootRunId": "r-1", "message": { "role": "assistant", "content": "Hello! How can I help?" } }
```

#### `run.output`

```json
{ "type": "run.output", "runId": "r-1", "rootRunId": "r-1", "sessionId": "s-1", "status": "succeeded", "output": { "result": "done" } }
```

#### `approval.requested`

```json
{ "type": "approval.requested", "runId": "r-1", "rootRunId": "r-1", "sessionId": "s-1", "toolName": "delete-user", "reason": "This tool requires approval" }
```

#### `agent.event`

Bridged runtime events. Event types: `run.created`, `run.status_changed`, `run.retry_started`, `tool.started`, `tool.completed`, `delegate.spawned`, `approval.requested`, `approval.resolved`, `run.completed`, `run.failed`, `snapshot.created`.

```json
{ "type": "agent.event", "eventType": "tool.completed", "data": { "toolName": "search" }, "sessionId": "s-1", "runId": "r-1", "rootRunId": "r-1" }
```

#### `error`

```json
{ "type": "error", "code": "session_busy", "message": "Session already has an active run", "requestType": "message.send" }
```

Error codes: `invalid_json`, `invalid_frame`, `unknown_frame_type`, `unsupported_frame`, `auth_required`, `invalid_token`, `token_expired`, `session_not_found`, `session_forbidden`, `session_busy`, `approval_required`, `gateway_overloaded`, `route_not_found`, `run_failed`.

#### `pong`

```json
{ "type": "pong", "id": "p-1" }
```

---

## Routing

The gateway resolves agents deterministically without model involvement:

1. **Session pin** — if the session already has an `agentId`, reuse it
2. **Bindings** — evaluate `channelId` → `tenantId` → `roles` in specificity order; ties broken by config order
3. **Default** — fall back to `defaultAgentId`

Normal chat traffic cannot override routing by supplying `agentId` directly. Only `run.start` allows explicit agent targeting for isolated runs.

---

## Session Concurrency

- One active root run per session at a time
- `message.send` and `run.start` are rejected while a session is `running` (error code: `session_busy`)
- Only `approval.resolve` is accepted while a session is `awaiting_approval`
- Multiple same-principal connections can observe the same session
- Independent sessions can run at the same time, subject to gateway admission limits

`channels.defaults.sessionConcurrency` is currently `1` in the gateway contract. To run multiple jobs in parallel, open or use separate sessions, or send isolated `run.start` frames without a `sessionId`.

## Run Admission And Parallel Runs

The gateway now admits independent root runs through `runAdmissions`. This is separate from v1.4 child-run delegation: a manager agent may still have only one active child run per parent, but the gateway can run multiple independent root runs across sessions, tenants, and agents.

Defaults:

- `concurrency.maxActiveRuns`: `16`
- `concurrency.maxActiveRunsPerTenant`: `8`
- `concurrency.maxActiveRunsPerAgent`: `8`
- `concurrency.runAdmissionLeaseMs`: `1800000` ms

Set these in `gateway.json` under `concurrency`. A run must pass all configured limits before it starts. If a session-bound `run.start`, `message.send`, `run.retry`, `approval.resolve`, or `clarification.resolve` cannot get admission, the session is restored to its previous state. If an isolated `run.start` cannot get admission, no session state is changed.

Be careful about:

- provider and model rate limits, which can be lower than gateway limits
- CPU, memory, file-tool, shell-tool, and database pressure from many runs at once
- per-session state: one session remains a serial lane, so use distinct sessions for parallel work
- stuck processes: expired admission leases stop stale rows from permanently blocking new work, but long-running jobs should still release admission in `finally`
- tenant fairness: `maxActiveRunsPerTenant` only applies when auth provides a `tenantId`

When a limit is exceeded, the client receives an `error` frame with `code: "gateway_overloaded"`. The error details include:

```json
{
  "limit": "maxActiveRunsPerAgent",
  "activeCount": 8,
  "configuredLimit": 8,
  "agentId": "support-agent",
  "tenantId": "acme",
  "sessionId": "s-1"
}
```

Use the status endpoint to see how many runs are active:

```bash
bun run --cwd packages/gateway-fastify status
```

The `/status` response includes `activeRuns.total`, `activeRuns.byAgent`, and `activeRuns.byTenant`. The endpoint requires an authenticated principal with the `admin` role.

---

## Scheduler (Cron)

The scheduler polls for due cron jobs and dispatches them through the same orchestrator as live WebSocket traffic.

### Target Kinds

| Kind | Behavior |
| ---- | -------- |
| `session_event` | Sends a chat message to an existing session |
| `isolated_run` | Executes `agent.run()` without session state |
| `isolated_chat` | Creates a fresh session and sends a chat message |

### Delivery Modes

| Mode | Behavior |
| ---- | -------- |
| `none` | No delivery (fire-and-forget) |
| `session` | Appends a system transcript message to the target session |
| `announce` | Channel-scoped announcement (requires `delivery.channelId`) |
| `webhook` | HTTP POST to `delivery.url` with a `cron.completed` payload |

### Approval Policy

Cron executions that reach an approval state are marked `needs_review` instead of blocking indefinitely. They will not auto-approve or auto-reject.

---

## Reconnect

When a client reconnects to an existing session via `session.open` with a `sessionId`:

- The gateway returns `session.opened`, then a follow-up `session.updated`, with the current state
- Active run linkage (`activeRunId`, `activeRootRunId`) is preserved
- Pending approval sessions surface their outstanding run state
- The client is auto-subscribed to relevant channels (`session:`, `run:`, `root-run:`, `agent:`)
- A fresh valid JWT is required; expired authorization is not reused

---

## Hooks

The gateway supports lifecycle hooks for extensibility:

| Slot | Timing | Can reject? |
| ---- | ------ | ----------- |
| `onAuthenticate` | After JWT validation | Yes |
| `onSessionResolve` | After session lookup | Yes |
| `beforeRoute` | Before agent routing | Yes |
| `beforeInboundMessage` | Before chat turn | Yes |
| `beforeRunStart` | Before structured run | Yes |
| `afterRunResult` | After run completes | No |
| `onAgentEvent` | On runtime event bridge | No |
| `beforeOutboundFrame` | Before frame delivery | Yes |
| `onDisconnect` | On socket close | No |
| `onError` | On unhandled error | No |

These hook slots are executed in the live gateway path: upgrade authentication, session resolution and reconnect, chat and structured-run dispatch, realtime event forwarding, outbound frame delivery, disconnect handling, and unhandled error reporting.

Hook failure policy (`fail`, `warn`, `ignore`) controls whether hook errors abort the request, log a warning, or are silently ignored.

---

## Health & Observability

When `server.healthPath` is configured, the gateway exposes a health endpoint:

```
GET /health
```

```json
{
  "state": "healthy",
  "startedAt": "2026-01-01T00:00:00.000Z",
  "checkedAt": "2026-01-01T00:05:00.000Z",
  "websocketPath": "/ws",
  "agents": 3,
  "stores": { "kind": "postgres", "available": true },
  "scheduler": { "enabled": true, "running": true },
  "errors": []
}
```

Health states: `healthy`, `startup_failed`, `degraded`.

### Metrics

Tracked counters: `sessionsCreated`, `sessionsReattached`, `activeRuns`, `chatTurns`, `structuredRuns`, `approvalResolutions`, `authFailures`, `routingMisses`, `cronClaims`, `cronFailures`, `hookFailures`, `protocolErrors`.

### Structured Logs

All operational events are emitted as JSON log entries with `level`, `event`, `message`, `timestamp`, and optional `data`. Event categories cover auth, sessions, routing, chat, runs, approvals, hooks, cron, and protocol errors.

### Log Analysis

Use the Bun-native analyzer to summarize gateway and agent runtime logs:

```bash
bun run logs:analyze
bun run logs:analyze --since 1h
bun run logs:analyze --session-id sess-123
bun run logs:analyze --run-id run-123
bun run logs:analyze --details
bun run logs:analyze --watch
```

From the repository root:

```bash
bun run gateway:logs:analyze --since 1h
```

### CLI Bins

The package exposes Bun-backed command bins for the local WebSocket client, TUI client, and trace-session reporter:

```bash
cd packages/gateway-fastify
bun link

adaptive-agent-tui --help
adaptive-agent-ws-client --help
adaptive-agent-trace-session --help
```

Short aliases are also available as `gateway-ws-client`, `gateway-tui`, and `trace-session`.
After `bun link`, these commands can be run from any working directory because the bin shims point back to the package entry files.

By default, the analyzer reads `~/.adaptiveAgent/data/gateway/logs` and combines `gateway-YYYY-MM-DD.log` with rotated `agent-runtime-YYYY-MM-DD.log` files. Use `--dir <path>` or repeated `--file <path>` flags for copied logs or CI artifacts.

The default report is compact: window, files, activity totals, failure summary, repeated patterns, and the top insights. Add `--details` for full sections and timelines. Add `--session-id`, `--run-id`, or `--root-run-id` to investigate one conversation or run chain; focused investigations automatically include the detailed timeline. Add `--json` for machine-readable output.

Human-readable times are rendered in local timezone as `HH:MM:SS`. Use `--timezone Asia/Kolkata` or another IANA timezone to override display timezone.

When request logging is enabled, the gateway emits explicit lifecycle events: `gateway.server.started`, `gateway.server.stopping`, and `gateway.server.stopped`. Each includes a `bootId`, `pid`, and server metadata. The analyzer uses only these lifecycle events to report server starts/stops and session outcomes within each boot window; it does not infer restarts from quiet log gaps.

---

## Project Structure

```
packages/gateway-fastify/src/
├── index.ts                  # Package entrypoint (re-exports)
├── bootstrap.ts              # Gateway bootstrap and startup
├── server.ts                 # Fastify WebSocket server
├── config.ts                 # Gateway and agent config schemas
├── protocol.ts               # WebSocket frame types and validation
├── auth.ts                   # JWT upgrade authentication
├── session.ts                # Session open, reattach, and write guards
├── routing.ts                # Deterministic bindings router
├── chat.ts                   # message.send orchestration
├── run.ts                    # run.start and approval.resolve orchestration
├── transcript.ts             # Transcript replay and summary
├── channels.ts               # Channel subscriptions and event bridge
├── outbound.ts               # Outbound authorization and redaction
├── hooks.ts                  # Lifecycle hook execution
├── reconnect.ts              # Reconnect session recovery
├── scheduler.ts              # Cron scheduler loop and dispatch
├── cron-delivery.ts          # Cron delivery modes
├── observability.ts          # Health, metrics, and structured logs
├── registries.ts             # Tool, delegate, hook, and auth registries
├── agent-registry.ts         # Lazy agent registry
├── core.ts                   # Core runtime bridge types
├── stores.ts                 # Store interfaces and in-memory implementations
├── stores-file.ts            # File-backed stores
├── stores-postgres.ts        # PostgreSQL session/transcript stores
├── stores-postgres-cron.ts   # PostgreSQL cron stores with lease claiming
└── errors.ts                 # Shared error types
```
