<script lang="ts">
  import { onMount } from 'svelte';
  import {
    getDesktopState,
    getRunResult,
    reloadSettings,
    quitCancel,
    quitTerminate,
    quitWait,
    startRun,
    stopRun,
    subscribe,
    type DesktopState,
    type ProgressEvent,
  } from './desktop';

  let tab: 'run' | 'settings' = 'run';
  let task = '';
  let desktop: DesktopState = { status: 'starting', configurationValid: false, runs: [], occupiedSlotCount: 0, capacity: 3, executionHealth: 'error', traceHealth: 'starting', quitState: 'idle' };
  let progress: ProgressEvent[] = [];
  let finalValue: unknown;
  let finalError = '';
  let startPending = false;
  let controlPending = false;
  let selectedRunId = '';
  let resultsByRun: Record<string, { result?: unknown; error?: string }> = {};

  const canSend = () => desktop.quitState === 'idle' && desktop.configurationValid && desktop.status !== 'error' && desktop.occupiedSlotCount < desktop.capacity && task.trim().length > 0 && !startPending;

  onMount(() => {
    let unlisten = () => {};
    void subscribe(
      (event) => { progress = [...progress.slice(-19), event]; },
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
        void refresh();
      },
      (state) => { desktop = state; },
    ).then((fn) => { unlisten = fn; });
    void refresh();
    return () => unlisten();
  });

  async function refresh() {
    desktop = await getDesktopState();
  }

  async function send() {
    if (!canSend()) return;
    progress = [];
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
            </div>
          {/each}
        </div>
      {/if}

      {#if progress.length}
        <div class="progress" aria-live="polite">
          {#each progress.filter((event) => !selectedRunId || event.runId === selectedRunId) as event}<div><span>{event.kind}</span>{event.message}</div>{/each}
        </div>
      {/if}
      {#if finalError}<div class="result error"><h2>Error</h2><pre>{finalError}</pre></div>{/if}
      {#if finalValue !== undefined}<div class="result"><h2>Result</h2><pre>{typeof finalValue === 'string' ? finalValue : JSON.stringify(finalValue, null, 2)}</pre></div>{/if}
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
