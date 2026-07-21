# Service File Reference Implementation Plan

## Status

- Target: `@adaptive-agent/service`, `@adaptive-agent/service-sdk`, and `@adaptive-agent/service-console`
- Storage: existing private MinIO/S3-compatible artifact store
- Primary use case: a task such as `Read report.md and summarise` can safely use an existing artifact owned by the submitting user
- Initial tool support: `read_file` and `search_files`
- Follow-up tool support: `edit_file` with immutable version publication

## Objective

Resolve explicit filename references in a service task to existing `service_artifacts` rows, pin the resolved artifacts to the job, materialize the corresponding MinIO objects into the job workspace, and tell the model the exact local paths available to file tools.

The implementation must preserve these invariants:

- PostgreSQL is authoritative for tenant and user ownership.
- MinIO objects remain private and immutable.
- A filename is a convenience alias, not durable identity.
- An artifact ID is the durable identity pinned to a job.
- Retries and recovery use the same pinned artifact bytes.
- Inputs are not re-ingested as outputs.
- Edited files are published as new artifacts and never overwrite source objects.

## Example Behavior

Given an available artifact:

```text
tenant_id: tenant-1
owner_user_id: Murthy
id: 758b434e-35e1-4a6e-b312-7bf640648fb9
original_filename: report.md
storage_key: artifacts/e34729a0-ce1f-4eff-9392-22647c1f2b58/758b434e-35e1-4a6e-b312-7bf640648fb9
content_hash: <sha256>
status: available
```

and a request:

```json
{
  "schemaVersion": 1,
  "agentId": "report-evaluator",
  "goal": "Read report.md and summarise"
}
```

the worker must, before invoking the model:

1. Extract `report.md` as an input filename reference.
2. Resolve it using the exact tenant and owner of the job.
3. Require exactly one available, unexpired match.
4. Persist the resolved artifact ID as a job file binding.
5. Download and verify the MinIO object.
6. Materialize it as a regular file under the job workspace.
7. Add an exact path manifest to model context.
8. Allow the model to call `read_file` or `search_files` against that path.

Example materialized path:

```text
inputs/758b434e-35e1-4a6e-b312-7bf640648fb9/report.md
```

Example model context:

```text
Files referenced by the task have been materialized in the job workspace.
Use read_file when file contents are needed. Use search_files with path "inputs"
when searching across the referenced files. Do not infer contents from filenames.

- report.md: inputs/758b434e-35e1-4a6e-b312-7bf640648fb9/report.md
```

The file content does not need to be inserted into the prompt. `read_file` returns it to the model on demand. This avoids placing large files into initial model context and also supports `search_files`.

## Scope

### Phase 1

- `run` requests submitted through the service API and console.
- Conservative natural-language filename extraction from `RunRequest.goal`.
- Exact filename resolution for artifacts owned by the job tenant and owner.
- Durable job-to-artifact bindings.
- MinIO-to-workspace materialization.
- Model path manifest.
- `read_file` and `search_files` against the materialized corpus.
- Deterministic retry and recovery.

### Phase 2

- Explicit `fileRefs` in public requests and a console artifact selector.
- Equivalent file references for chat, swarm, and orchestration requests.
- Artifact-ID references for duplicate filename disambiguation.

### Phase 3

- Editable bindings.
- `edit_file` against writable workspace copies.
- Changed-file checkpoints published as new immutable artifacts.
- Source artifact lineage.

## Non-goals

- Do not search all MinIO objects from `search_files`.
- Do not expose MinIO object keys or physical paths to clients.
- Do not select the newest artifact when filenames are ambiguous.
- Do not overwrite an existing MinIO object after `edit_file`.
- Do not make Core depend on service tables, MinIO, tenants, or service jobs.
- Do not infer arbitrary paths from natural language.
- Do not support cross-owner or cross-tenant file references.
- Do not index artifact contents in PostgreSQL in this change.

## Existing Behavior and Gap

The current service:

- Accepts a run goal and optional JSON input, but no file reference contract.
- Creates a fresh local workspace for each claimed command.
- Configures the agent workspace as the `artifacts/` output directory.
- Uploads files from `artifacts/` to MinIO when the workspace closes.
- Deletes the complete workspace after ingestion.
- Supports authenticated artifact downloads, but not worker input materialization.

Consequently, `read_file("report.md")` resolves under an empty output directory and fails with `ENOENT` even when an artifact named `report.md` exists in MinIO.

## Architecture

```text
Run goal
  |
  v
Conservative filename extraction
  |
  v
Owner-scoped artifact resolution ----> service_artifacts
  |
  v
Persist job file binding
  |
  v
Download by server-only storage_key --> MinIO
  |
  v
Verify size and SHA-256
  |
  v
Materialize under workspace/inputs
  |
  +------------------------------+
  |                              |
  v                              v
Model path manifest         File tools
                             read_file
                             search_files
```

## Data Model

Add a migration for durable job file bindings. Use the next available service migration number.

```sql
create table if not exists service_job_file_refs (
  job_id uuid not null references service_jobs(id) on delete cascade,
  requested_name text not null,
  source_artifact_id uuid not null references service_artifacts(id),
  current_artifact_id uuid not null references service_artifacts(id),
  access_mode text not null default 'read',
  source_content_hash text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (job_id, requested_name),
  check (access_mode in ('read', 'editable'))
);

create index if not exists service_job_file_refs_source_idx
  on service_job_file_refs(source_artifact_id);

create index if not exists service_job_file_refs_current_idx
  on service_job_file_refs(current_artifact_id);
```

Phase 1 always writes `access_mode = 'read'` and initially sets `current_artifact_id = source_artifact_id`.

The binding has two purposes:

1. Retry and recovery continue using the same artifact ID even if newer artifacts with the same filename are created.
2. Phase 3 can advance `current_artifact_id` to an edited checkpoint without changing source lineage.

### Retention

An artifact referenced by either `source_artifact_id` or `current_artifact_id` must not be deleted by normal expiration reconciliation while its owning job remains recoverable.

The implementation must update reconciliation queries so a bound artifact is not deleted. Define a bounded retention rule rather than pinning forever. The initial rule should retain bound artifacts until the later of:

- the artifact's normal `expires_at`; or
- the job's recovery/retention deadline, if such a deadline already exists.

If no job recovery deadline exists, add a conservative service configuration for file-reference retention and document its default. Do not silently create permanent retention.

## Filename Reference Grammar

Natural-language extraction is a compatibility convenience for Phase 1. It must be conservative and deterministic.

Recognize a basename after an input-oriented verb such as:

- `read`
- `open`
- `review`
- `evaluate`
- `summarize`
- `summarise`
- `search`
- `inspect`
- `analyze`
- `analyse`

Recognize:

- Bare basenames without whitespace, such as `report.md`.
- Backtick-delimited basenames, such as `` `quarterly report.md` ``.
- Single- or double-quoted basenames, such as `"quarterly report.md"`.

Reject extracted references containing:

- `/` or `\`.
- `.` or `..` as path segments.
- NUL or control characters.
- More than the configured filename length.
- Unsupported file extensions, if the service already has a media allowlist suitable for reuse.

Do not interpret output-oriented phrases such as `write report.md`, `create report.md`, or `save as report.md` as input references.

Keep extraction in a small pure function with table-driven tests. Do not introduce an LLM call to parse references.

Phase 2 explicit `fileRefs` supersede natural-language extraction when both are present.

## Artifact Resolution

Add a repository operation that resolves candidates by exact authoritative ownership and filename:

```sql
select a.*
from service_artifacts a
join service_jobs source_job on source_job.id = a.job_id
where a.tenant_id = $1
  and a.owner_user_id = $2
  and a.original_filename = $3
  and a.status = 'available'
  and (a.expires_at is null or a.expires_at > now())
order by a.created_at desc, a.id;
```

Required outcomes:

- Zero candidates: fail before model execution with `INPUT_FILE_NOT_FOUND`.
- One candidate: create or reuse the job binding.
- More than one candidate: fail with `INPUT_FILE_AMBIGUOUS`; never select newest automatically.
- Existing binding: use `current_artifact_id` without repeating filename selection.

The public service error can remain non-enumerating, but internal job events and logs should identify the requested filename and safe failure category. Do not log `storage_key` or file contents.

Binding creation must be idempotent under duplicate queue delivery. Use the `(job_id, requested_name)` primary key and verify that an existing binding points to the expected artifact.

## Storage API

Keep MinIO details behind the service artifact layer. Do not expose `PrivateObjectStorage` directly to Core or public SDK consumers.

Add service-level operations equivalent to:

```ts
interface MaterializedArtifactInput {
  artifactId: string;
  filename: string;
  mediaType: string;
  byteSize: number;
  contentHash: string;
  data: Uint8Array;
}

interface JobFileMaterializer {
  prepare(job: ServiceJob, workspace: JobWorkspace): Promise<PreparedJobFiles>;
}

interface PreparedJobFile {
  artifactId: string;
  filename: string;
  relativePath: string;
  mediaType: string;
  byteSize: number;
  contentHash: string;
}

interface PreparedJobFiles {
  files: PreparedJobFile[];
  modelContext?: string;
}
```

Exact names may follow existing repository conventions. Prefer extending the current artifact repository/manager and workspace policy over adding parallel storage abstractions.

## Workspace Layout

Change the effective Agent SDK workspace from `workspace.artifacts` to `workspace.root`.

Use this layout:

```text
<job-workspace>/
  inputs/
    <artifact-id>/
      <sanitized-original-filename>
  work/
    <artifact-id>/
      <sanitized-original-filename>
  artifacts/
    <new-output-files>
```

Phase 1 only uses `inputs/` and `artifacts/`.

Rules:

- `inputs/` contains materialized read-only source artifacts.
- `work/` is reserved for Phase 3 editable copies.
- `artifacts/` remains the only directory ingested as new output artifacts.
- The artifact ID directory prevents collisions between equal filenames.
- Materialized paths are generated by the server, never supplied by the prompt.
- `ArtifactWorkspacePolicy.close` must continue ingesting only `artifacts/`.

## Secure Materialization

For each pinned artifact:

1. Resolve the server-only `storage_key` from PostgreSQL.
2. Fetch the bytes from MinIO through `PrivateObjectStorage.get`.
3. Reject a missing object as `INPUT_FILE_UNAVAILABLE`.
4. Enforce per-file, total-byte, and file-count quotas before writing.
5. Verify `byte_size` and SHA-256 against the artifact row.
6. Create destination directories with private permissions.
7. Sanitize only the local display filename; preserve the original filename in metadata.
8. Create the destination file exclusively as a regular file.
9. Do not create symlinks or hardlinks.
10. Set read-only file and directory permissions where supported.
11. Return workspace-relative paths to the model; do not return MinIO keys.

Materialization must happen on every fresh workspace, including retry, recovery, resume, and continuation commands.

## Model Context Injection

After materialization and before `runRaw`, build a deterministic text manifest sorted by requested filename and artifact ID.

Pass the manifest as a text content part when the run API supports it. If the current service integration cannot pass text content parts without changing semantics, append a clearly delimited runtime-generated section to the effective model input while preserving the stored user goal unchanged.

Required instruction content:

- Exact workspace-relative path for every referenced file.
- Direction to call `read_file` before using file contents.
- Direction to use `search_files` under `inputs` for corpus search.
- Direction not to infer contents from the filename.

Do not inline complete file contents by default. A future size-bounded optimization may inline small text files, but it is not part of this implementation.

## Tool Behavior

### `read_file`

No Core change should be needed. Once the artifact is materialized and the agent workspace is the job root, the model can call:

```json
{
  "path": "inputs/758b434e-35e1-4a6e-b312-7bf640648fb9/report.md"
}
```

The service must not add MinIO lookup behavior to Core's generic `read_file` tool.

### `search_files`

No Core change should be needed. All files explicitly referenced by the task are materialized before the model runs. The model can call:

```json
{
  "path": "inputs",
  "query": "deep research",
  "include": ["**/*.md"]
}
```

`search_files` searches only the materialized job corpus. It must not trigger a download of every artifact owned by the user.

### `edit_file`

Phase 1 must not promise durable edit semantics.

Phase 3 behavior:

1. Resolve an editable reference and copy it to `work/<artifact-id>/<filename>`.
2. Record its starting artifact ID and content hash.
3. Let `edit_file` modify only the workspace copy.
4. At every workspace close boundary, hash the final file.
5. If unchanged, publish nothing.
6. If changed, scan and ingest it under a new artifact ID and storage key.
7. Record `source_artifact_id` lineage on the new artifact or in an associated lineage table.
8. Update the binding's `current_artifact_id` to the new checkpoint.
9. Re-materialize the latest checkpoint on resume, retry, or recovery.

Never overwrite the source MinIO object. Existing artifact hash, size, and provenance must remain true forever.

## Error Semantics

Add internal failure categories:

- `INPUT_FILE_NOT_FOUND`
- `INPUT_FILE_AMBIGUOUS`
- `INPUT_FILE_UNAVAILABLE`
- `INPUT_FILE_INTEGRITY_ERROR`
- `INPUT_FILE_TOO_LARGE`
- `INPUT_FILE_COUNT_EXCEEDED`
- `INPUT_FILE_TOTAL_BYTES_EXCEEDED`

Classify deterministic lookup, ambiguity, policy, and integrity failures as non-retryable. Classify temporary MinIO/network failures as retryable.

Public HTTP responses must not reveal another user's filenames or artifact existence. Worker failures may persist the safe requested filename because it originated in the owner's own request, but must not expose storage keys.

## Security Requirements

- Always filter with both `tenant_id` and `owner_user_id`.
- Never trust tenant, owner, artifact status, or storage key supplied by the client.
- Require `available` and unexpired artifacts for initial binding.
- Keep quarantined objects unavailable to automatic resolution.
- Enforce exact owner checks again in the worker before materialization.
- Audit successful and failed materialization attempts without recording content.
- Use regular-file-only workspace writes.
- Prevent path traversal through extracted or original filenames.
- Keep durable MinIO credentials and keys outside model context and tool results.
- Apply existing artifact input quotas or introduce equivalent bounded defaults.

## Implementation Sequence

### Step 1: Add pure filename extraction

- Add a small service-owned parser for conservative task filename references.
- Support `Read report.md and summarise`.
- Add table-driven parser tests before integrating storage.

### Step 2: Add persistence and repository methods

- Add the `service_job_file_refs` migration.
- Add owner-scoped candidate lookup.
- Add idempotent binding lookup/create operations.
- Exclude actively pinned artifacts from retention deletion.

### Step 3: Add artifact input retrieval

- Add an internal method to retrieve a bound artifact's bytes from MinIO.
- Reuse existing private storage, ownership metadata, hash, and quota concepts.
- Do not route worker materialization through the public HTTP download endpoint.

### Step 4: Prepare workspace inputs

- Create `inputs/` during workspace preparation when references exist.
- Download, verify, and write all bound files.
- Return a prepared-file manifest.
- Keep output ingestion scoped to `artifacts/`.

### Step 5: Change the agent workspace root

- Pass `workspace.root` to Agent SDK configuration.
- Verify that generated outputs are still directed to `artifacts/` by agent instructions/profile configuration.
- Ensure existing output artifact tests continue to pass.

### Step 6: Inject model context

- Add the deterministic file manifest before model execution.
- Verify the stored user goal remains unchanged.
- Verify the first model request can see exact file paths.

### Step 7: Integrate retry and recovery

- Reuse existing bindings.
- Re-materialize the same current artifact into every fresh workspace.
- Do not repeat filename selection when a binding exists.

### Step 8: Extend explicit request contracts

- After Phase 1 works, add typed `fileRefs` to service SDK and HTTP schemas.
- Add console selection and duplicate disambiguation.
- Keep filename extraction as compatibility behavior.

### Step 9: Add editable checkpoints

- Implement Phase 3 only after read/search behavior and recovery are stable.

## Tests

### Filename extraction

- Extracts `report.md` from `Read report.md and summarise`.
- Extracts quoted and backtick filenames containing spaces.
- Supports multiple input references.
- Ignores `write report.md` and `save as report.md`.
- Rejects traversal and path separators.
- Deduplicates repeated references deterministically.

### Ownership and resolution

- Resolves one exact available artifact for the same tenant and owner.
- Does not resolve an artifact with the same owner ID in another tenant.
- Does not resolve another user's artifact in the same tenant.
- Rejects quarantined, deleted, uploading, scanning, and expired artifacts.
- Returns not found for zero matches.
- Returns ambiguous for multiple matches.
- Reuses an existing job binding even after a newer same-name artifact appears.
- Binding creation remains idempotent under duplicate delivery.

### Materialization

- Downloads the expected MinIO object.
- Writes it beneath `inputs/<artifact-id>/`.
- Verifies byte size and SHA-256.
- Fails when the object is missing or corrupt.
- Enforces file-count and byte quotas.
- Never writes outside the workspace.
- Never exposes `storage_key` in model context or public errors.
- Does not ingest unchanged input files as output artifacts.

### Model and tools

- The first model request contains the exact generated path manifest.
- `read_file` can read the materialized file.
- `search_files` can search one and multiple materialized files under `inputs`.
- An unreferenced user artifact is not searchable in the job workspace.
- The stored run goal remains the original user goal.

### Lifecycle

- Retry materializes the same pinned artifact.
- Recovery materializes the same pinned artifact.
- A newer same-name artifact does not alter an existing job.
- Workspace cleanup removes local input copies.
- Pinned source retention survives through the configured recovery window.

### Phase 3 edits

- Unchanged editable copies create no new artifact.
- Changed copies create a new artifact and storage key.
- Original MinIO bytes and metadata remain unchanged.
- The binding advances to the new checkpoint.
- Resume materializes the edited checkpoint.

## Verification Commands

Use the narrowest package-local commands first:

```bash
bunx vitest run packages/service/src/<new-or-touched-test>.test.ts
bunx vitest run packages/service/src/artifacts.test.ts
bunx vitest run packages/service/src/backend.test.ts
bunx vitest run packages/service/src/http-server.test.ts
bun run --cwd packages/service typecheck
bun run --cwd packages/service-sdk typecheck
```

Use the scripts actually defined by each touched package. If a listed typecheck script is absent, run the existing package build or test script instead of introducing a new workflow solely for this change.

Perform one MinIO integration run using the console:

1. Produce or upload a unique `report.md` artifact.
2. Submit `Read report.md and summarise` as the same tenant and owner.
3. Confirm the trace shows a successful `read_file` call against `inputs/<artifact-id>/report.md`.
4. Submit the same task after creating a second owned `report.md`.
5. Confirm the job fails or requests disambiguation rather than selecting newest.
6. Retry the original successfully bound job and confirm it reads the originally pinned hash.

## Acceptance Criteria

- `Read report.md and summarise` succeeds when exactly one eligible owned `report.md` exists.
- The model receives a local path manifest and uses existing file tools to obtain content.
- Files remain private to the exact tenant and owner.
- Duplicate filenames are never resolved implicitly.
- `search_files` sees only the files pinned to the job.
- Retry and recovery use pinned artifact IDs, not repeated latest-name lookup.
- Input files are not uploaded again as ordinary outputs.
- No MinIO key or credential appears in model context, tool output, logs, or public API responses.
- Existing artifact output, download, quarantine, retention, and cleanup behavior remains intact.
- Phase 1 makes no claim that edits are durable; Phase 3 publishes edits as new immutable artifacts.

## Coding-Agent Guardrails

- Read current uncommitted changes before editing; service artifact and console files may already be in progress.
- Preserve the Core versus Agent SDK responsibility boundary. Core file tools remain generic and service-unaware.
- Prefer extending existing artifact, workspace, and repository abstractions over introducing duplicate managers.
- Keep Phase 1 read/search-only unless editable checkpoint behavior is explicitly requested.
- Do not broaden filename matching after tests fail; ambiguity and false-positive avoidance are correctness requirements.
- Do not make tests pass by selecting the newest duplicate artifact.
- Do not overwrite MinIO objects.
- Do not revert or rewrite unrelated service changes.
