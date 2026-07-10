import type {
  AgentRun,
  ContextRef,
  ContextRefAuthorizationContext,
  ContextRefAuthorizer,
  ContextRefResolution,
  ContextRefResolutionSummary,
  JsonObject,
  JsonValue,
  ResolvedContextRef,
  ResolvedRunSummary,
  RunStatus,
  RunStore,
} from './types.js';

export const RESERVED_CONTEXT_KEY = '__adaptiveAgent';

const DEFAULT_REF_MAX_BYTES = 32 * 1024;
const DEFAULT_TOTAL_MAX_BYTES = 64 * 1024;
const DEFAULT_SESSION_MAX_RUNS = 25;
const PREVIEW_MAX_CHARS = 4_000;
const textEncoder = new TextEncoder();

export interface ResolveContextRefsOptions {
  runStore: RunStore;
  refs?: ContextRef[];
  requestContext?: Record<string, JsonValue>;
  requestSessionId?: string;
  requestMetadata?: Record<string, JsonValue>;
  authorizer?: ContextRefAuthorizer;
  defaultRefMaxBytes?: number;
  maxTotalBytes?: number;
}

export function assertNoReservedContextCollision(context: Record<string, JsonValue> | undefined): void {
  if (context && Object.prototype.hasOwnProperty.call(context, RESERVED_CONTEXT_KEY)) {
    throw new Error(`context.${RESERVED_CONTEXT_KEY} is reserved for Adaptive Agent runtime context`);
  }
}

export async function resolveContextRefs(options: ResolveContextRefsOptions): Promise<ContextRefResolution | undefined> {
  const refs = options.refs ?? [];
  if (refs.length === 0) {
    assertNoReservedContextCollision(options.requestContext);
    return undefined;
  }

  assertNoReservedContextCollision(options.requestContext);
  const resolved: ResolvedContextRef[] = [];
  const summaries: ContextRefResolutionSummary[] = [];
  const maxTotalBytes = normalizePositiveInteger(options.maxTotalBytes, DEFAULT_TOTAL_MAX_BYTES, 'maxTotalBytes');
  let totalBytes = 0;

  for (const ref of refs) {
    const result = await resolveOneRef(options, ref);
    resolved.push(result);
    summaries.push(summarizeResolvedContextRef(result));
    totalBytes += result.bytes;
    if (totalBytes > maxTotalBytes) {
      throw new Error(`contextRefs exceed request byte limit of ${maxTotalBytes} bytes`);
    }
  }

  return {
    refs: cloneJson(refs) as ContextRef[],
    resolved,
    summary: {
      refs: summaries,
      totalBytes,
    },
  };
}

export function injectResolvedContextRefs(
  context: Record<string, JsonValue> | undefined,
  resolution: ContextRefResolution | undefined,
): Record<string, JsonValue> | undefined {
  if (!resolution) {
    return context;
  }

  assertNoReservedContextCollision(context);
  return {
    ...(context ?? {}),
    [RESERVED_CONTEXT_KEY]: {
      resolvedContextRefs: resolution.resolved as unknown as JsonValue,
    },
  };
}

export function mergeContextRefMetadata(
  metadata: Record<string, JsonValue> | undefined,
  resolution: ContextRefResolution | undefined,
): Record<string, JsonValue> | undefined {
  if (!resolution) {
    return metadata;
  }

  return {
    ...(metadata ?? {}),
    contextRefs: {
      source: resolution.refs as unknown as JsonValue,
      resolution: resolution.summary as unknown as JsonValue,
    },
  };
}

export function contextRefsResolvedEventPayload(resolution: ContextRefResolution): JsonObject {
  return {
    refs: resolution.refs as unknown as JsonValue,
    resolved: resolution.summary.refs as unknown as JsonValue,
    totalBytes: resolution.summary.totalBytes,
  };
}

function summarizeResolvedContextRef(ref: ResolvedContextRef): ContextRefResolutionSummary {
  return removeUndefined({
    kind: ref.kind,
    id: ref.id,
    view: ref.view,
    status: ref.status,
    runCount: ref.runs?.length,
    bytes: ref.bytes,
    truncated: ref.truncated,
    warnings: ref.warnings && ref.warnings.length > 0 ? ref.warnings : undefined,
  }) as ContextRefResolutionSummary;
}

async function resolveOneRef(options: ResolveContextRefsOptions, ref: ContextRef): Promise<ResolvedContextRef> {
  validateContextRef(ref);
  switch (ref.kind) {
    case 'run':
      return resolveRunRef(options, ref);
    case 'session':
      return resolveSessionRef(options, ref);
    default:
      throw new Error(`Unsupported context ref kind ${(ref as { kind?: unknown }).kind}`);
  }
}

async function resolveRunRef(
  options: ResolveContextRefsOptions,
  ref: Extract<ContextRef, { kind: 'run' }>,
): Promise<ResolvedContextRef> {
  const view = ref.view ?? 'result';
  if (view !== 'result') {
    throw new Error(`Unsupported run context ref view ${view}`);
  }

  const run = await options.runStore.getRun(ref.id);
  if (!run) {
    throw new Error(`Context ref run ${ref.id} does not exist`);
  }
  await authorize(options.authorizer, { ref, targetRun: run, requestSessionId: options.requestSessionId, requestMetadata: options.requestMetadata });
  assertAllowedStatus(ref, run.status, `Context ref run ${ref.id}`);

  const warnings: string[] = [];
  let resolved: ResolvedContextRef = removeUndefined({
    ref: cloneJson(ref) as ContextRef,
    kind: 'run' as const,
    id: ref.id,
    view,
    status: run.status,
    goal: run.goal,
    result: run.result,
    errorCode: ref.allowStatuses?.includes('failed') ? run.errorCode : undefined,
    errorMessage: ref.allowStatuses?.includes('failed') ? run.errorMessage : undefined,
    warnings,
    truncated: false,
    bytes: 0,
  }) as ResolvedContextRef;

  resolved = fitResolvedRefToBytes(resolved, refMaxBytes(options, ref), (nextWarnings) => {
    resolved = removeUndefined({
      ...resolved,
      result: undefined,
      resultPreview: previewJson(run.result),
      warnings: nextWarnings,
      truncated: true,
    }) as ResolvedContextRef;
    return resolved;
  });
  return resolved;
}

async function resolveSessionRef(
  options: ResolveContextRefsOptions,
  ref: Extract<ContextRef, { kind: 'session' }>,
): Promise<ResolvedContextRef> {
  const view = ref.view ?? 'run_summaries';
  if (view !== 'run_summaries') {
    throw new Error(`Unsupported session context ref view ${view}`);
  }
  if (!options.runStore.listBySession) {
    throw new Error('Session context refs require a RunStore that supports listBySession');
  }

  await authorize(options.authorizer, { ref, requestSessionId: options.requestSessionId, requestMetadata: options.requestMetadata });
  const maxRuns = normalizePositiveInteger(ref.maxRuns, DEFAULT_SESSION_MAX_RUNS, 'contextRefs[].maxRuns');
  const rootRunsOnly = ref.rootRunsOnly !== false;
  const allRuns = await options.runStore.listBySession(ref.id);
  const orderedRuns = allRuns
    .filter((run) => !rootRunsOnly || (!run.parentRunId && run.delegationDepth === 0))
    .sort(compareRunChronology);

  const warnings: string[] = [];
  const allowedStatuses = ref.allowStatuses ?? ['succeeded'];
  const omittedByStatus = new Map<RunStatus, number>();
  const eligibleRuns = orderedRuns.filter((run) => {
    if (allowedStatuses.includes(run.status)) {
      return true;
    }
    omittedByStatus.set(run.status, (omittedByStatus.get(run.status) ?? 0) + 1);
    return false;
  });

  if (omittedByStatus.size > 0) {
    const omitted = [...omittedByStatus]
      .map(([status, count]) => `${count} ${status} ${count === 1 ? 'run' : 'runs'}`)
      .join(' and ');
    warnings.push(`omitted ${omitted}`);
  }
  if (orderedRuns.length > 0 && eligibleRuns.length === 0) {
    throw new Error(`Context ref session ${ref.id} has no runs matching allowed statuses [${allowedStatuses.join(', ')}]`);
  }
  if (eligibleRuns.length > maxRuns) {
    warnings.push(`session contained ${eligibleRuns.length} matching runs; included first ${maxRuns}`);
  }

  const runs = eligibleRuns.slice(0, maxRuns).map(runToSummary);

  let resolved: ResolvedContextRef = removeUndefined({
    ref: cloneJson(ref) as ContextRef,
    kind: 'session' as const,
    id: ref.id,
    view,
    runs,
    warnings,
    truncated: warnings.length > 0,
    bytes: 0,
  }) as ResolvedContextRef;

  resolved = fitResolvedRefToBytes(resolved, refMaxBytes(options, ref), (nextWarnings) => {
    resolved = removeUndefined({
      ...resolved,
      runs: runs.map((run) => run.result === undefined
        ? run
        : removeUndefined({
            ...run,
            result: undefined,
            resultPreview: previewJson(run.result),
          }) as ResolvedRunSummary),
      warnings: nextWarnings,
      truncated: true,
    }) as ResolvedContextRef;
    return resolved;
  });
  return resolved;
}

function runToSummary(run: AgentRun): ResolvedRunSummary {
  const orchestration = readOrchestrationMetadata(run);
  return removeUndefined({
    runId: run.id,
    sessionId: run.sessionId,
    role: orchestration?.role,
    goal: run.goal,
    status: run.status,
    result: run.result,
    errorCode: run.errorCode,
    errorMessage: run.errorMessage,
    usage: run.usage,
  }) as ResolvedRunSummary;
}

function validateContextRef(ref: ContextRef): void {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) {
    throw new Error('contextRefs entries must be objects');
  }
  if (ref.kind !== 'run' && ref.kind !== 'session') {
    throw new Error('contextRefs entries require kind "run" or "session"');
  }
  if (!ref.id || typeof ref.id !== 'string') {
    throw new Error(`contextRefs ${ref.kind} ref requires a non-empty string id`);
  }
  if (ref.maxBytes !== undefined) {
    normalizePositiveInteger(ref.maxBytes, DEFAULT_REF_MAX_BYTES, 'contextRefs[].maxBytes');
  }
  if (ref.allowStatuses !== undefined) {
    if (!Array.isArray(ref.allowStatuses) || ref.allowStatuses.some((status) => !isRunStatus(status))) {
      throw new Error('contextRefs[].allowStatuses must be an array of RunStatus values');
    }
  }
  if (ref.kind === 'session' && ref.maxRuns !== undefined) {
    normalizePositiveInteger(ref.maxRuns, DEFAULT_SESSION_MAX_RUNS, 'contextRefs[].maxRuns');
  }
}

function assertAllowedStatus(ref: ContextRef, status: RunStatus, label: string): void {
  const allowedStatuses = ref.allowStatuses ?? ['succeeded'];
  if (!allowedStatuses.includes(status)) {
    throw new Error(`${label} is ${status}; allowed statuses: ${allowedStatuses.join(', ')}`);
  }
}

async function authorize(authorizer: ContextRefAuthorizer | undefined, context: ContextRefAuthorizationContext): Promise<void> {
  if (!authorizer) {
    return;
  }
  const allowed = await authorizer(context);
  if (!allowed) {
    throw new Error(`Context ref ${context.ref.kind}:${context.ref.id} is not authorized`);
  }
}

function fitResolvedRefToBytes(
  ref: ResolvedContextRef,
  maxBytes: number,
  makePreview: (warnings: string[]) => ResolvedContextRef,
): ResolvedContextRef {
  let next = withByteLength(ref);
  if (next.bytes <= maxBytes) {
    return next;
  }

  const warnings = [...(next.warnings ?? []), `context ref exceeded ${maxBytes} bytes; result fields were converted to deterministic previews`];
  next = withByteLength(makePreview(warnings));
  if (next.bytes <= maxBytes) {
    return next;
  }

  const compact = removeUndefined({
    ref: next.ref,
    kind: next.kind,
    id: next.id,
    view: next.view,
    status: next.status,
    goal: next.goal,
    runs: next.runs?.map((run) => removeUndefined({
      runId: run.runId,
      sessionId: run.sessionId,
      role: run.role,
      goal: run.goal,
      status: run.status,
      resultPreview: run.resultPreview ? truncateText(run.resultPreview, 500) : undefined,
      errorCode: run.errorCode,
      errorMessage: run.errorMessage,
    }) as ResolvedRunSummary),
    resultPreview: next.resultPreview ? truncateText(next.resultPreview, 500) : undefined,
    warnings: [...warnings, 'context ref preview was compacted further to fit byte limit'],
    truncated: true,
    bytes: 0,
  }) as ResolvedContextRef;
  const compactWithBytes = withByteLength(compact);
  if (compactWithBytes.bytes > maxBytes) {
    throw new Error(`context ref ${ref.kind}:${ref.id} cannot fit within ${maxBytes} bytes after deterministic truncation`);
  }
  return compactWithBytes;
}

function withByteLength(ref: ResolvedContextRef): ResolvedContextRef {
  const withoutBytes = { ...ref, bytes: 0 };
  return { ...ref, bytes: byteLength(withoutBytes) };
}

function refMaxBytes(options: ResolveContextRefsOptions, ref: ContextRef): number {
  return normalizePositiveInteger(ref.maxBytes, options.defaultRefMaxBytes ?? DEFAULT_REF_MAX_BYTES, 'contextRefs[].maxBytes');
}

function normalizePositiveInteger(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function compareRunChronology(left: AgentRun, right: AgentRun): number {
  const byCreatedAt = left.createdAt.localeCompare(right.createdAt);
  return byCreatedAt === 0 ? left.id.localeCompare(right.id) : byCreatedAt;
}

function previewJson(value: JsonValue | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return truncateText(JSON.stringify(value), PREVIEW_MAX_CHARS);
}

function truncateText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}[truncated]`;
}

function byteLength(value: JsonValue | object): number {
  return textEncoder.encode(JSON.stringify(value)).byteLength;
}

function cloneJson(value: JsonValue | object): JsonValue | object {
  return JSON.parse(JSON.stringify(value));
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) {
      delete value[key];
    }
  }
  return value;
}

function readOrchestrationMetadata(run: AgentRun): { role?: string } | undefined {
  const raw = run.metadata?.orchestration;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const role = (raw as Record<string, JsonValue>).role;
  return typeof role === 'string' ? { role } : undefined;
}

function isRunStatus(value: unknown): value is RunStatus {
  return value === 'queued'
    || value === 'planning'
    || value === 'awaiting_approval'
    || value === 'awaiting_subagent'
    || value === 'running'
    || value === 'interrupted'
    || value === 'succeeded'
    || value === 'failed'
    || value === 'clarification_requested'
    || value === 'replan_required'
    || value === 'cancelled';
}
