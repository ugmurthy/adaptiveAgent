# Desktop File Attachments and Media Routing Spec

Status: Final implementation specification

Target desktop protocol: `1.13`

Implementation status: protocol `1.13` phase 1 implements secure generic-file
attachments. Image/audio catalog orchestration remains fail-closed pending the
durable orchestration state required by sections 8-10; it must not be advertised
as available before those restart, cancellation, and replay semantics exist.

## 1. Outcome

The desktop app must accept one or more file attachments alongside:

- A task description.
- A chat user message.

The source file may be anywhere the signed-in operating-system user can select,
including outside the configured workspace.

The app must import a durable snapshot of each selected file. Execution must not
depend on the original path remaining readable or unchanged.

Routing is automatic:

- No attachments: direct execution with the pinned agent.
- Generic files only: direct execution with the pinned agent.
- Any image or audio attachment: catalog orchestration.
- Mixed generic and image/audio attachments: catalog orchestration for the whole
  submission, with generic files retained for final synthesis.

The renderer must not choose an agent, submit a path, or override automatic
routing.

## 2. Scope boundary

This feature requires coordinated changes in:

- `packages/desktop-app`: selection, staging, UI, workbench persistence,
  execution tracking, deletion, and trace targeting.
- `packages/desktop-bridge`: protocol `1.13`, attachment validation and
  translation, direct execution, and orchestration execution/control.
- `packages/core`: execution-scoped file authority, multiple read roots,
  canonical path validation, and durable orchestration records.
- `packages/agent-sdk`: durable catalog orchestration, stage identity,
  attachment propagation, and chat-turn synthesis.

Changes limited to `desktop-bridge` and core are not sufficient. The current
desktop app stores chat content as strings and assumes one workbench run equals
one core root run. The current orchestration SDK creates multiple independent
root runs, stores its scheduler state in memory, and does not preserve a
host-assigned run ID for its stages.

The package boundary remains:

- Core owns durable execution and orchestration state.
- Agent SDK owns catalog loading, modality routing, and agent construction.
- Desktop bridge translates the restricted desktop protocol into Agent SDK and
  core requests.
- Desktop app owns native file selection and product-level workbench records.

## 3. Normative terminology

- `attachmentId`: native-generated identity for one immutable imported file.
- `executionId`: native-generated identity for one user submission.
- `runId`: identity of one core root run.
- `chatSessionId`: stable session shared by turns in one persistent chat.
- `orchestration session`: durable set of specialist and synthesis root runs for
  one `executionId`.
- `requested agent`: the agent pinned by desktop configuration or chat.
- `specialist agent`: a catalog agent selected for `image` or `audio` input.

For direct execution, `runId` equals `executionId`. For orchestrated execution,
`executionId` identifies the orchestration session and each stage has its own
`runId`.

## 4. Native import and storage

### 4.1 Managed attachment store

Tauri native code must copy selected files into:

```text
<appData>/attachments/<attachmentId>/<safeName>
```

The managed store must not be placed in the workspace. Workspace staging would
pollute repositories, expose imported inputs to workspace write tools, and risk
showing inputs as generated artifacts.

The original source path must not be:

- Returned to the renderer.
- Sent to `desktop-bridge`.
- Persisted in workbench SQLite.
- Sent to a model provider.

### 4.2 Import rules

Native import must:

1. Reject directories, devices, FIFOs, sockets, and symbolic links.
2. Create a fresh UUID attachment directory without following links.
3. Copy the selected bytes into a new file; never retain a reference to the
   original file.
4. Use private permissions where supported: directory `0700`, payload `0600`.
5. Compute SHA-256 and byte size from the staged bytes.
6. Detect media type from file bytes, using extension only as a secondary hint.
7. Persist only a path relative to the managed attachment root.
8. Revalidate the staged regular file, size, and hash before submission.

Initial limits are:

- 8 attachments per submission.
- 10 MiB per attachment.
- 40 MiB total per submission.

The bridge advertises these limits. The renderer must not maintain an
independent source of truth.

Attachments are disabled when app-data persistence is unavailable. The current
in-memory workbench fallback must not accept attachment drafts.

### 4.3 Classification

Each imported attachment has exactly one kind:

```ts
type DesktopAttachmentKind = 'file' | 'image' | 'audio';
```

Classification order:

1. A supported, detected image MIME type becomes `image`.
2. A supported, detected audio MIME type becomes `audio`.
3. Every other accepted regular file becomes `file`.

Renaming a PDF to `.png` must not route it as an image. Unknown or conflicting
types become `file` unless the format is explicitly rejected by policy.

Supported image and audio MIME types must be derived from the effective model
and catalog capabilities. A file may be imported as a draft but must be rejected
before durable execution reservation if no valid route can consume it.

## 5. Renderer contract and UX

The renderer receives metadata and an opaque ID only:

```ts
interface AttachmentDraft {
  id: string;
  name: string;
  kind: DesktopAttachmentKind;
  sizeBytes: number;
  mimeType?: string;
}
```

Native commands:

```ts
selectAttachments(): Promise<AttachmentDraft[]>;
discardAttachmentDraft(attachmentId: string): Promise<void>;

startRun(
  description: string,
  attachmentIds: string[],
): Promise<StartedExecution>;

sendChatTurn(
  itemId: string,
  content: string,
  attachmentIds: string[],
): Promise<StartedExecution>;

interface StartedExecution {
  itemId: string;
  executionId: string;
  mode: 'direct' | 'catalog';
}
```

Task and chat message composers must support selecting, listing, and removing
draft attachment chips. Text remains required in protocol `1.13`; an
attachment-only submission is deferred.

The new-chat composer continues to create a title only and must not offer
attachments. Attachments belong to the first actual user message in the chat.

Drafts clear only after the native layer has durably claimed them. Failed
submission leaves the draft chips available for retry.

Persisted chat messages show attachment name, kind, and size. They never expose
the staged path.

## 6. Workbench persistence

### 6.1 Execution envelope

The workbench must stop treating every product execution ID as a core run ID.

```sql
create table workbench_executions (
  execution_id text primary key,
  item_id text not null references workbench_items(id) on delete cascade,
  turn_index integer,
  invocation_kind text not null check (invocation_kind in ('run', 'chat')),
  execution_mode text not null check (execution_mode in ('direct', 'catalog')),
  final_run_id text,
  trace_target_json text not null,
  cached_status text not null,
  submission_state text not null,
  cancel_requested integer not null default 0,
  result_json text,
  workspace_root text not null,
  shell_cwd text not null,
  created_at text not null,
  updated_at text not null
);
```

Existing `workbench_runs` rows migrate as direct executions:

- `execution_id = run_id`.
- `execution_mode = 'direct'`.
- `final_run_id = run_id`.
- Trace target is `{ "kind": "root-run", "rootRunId": run_id }`.

An implementation may evolve `workbench_runs` in place instead of renaming it,
provided these semantics and migration behavior are preserved.

### 6.2 Attachment ownership

```sql
create table attachments (
  attachment_id text primary key,
  staged_relative_path text not null unique,
  display_name text not null,
  kind text not null check (kind in ('file', 'image', 'audio')),
  mime_type text,
  audio_format text,
  size_bytes integer not null,
  sha256 text not null,
  state text not null check (state in ('draft', 'owned', 'delete_pending')),
  created_at text not null,
  claimed_at text
);

create table task_attachments (
  item_id text not null references workbench_items(id) on delete cascade,
  attachment_id text not null unique references attachments(attachment_id),
  ordinal integer not null,
  primary key (item_id, ordinal)
);

create table message_attachments (
  message_id text not null references chat_messages(id) on delete cascade,
  attachment_id text not null unique references attachments(attachment_id),
  ordinal integer not null,
  primary key (message_id, ordinal)
);
```

Claiming drafts and reserving the task or chat message must occur in one SQLite
transaction.

Task attachments belong to the task item so retry and recovery reuse the same
snapshot. Chat attachments belong to the specific user message so complete
transcript reconstruction and suffix deletion remain deterministic.

`chat_messages.content_json` may continue storing the text string. Attachment
joins reconstruct structured content for the bridge.

Each chat pins `workspace_root` in addition to its agent identity. A missing or
changed pinned workspace makes the chat read-only.

## 7. Desktop protocol `1.13`

Attachment and execution-envelope fields are valid only after explicit `1.13`
negotiation. Protocol versions through `1.12` must reject them rather than
ignore them.

### 7.1 Initialization

Native Tauri code supplies the attachment authority boundary:

```ts
interface RuntimeInitializeParamsV113 extends RuntimeInitializeParams {
  managedAttachmentRoot?: string;
}
```

The bridge canonicalizes this root once. It must reject a renderer- or RPC-
supplied path that is not an owned staged attachment beneath this root.

Initialization returns:

```ts
interface DesktopAttachmentCapabilities {
  enabled: boolean;
  maxFileBytes: number;
  maxAttachmentCount: number;
  maxSubmissionBytes: number;
  acceptedKinds: DesktopAttachmentKind[];
  supportedImageMimeTypes: string[];
  supportedAudioMimeTypes: string[];
  supportedGenericMimeTypes: string[];
  routing: {
    taskImage: 'catalog';
    taskAudio: 'catalog';
    taskGeneric: 'direct';
    chatImage: 'catalog';
    chatAudio: 'catalog';
    chatGeneric: 'direct';
  };
  reason?: string;
}
```

Capabilities must reflect the effective requested agent, active model, visible
tools, and catalog. Declared profile metadata alone is insufficient.

### 7.2 Trusted attachment descriptor

Only native code may construct this descriptor:

```ts
type AudioFormat =
  | 'wav' | 'mp3' | 'flac' | 'm4a' | 'ogg'
  | 'aac' | 'aiff' | 'pcm16' | 'pcm24';

interface DesktopAttachmentInput {
  attachmentId: string;
  kind: DesktopAttachmentKind;
  stagedRelativePath: string;
  name: string;
  mimeType?: string;
  sizeBytes: number;
  sha256: string;
  audioFormat?: AudioFormat;
}
```

The descriptor uses a managed-root-relative path. The bridge resolves and
canonicalizes it; absolute descriptor paths are invalid.

### 7.3 Task request

```ts
interface RunParamsV113 {
  executionId: string;
  goal: string;
  attachments?: DesktopAttachmentInput[];
  input?: JsonValue;
  inferenceMode?: InferenceMode;
  inferenceTier?: InferenceTier;
  profileRef?: ProfileRef;
}
```

### 7.4 Chat request

```ts
interface DesktopChatMessageV113 {
  role: 'user' | 'assistant';
  text: string;
  attachments?: DesktopAttachmentInput[];
}

interface ChatParamsV113 {
  executionId: string;
  chatSessionId: string;
  transcript: DesktopChatMessageV113[];
  inferenceMode?: InferenceMode;
  inferenceTier?: InferenceTier;
  profileRef?: ProfileRef;
}
```

Only user messages may have attachments. The bridge validates every nested
field and rejects unknown discriminants, unsupported source kinds, duplicate
attachment IDs, stale descriptors, and descriptors outside the managed root.

### 7.5 Core translation

The bridge translates descriptors to existing core content parts:

```ts
type DesktopCoreAttachmentPart =
  | {
      type: 'image';
      image: { path: string; name: string; mimeType?: string };
    }
  | {
      type: 'file';
      file: {
        source: { kind: 'path'; path: string };
        name: string;
        mimeType?: string;
      };
    }
  | {
      type: 'audio';
      audio: {
        source: { kind: 'path'; path: string };
        name: string;
        mimeType?: string;
        format?: AudioFormat;
      };
    };
```

An attachment-bearing chat user message becomes:

```ts
{
  role: 'user',
  content: [
    { type: 'text', text: message.text },
    ...translatedAttachments,
  ],
}
```

File bytes and base64 must not cross the Tauri IPC or NDJSON bridge protocol.

## 8. Core file authority

### 8.1 Execution-scoped access

Core must apply the same file authority to provider-native input and
`read_file` fallback. Provider-native support must not bypass workspace or
attachment containment.

The host supplies an opaque, non-model-visible execution context:

```ts
interface DesktopFileAccessContext {
  fileAccess: {
    version: 1;
    attachmentRoots: string[];
  };
}
```

The bridge must verify that each root is an immediate managed attachment
directory owned by the current submission before placing it in execution
context.

Core must authorize all path-backed inputs before run creation:

- `ImageInput.path`.
- `FileInput.source.kind === 'path'`.
- `AudioInput.source.kind === 'path'`.

Effective read roots are:

```text
[pinnedWorkspaceRoot, ...ownedAttachmentRoots]
```

Relative paths resolve only against the workspace root. Attachment paths must
be absolute canonical paths produced by the bridge.

### 8.2 `read_file` roots

Core extends the read tool contract compatibly:

```ts
interface ReadFileToolConfig {
  allowedRoot?: string;
  allowedRoots?:
    | readonly string[]
    | ((context: ToolExecutionContext) => readonly string[]);
}
```

`allowedRoot` and `allowedRoots` are mutually exclusive. Existing callers keep
their current behavior.

Containment must use canonical filesystem paths and reject symlink escapes.
Lexical `resolve`/`relative` checks alone are insufficient.

One execution must not be able to read another execution's attachment directory
by guessing its UUID.

## 9. Automatic orchestration

### 9.1 Routing policy

The bridge computes execution mode after validating attachments:

```ts
function executionMode(
  attachments: DesktopAttachmentInput[],
): 'direct' | 'catalog' {
  return attachments.some(
    (attachment) => attachment.kind === 'image' || attachment.kind === 'audio',
  ) ? 'catalog' : 'direct';
}
```

This decision is not renderer-configurable in protocol `1.13`.

The catalog router selects specialists by `image` or `audio` modality using
agent `modalitiesSupported`, `modalitiesPreferred`, and `modalityRoles`.
Exact MIME type may validate compatibility but does not independently select an
agent in `1.13`.

Planning must fail before any stage starts if no catalog route can consume a
required image or audio modality.

### 9.2 Durable orchestration contract

Agent SDK must expose a durable execution API backed by core-owned stores:

```ts
interface OrchestratedExecutionOptions
  extends Omit<AgentSdkRunOptions, 'runId' | 'sessionId'> {
  executionId: string;
  requestedAgentId: string;
  catalogFingerprint: string;
}

interface DurableOrchestrationSdk {
  runRaw(
    goal: string,
    options: OrchestratedExecutionOptions,
  ): Promise<OrchestratedExecutionResult>;

  inspectExecution(executionId: string): Promise<ExecutionInspection>;
  interruptExecution(executionId: string): Promise<void>;
  resumeExecution(executionId: string): Promise<OrchestratedExecutionResult>;
}
```

Before media routing is enabled, orchestration must:

1. Persist the request, catalog fingerprint, deterministic plan, and node rows
   before launching a stage.
2. Allocate and persist each stage `runId` before calling core.
3. Pass `sessionId: executionId` and the allocated `runId` to every task stage.
4. Persist a queued stage link before `runRaw`, not after it returns.
5. Resume after restart without duplicating completed or active stages.
6. Stop launching nodes after cancellation and interrupt every active stage.
7. Treat approval or clarification as a paused stage, not successful output.
8. Refuse resume if the pinned catalog fingerprint is unavailable or changed.
9. Preserve generic file parts for final synthesis in mixed submissions.
10. Pass raw media to final synthesis only when the requested agent supports it.

Each task stage includes:

```ts
{
  runId: stageRunId,
  sessionId: executionId,
  metadata: {
    orchestration: {
      kind: 'catalog',
      executionId,
      nodeId,
      stage,
      requestedAgentId,
      selectedAgentId,
      dependsOn,
    },
  },
}
```

### 9.3 Chat media orchestration

Chat remains pinned to one requested agent and must produce exactly one durable
assistant message per user turn. Image/audio attachments therefore use a
specialist-analysis-then-chat-synthesis flow:

1. Persist the user message and attachment ownership.
2. Create a unique `executionId` for the turn.
3. Run catalog-selected image/audio specialist stages with the current user text
   and only their selected media claims.
4. Invoke the pinned agent with `chatRaw` using the complete durable transcript.
5. Add specialist outputs to the current turn as non-persisted, clearly labelled
   synthesis context.
6. Pass generic file parts on their original user messages.
7. Pass raw image/audio to the final chat request only if the pinned agent can
   consume them; otherwise only specialist analyses reach final synthesis.
8. Persist only the final pinned-agent assistant response in `chat_messages`.

The specialist analysis must not be represented as assistant chat history. On
later turns, the original attachment remains in the reconstructed user message;
the system may reuse persisted specialist outputs associated with that turn
rather than rerunning specialists.

Core-owned orchestration records must therefore persist specialist outputs and
link them to `executionId`. Workbench records link that execution to the chat
turn.

Cancellation interrupts active specialists or the final chat run and prevents
an assistant message from being finalized. Resume continues from durable stage
state.

## 10. Execution control, results, and trace

Protocol `1.13` adds execution-envelope methods:

```text
execution/inspect
execution/interrupt
execution/resume
```

Existing `run/*` methods remain core-run operations for compatibility.

For direct execution:

- `executionId = runId`.
- Stop delegates to `run/interrupt`.
- Trace target is `{ kind: 'root-run', rootRunId: executionId }`.

For catalog execution:

- `executionId` is the orchestration session ID.
- Every stage has a separate root `runId`.
- Stop interrupts every active stage and prevents new stages.
- Trace target is `{ kind: 'session', sessionId: executionId }` for task
  orchestration.
- Chat-turn inspection returns the specialist stage roots plus final chat root.

Whole-execution steering, retry, and automatic recovery are deferred for catalog
executions in `1.13` and must return an explicit
`UNSUPPORTED_FOR_ORCHESTRATION` error. Durable resume after interruption or
restart is required.

Interaction events identify both `executionId` and the actual stage `runId`.
Approval resolution targets the stage run and then resumes the execution
scheduler.

Execution result shape:

```ts
interface DesktopExecutionResult {
  executionId: string;
  mode: 'direct' | 'catalog';
  status: string;
  finalRunId?: string;
  traceTarget:
    | { kind: 'root-run'; rootRunId: string }
    | { kind: 'session'; sessionId: string };
  stages?: Array<{
    nodeId: string;
    stage: string;
    agentId: string;
    runId: string;
    rootRunId: string;
    status: string;
  }>;
  result?: RunResult;
}
```

## 11. Lifetime and deletion

- Unowned drafts expire after 24 hours.
- Claimed task attachments live until the task item is deleted.
- Chat attachments live until their owning message is deleted.
- Chat suffix deletion removes attachments and media analyses for deleted turns.
- Active or resumable executions must not lose referenced attachments.
- Filesystem deletion happens after a durable `delete_pending` transition.
- Deletion is idempotent because SQLite and filesystem updates cannot be atomic.
- Startup reconciliation retries pending deletion and removes orphaned staging
  directories.
- Missing or hash-mismatched staged files make the owning execution explicitly
  unrecoverable; the system must not silently read the original source path.

## 12. Security requirements

- Renderer input is untrusted.
- The renderer never receives or submits attachment paths.
- Desktop protocol rejects absolute staged paths and non-path source kinds.
- Desktop protocol does not accept attachment URLs, provider file IDs, or inline
  base64 in `1.13`.
- Native import and bridge resolution reject symlink traversal.
- Core validates execution-time file authority even after bridge validation.
- Provider-native adapters and local tools enforce the same authority.
- Attachment paths and bytes are excluded from normal logs and trace payloads;
  traces may include ID, display name, kind, MIME type, size, and SHA-256.
- File bytes never cross Tauri IPC or NDJSON.
- Catalog summaries exposed to routing contain no file bytes or staged paths.

## 13. Failure semantics

Validation and routing must complete before reserving execution capacity where
possible. Failures use actionable categories:

- `ATTACHMENTS_UNAVAILABLE`
- `ATTACHMENT_NOT_FOUND`
- `ATTACHMENT_CHANGED`
- `ATTACHMENT_TOO_LARGE`
- `ATTACHMENT_TYPE_UNSUPPORTED`
- `ATTACHMENT_PATH_INVALID`
- `MEDIA_ROUTE_UNAVAILABLE`
- `CATALOG_CHANGED`
- `ORCHESTRATION_RECOVERY_REQUIRED`
- `UNSUPPORTED_FOR_ORCHESTRATION`

If durable workbench reservation succeeds but bridge submission fails, the user
message and attachment ownership remain durable and submission state becomes
`submission_failed`, matching existing chat semantics.

## 14. Required tests

### Native and workbench

- Select a file outside the workspace, submit it, then delete or modify the
  original; execution and recovery use the staged bytes.
- Reject directories, symlinks, devices, oversized files, excessive counts, and
  aggregate overflow.
- Draft claim is atomic with task/chat reservation.
- Attachment metadata and chat transcript survive close and reopen.
- Existing text-only workbench data migrates unchanged.
- Chat suffix deletion removes only later message attachments.
- Startup cleanup is idempotent.

### Bridge protocol

- Protocol `1.13` accepts exact valid descriptors.
- Protocol through `1.12` rejects attachment and execution-envelope fields.
- Reject malformed nested parts, duplicate IDs, stale descriptors, absolute
  paths, traversal, symlink escape, unsupported MIME/format combinations, and
  hash mismatch.
- Direct tasks forward exact generic file content parts.
- Image/audio tasks always select catalog mode.
- Image/audio chat turns execute specialist analysis before pinned-agent final
  synthesis.

### Core file authority

- Workspace and owned attachment roots are readable.
- A different execution's attachment directory is not readable.
- Provider-native input cannot bypass authorization.
- `read_file` fallback supports owned app-data attachments.
- Relative paths resolve only against workspace.
- Lexical and symlink escapes fail.

### Orchestration

- Generic-only execution creates one root with `runId = executionId`.
- Image and audio claims route to compatible catalog specialists.
- Mixed generic/media input retains generic files for final synthesis.
- Every stage ID and link is persisted before launch.
- Restart resumes without duplicate stages.
- Stop interrupts active roots and starts no later nodes.
- Approval pauses and resumes the owning stage and scheduler.
- Changed catalog fingerprint blocks resume.
- Chat orchestration persists one final assistant message and reuses prior media
  analysis on later turns.

### UI

- Task and chat message composers select, show, remove, and submit attachment
  chips.
- New-chat title mode has no attachment control.
- Failed submission preserves drafts; successful durable claim clears them.
- History shows attachment summaries without paths.
- Direct and catalog executions show correct status, stop behavior, result, and
  trace target.

## 15. Delivery sequence

Implementation must be delivered in reviewable phases:

1. Core canonical multi-root file authority and provider-native enforcement.
2. Core durable orchestration stores and Agent SDK resumable stage scheduler.
3. Bridge protocol `1.13`, capability reporting, descriptor validation, and
   direct generic-file execution.
4. Native staging, workbench migration, task attachments, lifecycle, and UI.
5. Task image/audio catalog orchestration and execution-envelope controls.
6. Chat attachment persistence and direct generic-file turns.
7. Chat image/audio specialist analysis and pinned-agent synthesis.
8. Deletion reconciliation, migration coverage, security tests, and full desktop
   acceptance verification.

No phase may expose an enabled attachment capability until its persistence,
authorization, cancellation, and restart tests pass.
