<script lang="ts">
  import { onMount } from 'svelte';
  import {
    getDesktopState,
    reloadSettings,
    startRun,
    stopRun,
    subscribe,
    type DesktopState,
    type ProgressEvent,
  } from './desktop';

  let tab: 'run' | 'settings' = 'run';
  let task = '';
  let desktop: DesktopState = { status: 'starting', configurationValid: false };
  let progress: ProgressEvent[] = [];
  let finalValue: unknown;
  let finalError = '';
  let busyAction = false;

  const canSend = () => desktop.configurationValid && desktop.status === 'ready' && task.trim().length > 0 && !busyAction;

  onMount(() => {
    let unlisten = () => {};
    void subscribe(
      (event) => { progress = [...progress.slice(-19), event]; },
      (event) => {
        finalValue = event.result;
        finalError = event.error ?? '';
        busyAction = false;
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
    busyAction = true;
    try { await startRun(task.trim()); }
    catch (error) { finalError = String(error); busyAction = false; }
    await refresh();
  }

  async function stop() {
    busyAction = true;
    try { await stopRun(); }
    catch (error) { finalError = String(error); }
    busyAction = false;
    await refresh();
  }

  async function reload() {
    busyAction = true;
    finalError = '';
    try { desktop = await reloadSettings(); }
    catch (error) { finalError = String(error); }
    busyAction = false;
  }
</script>

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
      <textarea id="task" bind:value={task} disabled={!desktop.configurationValid || desktop.status !== 'ready'} placeholder="Describe the task for AdaptiveAgent…"></textarea>
      <div class="actions">
        <button class="primary" disabled={!canSend()} on:click={send}>Send</button>
        <button disabled={desktop.status !== 'running' && desktop.status !== 'stopping'} on:click={stop}>Stop</button>
        <span class="run-status">{desktop.activeRunId ? `Run ${desktop.activeRunId}` : desktop.status}</span>
      </div>

      {#if progress.length}
        <div class="progress" aria-live="polite">
          {#each progress as event}<div><span>{event.kind}</span>{event.message}</div>{/each}
        </div>
      {/if}
      {#if finalError}<div class="result error"><h2>Error</h2><pre>{finalError}</pre></div>{/if}
      {#if finalValue !== undefined}<div class="result"><h2>Result</h2><pre>{typeof finalValue === 'string' ? finalValue : JSON.stringify(finalValue, null, 2)}</pre></div>{/if}
    </section>
  {:else}
    <section class="panel settings">
      <div class="settings-title"><div><h2>Resolved configuration</h2><p>Read-only values loaded by the supervised runtime.</p></div><button disabled={busyAction || desktop.status === 'running'} on:click={reload}>Reload Settings</button></div>
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
