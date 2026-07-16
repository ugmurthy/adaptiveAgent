<script lang="ts">
  import { onMount } from 'svelte';
  import DOMPurify from 'dompurify';
  import { marked } from 'marked';
  import type {
    ProviderModelUsageSummary,
    RootRun,
    SessionListItem,
    SessionPerformanceListItem,
    TimelineEntry,
    TraceReport,
    UsageSummary,
  } from '@adaptive-agent/trace-session';

  import RunAnalysisPanel from './components/RunAnalysisPanel.svelte';
  import TraceCharts from './components/TraceCharts.svelte';
  import { fetchRun, fetchSessionReport, fetchSessions } from './lib/api';
  import { buildTraceMarkdown, compactId, formatCost, formatDuration, oneLine } from '../trace-format';

  type Tab = 'story' | 'timeline' | 'messages' | 'raw';
  type SelectionKind = 'session' | 'run';

  const tabs: Tab[] = ['story', 'timeline', 'messages', 'raw'];

  interface RunListRow {
    sessionKey: string;
    sessionId: string | null;
    sessionStatus: string;
    rootRunId: string;
    runId: string;
    status: string;
    startedAt: string | null;
    completedAt: string | null;
    goal: string | null;
    durationMs: number | null;
  }

  interface SessionViewModel {
    key: string;
    sessionId: string | null;
    status: string;
    startedAt: string;
    goal: string | null;
    runs: RunListRow[];
    durationMs: number | null;
  }

  interface FinalOutputRow {
    rootRunId: string;
    runId: string;
    status: string | null;
    goal: string | null;
    result: unknown;
  }

  const emptyUsage: UsageSummary = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimatedCostUSD: 0,
  };

  let sessions = $state<SessionListItem[]>([]);
  let performance = $state<SessionPerformanceListItem[]>([]);
  let selectedSessionKey = $state<string | null>(null);
  let selectedRootRunId = $state<string | null>(null);
  let selectionKind = $state<SelectionKind>('session');
  let report = $state<TraceReport | null>(null);
  let activeTab = $state<Tab>('story');
  let query = $state('');
  let statusFilter = $state('all');
  let loadingList = $state(true);
  let loadingDetail = $state(false);
  let error = $state<string | null>(null);
  let focusedStep = $state<TimelineEntry | null>(null);
  let overviewExpanded = $state(false);
  let outputExpanded = $state(false);

  const performanceByRoot = $derived(new Map(performance.map((item) => [item.rootRunId, item])));
  const sessionViews = $derived(buildSessionViews(sessions, performanceByRoot));
  const filteredSessionViews = $derived(sessionViews.filter(sessionMatchesFilters));
  const selectedSessionView = $derived(sessionViews.find((session) => session.key === selectedSessionKey) ?? null);
  const selectedRunIndex = $derived(selectedSessionView?.runs.findIndex((row) => row.rootRunId === selectedRootRunId) ?? -1);
  const markdown = $derived(buildTraceMarkdown(report));
  const renderedMarkdown = $derived(DOMPurify.sanitize(marked.parse(markdown, { async: false }) as string));
  const brief = $derived(report?.diagnostics?.brief ?? null);
  const usage = $derived(report?.usage.total ?? null);
  const toolAccounting = $derived(report?.usage.toolAccounting ?? report?.diagnostics?.performance.toolAccounting ?? null);
  const modelCostUSD = $derived(usage?.estimatedCostUSD ?? 0);
  const toolCostUSD = $derived(toolAccounting?.estimatedCostUSD ?? 0);
  const totalCostUSD = $derived(modelCostUSD + toolCostUSD);
  const providerModelUsage = $derived(report?.usage.byProviderModel ?? []);
  const toolOutputProviderModelUsage = $derived(report?.usage.toolOutputByProviderModel ?? []);
  const visibleToolOutputProviderModelUsage = $derived(providerUsageRows(toolOutputProviderModelUsage));
  const finalOutputs = $derived(buildFinalOutputs(report?.rootRuns ?? []));
  const runAnalysis = $derived(report?.diagnostics?.analysis?.runs ?? []);

  onMount(async () => {
    await loadSessions();
  });

  async function loadSessions() {
    loadingList = true;
    error = null;
    try {
      const response = await fetchSessions();
      sessions = response.sessions;
      performance = response.performance;
      const firstSession = buildSessionViews(response.sessions, new Map(response.performance.map((item) => [item.rootRunId, item])))[0];
      loadingList = false;
      if (firstSession && !selectedSessionKey && !selectedRootRunId) {
        void selectSession(firstSession);
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      loadingList = false;
    } finally {
      loadingList = false;
    }
  }

  async function selectSession(session: SessionViewModel) {
    selectedSessionKey = session.key;
    selectedRootRunId = null;
    selectionKind = 'session';
    activeTab = 'story';
    focusedStep = null;
    overviewExpanded = false;
    outputExpanded = false;
    error = null;

    if (!session.sessionId) {
      const firstRun = session.runs[0];
      if (firstRun) {
        await selectRun(firstRun);
      }
      return;
    }

    loadingDetail = true;
    try {
      report = await fetchSessionReport(session.sessionId);
    } catch (cause) {
      report = null;
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      loadingDetail = false;
    }
  }

  async function selectRun(row: RunListRow) {
    selectedSessionKey = row.sessionKey;
    selectedRootRunId = row.rootRunId;
    selectionKind = 'run';
    activeTab = 'story';
    focusedStep = null;
    overviewExpanded = false;
    outputExpanded = false;
    loadingDetail = true;
    error = null;
    try {
      report = await fetchRun(row.rootRunId);
    } catch (cause) {
      report = null;
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      loadingDetail = false;
    }
  }

  async function selectSibling(offset: number) {
    if (!selectedSessionView || selectedRunIndex < 0) return;
    const sibling = selectedSessionView.runs[selectedRunIndex + offset];
    if (sibling) {
      await selectRun(sibling);
    }
  }

  function downloadMarkdown() {
    if (!report) return;
    const targetId = selectionKind === 'session'
      ? selectedSessionView?.sessionId ?? selectedSessionView?.key ?? 'session'
      : selectedRootRunId ?? 'run';
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `adaptive-agent-trace-${targetId}.md`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function downloadFinalOutput() {
    if (finalOutputs.length === 0) return;
    const targetId = selectionKind === 'session'
      ? selectedSessionView?.sessionId ?? selectedSessionView?.key ?? 'session'
      : selectedRootRunId ?? 'run';
    const single = finalOutputs.length === 1 ? finalOutputs[0] : null;
    const textResult = single && typeof single.result === 'string';
    const content = textResult
      ? single.result as string
      : JSON.stringify(single?.result ?? finalOutputs.map((row) => ({
        rootRunId: row.rootRunId,
        runId: row.runId,
        status: row.status,
        goal: row.goal,
        result: row.result,
      })), null, 2);
    const extension = textResult ? 'txt' : 'json';
    const blob = new Blob([content], { type: textResult ? 'text/plain;charset=utf-8' : 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `adaptive-agent-output-${safeFilename(targetId)}.${extension}`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function printPdf() {
    window.print();
  }

  function buildSessionViews(items: SessionListItem[], perf: Map<string, SessionPerformanceListItem>): SessionViewModel[] {
    return items.map((session) => {
      const key = sessionKey(session);
      const runs = session.goals.map((goal) => {
        const metric = perf.get(goal.rootRunId);
        const durationMs = metric?.totalDurationMs ?? durationFromDates(goal.startedAt, goal.completedAt);
        return {
          sessionKey: key,
          sessionId: session.sessionId,
          sessionStatus: session.status ?? 'unknown',
          rootRunId: goal.rootRunId,
          runId: goal.runId,
          status: goal.status ?? session.status ?? 'unknown',
          startedAt: goal.startedAt,
          completedAt: goal.completedAt,
          goal: goal.goal,
          durationMs,
        };
      });
      return {
        key,
        sessionId: session.sessionId,
        status: session.status ?? 'unknown',
        startedAt: session.startedAt,
        goal: runs.find((run) => oneLine(run.goal, '') !== '')?.goal ?? null,
        runs,
        durationMs: sumKnownDurations(runs.map((run) => run.durationMs)),
      };
    }).sort((left, right) => attentionRank(left.status) - attentionRank(right.status) || Date.parse(right.startedAt) - Date.parse(left.startedAt));
  }

  function sessionMatchesFilters(session: SessionViewModel): boolean {
    const trimmedQuery = query.trim().toLowerCase();
    const haystack = [
      session.sessionId,
      session.key,
      session.status,
      session.goal,
      ...session.runs.flatMap((run) => [run.rootRunId, run.runId, run.status, run.goal]),
    ].filter((value): value is string => typeof value === 'string').join(' ').toLowerCase();
    const matchesQuery = trimmedQuery === '' || haystack.includes(trimmedQuery);
    const matchesStatus = statusFilter === 'all' || session.status === statusFilter || session.runs.some((run) => run.status === statusFilter);
    return matchesQuery && matchesStatus;
  }

  function sessionKey(session: SessionListItem): string {
    return session.sessionId ?? `sessionless:${session.goals[0]?.rootRunId ?? session.startedAt}`;
  }

  function durationFromDates(startedAt: string | null, completedAt: string | null): number | null {
    if (!startedAt || !completedAt) return null;
    const duration = Date.parse(completedAt) - Date.parse(startedAt);
    return Number.isFinite(duration) && duration >= 0 ? duration : null;
  }

  function sumKnownDurations(values: Array<number | null>): number | null {
    const known = values.filter((value): value is number => value !== null && Number.isFinite(value));
    if (known.length === 0) return null;
    return known.reduce((total, value) => total + value, 0);
  }

  function attentionRank(status: string): number {
    if (status === 'running' || status === 'blocked') return 0;
    if (status === 'failed') return 1;
    if (status === 'unknown') return 2;
    return 3;
  }

  function runButtonClass(row: RunListRow): string {
    const selected = selectedRootRunId === row.rootRunId
      ? 'border-sky-200/45 bg-sky-200/12 shadow-[0_18px_50px_rgba(56,189,248,.12)]'
      : 'border-white/10 bg-black/20';
    return `w-full rounded-2xl border px-3 py-3 text-left transition hover:-translate-y-0.5 hover:border-sky-200/35 hover:bg-sky-200/10 ${selected}`;
  }

  function sessionButtonClass(session: SessionViewModel): string {
    const selected = selectionKind === 'session' && selectedSessionKey === session.key
      ? 'border-emerald-200/45 bg-emerald-200/10 shadow-[0_18px_50px_rgba(52,211,153,.10)]'
      : 'border-white/10 bg-white/[.045]';
    return `w-full rounded-3xl border p-4 text-left transition hover:-translate-y-0.5 hover:border-emerald-200/35 hover:bg-emerald-200/10 ${selected}`;
  }

  function tabButtonClass(tab: Tab): string {
    return `rounded-full px-4 py-2 text-sm font-bold capitalize ${activeTab === tab ? 'bg-white text-slate-950' : 'bg-white/7 text-slate-300 hover:bg-white/12'}`;
  }

  function statusClass(status: string): string {
    return `text-xs font-black uppercase tracking-[.18em] status-${classToken(status)}`;
  }

  function classToken(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  }

  function usageForRootRun(rootRunId: string): UsageSummary {
    return report?.usage.byRootRun.find((entry) => entry.rootRunId === rootRunId)?.usage ?? emptyUsage;
  }

  function rootRunForRow(row: RunListRow): RootRun | undefined {
    return report?.rootRuns.find((rootRun) => rootRun.rootRunId === row.rootRunId);
  }

  function runModelLabel(rootRun: RootRun | undefined): string {
    if (!rootRun?.modelProvider && !rootRun?.modelName) return 'unknown model';
    return `${rootRun.modelProvider ?? 'unknown'} / ${rootRun.modelName ?? 'unknown'}`;
  }

  function runCost(rootRunId: string): number {
    return usageForRootRun(rootRunId).estimatedCostUSD;
  }

  function providerUsageRows(rows: ProviderModelUsageSummary[]): ProviderModelUsageSummary[] {
    return rows.filter((row) => row.usage.totalTokens > 0 || row.usage.estimatedCostUSD > 0 || (row.runCount ?? row.toolCallCount ?? 0) > 0);
  }

  function buildFinalOutputs(rootRuns: RootRun[]): FinalOutputRow[] {
    return rootRuns
      .filter((rootRun) => rootRun.result !== null && rootRun.result !== undefined)
      .map((rootRun) => ({
        rootRunId: rootRun.rootRunId,
        runId: rootRun.runId,
        status: rootRun.status,
        goal: rootRun.goal,
        result: rootRun.result,
      }));
  }

  function outputText(value: unknown): string {
    if (typeof value === 'string') return value;
    return JSON.stringify(value, null, 2);
  }

  function safeFilename(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 96) || 'trace';
  }
</script>

<main class="relative z-10 min-h-screen px-4 py-5 text-slate-100 lg:px-6">
  <section class="mx-auto flex max-w-[1800px] flex-col gap-5">
    <header class="panel no-print overflow-hidden px-5 py-5 lg:px-7">
      <div class="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <p class="eyebrow">AdaptiveAgent observability</p>
          <h1 class="max-w-5xl text-4xl font-black tracking-[-0.05em] text-white md:text-6xl">
            Trace Workbench
          </h1>
          <p class="mt-3 max-w-3xl text-sm leading-7 text-slate-300 md:text-base">
            Session-first trace navigation for durable agent work: inspect the whole conversation, compare associated runs,
            then drill into the exact model, tool, and message context that explains the outcome.
          </p>
        </div>
        <div class="flex flex-wrap gap-2">
          <button class="rounded-full border border-sky-300/30 bg-sky-300/10 px-4 py-2 text-sm font-bold text-sky-100 hover:bg-sky-300/20" onclick={loadSessions}>Refresh sessions</button>
          <button class="rounded-full border border-amber-300/30 bg-amber-300/10 px-4 py-2 text-sm font-bold text-amber-100 hover:bg-amber-300/20" onclick={downloadMarkdown} disabled={!report}>Download markdown</button>
          <button class="rounded-full border border-violet-300/30 bg-violet-300/10 px-4 py-2 text-sm font-bold text-violet-100 hover:bg-violet-300/20" onclick={downloadFinalOutput} disabled={finalOutputs.length === 0}>Download output</button>
          <button class="rounded-full border border-emerald-300/30 bg-emerald-300/10 px-4 py-2 text-sm font-bold text-emerald-100 hover:bg-emerald-300/20" onclick={printPdf} disabled={!report}>Print / save PDF</button>
        </div>
      </div>
    </header>

    {#if error}
      <section class="panel no-print border-red-300/30 px-5 py-4 text-red-100">
        <p class="font-bold">Trace Workbench could not load data</p>
        <p class="mt-1 text-sm text-red-100/75">{error}</p>
      </section>
    {/if}

    <section class="grid gap-5 xl:grid-cols-[470px_minmax(0,1fr)]">
      <aside class="panel no-print h-fit overflow-hidden xl:sticky xl:top-5 xl:max-h-[calc(100vh-2.5rem)]">
        <div class="border-b border-white/10 p-4">
          <p class="eyebrow">Sessions</p>
          <div class="grid gap-2 sm:grid-cols-[1fr_150px] xl:grid-cols-1 2xl:grid-cols-[1fr_150px]">
            <input class="rounded-2xl border border-white/10 bg-black/30 px-4 py-3 text-sm outline-none ring-sky-300/20 placeholder:text-slate-500 focus:ring-4" bind:value={query} placeholder="Search goal, session, run id" />
            <select class="rounded-2xl border border-white/10 bg-black/30 px-4 py-3 text-sm outline-none ring-sky-300/20 focus:ring-4" bind:value={statusFilter}>
              <option value="all">All status</option>
              <option value="succeeded">Succeeded</option>
              <option value="failed">Failed</option>
              <option value="blocked">Blocked</option>
              <option value="running">Running</option>
              <option value="unknown">Unknown</option>
            </select>
          </div>
        </div>

        <div class="max-h-[62vh] space-y-3 overflow-auto p-3 xl:max-h-[calc(100vh-13rem)]">
          {#if loadingList}
            <p class="rounded-2xl border border-white/10 bg-white/5 p-4 text-sm text-slate-300">Loading persisted sessions…</p>
          {:else if filteredSessionViews.length === 0}
            <p class="rounded-2xl border border-white/10 bg-white/5 p-4 text-sm text-slate-300">No sessions match the current filters.</p>
          {:else}
            {#each filteredSessionViews as session (session.key)}
              <section class="rounded-[1.75rem] border border-white/10 bg-black/15 p-2">
                <button class={sessionButtonClass(session)} onclick={() => selectSession(session)}>
                  <div class="flex items-center justify-between gap-3">
                    <span class={statusClass(session.status)}>{session.status}</span>
                    <span class="rounded-full bg-black/30 px-2.5 py-1 text-[11px] text-slate-400">{session.runs.length} run{session.runs.length === 1 ? '' : 's'}</span>
                  </div>
                  <p class="mt-2 line-clamp-2 text-sm font-bold leading-6 text-slate-100">{oneLine(session.goal, 'Session without a persisted goal')}</p>
                  <div class="mt-3 flex flex-wrap gap-2 text-[11px] text-slate-500">
                    <span>session {compactId(session.sessionId)}</span>
                    <span>started {new Date(session.startedAt).toLocaleString()}</span>
                    <span>{formatDuration(session.durationMs)} total</span>
                  </div>
                </button>
                <div class="mt-2 space-y-2 px-1 pb-1">
                  {#each session.runs as row (row.rootRunId)}
                    <button class={runButtonClass(row)} onclick={() => selectRun(row)}>
                      <div class="flex items-center justify-between gap-3">
                        <span class={statusClass(row.status)}>{row.status}</span>
                        <span class="rounded-full bg-black/30 px-2.5 py-1 text-[11px] text-slate-400">{formatDuration(row.durationMs)}</span>
                      </div>
                      <p class="mt-1 line-clamp-2 text-xs font-bold leading-5 text-slate-200">{oneLine(row.goal)}</p>
                      <p class="mt-2 text-[11px] text-slate-500">run {compactId(row.rootRunId)}</p>
                    </button>
                  {/each}
                </div>
              </section>
            {/each}
          {/if}
        </div>
      </aside>

      <section class="min-w-0 space-y-5">
        {#if loadingDetail}
          <div class="panel no-print grid min-h-[420px] place-items-center p-8">
            <div class="text-center">
              <div class="mx-auto h-14 w-14 animate-spin rounded-full border-2 border-sky-300/20 border-t-sky-300"></div>
              <p class="mt-4 text-sm font-bold text-slate-200">Hydrating trace report…</p>
            </div>
          </div>
        {:else if report}
          {#if selectionKind === 'session'}
            <section class="panel overflow-hidden p-5 lg:p-6">
              <div class="grid gap-5 xl:grid-cols-[1fr_420px]">
                <div>
                  <p class="eyebrow">Session overview</p>
                  <h2 class="text-3xl font-black tracking-[-0.04em] text-white md:text-4xl">{report.summary.status}</h2>
                  <div class="collapsible-text mt-3" class:collapsed={!overviewExpanded}>
                    <p class="max-w-4xl text-base leading-8 text-slate-300">{report.summary.reason}</p>
                    <div class="mt-5 rounded-3xl border border-white/10 bg-black/20 p-4 text-sm leading-7 text-slate-300">
                      <p class="font-bold text-white">{oneLine(selectedSessionView?.goal ?? report.rootRuns[0]?.goal, 'Session without a persisted goal')}</p>
                      <p class="mt-2 text-xs text-slate-500">session {compactId(selectedSessionView?.sessionId)} · {report.rootRuns.length} associated root run{report.rootRuns.length === 1 ? '' : 's'}</p>
                    </div>
                  </div>
                  <button class="more-button mt-3" onclick={() => overviewExpanded = !overviewExpanded}>{overviewExpanded ? 'Show less' : 'Show more'}</button>
                </div>
                <div class="grid grid-cols-2 gap-3">
                  <div class="rounded-3xl border border-white/10 bg-white/[.045] p-4">
                    <p class="text-xs text-slate-400">Wall</p>
                    <p class="metric-value mt-1" title={formatDuration(brief?.wallDurationMs)}>{formatDuration(brief?.wallDurationMs)}</p>
                  </div>
                  <div class="rounded-3xl border border-white/10 bg-white/[.045] p-4">
                    <p class="text-xs text-slate-400">Runs</p>
                    <p class="metric-value mt-1">{report.rootRuns.length}</p>
                  </div>
                  <div class="rounded-3xl border border-white/10 bg-white/[.045] p-4">
                    <p class="text-xs text-slate-400">Tokens</p>
                    <p class="metric-value mt-1" title={(usage?.totalTokens ?? 0).toLocaleString()}>{(usage?.totalTokens ?? 0).toLocaleString()}</p>
                  </div>
                  <div class="rounded-3xl border border-white/10 bg-white/[.045] p-4">
                    <p class="text-xs text-slate-400">Total cost</p>
                    <p class="metric-value mt-1" title={formatCost(totalCostUSD)}>{formatCost(totalCostUSD)}</p>
                  </div>
                </div>
              </div>
            </section>

            <section class="panel overflow-hidden p-5 lg:p-6">
              <div class="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
                <div>
                  <p class="eyebrow">Associated runs</p>
                  <h3 class="text-2xl font-black tracking-[-0.03em] text-white">Session run ledger</h3>
                  <p class="mt-2 max-w-3xl text-sm leading-7 text-slate-400">Each row is a root run linked to this session. Select one to inspect its full story, timeline, messages, and raw report.</p>
                </div>
              </div>
              <div class="mt-5 overflow-hidden rounded-3xl border border-white/10 bg-black/20">
                <div class="overflow-auto">
                  <table class="w-full min-w-[920px] text-left text-sm">
                    <thead class="border-b border-white/10 text-xs uppercase tracking-[.16em] text-slate-500">
                      <tr>
                        <th class="px-4 py-3">Run</th>
                        <th class="px-4 py-3">Status</th>
                        <th class="px-4 py-3">Goal</th>
                        <th class="px-4 py-3">Model</th>
                        <th class="px-4 py-3 text-right">Tokens</th>
                        <th class="px-4 py-3 text-right">Cost</th>
                        <th class="px-4 py-3 text-right">Duration</th>
                      </tr>
                    </thead>
                    <tbody>
                      {#each selectedSessionView?.runs ?? [] as row}
                        <tr class="border-b border-white/5 last:border-0">
                          <td class="px-4 py-3"><button class="font-black text-sky-100 hover:text-sky-200" onclick={() => selectRun(row)}>{compactId(row.rootRunId)}</button></td>
                          <td class="px-4 py-3"><span class={statusClass(row.status)}>{row.status}</span></td>
                          <td class="max-w-[26rem] px-4 py-3 text-slate-300"><span class="line-clamp-2">{oneLine(row.goal)}</span></td>
                          <td class="px-4 py-3 text-slate-300">{runModelLabel(rootRunForRow(row))}</td>
                          <td class="px-4 py-3 text-right text-slate-300">{usageForRootRun(row.rootRunId).totalTokens.toLocaleString()}</td>
                          <td class="px-4 py-3 text-right font-black text-emerald-100">{formatCost(runCost(row.rootRunId))}</td>
                          <td class="px-4 py-3 text-right text-slate-300">{formatDuration(row.durationMs)}</td>
                        </tr>
                      {:else}
                        <tr><td class="px-4 py-5 text-slate-400" colspan="7">No runs are linked to this session.</td></tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          {:else}
            <section class="panel no-print overflow-hidden p-4 lg:p-5">
              <div class="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
                <div>
                  <p class="eyebrow">Run in session</p>
                  <p class="text-sm text-slate-300">
                    Run {selectedRunIndex + 1 > 0 ? selectedRunIndex + 1 : '?'} of {selectedSessionView?.runs.length ?? '?'} in session {compactId(selectedSessionView?.sessionId)}.
                  </p>
                </div>
                <div class="flex flex-wrap gap-2">
                  {#if selectedSessionView?.sessionId}
                    <button class="rounded-full border border-emerald-300/30 bg-emerald-300/10 px-4 py-2 text-sm font-bold text-emerald-100 hover:bg-emerald-300/20" onclick={() => selectedSessionView && selectSession(selectedSessionView)}>Back to session</button>
                  {/if}
                  <button class="rounded-full border border-white/10 bg-white/7 px-4 py-2 text-sm font-bold text-slate-200 hover:bg-white/12" onclick={() => selectSibling(-1)} disabled={selectedRunIndex <= 0}>Previous run</button>
                  <button class="rounded-full border border-white/10 bg-white/7 px-4 py-2 text-sm font-bold text-slate-200 hover:bg-white/12" onclick={() => selectSibling(1)} disabled={!selectedSessionView || selectedRunIndex < 0 || selectedRunIndex >= selectedSessionView.runs.length - 1}>Next run</button>
                </div>
              </div>
              <div class="mt-4 flex flex-wrap gap-2">
                {#each selectedSessionView?.runs ?? [] as row, index}
                  <button class={`rounded-full border px-3 py-1.5 text-xs font-bold ${row.rootRunId === selectedRootRunId ? 'border-sky-200/45 bg-sky-200/15 text-sky-100' : 'border-white/10 bg-black/20 text-slate-300 hover:bg-white/10'}`} onclick={() => selectRun(row)}>
                    {index + 1}. {row.status} · {compactId(row.rootRunId)}
                  </button>
                {/each}
              </div>
            </section>

            <section class="panel overflow-hidden p-5 lg:p-6">
              <div class="grid gap-5 xl:grid-cols-[1fr_340px]">
                <div>
                  <p class="eyebrow">Outcome status</p>
                  <h2 class="text-3xl font-black tracking-[-0.04em] text-white md:text-4xl">{report.summary.status}</h2>
                  <div class="collapsible-text mt-3" class:collapsed={!overviewExpanded}>
                    <p class="max-w-4xl text-base leading-8 text-slate-300">{report.summary.reason}</p>
                    <p class="mt-5 rounded-3xl border border-white/10 bg-black/20 p-4 text-sm leading-7 text-slate-300">{oneLine(report.rootRuns[0]?.goal)}</p>
                  </div>
                  <button class="more-button mt-3" onclick={() => overviewExpanded = !overviewExpanded}>{overviewExpanded ? 'Show less' : 'Show more'}</button>
                </div>
                <div class="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-2">
                  <div class="rounded-3xl border border-white/10 bg-white/[.045] p-4">
                    <p class="text-xs text-slate-400">Wall</p>
                    <p class="metric-value mt-1" title={formatDuration(brief?.wallDurationMs)}>{formatDuration(brief?.wallDurationMs)}</p>
                  </div>
                  <div class="rounded-3xl border border-white/10 bg-white/[.045] p-4">
                    <p class="text-xs text-slate-400">Tokens</p>
                    <p class="metric-value mt-1" title={(usage?.totalTokens ?? 0).toLocaleString()}>{(usage?.totalTokens ?? 0).toLocaleString()}</p>
                  </div>
                  <div class="rounded-3xl border border-white/10 bg-white/[.045] p-4">
                    <p class="text-xs text-slate-400">Total cost</p>
                    <p class="metric-value mt-1" title={formatCost(totalCostUSD)}>{formatCost(totalCostUSD)}</p>
                  </div>
                  <div class="rounded-3xl border border-white/10 bg-white/[.045] p-4">
                    <p class="text-xs text-slate-400">Calls</p>
                    <p class="metric-value mt-1" title={`${brief?.toolCalls ?? 0} tools`}>{brief?.toolCalls ?? 0} tools</p>
                  </div>
                </div>
              </div>
            </section>
          {/if}

          <section class="panel overflow-hidden p-5 lg:p-6">
            <div class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p class="eyebrow">Final output</p>
                <h3 class="text-2xl font-black tracking-[-0.03em] text-white">{selectionKind === 'session' ? 'Session results' : 'Run result'}</h3>
                <p class="mt-2 max-w-3xl text-sm leading-7 text-slate-400">Persisted result returned by the completed root run, separate from the diagnostic outcome text.</p>
              </div>
              <button class="rounded-full border border-violet-300/30 bg-violet-300/10 px-4 py-2 text-sm font-bold text-violet-100 hover:bg-violet-300/20" onclick={downloadFinalOutput} disabled={finalOutputs.length === 0}>Download output</button>
            </div>
            {#if finalOutputs.length}
              <div class="collapsible-text output-preview mt-5" class:collapsed={!outputExpanded}>
                <div class="space-y-4">
                  {#each finalOutputs as output (output.rootRunId)}
                    <article class="overflow-hidden rounded-3xl border border-violet-200/15 bg-violet-200/[.055]">
                      <div class="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 px-4 py-3">
                        <div>
                          <p class="text-sm font-black text-white">run {compactId(output.rootRunId)}</p>
                          <p class="mt-1 text-xs text-slate-500">{output.status ?? 'unknown'} · {oneLine(output.goal)}</p>
                        </div>
                        <span class="rounded-full bg-black/30 px-3 py-1 text-xs text-violet-100">{typeof output.result === 'string' ? 'text' : 'json'}</span>
                      </div>
                      <pre class="max-h-[28rem] overflow-auto whitespace-pre-wrap p-4 text-sm leading-7 text-slate-200">{outputText(output.result)}</pre>
                    </article>
                  {/each}
                </div>
              </div>
              <button class="more-button mt-3" onclick={() => outputExpanded = !outputExpanded}>{outputExpanded ? 'Show less' : 'Show more'}</button>
            {:else}
              <p class="mt-5 rounded-3xl border border-white/10 bg-black/20 p-4 text-sm text-slate-400">No final result was persisted for this {selectionKind}.</p>
            {/if}
          </section>

          <section class="panel overflow-hidden p-5 lg:p-6">
            <div class="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
              <div class="min-w-0">
                <p class="eyebrow">Cost accounting</p>
                <h3 class="text-2xl font-black tracking-[-0.03em] text-white">Model + tool provider spend</h3>
                <p class="mt-2 max-w-3xl text-sm leading-7 text-slate-400">Estimated cost = model token usage + persisted tool provider accounting.</p>
                {#if (toolAccounting?.unpricedRequests ?? 0) > 0}
                  <p class="mt-3 inline-flex rounded-full border border-red-300/30 bg-red-300/10 px-3 py-1 text-xs font-bold text-red-100">{toolAccounting?.unpricedRequests.toLocaleString()} unpriced tool request{toolAccounting?.unpricedRequests === 1 ? '' : 's'}</p>
                {/if}
              </div>
              <div class="grid w-full min-w-0 grid-cols-1 gap-3 sm:grid-cols-3 xl:w-[min(46rem,48vw)] xl:shrink-0">
                <div class="min-w-0 overflow-hidden rounded-3xl border border-sky-200/15 bg-sky-200/10 p-4">
                  <p class="text-[11px] uppercase tracking-[.16em] text-sky-200">Model</p>
                  <p class="cost-value mt-1" title={formatCost(modelCostUSD)}>{formatCost(modelCostUSD)}</p>
                </div>
                <div class="min-w-0 overflow-hidden rounded-3xl border border-amber-200/15 bg-amber-200/10 p-4">
                  <p class="text-[11px] uppercase tracking-[.16em] text-amber-200">Tools</p>
                  <p class="cost-value mt-1" title={formatCost(toolCostUSD)}>{formatCost(toolCostUSD)}</p>
                </div>
                <div class="min-w-0 overflow-hidden rounded-3xl border border-emerald-200/15 bg-emerald-200/10 p-4">
                  <p class="text-[11px] uppercase tracking-[.16em] text-emerald-200">Total</p>
                  <p class="cost-value mt-1" title={formatCost(totalCostUSD)}>{formatCost(totalCostUSD)}</p>
                </div>
              </div>
            </div>

            <div class={`mt-5 grid gap-4 ${visibleToolOutputProviderModelUsage.length ? 'xl:grid-cols-2' : ''}`}>
              <div class="overflow-hidden rounded-3xl border border-white/10 bg-black/20">
                <div class="border-b border-white/10 px-4 py-3">
                  <p class="text-sm font-black text-white">Model usage by provider/model</p>
                </div>
                {#if providerUsageRows(providerModelUsage).length}
                  <div class="overflow-auto">
                    <table class="w-full min-w-[980px] text-left text-sm">
                      <thead class="border-b border-white/10 text-xs uppercase tracking-[.16em] text-slate-500">
                        <tr>
                          <th class="px-4 py-3">Provider</th>
                          <th class="px-4 py-3">Model</th>
                          <th class="px-4 py-3 text-right">Runs</th>
                          <th class="px-4 py-3 text-right">Prompt</th>
                          <th class="px-4 py-3 text-right">Completion</th>
                          <th class="px-4 py-3 text-right">Reasoning</th>
                          <th class="px-4 py-3 text-right">Total tokens</th>
                          <th class="px-4 py-3 text-right">Cost</th>
                        </tr>
                      </thead>
                      <tbody>
                        {#each providerUsageRows(providerModelUsage) as row}
                          <tr class="border-b border-white/5 last:border-0">
                            <td class="px-4 py-3 font-bold text-white">{row.provider}</td>
                            <td class="px-4 py-3 text-slate-300">{row.model}</td>
                            <td class="px-4 py-3 text-right text-slate-300">{(row.runCount ?? 0).toLocaleString()}</td>
                            <td class="px-4 py-3 text-right text-slate-300">{row.usage.promptTokens.toLocaleString()}</td>
                            <td class="px-4 py-3 text-right text-slate-300">{row.usage.completionTokens.toLocaleString()}</td>
                            <td class="px-4 py-3 text-right text-slate-300">{(row.usage.reasoningTokens ?? 0).toLocaleString()}</td>
                            <td class="px-4 py-3 text-right text-slate-300">{row.usage.totalTokens.toLocaleString()}</td>
                            <td class="px-4 py-3 text-right font-black text-sky-100">{formatCost(row.usage.estimatedCostUSD)}</td>
                          </tr>
                        {/each}
                      </tbody>
                    </table>
                  </div>
                {:else}
                  <p class="p-4 text-sm text-slate-400">No model usage payloads were available for this trace.</p>
                {/if}
              </div>

              {#if visibleToolOutputProviderModelUsage.length}
                <div class="overflow-hidden rounded-3xl border border-white/10 bg-black/20">
                  <div class="border-b border-white/10 px-4 py-3">
                    <p class="text-sm font-black text-white">Tool-output token usage</p>
                  </div>
                  <div class="overflow-auto">
                    <table class="w-full min-w-[680px] text-left text-sm">
                      <thead class="border-b border-white/10 text-xs uppercase tracking-[.16em] text-slate-500">
                        <tr>
                          <th class="px-4 py-3">Provider</th>
                          <th class="px-4 py-3">Model</th>
                          <th class="px-4 py-3 text-right">Tool calls</th>
                          <th class="px-4 py-3 text-right">Tokens</th>
                          <th class="px-4 py-3 text-right">Cost</th>
                        </tr>
                      </thead>
                      <tbody>
                        {#each visibleToolOutputProviderModelUsage as row}
                          <tr class="border-b border-white/5 last:border-0">
                            <td class="px-4 py-3 font-bold text-white">{row.provider}</td>
                            <td class="px-4 py-3 text-slate-300">{row.model}</td>
                            <td class="px-4 py-3 text-right text-slate-300">{(row.toolCallCount ?? 0).toLocaleString()}</td>
                            <td class="px-4 py-3 text-right text-slate-300">{row.usage.totalTokens.toLocaleString()}</td>
                            <td class="px-4 py-3 text-right font-black text-sky-100">{formatCost(row.usage.estimatedCostUSD)}</td>
                          </tr>
                        {/each}
                      </tbody>
                    </table>
                  </div>
                </div>
              {/if}
            </div>

            <div class="mt-5 overflow-hidden rounded-3xl border border-white/10 bg-black/20">
              {#if toolAccounting?.byProviderOperation.length}
                <div class="overflow-auto">
                  <table class="w-full min-w-[760px] text-left text-sm">
                    <thead class="border-b border-white/10 text-xs uppercase tracking-[.16em] text-slate-500">
                      <tr>
                        <th class="px-4 py-3">Provider</th>
                        <th class="px-4 py-3">Operation</th>
                        <th class="px-4 py-3 text-right">Tool calls</th>
                        <th class="px-4 py-3 text-right">Requests</th>
                        <th class="px-4 py-3 text-right">Billable</th>
                        <th class="px-4 py-3 text-right">Cached</th>
                        <th class="px-4 py-3 text-right">Unpriced</th>
                        <th class="px-4 py-3 text-right">Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {#each toolAccounting.byProviderOperation as row}
                        <tr class="border-b border-white/5 last:border-0">
                          <td class="px-4 py-3 font-bold text-white">{row.provider}</td>
                          <td class="px-4 py-3 text-slate-300">{row.operation}</td>
                          <td class="px-4 py-3 text-right text-slate-300">{row.toolCalls.toLocaleString()}</td>
                          <td class="px-4 py-3 text-right text-slate-300">{row.requests.toLocaleString()}</td>
                          <td class="px-4 py-3 text-right text-slate-300">{row.billableRequests.toLocaleString()}</td>
                          <td class="px-4 py-3 text-right text-slate-300">{row.cachedToolCalls.toLocaleString()}</td>
                          <td class="px-4 py-3 text-right text-slate-300">{row.unpricedRequests.toLocaleString()}</td>
                          <td class="px-4 py-3 text-right font-black text-amber-100">{formatCost(row.estimatedCostUSD)}</td>
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
              {:else}
                <p class="p-4 text-sm text-slate-400">No tool accounting payloads were available for this trace.</p>
              {/if}
            </div>
          </section>

          <RunAnalysisPanel runs={runAnalysis} />

          <TraceCharts {report} />

          <section class="panel no-print overflow-hidden">
            <div class="flex flex-wrap gap-2 border-b border-white/10 p-3">
              {#each tabs as tab}
                <button class={tabButtonClass(tab)} onclick={() => activeTab = tab}>{tab}</button>
              {/each}
            </div>

            {#if activeTab === 'story'}
              <div class="grid gap-4 p-4 xl:grid-cols-[1fr_360px]">
                <article class="markdown-body print-card rounded-3xl border border-white/10 bg-black/20 p-5">
                  {@html renderedMarkdown}
                </article>
                <aside class="space-y-3">
                  <p class="eyebrow">Suggested next inspections</p>
                  {#each report.diagnostics?.suggestedNextViews ?? [] as suggestion}
                    <div class="rounded-3xl border border-white/10 bg-white/[.045] p-4">
                      <p class="text-sm font-bold text-white">{suggestion.reason}</p>
                      <code class="mt-2 block rounded-2xl bg-black/35 p-3 text-xs text-sky-100">{suggestion.command}</code>
                    </div>
                  {:else}
                    <p class="rounded-3xl border border-white/10 bg-white/[.045] p-4 text-sm text-slate-400">No follow-up commands suggested.</p>
                  {/each}
                </aside>
              </div>
            {:else if activeTab === 'timeline'}
              <div class="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_420px]">
                <div class="space-y-2">
                  {#each report.timeline as entry, index}
                    <button class="w-full rounded-3xl border border-white/10 bg-white/[.045] p-4 text-left hover:border-amber-200/35 hover:bg-amber-200/10" onclick={() => focusedStep = entry}>
                      <div class="flex flex-wrap items-center justify-between gap-3">
                        <p class="font-black text-white">{index + 1}. {entry.toolName ?? entry.eventType ?? 'step'}</p>
                        <p class="rounded-full bg-black/30 px-3 py-1 text-xs text-slate-300">{formatDuration(entry.durationMs)}</p>
                      </div>
                      <p class="mt-2 text-sm text-slate-400">run {compactId(entry.runId)} · {entry.outcome}</p>
                    </button>
                  {:else}
                    <p class="rounded-3xl border border-white/10 bg-white/[.045] p-4 text-sm text-slate-400">No tool-like timeline entries were found.</p>
                  {/each}
                </div>
                <pre class="min-h-[420px] overflow-auto rounded-3xl border border-white/10 bg-black/35 p-4 text-xs leading-6 text-slate-200">{JSON.stringify(focusedStep ?? report.timeline[0] ?? {}, null, 2)}</pre>
              </div>
            {:else if activeTab === 'messages'}
              <div class="space-y-4 p-4">
                {#each report.llmMessages as trace}
                  <section class="rounded-3xl border border-white/10 bg-white/[.045] p-4">
                    <p class="text-sm font-black text-white">run {compactId(trace.runId)} {trace.delegateName ? `· ${trace.delegateName}` : ''}</p>
                    <p class="mt-1 text-xs text-slate-500">latest snapshot {trace.latestSnapshotSeq ?? '-'} · persisted context shown below</p>
                    <div class="mt-3 space-y-2">
                      {#each trace.effectiveMessages.slice(-8) as message}
                        <div class="rounded-2xl border border-white/10 bg-black/25 p-3">
                          <p class="text-[11px] font-black uppercase tracking-[.16em] text-sky-200">{message.role} · {message.category}</p>
                          <p class="mt-2 whitespace-pre-wrap text-sm leading-7 text-slate-300">{message.content.slice(0, 1800)}</p>
                        </div>
                      {/each}
                    </div>
                  </section>
                {:else}
                  <p class="rounded-3xl border border-white/10 bg-white/[.045] p-4 text-sm text-slate-400">No snapshot-backed LLM messages were loaded for this trace.</p>
                {/each}
              </div>
            {:else}
              <pre class="max-h-[72vh] overflow-auto p-5 text-xs leading-6 text-slate-200">{JSON.stringify(report, null, 2)}</pre>
            {/if}
          </section>
        {:else}
          <div class="panel no-print grid min-h-[420px] place-items-center p-8 text-center text-slate-300">
            Select a persisted session or run from the left rail.
          </div>
        {/if}
      </section>
    </section>
  </section>
</main>
