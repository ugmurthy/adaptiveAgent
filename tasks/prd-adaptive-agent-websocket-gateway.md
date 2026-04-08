# PRD: AdaptiveAgent WebSocket Gateway

## Introduction

Build a Bun + Fastify gateway that exposes `AdaptiveAgent` instances over authenticated WebSocket connections with deterministic routing, gateway-owned session management, run orchestration, event channel fanout, hook extensibility, and scheduled ingress.

The gateway must preserve the current v1.4 runtime boundary documented in this repository. A `run` remains the core execution unit, `rootRunId` remains the identifier for a single run tree, child runs remain ordinary delegated runs created through synthetic `delegate.*` tools, and the gateway introduces `session` as a host-owned artifact that groups multiple root runs over time without making `session` a new primitive in `@adaptive-agent/core`.

The gateway must support both primary invocation styles already implied by the runtime design:

- `agent.chat(...)` for transcript-oriented conversational sessions
- `agent.run(...)` for structured tasks, commands, and scheduled work

## Goals

- Expose AdaptiveAgent instances over authenticated WebSocket connections using Fastify on Bun.
- Introduce a first-class gateway `session` artifact that groups multiple root runs over time.
- Route inbound traffic to the correct agent using deterministic host-configured bindings rather than model-selected routing.
- Support both `chat()` and `run()` invocation modes at the gateway layer.
- Publish runtime and session activity onto gateway channels so clients can subscribe to relevant updates.
- Add hook points for auth, routing, inbound processing, run lifecycle, outbound delivery, disconnects, and errors.
- Load agent identity and static configuration from JSON files with stable `id` and `name` fields.
- Keep transcript persistence, reconnect handling, and approval resume logic outside `@adaptive-agent/core`.
- Provide a practical durability path from in-memory and file-backed storage to PostgreSQL-backed production storage.
- Reuse the same run orchestrator for live WebSocket traffic and scheduled gateway work.

## User Stories

### US-001: Bootstrap a gateway package and config loader
**Description:** As a platform engineer, I want a dedicated gateway package with validated configuration so that the server can start predictably under Bun.

**Acceptance Criteria:**
- [ ] A new gateway package or workspace entry exists for the Fastify-based WebSocket gateway.
- [ ] The gateway loads `config/gateway.json` and fails fast with descriptive validation errors for invalid or missing required fields.
- [ ] The gateway can start under Bun with a configured host, port, and WebSocket path.
- [ ] Optional health endpoint behavior is documented and implemented if enabled by config.
- [ ] `bun run build` passes for the gateway workspace.
- [ ] `bun test` passes.

### US-002: Load agent definitions from JSON and materialize runtimes
**Description:** As a platform engineer, I want agent definitions loaded from JSON with a code registry for executable behavior so that agent identity stays declarative while behavior stays safe and explicit.

**Acceptance Criteria:**
- [ ] The gateway loads agent config files from `config/agents/*.json`.
- [ ] Each agent config requires stable `id`, `name`, invocation capability metadata, model configuration, and routing constraints.
- [ ] Tools, delegates, hooks, and auth providers are resolved through explicit registries rather than arbitrary inline code in JSON.
- [ ] Agents are instantiated lazily on first use and cached by `agentId`.
- [ ] Invalid agent references fail with actionable startup errors.
- [ ] `bun run build` passes for the gateway workspace.
- [ ] `bun test` passes.

### US-003: Authenticate WebSocket upgrades with JWT and normalize auth context
**Description:** As a platform engineer, I want the gateway to authenticate sockets before session creation so that routing and execution always operate on a trusted principal.

**Acceptance Criteria:**
- [ ] The WebSocket upgrade path validates JWT bearer tokens before allowing session creation unless a channel is explicitly configured as public.
- [ ] Successful auth produces a normalized auth context with at least `subject`, optional `tenantId`, `roles`, and raw claims access for policy checks.
- [ ] Expired or invalid tokens are rejected with a stable protocol error.
- [ ] Reconnects require a fresh valid JWT and do not silently inherit expired authorization.
- [ ] Sensitive claims are redacted before outbound delivery.
- [ ] `bun run build` passes for the gateway workspace.
- [ ] `bun test` passes.

### US-004: Create, reopen, and manage gateway sessions
**Description:** As an authenticated user, I want a durable gateway session that survives reconnects so that my conversation state and pending approvals persist across devices or tabs for the same principal.

**Acceptance Criteria:**
- [ ] The gateway can open a new session or reattach to an existing session when the same principal reconnects.
- [ ] A session records `agentId`, `channelId`, principal ownership, status, active run linkage, transcript version, and timestamps.
- [ ] Session status transitions include at least `idle`, `running`, `awaiting_approval`, `closed`, and `failed`.
- [ ] Session ownership is restricted to the same authenticated principal; different principals cannot attach to the session.
- [ ] Multiple live connections for the same principal can observe the same session.
- [ ] `bun run build` passes for the gateway workspace.
- [ ] `bun test` passes.

### US-005: Enforce deterministic routing and session pinning
**Description:** As a platform engineer, I want inbound traffic routed by host-configured bindings so that agent selection is predictable, auditable, and not left to the model.

**Acceptance Criteria:**
- [ ] Routing uses host configuration inputs such as channel, tenant, roles or claims, explicit session pinning, and gateway defaults.
- [ ] Existing sessions remain pinned to their resolved `agentId` unless an explicit host action rebinds them.
- [ ] Normal chat traffic cannot override routing by supplying `agentId` directly.
- [ ] Structured `run.start` traffic may specify `agentId` only when the endpoint or policy explicitly allows it.
- [ ] Binding evaluation order is deterministic and documented.
- [ ] `bun run build` passes for the gateway workspace.
- [ ] `bun test` passes.

### US-006: Execute conversational turns through `agent.chat(...)`
**Description:** As an authenticated user, I want chat messages to execute against the routed agent while preserving session history so that I can have a coherent multi-turn conversation.

**Acceptance Criteria:**
- [ ] `message.send` loads the session transcript, appends the inbound user message, and invokes `agent.chat(...)`.
- [ ] The gateway persists the resulting `runId` and treats it as the session's current root run for that turn.
- [ ] Successful assistant output is appended to the session transcript and delivered back to subscribed clients.
- [ ] Failed chat turns update session status and publish an error frame without corrupting prior transcript history.
- [ ] Chat sessions are pinned to `chat` invocation mode for subsequent turns unless the host explicitly creates a separate session for another mode.
- [ ] `bun run build` passes for the gateway workspace.
- [ ] `bun test` passes.

### US-007: Execute structured work through `agent.run(...)`
**Description:** As a platform or product integrator, I want structured run requests to use `agent.run(...)` so that commands, automation, and scheduled work can execute without chat transcript semantics.

**Acceptance Criteria:**
- [ ] `run.start` validates that the routed agent and endpoint allow `run` mode.
- [ ] The gateway builds a structured run request from `goal`, optional `input`, optional `context`, and metadata.
- [ ] The gateway persists `runId`, `rootRunId`, and session linkage when the run is session-bound.
- [ ] Terminal run output is delivered through the configured response path and/or channel.
- [ ] Structured sessions are pinned to `run` mode unless the host explicitly creates another session for `chat` mode.
- [ ] `bun run build` passes for the gateway workspace.
- [ ] `bun test` passes.

### US-008: Resume paused runs through approval resolution
**Description:** As an authenticated user, I want to approve or reject pending actions in a session so that paused runs can resume without losing execution state.

**Acceptance Criteria:**
- [ ] The gateway accepts approval frames only when the session has a pending authorized `runId`.
- [ ] Approval actions validate the sending principal matches the session owner.
- [ ] Approval resolution calls the appropriate runtime approval and resume path and keeps the same run in flight rather than creating a new root run.
- [ ] Session state returns to `idle`, `running`, or `failed` based on the resumed run outcome.
- [ ] Approval request and resolution events are published to subscribed channels.
- [ ] `bun run build` passes for the gateway workspace.
- [ ] `bun test` passes.

### US-009: Publish runtime events onto channels and protocol frames
**Description:** As a client developer, I want session, run, and agent events delivered through stable gateway frames so that I can render execution progress and subscribe to relevant topics.

**Acceptance Criteria:**
- [ ] The gateway supports channel subscriptions for at least session, run, root run, and agent-scoped delivery topics.
- [ ] Runtime events such as `run.created`, `run.status_changed`, `tool.started`, `tool.completed`, `delegate.spawned`, `approval.requested`, `approval.resolved`, `run.completed`, `run.failed`, and `snapshot.created` can be bridged to outbound frames.
- [ ] Outbound event frames include correlation metadata such as `sessionId`, `agentId`, `runId`, `rootRunId`, and `parentRunId` when available.
- [ ] The first release avoids token streaming and instead delivers event and result frames.
- [ ] Clients can subscribe to channels after connection and receive only authorized topics.
- [ ] `bun run build` passes for the gateway workspace.
- [ ] `bun test` passes.

### US-010: Persist transcript history with replay and compaction policy
**Description:** As a platform engineer, I want the gateway to own transcript persistence and replay policy so that multi-turn chat remains compatible with the current `AdaptiveAgent.chat()` contract without unbounded context growth.

**Acceptance Criteria:**
- [ ] Session transcript persistence is owned by gateway storage rather than the core runtime.
- [ ] The gateway replays recent messages verbatim and combines them with a rolling summary of older context for future chat turns.
- [ ] Summary refresh happens after successful turns or when the raw message window exceeds a configured threshold.
- [ ] Transcript state remains consistent across reconnects and approvals.
- [ ] The implementation documents how transcript history and run snapshots relate without conflating their ownership.
- [ ] `bun run build` passes for the gateway workspace.
- [ ] `bun test` passes.

### US-011: Enforce per-session concurrency and single-writer behavior
**Description:** As a platform engineer, I want strict per-session write concurrency so that multiple tabs or devices cannot race session state.

**Acceptance Criteria:**
- [ ] Only one active root run can exist per session at a time.
- [ ] While a session is `running`, additional user messages are rejected or queued according to configured policy.
- [ ] While a session is `awaiting_approval`, only approval-related frames are accepted.
- [ ] Multiple socket attachments for the same principal can observe session updates without creating multiple write lanes.
- [ ] Concurrency behavior is deterministic across reconnects and process restarts for the selected storage backend.
- [ ] `bun run build` passes for the gateway workspace.
- [ ] `bun test` passes.

### US-012: Add gateway hooks with explicit failure policy
**Description:** As a platform engineer, I want hook lifecycles around gateway events so that auth policy, auditing, rate limits, and outbound filtering can be extended without changing runtime semantics.

**Acceptance Criteria:**
- [ ] The gateway supports configured hook entry points for authentication, session resolution, routing, inbound frames, run start, run result, agent events, outbound frames, disconnects, and errors.
- [ ] `before*` hooks can mutate request metadata or reject execution.
- [ ] `after*` and `on*` hooks can observe and enrich context but cannot rewrite persisted execution facts.
- [ ] Hook failures follow an explicit policy of `fail`, `warn`, or `ignore`.
- [ ] Hook loading occurs through an explicit module registry rather than arbitrary dynamic code evaluation from untrusted input.
- [ ] `bun run build` passes for the gateway workspace.
- [ ] `bun test` passes.

### US-013: Support durable session and cron persistence across backend tiers
**Description:** As a platform engineer, I want storage abstractions for session, transcript, run linkage, and cron data so that the gateway can run in local development and production without changing its logical model.

**Acceptance Criteria:**
- [ ] The gateway defines storage interfaces for sessions, session messages, session-run linkage, cron jobs, and cron executions.
- [ ] An in-memory backend exists for tests and examples.
- [ ] A file-backed backend exists or is clearly staged as the first durable local-development backend.
- [ ] PostgreSQL-backed storage is supported or explicitly defined as the production target with compatible schemas.
- [ ] Runtime execution facts stay authoritative in runtime tables or stores, while client/session facts stay authoritative in gateway stores.
- [ ] `bun run build` passes for the gateway workspace.
- [ ] `bun test` passes.

### US-014: Dispatch scheduled work through the same run orchestrator
**Description:** As an operator, I want cron and scheduled work to flow through the normal gateway execution path so that scheduled runs behave consistently with user-triggered runs.

**Acceptance Criteria:**
- [ ] The gateway can persist cron job definitions and claim due work using leases so only one worker executes a given fire time.
- [ ] Supported target types include `session_event`, `isolated_run`, and `isolated_chat`.
- [ ] Supported delivery modes include at least `session`, `announce`, `webhook`, and `none`.
- [ ] Scheduled executions reuse the same run orchestrator and event fanout path as WebSocket-triggered executions.
- [ ] Cron runs that reach approval state follow an explicit policy such as fail or mark-needs-review instead of blocking indefinitely.
- [ ] `bun run build` passes for the gateway workspace.
- [ ] `bun test` passes.

### US-015: Provide operational recovery and observability basics
**Description:** As an operator, I want reconnect recovery, structured logs, and health signals so that the gateway can be operated safely in development and production.

**Acceptance Criteria:**
- [ ] Reconnecting clients can recover active session state and continue receiving channel events.
- [ ] The gateway emits structured operational logs for auth failures, routing decisions, session lifecycle, run dispatch, hook failures, and cron execution.
- [ ] Health and readiness surfaces can distinguish startup failure, degraded storage connectivity, and normal operation.
- [ ] Metrics or counters exist for session counts, active runs, auth failures, routing misses, and cron claims.
- [ ] Local development and deployment flow documentation exists for the chosen storage modes.
- [ ] `bun run build` passes for the gateway workspace.
- [ ] `bun test` passes.

## Functional Requirements

1. FR-1: The system must expose AdaptiveAgent instances over WebSockets using Bun and Fastify.
2. FR-2: The system must treat `session` as a gateway-owned host artifact rather than a new primitive inside `@adaptive-agent/core`.
3. FR-3: The system must support both `agent.chat(...)` and `agent.run(...)` invocation styles.
4. FR-4: The system must preserve the existing v1.4 execution boundary where a `run` is the execution unit and `rootRunId` identifies a single run tree.
5. FR-5: The system must load gateway configuration from `config/gateway.json` or an equivalent documented config path.
6. FR-6: The system must load agent definitions from JSON files with stable `id` and `name` fields.
7. FR-7: The system must represent executable behavior through registries for tools, delegates, hooks, and auth providers instead of embedding executable code directly in JSON.
8. FR-8: The system must authenticate WebSocket upgrades before session creation unless a channel is explicitly configured as public.
9. FR-9: The system must normalize successful authentication into an auth context containing at least principal identity and authorization claims needed for routing and policy.
10. FR-10: The system must reject invalid or expired JWTs with stable protocol errors.
11. FR-11: The system must support multiple live connections only when they resolve to the same principal for a given session.
12. FR-12: The system must persist a gateway session record with agent identity, channel identity, principal ownership, status, transcript metadata, and active run linkage.
13. FR-13: The system must support one session owning many root runs over time.
14. FR-14: The system must ensure one root run belongs to exactly one session when the run is session-bound.
15. FR-15: The system must resolve routing deterministically from host configuration using session pinning, binding rules, channel defaults, and gateway defaults.
16. FR-16: The system must not allow normal chat traffic to choose agent identity directly when routing policy forbids it.
17. FR-17: The system must keep an existing session pinned to its resolved `agentId` unless the host explicitly rebinds it.
18. FR-18: The system must define and validate a stable inbound WebSocket frame protocol for opening sessions, sending messages, starting runs, resolving approvals, subscribing to channels, closing sessions, and heartbeat traffic.
19. FR-19: The system must define and validate a stable outbound frame protocol for session lifecycle, runtime events, outputs, approvals, errors, and heartbeats.
20. FR-20: The system must route chat traffic by loading session transcript state, appending inbound user content, and invoking `agent.chat(...)`.
21. FR-21: The system must route structured work by building a run request from `goal`, optional `input`, optional `context`, and metadata, then invoking `agent.run(...)`.
22. FR-22: The system must persist session-to-run linkage including `sessionId`, `runId`, `rootRunId`, turn ordering, invocation kind, and timestamps.
23. FR-23: The system must store the active `runId` and `rootRunId` on the session while work is in flight.
24. FR-24: The system must allow approval resolution only when the session has an authorized pending run and the sender matches session ownership rules.
25. FR-25: The system must resume paused runs without creating a new root run for approval continuation.
26. FR-26: The system must own transcript persistence for multi-turn chat.
27. FR-27: The system must replay recent raw messages plus a rolling summary of older context for subsequent chat turns.
28. FR-28: The system must refresh transcript summary state after successful turns or when a configured threshold is crossed.
29. FR-29: The system must enforce a single active root run per session.
30. FR-30: The system must reject or queue additional writes while a session is `running` according to configured policy.
31. FR-31: The system must allow only approval-related writes while a session is `awaiting_approval`.
32. FR-32: The system must support channel subscriptions for at least session, run, root run, and agent topics.
33. FR-33: The system must bridge runtime events into outbound gateway frames with correlation metadata such as `sessionId`, `agentId`, `runId`, `rootRunId`, `parentRunId`, and delegate name when available.
34. FR-34: The first release must support event and result frames without requiring token-level output streaming.
35. FR-35: The system must support hook entry points for auth, session resolution, routing, inbound frames, run lifecycle, outbound delivery, disconnects, and errors.
36. FR-36: The system must implement explicit hook failure policy options of `fail`, `warn`, or `ignore`.
37. FR-37: The system must prevent hooks from rewriting authoritative persisted runtime facts after execution completes.
38. FR-38: The system must support storage abstractions for sessions, transcripts, session-run linkage, cron jobs, cron executions, and any required connection metadata.
39. FR-39: The system must support an in-memory backend for tests and examples.
40. FR-40: The system must support at least one durable backend suitable for local single-node development, such as file-backed storage.
41. FR-41: The system must define or implement PostgreSQL-backed persistence as the production-grade durability target.
42. FR-42: The system must keep gateway storage authoritative for client and session facts while runtime stores remain authoritative for execution facts.
43. FR-43: The system must support durable cron job definitions and run history.
44. FR-44: The system must claim due cron jobs with leases so only one worker executes a given scheduled fire time.
45. FR-45: The system must support cron target types `session_event`, `isolated_run`, and `isolated_chat`.
46. FR-46: The system must support cron delivery modes `session`, `announce`, `webhook`, and `none`.
47. FR-47: The system must execute scheduled work through the same run orchestrator used for live traffic.
48. FR-48: The system must define a policy for cron-triggered runs that reach approval state so they do not block indefinitely.
49. FR-49: The system must redact sensitive auth claims and other protected metadata before outbound delivery.
50. FR-50: The system must enforce channel and agent access checks before agent execution begins.
51. FR-51: The system must support reconnect recovery for active sessions and pending approvals.
52. FR-52: The system must emit structured operational logs for auth, routing, session lifecycle, run dispatch, hook failures, and scheduled work.
53. FR-53: The system must expose health and readiness signals suitable for local development and production operations.
54. FR-54: The system must provide documentation for local development, deployment, config structure, routing behavior, and supported protocol frames.

## Non-Goals

- Changing the core `AdaptiveAgent` contract to make `session` a runtime primitive.
- Allowing the model to choose routing or agent identity.
- Supporting parallel child runs beyond the existing v1.4 single-active-child rule.
- Introducing persistent interactive client-to-child-run protocols.
- Rebinding sessions to different agents automatically in the middle of a conversation.
- Making scheduling a responsibility of `@adaptive-agent/core` instead of the gateway host layer.
- Requiring token-level streaming in the first release.
- Shipping arbitrary code loading from untrusted JSON configuration.
- Solving cross-principal shared session collaboration in the first release.

## Design Considerations

- Session is the stable external object for clients, while `rootRunId` remains the stable internal execution-tree object.
- Channels are delivery topics for fanout and observability, not agent memory or state containers.
- Routing must be deterministic and host-owned, similar to a bindings engine, with explicit evaluation order.
- The gateway should pin a session to one invocation mode (`chat` or `run`) to avoid mixing transcript semantics with structured-run semantics.
- Transcript growth should be bounded through recent-message replay plus a rolling summary, not through unbounded verbatim replay.
- Multiple connections for the same principal should be allowed for observation, but the session must retain a single write lane.
- Approval state is run-oriented in the runtime and must be translated cleanly into session-oriented client behavior by the gateway.
- Cron is another gateway ingress path and should reuse the same execution orchestration rather than creating a parallel engine.

## Technical Considerations

- Proposed package split:
  - `packages/gateway-fastify` for the Fastify server, WebSocket protocol, auth, routing, hooks, and channel fanout.
  - `packages/core` remains the existing runtime.
  - `packages/store-postgres` remains the planned runtime store package and can be extended or paired with gateway-specific persistence.
- Suggested gateway storage artifacts:
  - `gateway_sessions`
  - `gateway_session_messages`
  - `gateway_session_runs`
  - `gateway_cron_jobs`
  - `gateway_cron_runs`
  - optional connection and outbox artifacts as needed
- If a file-backed backend is included, it should preserve the same logical artifacts so the implementation can migrate cleanly to PostgreSQL later.
- Suggested gateway protocol coverage:
  - inbound frames for session open, message send, run start, approval resolve, channel subscribe, session close, and ping
  - outbound frames for session opened, session updated, agent events, outputs, approval requested, protocol errors, and pong
- Runtime event bridging should cover at least run lifecycle, tool lifecycle, delegation lifecycle, approval lifecycle, and snapshot creation events.
- Hot-reload of configs or modules should be opt-in rather than default behavior.
- Tool registries and hook registries should constrain loading surfaces so gateway extension does not become an unsafe arbitrary code execution path.
- Session linkage should preserve turn ordering and run kind so transcripts, approvals, structured runs, and system events can be audited later.
- Suggested phase order for implementation:
  - gateway skeleton and config loading
  - session management and deterministic routing
  - chat and run orchestration
  - approval resume and event fanout
  - hooks and auth hardening
  - cron scheduling and durable coordination
  - operations, reconnect recovery, and production durability

## Success Metrics

- Authenticated clients can establish WebSocket sessions and receive stable protocol responses with no unauthenticated session creation paths enabled by default.
- Session reconnect restores the same session identity, transcript context, and pending approval state for the same principal.
- Routing decisions are deterministic and explainable from configuration, with zero cases where the model selects the target agent.
- A single session can successfully execute multiple chat turns as distinct root runs while preserving coherent conversation state.
- Structured run requests and chat requests both execute through the gateway without blurring their persistence or output semantics.
- Approval-required runs can be resumed from the gateway and continue on the same run rather than spawning replacement root runs.
- Subscribed clients receive correlated session and run events with enough metadata to render progress and debug issues.
- Scheduled jobs are claimed once and executed once per fire time under lease-based coordination for the selected durable backend.
- The gateway can run in local development with a lightweight backend and in production with a durable backend without changing the logical session model.

## Open Questions

- Should the first production-ready release require PostgreSQL from day one, or should file-backed persistence be part of the MVP scope?
- Should queued writes for a `running` session be part of the MVP, or should the first release reject concurrent writes and require clients to retry?
- Should public unauthenticated channels exist in the first release, or should MVP behavior require authentication for all channels?
- Should outbound `webhook` delivery for cron results ship in the first release, or can it follow after `session`, `announce`, and `none` modes?
- Should the gateway expose admin endpoints for live connection inspection and force-close behavior in the MVP, or should operations remain health-and-logs only at first?
