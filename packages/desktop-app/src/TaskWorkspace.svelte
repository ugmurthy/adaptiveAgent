<script lang="ts">
  import type { ActivityEvent } from './activity';
  import type { RunRecoveryPlan, RunSummary } from './desktop';
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
  export let recoveryPlan: RunRecoveryPlan | undefined;
  export let onselectrun: (runId: string) => void;
  export let onstop: (runId: string) => void;
  export let onrecover: (runId: string) => void;
  export let onsteer: (runId: string, message: string) => Promise<boolean>;
  export let ondelete: (target: {kind:'item';itemId:string}|{kind:'run';runId:string}) => void;
  export let ondecision: (run: RunSummary, approved: boolean) => void;
  export let oninspect: () => void;
  export let onshowtitle: (kind: 'task' | 'chat', title: string) => void;
  let steerMessage = '';
  let steerRunId = '';

  $: if (steerRunId !== selectedRun.runId) {
    steerRunId = selectedRun.runId;
    steerMessage = '';
  }

  $: recoveryLabel = recoveryPlan?.action === 'resume_same_run'
    ? 'Resume run'
    : recoveryPlan?.action === 'retry_same_run'
      ? 'Retry run'
      : '';

  async function submitSteer() {
    const message = steerMessage.trim();
    if (!message) return;
    if (await onsteer(selectedRun.runId, message)) steerMessage = '';
  }

  function output(value: unknown): unknown {
    if (value && typeof value === 'object' && 'status' in value && 'output' in value && value.status === 'success') return value.output;
    return value;
  }
</script>

<section class="center-card task-view">
  <div class="view-heading">
    <div><span>Task</span><h2><button class="title-trigger" aria-label="View full task description" on:click={() => onshowtitle('task', selectedRun.title)}>{selectedRun.title}</button></h2><p>Run {selectedRun.runId.slice(0,8)} · {selectedRun.status}</p></div>
    <button on:click={oninspect}>Inspector</button>
  </div>
  {#if attempts.length > 1}
    <div class="attempt-tabs">{#each attempts as run,index}<button class:active={run.runId===selectedRun.runId} on:click={()=>onselectrun(run.runId)}>Attempt {index+1} · {run.status}</button>{/each}</div>
  {/if}
  <div class="context-actions">
    {#if selectedRun.occupiesSlot}<button disabled={pending} on:click={()=>onstop(selectedRun.runId)}>{selectedRun.cancelRequested?'Retry stop':'Stop run'}</button>{/if}
    {#if !selectedRun.occupiesSlot && recoveryPlan?.executable && recoveryLabel}<button class="primary" disabled={pending} on:click={()=>onrecover(selectedRun.runId)}>{recoveryLabel}</button>{/if}
    <button class="danger ghost" disabled={pending || selectedRun.occupiesSlot} on:click={()=>ondelete({kind:'run',runId:selectedRun.runId})}>Delete run</button>
    <button class="danger ghost" disabled={pending || attempts.some((run)=>run.occupiesSlot)} on:click={()=>ondelete({kind:'item',itemId:selectedRun.itemId})}>Delete task</button>
  </div>
  {#if selectedRun.steerable}
    <div class="message-composer steer-composer"><label for="steer-message">Steer this run</label><textarea id="steer-message" bind:value={steerMessage} placeholder="Add guidance for the next model step"></textarea><div class="actions"><button disabled={pending || !steerMessage.trim()} on:click={submitSteer}>Send guidance</button></div></div>
  {:else if recoveryPlan}
    <div class="run-status">{recoveryPlan.reason}</div>
  {/if}
  {#each attempts.filter((run)=>run.pendingApproval) as run}<ApprovalCard {run} {pending} {ondecision}/>{/each}
  <ActivityNarrative events={activity} {now}/>
  {#if error}<div class="result error"><h3>Error</h3><pre>{error}</pre></div>{/if}
  {#if result !== undefined}<div class="result"><h3>Result</h3><ResultRenderer value={output(result)}/></div>{/if}
  {#if !activity.length && result === undefined && !error}<div class="empty-state"><strong>{selectedRun.occupiesSlot?'Working…':'No result available'}</strong><p>Live activity and the final result appear here.</p></div>{/if}
</section>
