# Provider-Neutral File And Audio Input Extension

**Status**: Implementation-ready proposal
**Target baseline**: `agen-spec-v1.5.md` and `agen-contracts-v1.5.md`
**Scope**: `packages/core` contracts, runtime normalization, provider adapters, logging, and tests

## 1. Decision

This document is the implementation contract for adding provider-neutral `file` and `audio` inputs.

It replaces the earlier sketch-level guidance in `PROVIDER-SDK.md` for this topic.

The feature is approved with these boundaries:

- Add provider-neutral `file` and `audio` inputs to the internal runtime model.
- Keep the central `ModelAdapter` boundary unchanged.
- Preserve existing `text` and `image` behavior.
- Ship provider support only where the installed SDK types expose a typed chat input shape.
- Do not add provider-neutral `video` in this change.

## 2. What Was Missing

`PROVIDER-SDK.md` was not enough on its own because it did not define:

- deterministic input types
- modality-specific source support
- request-surface changes
- runtime validation rules
- logging and redaction behavior
- per-provider support commitments
- acceptance criteria

This document closes those gaps.

## 3. Non-goals

- Do not add `video`.
- Do not add a new persistence primitive.
- Do not add a generalized upload manager or attachment cache.
- Do not change tool, plan, delegate, or replay semantics beyond richer user input content.
- Do not mutate persisted user content from `path` to provider `file_id`.

## 4. Normative Terms

The keywords `MUST`, `MUST NOT`, `SHOULD`, and `MAY` are normative.

## 5. Contract Changes

### 5.1 Shared modality and source types

```ts
export type InputModality = 'text' | 'image' | 'file' | 'audio';
export type InputSourceKind = 'path' | 'url' | 'data' | 'file_id';
```

### 5.2 Source unions

```ts
export interface PathInputSource {
  kind: 'path';
  path: string;
}

export interface UrlInputSource {
  kind: 'url';
  url: string;
}

export interface DataInputSource {
  kind: 'data';
  data: string; // raw base64, not a data: URL
}

export interface FileIdInputSource {
  kind: 'file_id';
  fileId: string;
}

export type FileInputSource = PathInputSource | UrlInputSource | FileIdInputSource;
export type AudioInputSource =
  | PathInputSource
  | UrlInputSource
  | DataInputSource
  | FileIdInputSource;
```

### 5.3 File and audio inputs

```ts
export interface FileInput {
  source: FileInputSource;
  mimeType?: string;
  name?: string;
}

export interface AudioInput {
  source: AudioInputSource;
  mimeType?: string;
  format?: 'wav' | 'mp3' | 'flac' | 'm4a' | 'ogg' | 'aac' | 'aiff' | 'pcm16' | 'pcm24';
  name?: string;
}
```

### 5.4 Content parts

```ts
export interface ModelTextContentPart {
  type: 'text';
  text: string;
}

export interface ModelImageContentPart {
  type: 'image';
  image: ImageInput;
}

export interface ModelFileContentPart {
  type: 'file';
  file: FileInput;
}

export interface ModelAudioContentPart {
  type: 'audio';
  audio: AudioInput;
}

export type ModelContentPart =
  | ModelTextContentPart
  | ModelImageContentPart
  | ModelFileContentPart
  | ModelAudioContentPart;

export type ModelMessageContent = string | ModelContentPart[];
```

## 6. Request Surface

### 6.1 `RunRequest`

```ts
export interface RunRequest {
  goal: string;
  input?: JsonValue;
  images?: ImageInput[]; // legacy shorthand
  contentParts?: ModelContentPart[];
  context?: Record<string, JsonValue>;
  allowedTools?: string[];
  forbiddenTools?: string[];
  outputSchema?: JsonSchema;
  metadata?: Record<string, JsonValue>;
}
```

Rules:

- `goal` remains required.
- The runtime MUST build the initial user message as plain string `goal` when there are no media parts.
- The runtime MUST build the initial user message as `[{ type: 'text', text: goal }, ...normalizedParts]` when media parts are present.
- `images` MUST remain supported for compatibility.
- `images` MUST be normalized into `contentParts`.
- If both `images` and `contentParts` contain image inputs, the runtime MUST reject the request with a validation error instead of guessing merge intent.

### 6.2 `ChatMessage`

```ts
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: ModelMessageContent;
  images?: ImageInput[]; // compatibility-only shorthand
}
```

Rules:

- `images` is valid only when `content` is a string.
- The runtime MUST normalize `images` into structured content before adapter dispatch.
- New code SHOULD use `content: ModelMessageContent` directly.

### 6.3 `DelegateToolInput`

```ts
export interface DelegateToolInput {
  goal: string;
  input?: JsonValue;
  images?: ImageInput[]; // legacy shorthand
  contentParts?: ModelContentPart[];
  context?: Record<string, JsonValue>;
  outputSchema?: JsonSchema;
  metadata?: Record<string, JsonValue>;
}
```

Rules:

- Delegate input normalization MUST match `RunRequest`.

## 7. Capability Model

The earlier flat `inputSources` proposal is not precise enough because support varies by modality. Use modality-specific capabilities instead.

```ts
export interface InputModalityCapability {
  sources: InputSourceKind[];
  supportedMimeTypes?: string[];
  maxInlineBytes?: number;
}

export interface ModelCapabilities {
  toolCalling: boolean;
  jsonOutput: boolean;
  streaming: boolean;
  usage: boolean;
  imageInput?: boolean; // compatibility alias during migration
  input?: Partial<Record<'image' | 'file' | 'audio', InputModalityCapability>>;
}
```

Rules:

- `text` is always supported and is not declared in `input`.
- `imageInput` MUST be derived from `input?.image` once adapters migrate.
- A request containing modality `M` MUST be rejected before provider dispatch if `capabilities.input?.[M]` is absent.
- A request containing source kind `S` for modality `M` MUST be rejected before provider dispatch if `S` is not listed in `capabilities.input?.[M]?.sources`.
- If `maxInlineBytes` is defined for a modality, local path-to-inline conversion MUST enforce it before adapter dispatch.

## 8. Validation Rules

### 8.1 Role restrictions

- `user` messages MAY contain `text`, `image`, `file`, and `audio`.
- `system` messages MUST contain only plain text or `text` parts.
- `assistant` messages MUST NOT be generated by the runtime with `file` or `audio` parts.
- `tool` messages MUST remain plain text content.

### 8.2 General part rules

- Structured content arrays MUST preserve order exactly.
- Empty arrays MUST be rejected.
- `text` parts MUST contain a string.
- Non-text parts MUST include a non-empty logical name.
- The logical name MAY come from `name`.
- The logical name MAY come from a filename derived from `path`.
- The logical name MAY come from a filename derived from the URL pathname.
- `mimeType` MUST be present for `data` audio inputs.
- `mimeType` SHOULD be inferred for `path` inputs when absent.

### 8.3 File rules

- `file` source kinds are `path`, `url`, and `file_id`.
- `file` MUST NOT support `data` in this change.
- `path` MUST reference a regular file.
- `file_id` MUST be a non-empty string.
- `url` MUST be an absolute `http:` or `https:` URL.

### 8.4 Audio rules

- `audio` source kinds are `path`, `url`, `data`, and `file_id` at the shared contract level.
- `path` MUST reference a regular file.
- `data` MUST be raw base64 without a `data:` prefix.
- `format` SHOULD be supplied for audio when known.
- `mimeType` SHOULD be supplied for audio when known.

### 8.5 Shared local size limits

These constants MUST be added to the runtime:

```ts
export const MAX_LOCAL_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_LOCAL_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_LOCAL_AUDIO_BYTES = 25 * 1024 * 1024;
```

Rules:

- These are runtime admission limits, not provider guarantees.
- Providers MAY reject smaller payloads.
- The runtime MUST NOT fetch remote URLs during validation.

## 9. Provider Support Matrix

This is the required support matrix for the first implementation.

### 9.1 OpenRouter

SDK evidence:

- `ChatContentFile` supports `{ type: 'file', file: { fileData?, fileId?, filename? } }`
- `ChatContentAudio` supports `{ type: 'input_audio', inputAudio: { data, format } }`

Adapter commitments:

- `OpenRouterAdapter` MUST support `file` with sources `path`, `url`, and `file_id`.
- `OpenRouterAdapter` MUST support `audio` with sources `path` and `data`.
- `OpenRouterAdapter` MUST reject `audio` `url` and `file_id` sources with a deterministic validation error before SDK dispatch.
- For `file.path`, the adapter MUST read the local file and convert it to a base64 data URL in `file.fileData`.
- For `file.url`, the adapter MUST pass the URL string via `file.fileData`.
- For `file.file_id`, the adapter MUST map to `file.fileId`.
- For `audio.path`, the adapter MUST read and base64-encode the file into `inputAudio.data`.
- For `audio.data`, the adapter MUST pass the raw base64 string unchanged.
- For `audio`, the adapter MUST require `format`.

Capability declaration:

```ts
input: {
  image: { sources: ['path'] },
  file: { sources: ['path', 'url', 'file_id'], maxInlineBytes: MAX_LOCAL_FILE_BYTES },
  audio: { sources: ['path', 'data'], maxInlineBytes: MAX_LOCAL_AUDIO_BYTES },
}
```

### 9.2 Mistral

SDK evidence:

- `ContentChunk` includes `document_url`, `file`, and `input_audio`
- `FileChunk` uses `fileId`
- `DocumentURLChunk` uses `documentUrl`
- `AudioChunk` uses `inputAudio: string`

Adapter commitments:

- `MistralAdapter` MUST support `file` with sources `path`, `url`, and `file_id`.
- `MistralAdapter` MUST support `audio` with sources `path` and `data`.
- `MistralAdapter` MUST reject `audio` `url` and `file_id` sources before SDK dispatch.
- For `file.path`, the adapter MUST upload the file with the SDK file API and then send a chat `file` chunk using the returned `fileId`.
- For `file.url`, the adapter MUST send a `document_url` chunk with `documentUrl`.
- For `file.file_id`, the adapter MUST send a `file` chunk with `fileId`.
- For `audio.path`, the adapter MUST read and base64-encode the local file into the SDK `inputAudio` field.
- For `audio.data`, the adapter MUST pass the raw base64 string unchanged.

Capability declaration:

```ts
input: {
  image: { sources: ['path'] },
  file: { sources: ['path', 'url', 'file_id'] },
  audio: { sources: ['path', 'data'], maxInlineBytes: MAX_LOCAL_AUDIO_BYTES },
}
```

### 9.3 Mesh

SDK evidence:

- `ContentPart` includes `text`, `image_url`, and `input_audio`
- installed chat types do not expose a `file` content part

Adapter commitments:

- `MeshAdapter` MUST support `audio` with sources `path` and `data`.
- `MeshAdapter` MUST reject all `file` inputs before SDK dispatch.
- `MeshAdapter` MUST reject `audio` `url` and `file_id` sources before SDK dispatch.
- For `audio.path`, the adapter MUST read and base64-encode the file into `input_audio.data`.
- For `audio.data`, the adapter MUST pass the raw base64 string unchanged.
- `MeshAdapter` MUST continue current `image` behavior unchanged.

Capability declaration:

```ts
input: {
  image: { sources: ['path'] },
  audio: { sources: ['path', 'data'], maxInlineBytes: MAX_LOCAL_AUDIO_BYTES },
}
```

## 10. Logging And Redaction

The runtime MUST NOT log raw binary payloads.

For `file` and `audio`, log summaries MUST contain only:

- `type`
- source `kind`
- `name`
- `mimeType`
- `format` for audio
- `path` only when capture policy allows
- `url` only when capture policy allows
- `fileId` only when capture policy allows
- `sizeBytes` when known

The runtime MUST NOT log:

- inline base64 `data`
- derived data URLs
- uploaded multipart bodies

## 11. Persistence And Replay

- Existing `ModelMessage` persistence remains sufficient.
- Stored structured content MUST preserve `file` and `audio` parts losslessly.
- The runtime MUST persist the original shared-contract source form, not provider-specific transformed content.
- Adapter-generated upload IDs MUST remain transport-local for this change.

## 12. Required Code Changes

The implementation agent MUST update these files:

- `packages/core/src/types.ts`
- `packages/core/src/adaptive-agent.ts`
- `packages/core/src/logging.ts`
- `packages/core/src/adapters/base-openai-chat-adapter.ts`
- `packages/core/src/adapters/openrouter-adapter.ts`
- `packages/core/src/adapters/mistral-adapter.ts`
- `packages/core/src/adapters/mesh-adapter.ts`
- `packages/core/src/adapters/adapters.test.ts`
- any directly affected runtime tests under `packages/core/src`

### 12.1 `packages/core/src/types.ts`

Add:

- `InputModality`
- `InputSourceKind`
- `PathInputSource`
- `UrlInputSource`
- `DataInputSource`
- `FileIdInputSource`
- `FileInputSource`
- `AudioInputSource`
- `FileInput`
- `AudioInput`
- `ModelFileContentPart`
- `ModelAudioContentPart`
- modality-specific `ModelCapabilities.input`

Keep:

- `ImageInput`
- `imageInput?: boolean` during migration

### 12.2 `packages/core/src/adaptive-agent.ts`

Replace image-only validation helpers with modality-aware helpers:

- `isModelContentPart()` MUST accept `file` and `audio`
- add `isFileInput()`
- add `isAudioInput()`
- add source validators
- update user message construction so `RunRequest.goal` plus `contentParts` normalize deterministically
- keep legacy `images` shorthand working

### 12.3 `packages/core/src/logging.ts`

Extend content summarization to support:

- `file`
- `audio`

Do not log:

- `audio.source.data`
- any derived data URL

### 12.4 `packages/core/src/adapters/base-openai-chat-adapter.ts`

Generalize media admission logic:

- replace `messageHasImageInput()` with a generic structured-content scan
- add capability checks for `file` and `audio`
- add reusable helper `localFileToDataUrl()`
- add reusable helper `localAudioToBase64()`
- add MIME inference for common file and audio types

Do not:

- add generic provider mapping for `file` or `audio` in the base OpenAI fallback path

The fallback path MUST reject unsupported modalities unless a specific adapter overrides it.

### 12.5 Provider adapters

- `openrouter-adapter.ts` MUST add explicit `file` and `audio` content-part normalization to SDK camelCase types
- `mistral-adapter.ts` MUST add explicit `documentUrl`, `fileId`, and `inputAudio` mapping
- `mesh-adapter.ts` MUST add explicit `input_audio` mapping and explicit `file` rejection

## 13. Acceptance Criteria

The change is complete only if all of the following are true:

- A `RunRequest` with `goal + contentParts[file]` validates and reaches a supporting adapter.
- A `RunRequest` with `goal + contentParts[audio]` validates and reaches a supporting adapter.
- Legacy `images` callers still behave exactly as before.
- Unsupported modality/source combinations fail before provider dispatch with deterministic error messages.
- OpenRouter adapter tests cover `file.path`, `file.url`, `file.file_id`, `audio.path`, and `audio.data`.
- Mistral adapter tests cover `file.path`, `file.url`, `file.file_id`, `audio.path`, and `audio.data`.
- Mesh adapter tests cover `audio.path`, `audio.data`, and `file` rejection.
- Logging tests prove that inline base64 audio is never logged.
- Existing image tests continue to pass.

## 14. Required Tests

At minimum add or update tests for:

- `isModelContentPart()` accepts valid `file` parts
- `isModelContentPart()` accepts valid `audio` parts
- invalid `file.data` is rejected
- invalid `audio.data` with `data:` prefix is rejected
- `RunRequest.images` still normalizes to image parts
- duplicate `images` plus image `contentParts` is rejected
- unsupported modality rejection
- unsupported source-kind rejection
- file and audio log summarization redaction
- provider adapter mapping for each supported combination in Section 9

## 15. Verification Commands

Use the narrowest checks first:

```bash
bunx vitest run packages/core/src/adapters/adapters.test.ts
bunx vitest run packages/core/src/adaptive-agent.test.ts
bun run --cwd packages/core build
```

If additional tests are touched:

```bash
bunx vitest run packages/core/src
```

## 16. Compatibility Notes

- Existing string-only callers remain valid.
- Existing image-only callers remain valid.
- `video` remains unsupported and MUST still be rejected.
- `imageInput?: boolean` remains in the public contract for one migration step and SHOULD be removed only in a later versioned contract update.
