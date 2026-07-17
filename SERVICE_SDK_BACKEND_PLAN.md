# Service SDK and Backend Implementation Plan

## Purpose

Build a production service around Adaptive Agent while preserving the existing runtime and CLI architecture.

The service must:

- Accept jobs through HTTP and WebSocket.
- Execute run, chat, swarm, and orchestration workloads asynchronously.
- Persist authoritative state in PostgreSQL.
- Stream durable, replayable progress events.
- Deliver state-change webhooks reliably.
- Make generated artifacts available only to the user who initiated the job.
- Reuse `@adaptive-agent/agent-sdk` and `@adaptive-agent/core` rather than invoking CLI subprocesses.

This plan is intentionally phased. Each phase has an explicit boundary and exit criteria so the system can be validated before the next reliability layer is added.

## Fixed Architecture Decisions

### Package responsibility

- `@adaptive-agent/core` continues to own runtime semantics: runs, sessions, child runs, leases, retries, continuation, snapshots, events, persistence, and execution-time validation.
- `@adaptive-agent/agent-sdk` continues to own agent-profile resolution, coordinator and decomposer setup, safe agent catalogs, prompt construction, and translation into strict core execution requests.
- `@adaptive-agent/service-sdk` owns service jobs, user ownership, service policy, queue commands, public event projection, artifact metadata, and webhook scheduling.
- The backend owns Fastify, HTTP, WebSocket connections, BullMQ, PostgreSQL adapters, object-storage adapters, authentication integration, and process entrypoints.
- The CLI remains a local adapter over Agent SDK. It must not depend on Service SDK.

The dependency direction is:

```text
CLI ---------------------------> Agent SDK ------> Core
                                      ^
                                      |
HTTP / WebSocket -> Service SDK ------+
```

### CLI-only capabilities

The following remain local CLI capabilities and are not exposed through Service SDK, HTTP, or WebSocket:

- `agent-create`
- `ambient`
- `catalog`
- `doctor`
- `init`
- `config`
- `update`
- `uninstall`

The backend still needs an internal allowlisted agent registry and normal readiness probes. Those are service infrastructure, not public versions of the local CLI commands.

### Service capabilities

The initial service-facing capabilities are:

- Run.
- Chat.
- Swarm run.
- Orchestrated run.
- Job inspection and event replay.
- Interrupt and cancellation.
- Steering.
- Retry, recovery, continuation, and resume.
- Approval and clarification.
- Result and artifact access.

### Persistence and dispatch

- PostgreSQL is the system of record for jobs, users, ownership, core runs, events, artifacts, outbox records, and webhook deliveries.
- BullMQ with Redis or Valkey provides dispatch, retry scheduling, delayed work, concurrency control, and worker scaling.
- Queue messages carry an opaque `jobId`; workers reload authoritative data from PostgreSQL.
- Job creation and outbox insertion occur in one PostgreSQL transaction.
- Queue delivery is treated as at least once. Service and runtime operations must be idempotent.

### Job and run terminology

A service `job` is an external product artifact. It does not replace a core `run`.

- One simple job may map to one root run and its child runs.
- One swarm job may map to a coordinator run, worker runs, a quality run, a synthesizer run, and their child runs.
- `sessionId` groups related runs.
- `coordinatorRunId` identifies a swarm execution within the session.
- No separate `swarmId` is introduced.

## Target Architecture

```text
End users and integrations
          |
          | HTTPS / WSS
          v
Load balancer / WAF / TLS
          |
          v
Bun + Fastify API and WebSocket instances
          |
          | Service SDK operations
          v
PostgreSQL <---- outbox dispatcher ----> BullMQ / Redis or Valkey
    ^                                        |
    |                                        v
    +------------- Agent worker fleet ------+
    |                  |
    |                  v
    |             Agent SDK -> Core
    |
    +---- event projector ----> live pub/sub ----> WebSocket instances
    |
    +---- webhook outbox -----> webhook workers -> customer endpoints
    |
    +---- artifact metadata <-- private object storage <-- job workers
```

The API and workers are separate processes. An HTTP or WebSocket handler never executes a long-running agent job inline.

## Phase 0: Freeze Contracts and Boundaries

### Objective

Agree on public behavior, ownership, and terminology before implementation starts.

Phase 0 produces design contracts only. It does not patch the CLI or add runtime code.

### Deliverables

- Define service operations:
  - Submit run.
  - Submit chat.
  - Submit swarm run.
  - Submit orchestrated run.
  - Inspect job.
  - Cancel or interrupt.
  - Retry, recover, resume, or continue.
  - Steer a run.
  - Resolve approval or clarification.
  - List events and artifacts.
- Define the service job state machine.
- Define versioned request, result, error, event, and artifact contracts.
- Define idempotency semantics for submission and control operations.
- Define `jobId`, `sessionId`, `runId`, `rootRunId`, and `coordinatorRunId` correlation rules.
- Define tenant and exact initiating-user ownership rules.
- Define retention rules for jobs, public events, raw events, artifacts, and webhook attempts.
- Define limits for request size, attachments, artifacts, active jobs, swarm concurrency, token usage, and cost.
- Produce a threat model covering:
  - Cross-user job, event, and artifact access.
  - Arbitrary agent or tool configuration.
  - Worker filesystem and network isolation.
  - Queue duplicate delivery.
  - Webhook SSRF.
  - Credential and secret leakage.
- Record the CLI-only command boundary.

### Exit criteria

- Package responsibilities and dependency direction are documented.
- Public service types do not depend on CLI parser types.
- The job state machine and public event envelope are agreed.
- Ownership is based on verified principals and database records, not client metadata.
- No code changes are required to complete the phase.

## Phase 1: Promote Swarm Run into a Public Agent SDK API

### Objective

Create one reusable Agent SDK implementation of swarm execution before the backend uses it.

The current CLI sequence for agent loading, decomposition, subtask validation, bounded worker execution, quality checking, and synthesis should become a first-class Agent SDK facade, referred to in this plan as `SwarmSdk`.

### Deliverables

- Add a transport-neutral Agent SDK swarm API with operations equivalent to:
  - Create or initialize the swarm facade.
  - Run a top-level objective.
  - Inspect a swarm session.
  - Retry a swarm session.
  - Close owned resources.
- Move command-independent swarm assembly behind this API:
  - Coordinator profile resolution.
  - Worker profile resolution.
  - Worker catalog construction.
  - Duplicate worker ID validation.
  - Coordinator decomposition.
  - Structured subtask parsing.
  - SDK-level subtask validation.
  - Default quality and synthesizer profile construction.
  - Shared runtime creation and reuse.
  - Core `SwarmCoordinator` construction.
  - Worker, quality, and synthesizer execution.
- Emit structured lifecycle events for decomposition and all execution phases.
- Expose enough inspection data to identify completed, active, waiting, failed, and retryable phases.
- Refactor the CLI to call `SwarmSdk` while retaining:
  - Argument parsing.
  - Local file and attachment loading.
  - Terminal interaction.
  - Pretty, JSON, and JSONL rendering.
  - Exit-code selection.

### Reliability requirement

The new API must allow a service worker to determine whether it should:

- Start decomposition.
- Recover or resume an existing coordinator run.
- Continue from validated subtasks.
- Resume partially completed worker execution.
- Retry failed worker, quality, or synthesizer runs.
- Return an already completed result.

Core remains responsible for validating prepared subtasks before execution.

### Exit criteria

- Existing CLI behavior and tests pass.
- The CLI no longer assembles swarm execution itself.
- Agent SDK exports stable swarm request, result, inspection, and retry types.
- Swarm agents share one runtime without opening one PostgreSQL pool per agent.
- Agent SDK remains independent of Service SDK.

## Phase 2: Build the Service SDK Domain and PostgreSQL Model

### Objective

Create a transport-independent application layer for asynchronous service jobs.

### Package shape

`@adaptive-agent/service-sdk` should expose application services and dependency interfaces. It should not import Fastify, hold WebSocket connections, or instantiate BullMQ directly.

Initial dependency interfaces should cover:

- Job storage.
- Job-to-run links.
- Client request idempotency.
- Public service events.
- Outbox records.
- Queue publication.
- Agent registry resolution.
- Authorization policy.
- Artifact metadata and storage.
- Audit logging.
- Clock and ID generation.

### Service SDK operations

- `submitRun`
- `submitChat`
- `submitSwarmRun`
- `submitOrchestratedRun`
- `getJob`
- `cancelJob`
- `retryJob`
- `recoverJob`
- `resumeJob`
- `continueJob`
- `steerJob`
- `resolveApproval`
- `resolveClarification`
- `listEvents`
- `listArtifacts`

Every operation receives a verified service actor containing the authoritative user and tenant identity.

### PostgreSQL tables

Add service-owned tables for:

- Users and tenants.
- Service jobs.
- Job-to-run links.
- Client request idempotency.
- Public service events.
- Service outbox records.
- Audit records.

The service tables are an authorization and product model around the existing core runtime tables. User ownership is not added to `agent_runs` as the primary authorization mechanism.

### Core invariants

- Job and outbox rows are inserted in one transaction.
- Queue payloads do not contain trusted ownership or agent configuration.
- Agent selection uses server-owned allowlisted IDs.
- Jobs store agent IDs and profile versions or hashes, not copied model, tool, delegate, or instruction fields.
- Exact user ownership is enforced by constrained database queries.
- A job may link to multiple runs and run roles.

### Exit criteria

- Run, chat, swarm, and orchestration submissions work with in-process test adapters.
- PostgreSQL integration tests cover transactions, idempotency, and ownership.
- Repeated idempotency keys return the original job.
- Cross-user query and control attempts are rejected.
- Service SDK has no Fastify or Redis dependency.

## Phase 3: Add Queue Dispatch and Agent Workers

### Objective

Execute service jobs reliably outside API processes.

### Deliverables

- BullMQ queues backed by Redis or Valkey.
- A PostgreSQL outbox dispatcher.
- Deterministic queue job IDs.
- An agent worker process.
- A stale-job queue reconciler.
- Configurable queues and concurrency by workload class.
- Graceful shutdown and worker draining.
- Server-owned agent registry loading.
- Shared PostgreSQL core runtime per worker process.
- Per-job isolated workspace and base sandbox policy.

The first worker release should support:

- Run.
- Chat.
- Swarm run.
- Orchestrated run.

Control jobs should cover cancellation, retry, recovery, resume, continuation, steering, approval, and clarification.

### Redelivery behavior

Queue delivery is at least once. Before execution, a worker must inspect the authoritative job and linked core runs.

- If the service job is terminal, acknowledge without executing.
- If no run exists, start the requested operation.
- If a run is active, inspect its lease and recovery state.
- If a run is waiting for interaction, leave the job waiting.
- If a swarm is partially complete, inspect or retry the existing session.
- Never create a new root run merely because the queue message was delivered again.

### Swarm execution scope

Initially, one service worker may coordinate a swarm using the existing bounded worker concurrency. This provides horizontal scaling across swarm jobs while preserving current semantics.

Distributing each swarm subtask as a separate service queue job is deferred until workload measurements justify the additional orchestration and recovery complexity.

### Exit criteria

- Accepted jobs survive API, worker, and Redis restarts.
- Duplicate queue delivery does not create duplicate root runs.
- A killed worker can recover or retry existing execution.
- Redis unavailability leaves accepted jobs safely pending in PostgreSQL.
- Stale accepted or queued jobs are republished safely.
- Worker shutdown stops claiming new jobs and drains active work.

## Phase 4: Add the Authenticated HTTP Backend

### Objective

Expose Service SDK through a production-shaped HTTP API.

### Deliverables

- Bun and Fastify service entrypoint.
- OIDC or JWT authentication.
- Runtime request and response validation.
- OpenAPI documentation.
- Structured request logging and correlation IDs.
- Rate limits and payload limits.
- Liveness and readiness endpoints.

Initial endpoints should include:

```text
POST /v1/jobs/run
POST /v1/jobs/chat
POST /v1/jobs/swarm
POST /v1/jobs/orchestration

GET  /v1/jobs/:jobId
POST /v1/jobs/:jobId/cancel
POST /v1/jobs/:jobId/retry
POST /v1/jobs/:jobId/recover
POST /v1/jobs/:jobId/resume
POST /v1/jobs/:jobId/continue
POST /v1/jobs/:jobId/steer
POST /v1/jobs/:jobId/approval
POST /v1/jobs/:jobId/clarification

GET  /v1/jobs/:jobId/events
GET  /v1/jobs/:jobId/artifacts
```

Submission returns `202 Accepted` with a service `jobId`.

### Security requirements

- User and tenant identity come only from verified authentication.
- Every job route uses an ownership-constrained query.
- Unknown and unauthorized resources return non-enumerating errors.
- Clients cannot provide agent config paths, model credentials, tool lists, delegates, workspace roots, runtime modes, or approval defaults.
- Service policies bound agent IDs, allowed invocation modes, concurrency, cost, and tool risk.

### Exit criteria

- End-to-end HTTP submission and polling work for run, chat, swarm, and orchestration.
- Idempotent submission survives client retries.
- Cross-user authorization tests pass.
- API restarts do not affect worker execution.
- Attempts to override server-owned execution configuration are rejected.

## Phase 5: Add Durable Event Projection and WebSockets

### Objective

Provide real-time progress with reliable reconnect and replay.

### Deliverables

- A durable projector from core `agent_events` to public service events.
- Per-job monotonic public sequence numbers.
- Idempotent projection keyed by source event identity.
- Redis or Valkey pub/sub for low-latency live fanout.
- Authenticated WebSocket endpoint.
- Heartbeats, connection limits, and slow-client backpressure handling.
- HTTP event pagination as a recovery path.

Initial WebSocket operations should include:

- Submit job.
- Subscribe and unsubscribe.
- Cancel.
- Steer.
- Approve.
- Answer clarification.
- Receive job events and terminal results.

WebSocket submission invokes the same Service SDK methods as HTTP submission.

### Replay protocol

1. The client subscribes with its last received sequence.
2. The backend verifies exact job ownership.
3. The backend replays newer PostgreSQL events.
4. The backend transitions to live delivery without an event gap.
5. The client stores the public sequence as its replay cursor.

### Exit criteria

- Disconnect and reconnect recover all missed events.
- Multiple API instances receive live events.
- No connection can subscribe to another user's job.
- Duplicate core events do not create duplicate public events.
- Slow clients cannot exhaust process memory.
- Terminal results remain available over HTTP when live delivery fails.

## Phase 6: Add Private Artifact Management

### Objective

Make generated files available only to the user who initiated the job.

### Storage model

- Use private S3-compatible object storage in production.
- Use MinIO for local development and integration tests.
- Give each job an isolated workspace with a designated artifact output directory.
- Upload artifacts out of worker storage before making them available.
- Block all public object-storage access.
- Encrypt objects at rest and require TLS in transit.

### Artifact table

Add service-owned artifact metadata containing:

- Artifact ID.
- Tenant ID.
- Exact owner user ID.
- Job ID.
- Run ID and optional tool execution ID.
- Internal storage key.
- Original filename.
- Media type.
- Byte size.
- Content hash.
- Lifecycle status.
- Creation, availability, expiry, and deletion timestamps.

Lifecycle statuses should include:

- `uploading`
- `scanning`
- `available`
- `quarantined`
- `deleted`

Ownership is derived from the authoritative job row. It is never accepted from a client or trusted from a queue payload.

### Access model

For strict initiator-only access, the backend proxies object downloads after checking:

- The artifact belongs to the requested job.
- The job was initiated by the authenticated user.
- Tenant identity matches.
- The artifact is available.

Do not place storage keys or pre-signed URLs in public events, logs, or webhooks. WebSocket events carry artifact IDs and metadata only.

### Security controls

- Reject path traversal and workspace escape.
- Reject symbolic links that resolve outside the job workspace.
- Enforce file count and size quotas.
- Validate media type and safe content disposition.
- Quarantine artifacts that require scanning.
- Audit artifact download attempts.
- Reconcile abandoned uploads and orphaned objects.
- Delete or expire artifacts according to retention policy.

### Exit criteria

- Artifact-producing agents can be enabled safely.
- Cross-user artifact listing and download are denied.
- Worker files do not remain on shared host storage.
- Object storage is private and encrypted.
- Every download is authenticated, authorized, and audited.

## Phase 7: Add Webhook Subscriptions and Delivery

### Objective

Deliver selected job state changes reliably without blocking agent execution.

### Deliverables

Add service-owned tables for:

- Webhook endpoints.
- Webhook subscriptions and event filters.
- Webhook delivery attempts.

Add a separate webhook queue and worker with:

- HMAC signatures and timestamps.
- Stable event and delivery IDs.
- Exponential backoff with jitter.
- Attempt limits and dead-letter state.
- Delivery inspection and controlled redrive.
- Secret rotation.
- Response-code and duration auditing.

Webhook notifications originate from versioned public service events, not directly from raw core events.

Artifact entries in webhook payloads contain metadata and opaque IDs only. They do not contain object-storage paths, pre-signed URLs, or user credentials.

### Security controls

- Require HTTPS destinations.
- Block loopback, private, link-local, and cloud metadata destinations.
- Revalidate DNS to reduce rebinding risk.
- Disable redirects or revalidate every redirect target.
- Bound request duration, response size, and concurrency.
- Encrypt webhook secrets.

### Exit criteria

- Transient failures retry without affecting job state.
- Permanent failures become inspectable dead-letter deliveries.
- Duplicate queue delivery does not create uncontrolled duplicate effects.
- SSRF protections and signature verification tests pass.
- Webhook failure cannot block or fail an agent job.

## Phase 8: Production Hardening and Rollout

### Objective

Turn the functional service into a scalable and operable production system.

### Deployment

Build one immutable Bun image with separate process entrypoints for:

- API and WebSocket.
- Agent worker.
- Outbox dispatcher.
- Event projector.
- Webhook worker.
- Cleanup and reconciliation worker.

Provide:

- Docker Compose for development and integration testing.
- Kubernetes, ECS, or equivalent production deployment manifests.
- Managed multi-zone PostgreSQL with backups and point-in-time recovery.
- Managed Redis or Valkey with persistence, replication, failover, and `noeviction`.
- Private managed object storage.
- Controlled database migration jobs.
- Secret-manager integration.
- Graceful shutdown, readiness checks, and rollback procedures.

### Observability

Add structured logs, metrics, and traces for:

- Queue depth and oldest-job age.
- Job state counts and duration.
- Run lease expiry and recovery.
- Swarm phase duration and worker count.
- Token use and estimated cost.
- Event projection lag.
- WebSocket connections, drops, replay, and backpressure.
- Artifact upload, scan, and download failures.
- Webhook retries and dead letters.
- PostgreSQL and Redis connection saturation.

Correlate telemetry with `jobId`, `sessionId`, `runId`, `rootRunId`, `coordinatorRunId`, and `tenantId`.

### Validation

Run:

- Load and soak tests.
- Worker kill and restart tests.
- Redis outage and recovery tests.
- PostgreSQL failover tests.
- Event replay and multi-instance fanout tests.
- Backup and restore exercises.
- Tenant-isolation tests.
- Artifact authorization and workspace-escape tests.
- Webhook SSRF and signature tests.
- Graceful deployment and rollback tests.

### Exit criteria

- Service-level objectives and alerts are defined.
- Recovery and redrive runbooks exist.
- Backups and restoration have been exercised.
- API and worker fleets scale independently.
- No known path bypasses user ownership checks.
- Production rollback has been tested.

## Suggested Repository Structure

```text
packages/
  core/
  agent-sdk/
    src/
      swarm-sdk.ts
      swarm-runner.ts
      orchestration.ts
  service-sdk/
    src/
      service-sdk.ts
      jobs/
      execution/
      events/
      artifacts/
      webhooks/
      auth/
      ports/
  service/
    src/
      entrypoints/
        api.ts
        agent-worker.ts
        dispatcher.ts
        event-projector.ts
        webhook-worker.ts
        reconciler.ts
      transport/
        http/
        websocket/
      adapters/
        postgres/
        bullmq/
        object-storage/
        auth/
        observability/
    migrations/

deploy/
  Dockerfile
  compose.yaml
  kubernetes/
```

Keep Service SDK infrastructure-neutral, but avoid creating separate packages for every adapter until reuse or independent versioning requires it.

## Release Milestones

### Internal alpha: Phases 0-3

- Public Agent SDK swarm facade.
- CLI migrated to the facade.
- Service SDK domain and PostgreSQL model.
- Queue dispatcher and workers.
- Internal job inspection.

### Private API beta: Phases 4-5

- Authenticated HTTP API.
- WebSocket progress and durable replay.
- Run, chat, swarm, and orchestration.
- Polling and event-list APIs as fallback.
- Limited server-owned agent allowlist.

### Artifact-enabled beta: Phase 6

- Isolated workspaces.
- Private object storage.
- Exact initiator-only artifact access.
- Artifact-producing agents enabled.

### Production release: Phases 7-8

- Reliable signed webhooks.
- Horizontal scaling.
- Full observability and operational tooling.
- Security, failure, recovery, and load validation.

## Deferred Work

The initial implementation does not include:

- A public remote client package.
- A remote mode for the CLI.
- Per-subtask service queue jobs inside one swarm.
- Public agent-profile creation or discovery.
- Artifact sharing between users.
- Public bucket access or long-lived artifact URLs.
- Moving service ownership or HTTP concepts into core.

These can be added later without changing the core package boundary. A future remote CLI mode should use a separate typed HTTP and WebSocket client package, not import Service SDK into the local CLI.

## Implementation Order Summary

```text
Phase 0  Contracts and boundaries; no code changes
   |
Phase 1  Agent SDK SwarmSdk and CLI migration
   |
Phase 2  Service SDK domain and PostgreSQL model
   |
Phase 3  Queue, workers, recovery, and reconciliation
   |
Phase 4  Authenticated HTTP API
   |
Phase 5  Durable events and WebSockets
   |
Phase 6  Private artifacts
   |
Phase 7  Reliable webhooks
   |
Phase 8  Production hardening and rollout
```

The critical sequencing rule is to complete the reusable Agent SDK swarm facade before service swarm execution. This keeps the CLI and backend as separate adapters over one implementation of the agent workflow.
