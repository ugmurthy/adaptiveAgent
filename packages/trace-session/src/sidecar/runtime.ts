import { buildTraceComparison } from '../trace-session/report.js';
import type { ListFilterOptions } from '../trace-session/data.js';
import type { CliOptions, TraceReport } from '../trace-session/types.js';
import type { TraceService } from '../trace-session/reader.js';
import {
  JSON_RPC_ERROR_CODES,
  TRACE_SIDECAR_DEFAULT_LIMIT,
  TRACE_SIDECAR_MAX_LIMIT,
  TRACE_SIDECAR_MAX_REQUEST_BYTES,
  TRACE_SIDECAR_MAX_RESPONSE_BYTES,
  TRACE_SIDECAR_PROTOCOL_VERSION,
  TRACE_SIDECAR_QUERY_TIMEOUT_MS,
  TRACE_SIDECAR_VERSION,
  TraceSidecarProtocolError,
  type TraceGetParams,
  type TraceListFilters,
  type TraceSidecarRpcRequest,
  type TraceTarget,
} from './protocol.js';

export interface TraceSidecarPolicy {
  allowMessages: boolean;
  allowReasoning: boolean;
  allowRawToolPayloads: boolean;
}

export class TraceSidecarRuntime {
  private initialized = false;

  constructor(
    private readonly service: TraceService,
    private readonly backendKind: 'sqlite' | 'postgres',
    private readonly policy: TraceSidecarPolicy,
  ) {}

  async handle(request: TraceSidecarRpcRequest): Promise<unknown> {
    if (request.method === 'initialize') return this.initialize(request.params!);
    if (!this.initialized) {
      throw new TraceSidecarProtocolError(
        'NOT_INITIALIZED',
        'Call initialize with a supported protocolVersion before other JSON-RPC methods.',
        JSON_RPC_ERROR_CODES.notInitialized,
      );
    }

    switch (request.method) {
      case 'runtime/info':
        return this.info();
      case 'trace/get':
        return this.getTrace(request.params!);
      case 'trace/listSessions':
        return this.service.listSessions(listFilters(request.params ?? {}));
      case 'trace/listSessionlessRuns':
        return this.service.listSessionless(request.params?.limit ?? TRACE_SIDECAR_DEFAULT_LIMIT);
      case 'trace/usage':
        return this.service.usage(traceOptions(request.params!.target));
      case 'trace/compare': {
        const { baselineRunId, candidateRunId } = request.params!;
        const [baseline, candidate] = await Promise.all([
          this.service.trace(traceOptions({ kind: 'run', runId: baselineRunId }, baselineRunId)),
          this.service.trace(traceOptions({ kind: 'run', runId: candidateRunId }, candidateRunId)),
        ]);
        return buildTraceComparison(baseline, candidate, baselineRunId, candidateRunId);
      }
      case 'trace/aggregate': {
        const { groupBy, ...filters } = request.params!;
        const report = await this.service.aggregate({ ...listFilters(filters), groupBy });
        return { ...report, notes: [] };
      }
      case 'shutdown':
        return { shutdown: true };
    }
  }

  info(): Record<string, unknown> {
    return {
      serverInfo: { name: 'adaptive-agent-trace-session', version: TRACE_SIDECAR_VERSION },
      protocolVersion: TRACE_SIDECAR_PROTOCOL_VERSION,
      backend: { kind: this.backendKind, readOnly: true },
      capabilities: this.capabilities(),
      limits: {
        maxConcurrentRequests: 1,
        defaultListItems: TRACE_SIDECAR_DEFAULT_LIMIT,
        maxListItems: TRACE_SIDECAR_MAX_LIMIT,
        maxRequestBytes: TRACE_SIDECAR_MAX_REQUEST_BYTES,
        maxResponseBytes: TRACE_SIDECAR_MAX_RESPONSE_BYTES,
        queryTimeoutMs: this.backendKind === 'postgres' ? TRACE_SIDECAR_QUERY_TIMEOUT_MS : null,
      },
    };
  }

  private initialize(params: { protocolVersion: string; clientInfo: { name: string; version?: string } }): Record<string, unknown> {
    if (this.initialized) {
      throw new TraceSidecarProtocolError('ALREADY_INITIALIZED', 'The sidecar is already initialized.', JSON_RPC_ERROR_CODES.alreadyInitialized);
    }
    if (params.protocolVersion !== TRACE_SIDECAR_PROTOCOL_VERSION) {
      throw new TraceSidecarProtocolError(
        'UNSUPPORTED_PROTOCOL_VERSION',
        `Unsupported protocol version. This sidecar supports ${TRACE_SIDECAR_PROTOCOL_VERSION}.`,
        JSON_RPC_ERROR_CODES.unsupportedProtocol,
        { supportedVersions: [TRACE_SIDECAR_PROTOCOL_VERSION] },
      );
    }
    this.initialized = true;
    return this.info();
  }

  private async getTrace(params: TraceGetParams): Promise<TraceReport> {
    const includeMessages = Boolean(params.include?.messages || params.include?.reasoning);
    requireCapability(includeMessages, this.policy.allowMessages || this.policy.allowReasoning, 'messages');
    requireCapability(Boolean(params.include?.reasoning), this.policy.allowReasoning, 'reasoning');
    requireCapability(Boolean(params.include?.rawToolPayloads), this.policy.allowRawToolPayloads, 'rawToolPayloads');

    const report = await this.service.trace(traceOptions(params.target, params.focusRunId, {
      includePlans: Boolean(params.include?.plans),
      messages: includeMessages,
      reasoning: Boolean(params.include?.reasoning),
    }));
    return projectTraceReport(report, {
      plans: Boolean(params.include?.plans),
      messages: includeMessages,
      reasoning: Boolean(params.include?.reasoning),
      rawToolPayloads: Boolean(params.include?.rawToolPayloads),
    });
  }

  private capabilities(): Record<string, boolean> {
    return {
      compare: true,
      aggregate: true,
      messages: this.policy.allowMessages || this.policy.allowReasoning,
      reasoning: this.policy.allowReasoning,
      rawToolPayloads: this.policy.allowRawToolPayloads,
    };
  }
}

function traceOptions(
  target: TraceTarget,
  focusRunId?: string,
  include: { includePlans?: boolean; messages?: boolean; reasoning?: boolean } = {},
): CliOptions {
  return {
    json: false,
    listSessions: false,
    listPerformance: false,
    listSessionless: false,
    deleteEmptyGoalSessions: false,
    usageOnly: false,
    includePlans: include.includePlans ?? false,
    onlyDelegates: false,
    messages: include.messages ?? false,
    reasoning: include.reasoning ?? false,
    systemOnly: false,
    help: false,
    ...(focusRunId ? { focusRunId } : {}),
    ...(target.kind === 'session' ? { sessionId: target.sessionId, ...(target.rootRunId ? { rootRunId: target.rootRunId } : {}) } : {}),
    ...(target.kind === 'root-run' ? { rootRunId: target.rootRunId } : {}),
    ...(target.kind === 'run' ? { runId: target.runId } : {}),
  };
}

function listFilters(params: TraceListFilters): ListFilterOptions {
  return {
    ...(params.goals ? { goals: params.goals } : {}),
    ...(params.hasGoal !== undefined ? { hasGoal: params.hasGoal } : {}),
    ...(params.noGoal !== undefined ? { noGoal: params.noGoal } : {}),
    ...(params.statuses ? { statuses: params.statuses } : {}),
    limit: params.limit ?? TRACE_SIDECAR_DEFAULT_LIMIT,
    ...(params.types ? { types: params.types } : {}),
    ...(params.swarmRole ? { swarmRole: params.swarmRole } : {}),
    ...(params.since ? { since: params.since } : {}),
    ...(params.until ? { until: params.until } : {}),
  };
}

function requireCapability(requested: boolean, allowed: boolean, capability: string): void {
  if (requested && !allowed) {
    throw new TraceSidecarProtocolError(
      'SENSITIVE_DATA_NOT_ALLOWED',
      `${capability} access is not enabled for this sidecar.`,
      JSON_RPC_ERROR_CODES.sensitiveDataNotAllowed,
      { capability },
    );
  }
}

function projectTraceReport(
  report: TraceReport,
  include: { plans: boolean; messages: boolean; reasoning: boolean; rawToolPayloads: boolean },
): TraceReport {
  return {
    ...report,
    rootRuns: report.rootRuns.map(({ result: _result, errorMessage: _errorMessage, ...run }) => ({
      ...run,
      result: undefined,
      errorMessage: undefined,
    })),
    timeline: report.timeline.map(({ params, output, accounting: _accounting, ...entry }) => ({
      ...entry,
      params: include.rawToolPayloads ? params : undefined,
      output: include.rawToolPayloads ? output : undefined,
      outcome: safeOutcome(entry.outcome),
    })),
    llmMessages: include.messages ? report.llmMessages.map((trace) => ({
      ...trace,
      initialMessages: trace.initialMessages?.map((message) => projectMessage(message, include.reasoning)),
      effectiveMessages: trace.effectiveMessages.map((message) => projectMessage(message, include.reasoning)),
    })) : [],
    milestones: report.milestones?.map((milestone) => ({ ...milestone, text: milestone.eventType })),
    runTree: report.runTree?.map(({ result: _result, ...run }) => ({ ...run, result: undefined })),
    delegates: report.delegates.map(({
      child_error_message: _childErrorMessage,
      child_result: _childResult,
      parent_last_event_payload: _parentPayload,
      child_last_event_payload: _childPayload,
      ...delegate
    }) => ({
      ...delegate,
      child_error_message: null,
      child_result: undefined,
      parent_last_event_payload: undefined,
      child_last_event_payload: undefined,
    })),
    plans: include.plans ? report.plans : [],
    summary: { status: report.summary.status, reason: `Trace status is ${report.summary.status}.` },
    warnings: [],
    diagnostics: undefined,
  };
}

function projectMessage<T extends { reasoning?: string; reasoningDetails?: unknown[] }>(message: T, includeReasoning: boolean): T {
  return {
    ...message,
    reasoning: includeReasoning ? message.reasoning : undefined,
    reasoningDetails: includeReasoning ? message.reasoningDetails : undefined,
  };
}

function safeOutcome(outcome: string): string {
  if (outcome.startsWith('failed')) return 'failed';
  if (outcome.startsWith('completed')) return 'completed';
  if (outcome.startsWith('running')) return 'running';
  return outcome.includes(':') ? outcome.slice(0, outcome.indexOf(':')) : outcome;
}
