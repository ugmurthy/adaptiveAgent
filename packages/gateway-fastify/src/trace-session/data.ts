import { inspect } from 'node:util';

import type { PostgresClient } from '../stores-postgres.js';

import {
  buildMilestones,
  buildRunTreeEntries,
  buildTimeline,
  collectFocusedRunIds,
  filterReportForFocusedRun,
  isHistoricalTrace,
  summarizeTrace,
  totalStepsFromSnapshotSummaries,
} from './report.js';
import type {
  CliOptions,
  DelegateRow,
  PlanRow,
  RootRun,
  RunMessageTrace,
  RunSnapshotSummary,
  SessionListItem,
  SessionOverview,
  SessionUsageSummary,
  SessionlessRunListItem,
  SnapshotMessageRow,
  TraceMessage,
  TraceMessageRole,
  TraceReport,
  TraceTarget,
  TraceToolCall,
  UsageSummary,
} from './types.js';

export async function traceSession(client: PostgresClient, options: CliOptions): Promise<TraceReport> {
  const [resolvedTarget, migration] = await Promise.all([
    resolveTraceTarget(client, options),
    detectTraceSupport(client),
  ]);
  const { target, session, rootRunIds } = resolvedTarget;
  const [rootRuns, usage] = await Promise.all([
    loadRootRuns(client, rootRunIds, options.sessionId, migration.hasRunModelColumns),
    loadSessionUsage(client, rootRunIds),
  ]);

  const warnings: string[] = [];
  if (target.kind === 'session' && !session) {
    warnings.push(`Session "${options.sessionId}" was not found.`);
  }
  if (target.kind === 'run' && !target.resolvedRootRunId) {
    warnings.push(`Run "${target.requestedId}" was not found.`);
  }
  if ((target.kind === 'root-run' || (target.kind === 'run' && target.resolvedRootRunId)) && rootRuns.length === 0) {
    warnings.push(`Root run "${target.resolvedRootRunId ?? target.requestedId}" was not found.`);
  }
  if (!migration.hasToolObservabilityColumns) {
    warnings.push('The core:002_tool_observability columns are missing. Precise tracing is not possible for this database until the migration is applied.');
  }

  const shouldLoadMessages = options.messages || options.systemOnly || options.view === 'messages';
  const llmMessagesPromise = shouldLoadMessages
    ? loadRunMessageTraces(client, rootRunIds).catch((error: unknown) => {
        warnings.push(`LLM messages are unavailable: ${errorMessage(error)}`);
        return [] as RunMessageTrace[];
      })
    : Promise.resolve([] as RunMessageTrace[]);
  const snapshotSummariesPromise = loadRunSnapshotSummaries(client, rootRunIds).catch((error: unknown) => {
    warnings.push(`Step counts are unavailable: ${errorMessage(error)}`);
    return [] as RunSnapshotSummary[];
  });

  const [traceRows, llmMessages, snapshotSummaries, delegates, plans] = await Promise.all([
    migration.hasToolObservabilityColumns ? loadTraceRows(client, options.sessionId ?? target.requestedId, rootRunIds) : Promise.resolve([]),
    llmMessagesPromise,
    snapshotSummariesPromise,
    loadDelegateDiagnostics(client, rootRunIds).catch((error: unknown) => {
      warnings.push(`Delegate diagnostics are unavailable: ${errorMessage(error)}`);
      return [] as DelegateRow[];
    }),
    options.includePlans
      ? loadPlans(client, rootRunIds).catch((error: unknown) => {
          warnings.push(`Plan details are unavailable: ${errorMessage(error)}`);
          return [] as PlanRow[];
        })
      : Promise.resolve([]),
  ]);

  const timeline = buildTimeline(traceRows, { onlyDelegates: options.onlyDelegates });
  if (traceRows.length > 0 && isHistoricalTrace(traceRows)) {
    warnings.push(
      'This looks like pre-observability historical data. Precise call tracing by tool_call_id, ledger input, and child_run_id is not possible; shown rows are reconstructed from event payloads where available.',
    );
  }

  let report: TraceReport = {
    target,
    session,
    rootRuns,
    usage,
    timeline,
    milestones: buildMilestones(traceRows),
    llmMessages,
    runTree: buildRunTreeEntries(traceRows),
    snapshotSummaries,
    totalSteps: totalStepsFromSnapshotSummaries(snapshotSummaries),
    delegates,
    plans,
    summary: summarizeTrace(session, rootRuns, timeline, delegates),
    warnings,
  };

  if (options.focusRunId) {
    const focusedRunIds = collectFocusedRunIds(report.runTree ?? [], options.focusRunId);
    if (focusedRunIds.size === 0) {
      warnings.push(`Run "${options.focusRunId}" was not found in the traced run tree.`);
    } else {
      report = filterReportForFocusedRun(report, focusedRunIds);
      report.summary = summarizeTrace(report.session, report.rootRuns, report.timeline, report.delegates);
      report.totalSteps = totalStepsFromSnapshotSummaries(report.snapshotSummaries ?? []);
    }
  }

  return report;
}

export async function loadUsageForTraceTarget(client: PostgresClient, options: CliOptions): Promise<SessionUsageSummary> {
  const { rootRunIds } = await resolveTraceTarget(client, options);
  return loadSessionUsage(client, rootRunIds);
}


export async function listSessions(client: PostgresClient): Promise<SessionListItem[]> {
  const result = await client.query<{
    session_id: string;
    started_at: string;
    status: string;
    goals: unknown;
  }>(`
    select
      s.id as session_id,
      s.created_at as started_at,
      coalesce(
        case
          when count(l.run_id) filter (where l.run_id is not null) = 0 then s.status
          when count(*) filter (where r.status is distinct from 'succeeded') = 0 then 'succeeded'
          else 'failed'
        end,
        s.status
      ) as status,
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'rootRunId', l.root_run_id,
            'goal', r.goal,
            'linkedAt', l.created_at
          )
          order by l.created_at asc, l.run_id asc
        ) filter (where l.run_id is not null),
        '[]'::jsonb
      ) as goals
    from gateway_sessions s
    left join gateway_session_run_links l
      on l.session_id = s.id
      and l.invocation_kind = 'run'
    left join agent_runs r on r.id::text = l.root_run_id
    group by s.id, s.created_at
    order by s.created_at desc, s.id desc
  `);

  return result.rows.map((row) => ({
    sessionId: row.session_id,
    startedAt: row.started_at,
    status: row.status,
    goals: parseSessionGoals(row.goals),
  }));
}

export async function listSessionlessRuns(client: PostgresClient): Promise<SessionlessRunListItem[]> {
  const result = await client.query<{
    root_run_id: string;
    started_at: string;
    status: string | null;
    goal: string | null;
  }>(`
    select
      r.id::text as root_run_id,
      r.created_at as started_at,
      r.status,
      r.goal
    from agent_runs r
    left join gateway_session_run_links l
      on l.root_run_id = r.id::text
     and l.invocation_kind = 'run'
    where r.id = r.root_run_id
      and l.root_run_id is null
    order by r.created_at desc, r.id desc
  `);

  return result.rows.map((row) => ({
    rootRunId: row.root_run_id,
    startedAt: row.started_at,
    status: row.status,
    goal: row.goal,
  }));
}

function parseSessionGoals(value: unknown): SessionListItem['goals'] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') {
      return [];
    }
    const record = item as Record<string, unknown>;
    if (typeof record.rootRunId !== 'string' || (record.goal !== null && typeof record.goal !== 'string') || typeof record.linkedAt !== 'string') {
      return [];
    }
    return [{
      rootRunId: record.rootRunId,
      goal: record.goal,
      linkedAt: record.linkedAt,
    }];
  });
}

function usageSummaryFromRow(row: {
  total_prompt_tokens: string | number;
  total_completion_tokens: string | number;
  total_reasoning_tokens: string | number | null;
  estimated_cost_usd: string | number;
}): UsageSummary {
  const promptTokens = Number(row.total_prompt_tokens ?? 0);
  const completionTokens = Number(row.total_completion_tokens ?? 0);
  const reasoningTokens = Number(row.total_reasoning_tokens ?? 0);
  return {
    promptTokens,
    completionTokens,
    reasoningTokens: reasoningTokens > 0 ? reasoningTokens : undefined,
    totalTokens: promptTokens + completionTokens + reasoningTokens,
    estimatedCostUSD: Number(row.estimated_cost_usd ?? 0),
  };
}


async function detectTraceSupport(client: PostgresClient): Promise<{ hasTraceView: boolean; hasToolObservabilityColumns: boolean; hasRunModelColumns: boolean }> {
  const [viewResult, columnResult, runModelColumnResult] = await Promise.all([
    client.query<{ exists: boolean }>(`select to_regclass('public.session_execution_trace') is not null as exists`),
    client.query<{ count: string }>(`
      select count(*)::text as count
      from information_schema.columns
      where table_schema = 'public'
        and (
          (table_name = 'agent_events' and column_name = 'tool_call_id')
          or (table_name = 'tool_executions' and column_name in ('input', 'child_run_id'))
        )
    `),
    client.query<{ count: string }>(`
      select count(*)::text as count
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'agent_runs'
        and column_name in ('model_provider', 'model_name')
    `),
  ]);
  return {
    hasTraceView: viewResult.rows[0]?.exists === true,
    hasToolObservabilityColumns: Number(columnResult.rows[0]?.count ?? 0) >= 3,
    hasRunModelColumns: Number(runModelColumnResult.rows[0]?.count ?? 0) >= 2,
  };
}

async function loadSessionOverview(client: PostgresClient, sessionId: string): Promise<SessionOverview | null> {
  const result = await client.query<{
    id: string;
    channel_id: string | null;
    agent_id: string | null;
    invocation_mode: string | null;
    status: string;
    current_run_id: string | null;
    current_root_run_id: string | null;
    last_completed_root_run_id: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `
      select id, channel_id, agent_id, invocation_mode, status, current_run_id,
             current_root_run_id, last_completed_root_run_id, created_at, updated_at
      from gateway_sessions
      where id = $1
    `,
    [sessionId],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    sessionId: row.id,
    channelId: row.channel_id,
    agentId: row.agent_id,
    invocationMode: row.invocation_mode,
    status: row.status,
    currentRunId: row.current_run_id,
    currentRootRunId: row.current_root_run_id,
    lastCompletedRootRunId: row.last_completed_root_run_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function loadTraceSessionRootRunIds(
  client: PostgresClient,
  sessionId: string,
  session: SessionOverview | null,
  rootRunId?: string,
): Promise<string[]> {
  if (rootRunId) {
    return [rootRunId];
  }

  const result = await client.query<{
    root_run_id: string;
  }>(
    `
      select l.root_run_id
      from gateway_session_run_links l
      where l.session_id = $1
        and l.invocation_kind = 'run'
      group by l.root_run_id
      order by min(l.created_at) asc, min(l.run_id) asc
    `,
    [sessionId],
  );

  const ordered = result.rows.map((row) => row.root_run_id);
  const runtimeRoots = await client.query<{
    root_run_id: string;
  }>(
    `
      select r.id::text as root_run_id
      from agent_runs r
      where r.id = r.root_run_id
        and (
          r.context ->> 'sessionId' = $1
          or r.metadata -> 'gateway' ->> 'sessionId' = $1
        )
      order by r.created_at asc, r.id asc
    `,
    [sessionId],
  );
  for (const row of runtimeRoots.rows) {
    if (!ordered.includes(row.root_run_id)) {
      ordered.push(row.root_run_id);
    }
  }
  for (const candidate of [session?.currentRootRunId, session?.lastCompletedRootRunId]) {
    if (candidate && !ordered.includes(candidate)) {
      ordered.push(candidate);
    }
  }
  return ordered;
}

async function resolveTraceTarget(
  client: PostgresClient,
  options: CliOptions,
): Promise<{ target: TraceTarget; session: SessionOverview | null; rootRunIds: string[] }> {
  if (options.sessionId) {
    const session = await loadSessionOverview(client, options.sessionId);
    const rootRunIds = await loadTraceSessionRootRunIds(client, options.sessionId, session, options.rootRunId);
    return {
      target: {
        kind: 'session',
        requestedId: options.sessionId,
        resolvedRootRunId: options.rootRunId,
      },
      session,
      rootRunIds,
    };
  }

  if (options.runId) {
    const rootRunId = await loadRootRunIdForRun(client, options.runId);
    return {
      target: {
        kind: 'run',
        requestedId: options.runId,
        resolvedRootRunId: rootRunId ?? undefined,
      },
      session: null,
      rootRunIds: rootRunId ? [rootRunId] : [],
    };
  }

  return {
    target: {
      kind: 'root-run',
      requestedId: options.rootRunId!,
      resolvedRootRunId: options.rootRunId!,
    },
    session: null,
    rootRunIds: options.rootRunId ? [options.rootRunId] : [],
  };
}

async function loadRootRunIdForRun(client: PostgresClient, runId: string): Promise<string | null> {
  const result = await client.query<{ root_run_id: string }>(
    `
      select root_run_id::text as root_run_id
      from agent_runs
      where id = $1
    `,
    [runId],
  );
  return result.rows[0]?.root_run_id ?? null;
}

async function loadRootRuns(client: PostgresClient, rootRunIds: string[], sessionId?: string, hasRunModelColumns = true): Promise<RootRun[]> {
  if (rootRunIds.length === 0) {
    return [];
  }

  const modelColumns = hasRunModelColumns
    ? 'r.model_provider, r.model_name'
    : 'null::text as model_provider, null::text as model_name';
  const result = await client.query<{
    root_run_id: string;
    run_id: string;
    invocation_kind: string;
    turn_index: number | null;
    linked_at: string;
    status: string | null;
    goal: string | null;
    result: unknown;
    model_provider: string | null;
    model_name: string | null;
  }>(
    `
      with requested_roots as (
        select root_run_id::uuid as root_run_id, ordinality
        from unnest($2::text[]) with ordinality as roots(root_run_id, ordinality)
      )
      select
        rr.root_run_id::text as root_run_id,
        coalesce(link.run_id, rr.root_run_id::text) as run_id,
        coalesce(link.invocation_kind, 'run') as invocation_kind,
        link.turn_index,
        coalesce(link.created_at, r.created_at) as linked_at,
        r.status,
        r.goal,
        r.result,
        ${modelColumns}
      from requested_roots rr
      join agent_runs r on r.id = rr.root_run_id
      left join lateral (
        select l.run_id, l.invocation_kind, l.turn_index, l.created_at
        from gateway_session_run_links l
        where $1::text is not null
          and l.session_id = $1
          and l.invocation_kind = 'run'
          and l.root_run_id = rr.root_run_id::text
        order by l.created_at asc, l.run_id asc
        limit 1
      ) link on true
      order by rr.ordinality asc
    `,
    [sessionId, rootRunIds],
  );
  return result.rows.map((row) => ({
    rootRunId: row.root_run_id,
    runId: row.run_id,
    invocationKind: row.invocation_kind,
    turnIndex: row.turn_index,
    linkedAt: row.linked_at,
    status: row.status,
    goal: row.goal,
    result: row.result,
    modelProvider: row.model_provider,
    modelName: row.model_name,
  }));
}

async function loadSessionUsage(client: PostgresClient, rootRunIds: string[]): Promise<SessionUsageSummary> {
  if (rootRunIds.length === 0) {
    return {
      total: { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCostUSD: 0 },
      byRootRun: [],
    };
  }

  const result = await client.query<{
    root_run_id: string;
    total_prompt_tokens: string | number;
    total_completion_tokens: string | number;
    total_reasoning_tokens: string | number | null;
    estimated_cost_usd: string | number;
  }>(
    `
      with recursive root_runs as (
        select root_run_id::uuid as root_run_id, ordinality
        from unnest($1::text[]) with ordinality as roots(root_run_id, ordinality)
      ), run_tree as (
        select r.id, r.root_run_id, r.created_at
        from agent_runs r
        join root_runs rr on rr.root_run_id = r.id

        union all

        select c.id, c.root_run_id, c.created_at
        from agent_runs c
        join run_tree rt on c.parent_run_id = rt.id
      )
      select
        rt.root_run_id::text as root_run_id,
        coalesce(sum(r.total_prompt_tokens), 0)::text as total_prompt_tokens,
        coalesce(sum(r.total_completion_tokens), 0)::text as total_completion_tokens,
        coalesce(sum(r.total_reasoning_tokens), 0)::text as total_reasoning_tokens,
        coalesce(sum(r.estimated_cost_usd), 0)::text as estimated_cost_usd
      from run_tree rt
      join agent_runs r on r.id = rt.id
      join root_runs rr on rr.root_run_id = rt.root_run_id
      group by rt.root_run_id, rr.ordinality
      order by rr.ordinality asc, rt.root_run_id asc
    `,
    [rootRunIds],
  );

  const byRootRun = result.rows.map((row) => ({
    rootRunId: row.root_run_id,
    usage: usageSummaryFromRow(row),
  }));

  const total = byRootRun.reduce<UsageSummary>(
    (acc, item) => {
      const reasoningTokens = (acc.reasoningTokens ?? 0) + (item.usage.reasoningTokens ?? 0);
      return {
        promptTokens: acc.promptTokens + item.usage.promptTokens,
        completionTokens: acc.completionTokens + item.usage.completionTokens,
        reasoningTokens: reasoningTokens > 0 ? reasoningTokens : undefined,
        totalTokens: acc.totalTokens + item.usage.totalTokens,
        estimatedCostUSD: acc.estimatedCostUSD + item.usage.estimatedCostUSD,
      };
    },
    { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCostUSD: 0 },
  );

  return { total, byRootRun };
}

async function loadRunMessageTraces(client: PostgresClient, rootRunIds: string[]): Promise<RunMessageTrace[]> {
  if (rootRunIds.length === 0) {
    return [];
  }

  const result = await client.query<SnapshotMessageRow>(
    `
      with recursive root_runs as (
        select root_run_id::uuid as root_run_id, ordinality
        from unnest($1::text[]) with ordinality as roots(root_run_id, ordinality)
      ), run_tree as (
        select
          rr.root_run_id,
          rr.ordinality,
          r.id as run_id,
          r.delegate_name,
          r.delegation_depth,
          r.created_at as run_created_at
        from root_runs rr
        join agent_runs r on r.id = rr.root_run_id

        union all

        select
          rt.root_run_id,
          rt.ordinality,
          c.id as run_id,
          c.delegate_name,
          c.delegation_depth,
          c.created_at as run_created_at
        from run_tree rt
        join agent_runs c on c.parent_run_id = rt.run_id
      )
      select
        rt.root_run_id::text as root_run_id,
        rt.run_id::text as run_id,
        rt.delegate_name as run_delegate_name,
        rt.delegation_depth,
        initial_snapshot.snapshot_seq as initial_snapshot_seq,
        initial_snapshot.created_at as initial_snapshot_created_at,
        initial_snapshot.state as initial_snapshot_state,
        latest_snapshot.snapshot_seq as latest_snapshot_seq,
        latest_snapshot.created_at as latest_snapshot_created_at,
        latest_snapshot.state as latest_snapshot_state
      from run_tree rt
      left join lateral (
        select rs.snapshot_seq, rs.created_at, rs.state
        from run_snapshots rs
        where rs.run_id = rt.run_id
        order by rs.snapshot_seq asc
        limit 1
      ) initial_snapshot on true
      left join lateral (
        select rs.snapshot_seq, rs.created_at, rs.state
        from run_snapshots rs
        where rs.run_id = rt.run_id
        order by rs.snapshot_seq desc
        limit 1
      ) latest_snapshot on true
      order by rt.ordinality asc, rt.run_created_at asc, rt.run_id asc
    `,
    [rootRunIds],
  );

  return result.rows
    .map(runMessageTraceFromRow)
    .filter((trace): trace is RunMessageTrace => trace !== null);
}

async function loadRunSnapshotSummaries(client: PostgresClient, rootRunIds: string[]): Promise<RunSnapshotSummary[]> {
  if (rootRunIds.length === 0) {
    return [];
  }

  const result = await client.query<SnapshotMessageRow>(
    `
      with recursive root_runs as (
        select root_run_id::uuid as root_run_id, ordinality
        from unnest($1::text[]) with ordinality as roots(root_run_id, ordinality)
      ), run_tree as (
        select
          rr.root_run_id,
          rr.ordinality,
          r.id as run_id,
          r.delegate_name,
          r.delegation_depth,
          r.created_at as run_created_at
        from root_runs rr
        join agent_runs r on r.id = rr.root_run_id

        union all

        select
          rt.root_run_id,
          rt.ordinality,
          c.id as run_id,
          c.delegate_name,
          c.delegation_depth,
          c.created_at as run_created_at
        from run_tree rt
        join agent_runs c on c.parent_run_id = rt.run_id
      )
      select
        rt.root_run_id::text as root_run_id,
        rt.run_id::text as run_id,
        rt.delegate_name as run_delegate_name,
        rt.delegation_depth,
        null::bigint as initial_snapshot_seq,
        null::timestamptz as initial_snapshot_created_at,
        null::jsonb as initial_snapshot_state,
        latest_snapshot.snapshot_seq as latest_snapshot_seq,
        latest_snapshot.created_at as latest_snapshot_created_at,
        latest_snapshot.state as latest_snapshot_state
      from run_tree rt
      left join lateral (
        select rs.snapshot_seq, rs.created_at, rs.state
        from run_snapshots rs
        where rs.run_id = rt.run_id
        order by rs.snapshot_seq desc
        limit 1
      ) latest_snapshot on true
      order by rt.ordinality asc, rt.run_created_at asc, rt.run_id asc
    `,
    [rootRunIds],
  );

  return result.rows.map((row) => {
    const latestState = parseSnapshotState(row.latest_snapshot_state);
    return {
      rootRunId: row.root_run_id,
      runId: row.run_id,
      delegateName: row.run_delegate_name,
      depth: row.delegation_depth ?? 0,
      latestSnapshotSeq: row.latest_snapshot_seq,
      latestSnapshotCreatedAt: row.latest_snapshot_created_at,
      latestStepsUsed: latestState?.stepsUsed ?? null,
    };
  });
}

async function loadTraceRows(client: PostgresClient, sessionId: string, rootRunIds: string[]): Promise<TraceRow[]> {
  if (rootRunIds.length === 0) {
    return [];
  }

  const result = await client.query<TraceRow>(
    `
      with recursive root_runs as (
        select root_run_id::uuid as root_run_id, ordinality
        from unnest($1::text[]) with ordinality as roots(root_run_id, ordinality)
      ), run_tree as (
        select
          rr.root_run_id,
          rr.ordinality,
          r.id as run_id,
          r.parent_run_id,
          r.parent_step_id,
          r.delegate_name,
          r.delegation_depth,
          r.status as run_status,
          r.current_step_id,
          r.current_child_run_id,
          r.goal,
          r.error_code as run_error_code,
          r.error_message as run_error_message,
          r.created_at as run_created_at,
          r.updated_at as run_updated_at,
          r.completed_at as run_completed_at
        from root_runs rr
        join agent_runs r on r.id = rr.root_run_id

        union all

        select
          rt.root_run_id,
          rt.ordinality,
          c.id as run_id,
          c.parent_run_id,
          c.parent_step_id,
          c.delegate_name,
          c.delegation_depth,
          c.status as run_status,
          c.current_step_id,
          c.current_child_run_id,
          c.goal,
          c.error_code as run_error_code,
          c.error_message as run_error_message,
          c.created_at as run_created_at,
          c.updated_at as run_updated_at,
          c.completed_at as run_completed_at
        from run_tree rt
        join agent_runs c on c.parent_run_id = rt.run_id
      )
      select
        $2::text as session_id,
        rt.root_run_id::text as root_run_id,
        rt.run_id::text as run_id,
        rt.parent_run_id::text as parent_run_id,
        rt.parent_step_id,
        rt.delegate_name as run_delegate_name,
        rt.delegation_depth,
        rt.run_status,
        rt.current_step_id,
        rt.current_child_run_id::text as current_child_run_id,
        rt.goal,
        rt.run_error_code,
        rt.run_error_message,
        rt.run_created_at,
        rt.run_updated_at,
        rt.run_completed_at,
        e.id::text as event_id,
        e.seq as event_seq,
        e.created_at as event_created_at,
        e.event_type,
        e.step_id as event_step_id,
        e.tool_call_id,
        e.payload,
        e.payload ->> 'toolName' as event_tool_name,
        coalesce(te.input, e.payload -> 'input', child.input) as resolved_input,
        te.tool_name as ledger_tool_name,
        te.status as tool_execution_status,
        te.started_at as tool_started_at,
        te.completed_at as tool_completed_at,
        te.output as tool_output,
        te.error_code as tool_error_code,
        te.error_message as tool_error_message,
        coalesce(te.child_run_id, nullif(e.payload ->> 'childRunId', '')::uuid)::text as child_run_id,
        child.status as child_run_status,
        child.error_code as child_error_code,
        child.error_message as child_error_message,
        child.result as child_run_result
      from run_tree rt
      left join agent_events e on e.run_id = rt.run_id
      left join tool_executions te
        on te.run_id = e.run_id
       and te.tool_call_id = e.tool_call_id
      left join agent_runs child
        on child.id = coalesce(te.child_run_id, nullif(e.payload ->> 'childRunId', '')::uuid)
      order by event_created_at asc nulls last, event_seq asc nulls last, run_created_at asc nulls last
    `,
    [rootRunIds, sessionId],
  );
  return result.rows;
}

async function loadDelegateDiagnostics(client: PostgresClient, rootRunIds: string[]): Promise<DelegateRow[]> {
  if (rootRunIds.length === 0) {
    return [];
  }

  const result = await client.query<DelegateRow>(
    `
      with recursive root_runs as (
        select root_run_id::uuid as root_run_id
        from unnest($1::text[]) as roots(root_run_id)
      ), run_tree as (
        select r.id, r.root_run_id, r.parent_run_id, r.parent_step_id, r.delegate_name, r.status,
               r.current_step_id, r.current_child_run_id, r.lease_owner, r.lease_expires_at,
               r.heartbeat_at, r.error_code, r.error_message, r.result, r.created_at, r.updated_at,
               r.completed_at
        from agent_runs r
        join root_runs rr on rr.root_run_id = r.id

        union all

        select c.id, c.root_run_id, c.parent_run_id, c.parent_step_id, c.delegate_name, c.status,
               c.current_step_id, c.current_child_run_id, c.lease_owner, c.lease_expires_at,
               c.heartbeat_at, c.error_code, c.error_message, c.result, c.created_at, c.updated_at,
               c.completed_at
        from agent_runs c
        join run_tree rt on c.parent_run_id = rt.id
      )
      select
        parent.root_run_id,
        parent.id as parent_run_id,
        parent.current_step_id as parent_step_id,
        parent.status as parent_status,
        coalesce(parent_tool.child_run_id, parent.current_child_run_id) as child_run_id,
        snap.state ->> 'waitingOnDelegateName' as snapshot_delegate_name,
        snap.state ->> 'waitingOnChildRunId' as snapshot_child_run_id,
        child.delegate_name as child_delegate_name,
        child.status as child_status,
        child.parent_run_id as child_parent_run_id,
        child.parent_step_id as child_parent_step_id,
        child.heartbeat_at as child_heartbeat_at,
        child.lease_owner as child_lease_owner,
        child.lease_expires_at as child_lease_expires_at,
        child.updated_at as child_updated_at,
        child.completed_at as child_completed_at,
        child.error_code as child_error_code,
        child.error_message as child_error_message,
        child.result as child_result,
        case
          when child.id is null then 'missing child row'
          when child.parent_run_id is distinct from parent.id then 'child linkage mismatch'
          when child.status in ('queued', 'planning', 'running') then 'still running'
          when child.status = 'awaiting_approval' then 'awaiting approval'
          when child.status = 'awaiting_subagent' then 'waiting on its own child'
          when child.status = 'interrupted' then 'interrupted and needs resume'
          when child.status = 'succeeded' then 'returned successfully'
          when child.status = 'replan_required' then 'returned replan.required'
          when child.status = 'failed' then 'failed'
          when child.status = 'cancelled' then 'cancelled'
          else 'state requires manual inspection'
        end as delegate_reason,
        parent_last_event.event_type as parent_last_event_type,
        parent_last_event.created_at as parent_last_event_at,
        parent_last_event.payload as parent_last_event_payload,
        child_last_event.event_type as child_last_event_type,
        child_last_event.created_at as child_last_event_at,
        child_last_event.payload as child_last_event_payload
      from run_tree parent
      left join lateral (
        select te.child_run_id
        from tool_executions te
        where te.run_id = parent.id
          and te.step_id = parent.current_step_id
          and te.child_run_id is not null
        order by te.started_at desc, te.tool_call_id desc
        limit 1
      ) parent_tool on true
      left join agent_runs child on child.id = coalesce(parent_tool.child_run_id, parent.current_child_run_id)
      left join lateral (
        select rs.state
        from run_snapshots rs
        where rs.run_id = parent.id
        order by rs.snapshot_seq desc
        limit 1
      ) snap on true
      left join lateral (
        select e.event_type, e.created_at, e.payload
        from agent_events e
        where e.run_id = parent.id
        order by e.seq desc
        limit 1
      ) parent_last_event on true
      left join lateral (
        select e.event_type, e.created_at, e.payload
        from agent_events e
        where e.run_id = child.id
        order by e.seq desc
        limit 1
      ) child_last_event on true
      where parent.status = 'awaiting_subagent'
         or parent.current_child_run_id is not null
         or parent_tool.child_run_id is not null
      order by parent.updated_at asc, parent.id asc
    `,
    [rootRunIds],
  );
  return result.rows;
}

async function loadPlans(client: PostgresClient, rootRunIds: string[]): Promise<PlanRow[]> {
  if (rootRunIds.length === 0) {
    return [];
  }

  const result = await client.query<PlanRow>(
    `
      with recursive root_runs as (
        select root_run_id::uuid as root_run_id, ordinality
        from unnest($1::text[]) with ordinality as roots(root_run_id, ordinality)
      ), run_tree as (
        select r.id, r.root_run_id, r.current_plan_id, r.current_plan_execution_id
        from agent_runs r
        join root_runs rr on rr.root_run_id = r.id

        union all

        select c.id, c.root_run_id, c.current_plan_id, c.current_plan_execution_id
        from agent_runs c
        join run_tree rt on c.parent_run_id = rt.id
      )
      select
        rt.root_run_id,
        rt.id as run_id,
        pe.id as plan_execution_id,
        pe.status as plan_execution_status,
        pe.attempt,
        pe.current_step_id,
        pe.current_step_index,
        pe.replan_reason,
        p.id as plan_id,
        p.goal as plan_goal,
        p.summary as plan_summary,
        ps.step_index,
        ps.step_key,
        ps.title,
        ps.tool_name,
        ps.failure_policy,
        ps.requires_approval,
        ps.input_template
      from run_tree rt
      join root_runs rr on rr.root_run_id = rt.root_run_id
      left join plan_executions pe on pe.id = rt.current_plan_execution_id or pe.run_id = rt.id
      left join plans p on p.id = pe.plan_id
      left join plan_steps ps on ps.plan_id = p.id
      order by rr.ordinality asc, rt.root_run_id asc, rt.id asc, pe.attempt asc nulls last, ps.step_index asc nulls last
    `,
    [rootRunIds],
  );
  return result.rows;
}

function runMessageTraceFromRow(row: SnapshotMessageRow): RunMessageTrace | null {
  const initialState = parseSnapshotState(row.initial_snapshot_state);
  const latestState = parseSnapshotState(row.latest_snapshot_state ?? row.initial_snapshot_state);
  if (!initialState || !latestState) {
    return null;
  }

  const initialMessageCount = initialState.messages.length;
  let initialSystemMessagesSeen = 0;
  const initialMessages: TraceMessage[] = initialState.messages.map((message, index) => {
    const category = classifyPersistedMessage(message, index, initialMessageCount, initialSystemMessagesSeen);
    if (message.role === 'system' && index < initialMessageCount) {
      initialSystemMessagesSeen += 1;
    }
    return {
      position: index,
      persistence: 'persisted',
      role: message.role,
      content: message.content,
      name: message.name,
      toolCallId: message.toolCallId,
      toolCalls: message.toolCalls,
      category,
    };
  });

  initialSystemMessagesSeen = 0;
  const effectiveMessages: TraceMessage[] = latestState.messages.map((message, index) => {
    const category = classifyPersistedMessage(message, index, initialMessageCount, initialSystemMessagesSeen);
    if (message.role === 'system' && index < initialMessageCount) {
      initialSystemMessagesSeen += 1;
    }
    return {
      position: index,
      persistence: 'persisted',
      role: message.role,
      content: message.content,
      name: message.name,
      toolCallId: message.toolCallId,
      toolCalls: message.toolCalls,
      category,
    };
  });

  for (const [offset, message] of latestState.pendingRuntimeMessages.entries()) {
    effectiveMessages.push({
      position: latestState.messages.length + offset,
      persistence: 'pending',
      role: message.role,
      content: message.content,
      name: message.name,
      toolCallId: message.toolCallId,
      toolCalls: message.toolCalls,
      category: classifyPendingMessage(message),
    });
  }

  return {
    rootRunId: row.root_run_id,
    runId: row.run_id,
    delegateName: row.run_delegate_name,
    depth: row.delegation_depth ?? 0,
    initialSnapshotSeq: row.initial_snapshot_seq,
    initialSnapshotCreatedAt: row.initial_snapshot_created_at,
    latestSnapshotSeq: row.latest_snapshot_seq,
    latestSnapshotCreatedAt: row.latest_snapshot_created_at,
    initialMessages,
    latestStepsUsed: latestState.stepsUsed,
    effectiveMessages,
  };
}

function snapshotSummaryFromMessageTrace(trace: RunMessageTrace): RunSnapshotSummary {
  return {
    rootRunId: trace.rootRunId,
    runId: trace.runId,
    delegateName: trace.delegateName,
    depth: trace.depth,
    latestSnapshotSeq: trace.latestSnapshotSeq,
    latestSnapshotCreatedAt: trace.latestSnapshotCreatedAt,
    latestStepsUsed: trace.latestStepsUsed ?? null,
  };
}

function parseSnapshotState(value: unknown): { messages: ParsedTraceMessage[]; pendingRuntimeMessages: ParsedTraceMessage[]; stepsUsed: number | null } | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  return {
    messages: parseTraceMessages(record.messages),
    pendingRuntimeMessages: parseTraceMessages(record.pendingRuntimeMessages),
    stepsUsed: typeof record.stepsUsed === 'number' ? record.stepsUsed : null,
  };
}

interface ParsedTraceMessage {
  role: TraceMessageRole;
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: TraceToolCall[];
}

function parseTraceMessages(value: unknown): ParsedTraceMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    const parsed = parseTraceMessage(entry);
    return parsed ? [parsed] : [];
  });
}

function parseTraceMessage(value: unknown): ParsedTraceMessage | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (!isTraceMessageRole(record.role) || typeof record.content !== 'string') {
    return null;
  }

  const toolCalls = parseTraceToolCalls(record.toolCalls);
  return {
    role: record.role,
    content: record.content,
    name: typeof record.name === 'string' ? record.name : undefined,
    toolCallId: typeof record.toolCallId === 'string' ? record.toolCallId : undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}

function parseTraceToolCalls(value: unknown): TraceToolCall[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }

    const record = entry as Record<string, unknown>;
    if (typeof record.id !== 'string' || typeof record.name !== 'string' || !('input' in record)) {
      return [];
    }

    return [{
      id: record.id,
      name: record.name,
      input: record.input,
    }];
  });
}

function isTraceMessageRole(value: unknown): value is TraceMessageRole {
  return value === 'system' || value === 'user' || value === 'assistant' || value === 'tool';
}

function classifyPersistedMessage(
  message: ParsedTraceMessage,
  index: number,
  initialMessageCount: number,
  initialSystemMessagesSeen: number,
): TraceMessage['category'] {
  switch (message.role) {
    case 'user':
      return 'user';
    case 'assistant':
      return 'assistant';
    case 'tool':
      return 'tool';
    case 'system':
      if (index >= initialMessageCount) {
        return 'runtime-injected-system';
      }
      return initialSystemMessagesSeen === 0 ? 'initial-runtime-system' : 'gateway-chat-system-context';
  }
}

function classifyPendingMessage(message: ParsedTraceMessage): TraceMessage['category'] {
  switch (message.role) {
    case 'user':
      return 'user';
    case 'assistant':
      return 'assistant';
    case 'tool':
      return 'tool';
    case 'system':
      return 'runtime-injected-system';
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return inspect(error);
}
