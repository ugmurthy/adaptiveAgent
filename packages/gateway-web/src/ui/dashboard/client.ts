import type {
  DashboardError,
  DashboardDeleteRunResult,
  DashboardFilters,
  DashboardMessagesResponse,
  DashboardMessagesView,
  DashboardPlansResponse,
  DashboardReplayRunResult,
  DashboardRetryRunResult,
  DashboardRunListResult,
  DashboardTimelineResponse,
  TraceReport,
} from './types';

export interface DashboardClient {
  listRuns(filters: DashboardFilters): Promise<DashboardRunListResult>;
  getRun(rootRunId: string, options: { messagesView: DashboardMessagesView; focusRunId: string }): Promise<TraceReport>;
  getMessages(rootRunId: string, options: { messagesView: DashboardMessagesView; focusRunId: string }): Promise<DashboardMessagesResponse>;
  getTimeline(rootRunId: string, options: { focusRunId: string }): Promise<DashboardTimelineResponse>;
  getPlans(rootRunId: string, options: { focusRunId: string }): Promise<DashboardPlansResponse>;
  deleteRun(rootRunId: string): Promise<DashboardDeleteRunResult>;
  replayRun(rootRunId: string): Promise<DashboardReplayRunResult>;
  retryRun(runId: string): Promise<DashboardRetryRunResult>;
  resolveApproval(runId: string, approved: boolean): Promise<void>;
}

export function createDashboardClient(resolveToken: () => Promise<string>): DashboardClient {
  return {
    listRuns: async (filters) => normalizeListResult(await request(`/api/runs?${buildListSearch(filters)}`, resolveToken)),
    getRun: async (rootRunId, options) => normalizeTraceReport(await request(`/api/runs/${encodeURIComponent(rootRunId)}?${buildDetailSearch(options)}`, resolveToken)),
    getMessages: (rootRunId, options) => request(`/api/runs/${encodeURIComponent(rootRunId)}/messages?${buildDetailSearch(options)}`, resolveToken),
    getTimeline: (rootRunId, options) => request(`/api/runs/${encodeURIComponent(rootRunId)}/timeline?${buildDetailSearch(options)}`, resolveToken),
    getPlans: (rootRunId, options) => request(`/api/runs/${encodeURIComponent(rootRunId)}/plans?${buildDetailSearch(options)}`, resolveToken),
    deleteRun: (rootRunId) => request(`/api/runs/${encodeURIComponent(rootRunId)}`, resolveToken, { method: 'DELETE' }),
    replayRun: (rootRunId) => request(`/api/runs/${encodeURIComponent(rootRunId)}/replay`, resolveToken, { method: 'POST' }),
    retryRun: (runId) => request(`/api/runs/${encodeURIComponent(runId)}/retry`, resolveToken, { method: 'POST' }),
    resolveApproval: async (runId, approved) => {
      await request(`/api/runs/${encodeURIComponent(runId)}/approval`, resolveToken, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          approved,
          metadata: {
            source: 'dashboard',
          },
        }),
      });
    },
  };
}

export function isDashboardError(error: unknown): error is DashboardError {
  return typeof error === 'object' && error !== null && 'code' in error && 'message' in error && 'status' in error;
}

async function request<T>(path: string, resolveToken: () => Promise<string>, init: RequestInit = {}): Promise<T> {
  const token = await resolveToken();
  const response = await fetch(path, {
    ...init,
    headers: {
      ...init.headers,
      authorization: `Bearer ${token}`,
    },
  });
  const payload = await readJsonPayload(response, path);
  if (!response.ok) {
    const envelope = payload as { code?: unknown; message?: unknown; details?: unknown };
    throw {
      status: response.status,
      code: typeof envelope.code === 'string' ? envelope.code : `http_${response.status}`,
      message: typeof envelope.message === 'string' ? envelope.message : `Dashboard request failed with ${response.status}.`,
      details: envelope.details,
    } satisfies DashboardError;
  }

  return payload as T;
}

async function readJsonPayload(response: Response, path: string): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw {
      status: response.status,
      code: 'invalid_dashboard_response',
      message: `Expected JSON from ${path}, but received a non-JSON response. Check that the gateway dashboard API is mounted or proxied for this web app.`,
    } satisfies DashboardError;
  }
}

function normalizeListResult(payload: unknown): DashboardRunListResult {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    throw {
      status: 0,
      code: 'invalid_dashboard_response',
      message: 'GET /api/runs did not return the documented dashboard list shape.',
    } satisfies DashboardError;
  }

  return {
    items: payload.items as DashboardRunListResult['items'],
    limit: typeof payload.limit === 'number' ? payload.limit : 50,
    offset: typeof payload.offset === 'number' ? payload.offset : 0,
    nextOffset: typeof payload.nextOffset === 'number' ? payload.nextOffset : null,
  };
}

function normalizeTraceReport(payload: unknown): TraceReport {
  if (!isRecord(payload)) {
    throw {
      status: 0,
      code: 'invalid_dashboard_response',
      message: 'GET /api/runs/:rootRunId did not return the documented trace report shape.',
    } satisfies DashboardError;
  }

  return {
    target: isRecord(payload.target) ? payload.target as TraceReport['target'] : {},
    session: isRecord(payload.session) ? payload.session as TraceReport['session'] : null,
    rootRuns: Array.isArray(payload.rootRuns) ? payload.rootRuns as TraceReport['rootRuns'] : [],
    usage: isRecord(payload.usage) ? payload.usage as TraceReport['usage'] : {},
    timeline: Array.isArray(payload.timeline) ? payload.timeline as TraceReport['timeline'] : [],
    milestones: Array.isArray(payload.milestones) ? payload.milestones as TraceReport['milestones'] : undefined,
    llmMessages: Array.isArray(payload.llmMessages) ? payload.llmMessages as TraceReport['llmMessages'] : [],
    runTree: Array.isArray(payload.runTree) ? payload.runTree as TraceReport['runTree'] : undefined,
    snapshotSummaries: Array.isArray(payload.snapshotSummaries) ? payload.snapshotSummaries as TraceReport['snapshotSummaries'] : undefined,
    totalSteps: typeof payload.totalSteps === 'number' || payload.totalSteps === null ? payload.totalSteps : null,
    delegates: Array.isArray(payload.delegates) ? payload.delegates as TraceReport['delegates'] : [],
    plans: Array.isArray(payload.plans) ? payload.plans as TraceReport['plans'] : [],
    summary: isRecord(payload.summary) ? payload.summary as TraceReport['summary'] : { status: 'unknown', reason: 'Trace report did not include a summary.' },
    warnings: Array.isArray(payload.warnings) ? payload.warnings.filter((warning): warning is string => typeof warning === 'string') : [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function buildListSearch(filters: DashboardFilters): string {
  const params = new URLSearchParams();
  setParam(params, 'from', filters.from);
  setParam(params, 'to', filters.to);
  setParam(params, 'status', filters.status);
  setParam(params, 'session', filters.session === 'any' ? '' : filters.session);
  setParam(params, 'requiresApproval', filters.requiresApproval);
  setParam(params, 'q', filters.q);
  setParam(params, 'sort', filters.sort);
  params.set('limit', filters.limit.toString());
  params.set('offset', filters.offset.toString());
  return params.toString();
}

function buildDetailSearch(options: { messagesView?: DashboardMessagesView; focusRunId?: string }): string {
  const params = new URLSearchParams();
  params.set('includePlans', 'true');
  params.set('messages', 'true');
  setParam(params, 'messagesView', options.messagesView);
  setParam(params, 'focusRunId', options.focusRunId);
  return params.toString();
}

function setParam(params: URLSearchParams, key: string, value: string | undefined): void {
  if (value) {
    params.set(key, value);
  }
}
