# Service SDK Contracts v1

## Status and scope

This document freezes the Phase 0 public behavior for the initial Adaptive Agent service. It is normative for `@adaptive-agent/service-sdk` and the backend adapters built on it.

The service exposes asynchronous product `job` records around core runtime `run` records. A job is not a run, and a swarm does not introduce a separate `swarmId`.

## Responsibility and dependency boundary

- `@adaptive-agent/core` owns run, session, child-run, lease, retry, continuation, event, snapshot, and execution-time validation semantics.
- `@adaptive-agent/agent-sdk` owns agent-profile resolution, decomposition setup, worker catalogs, prompt construction, and translation to core requests.
- `@adaptive-agent/service-sdk` owns jobs, exact-user ownership, service policy, idempotency, durable commands, public event contracts, artifact metadata, and audit records.
- The backend owns HTTP, WebSocket connections, PostgreSQL and BullMQ adapters, authentication integration, object storage, and process entrypoints.
- The CLI remains a local Agent SDK adapter and does not import Service SDK.

```text
CLI ---------------------------> Agent SDK ------> Core
                                      ^
                                      |
HTTP / WebSocket -> Service SDK ------+
```

The following remain CLI-only: `agent-create`, `ambient`, `catalog`, `doctor`, `init`, `config`, `update`, and `uninstall`.

## Verified actor and ownership

Every operation receives a verified actor:

```ts
interface ServiceActor {
  tenantId: string;
  userId: string;
}
```

- Authentication middleware, not request JSON, constructs this actor.
- Every user-facing job, event, run-link, and artifact query is constrained by `jobId`, `tenantId`, and exact `ownerUserId` in the database.
- Tenant membership alone does not grant access to another user's jobs.
- Missing and unauthorized resources return the same non-enumerating `Resource not found` error.
- Queue messages, run metadata, event payloads, and artifact metadata are not authorization sources.

## Versioning

- The initial contract version is `1`.
- Run, chat, swarm, and orchestration requests carry `schemaVersion: 1`.
- Jobs, results, errors, public events, and artifacts carry `schemaVersion: 1`.
- Additive optional fields may be introduced within v1. Removing fields, changing field meaning, changing state transitions, or changing ownership semantics requires a new version.
- Public contracts do not import CLI parser types.

## Operations

### Submission

- `submitRun`
- `submitChat`
- `submitSwarmRun`
- `submitOrchestratedRun`

Submission resolves every requested agent ID through the server allowlist, pins its profile version and content hash, generates `jobId` and `sessionId`, and inserts the job, execute command, outbox row, optional idempotency record, and audit record in one PostgreSQL transaction.

### Inspection and control

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

Controls append durable versioned commands. A queue delivery contains only `{ jobId }`; a worker reloads the authoritative command, request, ownership, profile pins, and run links from PostgreSQL.

## Request contracts

```ts
interface RunRequestV1 {
  schemaVersion: 1;
  agentId: string;
  goal: string;
  input?: JsonValue;
}

interface ChatRequestV1 {
  schemaVersion: 1;
  agentId: string;
  message: string;
  conversationId?: string;
}

interface SwarmRunRequestV1 {
  schemaVersion: 1;
  coordinatorAgentId: string;
  workerAgentIds: string[];
  qualityAgentId: string;
  synthesizerAgentId: string;
  objective: string;
}

interface OrchestratedRunRequestV1 {
  schemaVersion: 1;
  orchestratorAgentId: string;
  agentIds: string[];
  objective: string;
}
```

Swarm submissions require all four execution roles to be assigned explicitly: one coordinator, one or more workers, one quality agent, and one synthesizer agent. Omitting either finalizer role is a breaking request-validation error.

Agent IDs are allowlisted public IDs. Clients cannot provide config paths, model credentials, model overrides, instructions, tool lists, delegates, workspace roots, runtime modes, or approval defaults. Jobs persist only agent IDs, profile versions, and content hashes; the agent spec remains the source of truth.

## Job state machine

```text
accepted -> queued -> running ---------------------------> succeeded
                         |                                      |
                         +----> waiting_approval ----resume-----+
                         |
                         +----> waiting_clarification -resume---+
                         |
                         +----> failed --retry/recover/continue-> running
                         |
                         +----> cancelling ---------------------> cancelled

succeeded --continue--> running
cancelled --retry-----> running
```

`accepted`, `queued`, `running`, `waiting_approval`, `waiting_clarification`, and `cancelling` are non-terminal. `succeeded`, `failed`, and `cancelled` are terminal for the current execute attempt, but a later valid control command can start more processing on the same job.

Legal controls:

| Command | Source states |
| --- | --- |
| `cancel` | `accepted`, `queued`, `running`, `waiting_approval`, `waiting_clarification` |
| `retry` | `failed`, `cancelled` |
| `recover` | `failed` |
| `resume` | `waiting_approval`, `waiting_clarification`, `failed` |
| `continue` | `failed`, `succeeded` |
| `steer` | `running`, `waiting_approval`, `waiting_clarification` |
| `resolve_approval` | `waiting_approval` |
| `resolve_clarification` | `waiting_clarification` |

Invalid transitions fail without appending an outbox command.

## Idempotency

- Submission keys are scoped to `(tenantId, userId, workload kind, key)`.
- Control keys are scoped to `(tenantId, userId, control kind, key)`.
- The server hashes the normalized operation body, including the target `jobId` for controls.
- Reusing a key with the same hash returns the original job and creates no new command or outbox row.
- Reusing a key with a different hash returns `IdempotencyConflictError`.
- Keys are not shared across users, tenants, or operation kinds.
- Queue delivery is at least once. Outbox command versions, command leases, and processed markers make delivery retries safe.

## Job and run correlation

- `jobId` identifies the external service job.
- `sessionId` is generated and persisted when the job is accepted, before queue publication.
- `runId` identifies one core run.
- `rootRunId` is the core root for a run tree.
- `coordinatorRunId` identifies one swarm execution within its `sessionId`.
- There is no `swarmId`.
- A job can link to multiple runs with roles: `root`, `coordinator`, `worker`, `quality`, `synthesizer`, `child`, and `continuation`.
- On redelivery, workers inspect links and also search core runs by the persisted `sessionId` to adopt a run created before a worker crash.

## Result and error contracts

```ts
interface ServiceResultV1 {
  schemaVersion: 1;
  value: JsonValue;
  completedAt: string;
}

interface ServiceErrorV1 {
  schemaVersion: 1;
  code: string;
  message: string;
  retryable: boolean;
}
```

Errors exposed publicly must not contain database URLs, credentials, provider tokens, raw model authorization headers, private storage keys, or unbounded provider responses.

## Public event envelope

```ts
interface PublicEventEnvelopeV1 {
  schemaVersion: 1;
  id: string;
  jobId: string;
  sequence: number;
  type: string;
  data: JsonValue;
  occurredAt: string;
}
```

- `sequence` is monotonic within one job and is the replay cursor.
- Event projection is idempotent by source event identity.
- Public events contain opaque artifact IDs and metadata, never object-storage keys or signed URLs.
- Raw core events remain internal and may contain details omitted from the public projection.

## Artifact contract

Artifact metadata includes `artifactId`, exact tenant and owner, `jobId`, optional `runId` and tool execution ID, filename, media type, byte size, content hash, lifecycle status, and timestamps.

Lifecycle states are `uploading`, `scanning`, `available`, `quarantined`, and `deleted`. Listing and download authorization is always derived from the authoritative owning job. Available artifacts use the normal owner-only download operation. Quarantined artifacts require a separate, explicit owner-only download operation that is audited distinctly and always returns a forced `application/octet-stream` attachment. Quarantined content is never rendered inline, and administrators cannot download it through admin APIs. Unauthorized access and status mismatches return the same not-found response. Phase 6 defines upload, scanning, and download adapters; Phase 0 freezes the metadata and ownership behavior only.

## Retention defaults

Deployments may shorten retention only when product policy and applicable law permit it. The initial maximum defaults are:

| Record | Default retention |
| --- | --- |
| Jobs and public results | 30 days after terminal state |
| Public service events | 30 days after terminal state |
| Raw core events and snapshots | 14 days after terminal state |
| Available artifacts | 7 days after availability |
| Quarantined artifacts | 30 days |
| Idempotency records | 24 hours after creation, never less than the client retry window |
| Outbox and audit records | Outbox 7 days after processing; audit 1 year |
| Webhook attempts | 30 days |

Deletion must preserve referential integrity and required audit evidence. Retention workers must constrain every artifact operation by authoritative job ownership.

## Initial service limits

Limits are enforced by service policy before dispatch and rechecked where execution can expand work:

| Limit | Initial default |
| --- | --- |
| JSON request body | 1 MiB |
| Attachments per job | 20 |
| Total attachment bytes | 100 MiB |
| Artifact files per job | 100 |
| Total artifact bytes per job | 1 GiB |
| Active jobs per user | 10 |
| Active jobs per tenant | 100 |
| Swarm worker concurrency per job | 4 |
| Swarm subtasks per job | 32 |
| Token and cost budget | Required server policy per allowlisted profile; no unbounded default |

The backend may configure lower tenant/profile limits. Clients cannot raise them.

## Threat model and required controls

### Cross-user access

Threat: guessed IDs expose jobs, events, runs, or artifacts. Controls: verified actors, exact-user database predicates, non-enumerating errors, private object storage, and authorization tests for every operation.

### Arbitrary agents and tools

Threat: clients select filesystem paths, credentials, models, instructions, or dangerous tools. Controls: server-owned allowlisted IDs, pinned version/hash, execution-time registry hash verification, and core validation.

### Worker filesystem and network

Threat: tools escape a job workspace or access unintended networks. Controls: normalized private per-job workspaces, symlink/escape checks, an explicit sandbox-policy hook, and production OS/container network enforcement. A local workspace directory alone is not claimed to provide OS or network isolation.

### Duplicate or reordered queue delivery

Threat: duplicate roots or repeated controls. Controls: transactional outbox, deterministic queue IDs, PostgreSQL command leases, per-command processed markers, session-based run adoption, and idempotent core recovery. BullMQ is never the system of record.

### Webhook SSRF

Threat: callbacks reach loopback, private, link-local, metadata, or rebinding targets. Controls for Phase 7: HTTPS-only destinations, address validation before every connection and redirect, DNS revalidation, bounded duration/response size, signing, and isolated webhook workers.

### Credential leakage

Threat: secrets enter events, errors, logs, queue payloads, artifacts, or webhooks. Controls: opaque queue payloads, server-side credential resolution, log/error redaction, private storage keys, bounded provider errors, and no signed URLs in durable public records.

## Phase 0 acceptance

- Package responsibilities and dependency direction are fixed above.
- Public types are independent of CLI parser types.
- The job states, transitions, public event envelope, ownership rules, idempotency behavior, retention, limits, and threat model are fixed for v1.
- Authentication identity and database ownership records, never client metadata, are authoritative.
