# Proposal: AdaptiveAgent WebSocket Gateway

## Overview

Build a Bun + Fastify gateway that exposes AdaptiveAgent instances over WebSockets with authenticated session management, deterministic agent routing, gateway hooks, and channel-based event delivery.

The key design choice is to keep `session` as a gateway-owned host artifact rather than a new runtime primitive inside `@adaptive-agent/core`.

The gateway should support both primary AdaptiveAgent invocation styles:

- `agent.chat(...)` for transcript-oriented conversational sessions
- `agent.run(...)` for structured tasks, commands, and scheduled executions

That preserves the v1.4 boundary already documented in this repository:

- `run` remains the core execution unit
- `rootRunId` remains the root of a single run tree
- child runs remain normal delegated runs created through synthetic `delegate.*` tools
- the gateway wraps one or more root runs inside a longer-lived session

## Goals

- Expose AdaptiveAgent over authenticated WebSocket connections using Fastify on Bun.
- Route inbound messages to the correct configured agent using deterministic host rules, similar to OpenClaw bindings.
- Introduce a first-class gateway `session` artifact that groups multiple root runs over time.
- Support both conversational `chat()` invocations and structured `run()` invocations at the gateway layer.
- Support event channels so clients can subscribe to session, run, and agent activity.
- Provide gateway hooks for auth, session resolution, inbound message processing, run lifecycle, and outbound delivery.
- Load agent definitions from JSON config files with stable `id` and `name` fields.

## Non-Goals

- No change to the core `AdaptiveAgent` contract to make `session` a runtime primitive.
- No parallel child runs beyond the existing v1.4 single-active-child rule.
- No persistent client-to-child-run interactive protocol; child runs should stay non-interactive.
- No attempt to make the model choose routing or agent identity.

## Recommended Design Principles

### 1. Keep Session Above The Runtime

`AdaptiveAgent.chat()` currently creates a new root run for each turn. Because of that, the clean boundary is:

- gateway session = durable conversation container
- root run = one agent turn or resumed approval flow
- child runs = delegated work within that root run

This means a session can own many root runs:

- turn 1 -> `rootRunId = R1`
- turn 2 -> `rootRunId = R2`
- turn 3 -> `rootRunId = R3`

If a run pauses for approval, the session keeps the pending `runId` and resumes that same run instead of creating a new root run.

The gateway should not force every agent into the same invocation style. Some agents should be chat-first, some run-first, and some should allow both.

### 2. Deterministic Routing

Like OpenClaw, routing should be decided by host configuration, not by the model.

The gateway should resolve an inbound message in this order:

1. authenticate connection
2. resolve or create session
3. resolve routing binding
4. select agent config
5. dispatch to that agent

### 3. Channels Are Delivery Topics, Not Agent State

Channels should be the gateway's fanout mechanism for observability and message delivery.

Recommended logical channels:

- `session:<sessionId>`
- `run:<runId>`
- `root-run:<rootRunId>`
- `agent:<agentId>`
- `tenant:<tenantId>` if multi-tenant support is needed

### 4. JSON Config For Agents, Code Modules For Behavior

Agent identity and static configuration should live in JSON files.

Dynamic behavior that cannot be expressed in JSON should be referenced by stable module IDs:

- tools
- hook handlers
- auth adapters
- optional prompt builders

## Proposed Architecture

## Packages

- `packages/gateway-fastify` - Fastify server, WebSocket protocol, auth, routing, hooks, channel fanout
- `packages/core` - existing runtime used as-is
- `packages/store-postgres` - existing planned store package plus gateway session tables

## Gateway Components

### Fastify Server

- Bun runtime
- Fastify HTTP server
- `@fastify/websocket` for bidirectional transport
- optional HTTP health and admin endpoints

### Auth Layer

- authenticates before session creation
- attaches `authContext` to the connection
- supports policy checks during routing and hook execution

Selected MVP auth shape:

- JWT bearer token during WebSocket upgrade
- normalized auth context: `subject`, `tenantId`, `roles`, `claims`
- reconnects are allowed for the same principal by presenting a fresh valid JWT

### Session Manager

Owns the host-level `session` artifact.

Suggested session fields:

```ts
interface GatewaySession {
  id: string;
  agentId: string;
  channelId: string;
  tenantId?: string;
  authSubject: string;
  status: 'idle' | 'running' | 'awaiting_approval' | 'closed' | 'failed';
  currentRunId?: string;
  currentRootRunId?: string;
  lastCompletedRootRunId?: string;
  transcriptVersion: number;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
```

Responsibilities:

- create or look up sessions
- keep session transcript/history
- map active run state to the session
- prevent concurrent turns on the same session
- allow multiple live connections for the same authenticated principal
- resume paused runs when approval is resolved

### Agent Registry

Loads agent configs from JSON files and materializes `AdaptiveAgent` instances.

Recommended model:

- one immutable config object per agent id
- lazy instantiate agent runtime on first use
- optionally cache model adapter and tool wiring
- hot-reload only if explicitly enabled
- include invocation capabilities so the gateway knows whether an agent supports `chat`, `run`, or both

### Router / Bindings Engine

Determines which agent handles a message.

Recommended matching inputs:

- WebSocket path or namespace
- declared client channel
- tenant id
- auth roles or claims
- explicit `agentId` if allowed
- session metadata

Recommended priority order:

1. explicit session pin to an existing `agentId`
2. exact binding on channel + tenant + auth attributes
3. channel-level default
4. gateway default agent

### Run Orchestrator

Bridge between the gateway session layer and `AdaptiveAgent`.

Recommended invocation model:

- `chat` mode for transcript-oriented user conversations
- `run` mode for structured task execution, commands, and most cron jobs
- each session should be pinned to an invocation mode once created unless the host intentionally creates a separate session or endpoint for the other mode

For a chat turn:

1. load session transcript
2. append inbound user message
3. call `agent.chat({ messages, context, metadata })`
4. store returned `runId` as the session's current run
5. set `currentRootRunId = runId` for the root run
6. persist result and append assistant output to transcript when successful
7. if approval is requested, keep the run open on the session

For a structured run:

1. validate the agent and endpoint allow `run` mode
2. build a `RunRequest` from `goal`, `input`, `context`, and metadata
3. call `agent.run({ goal, input, context, metadata })`
4. store the resulting `runId` and `rootRunId` on the session or invocation record
5. persist terminal output and publish it through the configured channel or response path

For approval resolution:

1. validate session has a pending `runId`
2. call `agent.resolveApproval(runId, approved)` if needed
3. call `agent.resume(runId)`
4. persist terminal result back onto the session

### Event Bridge And Channel Fanout

Subscribe to the runtime `EventStore` and route events onto gateway channels.

This should publish:

- `run.created`
- `run.status_changed`
- `tool.started`
- `tool.completed`
- `tool.failed`
- `delegate.spawned`
- `approval.requested`
- `approval.resolved`
- `run.completed`
- `run.failed`
- `snapshot.created`

The gateway should decorate outbound event frames with session-level metadata so a client can correlate:

- `sessionId`
- `agentId`
- `runId`
- `rootRunId`
- `parentRunId`
- `delegateName`

### Hook Runner

Hooks allow policy and integration without changing the core runtime.

Recommended hooks:

- `onAuthenticate`
- `onSessionResolve`
- `beforeRoute`
- `beforeInboundMessage`
- `beforeRunStart`
- `afterRunResult`
- `onAgentEvent`
- `beforeOutboundFrame`
- `onDisconnect`
- `onError`

Recommended behavior:

- `before*` hooks may mutate metadata or reject the request
- `after*` and `on*` hooks observe and enrich, but should not rewrite persisted run facts
- hook failures should have explicit policy: `fail`, `warn`, or `ignore`

## Session Model

## Why Wrap `rootRunId` Into Sessions

`rootRunId` already identifies a run tree, but not a user conversation across turns.

The gateway session should therefore be the stable external object, while `rootRunId` remains the stable internal execution-tree object.

Recommended mapping:

- one session has many root runs over time
- one root run belongs to exactly one session
- one root run may have many child runs

Suggested persisted linkage:

```ts
interface SessionRunLink {
  sessionId: string;
  runId: string;
  rootRunId: string;
  turnIndex: number;
  kind: 'chat_turn' | 'run_invocation' | 'approval_resume' | 'system_event';
  createdAt: string;
}
```

## Transcript Ownership

The gateway, not the core runtime, should own transcript persistence.

That fits the current `chat()` API, which expects the host to provide the full message history for each turn.

Selected rule:

- session transcript is the source of truth for multi-turn chat
- run snapshots are the source of truth for in-flight execution and resume
- each turn should replay recent raw messages plus a rolling summary of older context

Recommended replay policy:

- keep the most recent message window verbatim
- maintain a gateway-owned rolling summary for older conversation context
- refresh the summary after successful turns or when the raw message window crosses a threshold
- use the summary plus recent raw messages as the `chat()` input envelope for the next turn

Why this is the right default:

- it avoids unbounded transcript growth
- it preserves short-range conversational fidelity
- it keeps the session model compatible with the current `AdaptiveAgent.chat()` contract
- it gives the gateway a clear place to add token-budget controls later

## Concurrency Rules

Per session:

- only one active root run at a time
- allow multiple concurrent socket attachments for the same principal
- reject or queue additional user messages while a run is `running`
- allow only approval frames while a run is `awaiting_approval`
- enforce a single write lane even if the same user has several tabs or devices attached

Across sessions and agents:

- different sessions should be allowed to run concurrently by default
- different agents should be allowed to run concurrently by default
- cron-triggered work for one agent should not block an unrelated in-flight run for another agent unless a configured global or per-agent concurrency limit says otherwise

This aligns well with the current v1.4 single-active-child model and avoids racey session state.

## WebSocket Protocol Proposal

## Inbound Frames

```ts
type ClientFrame =
  | { type: 'session.open'; sessionId?: string; channelId: string; metadata?: Record<string, unknown> }
  | { type: 'message.send'; sessionId: string; text: string; metadata?: Record<string, unknown> }
  | { type: 'run.start'; sessionId?: string; agentId?: string; goal: string; input?: unknown; context?: Record<string, unknown>; metadata?: Record<string, unknown> }
  | { type: 'approval.resolve'; sessionId: string; approved: boolean }
  | { type: 'channel.subscribe'; channels: string[] }
  | { type: 'session.close'; sessionId: string }
  | { type: 'ping'; ts: string };
```

## Outbound Frames

```ts
type ServerFrame =
  | { type: 'session.opened'; sessionId: string; agentId: string; status: string }
  | { type: 'session.updated'; sessionId: string; status: string; currentRunId?: string; currentRootRunId?: string }
  | { type: 'agent.event'; channel: string; event: unknown }
  | { type: 'message.output'; sessionId: string; runId: string; output: unknown }
  | { type: 'run.output'; sessionId?: string; runId: string; output: unknown }
  | { type: 'approval.requested'; sessionId: string; runId: string; toolName: string; message: string }
  | { type: 'error'; code: string; message: string; retryable?: boolean }
  | { type: 'pong'; ts: string };
```

For the first iteration, avoid token streaming unless the chosen `ModelAdapter` surface is extended later.

## Cron And Scheduling

Cron should be a gateway-owned capability, not a responsibility of `@adaptive-agent/core`.

The scheduler should:

- persist jobs and run history
- claim due jobs with leases so only one worker executes a given fire time
- dispatch due jobs into normal gateway execution paths
- publish cron-triggered runs onto the same event channels as user-triggered runs

That keeps scheduling as host orchestration while reusing the existing `run`, `chat`, `resume`, and event semantics of AdaptiveAgent.

## Scheduler Ownership

Recommended ownership model:

- the gateway process owns cron job definitions and due-job dispatch
- a dedicated scheduler loop or worker pool claims jobs from durable storage
- the scheduler invokes the same run orchestrator used by WebSocket traffic instead of creating a parallel execution engine

This means cron is another gateway ingress path, alongside WebSocket messages.

## Cron Job Types

Recommended job target types:

- `session_event` - inject scheduled work into an existing session
- `isolated_run` - execute a fresh structured run with no prior transcript carry-over
- `isolated_chat` - execute a fresh chat-style turn in a dedicated isolated session when conversation framing still matters

Recommended invocation defaults:

- `session_event` should usually call `agent.chat(...)`
- `isolated_run` should usually call `agent.run(...)`
- `isolated_chat` should call `agent.chat(...)` with a synthetic session such as `cron:<jobId>`

Suggested cron job shape:

```ts
interface GatewayCronJob {
  id: string;
  name: string;
  schedule:
    | { kind: 'at'; at: string }
    | { kind: 'every'; everyMs: number }
    | { kind: 'cron'; expr: string; tz?: string; staggerMs?: number };
  target:
    | { kind: 'session_event'; sessionId: string }
    | { kind: 'isolated_run'; agentId: string }
    | { kind: 'isolated_chat'; agentId: string };
  invocation:
    | { mode: 'chat'; message: string; context?: Record<string, unknown> }
    | { mode: 'run'; goal: string; input?: unknown; context?: Record<string, unknown> };
  delivery:
    | { mode: 'session' }
    | { mode: 'announce'; channelId: string }
    | { mode: 'webhook'; url: string }
    | { mode: 'none' };
}
```

## Cron Delivery Modes

Recommended delivery modes:

- `session` - write the result back into the target session and publish normal session events
- `announce` - deliver a summary or structured result to a configured outbound channel
- `webhook` - POST a completion payload to an external endpoint
- `none` - internal-only execution for maintenance, indexing, or background analysis

Recommended behavior:

- cron delivery should happen after the run result is finalized, not through a second agent turn unless explicitly requested
- isolated cron jobs should not inherit arbitrary user transcript state
- if a cron-triggered run reaches `awaiting_approval`, default behavior should be fail or mark-needs-review rather than blocking forever

## Cron And Sessions

Recommended mapping:

- `session_event` reuses the existing session and creates a new root run inside it
- `isolated_run` creates a fresh root run and may skip session creation entirely unless audit requirements prefer a synthetic session wrapper
- `isolated_chat` creates or reuses a synthetic session namespace like `cron:<jobId>` so transcript carry-over stays isolated from human chat sessions

This matches the OpenClaw distinction between main-session events and isolated scheduled turns while preserving the gateway's session/run boundary.

## Config Proposal

## Gateway Config

File: `config/gateway.json`

```json
{
  "server": {
    "host": "0.0.0.0",
    "port": 3000,
    "websocketPath": "/ws"
  },
  "auth": {
    "provider": "jwt",
    "issuer": "https://auth.example.com",
    "audience": "adaptive-agent-gateway"
  },
  "cron": {
    "enabled": true,
    "schedulerLeaseMs": 30000,
    "maxConcurrentJobs": 4
  },
  "channels": {
    "defaults": {
      "sessionConcurrency": 1
    },
    "list": [
      { "id": "webchat", "name": "Web Chat" },
      { "id": "ops", "name": "Ops Console" }
    ]
  },
  "bindings": [
    {
      "match": {
        "channelId": "ops",
        "roles": ["ops"]
      },
      "agentId": "ops-agent"
    },
    {
      "match": {
        "channelId": "webchat"
      },
      "agentId": "support-agent"
    }
  ],
  "defaultAgentId": "support-agent",
  "hooks": {
    "modules": [
      "./hooks/audit-log.ts",
      "./hooks/rate-limit.ts"
    ]
  }
}
```

## Agent Config

Files: `config/agents/<agentId>.json`

```json
{
  "id": "support-agent",
  "name": "Support Agent",
  "invocationModes": ["chat", "run"],
  "defaultInvocationMode": "chat",
  "model": {
    "provider": "openrouter",
    "model": "anthropic/claude-sonnet-4"
  },
  "systemInstructions": "You are the support front door for authenticated users.",
  "tools": ["read_file", "web_search"],
  "delegates": ["researcher", "writer"],
  "defaults": {
    "maxSteps": 12,
    "autoApproveAll": false
  },
  "routing": {
    "allowedChannels": ["webchat"]
  }
}
```

## Module Registry

Because JSON cannot express executable behavior directly, add a code registry layer:

- tool registry maps tool names to `ToolDefinition`
- delegate registry maps delegate names to `DelegateDefinition`
- hook registry loads hook modules from configured file paths
- auth registry resolves auth providers

## Persistence Proposal

PostgreSQL is the preferred durable target because it aligns with the documented store direction and supports leases, concurrency control, and multi-process scheduling cleanly.

However, PostgreSQL is not a hard prerequisite for the first gateway implementation.

Recommended persistence strategy:

- support a storage abstraction for gateway sessions, transcripts, cron jobs, and run linkage
- allow a file-backed implementation for local development and early single-node deployments
- treat PostgreSQL as the production-grade backend for multi-process durability and scheduler coordination

This mirrors the core runtime design, which already abstracts persistence behind store interfaces and can run with in-memory defaults.

Recommended backend tiers:

- in-memory for examples and tests
- file-backed JSON/JSONL storage for OpenClaw-style single-node persistence
- PostgreSQL for production durability, leases, and horizontal workers

Recommended gateway tables:

- `gateway_sessions`
- `gateway_session_messages`
- `gateway_session_runs`
- `gateway_connections` or ephemeral in-memory connection registry plus heartbeats
- `gateway_cron_jobs`
- `gateway_cron_runs`
- optional `gateway_outbox` if reliable external fanout is needed later

Suggested relationship to agent runtime tables:

- `gateway_session_runs.run_id -> agent_runs.id`
- `gateway_session_runs.root_run_id -> agent_runs.root_run_id`

This keeps the runtime tables authoritative for execution facts and the gateway tables authoritative for client/session facts.

If a file-backed MVP is chosen instead of PostgreSQL, the same logical artifacts should exist even if they are stored as JSON files rather than relational tables.

Suggested file-backed layout:

- `gateway/sessions/<sessionId>.json`
- `gateway/transcripts/<sessionId>.jsonl`
- `gateway/runs/<runId>.json`
- `gateway/cron/jobs.json`
- `gateway/cron/runs/<jobId>.jsonl`

Tradeoffs of file-backed persistence:

- good for a single host and easy local inspection
- simpler to ship for an MVP
- weaker for multi-process lease coordination and crash recovery edge cases
- harder to query operationally across many sessions and jobs
- likely to need a migration path once concurrency, cron scale, or observability requirements grow

## Security And Auth

Recommended MVP rules:

- require auth before opening a session unless a channel is explicitly marked public
- validate JWT during the WebSocket upgrade path and normalize claims into `AuthContext`
- stamp auth context into session metadata and run metadata
- enforce channel and agent access in routing before agent execution starts
- validate that approval frames come from the same authorized session principal
- allow multiple live connections only when they resolve to the same principal for that session
- redact sensitive auth claims before pushing events back to clients

Recommended JWT claims for the MVP:

- `sub` for the stable principal id
- `exp` for token expiry enforcement
- `tenantId` when multi-tenant routing is enabled
- `roles` or equivalent authorization claims for bindings and ACL checks

Operational note:

- because auth happens on upgrade, reconnect after token expiry should require a fresh token rather than silently keeping an old socket authorized

If multi-tenant use is expected, `tenantId` should be mandatory in session resolution and routing.

## High-Level Delivery Plan

### Phase 1: Gateway Skeleton

- create `packages/gateway-fastify`
- add Fastify + WebSocket server bootstrap for Bun
- define config loading and validation for gateway and agent JSON files
- add agent registry and module registry

### Phase 2: Session And Routing

- add session store and transcript store
- implement channel bindings and deterministic agent selection
- define agent invocation capabilities and session mode pinning
- define WebSocket frame protocol
- add per-session concurrency guard

### Phase 3: Agent Execution Bridge

- wire session turns to `agent.chat(...)`
- wire structured task execution to `agent.run(...)`
- persist run/session linkage
- handle approval and resume flow cleanly
- subscribe to runtime events and publish onto channels

### Phase 4: Hooks And Auth Hardening

- add auth provider abstraction
- add hook lifecycle and failure policy
- add audit, rate limit, and policy hooks
- add redaction and outbound frame filtering

### Phase 5: Cron And Scheduled Work

- add durable cron job storage and lease-based claiming
- dispatch scheduled work through the same run orchestrator as live traffic
- implement `session`, `announce`, `webhook`, and `none` delivery modes
- define cron behavior for approvals, retries, and failures

### Phase 6: Operations And Durability

- add or harden the selected durable backend
- support file-backed persistence for MVP and local single-node deployments if desired
- move session data onto Postgres-backed stores for production-grade durability
- add reconnect behavior and session recovery
- add metrics, health checks, and structured logs
- document deployment and local dev flows

## Risks And Design Watchouts

- The current `chat()` API is transcript-in, result-out. That means the gateway must own transcript persistence carefully.
- Approval handling is run-oriented, not session-oriented. The gateway has to translate between those concepts cleanly.
- If multiple clients attach to one session, the gateway needs a clear rule for who may send and who may observe.
- Supporting both `chat()` and `run()` means the gateway must make invocation mode explicit so transcript and result semantics do not blur together.
- Cron jobs that hit approval or clarification states need an explicit policy so scheduled work does not stall indefinitely.
- File-backed persistence is viable for an MVP, but lease coordination and concurrent schedulers are materially harder than with PostgreSQL.
- Tool and hook registries can become an unsafe code-loading surface if arbitrary paths are allowed.
- If routing rules can pin a session to an agent, rebinding mid-session should be explicit rather than automatic.

## Recommendation

The best first implementation is a host-managed session gateway that leaves `@adaptive-agent/core` largely unchanged.

That approach:

- matches the current v1.4 run-tree model
- avoids forcing `session` into the core contracts prematurely
- keeps OpenClaw-style routing deterministic and configurable
- gives a practical path to WebSocket delivery, hooks, and auth without destabilizing run semantics

## Decisions So Far

1. Session semantics: `B`

- A session represents one user conversation across reconnects.
- A reconnect should reattach to the same session and continue using the same transcript and pending approval state.

2. Agent selection: `A` with default fallback

- The gateway resolves the agent from bindings only.
- If no binding matches, the gateway uses the configured default agent.
- Clients should not be able to override routing by supplying an `agentId` in the normal chat path.

3. Which auth model should the gateway target first?

- Use JWT bearer auth during the WebSocket upgrade.
- Treat the gateway as trusting upstream identity rather than owning login itself.
- Require reconnecting clients to present a fresh valid JWT.

4. Who may attach to the same session?

- Allow multiple live connections for the same authenticated principal.
- Keep session ownership singular at the principal level, not shared across different principals.
- Enforce one write lane for message send and approval actions even if many tabs or devices are attached.

5. Should session history be replayed into every turn verbatim?

- Replay recent messages plus a rolling summary.
- Keep recent turns verbatim for fidelity and use the summary to compress older context.
- Let the gateway own summary refresh policy rather than pushing that concern into the core runtime.
