<script lang="ts">
  import { onMount } from 'svelte';
  import { addActivity, formatDuration, modelTiming, type ActivityEvent } from './activity';
  import {
    getDesktopState,
    createChat, listChats, loadChat, sendChatTurn,
    getRunResult,
    reloadSettings,
    quitCancel,
    quitTerminate,
    quitWait,
    startRun,
    stopRun,
    resolveApproval,
    selectTrace, getTracePrivacy, setTracePrivacy,
    subscribe,
    type DesktopState,
    type Chat,
    type TracePrivacy, type TraceReport,
  } from './desktop';

  let tab: 'run' | 'chat' | 'inspect' | 'settings' = 'run';
  let task = '';
  let desktop: DesktopState = { status: 'starting', configurationValid: false, runs: [], occupiedSlotCount: 0, capacity: 3, executionHealth: 'error', traceHealth: 'starting', quitState: 'idle' };
  let activityByRoot: Record<string, ActivityEvent[]> = {};
  let now = Date.now();
  let finalValue: unknown;
  let finalError = '';
  let startPending = false;
  let controlPending = false;
  let selectedRunId = '';
  let resultsByRun: Record<string, { result?: unknown; error?: string }> = {};
  let chats: Chat[] = [];
  let selectedChat: Chat | undefined;
  let chatMessage = '';
  let refreshGeneration = 0;
  let refreshScheduled = false;
  let traceRoot = '';
  let traceReport: TraceReport | undefined;
  let traceError = '';
  let traceView: 'overview'|'timeline'|'agents'|'tools'|'usage'|'diagnostics'|'sensitive' = 'overview';
  let tracePrivacy: TracePrivacy = { messages:false, reasoning:false, rawToolPayloads:false };
  let privacyPending = false;
  $: selectedActivity = selectedRunId ? activityByRoot[selectedRunId] ?? [] : [];
  $: selectedTiming = modelTiming(selectedActivity, now);

  const canSend = () => desktop.quitState === 'idle' && desktop.configurationValid && desktop.status !== 'error' && desktop.occupiedSlotCount < desktop.capacity && task.trim().length > 0 && !startPending;

  onMount(() => {
    let unlisten = () => {};
    let cancelled = false;
    const timer = window.setInterval(() => { now = Date.now(); }, 100);
    void (async () => {
    unlisten = await subscribe(
      (event) => { activityByRoot = addActivity(activityByRoot, event); },
      (event) => {
        const previous = resultsByRun[event.runId];
        resultsByRun = {
            ...resultsByRun,
            [event.runId]: {
              result: event.result === undefined ? previous?.result : event.result,
              error: event.error === undefined ? previous?.error : event.error,
            },
          };
        if (event.runId === selectedRunId) {
          finalValue = resultsByRun[event.runId]?.result;
          finalError = resultsByRun[event.runId]?.error ?? '';
        }
        scheduleRefresh();
      },
      (state) => { desktop = state; scheduleRefresh(); },
      (event) => {
        if (event.rootRunId !== traceRoot || privacyPending) return;
        traceReport = event.report;
        traceError = event.error ?? '';
      },
    );
    if (cancelled) unlisten(); else { await refresh(); tracePrivacy = await getTracePrivacy(); }
    })().catch((error) => { finalError = String(error); });
    return () => { cancelled = true; window.clearInterval(timer); unlisten(); };
  });

  function scheduleRefresh() {
    if (refreshScheduled) return;
    refreshScheduled = true;
    queueMicrotask(() => { refreshScheduled = false; void refresh(); });
  }

  async function refresh() {
    const generation = ++refreshGeneration;
    const selectedId = selectedChat?.itemId;
    try {
      const [nextDesktop, nextChats, nextChat] = await Promise.all([
        getDesktopState(), listChats(), selectedId ? loadChat(selectedId) : Promise.resolve(undefined),
      ]);
      if (generation !== refreshGeneration) return;
      desktop = nextDesktop; chats = nextChats;
      if (selectedId && selectedChat?.itemId === selectedId) selectedChat = nextChat;
    } catch (error) {
      if (generation === refreshGeneration) finalError = String(error);
    }
  }

  async function newChat() { try { selectedChat=await createChat('New chat'); selectedRunId=''; chats=await listChats(); tab='chat'; } catch(error){finalError=String(error);} }
  async function selectChat(itemId:string){selectedChat=await loadChat(itemId);selectedRunId=[...selectedChat.messages].reverse().find((message)=>message.runId)?.runId ?? '';}
  async function sendMessage(){if(!selectedChat||!chatMessage.trim())return; startPending=true; finalError=''; try{const started=await sendChatTurn(selectedChat.itemId,chatMessage.trim());selectedRunId=started.runId;chatMessage='';selectedChat=await loadChat(selectedChat.itemId);}catch(error){finalError=String(error);}startPending=false;await refresh();}

  async function send() {
    if (!canSend()) return;
    finalValue = undefined;
    finalError = '';
    startPending = true;
    try {
      const started = await startRun(task.trim());
      selectedRunId = started.runId;
      const early = resultsByRun[started.runId];
      finalValue = early?.result ?? await getRunResult(started.runId);
      finalError = early?.error ?? '';
      task = '';
    }
    catch (error) { finalError = String(error); }
    startPending = false;
    await refresh();
  }

  async function stop(runId: string) {
    controlPending = true;
    try { await stopRun(runId); }
    catch (error) { finalError = String(error); }
    controlPending = false;
    await refresh();
  }

  async function decide(run: import('./desktop').RunSummary, approved:boolean) {
    if (!run.pendingApproval) return;
    controlPending=true; finalError='';
    try { await resolveApproval(run.pendingApproval,approved); } catch(error) { finalError=String(error); }
    controlPending=false; await refresh();
  }

  async function selectRun(runId: string) {
    selectedRunId = runId;
    finalValue = resultsByRun[runId]?.result;
    finalError = resultsByRun[runId]?.error ?? '';
    const result = await getRunResult(runId);
    if (selectedRunId === runId) finalValue = result ?? resultsByRun[runId]?.result;
  }

  async function reload() {
    controlPending = true;
    finalError = '';
    try { desktop = await reloadSettings(); }
    catch (error) { finalError = String(error); }
    controlPending = false;
  }

  async function quit(action: 'wait' | 'terminate' | 'cancel') {
    controlPending = true;
    try {
      desktop = await (action === 'wait' ? quitWait() : action === 'terminate' ? quitTerminate() : quitCancel());
    } catch (error) { finalError = String(error); }
    controlPending = false;
  }

  function chatActivity(itemId:string): ActivityEvent[] {
    const occupied = desktop.runs.find((run) => run.itemId === itemId && run.occupiesSlot);
    const latestMessage = selectedChat?.itemId === itemId
      ? [...selectedChat.messages].reverse().find((message) => message.runId)
      : undefined;
    const root = occupied?.runId ?? latestMessage?.runId;
    return root ? activityByRoot[root] ?? [] : [];
  }

  async function savePrivacy(next: TracePrivacy) {
    privacyPending=true; traceReport=undefined; traceError='';
    try { tracePrivacy=await setTracePrivacy(next); }
    catch(error) { traceError=String(error); }
    privacyPending=false;
  }

  function costSummary(report: TraceReport): string {
    const total=report.usage?.total;
    const unpriced=report.diagnostics?.performance?.toolAccounting?.unpricedRequests ?? report.usage?.toolAccounting?.unpricedRequests ?? 0;
    const estimate=total?.estimatedCostUSD ?? 0;
    if (unpriced>0) return `${unpriced} unpriced request${unpriced===1?'':'s'}; $${estimate.toFixed(4)} is a partial estimate`;
    if ((total?.totalTokens ?? 0)>0 || estimate>0) return `Estimated cost $${estimate.toFixed(4)}`;
    return 'No priced usage recorded';
  }

  $: inspectionRoot = selectedRunId;
  $: if (inspectionRoot !== traceRoot) {
    traceRoot=inspectionRoot; traceReport=undefined; traceError='';
    void selectTrace(traceRoot || undefined).catch((error)=>{traceError=String(error);});
  }
</script>

{#if desktop.quitState === 'confirming'}
  <div class="quit-backdrop" role="presentation">
    <div class="quit-dialog" role="dialog" aria-modal="true" aria-labelledby="quit-title">
      <h2 id="quit-title">Runs are still active</h2>
      <p>Choose how AdaptiveAgent should finish before quitting.</p>
      <div class="actions">
        <button disabled={controlPending} on:click={() => quit('cancel')}>Cancel</button>
        <button disabled={controlPending} on:click={() => quit('wait')}>Wait for runs</button>
        <button class="danger" disabled={controlPending} on:click={() => quit('terminate')}>Terminate all and quit</button>
      </div>
    </div>
  </div>
{/if}

<main>
  <header>
    <div><span class="mark">A</span><div><h1>AdaptiveAgent</h1><p>Desktop runtime</p></div></div>
    <span class:good={desktop.status === 'ready'} class="status-dot">{desktop.status}</span>
  </header>

  <nav aria-label="Application sections">
    <button class:active={tab === 'run'} on:click={() => tab = 'run'}>Run</button>
    <button class:active={tab === 'chat'} on:click={() => tab = 'chat'}>Chat</button>
    <button class:active={tab === 'inspect'} on:click={() => tab = 'inspect'}>Inspector</button>
    <button class:active={tab === 'settings'} on:click={() => tab = 'settings'}>Settings</button>
  </nav>

  {#if tab === 'run'}
    <section class="panel">
      {#if desktop.configuration}
        <div class="summary">
          <strong>{desktop.configuration.agent.name}</strong>
          <span>{desktop.configuration.model.provider} / {desktop.configuration.model.model}</span>
          <span>{desktop.configuration.runtime.mode} · {desktop.configuration.inference.mode}</span>
        </div>
      {/if}
      {#if desktop.error}<div class="alert">{desktop.error}</div>{/if}
      <label for="task">Task</label>
      <textarea id="task" bind:value={task} disabled={!desktop.configurationValid || desktop.quitState !== 'idle'} placeholder="Describe the task for AdaptiveAgent…"></textarea>
      <div class="actions">
        <button class="primary" disabled={!canSend()} on:click={send}>Send</button>
        <span class="run-status">{desktop.occupiedSlotCount}/{desktop.capacity} slots occupied</span>
      </div>

      {#if desktop.runs.length}
        <div class="progress">
          {#each desktop.runs as run}
            <div>
              <button class:active={selectedRunId === run.runId} on:click={() => selectRun(run.runId)}>{run.runId.slice(0, 8)} · {run.status}</button>
              {#if run.occupiesSlot}<button disabled={controlPending} on:click={() => stop(run.runId)}>{run.cancelRequested ? 'Retry stop' : 'Stop'}</button>{/if}
              {#if run.pendingApproval}<div class="alert"><strong>{run.pendingApproval.toolName}</strong><p>{run.pendingApproval.message}</p><button disabled={controlPending || run.pendingApproval.decisionInFlight} on:click={()=>decide(run,true)}>Approve</button><button disabled={controlPending || run.pendingApproval.decisionInFlight} on:click={()=>decide(run,false)}>Reject</button></div>{/if}
            </div>
          {/each}
        </div>
      {/if}

      {#if selectedActivity.length}
        <div class="model-timer" aria-live="polite">
          {#if selectedTiming.current}
            <strong>{selectedTiming.current.delegateName ?? 'Agent'} · {selectedTiming.current.provider ?? 'model'} / {selectedTiming.current.model ?? 'unknown'}</strong>
            <span>{formatDuration(selectedTiming.current.elapsedMs)} in progress</span>
          {:else}<strong>Model idle</strong>{/if}
          <span>{formatDuration(selectedTiming.completedMs)} completed model time</span>
        </div>
        <div class="progress narrative" aria-live="polite">
          {#each selectedActivity as event (event.eventId)}<div><span>{event.runId === event.rootRunId ? 'Agent' : event.delegateName ?? 'Delegate'}</span>{event.message}{event.durationMs !== undefined ? ` · ${formatDuration(event.durationMs)}` : ''}</div>{/each}
        </div>
      {/if}
      {#if finalError}<div class="result error"><h2>Error</h2><pre>{finalError}</pre></div>{/if}
      {#if finalValue !== undefined}<div class="result"><h2>Result</h2><pre>{typeof finalValue === 'string' ? finalValue : JSON.stringify(finalValue, null, 2)}</pre></div>{/if}
    </section>
  {:else if tab === 'chat'}
    <section class="panel">
      <div class="settings-title"><div><h2>Chats</h2><p>Persistent transcripts pinned to their creating agent.</p></div><button disabled={!desktop.configurationValid || desktop.quitState !== 'idle'} on:click={newChat}>New chat</button></div>
      <div class="progress">{#each chats as chat}<button class:active={selectedChat?.itemId===chat.itemId} on:click={()=>selectChat(chat.itemId)}>{chat.title} · {chat.pinnedAgentName}</button>{/each}</div>
      {#if selectedChat}
        <div class="summary"><strong>{selectedChat.title}</strong><span>Pinned: {selectedChat.pinnedAgentName}</span><span>Session {selectedChat.sessionId.slice(0,8)}</span></div>
        {#if selectedChat.readOnlyReason}<div class="alert">{selectedChat.readOnlyReason}</div>{/if}
        <div class="progress" aria-live="polite">{#each selectedChat.messages as message}<div><strong>{message.role}</strong><span>{message.content}</span></div>{/each}</div>
        <label for="chat-message">Message</label><textarea id="chat-message" bind:value={chatMessage} disabled={!!selectedChat.readOnlyReason || selectedChat.occupied || desktop.quitState!=='idle'}></textarea>
        <div class="actions"><button class="primary" disabled={!chatMessage.trim() || !!selectedChat.readOnlyReason || selectedChat.occupied || startPending || desktop.occupiedSlotCount>=desktop.capacity} on:click={sendMessage}>Send</button><span>{selectedChat.occupied?'Turn in progress':'Ready'}</span></div>
        {#each desktop.runs.filter(run=>run.itemId===selectedChat?.itemId && run.pendingApproval) as run}<div class="alert"><strong>{run.pendingApproval!.toolName}</strong><p>{run.pendingApproval!.message}</p><button disabled={controlPending || run.pendingApproval!.decisionInFlight} on:click={()=>decide(run,true)}>Approve</button><button disabled={controlPending || run.pendingApproval!.decisionInFlight} on:click={()=>decide(run,false)}>Reject</button></div>{/each}
        {@const activity = chatActivity(selectedChat.itemId)}
        {@const timing = modelTiming(activity, now)}
        {#if activity.length}<div class="model-timer">{#if timing.current}<strong>{timing.current.delegateName ?? 'Agent'} · {timing.current.provider ?? 'model'} / {timing.current.model ?? 'unknown'}</strong><span>{formatDuration(timing.current.elapsedMs)} in progress</span>{/if}<span>{formatDuration(timing.completedMs)} completed model time</span></div><div class="progress narrative">{#each activity as event (event.eventId)}<div><span>{event.runId===event.rootRunId?'Agent':event.delegateName??'Delegate'}</span>{event.message}</div>{/each}</div>{/if}
      {/if}
      {#if finalError}<div class="result error"><pre>{finalError}</pre></div>{/if}
    </section>
  {:else if tab === 'inspect'}
    <section class="panel inspector">
      <div class="settings-title"><div><h2>Trace inspector</h2><p>Read-only durable execution evidence for {traceRoot ? traceRoot.slice(0,8) : 'the selected run'}.</p></div><span class:good={desktop.traceHealth==='ready'} class="status-dot">{desktop.traceHealth}</span></div>
      {#if desktop.traceError}<div class="alert">{desktop.traceError}</div>{/if}
      {#if traceError}<div class="alert">{traceError}</div>{/if}
      {#if !traceRoot}<div class="alert">Select a run or start a chat turn to inspect its trace.</div>{/if}
      <div class="inspector-tabs">
        {#each [['overview','Overview'],['timeline','Timeline'],['agents','Agents / run tree'],['tools','Tools'],['usage','Tokens and cost'],['diagnostics','Diagnostics'],['sensitive','Sensitive data']] as item}
          <button class:active={traceView===item[0]} on:click={()=>traceView=item[0] as typeof traceView}>{item[1]}</button>
        {/each}
      </div>
      {#if traceReport}
        {#if traceView==='overview'}
          <div class="summary"><strong>{traceReport.summary?.status ?? 'unknown'}</strong><span>{traceReport.summary?.reason ?? 'No summary available.'}</span></div>
          <pre>{JSON.stringify({rootRuns:traceReport.rootRuns,performance:traceReport.performance},null,2)}</pre>
        {:else if traceView==='timeline'}
          <pre>{JSON.stringify(traceReport.timeline ?? [],null,2)}</pre>
        {:else if traceView==='agents'}
          <pre>{JSON.stringify(traceReport.runTree ?? [],null,2)}</pre>
        {:else if traceView==='tools'}
          <pre>{JSON.stringify((traceReport.timeline ?? []).filter((entry)=>typeof entry.toolName==='string'),null,2)}</pre>
        {:else if traceView==='usage'}
          {@const total=traceReport.usage?.total}
          <div class="summary"><strong>{total?.totalTokens ?? 0} tokens</strong><span>{total?.promptTokens ?? 0} prompt · {total?.completionTokens ?? 0} completion · {total?.reasoningTokens ?? 0} reasoning</span><span>{costSummary(traceReport)}</span></div>
          <pre>{JSON.stringify(traceReport.usage,null,2)}</pre>
        {:else if traceView==='diagnostics'}
          <pre>{JSON.stringify(traceReport.diagnostics ?? {warnings:traceReport.warnings ?? [],performance:traceReport.performance},null,2)}</pre>
        {:else}
          <div class="privacy-controls">
            <label><input type="checkbox" checked={tracePrivacy.messages} disabled={privacyPending || tracePrivacy.reasoning} on:change={(event)=>savePrivacy({...tracePrivacy,messages:event.currentTarget.checked})}> Messages</label>
            <label><input type="checkbox" checked={tracePrivacy.reasoning} disabled={privacyPending} on:change={(event)=>savePrivacy({...tracePrivacy,reasoning:event.currentTarget.checked,messages:event.currentTarget.checked || tracePrivacy.messages})}> Reasoning</label>
            <label><input type="checkbox" checked={tracePrivacy.rawToolPayloads} disabled={privacyPending} on:change={(event)=>savePrivacy({...tracePrivacy,rawToolPayloads:event.currentTarget.checked})}> Raw tool payloads</label>
          </div>
          <pre>{JSON.stringify({messages:tracePrivacy.messages ? traceReport.llmMessages ?? [] : 'Disabled',reasoning:tracePrivacy.reasoning ? 'Included in authorized messages' : 'Disabled',rawToolPayloads:tracePrivacy.rawToolPayloads ? (traceReport.timeline ?? []).map(({params,output,eventType,runId,toolName})=>({eventType,runId,toolName,params,output})) : 'Disabled'},null,2)}</pre>
        {/if}
      {/if}
    </section>
  {:else}
    <section class="panel settings">
      <div class="settings-title"><div><h2>Resolved configuration</h2><p>Read-only values loaded by the supervised runtime.</p></div><button disabled={controlPending || desktop.status === 'running'} on:click={reload}>Reload Settings</button></div>
      <div class:valid={desktop.configurationValid} class="validity">{desktop.configurationValid ? 'Configuration valid' : 'Configuration invalid'}</div>
      {#if desktop.error}<div class="alert">{desktop.error}</div>{/if}
      {#if desktop.configuration}
        <dl>
          <dt>Agent</dt><dd>{desktop.configuration.agent.name} <small>{desktop.configuration.agent.id}</small></dd>
          <dt>Provider / model</dt><dd>{desktop.configuration.model.provider} / {desktop.configuration.model.model}</dd>
          <dt>Credential</dt><dd>{desktop.configuration.model.credentialAvailable ? 'Available' : 'Unavailable'} <small>value never exposed</small></dd>
          <dt>Inference</dt><dd>{desktop.configuration.inference.mode} · {desktop.configuration.inference.tier}</dd>
          <dt>Runtime</dt><dd>{desktop.configuration.runtime.mode}</dd>
          <dt>Workspace</dt><dd>{desktop.configuration.workspace.root}</dd>
          <dt>Shell directory</dt><dd>{desktop.configuration.workspace.shellCwd}</dd>
          <dt>Approval</dt><dd>{desktop.configuration.interaction.approvalMode}</dd>
          <dt>Clarification</dt><dd>{desktop.configuration.interaction.clarificationMode}</dd>
        </dl>
      {/if}
    </section>
  {/if}
</main>
