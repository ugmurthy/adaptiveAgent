# Gateway Plan: Local Runtime and Remote Capability Gateway

## 1. Status

This document is the implementation plan for an authenticated AdaptiveAgent
capability gateway used by local CLI and desktop runtimes.

It supersedes `tasks/prd-adaptive-agent-websocket-gateway.md` for this product
path. That older plan describes server-executed agents, gateway sessions, and
server-owned run persistence. This plan deliberately keeps execution and run
persistence on the client. The older document remains relevant only if a
separate server-run agent product is pursued.

This is a plan, not an implementation. Each phase has an independent
validation gate and should be completed before dependent phases begin.

## 2. Product Goal

Allow an authorized CLI or Swift desktop application to execute AdaptiveAgent
runs locally while using server-owned credentials for model inference,
key-backed web search, and key-backed page extraction.

The client must own:

- the core execution loop
- local tools and workspace access
- local artifacts
- delegates and child runs
- approvals and clarifications
- runs, events, snapshots, tool execution records, plans, and continuations
- recovery, retry, resume, and replay

The server must own:

- authentication and entitlement enforcement
- inference-tier authorization
- provider/model routing
- server provider credentials
- key-backed web provider credentials
- immutable filesystem-based server profile distribution
- authoritative usage metering and billing records

The server must not own or persist client runs, conversations, snapshots,
plans, artifacts, local file paths, or tool execution state.

## 3. Fixed Architecture Decisions

1. The server is a capability gateway, not an AdaptiveAgent runtime host.
2. The public capability API uses JSON-RPC 2.0 over WSS at `/rpc`.
3. The CLI uses `@adaptive-agent/agent-sdk` directly.
4. A Swift application launches `@adaptive-agent/desktop-bridge` as a local
   sidecar and communicates with it over stdio or a Unix-domain socket.
5. Desktop run persistence uses an embedded SQLite runtime.
6. The client selects `low`, `medium`, `high`, or `xtra-high` when initiating a
   run. The gateway maps that tier to a server-owned provider/model route.
7. Tier, authorization, and route-policy data use a protected host execution
   context. They must not use model-visible or model-controlled metadata.
8. Provider transport streaming is implemented during the first gateway
   vertical slice. `GatewayModelAdapter.generate()` initially consumes those
   events and returns the final `ModelResponse` to the unchanged core loop.
9. Core/UI-visible model deltas are a later phase that reuses the same gateway
   stream protocol. The gateway wire protocol must not be redesigned for it.
10. Direct public page fetching remains local.
11. The gateway exposes only key-backed page extraction such as Parallel.
12. Server profiles and delegates are declarative. Any server-distributed
    profile bundle containing a handler or executable module is rejected.
13. Server profiles are immutable filesystem deployment assets, not
    user-created or user-edited database records.
14. Direct client BYOK and local-model execution are supported later. The
    server can authorize official-client use, but cannot strongly enforce or
    authoritatively meter work that never reaches the server.

## 4. High-Level Architecture

```text
                              +-----------------------------------+
                              | Capability gateway                |
                              |                                   |
                              | JWT/OIDC authentication           |
                              | Entitlements and run permits      |
                              | Tier routing policy               |
                              | Model provider adapters           |
                              | Key-backed web providers          |
                              | Profile manifest/files            |
                              | Usage and billing ledger          |
                              | Ephemeral idempotency cache       |
                              |                                   |
                              | No AgentSdk and no run state      |
                              +-----------------+-----------------+
                                                |
                                      WSS JSON-RPC /rpc
                                                |
        +---------------------------------------+-----------------------+
        | Local client runtime                                         |
        |                                                               |
        |  CLI ----------------------+                                  |
        |                             |                                  |
        |  Swift UI -> local bridge --+-> Agent SDK -> core runtime     |
        |                                                  |            |
        |                                                  +-> SQLite   |
        |                                                  +-> files    |
        |                                                  +-> local    |
        |                                                      tools    |
        |                                                  +-> gateway  |
        |                                                      adapters |
        +---------------------------------------------------------------+
```

## 5. Responsibility Boundaries

### 5.1 `@adaptive-agent/core`

Core continues to own runtime semantics:

- runs, sessions, child runs, retry, continuation, and recovery
- snapshots, events, leases, and optimistic versioning
- tool execution and idempotency
- execution-time validation
- generic model and tool interfaces
- generic persistence interfaces and implementations

Core may carry an opaque host execution context, but it must not understand
JWTs, billing plans, gateway URLs, profile catalogs, CLI flags, or provider
route tables.

### 5.2 `@adaptive-agent/agent-sdk`

Agent SDK owns client setup:

- local and server profile resolution
- inference mode and tier selection
- gateway client construction
- model adapter and tool proxy injection
- local workspace and tool registration
- SQLite runtime selection
- CLI-friendly errors and diagnostics
- propagation of strict run options into core

Agent SDK prevalidates for usability. Core remains authoritative for execution
validation and inheritance.

### 5.3 Gateway client

A new `@adaptive-agent/gateway-client` package owns:

- WSS connection lifecycle
- JSON-RPC request/response correlation
- access-token injection and refresh hooks
- capability negotiation
- reconnect and cancellation
- model stream assembly
- gateway `ModelAdapter`
- gateway `web_search` and Parallel extraction tools
- gateway error normalization
- tracing and correlation IDs

It imports core contracts but core must not import it.

### 5.4 Capability gateway

A new `@adaptive-agent/capability-gateway` package owns:

- the Bun WSS `/rpc` server
- authentication and actor construction
- entitlement checks
- tier routing and provider fallback
- provider client reuse and concurrency control
- search and extraction provider execution
- profile manifest loading and validation
- usage metering and billing persistence
- ephemeral active-call and result replay state

It must not construct `AgentSdk`, execute agent runs, or import server job
orchestration from `@adaptive-agent/service-sdk`.

### 5.5 Shared protocol

A small `@adaptive-agent/gateway-protocol` package owns pure protocol types,
validation, version constants, method names, error codes, and stream envelopes.
It must not open sockets, read environment variables, or depend on Fastify,
PostgreSQL, Agent SDK, or provider SDKs.

## 6. Core Contracts

### 6.1 Protected host execution context

Add an opaque JSON execution context to the core run contract. It is supplied
by the host, persisted by core, inherited by all derived runs, and never
accepted from model-generated delegate input.

Target shape at the core boundary:

```ts
interface RunRequest {
  executionContext?: JsonObject;
}

interface AgentRun {
  executionContext?: JsonObject;
}

interface ModelRequest {
  executionContext?: JsonObject;
}

interface ToolContext {
  executionContext?: JsonObject;
}
```

Core treats the object as opaque. Agent SDK owns a typed interpretation similar
to:

```ts
type InferenceMode = 'gateway' | 'local' | 'byok';
type InferenceTier = 'low' | 'medium' | 'high' | 'xtra-high';

interface GatewayExecutionContext {
  inferenceMode: InferenceMode;
  inferenceTier?: InferenceTier;
  authorizationRef?: string;
  routePolicyRef?: string;
  profileRefs?: Array<{
    source: 'local' | 'server';
    id: string;
    version: string;
    contentHash: string;
  }>;
}
```

The context must be inherited through:

- direct child/delegate runs
- retry
- resume
- recovery
- continuation
- swarm coordinator, worker, quality, and synthesizer runs
- Agent SDK orchestration stages

The context must not be merged from `DelegateToolInput.metadata`, steering
metadata, model output, or client profile metadata.

Raw access tokens and provider credentials must never appear in this context.
`authorizationRef` is an opaque permit identifier only.

### 6.2 Model invocation identity

Add a core-generated invocation descriptor to `ModelRequest`:

```ts
interface ModelInvocationContext {
  runId: UUID;
  rootRunId: UUID;
  stepId: string;
  purpose: 'agent_turn' | 'output_repair';
  callId: string;
  attempt: number;
}
```

Requirements:

- `callId` is stable when the same logical attempt is recovered after a crash.
- A deliberate new model attempt gets a different `callId`.
- Output-schema repair uses a distinct purpose and call ID.
- The gateway uses `callId` for request replay and billing uniqueness.
- JSON-RPC `id` remains connection-local and is not a billing identifier.

### 6.3 Actual route and usage

The gateway adapter uses static identity such as:

```text
provider = adaptive-agent-gateway
model = tier:high
```

Each terminal response must report the actual route in `UsageSummary.provider`
and `UsageSummary.model`. Core events and diagnostics should prefer the
response-reported values when present.

The local run preserves both:

- requested tier and route-policy reference in `executionContext`
- actual provider/model and measured usage in events and usage summaries

### 6.4 Provider stream contract

Provider adapters should expose normalized streams while preserving existing
`generate()` behavior.

Target direction:

```ts
interface ModelAdapter {
  generate(request: ModelRequest): Promise<ModelResponse>;
  stream?(
    request: ModelRequest,
    onEvent: (event: ModelStreamEvent) => Promise<void> | void,
  ): Promise<ModelResponse>;
}
```

Normalized events must cover at least:

- `start`
- `text_delta`
- `tool_call_start`
- `tool_call_delta`
- `tool_call_end`
- `summary`
- `usage`
- `done`
- `error`

Rules:

- `generate()` remains compatible and consumes the provider stream internally.
- The gateway calls `stream()` when available and forwards normalized events.
- Tool-call arguments are not executable until a terminal complete tool call
  is assembled and validated.
- Raw chain-of-thought is not persisted or forwarded. Provider-safe summaries
  may use the existing summary channel.
- Existing adapter request gating, timeout, retry, cancellation, usage, and
  tool-name mapping behavior must remain unchanged.

During the first vertical slice, `AdaptiveAgent` continues to call
`generate()`. Core-visible token events are introduced only in Phase 9.

## 7. Gateway JSON-RPC Contract

### 7.1 Transport

- Endpoint: `wss://<host>/rpc`
- One JSON-RPC object per WebSocket text frame
- Binary frames rejected
- Batch requests unsupported initially
- Request notifications unsupported initially
- Concurrent requests allowed
- Payload, connection, in-flight request, and backpressure limits enforced
- Production TLS may terminate at a trusted reverse proxy or directly in Bun

### 7.2 Authentication

- Native CLI and Swift clients send `Authorization: Bearer <access-token>` on
  the WebSocket upgrade.
- The gateway verifies issuer, audience, signature, expiration, subject, and
  required account/tenant claims.
- Authorization identity comes only from the verified token.
- Tokens are never accepted in URL query parameters.
- Access tokens are not written to logs, billing rows, profiles, or responses.
- Expiring tokens produce a stable notification so the client can refresh or
  reconnect.

### 7.3 Initial methods

```text
initialize
profile/list
profile/get
run/authorize
model/generate
tool/execute
request/cancel
account/usage
```

The gateway must not expose:

```text
agent/run
agent/chat
run/resume
run/retry
run/recover
runtime/initialize
runtime/shutdown
cli/execute
```

### 7.4 Initialization result

The result advertises:

- protocol version
- server version
- supported inference tiers
- supported stream event versions
- supported profile schema versions
- available remote tool names and schema versions
- structured-output support
- cancellation support
- attachment and message limits
- account-level permitted modes and tier ceiling

### 7.5 Run authorization

`run/authorize` is a fail-fast entitlement and billing-correlation operation,
not the only security boundary.

Input includes:

- client run ID
- inference mode
- requested tier
- pinned profile references

Result includes:

- opaque permit ID
- approved inference mode and tier
- route-policy version
- allowed remote capabilities
- expiration

Every `model/generate` and `tool/execute` still revalidates the authenticated
principal, entitlement, permit, and capability. Local and BYOK execution cannot
be made tamper-proof because the client owns the process.

### 7.6 Model streaming

The client sends one `model/generate` request with a stable `callId`. The server
emits correlated notifications:

```json
{
  "jsonrpc": "2.0",
  "method": "model/stream",
  "params": {
    "callId": "run:step:model:attempt",
    "seq": 12,
    "event": {
      "type": "text_delta",
      "delta": "next text"
    }
  }
}
```

The terminal JSON-RPC response contains the fully assembled `ModelResponse`.
Initially, `GatewayModelAdapter.generate()` consumes notifications internally.
No gateway protocol change is required when Phase 9 exposes these events to
core and desktop clients.

### 7.7 Idempotency and billing

- Model calls use authenticated account ID plus `callId` as the idempotency
  key.
- Tool calls use authenticated account ID plus core
  `ToolContext.idempotencyKey`.
- Active and terminal model results are retained in a short-lived ephemeral
  cache long enough for reconnect and retry.
- Repeating an identical completed call returns the cached terminal response
  and does not add a second billable usage row.
- Reusing a call ID with a different request hash returns an idempotency
  conflict.
- A unique billing constraint prevents duplicate terminal billing records.
- Prompt, response, and page content are not persisted in the billing ledger.

### 7.8 Stable public errors

Error data must include:

- stable gateway code
- retryable boolean
- optional retry delay
- call ID or tool idempotency key when safe
- trace ID

Required error classes include:

- unauthenticated
- token expired
- forbidden
- tier not entitled
- capability not entitled
- invalid params
- idempotency conflict
- quota exceeded
- rate limited
- provider unavailable
- provider timeout
- cancelled
- internal error

Provider response bodies, credentials, and internal route configuration must
not be exposed.

## 8. Server Profile Contract

### 8.1 Storage

Server profiles live in a deployment-controlled filesystem manifest. They are
not user-created or user-edited records.

Each manifest entry includes:

- profile ID
- version
- content hash
- relative config path
- allowed inference tiers or tier ceiling
- allowed remote capabilities
- referenced declarative delegates

The gateway validates all entries at startup and omits or fails on invalid
entries according to explicit startup policy.

### 8.2 Declarative-only rule

A server profile bundle is invalid if the profile or any transitive delegate
contains:

- `handler`
- `handlerTools`
- executable module paths
- installation commands
- package-manager hooks
- arbitrary scripts
- inline credentials

Server bundles may include only profile/delegate instructions, tool names,
allowed tools, defaults, limits, recovery policy, routing metadata, and
capability declarations.

Local profiles and local delegates may retain locally installed handlers. The
server-distribution prohibition does not alter trusted local profile behavior.

### 8.3 Client caching and resume

- Profile references use explicit `server:` or `local:` source namespaces.
- Remote bundles are retrieved by ID/version/content hash.
- The client verifies the hash before use.
- The exact resolved profile and delegate bundle is cached locally.
- A run persists the profile pins in protected execution context.
- Resume must use the pinned cached bundle, not the latest server profile.
- Missing pinned bundles produce an actionable recovery error rather than
  silently selecting a newer profile.

## 9. Web Capability Contract

### 9.1 Local direct page fetch

Ordinary direct HTTP page fetching remains the local `read_web_page` tool. It
does not pass through the gateway and does not require a server API key.

### 9.2 Gateway search

The gateway may expose allowlisted key-backed providers such as Brave, Serper,
or Parallel Search. Provider selection remains server-owned.

### 9.3 Gateway Parallel extraction

The gateway may expose Parallel extraction under the logical
`read_web_page@1` capability. Parallel, not the gateway process, retrieves the
target URL.

The gateway must:

- permit only `http:` and `https:` URLs
- reject embedded URL credentials
- bound URL length, batch size, timeout, and response size
- enforce account quotas and concurrency
- pass cancellation where supported
- avoid logging page contents
- record provider request ID, duration, usage, cost, and cache status
- enforce tool idempotency

No general-purpose server-side direct fetcher or dedicated fetch worker is in
scope.

## 10. Local SQLite Runtime

Add an embedded durable runtime mode to core and Agent SDK.

```ts
type RuntimeMode = 'memory' | 'sqlite' | 'postgres';
```

SQLite must implement:

- `RunStore`
- `EventStore`
- `SnapshotStore`
- `ToolExecutionStore`
- `PlanStore`
- `ContinuationStore`
- `RuntimeTransactionStore`
- recovery candidate scanning required by current runtime behavior

Requirements:

- WAL mode
- foreign keys enabled
- bounded busy timeout
- explicit migrations and schema version
- optimistic run version checks
- deterministic event sequencing
- lease acquisition, heartbeat, and release
- atomic run/event/snapshot boundaries
- atomic delegate child spawn and parent transition
- atomic tool execution state transitions
- safe process shutdown and database close

SQLite is the default desktop durable mode. Memory remains explicit and
ephemeral. PostgreSQL behavior remains supported and unchanged except for the
new execution-context persistence column.

## 11. Phased Implementation

### Phase 0: Freeze gateway and execution contracts

**Status:** Completed.

**Outcome:** AmpCode has stable names, ownership boundaries, and wire contracts
before implementation begins.

#### US-001: Create gateway protocol package

**Description:** As an implementer, I need transport-neutral protocol types and
validators so client and server cannot drift.

**Tasks:**

- Add `packages/gateway-protocol`.
- Define protocol version `1.0` as a string.
- Define JSON-RPC request, response, notification, ID, and error types.
- Define all Phase 2 method parameter/result types.
- Define normalized model stream events and sequence rules.
- Define profile refs, inference modes, and inference tiers.
- Define bounded runtime validators without importing Agent SDK.
- Add protocol fixtures for success and every public error class.

**Acceptance criteria:**

- [x] Client and server can import one protocol source of truth.
- [x] Validators reject batches, binary-equivalent inputs, invalid IDs,
      unsupported methods, unknown tiers, oversized fields, and malformed
      stream envelopes.
- [x] Protocol package has no runtime/network/provider dependencies.
- [x] `bun run build`, `bun run typecheck`, and focused tests pass.

#### Phase 0 gate

- [x] Protocol names, tier spelling, profile reference shape, idempotency behavior,
  and error taxonomy are reviewed before Phase 1.

### Phase 1: Add protected execution context and expose provider streams

**Status:** Completed.

**Outcome:** Core can safely carry gateway policy, generate stable call IDs,
and expose normalized provider streams without changing final run behavior.

#### US-002: Persist and inherit protected execution context

**Tasks:**

- Extend core run, request, model, tool, in-memory store, and Postgres store
  types.
- Add the next numbered core Postgres migration for execution context.
- Copy parent execution context into delegate child runs.
- Preserve it through retry, recovery, resume, and continuation.
- Propagate it through core swarm and Agent SDK orchestration paths.
- Reject non-JSON execution context at execution time.
- Ensure it is not included in provider message content or ordinary metadata.

**Acceptance criteria:**

- [x] A delegate payload that attempts to supply another tier or permit cannot
      alter the child execution context.
- [x] Retry, continuation, swarm stages, and orchestration stages retain the
      original context.
- [x] Existing metadata behavior remains unchanged.
- [x] Existing memory and Postgres tests pass.

#### US-003: Add deterministic model invocation context

**Tasks:**

- Add invocation context to every normal model turn and output-repair call.
- Make IDs stable across recovery of the same logical attempt.
- Include call ID and attempt in model lifecycle logs/events where safe.
- Add tests for normal turns, retries, output repair, child runs, and recovery.

**Acceptance criteria:**

- [x] The same recovered logical attempt produces the same call ID.
- [x] A new deliberate attempt produces a different call ID.
- [x] Output repair never collides with the main model turn.

#### US-004: Make adapter streaming reusable

**Tasks:**

- Expand normalized `ModelStreamEvent` types.
- Refactor applicable provider adapters so streaming is the primary parser and
  `generate()` assembles the same final response from it.
- Preserve request gates, retries, timeout, abort, tool aliasing, structured
  output, and usage behavior.
- Provide a synthetic start/done stream for adapters that cannot expose
  provider deltas yet.
- Do not change `AdaptiveAgent` to publish live deltas in this phase.

**Acceptance criteria:**

- [x] Existing `generate()` adapter tests remain behaviorally identical.
- [x] Stream tests reconstruct the same final `ModelResponse` as `generate()`.
- [x] Partial tool calls are never exposed as executable complete calls.
- [x] Cancellation terminates provider consumption promptly.
- [x] No raw reasoning/chain-of-thought is forwarded.

#### Phase 1 gate

- [x] Core, Agent SDK, swarm, and desktop-bridge existing suites pass.
- [x] Postgres migration compatibility is verified.

### Phase 2: Build the authenticated model gateway vertical slice

**Status:** Completed and manually tested.

**Outcome:** An authenticated client can request one tier-routed model call,
receive WSS stream events and a final response, and produce one billing row.

#### US-005: Bootstrap capability gateway

**Tasks:**

- Add `packages/capability-gateway` with Bun-native `Bun.serve` WSS handling.
- Accept upgrades only at `/rpc`.
- Add JWT/JWKS or configured HMAC verification using `jose`.
- Enforce connection, payload, in-flight request, idle, and backpressure limits.
- Add graceful shutdown and provider-client cleanup.
- Add metadata-only structured logging.

**Acceptance criteria:**

- [x] Missing, expired, wrong-audience, and wrong-issuer tokens are rejected.
- [x] Non-`/rpc`, non-upgrade, binary, and oversized inputs are rejected.
- [x] A valid principal can initialize exactly once per connection.
- [x] Shutdown stops upgrades and drains or cancels bounded in-flight work.

#### US-006: Add tier router and model provider execution

**Tasks:**

- Define a server-owned route-policy configuration file.
- Map each tier to ordered provider/model targets and limits.
- Validate model capabilities against tools, structured output, and input
  modalities before invoking a provider.
- Reuse provider clients and enforce per-provider concurrency.
- Forward normalized stream events with `callId` and `seq`.
- Return actual provider/model, provider response ID, usage, route-policy
  version, timings, and final output.

**Acceptance criteria:**

- [x] Clients cannot name a concrete provider/model in gateway mode.
- [x] Tier entitlement is enforced before provider invocation.
- [x] Configured fallback is deterministic and observable.
- [x] The final response can be reconstructed from stream events.
- [x] Actual route and usage are returned without exposing credentials.

#### US-007: Add permits, idempotency, and billing ledger

**Tasks:**

- Add a minimal `run/authorize` permit service.
- Add billing/usage store interfaces and a Postgres implementation.
- Persist only actor, permit, capability, call ID, request hash, tier, route,
  provider/model, usage, cost, status, and timestamps.
- Add a unique account/call ID constraint.
- Add a single-instance in-memory active/terminal result cache for the MVP.
- Detect request-hash conflicts.
- Commit terminal usage before returning billable completion.

**Acceptance criteria:**

- [x] Repeating an identical completed call returns the same final response
      with no second provider invocation or billing row.
- [x] Reusing the call ID with different content is rejected.
- [x] No prompt, model output, tool output, page content, API key, or access
      token is present in billing storage.
- [x] Failed and cancelled calls have explicit billing states.

#### Phase 2 gate

- [x] A protocol test client completes a real or stubbed tier-routed model call.
- [x] A forced WSS disconnect followed by retry with the same call ID produces one
  provider invocation and one billing record within the same gateway process.

### Phase 3: Add gateway client and Agent SDK integration

**Outcome:** A normal local core run uses gateway inference while core remains
the execution authority.

#### US-008: Implement reusable gateway client

**Tasks:**

- Add `packages/gateway-client`.
- Implement connection, initialize, correlation, sequence checks, reconnect,
  timeout, cancellation, and token-provider callbacks.
- Implement `GatewayModelAdapter`.
- Make `generate()` consume `model/stream` notifications and return the final
  `ModelResponse`.
- Reissue the same call ID after eligible transport failures.
- Normalize gateway errors to core failure kinds without leaking internals.

**Acceptance criteria:**

- [x] Concurrent model requests do not cross streams.
- [x] Missing, duplicate, and out-of-order sequences are diagnosed.
- [x] Abort signals issue cancellation and stop local consumption.
- [x] Reconnect uses the original call ID.
- [x] Final usage includes actual server-selected provider/model.

#### US-009: Add Agent SDK inference modes and run tiers

**Tasks:**

- Add `InferenceMode` and `InferenceTier` to Agent SDK APIs.
- Add a model-adapter injection path to `AgentSdk.create`.
- Resolve gateway URL and non-secret connection settings from local settings.
- Request a run permit before an official-client run starts.
- Place permit, tier, route policy, and profile pins in protected execution
  context.
- Propagate the context through run, chat, swarm, and orchestration entrypoints.
- Add CLI options for inference mode and tier without adding gateway concepts
  to core.

**Acceptance criteria:**

- [x] Two runs using one SDK instance may select different tiers safely.
- [x] A local core run completes using only the gateway model adapter.
- [x] Local file tools execute on the client during the remote-model run.
- [x] Gateway unavailability produces an actionable client error.
- [x] Access tokens are absent from logs, events, and run inspection.

#### Phase 3 architecture-validation gate

This is the earliest full validation of the architecture. Do not expand scope
until all of the following pass:

- A CLI run executes locally with a memory runtime and gateway inference.
- The model calls a local file tool and receives its result on the next gateway
  inference turn.
- The gateway has no run/session/snapshot/artifact record.
- Local events include call ID, requested tier, actual route, usage, and trace
  correlation.
- Disconnect/retry does not duplicate billing.

### Phase 4: Add embedded SQLite durability

**Outcome:** Desktop runs survive process loss without PostgreSQL.

#### US-010: Implement SQLite runtime stores

**Tasks:**

- Add SQLite migrations and all required core store implementations.
- Use `bun:sqlite`, WAL, foreign keys, and explicit transactions.
- Mirror existing memory/Postgres behavioral contracts rather than copying
  Postgres-specific SQL mechanically.
- Add a shared conformance suite that can run against memory, SQLite, and
  Postgres stores where semantics overlap.
- Add SQLite lifecycle wiring in Agent SDK.

**Acceptance criteria:**

- [ ] Create, update, version conflict, lease, event sequencing, snapshot,
      continuation, plan, and tool idempotency tests pass.
- [ ] Delegate child spawn and parent transition are atomic.
- [ ] Killing a process mid-run and reopening the database yields a valid
      recovery candidate.
- [ ] Resume does not rerun a completed idempotent local or gateway tool.
- [ ] SQLite is selectable without `DATABASE_URL`.

#### Phase 4 gate

- Repeat the Phase 3 end-to-end run using SQLite.
- Kill and resume during a delegated run and during a gateway transport retry.

### Phase 5: Add key-backed remote web capabilities

**Outcome:** Local agents can use server-owned search and Parallel extraction
keys without moving general page fetching to the server.

#### US-011: Add gateway `tool/execute`

**Tasks:**

- Add allowlisted, versioned `web_search@1` and `read_web_page@1` operations.
- Route search to configured key-backed providers.
- Route page extraction only to Parallel or another explicit key-backed
  extraction provider.
- Validate inputs, permissions, quotas, idempotency, and output bounds.
- Return provider accounting and diagnostics separately from model-visible
  output.

**Acceptance criteria:**

- [ ] Arbitrary server tool names are rejected.
- [ ] Direct fetch is not implemented by the gateway.
- [ ] Duplicate tool idempotency keys do not duplicate provider charges.
- [ ] Page/search content is not written to server logs or billing storage.

#### US-012: Add Agent SDK proxy tools

**Tasks:**

- Implement gateway proxy `ToolDefinition`s with the current local tool names
  and compatible schemas/results.
- Use provided-tool override behavior to replace only configured remote tools.
- Keep local direct `read_web_page` available as an explicit local mode.
- Preserve core timeout, abort, budgets, capture, formatting, and tool
  execution persistence.

**Acceptance criteria:**

- [ ] A profile can use gateway search and local direct page fetch together.
- [ ] A profile can use gateway Parallel extraction when configured.
- [ ] Core persists the result and tool idempotency record locally.
- [ ] Provider cost appears in gateway billing and local diagnostics.

### Phase 6: Add declarative server profile distribution

**Outcome:** Authorized clients can select immutable server profiles without
executing server-delivered handlers.

#### US-013: Build validated filesystem profile registry

**Tasks:**

- Add a server manifest loader with version/content-hash verification.
- Resolve all transitive declarative delegates at startup.
- Reject handlers, handler tools, scripts, credentials, and unresolved tools.
- Enforce profile-specific tier ceilings and remote capabilities.
- Implement `profile/list` and `profile/get`.

**Acceptance criteria:**

- [x] A handler in any transitive delegate rejects the entire bundle.
- [x] Content-hash mismatch prevents distribution.
- [x] Responses contain no server paths or secrets.
- [x] Unauthorized profiles are non-enumerable.

#### US-014: Add Agent SDK server profile resolver and cache

**Tasks:**

- Add explicit `server:` and `local:` resolution.
- Download, validate, hash-check, and cache server bundles.
- Persist profile pins and retain bundle versions needed by local runs.
- Validate resolved tools/delegates against the local executable registry.
- Provide clear offline/missing-version diagnostics.

**Acceptance criteria:**

- [x] Ambiguous unqualified local/server IDs are rejected.
- [x] A cached pinned profile can resume while the gateway is unavailable.
- [x] A newer server version is not silently substituted during resume.
- [x] Server profiles cannot install or invoke downloaded code.

### Phase 7: Integrate the local desktop bridge and Swift host

**Status:** Completed.

**Outcome:** A Swift app controls the durable local runtime while the sidecar
uses the gateway for authorized capabilities.

#### US-015: Extend local desktop protocol

**Tasks:**

- Add inference mode, inference tier, and explicit profile ref to local run and
  chat methods.
- Report SQLite and gateway connection state through runtime inspection.
- Add an in-memory access-token update/refresh mechanism suitable for a Swift
  host; never persist or log the token.
- Preserve existing local JSON-RPC handshake and event behavior.
- Version the desktop protocol for additive fields and methods.

**Acceptance criteria:**

- [x] Swift can initialize a SQLite runtime and start a gateway-backed run.
- [x] Token replacement does not require rebuilding the runtime.
- [x] Tokens do not appear in protocol diagnostics or local persistence.
- [x] Artifact paths and writes remain local.
- [x] Existing stdio CLI-child isolation remains intact.

#### Phase 7 gate

- Build the compiled sidecar and run a protocol smoke test that writes a local
  artifact using remote inference.

### Phase 8: Add local model and direct BYOK modes

**Outcome:** Authorized official clients can use client-owned providers without
sending inference through the gateway.

#### US-016: Select local and BYOK adapters

**Tasks:**

- Retain existing Ollama and direct provider adapters.
- Resolve client credentials from local secure configuration/environment, not
  server profiles.
- Require official clients to obtain a run permit before starting when online
  authorization policy requires it.
- Record inference mode and permit locally.
- Treat client-reported usage as non-authoritative telemetry.

**Acceptance criteria:**

- [x] Local and BYOK prompts do not reach the gateway after authorization.
- [x] Provider keys do not reach the gateway in direct BYOK mode.
- [x] Gateway billing does not claim authoritative token usage for direct work.
- [x] Documentation states that a modified local client can bypass local
      authorization enforcement.

### Phase 9: Expose existing gateway streams to core and desktop UIs

**Outcome:** CLI and Swift clients render model output incrementally without
changing the gateway wire protocol.

#### US-017: Consume model streams in the core loop

**Tasks:**

- Make the core loop call `ModelAdapter.stream()` when available.
- Emit live-only normalized model delta events.
- Assemble and validate the same final `ModelResponse` used by non-streaming
  runs.
- Persist lifecycle, usage, final response, and snapshots, but not token
  deltas by default.
- Preserve generate-only adapter compatibility.

**Acceptance criteria:**

- [ ] Streaming and non-streaming paths produce equivalent final run state.
- [ ] SQLite growth is not proportional to token-delta count.
- [ ] Tool calls execute only after complete validated arguments.
- [ ] Cancellation is reflected in both live stream and durable run status.

#### US-018: Forward live deltas through desktop bridge

**Tasks:**

- Add desktop notifications for normalized model stream events.
- Preserve call ID and sequence.
- Coalesce small deltas under backpressure without dropping terminal events.
- Document that missed live deltas are not replayed; final local run state is
  replayable.

**Acceptance criteria:**

- [ ] Swift receives ordered deltas for the active run.
- [ ] A slow client does not block core execution indefinitely.
- [ ] Reconnecting clients can inspect the final run even if deltas were lost.

### Phase 10: Production hardening and multi-instance rollout

**Outcome:** The stateless capability gateway can scale horizontally while
preserving idempotency, billing correctness, and observability.

#### US-019: Add distributed ephemeral call state

**Tasks:**

- Replace the single-instance result cache with Redis or equivalent TTL state.
- Store active-call ownership, request hash, terminal response, sequence
  cursor, and expiration only.
- Encrypt cached terminal responses if operational requirements demand it.
- Keep durable billing uniqueness in PostgreSQL.

**Acceptance criteria:**

- [ ] Reconnect to another gateway instance can recover a terminal response.
- [ ] Multi-instance retries create one billable usage record.
- [ ] Expired cache entries do not affect durable billing auditability.

#### US-020: Add production routing and telemetry

**Tasks:**

- Add circuit breakers, provider cooldown, health-aware fallback, and bounded
  retries.
- Add OpenTelemetry trace propagation from local run to provider request.
- Add dashboards for latency, first-token time, completion time, errors,
  retries, route distribution, active calls, cache hits, tokens, and cost.
- Add quota, rate-limit, and abuse alerts.
- Add billing reconciliation against provider usage reports.

**Acceptance criteria:**

- [ ] Every billable call is traceable from local call ID to billing row and
      provider response ID.
- [ ] Logs contain no request/response bodies under default policy.
- [ ] Route failover is visible and testable.
- [ ] Provider invoice samples reconcile within a documented tolerance.

## 12. Functional Requirements

- FR-1: The authoritative agent runtime and run state must remain local.
- FR-2: Every gateway connection must authenticate before capability use.
- FR-3: Every remote capability call must revalidate entitlement.
- FR-4: The client must choose one supported inference tier per top-level run.
- FR-5: Tier and authorization must propagate through all derived runs without
  using model-controlled metadata.
- FR-6: The gateway must own provider/model selection in gateway mode.
- FR-7: Model calls must be idempotent across eligible reconnect retries.
- FR-8: Billing must have one terminal record per unique billable call.
- FR-9: Gateway provider streams must be available from the first model
  vertical slice.
- FR-10: Initial core execution may consume only the final assembled response.
- FR-11: Core/UI-visible model streaming must reuse the existing gateway wire
  stream.
- FR-12: Local file and artifact tools must never execute on the gateway.
- FR-13: Direct public page fetching must remain local.
- FR-14: Gateway page extraction must use an explicit key-backed provider such
  as Parallel.
- FR-15: Server profiles must be immutable, hash-pinned, declarative filesystem
  assets.
- FR-16: Server profile bundles containing executable handlers must be
  rejected.
- FR-17: The client must cache the exact server profile bundle needed to resume
  a local run.
- FR-18: Desktop durability must not require PostgreSQL.
- FR-19: Direct BYOK credentials must remain on the client.
- FR-20: The gateway must not persist runs, conversations, artifacts, prompts,
  model outputs, or page contents.

## 13. Non-Functional Requirements

### 13.1 Performance

- Reuse one authenticated WSS connection for concurrent calls.
- Reuse upstream provider clients and connection pools.
- Apply explicit backpressure and concurrency limits.
- Track first-event, first-token, and terminal latency.
- Avoid a database write per stream delta.
- Cache profile bundles by content hash and ETag.
- Keep model/tool result sizes bounded.

### 13.2 Extensibility

- Version protocol, profile, stream, and tool schemas independently.
- Add providers through route/provider registries without changing the core
  agent loop.
- Add remote tools only through an explicit gateway allowlist.
- Preserve custom local `ModelAdapter` and `ToolDefinition` injection.
- Ignore unknown additive diagnostic fields while rejecting unknown required
  protocol versions.

### 13.3 Debuggability

Every capability call should correlate:

- account/tenant ID
- local session ID where safely supplied
- run ID and root run ID
- step ID
- tool call ID
- model call ID
- permit ID
- route-policy version
- actual provider/model
- upstream provider response ID
- trace ID

Gateway logs contain metadata, sizes, timings, and error classes only. Client
logs follow existing capture/redaction policy.

### 13.4 Privacy and security

- Gateway inference necessarily sees model-visible messages sent for remote
  inference.
- Local artifact paths must not be sent merely for correlation.
- Only artifact content explicitly included in model context may transit the
  gateway.
- Access tokens and provider keys must never enter run persistence.
- Server profile responses must not expose filesystem paths.
- Public errors must not expose upstream response bodies or route secrets.

## 14. Non-Goals

- Server execution of AdaptiveAgent runs
- Server run/session/snapshot/plan persistence
- Server artifact upload or storage
- Gateway access to local files or shell
- Generic remote CLI execution
- Generic server-side direct URL fetching
- Server-distributed executable profile handlers
- User-created or user-edited server profile records
- Offline tamper-proof authorization of user-controlled local models
- Authoritative server metering of direct local/BYOK provider usage
- DAG execution, parallel child runs, or child messaging changes
- A separate `swarmId`

## 15. Verification Commands

Use touched-package Bun-native checks. Exact scripts may be added by the phase
that creates each package.

```sh
bun run --cwd packages/core build
bun run --cwd packages/core test

bun run --cwd packages/agent-sdk typecheck
bun run --cwd packages/agent-sdk test

bun run --cwd packages/desktop-bridge typecheck
bun run --cwd packages/desktop-bridge test

bun run --cwd packages/gateway-protocol typecheck
bun run --cwd packages/gateway-protocol test

bun run --cwd packages/gateway-client typecheck
bun run --cwd packages/gateway-client test

bun run --cwd packages/capability-gateway typecheck
bun run --cwd packages/capability-gateway test
```

For shared contract or persistence changes, run all affected package suites.
Do not suppress unrelated failures; report them with their pre-existing status.

## 16. AmpCode Execution Guidance

1. Implement one phase at a time.
2. Start every phase by reading the current files named in that phase; do not
   assume this plan reflects later code changes.
3. Preserve behavior while refactoring provider streaming, verify, and only
   then add gateway behavior.
4. Keep core free of Agent SDK, JWT, billing, and gateway package imports.
5. Do not bypass core validation because Agent SDK or protocol validation ran.
6. Do not add server run persistence as a shortcut for reconnect handling.
7. Do not put tokens or permits into ordinary metadata.
8. Do not implement general server-side fetch while adding Parallel extraction.
9. Do not accept server profiles with handlers under a warning or confirmation
   flow; reject them.
10. At each phase gate, record:
    - files changed
    - contracts changed
    - migrations added
    - focused and broader verification results
    - unresolved risks
    - whether the next phase is unblocked

## 17. Success Metrics

- A gateway-backed run executes entirely in the local runtime.
- A local tool can be called between two remote inference turns.
- A local artifact can be created without server artifact storage.
- SQLite restart recovery does not duplicate completed tools.
- A WSS disconnect/retry produces one provider call and one billing row within
  the supported idempotency window.
- Requested tier and actual provider/model are both visible locally.
- Server profile resume uses the pinned cached bundle.
- Server storage inspection finds no run, prompt, response, page, or artifact
  content.
- Direct BYOK and local-model modes send no inference body to the gateway.
- Later UI streaming requires no gateway protocol redesign.

## 18. Open Decisions Before Production Rollout

These do not block the Phase 3 architecture-validation milestone:

1. Production OIDC provider and native login/device-flow UX.
2. Exact tier-to-provider/model route table and account plan limits.
3. Billing currency, markup, rounding, credits, and invoice integration.
4. Permit lifetime and refresh policy for very long local runs.
5. Distributed cache technology and terminal-response encryption policy.
6. Local profile-cache retention and garbage collection policy.
7. Final Swift access-token handoff and refresh callback contract.
8. Whether direct local page fetch is allowed to access private/intranet hosts
   and which local approval policy applies.
