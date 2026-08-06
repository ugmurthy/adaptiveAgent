<script lang="ts">
  import type { ActivityEvent } from './activity';
  import { getRunOverview, listWorkspaceArtifacts, type RunRecoveryPlan, type RunSummary } from './desktop';
  import ActivityNarrative from './ActivityNarrative.svelte';
  import ArtifactList from './ArtifactList.svelte';
  import ApprovalCard from './ApprovalCard.svelte';
  import ResultRenderer from './ResultRenderer.svelte';
  import { extractResultArtifacts, recoveryActionLabel, resolveResultArtifactPaths, resultDisplayContent, type ResultArtifact } from './workbench-ux';

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
  export let onrecover: (plan: RunRecoveryPlan) => void;
  export let onsteer: (runId: string, message: string) => Promise<boolean>;
  export let ondelete: (target: {kind:'item';itemId:string}|{kind:'run';runId:string}) => void;
  export let ondecision: (run: RunSummary, approved: boolean) => void;
  export let onshowtitle: (kind: 'task' | 'chat', title: string) => void;
  let steerMessage = '';
  let steerRunId = '';
  let reportTab: 'result'|'artifacts' = 'result';
  let resolvedArtifacts: ResultArtifact[] = [];
  let artifactRunId = '';
  let artifactError = '';
  let exportOpen = false;
  let exportError = '';

  $: if (steerRunId !== selectedRun.runId) {
    steerRunId = selectedRun.runId;
    steerMessage = '';
    reportTab = 'result';
    artifactRunId = '';
    resolvedArtifacts = [];
    artifactError = '';
  }

  $: recoveryLabel = recoveryPlan?.runId === selectedRun.runId && recoveryPlan.status === selectedRun.status
    ? recoveryActionLabel(recoveryPlan)
    : '';
  $: resultValue = output(result);
  $: artifacts = extractResultArtifacts(resultValue);
  $: displayedResult = resultDisplayContent(resultValue);

  async function submitSteer() {
    const message = steerMessage.trim();
    if (!message) return;
    if (await onsteer(selectedRun.runId, message)) steerMessage = '';
  }

  function output(value: unknown): unknown {
    if (value && typeof value === 'object' && 'status' in value && 'output' in value && value.status === 'success') return value.output;
    return value;
  }

  function download(text: string, extension: 'json' | 'md', type: string) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `adaptive-agent-${selectedRun.runId.slice(0,8)}.${extension}`; anchor.click();
    URL.revokeObjectURL(url);
  }

  async function exportOverview() {
    exportError = '';
    try {
      const overview = await getRunOverview(selectedRun.runId);
      download(JSON.stringify(overview, null, 2), 'json', 'application/json;charset=utf-8');
      exportOpen = false;
    } catch (error) {
      exportError = String(error);
    }
  }

  function exportMarkdown() {
    const value = displayedResult;
    const markdown = typeof value === 'string' ? value : `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
    download(markdown, 'md', 'text/markdown;charset=utf-8');
    exportOpen = false;
  }

  async function selectReportTab(tab: typeof reportTab) {
    reportTab = tab;
    if (tab !== 'artifacts' || artifactRunId === selectedRun.runId) return;
    artifactRunId = selectedRun.runId;
    artifactError = '';
    try {
      resolvedArtifacts = resolveResultArtifactPaths(artifacts, await listWorkspaceArtifacts());
    } catch (error) {
      artifactError = String(error);
      resolvedArtifacts = [];
    }
  }
</script>

<section class="center-card task-view">
  <div class="view-heading task-header">
    <div><span>{selectedRun.occupiesSlot ? 'Live task' : 'Completed task'}</span><h2><button class="title-trigger" title={selectedRun.title} aria-label={`View full task description: ${selectedRun.title}`} on:click={() => onshowtitle('task', selectedRun.title)}>{selectedRun.title}</button></h2><p>Run {selectedRun.runId.slice(0,8)} · <strong class="status-label">{selectedRun.status}</strong></p></div>
    {#if result !== undefined}<details class="export-menu" bind:open={exportOpen}><summary>Export</summary><div><button on:click={exportOverview}>Run Overview (.json)</button><button on:click={exportMarkdown}>Final result (.md)</button></div></details>{/if}
  </div>
  {#if exportError}<div class="alert">{exportError}</div>{/if}
  {#if attempts.length > 1}
    <div class="attempt-tabs">{#each attempts as run,index}<button class:active={run.runId===selectedRun.runId} on:click={()=>onselectrun(run.runId)}>Attempt {index+1} · {run.status}</button>{/each}</div>
  {/if}
  <div class="context-actions">
    {#if selectedRun.occupiesSlot}<button disabled={pending} on:click={()=>onstop(selectedRun.runId)}>{selectedRun.cancelRequested?'Retry stop':'Stop run'}</button>{/if}
    {#if !selectedRun.occupiesSlot && recoveryPlan?.executable && recoveryLabel}<button class="primary" disabled={pending} on:click={()=>onrecover(recoveryPlan)}>{recoveryLabel}</button>{/if}
    <button class="danger ghost" disabled={pending || attempts.some((run)=>run.occupiesSlot)} on:click={()=>ondelete({kind:'item',itemId:selectedRun.itemId})}>Delete task</button>
  </div>
  {#if selectedRun.steerable}
    <div class="message-composer steer-composer"><label for="steer-message">Steer active run</label><p class="composer-helper">Guidance affects the next model step; it does not rewrite completed work.</p><textarea id="steer-message" bind:value={steerMessage} placeholder="Add guidance for the next model step"></textarea><div class="actions"><button disabled={pending || !steerMessage.trim()} on:click={submitSteer}>Send guidance</button></div></div>
  {:else if recoveryPlan}
    <div class="run-status">{recoveryPlan.reason}</div>
  {/if}
  {#each attempts.filter((run)=>run.pendingApproval) as run}<ApprovalCard {run} {pending} {ondecision}/>{/each}
  {#if error}<div class="result error"><h3>Error</h3><pre>{error}</pre></div>{/if}
  {#if !selectedRun.occupiesSlot && result !== undefined}
    <div class="report-tabs">{#each ['result','artifacts'] as tab}<button class:active={reportTab===tab} on:click={() => selectReportTab(tab as typeof reportTab)}>{tab}</button>{/each}</div>
    <div class="completed-report">
      {#if reportTab==='result'}<ResultRenderer value={displayedResult}/>
      {:else if artifactError}<div class="alert">{artifactError}</div>
      {:else if resolvedArtifacts.length}<ArtifactList artifacts={resolvedArtifacts}/>{:else}<div class="empty-state"><strong>No structured artifacts</strong><p>The result did not include recognizable files or an artifacts/files array.</p></div>{/if}
    </div>
  {:else}<ActivityNarrative events={activity} {now}/>{/if}
  {#if !activity.length && result === undefined && !error}<div class="empty-state"><strong>{selectedRun.occupiesSlot?'Working…':'No result available'}</strong><p>Live activity and the final result appear here.</p></div>{/if}
</section>
