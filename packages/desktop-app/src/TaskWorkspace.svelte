<script lang="ts">
  import type { ActivityEvent } from './activity';
  import type { RunSummary } from './desktop';
  import ActivityNarrative from './ActivityNarrative.svelte';
  import ApprovalCard from './ApprovalCard.svelte';
  import ResultRenderer from './ResultRenderer.svelte';

  export let attempts: RunSummary[] = [];
  export let selectedRun: RunSummary;
  export let activity: ActivityEvent[] = [];
  export let now = Date.now();
  export let result: unknown;
  export let error = '';
  export let pending = false;
  export let onselectrun: (runId: string) => void;
  export let onstop: (runId: string) => void;
  export let ondelete: (target: {kind:'item';itemId:string}|{kind:'run';runId:string}) => void;
  export let ondecision: (run: RunSummary, approved: boolean) => void;
  export let oninspect: () => void;

  function output(value: unknown): unknown {
    if (value && typeof value === 'object' && 'status' in value && 'output' in value && value.status === 'success') return value.output;
    return value;
  }
</script>

<section class="center-card task-view">
  <div class="view-heading">
    <div><span>Task</span><h2>{selectedRun.title}</h2><p>Run {selectedRun.runId.slice(0,8)} · {selectedRun.status}</p></div>
    <button on:click={oninspect}>Inspector</button>
  </div>
  {#if attempts.length > 1}
    <div class="attempt-tabs">{#each attempts as run,index}<button class:active={run.runId===selectedRun.runId} on:click={()=>onselectrun(run.runId)}>Attempt {index+1} · {run.status}</button>{/each}</div>
  {/if}
  <div class="context-actions">
    {#if selectedRun.occupiesSlot}<button disabled={pending} on:click={()=>onstop(selectedRun.runId)}>{selectedRun.cancelRequested?'Retry stop':'Stop run'}</button>{/if}
    <button class="danger ghost" disabled={pending || selectedRun.occupiesSlot} on:click={()=>ondelete({kind:'run',runId:selectedRun.runId})}>Delete run</button>
    <button class="danger ghost" disabled={pending || attempts.some((run)=>run.occupiesSlot)} on:click={()=>ondelete({kind:'item',itemId:selectedRun.itemId})}>Delete task</button>
  </div>
  {#each attempts.filter((run)=>run.pendingApproval) as run}<ApprovalCard {run} {pending} {ondecision}/>{/each}
  <ActivityNarrative events={activity} {now}/>
  {#if error}<div class="result error"><h3>Error</h3><pre>{error}</pre></div>{/if}
  {#if result !== undefined}<div class="result"><h3>Result</h3><ResultRenderer value={output(result)}/></div>{/if}
  {#if !activity.length && result === undefined && !error}<div class="empty-state"><strong>{selectedRun.occupiesSlot?'Working…':'No result available'}</strong><p>Live activity and the final result appear here.</p></div>{/if}
</section>
