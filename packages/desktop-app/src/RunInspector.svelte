<script lang="ts">
  import type { DesktopState, TracePrivacy, TraceReport } from './desktop';
  import ResultRenderer from './ResultRenderer.svelte';
  import { formatTimestamp } from './timestamp';
  export let desktop: DesktopState;
  export let root = '';
  export let report: TraceReport | undefined;
  export let error = '';
  export let privacy: TracePrivacy;
  export let privacyPending = false;
  export let onprivacy: (privacy: TracePrivacy) => void;
  export let onclose: () => void;
  let view: 'overview'|'timeline'|'agents'|'tools'|'usage'|'diagnostics' = 'overview';
  let rawVisible = false;

  function formatCost(estimate: number): string {
    return estimate < 0.0001 ? '<$0.0001' : `$${estimate.toFixed(4)}`;
  }

  function costSummary(value: TraceReport): string {
    const total=value.usage?.total;
    const unpriced=value.diagnostics?.performance?.toolAccounting?.unpricedRequests ?? value.usage?.toolAccounting?.unpricedRequests ?? 0;
    const estimate=total?.estimatedCostUSD ?? 0;
    if (unpriced>0) return `${unpriced} unpriced request${unpriced===1?'':'s'}; ${estimate>0 ? `${formatCost(estimate)} partial estimate` : 'no priced cost recorded'}`;
    if (estimate>0) return `Estimated cost ${formatCost(estimate)}`;
    if ((total?.totalTokens ?? 0)>0) return 'Usage recorded; no priced cost recorded';
    return 'No priced usage recorded';
  }

  function rawData(): unknown {
    if (!report) return undefined;
    if (view === 'overview') return report;
    if (view === 'timeline') return report.timeline;
    if (view === 'agents') return report.runTree;
    if (view === 'tools') return (report.timeline ?? []).filter((entry) => typeof entry.toolName === 'string');
    if (view === 'usage') return report.usage;
    return {
      diagnostics: report.diagnostics ?? { warnings: report.warnings ?? [], performance: report.performance },
      sensitive: {
        messages: privacy.messages ? report.llmMessages ?? [] : 'Disabled',
        reasoning: privacy.reasoning ? 'Included in authorized messages' : 'Disabled',
        rawToolPayloads: privacy.rawToolPayloads
          ? (report.timeline ?? []).map(({ params, output, eventType, runId, toolName }) => ({ eventType, runId, toolName, params, output }))
          : 'Disabled',
      },
    };
  }

  function formatDate(value?: string | null): string {
    return formatTimestamp(value);
  }
</script>

<aside class="run-inspector" aria-label="Run inspector">
  <header><div><span>Inspector</span><strong>{root ? root.slice(0,8) : 'No run selected'}</strong></div><button aria-label="Close inspector" on:click={onclose}>×</button></header>
  <div class="health-line"><span class:good={desktop.traceHealth==='ready'} class="status-dot">Trace {desktop.traceHealth}</span><small>Read only</small></div>
  {#if desktop.traceError}<div class="alert">{desktop.traceError}</div>{/if}
  {#if error}<div class="alert">{error}</div>{/if}
  {#if !root}<p class="empty-copy">Select a task attempt or chat turn to inspect durable evidence.</p>{/if}
  <div class="inspector-tabs">
    {#each [['overview','Overview'],['timeline','Timeline'],['agents','Agents'],['tools','Tools'],['usage','Usage'],['diagnostics','Diagnostics']] as item}
      <button class:active={view===item[0]} on:click={()=>view=item[0] as typeof view}>{item[1]}</button>
    {/each}
  </div>
  {#if report}
    {#if view==='overview'}
      <div class="summary"><strong>{report.summary?.status ?? 'unknown'}</strong><span>{report.summary?.reason ?? 'No summary available.'}</span></div>
      <div class="metric-grid"><div><strong>{report.rootRuns?.length ?? 0}</strong><span>root runs</span></div><div><strong>{report.timeline?.length ?? 0}</strong><span>events</span></div></div>
      {#each (report.rootRuns ?? []) as run}
        <article class="inspector-run-detail">
          <div class="inspector-run-heading"><strong>{run.status ?? 'unknown'}</strong><span>{run.runId.slice(0,8)}</span></div>
          {#if run.goal}<div class="inspector-field"><span>Goal</span><p>{run.goal}</p></div>{/if}
          <dl class="inspector-metadata">
            <div><dt>Model</dt><dd>{[run.modelProvider, run.modelName].filter(Boolean).join(' / ') || 'Not recorded'}</dd></div>
            <div><dt>Started</dt><dd>{formatDate(run.startedAt ?? run.linkedAt)}</dd></div>
            <div><dt>Completed</dt><dd>{formatDate(run.completedAt)}</dd></div>
          </dl>
          {#if run.errorCode || run.errorMessage}<div class="alert"><strong>{run.errorCode ?? 'Run error'}</strong>{#if run.errorMessage}<p>{run.errorMessage}</p>{/if}</div>{/if}
          {#if run.result !== null && run.result !== undefined}<div class="inspector-field"><span>Final output</span><ResultRenderer value={run.result}/></div>{/if}
        </article>
      {/each}
    {:else if view==='timeline'}
      <div class="inspector-list">{#each (report.timeline ?? []).slice(-50) as entry}<article><strong>{String(entry.eventType ?? entry.type ?? 'Event')}</strong><span>{String(entry.toolName ?? entry.runId ?? '')}</span></article>{/each}</div>
    {:else if view==='agents'}
      <div class="inspector-stat"><strong>{report.runTree?.length ?? 0}</strong><span>agent run records</span></div>
      <div class="inspector-list">{#each (report.runTree ?? []) as run}<article><strong>{run.delegateName ?? (run.depth ? 'Child run' : 'Coordinator')}</strong><span>{run.status ?? 'unknown'} · {run.runId.slice(0,8)}</span>{#if run.parentRunId}<small>Parent {run.parentRunId.slice(0,8)}</small>{/if}</article>{/each}</div>
    {:else if view==='tools'}
      {@const tools=(report.timeline ?? []).filter((entry)=>typeof entry.toolName==='string')}<div class="inspector-stat"><strong>{tools.length}</strong><span>tool events</span></div><div class="inspector-list">{#each tools.slice(-30) as tool}<article><strong>{String(tool.toolName)}</strong><span>{String(tool.eventType ?? '')}</span></article>{/each}</div>
    {:else if view==='usage'}
      {@const total=report.usage?.total}
      <div class="inspector-stat"><strong>{total?.totalTokens ?? 0}</strong><span>total tokens</span><small>{costSummary(report)}</small></div>
      <div class="metric-grid"><div><strong>{total?.promptTokens ?? 0}</strong><span>prompt</span></div><div><strong>{total?.completionTokens ?? 0}</strong><span>completion</span></div></div>
    {:else if view==='diagnostics'}
      <div class="warning-copy"><strong>Sensitive trace data</strong><p>Enabling these controls may expose prompts, reasoning, or raw tool payloads on this device.</p></div>
      <div class="privacy-controls">
        <label><input type="checkbox" checked={privacy.messages} disabled={privacyPending || privacy.reasoning} on:change={(event)=>onprivacy({...privacy,messages:event.currentTarget.checked})}> Messages</label>
        <label><input type="checkbox" checked={privacy.reasoning} disabled={privacyPending} on:change={(event)=>onprivacy({...privacy,reasoning:event.currentTarget.checked,messages:event.currentTarget.checked || privacy.messages})}> Reasoning</label>
        <label><input type="checkbox" checked={privacy.rawToolPayloads} disabled={privacyPending} on:change={(event)=>onprivacy({...privacy,rawToolPayloads:event.currentTarget.checked})}> Raw tool payloads</label>
      </div>
    {/if}
    <button class="raw-toggle" on:click={() => rawVisible=!rawVisible}>{rawVisible ? 'Hide raw data' : 'View raw data'}</button>
    {#if rawVisible}<pre>{JSON.stringify(rawData(), null, 2)}</pre>{/if}
  {/if}
</aside>
