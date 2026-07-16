import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

import {
  createTracePostgresPool,
  listSessionPerformance,
  resolveTracePostgresConfig,
  traceSession,
  type CliOptions,
  type SessionListItem,
  type TracePostgresPool,
} from '@adaptive-agent/trace-session';
import { buildTraceMarkdown } from './trace-format.js';

const port = Number(Bun.env.TRACE_WORKBENCH_PORT ?? Bun.env.PORT ?? 4767);
const host = Bun.env.TRACE_WORKBENCH_HOST ?? '0.0.0.0';
const clientDir = existsSync(join(import.meta.dir, '../client'))
  ? join(import.meta.dir, '../client')
  : join(import.meta.dir, '../dist/client');

let poolPromise: Promise<TracePostgresPool> | null = null;

function getPool(): Promise<TracePostgresPool> {
  poolPromise ??= resolveTracePostgresConfig({
    databaseUrl: Bun.env.TRACE_WORKBENCH_DATABASE_URL ?? Bun.env.DATABASE_URL,
    databaseUrlEnv: Bun.env.TRACE_WORKBENCH_DATABASE_URL_ENV ?? 'DATABASE_URL',
    ssl: readBoolean(Bun.env.PGSSL),
  }).then((config) => createTracePostgresPool(config));
  return poolPromise;
}

const server = Bun.serve({
  hostname: host,
  port,
  async fetch(request) {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/api/')) {
        return await handleApi(url);
      }
      return await serveClient(url.pathname);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json({ error: { code: 'trace_workbench_error', message } }, 500);
    }
  },
});

console.log(`Trace Workbench listening on http://${server.hostname}:${server.port}`);

async function handleApi(url: URL): Promise<Response> {
  if (url.pathname === '/api/health') {
    return json({ ok: true });
  }

  const pool = await getPool();

  if (url.pathname === '/api/sessions') {
    const limit = readPositiveInteger(url.searchParams.get('limit')) ?? 100;
    const sessions = await listWorkbenchSessions(pool, limit);
    const performance = url.searchParams.get('includePerformance') === 'true'
      ? await listSessionPerformance(pool).catch(() => [])
      : [];
    return json({ sessions, performance });
  }

  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionMatch) {
    const sessionId = decodeURIComponent(sessionMatch[1]!);
    const report = await traceSession(pool, traceOptions({ sessionId }));
    return json({ report });
  }

  const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (runMatch) {
    const rootRunId = decodeURIComponent(runMatch[1]!);
    const report = await traceSession(pool, traceOptions({ rootRunId }));
    return json({ report });
  }

  const markdownMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/markdown$/);
  if (markdownMatch) {
    const rootRunId = decodeURIComponent(markdownMatch[1]!);
    const report = await traceSession(pool, traceOptions({ rootRunId }));
    return new Response(buildTraceMarkdown(report), {
      headers: {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename="adaptive-agent-trace-${safeFilename(rootRunId)}.md"`,
      },
    });
  }

  return json({ error: { code: 'not_found', message: `No route for ${url.pathname}` } }, 404);
}

async function serveClient(pathname: string): Promise<Response> {
  if (!existsSync(clientDir)) {
    return new Response('Trace Workbench client is not built. Run `bun run build` or use `bun run dev`.', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  const relativePath = pathname === '/' ? 'index.html' : normalize(pathname).replace(/^\/+/, '');
  const filePath = join(clientDir, relativePath);
  if (!filePath.startsWith(clientDir) || !existsSync(filePath)) {
    return new Response(Bun.file(join(clientDir, 'index.html')), { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  return new Response(Bun.file(filePath), { headers: { 'content-type': contentType(filePath) } });
}

function traceOptions(overrides: { rootRunId: string } | { sessionId: string }): CliOptions {
  return {
    ...overrides,
    json: false,
    listSessions: false,
    listPerformance: false,
    listSessionless: false,
    deleteEmptyGoalSessions: false,
    usageOnly: false,
    includePlans: true,
    onlyDelegates: false,
    messages: true,
    reasoning: true,
    systemOnly: false,
    help: false,
    previewChars: 900,
  };
}

async function listWorkbenchSessions(client: TracePostgresPool, limit: number): Promise<SessionListItem[]> {
  const result = await client.query<{
    session_id: string | null;
    root_run_id: string;
    run_id: string;
    status: string | null;
    started_at: string | null;
    completed_at: string | null;
    goal: unknown;
    linked_at: string;
  }>(`
    select
      r.session_id,
      r.root_run_id::text as root_run_id,
      r.id::text as run_id,
      r.status,
      r.created_at as started_at,
      r.completed_at,
      r.goal,
      coalesce(r.updated_at, r.created_at) as linked_at
    from agent_runs r
    where r.id = r.root_run_id
    order by coalesce(r.updated_at, r.created_at) desc, r.id desc
    limit $1
  `, [limit]);

  const groups = new Map<string, SessionListItem>();
  for (const row of result.rows) {
    const startedAt = row.started_at ?? row.linked_at;
    const key = row.session_id ?? `sessionless:${row.root_run_id}`;
    const existing = groups.get(key);
    const goal = typeof row.goal === 'string'
      ? row.goal
      : row.goal === null || row.goal === undefined
        ? null
        : JSON.stringify(row.goal);
    const goalRow = {
      rootRunId: row.root_run_id,
      runId: row.run_id,
      status: row.status,
      startedAt,
      completedAt: row.completed_at,
      goal,
      linkedAt: row.linked_at,
    };

    if (!existing) {
      groups.set(key, {
        sessionId: row.session_id,
        startedAt,
        status: row.status ?? 'unknown',
        goals: [goalRow],
      });
      continue;
    }

    existing.goals.push(goalRow);
    existing.startedAt = Date.parse(startedAt) < Date.parse(existing.startedAt) ? startedAt : existing.startedAt;
    existing.status = summarizeSessionStatus(existing.goals.map((goal) => goal.status));
  }

  return [...groups.values()].sort((left, right) =>
    latestGoalTime(right) - latestGoalTime(left)
    || (right.sessionId ?? right.goals[0]?.rootRunId ?? '').localeCompare(left.sessionId ?? left.goals[0]?.rootRunId ?? ''),
  );
}

function summarizeSessionStatus(statuses: Array<string | null>): string {
  if (statuses.some((status) => status === 'running' || status === 'blocked')) return 'running';
  if (statuses.some((status) => status === 'failed')) return 'failed';
  if (statuses.length > 0 && statuses.every((status) => status === 'succeeded')) return 'succeeded';
  return statuses.find((status): status is string => typeof status === 'string') ?? 'unknown';
}

function latestGoalTime(session: SessionListItem): number {
  return Math.max(...session.goals.map((goal) => Date.parse(goal.linkedAt || goal.startedAt || session.startedAt)).filter(Number.isFinite), Date.parse(session.startedAt));
}

function readPositiveInteger(value: string | null): number | null {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return Math.min(parsed, 500);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function contentType(filePath: string): string {
  switch (extname(filePath)) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.json': return 'application/json; charset=utf-8';
    default: return 'application/octet-stream';
  }
}

function safeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 96);
}

function readBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  return value === true || value === 'true' || value === '1' || value === 'yes';
}
