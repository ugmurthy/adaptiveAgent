# Implementation Plan: Safe `shell_exec` MVP

## 1. Introduction

Allow server-owned agents using `shell_exec` to be advertised and executed by the Adaptive Agent service without giving model-generated commands access to the shared agent worker, its credentials, or the host network.

The MVP uses a dedicated internal sandbox service backed by Docker. The trusted agent worker sends approved-by-policy command requests to that service. The sandbox service executes every command in a fresh, credential-free container with the job workspace as its only writable persistent mount.

The selected MVP policy is:

- Sandbox backend: dedicated internal Docker sandbox service.
- Workloads: `run` and `chat` only.
- Approval: automatic for `shell_exec` in the service runtime.
- Network: disabled for every command container.

Automatic approval makes containment the primary security boundary. The feature must fail closed if the sandbox service, profile, workspace validation, or container restrictions are unavailable.

## 2. Architecture

```text
Client
  |
  | POST /v1/jobs/run or /v1/jobs/chat
  v
Service API -> PostgreSQL/outbox -> BullMQ
                                      |
                                      v
                              Trusted AgentWorker
                              - database credentials
                              - model credentials
                              - job workspace
                                      |
                                      | internal authenticated request
                                      | jobId, workspaceId, command, cwd,
                                      | server-owned sandbox profile
                                      v
                              Sandbox service
                              - owns Docker access
                              - has no model/database credentials
                              - validates workspace and profile
                                      |
                                      v
                              Disposable command container
                              - network=none
                              - read-only root filesystem
                              - job workspace mounted read-write
                              - bounded CPU/memory/PIDs/time/output
```

The existing `AgentWorker` must not receive Docker socket access. The existing `LocalWorkspaceManager` remains responsible for job workspace creation and artifact preparation, but its `SandboxPolicy` is not treated as process isolation.

## 3. Goals

- Advertise allowlisted `run`/`chat` agents that include `shell_exec` when they have an authorized sandbox profile.
- Execute `shell_exec` without spawning a command in the agent worker process.
- Prevent commands from reading agent-worker environment variables, service credentials, host files, or the Docker socket.
- Prevent command containers from making network connections.
- Preserve writes beneath the job workspace so later tool calls and artifact ingestion can observe them.
- Automatically execute service `shell_exec` calls without entering `waiting_approval`.
- Preserve cancellation, timeout, bounded-output, event, retry, and recovery behavior.
- Fail closed on invalid paths, unknown profiles, sandbox unavailability, or containment setup failure.

## 4. Non-Goals

- Shell access for `swarm` or `orchestration` workloads.
- Client-selected images, sandbox profiles, mounts, limits, network policy, environment variables, or approval policy.
- Outbound network allowlists or unrestricted network access.
- Interactive terminals, stdin, PTYs, background daemons, or long-lived command containers.
- Installing packages persistently outside the mounted job workspace.
- Windows or macOS command containers in production.
- Kubernetes, gVisor, Firecracker, or multi-host workspace transport.
- Command allowlists or deny-lists as the main security boundary.
- Running the entire agent worker inside the command sandbox.
- Changing local CLI `shell_exec`; its existing approval behavior remains unchanged.

## 5. Security Invariants

These are release blockers, not follow-up hardening:

1. The agent worker never invokes the built-in local `shell_exec` for a service job.
2. The agent worker does not mount or access the Docker socket.
3. The sandbox service does not receive database, Redis, object-storage, model-provider, or JWT credentials.
4. Every command runs in a newly created container and the container is removed after completion, timeout, cancellation, or startup failure.
5. The only host bind mount is the validated job workspace.
6. The command container has no network namespace access (`NetworkMode=none`).
7. The root filesystem is read-only; only the job workspace and bounded temporary storage are writable.
8. The process runs as a fixed unprivileged UID/GID with all Linux capabilities dropped and `no-new-privileges` enabled.
9. The sandbox service maps a server-owned profile name to a pinned image digest and fixed limits. Request fields cannot override those settings.
10. Both the agent worker and sandbox service canonicalize `cwd`; it must resolve beneath the canonical job workspace after symlink resolution.
11. Only workspace identifiers generated by the service are accepted. The sandbox API does not accept an arbitrary host mount path.
12. Environment variables passed to the command use a small allowlist and are never copied from `process.env`.
13. Timeout and output limits are enforced by the sandbox service, independently of values supplied by the agent worker.
14. Failure to apply any required Docker restriction aborts execution rather than starting a weaker container.
15. The internal endpoint is inaccessible from the public API network and requires a service credential.

## 6. User Stories and Implementation Tasks

### US-001: Authorize shell agents through the server registry

**Description:** As a service operator, I want shell capability to be explicitly authorized in the server-owned registry so clients cannot grant it to an agent.

**Implementation:**

- Extend `AgentManifestEntry` in `packages/service/src/registry.ts` with:

  ```ts
  executionClass?: 'standard' | 'sandboxed-shell';
  sandboxProfile?: string;
  ```

- Keep `standard` as the effective default for compatibility.
- Replace the unconditional `shell_exec` rejection with validation:
  - An agent without `shell_exec` may use `standard` only.
  - An agent with `shell_exec` must declare `executionClass: 'sandboxed-shell'`.
  - It must reference a configured server-owned `sandboxProfile`.
  - Its `allowedWorkloads` must contain only `run` and/or `chat`.
  - A shell agent must be rejected when sandbox support is disabled in that process.
- Perform the same validation in `resolve`, `resolvePinned`, and catalog listing through one registry validation path.
- Continue pinning the agent config version and content hash. Sandbox authorization remains manifest metadata and must not be accepted from an agent JSON file or client request.
- Return shell agents from `GET /v1/agents`. Add additive catalog metadata:

  ```json
  {
    "id": "coding-agent",
    "version": "1",
    "allowedWorkloads": ["run", "chat"],
    "executionClass": "sandboxed-shell",
    "capabilities": ["shell_exec"]
  }
  ```

**Acceptance Criteria:**

- [ ] A standard agent without `shell_exec` resolves as before.
- [ ] A shell agent without `executionClass: sandboxed-shell` is rejected.
- [ ] A shell agent without a known `sandboxProfile` is rejected.
- [ ] A shell agent allowing `swarm` or `orchestration` is rejected.
- [ ] A correctly configured shell agent resolves for `run` and `chat` and appears in `/v1/agents`.
- [ ] Clients still cannot submit tools, execution class, profile, image, limits, or network policy.
- [ ] Registry unit tests pass.

### US-002: Define the sandbox command boundary

**Description:** As a service developer, I want a provider-independent command executor so the Agent SDK never depends directly on Docker.

**Implementation:**

- Add service-owned interfaces for `SandboxCommandExecutor`, `SandboxCommandRequest`, `SandboxCommandResult`, and `SandboxProfile`.
- Keep the contract in `@adaptive-agent/service`; do not move service-specific container orchestration into core or Agent SDK.
- Use a relative `workspaceId` and relative `cwd` at the remote boundary. Do not send arbitrary host paths.
- Include only:
  - `requestId`
  - `jobId`
  - `workspaceId`
  - `command`
  - workspace-relative `cwd`
  - server-owned `profile`
- Do not accept caller-provided image, mounts, environment, network mode, CPU, memory, PID, timeout, or output limits.
- Standardize results:

  ```ts
  interface SandboxCommandResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut: boolean;
    truncated: boolean;
    stdoutBytes: number;
    stderrBytes: number;
    sandboxId: string;
  }
  ```

- Define stable internal errors for invalid input, policy rejection, capacity exhaustion, timeout, cancellation, runner unavailability, and container failure. Only sanitized service errors may reach public job responses.

**Acceptance Criteria:**

- [ ] The interface does not expose Docker-specific types.
- [ ] Resource and network settings cannot be supplied in an execution request.
- [ ] Invalid command, `cwd`, profile, and identifier values are rejected before an RPC is sent.
- [ ] Unit tests cover result mapping and sanitized errors.
- [ ] Package typecheck passes.

### US-003: Implement the internal sandbox service

**Description:** As a service operator, I want a separate process to own Docker access so an agent command cannot control the host container runtime.

**Implementation:**

- Add a separate `sandbox-server-main.ts` entrypoint under `packages/service` and include it in the package build.
- Expose only:
  - `GET /health/live`
  - `GET /health/ready`
  - `POST /internal/v1/execute`
- Bind to an internal address. Require a constant-time-validated bearer token supplied through `SANDBOX_SERVICE_TOKEN`.
- Configure:
  - `SANDBOX_HOST`
  - `SANDBOX_PORT`
  - `SANDBOX_WORKSPACE_ROOT`
  - `SANDBOX_SERVICE_TOKEN`
  - A server-owned profile configuration file or environment-selected fixed profile set.
- Use strict Fastify schemas with `additionalProperties: false`, command/body size limits, and no reflective error details.
- Resolve `workspaceId` beneath `SANDBOX_WORKSPACE_ROOT`; reject separators, traversal, symlinks at the workspace root, missing workspaces, and any canonical path outside the configured root.
- Apply global and per-tenant/job concurrency limits before starting Docker. The initial default should be conservative, for example four global command containers and one active command per job.
- Do not log authorization headers. Log command metadata and a command hash by default, not full command text.

**Acceptance Criteria:**

- [ ] Publicly unauthenticated execution requests receive `401`.
- [ ] Unknown fields and malformed identifiers receive `400`.
- [ ] Unknown profiles and invalid workspaces fail before Docker is called.
- [ ] Workspace traversal and symlink escape tests pass.
- [ ] Capacity limits reject or defer excess requests without starting extra containers.
- [ ] Readiness fails when Docker or the configured image is unavailable.
- [ ] HTTP handler tests use a fake command backend and do not require Docker.

### US-004: Execute commands in disposable Docker containers

**Description:** As a tenant, I want commands isolated from the host and other jobs even though they execute automatically.

**Implementation:**

- Implement a Docker command backend owned only by the sandbox service.
- For the MVP, invoke the Docker CLI with `spawn(binary, args, { shell: false })` or use a narrowly wrapped Docker Engine client. Never interpolate request data into a host shell command.
- Use one fresh container per command with a unique server-generated name.
- Apply at least:
  - Image pinned by digest.
  - `--network none`.
  - `--read-only`.
  - `--cap-drop ALL`.
  - `--security-opt no-new-privileges`.
  - Runtime-default or stricter seccomp profile.
  - Fixed unprivileged user.
  - Memory limit: 512 MiB initial default.
  - CPU limit: one CPU initial default.
  - PID limit: 128 initial default.
  - Bounded `/tmp` tmpfs with `nosuid,nodev`.
  - The canonical job workspace mounted at `/workspace` read-write.
  - Working directory beneath `/workspace`.
  - stdin closed and no TTY.
  - A minimal fixed environment such as `HOME=/tmp`, `TMPDIR=/tmp`, and a fixed `PATH`.
- Execute the model command as container arguments to `/bin/sh -lc`; the outer Docker invocation must not use a host shell.
- Enforce a 60-second default deadline in the sandbox service.
- Capture stdout and stderr independently with a combined bounded memory policy. Record byte counts and truncation.
- On cancellation or timeout, stop and forcibly remove the exact server-generated container.
- Run removal in `finally`, including create/start/attach failures.
- Verify the image digest and required restrictions during readiness checks.

**Acceptance Criteria:**

- [ ] A command can read and write only within `/workspace` and bounded temporary storage.
- [ ] A command cannot read an agent-worker-only canary secret.
- [ ] The command environment does not contain service credentials.
- [ ] A network probe fails in the container.
- [ ] A workspace file written by one command is visible to a later command for the same processing attempt.
- [ ] Timeout and cancellation remove the container.
- [ ] Output exceeding the limit is truncated without unbounded process memory growth.
- [ ] The command exit code, stdout, and stderr are returned accurately.
- [ ] No test leaves containers behind.

### US-005: Add the authenticated sandbox client

**Description:** As the trusted agent worker, I want to invoke the sandbox service with bounded and cancellable requests.

**Implementation:**

- Add an HTTP implementation of `SandboxCommandExecutor` to `packages/service`.
- Configure it with:
  - `SANDBOX_SERVICE_URL`
  - `SANDBOX_SERVICE_TOKEN`
  - request timeout no greater than the sandbox profile timeout plus a small transport grace period
- Send only the internal command contract.
- Propagate the tool `AbortSignal` to `fetch` so job cancellation aborts the request; the sandbox service must independently terminate the associated container when the connection closes or cancellation is signaled.
- Bound response-body reads and reject oversized or malformed responses.
- Map connectivity failures to a retryable internal service error without exposing internal URLs or Docker details.
- Do not retry a command automatically at the HTTP client layer. Durable run recovery remains responsible for deciding whether a tool execution may be retried, avoiding duplicate side effects.

**Acceptance Criteria:**

- [ ] Authentication is attached without appearing in logs or errors.
- [ ] Request cancellation aborts the transport.
- [ ] Oversized and malformed responses fail closed.
- [ ] The client never automatically repeats a submitted command.
- [ ] Client tests use a local fake HTTP server and cover success, timeout, cancellation, `401`, `429`, `5xx`, and malformed responses.

### US-006: Override `shell_exec` for service runs

**Description:** As a service user, I want an allowlisted shell agent to execute commands automatically through the sandbox rather than through the local built-in tool.

**Implementation:**

- Add `createSandboxedShellExecTool` under `packages/service`.
- Give it the exact name `shell_exec`; Agent SDK supplied tools already override built-ins by name.
- Set `requiresApproval: false` for this service-only tool. This implements the selected automatic-approval policy without globally auto-approving other gated tools.
- Keep local core/CLI `shell_exec` unchanged with `requiresApproval: true`.
- Validate and normalize:
  - Non-empty command with a fixed maximum length.
  - Optional workspace-relative `cwd`.
  - No NUL bytes.
  - Canonical `cwd` beneath the workspace.
- Delegate execution to `SandboxCommandExecutor` and retain existing model-facing bounded result formatting semantics.
- Update `AgentSdkWorkloadExecutor` so every `run` and `chat` SDK for an authorized shell agent receives the override through `AgentSdk.create({ tools: [...] })`.
- Set both the resolved `workspaceRoot` and `shellCwd` to the server-created job workspace. Do not retain the agent config's original shell directory.
- Continue rejecting shell agents for swarm and orchestration at registry resolution. Do not partially wire nested SDK paths in the MVP.
- Add a startup assertion: if the loaded registry contains a shell agent, the worker must have valid sandbox client configuration and successful sandbox readiness.

**Acceptance Criteria:**

- [ ] A service shell call invokes the sandbox executor and never invokes local `node:child_process.spawn` from core's built-in shell tool.
- [ ] `shell_exec` does not transition the job to `waiting_approval`.
- [ ] Other approval-gated tools retain their existing behavior.
- [ ] `cwd` defaults to the job workspace and cannot escape it.
- [ ] Command cancellation reaches the sandbox executor.
- [ ] `run` and `chat` support shell execution.
- [ ] `swarm` and `orchestration` reject shell agents before job execution.
- [ ] Retry/recovery tests prove the reconstructed SDK still receives the sandbox override.

### US-007: Preserve workspace and artifact behavior

**Description:** As a service user, I want files produced by sandbox commands to be available to later tools and artifact collection.

**Implementation:**

- Continue creating workspaces through `LocalWorkspaceManager`.
- Ensure the agent worker and sandbox service see the same `JOB_WORKSPACE_ROOT` through a same-node path or shared volume mounted at the same canonical location.
- Derive `workspaceId` from the manager-created directory name; never expose arbitrary mount paths to the model or client.
- Prepare file references before starting command execution.
- Mount the entire job workspace at `/workspace`, including `inputs` and `artifacts`.
- Keep input permissions consistent with the existing artifact policy. If inputs must be immutable, mount input directories read-only separately or enforce permissions before enabling the feature.
- Complete artifact ingestion before workspace cleanup.
- Document that writes outside `/workspace` and bounded `/tmp` are discarded after each command.

**Acceptance Criteria:**

- [ ] A shell command can consume prepared file inputs.
- [ ] A shell command can create an output under `artifacts` and the normal artifact pipeline uploads it.
- [ ] One job cannot reference or mount another job's workspace ID.
- [ ] Workspace cleanup occurs only after artifact ingestion and command completion.
- [ ] Existing artifact and workspace tests continue to pass.

### US-008: Add auditability and operational safeguards

**Description:** As an operator, I want to identify shell activity and contain resource abuse without leaking command secrets into infrastructure logs.

**Implementation:**

- Emit structured sandbox lifecycle logs containing:
  - request ID, sandbox ID, job ID, profile, relative `cwd`
  - command SHA-256 hash and command byte length
  - start/end timestamps and duration
  - exit code, timeout/cancellation flags
  - stdout/stderr byte counts and truncation
  - policy rejection code
- Do not log bearer tokens, process environment, full command text, stdout, or stderr by default. Core run events remain the authoritative tool-call audit record subject to existing tenant authorization.
- Add counters and histograms for executions, active containers, duration, exit status, timeouts, cancellations, policy rejections, output truncation, and cleanup failures.
- Add readiness checks to the agent worker and sandbox service.
- Treat container cleanup failure as an alert-worthy event and attempt bounded reconciliation by sandbox-name prefix on sandbox-service startup.
- Apply per-job and global concurrency limits. Tenant-wide limits can be added later if tenant identity is not available at the internal boundary in the MVP.

**Acceptance Criteria:**

- [ ] Every execution has correlatable job, request, and sandbox identifiers.
- [ ] Secrets and full command output are absent from default sandbox-service logs.
- [ ] Timeout, rejection, and cleanup failure are observable separately.
- [ ] Restart reconciliation only targets containers carrying the sandbox service's labels and expected name prefix.
- [ ] Readiness fails closed when execution containment cannot be guaranteed.

### US-009: Package and deploy the sandbox service safely

**Description:** As an operator, I want a reproducible deployment that separates the sandbox service from public and credential-bearing processes.

**Implementation:**

- Add the sandbox server to `packages/service` build scripts.
- Build a minimal command image containing the approved Bun/shell toolchain and run as a non-root user.
- Pin the command image by digest in deployment configuration.
- Deploy the sandbox service separately from HTTP and agent-worker processes.
- Give only the sandbox service access to the container runtime.
- Give only the agent worker access to the sandbox execution endpoint.
- Mount the job workspace root into both processes at the same path; mount it into command containers only per request.
- Do not inject general service `.env` data into the sandbox service or command image.
- Add configuration documentation and `.env.example` entries with safe defaults and explicit warnings.
- Add a deployment smoke test that runs a harmless command, writes an artifact, verifies network denial, and verifies cleanup.

**Acceptance Criteria:**

- [ ] HTTP and agent-worker containers have no Docker socket.
- [ ] The sandbox service is not exposed by the public ingress.
- [ ] The sandbox service starts with only its token, profile, workspace, runtime, and telemetry configuration.
- [ ] The command image contains no repository secrets or service configuration.
- [ ] A documented smoke test passes in the target deployment environment.

## 7. Functional Requirements

- **FR-1:** The registry must require `executionClass: sandboxed-shell` and a known `sandboxProfile` for every agent containing `shell_exec`.
- **FR-2:** Shell-enabled manifest entries must be limited to `run` and `chat` workloads in the MVP.
- **FR-3:** `/v1/agents` must advertise valid shell agents instead of silently removing them.
- **FR-4:** Clients must not be able to select or override shell capability, sandbox profile, image, mounts, limits, environment, or network policy.
- **FR-5:** The service-specific `shell_exec` must execute automatically and must not globally alter approval behavior for other tools.
- **FR-6:** Every shell command must execute through the dedicated sandbox service.
- **FR-7:** The sandbox service must start one fresh, restricted container per command.
- **FR-8:** Command containers must have no network access.
- **FR-9:** Command containers must receive no service or model credentials.
- **FR-10:** The job workspace must be the only persistent writable mount.
- **FR-11:** Both caller and runner must reject `cwd` values escaping the job workspace.
- **FR-12:** Commands must have fixed server-side CPU, memory, PID, duration, and output limits.
- **FR-13:** Cancellation and timeout must terminate and remove the command container.
- **FR-14:** The HTTP client must not automatically retry command submissions.
- **FR-15:** Sandbox failures must produce sanitized public job errors and detailed internal diagnostics.
- **FR-16:** The worker and registry must fail closed when sandbox configuration is absent or invalid.
- **FR-17:** Existing run persistence, profile pinning, recovery, artifact ingestion, and queue idempotency boundaries must remain unchanged.

## 8. Internal API Contract

### Execute request

```http
POST /internal/v1/execute
Authorization: Bearer <sandbox-service-token>
Content-Type: application/json
```

```json
{
  "schemaVersion": 1,
  "requestId": "uuid",
  "jobId": "service-job-id",
  "workspaceId": "normalized-generated-workspace-id",
  "cwd": ".",
  "command": "bun test",
  "profile": "bun-shell-v1"
}
```

### Execute success

```json
{
  "schemaVersion": 1,
  "sandboxId": "uuid",
  "stdout": "...",
  "stderr": "...",
  "exitCode": 0,
  "timedOut": false,
  "truncated": false,
  "stdoutBytes": 123,
  "stderrBytes": 0
}
```

### Error behavior

- `400`: malformed request or invalid workspace-relative path.
- `401`: invalid internal credential.
- `403`: workspace/profile policy rejection.
- `404`: unknown workspace.
- `409`: another command is already active for the job, if one-per-job is enforced by rejection.
- `429`: global capacity exhausted.
- `500`: sandbox startup or containment failure.
- `503`: Docker runtime or required image unavailable.

The agent worker maps these to retryable/non-retryable internal errors. Public APIs continue returning sanitized service errors.

## 9. Default Sandbox Profile

```json
{
  "id": "bun-shell-v1",
  "image": "registry.example.com/adaptive-agent/bun-shell@sha256:<digest>",
  "network": "none",
  "readOnlyRoot": true,
  "user": "65532:65532",
  "cpu": 1,
  "memoryBytes": 536870912,
  "pidsLimit": 128,
  "timeoutMs": 60000,
  "maxCommandBytes": 16384,
  "maxOutputBytes": 102400,
  "tmpfsBytes": 67108864
}
```

The MVP may ship one compiled-in or file-configured profile. Profile parsing must reject unknown fields and unsafe values. Environment variables may choose a profile file but must not permit per-request overrides.

## 10. Implementation Order

1. Add the provider-independent sandbox contracts and path validators.
2. Extend registry manifest validation and update catalog behavior.
3. Implement the sandbox HTTP server against a fake command backend.
4. Implement the Docker command backend and Docker-gated integration tests.
5. Implement the authenticated sandbox HTTP client.
6. Implement the service-specific `shell_exec` override with automatic execution.
7. Wire the override into `AgentSdkWorkloadExecutor` for `run`, `chat`, recovery, retry, resume, and continuation.
8. Validate workspace/artifact behavior across the process boundary.
9. Add metrics, cleanup reconciliation, readiness, deployment assets, and documentation.
10. Run the complete package verification and manual security smoke test.

Do not remove the current registry rejection until steps 1-6 are present and the execution path has a test proving the local built-in shell cannot be selected.

## 11. Verification Plan

### Unit and component tests

- Registry authorization matrix:
  - no shell/standard
  - shell/standard
  - shell/missing profile
  - shell/unknown profile
  - shell/run-chat
  - shell/swarm-orchestration
  - sandbox disabled
- Workspace and `cwd` validation:
  - `.`, nested paths, absolute paths, `..`, symlink escape, missing path, race/revalidation
- Sandbox server authentication, schema validation, capacity, and error mapping.
- Sandbox client success, timeout, abort, oversized response, malformed response, and no automatic retry.
- Tool override selection and automatic execution.
- Proof that other tools' `requiresApproval` values are unchanged.
- Recovery and resume reconstruct the sandboxed tool.
- Artifact collection after a sandbox write.

### Docker-gated integration tests

- Harmless command returns output and exit code.
- Non-zero command returns stderr and exit code without becoming a transport failure.
- Workspace write persists across separate command containers.
- Root filesystem write fails.
- Network access fails.
- Environment contains no injected canary secret.
- CPU/memory/PID limits are present through container inspection or controlled probes.
- Timeout and cancellation remove the container.
- Output is truncated at the configured limit.
- Container labels and startup reconciliation do not touch unrelated containers.

### Required commands

From `packages/service`:

```sh
bunx vitest run src/registry.test.ts
bunx vitest run src/sandbox-*.test.ts
bunx vitest run src/agent-executor.test.ts
bun run typecheck
bun run build
bun test
```

Run Docker integration tests through an explicit opt-in environment flag so ordinary unit tests do not silently skip required release verification. The release checklist must record the Docker test result separately.

## 12. Rollout Plan

1. Deploy the sandbox service with no shell agents authorized.
2. Verify readiness, runtime isolation, network denial, cleanup, and metrics in staging.
3. Deploy the agent-worker sandbox client and tool override while retaining registry rejection.
4. Enable one internal test agent with `executionClass: sandboxed-shell`, `sandboxProfile: bun-shell-v1`, and `allowedWorkloads: [run]`.
5. Run adversarial tests for path escape, environment theft, network access, fork/process abuse, output flooding, timeout, and cancellation.
6. Enable `chat` for the same test profile after run behavior is stable.
7. Allow additional server-owned profiles gradually. Do not provide a client-side capability toggle.
8. Roll back by removing shell agent authorization or disabling sandbox support; shell agents then fail registry resolution and disappear from the executable catalog.

## 13. Success Metrics

- 100% of service `shell_exec` calls are handled by the sandbox executor; zero local built-in shell invocations.
- Zero command containers receive service/model credentials or network access in security tests.
- 100% of timed-out and cancelled test commands have their containers removed within a bounded cleanup interval.
- Invalid workspace and `cwd` escape attempts are rejected before command execution.
- Valid shell agents appear in `/v1/agents` and complete representative `run` and `chat` jobs.
- Existing non-shell agent tests, package typecheck, and build remain green.

## 14. Risks and Mitigations

### Docker socket compromise

**Risk:** Docker control generally implies host-level control.

**Mitigation:** Only the dedicated sandbox service can access Docker. It exposes one narrow authenticated operation, validates all inputs, uses fixed profiles, and is not publicly reachable.

### Automatic approval increases impact

**Risk:** Prompt injection can trigger commands without a user checkpoint.

**Mitigation:** No network, no credentials, workspace-only persistence, strict resource limits, server-owned profiles, and no shell support for nested orchestration in the MVP. Automatic approval must not be generalized to other tools.

### Shared workspace path confusion

**Risk:** A caller could trick the sandbox service into mounting another host directory or tenant workspace.

**Mitigation:** Send generated workspace IDs rather than paths, canonicalize beneath one configured root, reject symlinks/escapes, and revalidate immediately before container creation.

### Duplicate execution

**Risk:** Transport retries could repeat a command with side effects.

**Mitigation:** The HTTP client does not retry. Use a unique request ID and short-lived server-side deduplication for completed/in-flight requests if needed, while preserving PostgreSQL/core recovery as the durable decision boundary.

### Container breakout

**Risk:** Containers do not provide a perfect security boundary.

**Mitigation:** Minimal patched image, unprivileged user, no capabilities, no network, read-only root, seccomp, no host namespaces/devices, resource limits, and a migration path to gVisor/Firecracker for higher-risk deployments.

### Workspace persistence across recovery

**Risk:** Current processing may recreate an ephemeral workspace when a run is resumed or recovered.

**Mitigation:** Add explicit tests for run/chat recovery and artifact reconstruction. Do not claim arbitrary workspace state survives worker crashes unless it is persisted through the existing input/artifact lifecycle.

## 15. Open Implementation Decisions

These do not change the selected MVP product scope but must be settled before coding their respective stories:

1. Use Docker CLI with `spawn(..., { shell: false })` or a Docker Engine library. Prefer the CLI for the smallest dependency footprint if cancellation, attach, bounded output, and cleanup can be implemented reliably.
2. Reject concurrent commands per job with `409` or queue them inside the sandbox service. Prefer rejection/backpressure for the MVP rather than adding another non-durable queue.
3. Store sandbox profiles in a strict JSON file or compile the first profile into service configuration. Prefer strict JSON so the image digest can change operationally without a code release.
4. Decide whether existing input files must be read-only inside command containers. Prefer separate read-only input mounts if compatible with current workspace preparation.
5. Decide the deployment-specific mechanism for ensuring the agent worker and sandbox service mount the same workspace root. This is an operational prerequisite for the Docker MVP.
