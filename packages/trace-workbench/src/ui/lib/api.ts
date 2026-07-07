import type { SessionListItem, SessionPerformanceListItem, TraceReport } from '@adaptive-agent/trace-session';

export interface SessionListResponse {
  sessions: SessionListItem[];
  performance: SessionPerformanceListItem[];
}

export async function fetchSessions(): Promise<SessionListResponse> {
  return fetchJson<SessionListResponse>('/api/sessions?limit=150', { timeoutMs: 12_000 });
}

export async function fetchRun(rootRunId: string): Promise<TraceReport> {
  const response = await fetchJson<{ report: TraceReport }>(`/api/runs/${encodeURIComponent(rootRunId)}`);
  return response.report;
}

export async function fetchSessionReport(sessionId: string): Promise<TraceReport> {
  const response = await fetchJson<{ report: TraceReport }>(`/api/sessions/${encodeURIComponent(sessionId)}`);
  return response.report;
}

async function fetchJson<T>(path: string, options: { timeoutMs?: number } = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = options.timeoutMs === undefined
    ? undefined
    : setTimeout(() => controller.abort(), options.timeoutMs);
  let response: Response;
  try {
    response = await fetch(path, { signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`Request timed out while loading ${path}.`);
    }
    throw error;
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json() as { error?: { message?: string } };
      message = body.error?.message ?? message;
    } catch {
      // Preserve HTTP status fallback.
    }
    throw new Error(message);
  }
  return await response.json() as T;
}
