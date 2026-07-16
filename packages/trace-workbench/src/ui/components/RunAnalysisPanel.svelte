<script lang="ts">
  import type { RunAnalysis } from '@adaptive-agent/trace-session';

  import {
    compactId,
    formatBytes,
    formatCost,
    formatDuration,
    formatPercentage,
    formatRatio,
  } from '../../trace-format';

  let { runs }: { runs: RunAnalysis[] } = $props();

  function modelLabel(run: RunAnalysis): string {
    if (!run.provider && !run.model) return 'unknown';
    return `${run.provider ?? 'unknown'} / ${run.model ?? 'unknown'}`;
  }

  function callCount(completed: number, failed: number): string {
    return `${completed.toLocaleString()} / ${failed.toLocaleString()}`;
  }

  function contextValues(values: Array<number | null>, formatter: (value: number | null) => string): string {
    return values.map(formatter).join(' / ');
  }

  function coverage(value: number | null): string {
    return value === null ? 'n/a' : formatPercentage(value * 100);
  }

  function classToken(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  }
</script>

<section class="panel overflow-hidden p-5 lg:p-6">
  <div class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
    <div>
      <p class="eyebrow">Derived diagnostics</p>
      <h3 class="text-2xl font-black tracking-[-0.03em] text-white">Per-run efficiency and context</h3>
      <p class="mt-2 max-w-4xl text-sm leading-7 text-slate-400">
        The same persisted-run analysis used by CLI comparisons, aggregate reports, and exports. Values are presented here without browser-side metric recomputation.
      </p>
    </div>
    <span class="w-fit rounded-full border border-sky-200/25 bg-sky-200/10 px-3 py-1 text-xs font-black uppercase tracking-[.16em] text-sky-100">
      {runs.length} run{runs.length === 1 ? '' : 's'}
    </span>
  </div>

  {#if runs.length}
    <div class="mt-5 space-y-4">
      <div class="overflow-hidden rounded-3xl border border-white/10 bg-black/20">
        <div class="border-b border-white/10 px-4 py-3">
          <p class="text-sm font-black text-white">Execution efficiency</p>
          <p class="mt-1 text-xs text-slate-500">Logical operations, attempts, measured time, output handling, and cost by persisted run.</p>
        </div>
        <div class="overflow-auto">
          <table class="w-full min-w-[1450px] text-left text-sm">
            <thead class="border-b border-white/10 text-xs uppercase tracking-[.14em] text-slate-500">
              <tr>
                <th class="px-4 py-3">Run</th>
                <th class="px-4 py-3">Status</th>
                <th class="px-4 py-3">Provider / model</th>
                <th class="px-4 py-3 text-right">Wall</th>
                <th class="px-4 py-3 text-right">Measured</th>
                <th class="px-4 py-3 text-right">Parallelism</th>
                <th class="px-4 py-3 text-right">Model logical / attempts</th>
                <th class="px-4 py-3 text-right">Retries</th>
                <th class="px-4 py-3 text-right">Amplification</th>
                <th class="px-4 py-3 text-right">Model failures</th>
                <th class="px-4 py-3 text-right">Tools / failed</th>
                <th class="px-4 py-3 text-right">Output reduction</th>
                <th class="px-4 py-3 text-right">Tokens</th>
                <th class="px-4 py-3 text-right">Grand cost</th>
              </tr>
            </thead>
            <tbody>
              {#each runs as run (run.runId)}
                <tr class="border-b border-white/5 last:border-0">
                  <td class="px-4 py-3 font-black text-sky-100" title={run.runId}>
                    <span class="text-slate-600">{'· '.repeat(run.depth)}</span>{compactId(run.runId)}
                    {#if run.delegateName}<span class="ml-2 text-xs font-medium text-slate-500">{run.delegateName}</span>{/if}
                  </td>
                  <td class="px-4 py-3"><span class={`text-xs font-black uppercase tracking-[.14em] status-${classToken(run.status ?? 'unknown')}`}>{run.status ?? 'unknown'}</span></td>
                  <td class="px-4 py-3 text-slate-300">{modelLabel(run)}</td>
                  <td class="px-4 py-3 text-right text-slate-300">{formatDuration(run.durations.wallMs)}</td>
                  <td class="px-4 py-3 text-right text-slate-300">{formatDuration(run.durations.cumulativeMeasuredMs)}</td>
                  <td class="px-4 py-3 text-right text-slate-300">{formatRatio(run.durations.parallelism)}</td>
                  <td class="px-4 py-3 text-right text-slate-300">{callCount(run.modelCalls.logicalCalls, run.modelCalls.attempts)}</td>
                  <td class="px-4 py-3 text-right text-slate-300">{run.modelCalls.retries.toLocaleString()}</td>
                  <td class="px-4 py-3 text-right text-slate-300">{formatRatio(run.modelCalls.retryAmplification)}</td>
                  <td class="px-4 py-3 text-right text-slate-300">{run.modelCalls.failures.toLocaleString()}</td>
                  <td class="px-4 py-3 text-right text-slate-300">{callCount(run.toolCalls.starts, run.toolCalls.failures)}</td>
                  <td class="px-4 py-3 text-right text-slate-300">{formatPercentage(run.toolCalls.reductionPercentage)}</td>
                  <td class="px-4 py-3 text-right text-slate-300">{run.usage.combined.totalTokens.toLocaleString()}</td>
                  <td class="px-4 py-3 text-right font-black text-emerald-100">{formatCost(run.costs.estimatedGrandTotalUSD)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>

      <div class="overflow-hidden rounded-3xl border border-white/10 bg-black/20">
        <div class="border-b border-white/10 px-4 py-3">
          <p class="text-sm font-black text-white">Context growth and evidence coverage</p>
          <p class="mt-1 text-xs text-slate-500">Initial / latest / peak / growth values remain unavailable when the trace did not persist a measurement.</p>
        </div>
        <div class="overflow-auto">
          <table class="w-full min-w-[1320px] text-left text-sm">
            <thead class="border-b border-white/10 text-xs uppercase tracking-[.14em] text-slate-500">
              <tr>
                <th class="px-4 py-3">Run</th>
                <th class="px-4 py-3">Context source</th>
                <th class="px-4 py-3">Bytes: initial / latest / peak / growth</th>
                <th class="px-4 py-3">Messages: initial / latest / peak / growth</th>
                <th class="px-4 py-3 text-right">Children</th>
                <th class="px-4 py-3 text-right">Child wall</th>
                <th class="px-4 py-3 text-right">Output</th>
                <th class="px-4 py-3 text-right">Events</th>
                <th class="px-4 py-3 text-right">Performance</th>
                <th class="px-4 py-3 text-right">Snapshots</th>
                <th class="px-4 py-3 text-right">Provider cost</th>
              </tr>
            </thead>
            <tbody>
              {#each runs as run (run.runId)}
                <tr class="border-b border-white/5 last:border-0">
                  <td class="px-4 py-3 font-black text-sky-100" title={run.runId}>{compactId(run.runId)}</td>
                  <td class="px-4 py-3 text-slate-300">{run.contextGrowth.source} · {run.contextGrowth.samples.toLocaleString()}</td>
                  <td class="px-4 py-3 font-mono text-xs text-slate-300">{contextValues([
                    run.contextGrowth.initialMessageBytes,
                    run.contextGrowth.latestMessageBytes,
                    run.contextGrowth.peakMessageBytes,
                    run.contextGrowth.messageBytesGrowth,
                  ], formatBytes)}</td>
                  <td class="px-4 py-3 font-mono text-xs text-slate-300">{contextValues([
                    run.contextGrowth.initialMessageCount,
                    run.contextGrowth.latestMessageCount,
                    run.contextGrowth.peakMessageCount,
                    run.contextGrowth.messageCountGrowth,
                  ], (value) => value === null ? 'n/a' : value.toLocaleString())}</td>
                  <td class="px-4 py-3 text-right text-slate-300">{run.directChildFanOut.toLocaleString()}</td>
                  <td class="px-4 py-3 text-right text-slate-300">{formatDuration(run.cumulativeDirectChildWallMs)}</td>
                  <td class="px-4 py-3 text-right text-slate-300">{formatBytes(run.outputBytes)}</td>
                  <td class="px-4 py-3 text-right text-slate-300">{run.coverage.events.toLocaleString()}</td>
                  <td class="px-4 py-3 text-right text-slate-300">{coverage(run.coverage.performance)}</td>
                  <td class="px-4 py-3 text-right text-slate-300">{run.coverage.snapshots.toLocaleString()}</td>
                  <td class="px-4 py-3 text-right text-slate-300">{coverage(run.coverage.cost)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>

      {#if runs.some((run) => run.notes.length > 0)}
        <div class="grid gap-3 lg:grid-cols-2">
          {#each runs.filter((run) => run.notes.length > 0) as run (run.runId)}
            <article class="rounded-3xl border border-amber-200/15 bg-amber-200/[.055] p-4">
              <p class="text-xs font-black uppercase tracking-[.14em] text-amber-100">Data notes · {compactId(run.runId)}</p>
              <ul class="mt-2 space-y-1 pl-4 text-sm leading-6 text-slate-300">
                {#each run.notes as note}<li class="list-disc">{note}</li>{/each}
              </ul>
            </article>
          {/each}
        </div>
      {/if}
    </div>
  {:else}
    <p class="mt-5 rounded-3xl border border-white/10 bg-black/20 p-4 text-sm text-slate-400">
      No per-run analysis was attached to this report.
    </p>
  {/if}
</section>
