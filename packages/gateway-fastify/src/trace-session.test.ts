import { describe, expect, it } from 'vitest';

import { buildTimeline, computeDelegateReason, parseArgs, renderDeleteEmptyGoalSessionsSql, renderSessionList, renderSessionlessRunList, renderTraceReport, renderUsageReport, summarizeTrace, traceSession } from './trace-session.js';

describe('trace-session CLI helpers', () => {
  it('parses the primary trace-session command and flags', () => {
    expect(parseArgs(['trace-session', 'sess-1', '--json', '--root-run', 'root-1', '--include-plans', '--only-delegates'])).toEqual({
      sessionId: 'sess-1',
      json: true,
      listSessions: false,
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

  it('parses direct run tracing flags without a session id', () => {
    expect(parseArgs(['trace-session', '--run', 'run-1', '--messages'])).toEqual({
      json: false,
      listSessions: false,
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
      ],
      { json: false },
    );

    expect(output).toContain('---- session-newest-full-id : succeeded : 2026-04-16T10:00:00.000Z ----');
    expect(output).toContain('  Goal: Summarize the incident timeline');
    expect(output).toContain('  - root-2  succeeded  started=2026-04-16 10:00:01.000  elapsed=2.00s');
    expect(output).toContain('---- session-older-full-id : unknown : 2026-04-16T09:00:00.000Z ----');
    expect(output).toContain('  Goal: (none)');
    expect(output).toContain('  Runs: (none)');
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

  it('parses the session-less list flag without a session id', () => {
    expect(parseArgs(['trace-session', '--ls-sessionless', '--json'])).toEqual({
      sessionId: undefined,
      json: true,
      listSessions: false,
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
          goals: [{ rootRunId: 'root-null', goal: null, linkedAt: now() }],
        },
        {
          sessionId: 'session-blank',
          startedAt: now(),
          goals: [{ rootRunId: 'root-blank', goal: '   ', linkedAt: now() }],
        },
        {
          sessionId: 'session-keep',
          startedAt: now(),
          goals: [{ rootRunId: 'root-keep', goal: 'Keep me', linkedAt: now() }],
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
    expect(output).toContain('root-1 : prompt=700');
    expect(output).toContain('root-2 : prompt=300');
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
    expect(output).toContain('2.50s');
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

  it('prints JSON as machine-readable report output', () => {
    const output = renderTraceReport(
      {
        target: traceTarget('session', 'sess-1'),
        session: session('succeeded'),
        rootRuns: [],
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
              role: 'system',
              category: 'runtime-injected-system',
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
    expect(output).toContain('runtime-injected-system');
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
              role: 'system',
              category: 'runtime-injected-system',
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
    expect(output).toContain('runtime-injected-system');
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

        if (sql.includes('coalesce(sum(r.total_prompt_tokens)')) {
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
                  { role: 'system', content: 'Future web_search calls should include a short purpose.' },
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
            category: 'runtime-injected-system',
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

        if (sql.includes('coalesce(sum(r.total_prompt_tokens)')) {
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

        if (sql.includes('coalesce(sum(r.total_prompt_tokens)')) {
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
