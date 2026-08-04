<script lang="ts">
  import type { DesktopState, TracePrivacy, TraceReport } from './desktop';
  export let desktop: DesktopState;
  export let root = '';
  export let report: TraceReport | undefined;
  export let error = '';
  export let privacy: TracePrivacy;
  export let privacyPending = false;
  export let onprivacy: (privacy: TracePrivacy) => void;
  export let onclose: () => void;
  let view: 'overview'|'timeline'|'agents'|'tools'|'usage'|'diagnostics'|'sensitive' = 'overview';

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
</script>

<aside class="run-inspector" aria-label="Run inspector">
  <header><div><span>Inspector</span><strong>{root ? root.slice(0,8) : 'No run selected'}</strong></div><button aria-label="Close inspector" on:click={onclose}>×</button></header>
  <div class="health-line"><span class:good={desktop.traceHealth==='ready'} class="status-dot">Trace {desktop.traceHealth}</span><small>Read only</small></div>
  {#if desktop.traceError}<div class="alert">{desktop.traceError}</div>{/if}
  {#if error}<div class="alert">{error}</div>{/if}
  {#if !root}<p class="empty-copy">Select a task attempt or chat turn to inspect durable evidence.</p>{/if}
  <div class="inspector-tabs">
    {#each [['overview','Overview'],['timeline','Timeline'],['agents','Agents'],['tools','Tools'],['usage','Usage'],['diagnostics','Diagnostics'],['sensitive','Sensitive']] as item}
      <button class:active={view===item[0]} on:click={()=>view=item[0] as typeof view}>{item[1]}</button>
    {/each}
  </div>
  {#if report}
    {#if view==='overview'}
      <div class="summary"><strong>{report.summary?.status ?? 'unknown'}</strong><span>{report.summary?.reason ?? 'No summary available.'}</span></div>
      <pre>{JSON.stringify({rootRuns:report.rootRuns,performance:report.performance},null,2)}</pre>
    {:else if view==='timeline'}
      <pre>{JSON.stringify(report.timeline ?? [],null,2)}</pre>
    {:else if view==='agents'}
      <pre>{JSON.stringify(report.runTree ?? [],null,2)}</pre>
    {:else if view==='tools'}
      <pre>{JSON.stringify((report.timeline ?? []).filter((entry)=>typeof entry.toolName==='string'),null,2)}</pre>
    {:else if view==='usage'}
      {@const total=report.usage?.total}
      <div class="inspector-stat"><strong>{total?.totalTokens ?? 0}</strong><span>total tokens</span><small>{costSummary(report)}</small></div>
      <pre>{JSON.stringify(report.usage,null,2)}</pre>
    {:else if view==='diagnostics'}
      <pre>{JSON.stringify(report.diagnostics ?? {warnings:report.warnings ?? [],performance:report.performance},null,2)}</pre>
    {:else}
      <div class="privacy-controls">
        <label><input type="checkbox" checked={privacy.messages} disabled={privacyPending || privacy.reasoning} on:change={(event)=>onprivacy({...privacy,messages:event.currentTarget.checked})}> Messages</label>
        <label><input type="checkbox" checked={privacy.reasoning} disabled={privacyPending} on:change={(event)=>onprivacy({...privacy,reasoning:event.currentTarget.checked,messages:event.currentTarget.checked || privacy.messages})}> Reasoning</label>
        <label><input type="checkbox" checked={privacy.rawToolPayloads} disabled={privacyPending} on:change={(event)=>onprivacy({...privacy,rawToolPayloads:event.currentTarget.checked})}> Raw tool payloads</label>
      </div>
      <pre>{JSON.stringify({messages:privacy.messages ? report.llmMessages ?? [] : 'Disabled',reasoning:privacy.reasoning ? 'Included in authorized messages' : 'Disabled',rawToolPayloads:privacy.rawToolPayloads ? (report.timeline ?? []).map(({params,output,eventType,runId,toolName})=>({eventType,runId,toolName,params,output})) : 'Disabled'},null,2)}</pre>
    {/if}
  {/if}
</aside>
