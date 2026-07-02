import { describe, expect, it } from 'vitest';

import { buildTimeline, buildTraceDiagnostics, computeDelegateReason, listSessions, loadUsageForTraceTarget, parseArgs, renderDeleteEmptyGoalSessionsSql, renderSessionList, renderSessionPerformanceList, renderSessionlessRunList, renderTraceHtml, renderTraceReport, renderUsageReport, summarizePerformance, summarizeTrace, traceSession } from './trace-session.js';
import type { TraceRow } from './trace-session.js';

describe('trace-session CLI helpers', () => {
  it('parses the primary trace-session command and flags', () => {
    expect(parseArgs(['trace-session', 'sess-1', '--json', '--root-run', 'root-1', '--include-plans', '--only-delegates'])).toEqual({
      sessionId: 'sess-1',
      json: true,
      listSessions: false,
      listPerformance: false,
      listSessionless: false,
      deleteEmptyGoalSessions: false,
      usageOnly: false,
      rootRunId: 'root-1',
      includePlans: true,
      onlyDelegates: true,
      messages: false,
      systemOnly: false,
      help: false,
    });
  });

  it('parses message inspection flags for session tracing', () => {
    expect(parseArgs(['trace-session', 'sess-1', '--messages', '--system-only'])).toEqual({
      sessionId: 'sess-1',
      json: false,
      listSessions: false,
      listPerformance: false,
      listSessionless: false,
      deleteEmptyGoalSessions: false,
      usageOnly: false,
      includePlans: false,
      onlyDelegates: false,
      messages: true,
      systemOnly: true,
      help: false,
    });
  });

  it('parses view, message view, focus run, and preview width flags', () => {
    expect(parseArgs(['trace-session', 'sess-1', '--view', 'messages', '--messages-view', 'delta', '--focus-run', 'run-2', '--preview-chars', '80'])).toEqual({
      sessionId: 'sess-1',
      json: false,
      listSessions: false,
      listPerformance: false,
      listSessionless: false,
      deleteEmptyGoalSessions: false,
      usageOnly: false,
      includePlans: false,
      onlyDelegates: false,
      messages: true,
      messagesView: 'delta',
      view: 'messages',
      focusRunId: 'run-2',
      previewChars: 80,
      systemOnly: false,
      help: false,
    });
  });

  it('parses the performance report view', () => {
    expect(parseArgs(['trace-session', 'sess-1', '--view', 'performance'])).toMatchObject({
      sessionId: 'sess-1',
      view: 'performance',
    });
  });

  it('parses the final output report view', () => {
    expect(parseArgs(['trace-session', 'sess-1', '--view', 'output'])).toMatchObject({
      sessionId: 'sess-1',
      view: 'output',
    });
  });

  it('parses diagnostic report views', () => {
    expect(parseArgs(['trace-session', 'sess-1', '--view', 'brief'])).toMatchObject({ view: 'brief' });
    expect(parseArgs(['trace-session', 'sess-1', '--view', 'investigate'])).toMatchObject({ view: 'investigate' });
    expect(parseArgs(['trace-session', 'sess-1', '--view', 'policy'])).toMatchObject({ view: 'policy' });
  });

  it('parses the static HTML report path', () => {
    expect(parseArgs(['trace-session', 'sess-1', '--html', 'artifacts/trace.html'])).toMatchObject({
      sessionId: 'sess-1',
      htmlPath: 'artifacts/trace.html',
    });
  });

  it('parses direct run tracing flags without a session id', () => {
    expect(parseArgs(['trace-session', '--run', 'run-1', '--messages'])).toEqual({
      json: false,
      listSessions: false,
      listPerformance: false,
      listSessionless: false,
      deleteEmptyGoalSessions: false,
      usageOnly: false,
      includePlans: false,
      onlyDelegates: false,
      runId: 'run-1',
      messages: true,
      systemOnly: false,
      help: false,
    });
  });

  it('parses the session list flag without a session id', () => {
    expect(parseArgs(['trace-session', '--ls', '--json', '--preview-chars', '40'])).toEqual({
      sessionId: undefined,
      json: true,
      listSessions: true,
      listPerformance: false,
      listSessionless: false,
      deleteEmptyGoalSessions: false,
      usageOnly: false,
      includePlans: false,
      onlyDelegates: false,
      messages: false,
      previewChars: 40,
      systemOnly: false,
      help: false,
    });
  });

  it('parses the session performance list flag without a session id', () => {
    expect(parseArgs(['trace-session', '--lsp', '--json', '--preview-chars', '40'])).toEqual({
      sessionId: undefined,
      json: true,
      listSessions: false,
      listPerformance: true,
      listSessionless: false,
      deleteEmptyGoalSessions: false,
      usageOnly: false,
      includePlans: false,
      onlyDelegates: false,
      messages: false,
      previewChars: 40,
      systemOnly: false,
      help: false,
    });
  });

  it('parses the delete flag without a session id', () => {
    expect(parseArgs(['trace-session', '--delete'])).toEqual({
      sessionId: undefined,
      json: false,
      listSessions: false,
      listPerformance: false,
      listSessionless: false,
      deleteEmptyGoalSessions: true,
      usageOnly: false,
      includePlans: false,
      onlyDelegates: false,
      messages: false,
      systemOnly: false,
      help: false,
    });
  });

  it('parses the usage flag with a session id', () => {
    expect(parseArgs(['trace-session', 'sess-1', '--usage', '--json'])).toEqual({
      sessionId: 'sess-1',
      json: true,
      listSessions: false,
      listPerformance: false,
      listSessionless: false,
      deleteEmptyGoalSessions: false,
      usageOnly: true,
      includePlans: false,
      onlyDelegates: false,
      messages: false,
      systemOnly: false,
      help: false,
    });
  });

  it('renders listed sessions with full ids, start time, and goals', () => {
    const output = renderSessionList(
      [
        {
          sessionId: 'session-newest-full-id',
          startedAt: '2026-04-16T10:00:00.000Z',
          status: 'succeeded',
          goals: [
            {
              rootRunId: 'root-2',
              runId: 'root-2',
              status: 'succeeded',
              startedAt: '2026-04-16T10:00:01.000Z',
              completedAt: '2026-04-16T10:00:03.000Z',
              goal: 'Summarize the incident timeline',
              linkedAt: '2026-04-16T10:00:01.000Z',
            },
          ],
        },
        {
          sessionId: 'session-older-full-id',
          startedAt: '2026-04-16T09:00:00.000Z',
          status: 'unknown',
          goals: [],
        },
        {
          sessionId: null,
          startedAt: '2026-04-16T08:00:00.000Z',
          status: 'succeeded',
          goals: [
            {
              rootRunId: 'root-sessionless',
              runId: 'root-sessionless',
              status: 'succeeded',
              startedAt: '2026-04-16T08:00:00.000Z',
              completedAt: '2026-04-16T08:00:05.000Z',
              goal: 'SDK-only run',
              linkedAt: '2026-04-16T08:00:00.000Z',
            },
          ],
        },
      ],
      { json: false },
    );

    expect(output).toContain('---- session-newest-full-id : succeeded : 2026-04-16T10:00:00.000Z ----');
    expect(output).toContain('  Goal: Summarize the incident timeline');
    expect(output).toContain('  - root-2  succeeded  started=2026-04-16 10:00:01.000  elapsed=2.00s');
    expect(output).toContain('---- session-older-full-id : unknown : 2026-04-16T09:00:00.000Z ----');
    expect(output).toContain('  Goal: (none)');
    expect(output).toContain('  Runs: (none)');
    expect(output).toContain('---- sessionless:root-sessionless : succeeded : 2026-04-16T08:00:00.000Z ----');
    expect(output).toContain('  - run=root-sessionless  succeeded  started=2026-04-16 08:00:00.000  elapsed=5.00s');
  });

  it('renders listed sessions as JSON', () => {
    const output = renderSessionList(
      [{
        sessionId: 'session-1',
        startedAt: now(),
        goals: [{
          rootRunId: 'root-1',
          runId: 'root-1',
          status: 'succeeded',
          startedAt: now(),
          completedAt: now(),
          goal: 'Finish the task',
          linkedAt: now(),
        }],
      }],
      { json: true },
    );

    expect(JSON.parse(output)).toEqual([
      {
        sessionId: 'session-1',
        startedAt: now(),
        goals: [{
          rootRunId: 'root-1',
          runId: 'root-1',
          status: 'succeeded',
          startedAt: now(),
          completedAt: now(),
          goal: 'Finish the task',
          linkedAt: now(),
        }],
      },
    ]);
  });

  it('falls back to agent_runs.session_id when listing runs without gateway links', async () => {
    const client = {
      query: async <TRow extends Record<string, unknown>>(sql: string) => {
        if (sql.includes('select to_regclass')) {
          return { rows: [{ exists: false }] } as unknown as { rows: TRow[] };
        }

        if (sql.includes('from information_schema.columns')) {
          return { rows: [{ count: '3' }] } as unknown as { rows: TRow[] };
        }

        if (sql.includes('from information_schema.tables')) {
          return { rows: [{ count: '2' }] } as unknown as { rows: TRow[] };
        }

        if (sql.includes('from gateway_sessions s')) {
          return { rows: [] } as unknown as { rows: TRow[] };
        }

        if (sql.includes('from agent_runs r') && sql.includes('l.root_run_id is null')) {
          return {
            rows: [
              {
                session_id: 'swarm-session-1',
                root_run_id: 'root-from-swarm',
                started_at: '2026-04-16T11:00:00.000Z',
                completed_at: '2026-04-16T11:00:05.000Z',
                status: 'succeeded',
                goal: 'CLI swarm run',
              },
              {
                session_id: null,
                root_run_id: 'root-without-session',
                started_at: '2026-04-16T10:00:00.000Z',
                completed_at: null,
                status: 'running',
                goal: 'Detached SDK run',
              },
            ],
          } as unknown as { rows: TRow[] };
        }

        throw new Error(`Unexpected SQL in test:\n${sql}`);
      },
    };

    const sessions = await listSessions(client as never);

    expect(sessions).toEqual([
      expect.objectContaining({
        sessionId: 'swarm-session-1',
        goals: [expect.objectContaining({ rootRunId: 'root-from-swarm' })],
      }),
      expect.objectContaining({
        sessionId: null,
        goals: [expect.objectContaining({ rootRunId: 'root-without-session' })],
      }),
    ]);

    const deleteSessions = await listSessions(client as never, { recoverAgentRunSessionIds: false });
    expect(deleteSessions[0]?.sessionId).toBeNull();
  });

  it('lists core runtime sessions when gateway session tables are absent', async () => {
    const client = {
      query: async <TRow extends Record<string, unknown>>(sql: string) => {
        if (sql.includes('select to_regclass')) {
          return { rows: [{ exists: false }] } as unknown as { rows: TRow[] };
        }

        if (sql.includes('from information_schema.columns')) {
          return { rows: [{ count: '3' }] } as unknown as { rows: TRow[] };
        }

        if (sql.includes('from information_schema.tables')) {
          return { rows: [{ count: '0' }] } as unknown as { rows: TRow[] };
        }

        if (sql.includes('from agent_runs r') && sql.includes('r.session_id is not null')) {
          return {
            rows: [{
              session_id: 'core-session-1',
              started_at: '2026-04-16T11:00:00.000Z',
              status: 'succeeded',
              goals: [{
                rootRunId: 'core-root-1',
                runId: 'core-root-1',
                status: 'succeeded',
                startedAt: '2026-04-16T11:00:00.000Z',
                completedAt: '2026-04-16T11:00:05.000Z',
                goal: 'Core-only CLI run',
                linkedAt: '2026-04-16T11:00:00.000Z',
              }],
            }],
          } as unknown as { rows: TRow[] };
        }

        if (sql.includes('from agent_runs r') && sql.includes('r.session_id is null')) {
          return { rows: [] } as unknown as { rows: TRow[] };
        }

        throw new Error(`Unexpected SQL in test:\n${sql}`);
      },
    };

    await expect(listSessions(client as never)).resolves.toEqual([
      expect.objectContaining({
        sessionId: 'core-session-1',
        goals: [expect.objectContaining({ rootRunId: 'core-root-1' })],
      }),
    ]);
  });

  it('renders listed session performance as one line per run', () => {
    const performance = summarizePerformance([
      traceRow({
        event_id: 'model-done',
        event_type: 'model.completed',
        payload: { performance: { durationMs: 1500 } },
      }),
      traceRow({
        event_id: 'tool-done',
        event_type: 'tool.completed',
        event_tool_name: 'read_file',
        payload: { toolName: 'read_file', performance: { durationMs: 250 } },
      }),
      traceRow({
        event_id: 'snapshot',
        event_type: 'snapshot.created',
        payload: { performance: { saveDurationMs: 50 } },
      }),
    ]);

    const output = renderSessionPerformanceList(
      [{
        sessionId: 'session-1',
        sessionStatus: 'succeeded',
        rootRunId: 'root-1',
        runId: 'root-1',
        runStatus: 'succeeded',
        startedAt: '2026-04-16T10:00:00.000Z',
        completedAt: '2026-04-16T10:00:02.000Z',
        totalDurationMs: 2000,
        goal: 'Summarize the incident timeline',
        performance,
      }],
      { json: false },
    );

    expect(output).toContain('session=session-1');
    expect(output).toContain('run=root-1');
    expect(output).toContain('total=2.00s');
    expect(output).toContain('model=1.50s');
    expect(output).toContain('tools=250ms');
    expect(output).toContain('snapshot=50ms');
    expect(output).toContain('other=200ms');
    expect(output).toContain('\n  goal=Summarize the incident timeline');
    expect(output.split('\n')).toHaveLength(2);
  });

  it('renders null session ids in listed session performance rows', () => {
    const output = renderSessionPerformanceList(
      [{
        sessionId: null,
        sessionStatus: 'succeeded',
        rootRunId: 'root-sessionless',
        runId: 'root-sessionless',
        runStatus: 'succeeded',
        startedAt: '2026-04-16T10:00:00.000Z',
        completedAt: '2026-04-16T10:00:01.000Z',
        totalDurationMs: 1000,
        goal: 'Session id omitted by gateway and runtime',
        performance: summarizePerformance([]),
      }],
      { json: false },
    );

    expect(output).toContain('session=null');
    expect(output).toContain('run=root-sessionless');
  });

  it('parses the session-less list flag without a session id', () => {
    expect(parseArgs(['trace-session', '--ls-sessionless', '--json'])).toEqual({
      sessionId: undefined,
      json: true,
      listSessions: false,
      listPerformance: false,
      listSessionless: true,
      deleteEmptyGoalSessions: false,
      usageOnly: false,
      includePlans: false,
      onlyDelegates: false,
      messages: false,
      systemOnly: false,
      help: false,
    });
  });

  it('renders listed session-less root runs with goals', () => {
    const output = renderSessionlessRunList(
      [
        {
          rootRunId: 'root-newest-full-id',
          startedAt: '2026-04-16T10:00:00.000Z',
          status: 'running',
          goal: 'Trace a detached run',
        },
        {
          rootRunId: 'root-older-full-id',
          startedAt: '2026-04-16T09:00:00.000Z',
          status: 'succeeded',
          goal: null,
        },
      ],
      { json: false },
    );

    expect(output).toContain('root-newest-full-id : 2026-04-16T10:00:00.000Z');
    expect(output).toContain('Goal : Trace a detached run');
    expect(output).toContain('-----');
    expect(output).toContain('root-older-full-id : 2026-04-16T09:00:00.000Z');
    expect(output).toContain('Goal : (none)');
  });

  it('renders listed session-less root runs as JSON', () => {
    const output = renderSessionlessRunList(
      [{
        rootRunId: 'root-1',
        startedAt: now(),
        status: 'succeeded',
        goal: 'Trace it',
      }],
      { json: true },
    );

    expect(JSON.parse(output)).toEqual([
      {
        rootRunId: 'root-1',
        startedAt: now(),
        status: 'succeeded',
        goal: 'Trace it',
      },
    ]);
  });

  it('renders delete SQL only for sessions with empty or null goals', () => {
    const output = renderDeleteEmptyGoalSessionsSql(
      [
        {
          sessionId: 'session-empty',
          startedAt: now(),
          goals: [],
        },
        {
          sessionId: 'session-null',
          startedAt: now(),
          goals: [{ rootRunId: 'root-null', runId: 'root-null', status: 'succeeded', startedAt: now(), completedAt: now(), goal: null, linkedAt: now() }],
        },
        {
          sessionId: 'session-blank',
          startedAt: now(),
          goals: [{ rootRunId: 'root-blank', runId: 'root-blank', status: 'succeeded', startedAt: now(), completedAt: now(), goal: '   ', linkedAt: now() }],
        },
        {
          sessionId: 'session-keep',
          startedAt: now(),
          goals: [{ rootRunId: 'root-keep', runId: 'root-keep', status: 'succeeded', startedAt: now(), completedAt: now(), goal: 'Keep me', linkedAt: now() }],
        },
      ],
      { json: false },
    );

    expect(output).toContain("delete from gateway_sessions where id = 'session-empty';");
    expect(output).toContain("delete from gateway_sessions where id = 'session-null';");
    expect(output).toContain("delete from gateway_sessions where id = 'session-blank';");
    expect(output).not.toContain("delete from gateway_sessions where id = 'session-keep';");
  });

  it('renders usage report for the whole session', () => {
    const output = renderUsageReport(
      usage({
        total: {
          promptTokens: 1000,
          completionTokens: 250,
          reasoningTokens: 25,
          totalTokens: 1275,
          estimatedCostUSD: 0.01,
        },
        byRootRun: [
          {
            rootRunId: 'root-1',
            usage: {
              promptTokens: 700,
              completionTokens: 200,
              totalTokens: 900,
              estimatedCostUSD: 0.007,
            },
          },
          {
            rootRunId: 'root-2',
            usage: {
              promptTokens: 300,
              completionTokens: 50,
              reasoningTokens: 25,
              totalTokens: 375,
              estimatedCostUSD: 0.003,
            },
          },
        ],
      }),
      { json: false },
    );

    expect(output).toContain('prompt=1,000');
    expect(output).toContain('completion=250');
    expect(output).toContain('reasoning=25');
    expect(output).toContain('Run usage by root run');
    expect(output).toContain('root run');
    expect(output).toContain('tokens');
    expect(output).toContain('root-1');
    expect(output).toContain('900');
    expect(output).toContain('700');
    expect(output).toContain('root-2');
    expect(output).toContain('375');
    expect(output).toContain('300');
  });

  it('includes completed non-delegate tool output usage in trace target totals', async () => {
    const client = {
      query: async <TRow extends Record<string, unknown>>(sql: string, params?: unknown[]) => {
        if (sql.includes('select to_regclass')) {
          return { rows: [{ exists: false }] } as unknown as { rows: TRow[] };
        }

        if (sql.includes('from information_schema.columns')) {
          return { rows: [{ count: '3' }] } as unknown as { rows: TRow[] };
        }

        if (sql.includes('from information_schema.tables')) {
          return { rows: [{ count: '0' }] } as unknown as { rows: TRow[] };
        }

        if (sql.includes('run_usage_by_root as')) {
          expect(params).toEqual([['root-usage']]);
          expect(sql).toContain('tool_output_usage_by_root as');
          expect(sql).toContain('te.child_run_id is null');
          expect(sql).toContain("te.output #>> '{usage,prompt_tokens}'");
          expect(sql).toContain("te.output #>> '{usage,cost_details,upstream_inference_cost}'");
          return {
            rows: [{
              root_run_id: 'root-usage',
              total_prompt_tokens: '143',
              total_completion_tokens: '4160',
              total_reasoning_tokens: '0',
              estimated_cost_usd: '0.16783',
            }],
          } as unknown as { rows: TRow[] };
        }

        if (sql.includes('attributed_usage as')) {
          expect(params).toEqual([['root-usage']]);
          return { rows: [] } as unknown as { rows: TRow[] };
        }

        if (sql.includes('attributed_tool_usage as')) {
          expect(params).toEqual([['root-usage']]);
          expect(sql).toContain("raw_usage.api_key_env ~* '^[A-Z0-9_]+_API_KEY$'");
          expect(sql).toContain("when te.tool_name ilike '%openrouter%' then 'openrouter'");
          return {
            rows: [{
              provider: 'openrouter',
              model: 'openai/gpt-image-1',
              tool_call_count: '1',
              total_prompt_tokens: '143',
              total_completion_tokens: '4160',
              total_reasoning_tokens: '0',
              estimated_cost_usd: '0.16783',
            }],
          } as unknown as { rows: TRow[] };
        }

        throw new Error(`Unexpected SQL in test:\n${sql}`);
      },
    };

    await expect(loadUsageForTraceTarget(client as never, {
      rootRunId: 'root-usage',
      json: false,
      listSessions: false,
      listPerformance: false,
      listSessionless: false,
      deleteEmptyGoalSessions: false,
      usageOnly: true,
      includePlans: false,
      onlyDelegates: false,
      messages: false,
      systemOnly: false,
      help: false,
    })).resolves.toEqual({
      total: {
        promptTokens: 143,
        completionTokens: 4160,
        totalTokens: 4303,
        estimatedCostUSD: 0.16783,
      },
      byRootRun: [{
        rootRunId: 'root-usage',
        usage: {
          promptTokens: 143,
          completionTokens: 4160,
          totalTokens: 4303,
          estimatedCostUSD: 0.16783,
        },
      }],
      byProviderModel: [],
      toolOutputByProviderModel: [{
        provider: 'openrouter',
        model: 'openai/gpt-image-1',
        usage: {
          promptTokens: 143,
          completionTokens: 4160,
          totalTokens: 4303,
          estimatedCostUSD: 0.16783,
        },
        toolCallCount: 1,
      }],
    });
  });

  it('renders a succeeded session summary', () => {
    const summary = summarizeTrace(
      session('succeeded'),
      [{
        rootRunId: 'root-succeeded',
        runId: 'root-succeeded',
        invocationKind: 'run',
        turnIndex: 0,
        linkedAt: now(),
        status: 'succeeded',
        goal: 'Finish the task',
        result: 'Done',
      }],
      [],
      [],
    );

    expect(summary).toEqual({
      status: 'succeeded',
      reason: 'succeeded because all linked root runs completed successfully',
    });
  });

  it('prefers discovered root run outcomes over a stale failed session status', () => {
    const summary = summarizeTrace(
      session('failed'),
      [{
        rootRunId: 'root-succeeded',
        runId: 'root-succeeded',
        invocationKind: 'run',
        turnIndex: 0,
        linkedAt: now(),
        status: 'succeeded',
        goal: 'Finish the task',
        result: 'Done',
      }],
      [],
      [],
    );

    expect(summary).toEqual({
      status: 'succeeded',
      reason: 'succeeded because all linked root runs completed successfully',
    });
  });

  it('renders a failed session summary from a failed delegate', () => {
    const summary = summarizeTrace(session('failed'), [], [], [
      delegate({
        child_status: 'failed',
        child_error_message: 'tool exploded',
      }),
    ]);

    expect(summary.status).toBe('failed');
    expect(summary.reason).toContain('tool exploded');
  });

  it('surfaces the persisted root run failure detail in the summary', () => {
    const summary = summarizeTrace(
      session('failed'),
      [{
        rootRunId: 'root-failed',
        runId: 'root-failed',
        invocationKind: 'run',
        turnIndex: 0,
        linkedAt: now(),
        status: 'failed',
        goal: 'Finish the task',
        result: null,
        errorCode: 'MODEL_ERROR',
        errorMessage: 'Model timed out after 90000ms',
      }],
      [],
      [],
    );

    expect(summary).toEqual({
      status: 'failed',
      reason: 'failed because root run root-failed failed: Model timed out after 90000ms',
    });
  });

  it('surfaces tool span failure detail in the summary when no root run error is available', () => {
    const summary = summarizeTrace(
      session('failed'),
      [],
      [{
        rootRunId: 'root-1',
        runId: 'root-1',
        depth: 0,
        stepId: 'step-1',
        toolCallId: 'tool-1',
        eventType: 'tool.failed',
        toolName: 'web_search',
        params: null,
        output: null,
        startedAt: now(),
        completedAt: now(),
        durationMs: 123,
        outcome: 'failed: Timed out after 90000ms',
        childRunId: null,
        eventSeq: 3,
      }],
      [],
    );

    expect(summary).toEqual({
      status: 'failed',
      reason: 'failed because tool web_search failed: Timed out after 90000ms',
    });
  });

  it('explains a delegate stuck in awaiting_subagent', () => {
    const stuck = delegate({ child_status: 'awaiting_subagent' });
    expect(computeDelegateReason(stuck)).toBe('waiting on its own child');

    const summary = summarizeTrace(session('running'), [], [], [stuck]);
    expect(summary).toEqual({
      status: 'blocked',
      reason: 'blocked because delegate analyst (child-run) is waiting on its own child',
    });
  });

  it('keeps pre-migration historical spans readable without precise ids', () => {
    const timeline = buildTimeline([
      {
        session_id: 'sess-old',
        root_run_id: 'root-old',
        run_id: 'root-old',
        parent_run_id: null,
        parent_step_id: null,
        run_delegate_name: null,
        delegation_depth: 0,
        run_status: 'succeeded',
        current_step_id: 'step-1',
        current_child_run_id: null,
        goal: null,
        run_error_code: null,
        run_error_message: null,
        run_created_at: now(),
        run_updated_at: now(),
        run_completed_at: now(),
        event_id: 'event-1',
        event_seq: 1,
        event_created_at: '2026-04-16T10:00:00.000Z',
        event_type: 'tool.completed',
        event_step_id: 'step-1',
        tool_call_id: null,
        payload: { toolName: 'read_file', input: { path: 'README.md' } },
        event_tool_name: 'read_file',
        resolved_input: { path: 'README.md' },
        ledger_tool_name: null,
        tool_execution_status: null,
        tool_started_at: null,
        tool_completed_at: null,
        tool_output: null,
        tool_error_code: null,
        tool_error_message: null,
        child_run_id: null,
        child_run_status: null,
        child_error_code: null,
        child_error_message: null,
        child_run_result: null,
      },
    ]);

    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.toolName).toBe('read_file');
    expect(timeline[0]?.toolCallId).toBeNull();
    expect(timeline[0]?.params).toEqual({ path: 'README.md' });
  });

  it('renders timeline titles with the earliest tool start and falls back to output previews when params are missing', () => {
    const timeline = buildTimeline([
      {
        session_id: 'sess-1',
        root_run_id: 'root-1',
        run_id: 'root-1',
        parent_run_id: null,
        parent_step_id: null,
        run_delegate_name: null,
        delegation_depth: 0,
        run_status: 'succeeded',
        current_step_id: 'step-1',
        current_child_run_id: null,
        goal: null,
        run_error_code: null,
        run_error_message: null,
        run_created_at: now(),
        run_updated_at: now(),
        run_completed_at: now(),
        event_id: 'event-1',
        event_seq: 1,
        event_created_at: '2026-04-19T02:37:42.662Z',
        event_type: 'tool.started',
        event_step_id: 'step-1',
        tool_call_id: 'call-1',
        payload: { toolName: 'read_file', input: { path: 'README.md' } },
        event_tool_name: 'read_file',
        resolved_input: { path: 'README.md' },
        ledger_tool_name: null,
        tool_execution_status: null,
        tool_started_at: null,
        tool_completed_at: null,
        tool_output: null,
        tool_error_code: null,
        tool_error_message: null,
        child_run_id: null,
        child_run_status: null,
        child_error_code: null,
        child_error_message: null,
        child_run_result: null,
      },
      {
        session_id: 'sess-1',
        root_run_id: 'root-1',
        run_id: 'root-1',
        parent_run_id: null,
        parent_step_id: null,
        run_delegate_name: null,
        delegation_depth: 0,
        run_status: 'succeeded',
        current_step_id: 'step-1',
        current_child_run_id: null,
        goal: null,
        run_error_code: null,
        run_error_message: null,
        run_created_at: now(),
        run_updated_at: now(),
        run_completed_at: now(),
        event_id: 'event-2',
        event_seq: 2,
        event_created_at: '2026-04-19T02:37:42.666Z',
        event_type: 'tool.completed',
        event_step_id: 'step-1',
        tool_call_id: 'call-1',
        payload: { toolName: 'read_file' },
        event_tool_name: 'read_file',
        resolved_input: null,
        ledger_tool_name: 'read_file',
        tool_execution_status: 'completed',
        tool_started_at: '2026-04-19T02:37:42.662Z',
        tool_completed_at: '2026-04-19T02:37:42.666Z',
        tool_output: { lines: 42 },
        tool_error_code: null,
        tool_error_message: null,
        child_run_id: null,
        child_run_status: null,
        child_error_code: null,
        child_error_message: null,
        child_run_result: null,
      },
      {
        session_id: 'sess-1',
        root_run_id: 'root-1',
        run_id: 'root-1',
        parent_run_id: null,
        parent_step_id: null,
        run_delegate_name: null,
        delegation_depth: 0,
        run_status: 'succeeded',
        current_step_id: 'step-1',
        current_child_run_id: null,
        goal: null,
        run_error_code: null,
        run_error_message: null,
        run_created_at: now(),
        run_updated_at: now(),
        run_completed_at: now(),
        event_id: 'event-3',
        event_seq: 3,
        event_created_at: '2026-04-19T02:37:42.667Z',
        event_type: 'step.completed',
        event_step_id: 'step-1',
        tool_call_id: null,
        payload: { toolName: 'read_file' },
        event_tool_name: 'read_file',
        resolved_input: null,
        ledger_tool_name: null,
        tool_execution_status: null,
        tool_started_at: null,
        tool_completed_at: null,
        tool_output: null,
        tool_error_code: null,
        tool_error_message: null,
        child_run_id: null,
        child_run_status: null,
        child_error_code: null,
        child_error_message: null,
        child_run_result: null,
      },
    ]);

    const output = renderTraceReport(
      {
        target: traceTarget('session', 'sess-1'),
        session: { ...session('succeeded'), createdAt: '2026-04-01T00:00:00.000Z' },
        rootRuns: [],
        usage: usage(),
        timeline,
        llmMessages: [],
        delegates: [],
        plans: [],
        warnings: [],
        summary: { status: 'succeeded', reason: 'ok' },
      },
      { json: false, includePlans: false, onlyDelegates: false, messages: false, systemOnly: false },
    );

    const lines = output.split('\n');
    const titleIndex = lines.findIndex((line) => line.includes('Tool Timeline: 2026-04-19 02:37:42.662'));
    expect(titleIndex).toBeGreaterThanOrEqual(0);
    expect(lines[titleIndex + 1]).toContain('started-time');
    expect(lines[titleIndex + 1]).toContain('duration');
    expect(lines.find((line) => line.includes('read_file'))).toContain('02:37:42.662');
    expect(lines.find((line) => line.includes('step.completed'))).toContain('{ "lines": 42 }');
  });

  it('renders session duration and markdown-style section headers in the human report', () => {
    const timeline = buildTimeline([
      {
        session_id: 'sess-1',
        root_run_id: 'root-1',
        run_id: 'root-1',
        parent_run_id: null,
        parent_step_id: null,
        run_delegate_name: null,
        delegation_depth: 0,
        run_status: 'succeeded',
        current_step_id: 'step-1',
        current_child_run_id: null,
        goal: null,
        run_error_code: null,
        run_error_message: null,
        run_created_at: now(),
        run_updated_at: now(),
        run_completed_at: now(),
        event_id: 'event-1',
        event_seq: 1,
        event_created_at: '2026-04-19T02:37:42.662Z',
        event_type: 'tool.completed',
        event_step_id: 'step-1',
        tool_call_id: 'call-1',
        payload: { toolName: 'read_file', input: { path: 'README.md' } },
        event_tool_name: 'read_file',
        resolved_input: { path: 'README.md' },
        ledger_tool_name: 'read_file',
        tool_execution_status: 'completed',
        tool_started_at: '2026-04-19T02:37:42.662Z',
        tool_completed_at: '2026-04-19T02:37:45.162Z',
        tool_output: { lines: 42 },
        tool_error_code: null,
        tool_error_message: null,
        child_run_id: null,
        child_run_status: null,
        child_error_code: null,
        child_error_message: null,
        child_run_result: null,
      },
    ]);

    const output = renderTraceReport(
      {
        target: traceTarget('session', 'sess-1'),
        session: { ...session('succeeded'), createdAt: '2026-04-16T10:00:00.000Z', updatedAt: '2026-04-16T10:00:02.500Z' },
        rootRuns: [{
          rootRunId: 'root-1',
          runId: 'root-1',
          invocationKind: 'run',
          turnIndex: 0,
          linkedAt: now(),
          startedAt: '2026-04-16T10:00:01.000Z',
          updatedAt: '2026-04-16T10:00:11.000Z',
          completedAt: '2026-04-16T10:00:11.000Z',
          status: 'succeeded',
          goal: 'Trace headers',
          result: 'Done',
          modelProvider: 'mesh',
          modelName: 'qwen/qwen3.5-27b',
        }],
        usage: usage(),
        timeline,
        milestones: [{
          rootRunId: 'root-1',
          runId: 'root-1',
          depth: 0,
          eventType: 'tool.completed',
          stepId: 'step-1',
          createdAt: '2026-04-19T02:37:45.162Z',
          eventSeq: 1,
          text: 'tool.completed root-1 step-1',
        }],
        llmMessages: [],
        delegates: [],
        plans: [],
        warnings: [],
        summary: { status: 'succeeded', reason: 'ok' },
      },
      { json: false, includePlans: false, onlyDelegates: false, messages: false, systemOnly: false },
    );

    expect(output).toContain('session duration');
    expect(output).toContain('provider');
    expect(output).toContain('mesh');
    expect(output).toContain('model');
    expect(output).toContain('qwen/qwen3.5-27b');
    expect(output).toContain('10.00s');
    const lines = output.split('\n');
    const goalLine = lines.find((line) => stripAnsi(line) === '# Goal');
    expect(goalLine).toBeDefined();
    for (const title of ['Root Runs', 'Milestones']) {
      const line = lines.find((candidate) => stripAnsi(candidate) === `# ${title}`);
      expect(line?.replace(title, 'Goal')).toBe(goalLine);
    }
    const timelineLine = lines.find((line) => stripAnsi(line).startsWith('# Tool Timeline:'));
    expect(timelineLine?.replace(/Tool Timeline:.*/, 'Goal')).toBe(goalLine);
  });

  it('renders only the final root-run result in the output view', () => {
    const output = renderTraceReport(
      {
        target: traceTarget('session', 'sess-1'),
        session: session('succeeded'),
        rootRuns: [{
          rootRunId: 'root-1',
          runId: 'root-1',
          invocationKind: 'run',
          turnIndex: 0,
          linkedAt: now(),
          startedAt: '2026-04-16T10:00:00.000Z',
          updatedAt: '2026-04-16T10:00:03.000Z',
          completedAt: '2026-04-16T10:00:03.000Z',
          status: 'succeeded',
          goal: 'Measure performance',
          result: { answer: 'Done' },
        }],
        usage: usage(),
        timeline: [],
        llmMessages: [],
        delegates: [],
        plans: [],
        warnings: [],
        summary: { status: 'succeeded', reason: 'ok' },
      },
      { json: false, includePlans: false, onlyDelegates: false, messages: false, systemOnly: false, view: 'output' },
    );

    expect(output).toContain('"answer": "Done"');
    expect(output).not.toContain('Trace Brief');
    expect(output).not.toContain('# Goal');
    expect(output).not.toContain('Final Output');
  });

  it('prints JSON as machine-readable report output', () => {
    const output = renderTraceReport(
      {
        target: traceTarget('session', 'sess-1'),
        session: session('succeeded'),
        rootRuns: [{
          rootRunId: 'root-1',
          runId: 'root-1',
          invocationKind: 'run',
          turnIndex: 0,
          linkedAt: now(),
          startedAt: '2026-04-16T10:00:00.000Z',
          updatedAt: '2026-04-16T10:00:03.000Z',
          completedAt: '2026-04-16T10:00:03.000Z',
          status: 'succeeded',
          goal: 'Measure performance',
          result: 'Done',
        }],
        usage: usage(),
        timeline: [],
        llmMessages: [],
        delegates: [],
        plans: [],
        warnings: ['historical data'],
        summary: { status: 'unknown', reason: 'not enough data' },
      },
      { json: true, includePlans: false, onlyDelegates: false, messages: false, systemOnly: false },
    );

    const parsed = JSON.parse(output);
    expect(parsed.warnings).toEqual(['historical data']);
    expect(parsed.usage.total.totalTokens).toBe(0);
  });

  it('renders provider and model for direct root-run traces', () => {
    const output = renderTraceReport(
      {
        target: traceTarget('root-run', 'root-1', 'root-1'),
        session: null,
        rootRuns: [{
          rootRunId: 'root-1',
          runId: 'root-1',
          invocationKind: 'run',
          turnIndex: null,
          linkedAt: now(),
          status: 'succeeded',
          goal: 'Trace a root run',
          result: 'Done',
          modelProvider: 'mesh',
          modelName: 'qwen/qwen3.5-27b',
        }],
        usage: usage(),
        timeline: [],
        llmMessages: [],
        delegates: [],
        plans: [],
        warnings: [],
        summary: { status: 'succeeded', reason: 'ok' },
      },
      { json: false, includePlans: false, onlyDelegates: false, messages: false, systemOnly: false },
    );

    expect(output).toContain('target');
    expect(output).toContain('provider');
    expect(output).toContain('mesh');
    expect(output).toContain('model');
    expect(output).toContain('qwen/qwen3.5-27b');
  });

  it('renders aggregated usage in the human report', () => {
    const output = renderTraceReport(
      {
        target: traceTarget('session', 'sess-1'),
        session: session('succeeded'),
        rootRuns: [{
          rootRunId: 'root-1',
          runId: 'root-1',
          invocationKind: 'run',
          turnIndex: 0,
          linkedAt: now(),
          status: 'succeeded',
          goal: 'Finish the task',
          result: 'Done',
        }],
        usage: usage({
          total: {
            promptTokens: 1200,
            completionTokens: 300,
            reasoningTokens: 40,
            totalTokens: 1540,
            estimatedCostUSD: 0.012345,
          },
          byRootRun: [{
            rootRunId: 'root-1',
            usage: {
              promptTokens: 1200,
              completionTokens: 300,
              reasoningTokens: 40,
              totalTokens: 1540,
              estimatedCostUSD: 0.012345,
            },
          }],
        }),
        timeline: [],
        llmMessages: [],
        delegates: [],
        plans: [],
        warnings: [],
        summary: { status: 'succeeded', reason: 'ok' },
      },
      { json: false, includePlans: false, onlyDelegates: false, messages: false, systemOnly: false },
    );

    expect(output).toContain('usage');
    expect(output).toContain('prompt=1,200');
    expect(output).toContain('completion=300');
    expect(output).toContain('reasoning=40');
    expect(output).toContain('total=1,540');
    expect(output).toContain('cost=$0.012345');
    expect(output).toContain('root run');
    expect(output).toContain('status');
    expect(output).toContain('root-1');
    expect(output).toContain('succeeded');
    expect(output).not.toContain('Root Runs');
  });

  it('summarizes and renders persisted performance metrics', () => {
    const performance = summarizePerformance([
      traceRow({
        event_id: 'model-start',
        event_seq: 1,
        event_type: 'model.started',
        payload: {
          performance: {
            requestBytes: 2048,
            eventPayloadBytes: 100,
          },
        },
      }),
      traceRow({
        event_id: 'model-done',
        event_seq: 2,
        event_type: 'model.completed',
        payload: {
          performance: {
            responseBytes: 1024,
            durationMs: 2500,
            pendingToolCallCount: 1,
            adapter: {
              adapterResponseLatencyMs: 2300,
              adapterRequestBytes: 4096,
              adapterResponseBytes: 2048,
              adapterAttemptCount: 2,
              adapterStatusCode: 200,
            },
          },
        },
      }),
      traceRow({
        event_id: 'tool-done',
        event_seq: 3,
        event_type: 'tool.completed',
        event_tool_name: 'read_file',
        ledger_tool_name: 'read_file',
        payload: {
          toolName: 'read_file',
          performance: {
            durationMs: 12,
            inputBytes: 32,
            rawOutputBytes: 4096,
            eventOutputBytes: 128,
            modelOutputBytes: 4096,
          },
        },
      }),
      traceRow({
        event_id: 'snapshot',
        event_seq: 4,
        event_type: 'snapshot.created',
        payload: {
          performance: {
            stateBytes: 8192,
            messageBytes: 4096,
            messageCount: 8,
            saveDurationMs: 5,
          },
        },
      }),
    ]);

    expect(performance.model.requestBytes.total).toBe(2048);
    expect(performance.model.adapterStatusCodes).toEqual({ '200': 1 });
    expect(performance.tools.byTool[0]).toMatchObject({
      toolName: 'read_file',
      completed: 1,
    });
    expect(performance.snapshots.stateBytes.total).toBe(8192);

    const output = renderTraceReport(
      {
        target: traceTarget('session', 'sess-1'),
        session: session('succeeded'),
        rootRuns: [{
          rootRunId: 'root-1',
          runId: 'root-1',
          invocationKind: 'run',
          turnIndex: 0,
          linkedAt: now(),
          startedAt: '2026-04-16T10:00:00.000Z',
          updatedAt: '2026-04-16T10:00:03.000Z',
          completedAt: '2026-04-16T10:00:03.000Z',
          status: 'succeeded',
          goal: 'Measure performance',
          result: 'Done',
        }],
        usage: usage({
          total: {
            promptTokens: 120,
            completionTokens: 30,
            totalTokens: 150,
            estimatedCostUSD: 0.0042,
          },
          byRootRun: [{
            rootRunId: 'root-1',
            usage: {
              promptTokens: 120,
              completionTokens: 30,
              totalTokens: 150,
              estimatedCostUSD: 0.0042,
            },
          }],
        }),
        performance,
        timeline: [],
        llmMessages: [],
        delegates: [],
        plans: [],
        warnings: [],
        summary: { status: 'succeeded', reason: 'ok' },
      },
      { json: false, includePlans: false, onlyDelegates: false, messages: false, systemOnly: false, view: 'performance' },
    );

    expect(output).toContain('Performance');
    expect(output).toContain('Usage');
    expect(output).toContain('Run Usage by Root Run');
    expect(output).toContain('root run');
    expect(output).toContain('status');
    expect(output).toContain('succeeded');
    expect(output).toContain('tokens');
    expect(output).toContain('root-1');
    expect(output).toContain('150');
    expect(output).toContain('model');
    expect(output).toContain('adapter status');
    expect(output).toContain('200:1');
    expect(output).toContain('read_file');
    expect(output).toContain('Notes');
    expect(output).toContain('raw output');
    expect(output).toContain('Duration split:');
    expect(output).toContain('total=3.00s');
    expect(output).toContain('model=2.50s');
    expect(output).toContain('tools=12ms');
    expect(output).toContain('snapshot save=5ms');
    expect(output).toContain('other=483ms');
  });

  it('builds diagnostics and renders brief, investigation, and policy views', () => {
    const rows = [
      traceRow({
        event_id: 'model-failed',
        event_seq: 1,
        event_type: 'model.failed',
        payload: { performance: { durationMs: 12000 } },
      }),
      traceRow({
        event_id: 'budget-search',
        event_seq: 2,
        event_type: 'tool.completed',
        event_step_id: 'step-2',
        tool_call_id: 'call-search',
        event_tool_name: 'web_search',
        ledger_tool_name: 'web_search',
        tool_execution_status: 'completed',
        tool_started_at: '2026-04-16T10:00:01.000Z',
        tool_completed_at: '2026-04-16T10:00:01.000Z',
        resolved_input: { query: 'extra search' },
        tool_output: {
          reason: 'budget_exhausted',
          budgetGroup: 'web_research.search',
          status: 'partial',
        },
        payload: {
          toolName: 'web_search',
          output: {
            reason: 'budget_exhausted',
            budgetGroup: 'web_research.search',
            status: 'partial',
          },
          performance: { durationMs: 0, modelOutputBytes: 96 },
        },
      }),
      traceRow({
        event_id: 'read-failed',
        event_seq: 3,
        event_type: 'tool.failed',
        event_step_id: 'step-3',
        tool_call_id: 'call-read',
        event_tool_name: 'read_web_page',
        ledger_tool_name: 'read_web_page',
        tool_execution_status: 'failed',
        tool_started_at: '2026-04-16T10:00:02.000Z',
        tool_completed_at: '2026-04-16T10:00:03.500Z',
        resolved_input: { url: 'https://example.com' },
        tool_error_message: 'request timed out',
        payload: { toolName: 'read_web_page', performance: { durationMs: 1500 } },
      }),
    ];
    const performance = summarizePerformance(rows);
    const timeline = buildTimeline(rows);
    const report = {
      target: traceTarget('session', 'sess-1'),
      session: session('failed'),
      rootRuns: [{
        rootRunId: 'root-1',
        runId: 'root-1',
        invocationKind: 'run',
        turnIndex: 0,
        linkedAt: '2026-04-16T10:00:00.000Z',
        startedAt: '2026-04-16T10:00:00.000Z',
        updatedAt: '2026-04-16T10:00:05.000Z',
        completedAt: '2026-04-16T10:00:05.000Z',
        status: 'failed',
        goal: 'Diagnose a research run',
        result: null,
        errorMessage: 'Model timed out',
      }],
      usage: usage({
        total: {
          promptTokens: 900,
          completionTokens: 100,
          totalTokens: 1000,
          estimatedCostUSD: 0.01,
        },
        byRootRun: [{
          rootRunId: 'root-1',
          usage: {
            promptTokens: 900,
            completionTokens: 100,
            totalTokens: 1000,
            estimatedCostUSD: 0.01,
          },
        }],
      }),
      performance,
      timeline,
      milestones: [
        {
          rootRunId: 'root-1',
          runId: 'root-1',
          depth: 0,
          eventType: 'model.tool_call_rejected' as const,
          stepId: 'step-4',
          createdAt: now(),
          eventSeq: 4,
          text: 'model.tool_call_rejected requested bad_tool',
        },
        {
          rootRunId: 'root-1',
          runId: 'root-1',
          depth: 0,
          eventType: 'approval.requested' as const,
          stepId: 'step-5',
          createdAt: now(),
          eventSeq: 5,
          text: 'approval requested',
        },
      ],
      llmMessages: [{
        rootRunId: 'root-1',
        runId: 'root-1',
        delegateName: null,
        depth: 0,
        initialSnapshotSeq: 1,
        initialSnapshotCreatedAt: now(),
        latestSnapshotSeq: 2,
        latestSnapshotCreatedAt: now(),
        effectiveMessages: [{
          position: 0,
          persistence: 'pending' as const,
          role: 'user' as const,
          category: 'runtime-injected-user' as const,
          content: 'You are near the web research budget.',
        }],
      }],
      delegates: [delegate({ child_status: 'failed', child_error_message: 'delegate timed out' })],
      plans: [],
      warnings: [],
      summary: { status: 'failed' as const, reason: 'failed because delegate analyst failed: delegate timed out' },
    };

    const diagnostics = buildTraceDiagnostics(report);
    expect(diagnostics.brief.status).toBe('failed');
    expect(diagnostics.policy).toMatchObject({
      budgetExhaustedToolCalls: 1,
      rejectedToolCalls: 1,
      approvalRequests: 1,
      unresolvedApprovalRequests: 1,
      runtimePolicyMessages: 1,
    });
    expect(diagnostics.policy.budgetGroups[0]).toMatchObject({
      budgetGroup: 'web_research.search',
      skippedCalls: 1,
      toolNames: ['web_search'],
    });
    expect(diagnostics.findings.map((finding) => finding.category)).toEqual(expect.arrayContaining(['failure', 'policy', 'performance']));

    const brief = renderTraceReport({ ...report, diagnostics }, { json: false, includePlans: false, onlyDelegates: false, messages: false, systemOnly: false, view: 'brief' });
    expect(brief).toContain('Trace Brief');
    expect(brief).toContain('Top findings');
    expect(brief).not.toContain('Goal');

    const investigation = renderTraceReport({ ...report, diagnostics }, { json: false, includePlans: false, onlyDelegates: false, messages: false, systemOnly: false, view: 'investigate' });
    expect(investigation).toContain('Investigation');
    expect(investigation).toContain('Delegate chain evidence');
    expect(investigation).toContain('Suggested next views');
    expect(investigation).toContain('1. ERROR failure Trace failed');
    expect(investigation).toContain('Evidence');
    expect(investigation).toContain('$ trace-session --run child-run --view messages --messages-view delta');
    expect(investigation).not.toContain('severity  category');

    const policy = renderTraceReport({ ...report, diagnostics }, { json: false, includePlans: false, onlyDelegates: false, messages: false, systemOnly: false, view: 'policy' });
    expect(policy).toContain('Policy Adherence');
    expect(policy).toContain('web_research.search');
    expect(policy).toContain('rejected tool calls');

    const performanceOutput = renderTraceReport({ ...report, diagnostics }, { json: false, includePlans: false, onlyDelegates: false, messages: false, systemOnly: false, view: 'performance' });
    expect(performanceOutput).toContain('Digest');
    expect(performanceOutput).toContain('Top Token Runs');
    expect(performanceOutput).toContain('Slowest Tool Spans');
  });

  it('renders a self-contained static HTML report with escaped trace data', () => {
    const rows = [traceRow({
      event_id: 'tool-1',
      event_seq: 1,
      event_type: 'tool.completed',
      event_step_id: 'step-1',
      tool_call_id: 'call-1',
      event_tool_name: 'read_file',
      ledger_tool_name: 'read_file',
      tool_execution_status: 'completed',
      tool_started_at: '2026-04-16T10:00:01.000Z',
      tool_completed_at: '2026-04-16T10:00:02.000Z',
      resolved_input: { path: '<unsafe>.txt' },
      tool_output: '<script>alert(1)</script>',
      payload: {
        toolName: 'read_file',
        performance: {
          durationMs: 1000,
          rawOutputBytes: 128,
          modelOutputBytes: 64,
        },
      },
    })];
    const performance = summarizePerformance(rows);
    const report = {
      target: traceTarget('session', 'sess-1'),
      session: session('failed'),
      rootRuns: [{
        rootRunId: 'root-1',
        runId: 'root-1',
        invocationKind: 'run',
        turnIndex: 0,
        linkedAt: '2026-04-16T10:00:00.000Z',
        startedAt: '2026-04-16T10:00:00.000Z',
        updatedAt: '2026-04-16T10:00:03.000Z',
        completedAt: '2026-04-16T10:00:03.000Z',
        status: 'failed',
        goal: 'Investigate <unsafe> workflow',
        result: { answer: 'Use <safe> output' },
        errorMessage: 'Exploded <b>bad</b>',
        modelProvider: 'openai',
        modelName: 'gpt-test',
      }],
      usage: usage({
        total: {
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          estimatedCostUSD: 0.001,
        },
        byRootRun: [{
          rootRunId: 'root-1',
          usage: {
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15,
            estimatedCostUSD: 0.001,
          },
        }],
      }),
      performance,
      timeline: buildTimeline(rows),
      milestones: [],
      llmMessages: [{
        rootRunId: 'root-1',
        runId: 'root-1',
        delegateName: null,
        depth: 0,
        initialSnapshotSeq: 1,
        initialSnapshotCreatedAt: now(),
        latestSnapshotSeq: 2,
        latestSnapshotCreatedAt: now(),
        effectiveMessages: [{
          position: 0,
          persistence: 'persisted' as const,
          role: 'system' as const,
          category: 'runtime-injected-system' as const,
          content: 'System says <policy>stay safe</policy>',
        }],
      }],
      delegates: [delegate({ child_status: 'failed', child_error_message: 'delegate <timeout>' })],
      plans: [{
        root_run_id: 'root-1',
        run_id: 'root-1',
        plan_execution_id: 'plan-exec-1',
        plan_execution_status: 'running',
        attempt: 1,
        current_step_id: 'step-1',
        current_step_index: 0,
        replan_reason: 'Need <more evidence>',
        plan_id: 'plan-1',
        plan_goal: 'Investigate unsafe workflow',
        plan_summary: null,
        step_index: 0,
        step_key: 'inspect',
        title: 'Inspect <unsafe> file',
        tool_name: 'read_file',
        failure_policy: null,
        requires_approval: false,
      }],
      warnings: ['warning <check>'],
      summary: { status: 'failed' as const, reason: 'failed because <bad>' },
    };

    const html = renderTraceHtml(report, {
      includePlans: true,
      messages: true,
      generatedAt: '2026-04-16T11:00:00.000Z',
    });

    expect(html).toContain('<!doctype html>');
    expect(html).toContain('Adaptive Agent Trace Report');
    expect(html).toContain('Trace Brief');
    expect(html).toContain('Findings');
    expect(html).toContain('Policy Adherence');
    expect(html).toContain('Performance');
    expect(html).toContain('Workflow');
    expect(html).toContain('LLM Message Context');
    expect(html).not.toContain('#plans');
    expect(html).not.toContain('>Plans<');
    expect(html).toContain('Raw Trace JSON');
    expect(html).toContain('read_file');
    expect(html).toContain('&lt;unsafe&gt;');
    expect(html).toContain('&lt;b&gt;bad&lt;/b&gt;');
    expect(html).toContain('&lt;policy&gt;stay safe&lt;/policy&gt;');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<unsafe>');
    expect(html).not.toContain('<b>bad</b>');
    expect(html).not.toContain('<policy>stay safe</policy>');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('counts tool calls by durable execution status instead of terminal lifecycle events', () => {
    const performance = summarizePerformance([
      traceRow({
        event_id: 'tool-start-1',
        event_seq: 1,
        event_type: 'tool.started',
        tool_call_id: 'call-1',
        event_tool_name: 'web_search',
        ledger_tool_name: 'web_search',
        tool_execution_status: 'completed',
        tool_started_at: '2026-04-16T10:00:00.000Z',
        payload: { toolName: 'web_search' },
      }),
      traceRow({
        event_id: 'tool-failed-1',
        event_seq: 2,
        event_type: 'tool.failed',
        tool_call_id: 'call-1',
        event_tool_name: 'web_search',
        ledger_tool_name: 'web_search',
        tool_execution_status: 'completed',
        tool_started_at: '2026-04-16T10:00:00.000Z',
        tool_completed_at: '2026-04-16T10:00:01.000Z',
        payload: {
          toolName: 'web_search',
          performance: {
            durationMs: 1000,
            rawOutputBytes: 128,
            modelOutputBytes: 64,
          },
        },
      }),
      traceRow({
        event_id: 'tool-completed-1',
        event_seq: 3,
        event_type: 'tool.completed',
        tool_call_id: 'call-1',
        event_tool_name: 'web_search',
        ledger_tool_name: 'web_search',
        tool_execution_status: 'completed',
        tool_started_at: '2026-04-16T10:00:00.000Z',
        tool_completed_at: '2026-04-16T10:00:01.000Z',
        payload: {
          toolName: 'web_search',
          performance: {
            durationMs: 1000,
            rawOutputBytes: 128,
            modelOutputBytes: 64,
          },
        },
      }),
      traceRow({
        event_id: 'tool-failed-2',
        event_seq: 4,
        event_type: 'tool.failed',
        tool_call_id: 'call-2',
        event_tool_name: 'read_web_page',
        ledger_tool_name: 'read_web_page',
        tool_execution_status: 'failed',
        tool_started_at: '2026-04-16T10:00:02.000Z',
        tool_completed_at: '2026-04-16T10:00:03.000Z',
        payload: { toolName: 'read_web_page', performance: { durationMs: 1000 } },
      }),
      traceRow({
        event_id: 'tool-completed-3',
        event_seq: 5,
        event_type: 'tool.completed',
        tool_call_id: 'call-3',
        event_tool_name: 'write_file',
        ledger_tool_name: 'write_file',
        tool_execution_status: 'completed',
        tool_started_at: '2026-04-16T10:00:04.000Z',
        tool_completed_at: '2026-04-16T10:00:05.000Z',
        payload: { toolName: 'write_file', performance: { durationMs: 1000 } },
      }),
    ]);

    expect(performance.tools).toMatchObject({
      started: 3,
      completed: 2,
      failed: 1,
    });
    expect(performance.tools.byTool.find((tool) => tool.toolName === 'web_search')).toMatchObject({
      started: 1,
      completed: 1,
      failed: 0,
    });
    expect(performance.tools.durationMs.count).toBe(4);
  });

  it('renders the effective LLM message context and classifies system messages', () => {
    const output = renderTraceReport(
      {
        target: traceTarget('session', 'sess-1'),
        session: session('succeeded'),
        rootRuns: [{
          rootRunId: 'root-1',
          runId: 'root-1',
          invocationKind: 'chat',
          turnIndex: 1,
          linkedAt: now(),
          status: 'succeeded',
          goal: 'Investigate the prompt stack',
          result: 'Done',
        }],
        usage: usage(),
        timeline: [],
        llmMessages: [{
          rootRunId: 'root-1',
          runId: 'root-1',
          delegateName: null,
          depth: 0,
          initialSnapshotSeq: 1,
          initialSnapshotCreatedAt: now(),
          latestSnapshotSeq: 3,
          latestSnapshotCreatedAt: now(),
          effectiveMessages: [
            {
              position: 0,
              persistence: 'persisted',
              role: 'system',
              category: 'initial-runtime-system',
              content: 'You are AdaptiveAgent.',
            },
            {
              position: 1,
              persistence: 'persisted',
              role: 'system',
              category: 'gateway-chat-system-context',
              content: 'Conversation summary:\nUser asked for help.',
            },
            {
              position: 2,
              persistence: 'persisted',
              role: 'user',
              category: 'user',
              content: 'Show me the prompt.',
            },
            {
              position: 3,
              persistence: 'pending',
              role: 'user',
              category: 'runtime-injected-user',
              content: 'You are near the web research budget.',
            },
          ],
        }],
        delegates: [],
        plans: [],
        warnings: [],
        totalSteps: 4,
        summary: { status: 'succeeded', reason: 'ok' },
      },
      { json: false, includePlans: false, onlyDelegates: false, messages: true, systemOnly: false },
    );

    expect(output).toContain('LLM Message Context');
    expect(output).toContain('initial-runtime-system');
    expect(output).toContain('gateway-chat-system-context');
    expect(output).toContain('runtime-injected-user');
    expect(output).toContain('Show me the prompt.');
  });

  it('renders message deltas when requested', () => {
    const output = renderTraceReport(
      {
        target: traceTarget('session', 'sess-1'),
        session: session('succeeded'),
        rootRuns: [],
        usage: usage(),
        timeline: [],
        llmMessages: [{
          rootRunId: 'root-1',
          runId: 'run-2',
          delegateName: 'analyst',
          depth: 1,
          initialSnapshotSeq: 1,
          initialSnapshotCreatedAt: now(),
          latestSnapshotSeq: 2,
          latestSnapshotCreatedAt: now(),
          initialMessages: [{
            position: 0,
            persistence: 'persisted',
            role: 'system',
            category: 'initial-runtime-system',
            content: 'You are AdaptiveAgent.',
          }],
          effectiveMessages: [
            {
              position: 0,
              persistence: 'persisted',
              role: 'system',
              category: 'initial-runtime-system',
              content: 'You are AdaptiveAgent.',
            },
            {
              position: 1,
              persistence: 'persisted',
              role: 'user',
              category: 'runtime-injected-user',
              content: 'Use a short purpose before each web search.',
            },
            {
              position: 2,
              persistence: 'pending',
              role: 'assistant',
              category: 'assistant',
              content: 'Preparing a clarification.',
            },
          ],
        }],
        delegates: [],
        plans: [],
        warnings: [],
        summary: { status: 'succeeded', reason: 'ok' },
      },
      { json: false, includePlans: false, onlyDelegates: false, messages: true, systemOnly: false, messagesView: 'delta' },
    );

    expect(output).toContain('delta: added=1 changed=0 pending=1');
    expect(output).toContain('runtime-injected-user');
    expect(output).toContain('Preparing a clarification.');
  });

  it('filters LLM messages down to system messages when --system-only is used', () => {
    const output = renderTraceReport(
      {
        target: traceTarget('session', 'sess-1'),
        session: session('succeeded'),
        rootRuns: [],
        usage: usage(),
        timeline: [],
        llmMessages: [{
          rootRunId: 'root-1',
          runId: 'root-1',
          delegateName: null,
          depth: 0,
          initialSnapshotSeq: 1,
          initialSnapshotCreatedAt: now(),
          latestSnapshotSeq: 2,
          latestSnapshotCreatedAt: now(),
          effectiveMessages: [
            {
              position: 0,
              persistence: 'persisted',
              role: 'system',
              category: 'initial-runtime-system',
              content: 'You are AdaptiveAgent.',
            },
            {
              position: 1,
              persistence: 'persisted',
              role: 'assistant',
              category: 'assistant',
              content: 'Intermediate answer.',
            },
          ],
        }],
        delegates: [],
        plans: [],
        warnings: [],
        summary: { status: 'unknown', reason: 'n/a' },
      },
      { json: false, includePlans: false, onlyDelegates: false, messages: true, systemOnly: true },
    );

    expect(output).toContain('LLM System Messages');
    expect(output).toContain('You are AdaptiveAgent.');
    expect(output).not.toContain('Intermediate answer.');
  });

  it('loads snapshot-backed LLM messages when message inspection is requested', async () => {
    const client = {
      query: async <TRow extends Record<string, unknown>>(sql: string, params?: unknown[]) => {
        if (sql.includes('from gateway_sessions') && sql.includes('where id = $1')) {
          return {
            rows: [{
              id: 'sess-msg',
              channel_id: 'web',
              agent_id: 'research-agent',
              invocation_mode: 'chat',
              status: 'succeeded',
              current_run_id: null,
              current_root_run_id: 'root-msg',
              last_completed_root_run_id: 'root-msg',
              created_at: now(),
              updated_at: now(),
            }],
          } as unknown as { rows: TRow[] };
        }

        if (sql.includes('select to_regclass')) {
          return { rows: [{ exists: false }] } as unknown as { rows: TRow[] };
        }

        if (sql.includes('from information_schema.columns')) {
          return { rows: [{ count: '3' }] } as unknown as { rows: TRow[] };
        }

        if (sql.includes('from information_schema.tables')) {
          return { rows: [{ count: '2' }] } as unknown as { rows: TRow[] };
        }

        if (sql.includes('select l.root_run_id') && sql.includes('from gateway_session_run_links l')) {
          return { rows: [] } as unknown as { rows: TRow[] };
        }

        if (sql.includes('from agent_runs r') && sql.includes("r.context ->> 'sessionId' = $1")) {
          return { rows: [{ root_run_id: 'root-msg' }] } as unknown as { rows: TRow[] };
        }

        if (sql.includes('with requested_roots as')) {
          return {
            rows: [{
              root_run_id: 'root-msg',
              run_id: 'root-msg',
              invocation_kind: 'chat',
              turn_index: 1,
              linked_at: now(),
              status: 'succeeded',
              goal: 'Inspect messages',
              result: 'ok',
            }],
          } as unknown as { rows: TRow[] };
        }

        if (sql.includes('run_usage_by_root as')) {
          return {
            rows: [{
              root_run_id: 'root-msg',
              total_prompt_tokens: '1',
              total_completion_tokens: '1',
              total_reasoning_tokens: '0',
              estimated_cost_usd: '0',
            }],
          } as unknown as { rows: TRow[] };
        }

        if (sql.includes('attributed_usage as') || sql.includes('attributed_tool_usage as')) {
          expect(params).toEqual([['root-msg']]);
          return { rows: [] } as unknown as { rows: TRow[] };
        }

        if (sql.includes('initial_snapshot.snapshot_seq') && sql.includes('latest_snapshot.snapshot_seq')) {
          expect(params).toEqual([['root-msg']]);
          return {
            rows: [{
              root_run_id: 'root-msg',
              run_id: 'root-msg',
              run_delegate_name: null,
              delegation_depth: 0,
              initial_snapshot_seq: 1,
              initial_snapshot_created_at: now(),
              initial_snapshot_state: {
                messages: [
                  { role: 'system', content: 'You are AdaptiveAgent.' },
                  { role: 'system', content: 'Conversation summary:\nEarlier turn.' },
                ],
              },
              latest_snapshot_seq: 2,
              latest_snapshot_created_at: now(),
              latest_snapshot_state: {
                messages: [
                  { role: 'system', content: 'You are AdaptiveAgent.' },
                  { role: 'system', content: 'Conversation summary:\nEarlier turn.' },
                  { role: 'assistant', content: 'Working...' },
                ],
                pendingRuntimeMessages: [
                  { role: 'user', content: 'Future web_search calls should include a short purpose.' },
                ],
              },
            }],
          } as unknown as { rows: TRow[] };
        }

        if (sql.includes('left join agent_events e on e.run_id = rt.run_id')) {
          return { rows: [] } as unknown as { rows: TRow[] };
        }

        if (sql.includes('from unnest($1::text[]) as roots(root_run_id)')) {
          return { rows: [] } as unknown as { rows: TRow[] };
        }

        throw new Error(`Unexpected SQL in test:\n${sql}`);
      },
    };

    const report = await traceSession(client as never, {
      sessionId: 'sess-msg',
      json: false,
      listSessions: false,
      listPerformance: false,
      listSessionless: false,
      deleteEmptyGoalSessions: false,
      usageOnly: false,
      includePlans: false,
      onlyDelegates: false,
      messages: true,
      systemOnly: true,
      help: false,
    });

    expect(report.llmMessages).toHaveLength(1);
    expect(report.target).toEqual(traceTarget('session', 'sess-msg'));
    expect(report.llmMessages[0]).toEqual(
      expect.objectContaining({
        rootRunId: 'root-msg',
        runId: 'root-msg',
        effectiveMessages: expect.arrayContaining([
          expect.objectContaining({ category: 'initial-runtime-system', content: 'You are AdaptiveAgent.' }),
          expect.objectContaining({ category: 'gateway-chat-system-context', content: 'Conversation summary:\nEarlier turn.' }),
          expect.objectContaining({
            category: 'runtime-injected-user',
            persistence: 'pending',
            content: 'Future web_search calls should include a short purpose.',
          }),
        ]),
      }),
    );
  });

  it('traces a standalone run id by resolving its root run id', async () => {
    const client = {
      query: async <TRow extends Record<string, unknown>>(sql: string, params?: unknown[]) => {
        if (sql.includes('select to_regclass')) {
          return { rows: [{ exists: false }] } as unknown as { rows: TRow[] };
        }

        if (sql.includes('from information_schema.columns')) {
          return { rows: [{ count: '3' }] } as unknown as { rows: TRow[] };
        }

        if (sql.includes('from information_schema.tables')) {
          return { rows: [{ count: '2' }] } as unknown as { rows: TRow[] };
        }

        if (sql.includes('from agent_runs') && sql.includes('where id = $1') && sql.includes('root_run_id::text as root_run_id')) {
          expect(params).toEqual(['child-run-1']);
          return { rows: [{ root_run_id: 'root-standalone' }] } as unknown as { rows: TRow[] };
        }

        if (sql.includes('with requested_roots as')) {
          expect(params).toEqual([undefined, ['root-standalone']]);
          return {
            rows: [{
              root_run_id: 'root-standalone',
              run_id: 'root-standalone',
              invocation_kind: 'run',
              turn_index: null,
              linked_at: now(),
              status: 'succeeded',
              goal: 'Standalone run goal',
              result: 'Standalone output',
            }],
          } as unknown as { rows: TRow[] };
        }

        if (sql.includes('run_usage_by_root as')) {
          expect(params).toEqual([['root-standalone']]);
          return {
            rows: [{
              root_run_id: 'root-standalone',
              total_prompt_tokens: '9',
              total_completion_tokens: '4',
              total_reasoning_tokens: '0',
              estimated_cost_usd: '0.002',
            }],
          } as unknown as { rows: TRow[] };
        }

        if (sql.includes('attributed_usage as') || sql.includes('attributed_tool_usage as')) {
          expect(params).toEqual([['root-standalone']]);
          return { rows: [] } as unknown as { rows: TRow[] };
        }

        if (sql.includes('left join agent_events e on e.run_id = rt.run_id')) {
          expect(params).toEqual([['root-standalone'], 'child-run-1']);
          return { rows: [] } as unknown as { rows: TRow[] };
        }

        if (sql.includes('initial_snapshot.snapshot_seq') && sql.includes('latest_snapshot.snapshot_seq')) {
          expect(params).toEqual([['root-standalone']]);
          return { rows: [] } as unknown as { rows: TRow[] };
        }

        if (sql.includes('latest_snapshot.snapshot_seq as latest_snapshot_seq') && sql.includes('from run_snapshots rs')) {
          expect(params).toEqual([['root-standalone']]);
          return { rows: [] } as unknown as { rows: TRow[] };
        }

        if (sql.includes('from unnest($1::text[]) as roots(root_run_id)')) {
          expect(params).toEqual([['root-standalone']]);
          return { rows: [] } as unknown as { rows: TRow[] };
        }

        throw new Error(`Unexpected SQL in test:\n${sql}`);
      },
    };

    const report = await traceSession(client as never, {
      runId: 'child-run-1',
      json: false,
      listSessions: false,
      listPerformance: false,
      listSessionless: false,
      deleteEmptyGoalSessions: false,
      usageOnly: false,
      includePlans: false,
      onlyDelegates: false,
      messages: false,
      systemOnly: false,
      help: false,
    });

    expect(report.target).toEqual(traceTarget('run', 'child-run-1', 'root-standalone'));
    expect(report.session).toBeNull();
    expect(report.rootRuns).toEqual([{
      rootRunId: 'root-standalone',
      runId: 'root-standalone',
      invocationKind: 'run',
      turnIndex: null,
      linkedAt: now(),
      status: 'succeeded',
      goal: 'Standalone run goal',
      result: 'Standalone output',
    }]);
    expect(report.warnings).toEqual([]);
  });

  it('falls back to the session root run ids when session run links are missing', async () => {
    const client = {
      query: async <TRow extends Record<string, unknown>>(sql: string, params?: unknown[]) => {
        if (sql.includes('from gateway_sessions') && sql.includes('where id = $1')) {
          return {
            rows: [{
              id: 'sess-fallback',
              channel_id: 'web',
              agent_id: 'research-agent',
              invocation_mode: 'run',
              status: 'failed',
              current_run_id: null,
              current_root_run_id: null,
              last_completed_root_run_id: 'root-fallback',
              created_at: now(),
              updated_at: now(),
            }],
          } as unknown as { rows: TRow[] };
        }

        if (sql.includes('select to_regclass')) {
          return { rows: [{ exists: false }] } as unknown as { rows: TRow[] };
        }

        if (sql.includes('from information_schema.columns')) {
          return { rows: [{ count: '3' }] } as unknown as { rows: TRow[] };
        }

        if (sql.includes('from information_schema.tables')) {
          return { rows: [{ count: '2' }] } as unknown as { rows: TRow[] };
        }

        if (sql.includes('select l.root_run_id') && sql.includes('from gateway_session_run_links l')) {
          return { rows: [] } as unknown as { rows: TRow[] };
        }

        if (sql.includes('from agent_runs r') && sql.includes("r.context ->> 'sessionId' = $1")) {
          return {
            rows: [{ root_run_id: 'root-fallback' }],
          } as unknown as { rows: TRow[] };
        }

        if (sql.includes('with requested_roots as')) {
          expect(params).toEqual(['sess-fallback', ['root-fallback']]);
          return {
            rows: [{
              root_run_id: 'root-fallback',
              run_id: 'root-fallback',
              invocation_kind: 'run',
              turn_index: null,
              linked_at: now(),
              status: 'succeeded',
              goal: 'Recovered root goal',
              result: 'Recovered output',
            }],
          } as unknown as { rows: TRow[] };
        }

        if (sql.includes('with recursive root_runs as') && sql.includes('left join agent_events e on e.run_id = rt.run_id')) {
          expect(params).toEqual([['root-fallback'], 'sess-fallback']);
          return {
            rows: [{
              session_id: 'sess-fallback',
              root_run_id: 'root-fallback',
              run_id: 'root-fallback',
              parent_run_id: null,
              parent_step_id: null,
              run_delegate_name: null,
              delegation_depth: 0,
              run_status: 'succeeded',
              current_step_id: 'step-1',
              current_child_run_id: null,
              goal: 'Recovered root goal',
              run_error_code: null,
              run_error_message: null,
              run_created_at: now(),
              run_updated_at: now(),
              run_completed_at: now(),
              event_id: '1',
              event_seq: 1,
              event_created_at: now(),
              event_type: 'tool.completed',
              event_step_id: 'step-1',
              tool_call_id: 'call-1',
              payload: { toolName: 'web.search', input: { q: 'test' } },
              event_tool_name: 'web.search',
              resolved_input: { q: 'test' },
              ledger_tool_name: 'web.search',
              tool_execution_status: 'succeeded',
              tool_started_at: now(),
              tool_completed_at: now(),
              tool_output: null,
              tool_error_code: null,
              tool_error_message: null,
              child_run_id: null,
              child_run_status: null,
              child_error_code: null,
              child_error_message: null,
              child_run_result: null,
            }],
          } as unknown as { rows: TRow[] };
        }

        if (sql.includes('run_usage_by_root as')) {
          expect(params).toEqual([['root-fallback']]);
          return {
            rows: [{
              root_run_id: 'root-fallback',
              total_prompt_tokens: '12',
              total_completion_tokens: '8',
              total_reasoning_tokens: '0',
              estimated_cost_usd: '0.001',
            }],
          } as unknown as { rows: TRow[] };
        }

        if (sql.includes('attributed_usage as') || sql.includes('attributed_tool_usage as')) {
          expect(params).toEqual([['root-fallback']]);
          return { rows: [] } as unknown as { rows: TRow[] };
        }

        if (sql.includes('with recursive root_runs as') && sql.includes('from unnest($1::text[]) as roots(root_run_id)')) {
          expect(params).toEqual([['root-fallback']]);
          return { rows: [] } as unknown as { rows: TRow[] };
        }

        throw new Error(`Unexpected SQL in test:\n${sql}`);
      },
    };

    const report = await traceSession(client as never, {
      sessionId: 'sess-fallback',
      json: false,
      listSessions: false,
      listPerformance: false,
      listSessionless: false,
      deleteEmptyGoalSessions: false,
      usageOnly: false,
      includePlans: false,
      onlyDelegates: false,
      messages: false,
      systemOnly: false,
      help: false,
    });

    expect(report.target).toEqual(traceTarget('session', 'sess-fallback'));
    expect(report.rootRuns).toEqual([{
      rootRunId: 'root-fallback',
      runId: 'root-fallback',
      invocationKind: 'run',
      turnIndex: null,
      linkedAt: now(),
      status: 'succeeded',
      goal: 'Recovered root goal',
      result: 'Recovered output',
    }]);
    expect(report.usage.byRootRun).toEqual([{
      rootRunId: 'root-fallback',
      usage: {
        promptTokens: 12,
        completionTokens: 8,
        totalTokens: 20,
        estimatedCostUSD: 0.001,
      },
    }]);
    expect(report.timeline).toEqual([expect.objectContaining({
      rootRunId: 'root-fallback',
      runId: 'root-fallback',
      toolName: 'web.search',
      toolCallId: 'call-1',
      outcome: 'succeeded',
    })]);
    expect(report.summary).toEqual({
      status: 'succeeded',
      reason: 'succeeded because all linked root runs completed successfully',
    });
  });

  it('traces agent_runs.session_id roots when the gateway session row is missing', async () => {
    const client = {
      query: async <TRow extends Record<string, unknown>>(sql: string, params?: unknown[]) => {
        if (sql.includes('from gateway_sessions') && sql.includes('where id = $1')) {
          expect(params).toEqual(['swarm-session-1']);
          return { rows: [] } as unknown as { rows: TRow[] };
        }

        if (sql.includes('select to_regclass')) {
          return { rows: [{ exists: false }] } as unknown as { rows: TRow[] };
        }

        if (sql.includes('from information_schema.columns')) {
          return { rows: [{ count: '3' }] } as unknown as { rows: TRow[] };
        }

        if (sql.includes('from information_schema.tables')) {
          return { rows: [{ count: '2' }] } as unknown as { rows: TRow[] };
        }

        if (sql.includes('select l.root_run_id') && sql.includes('from gateway_session_run_links l')) {
          expect(params).toEqual(['swarm-session-1']);
          return { rows: [] } as unknown as { rows: TRow[] };
        }

        if (sql.includes('from agent_runs r') && sql.includes('r.session_id = $1')) {
          expect(params).toEqual(['swarm-session-1']);
          expect(sql).toContain('min(r.id::text)');
          expect(sql).not.toContain('min(r.id) asc');
          return {
            rows: [
              { root_run_id: 'root-swarm-a' },
              { root_run_id: 'root-swarm-b' },
            ],
          } as unknown as { rows: TRow[] };
        }

        if (sql.includes('with requested_roots as')) {
          expect(params).toEqual(['swarm-session-1', ['root-swarm-a', 'root-swarm-b']]);
          return {
            rows: [
              {
                root_run_id: 'root-swarm-a',
                run_id: 'root-swarm-a',
                invocation_kind: 'run',
                turn_index: null,
                linked_at: '2026-04-16T10:00:00.000Z',
                started_at: '2026-04-16T10:00:00.000Z',
                updated_at: '2026-04-16T10:00:02.000Z',
                completed_at: '2026-04-16T10:00:02.000Z',
                status: 'succeeded',
                goal: 'Swarm branch A',
                result: 'A done',
              },
              {
                root_run_id: 'root-swarm-b',
                run_id: 'root-swarm-b',
                invocation_kind: 'run',
                turn_index: null,
                linked_at: '2026-04-16T10:00:01.000Z',
                started_at: '2026-04-16T10:00:01.000Z',
                updated_at: '2026-04-16T10:00:04.000Z',
                completed_at: '2026-04-16T10:00:04.000Z',
                status: 'succeeded',
                goal: 'Swarm branch B',
                result: 'B done',
              },
            ],
          } as unknown as { rows: TRow[] };
        }

        if (sql.includes('run_usage_by_root as')) {
          expect(params).toEqual([['root-swarm-a', 'root-swarm-b']]);
          return {
            rows: [
              {
                root_run_id: 'root-swarm-a',
                total_prompt_tokens: '10',
                total_completion_tokens: '5',
                total_reasoning_tokens: '0',
                estimated_cost_usd: '0.001',
              },
              {
                root_run_id: 'root-swarm-b',
                total_prompt_tokens: '20',
                total_completion_tokens: '5',
                total_reasoning_tokens: '0',
                estimated_cost_usd: '0.002',
              },
            ],
          } as unknown as { rows: TRow[] };
        }

        if (sql.includes('attributed_usage as') || sql.includes('attributed_tool_usage as')) {
          expect(params).toEqual([['root-swarm-a', 'root-swarm-b']]);
          return { rows: [] } as unknown as { rows: TRow[] };
        }

        if (sql.includes('left join agent_events e on e.run_id = rt.run_id')) {
          expect(params).toEqual([['root-swarm-a', 'root-swarm-b'], 'swarm-session-1']);
          return { rows: [] } as unknown as { rows: TRow[] };
        }

        if (sql.includes('latest_snapshot.snapshot_seq as latest_snapshot_seq') && sql.includes('from run_snapshots rs')) {
          expect(params).toEqual([['root-swarm-a', 'root-swarm-b']]);
          return { rows: [] } as unknown as { rows: TRow[] };
        }

        if (sql.includes('with recursive root_runs as') && sql.includes('from unnest($1::text[]) as roots(root_run_id)')) {
          expect(params).toEqual([['root-swarm-a', 'root-swarm-b']]);
          return { rows: [] } as unknown as { rows: TRow[] };
        }

        throw new Error(`Unexpected SQL in test:\n${sql}`);
      },
    };

    const report = await traceSession(client as never, {
      sessionId: 'swarm-session-1',
      json: false,
      listSessions: false,
      listPerformance: false,
      listSessionless: false,
      deleteEmptyGoalSessions: false,
      usageOnly: false,
      includePlans: false,
      onlyDelegates: false,
      messages: false,
      systemOnly: false,
      help: false,
    });

    expect(report.session).toBeNull();
    expect(report.rootRuns.map((run) => run.rootRunId)).toEqual(['root-swarm-a', 'root-swarm-b']);
    expect(report.warnings).toEqual([
      'Gateway session "swarm-session-1" was not found; tracing matching agent_runs rows instead.',
    ]);

    const output = renderTraceReport(report, {
      json: false,
      includePlans: false,
      onlyDelegates: false,
      messages: false,
      systemOnly: false,
    });
    expect(output).toContain('swarm-session-1');
    expect(output).toContain('(agent_runs.session_id)');
    expect(output).not.toContain('session not found');
  });
});

function now(): string {
  return '2026-04-16T10:00:00.000Z';
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

function session(status: string) {
  return {
    sessionId: 'sess-1',
    channelId: 'chan-1',
    agentId: 'agent-1',
    invocationMode: 'run',
    status,
    currentRunId: null,
    currentRootRunId: null,
    lastCompletedRootRunId: null,
    createdAt: now(),
    updatedAt: now(),
  };
}

function traceTarget(kind: 'session' | 'root-run' | 'run', requestedId: string, resolvedRootRunId?: string) {
  return {
    kind,
    requestedId,
    resolvedRootRunId,
  };
}

function delegate(overrides: Partial<Parameters<typeof computeDelegateReason>[0]> & Record<string, unknown> = {}) {
  return {
    root_run_id: 'root-1',
    parent_run_id: 'parent-run',
    parent_step_id: 'step-1',
    parent_status: 'awaiting_subagent',
    child_run_id: 'child-run',
    snapshot_delegate_name: null,
    snapshot_child_run_id: null,
    child_delegate_name: 'analyst',
    child_status: 'running',
    child_parent_run_id: 'parent-run',
    child_parent_step_id: 'step-1',
    child_heartbeat_at: now(),
    child_lease_owner: 'worker-1',
    child_lease_expires_at: now(),
    child_updated_at: now(),
    child_completed_at: null,
    child_error_code: null,
    child_error_message: null,
    child_result: null,
    delegate_reason: 'still running',
    parent_last_event_type: 'run.status.changed',
    parent_last_event_at: now(),
    parent_last_event_payload: null,
    child_last_event_type: 'run.status.changed',
    child_last_event_at: now(),
    child_last_event_payload: null,
    ...overrides,
  };
}

function traceRow(overrides: Partial<TraceRow> = {}): TraceRow {
  return {
    session_id: 'sess-1',
    root_run_id: 'root-1',
    run_id: 'root-1',
    parent_run_id: null,
    parent_step_id: null,
    run_delegate_name: null,
    delegation_depth: 0,
    run_status: 'succeeded',
    current_step_id: 'step-1',
    current_child_run_id: null,
    goal: null,
    run_error_code: null,
    run_error_message: null,
    run_created_at: now(),
    run_updated_at: now(),
    run_completed_at: now(),
    event_id: 'event-1',
    event_seq: 1,
    event_created_at: now(),
    event_type: 'run.created',
    event_step_id: null,
    tool_call_id: null,
    payload: {},
    event_tool_name: null,
    resolved_input: null,
    ledger_tool_name: null,
    tool_execution_status: null,
    tool_started_at: null,
    tool_completed_at: null,
    tool_output: null,
    tool_error_code: null,
    tool_error_message: null,
    child_run_id: null,
    child_run_status: null,
    child_error_code: null,
    child_error_message: null,
    child_run_result: null,
    ...overrides,
  };
}

function usage(overrides: Record<string, unknown> = {}) {
  return {
    total: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedCostUSD: 0,
    },
    byRootRun: [],
    ...overrides,
  };
}
