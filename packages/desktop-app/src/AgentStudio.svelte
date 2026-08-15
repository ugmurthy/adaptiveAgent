<script lang="ts">
  import { onMount } from 'svelte';
  import BrandMark from './BrandMark.svelte';
  import { aggregateRecentWork, agentsNeedingAttention, filterAndSortAgents, isInspectable } from './agent-studio';
  import { archiveAgentConfig, exportAgentConfig, generateAgentDraft, getDesktopCatalogStatus, listenCatalogStatusChanged, openAgentWindow, quitCancel, quitTerminate, quitWait, restoreAgentConfig, saveAgentConfig, validateAgentConfig, type AgentConfigPreview, type DesktopCatalogAgent, type DesktopCatalogStatus } from './desktop';

  let catalog: DesktopCatalogStatus | undefined;
  let loading = true;
  let error = '';
  let query = '';
  let showArchived = false;
  let openingId = '';
  let lifecycleId = '';
  let refreshTimer: number | undefined;
  let refreshRequested = false;
  let refreshTask: Promise<void> | undefined;
  let disposed = false;
  let builderOpen = false;
  let builderMode: 'describe' | 'json' = 'describe';
  let builderStep: 'input' | 'review' = 'input';
  let builderBrief = '';
  let builderJson = '';
  let builderNotes: string[] = [];
  let builderRecommendations: string[] = [];
  let builderPreview: AgentConfigPreview | undefined;
  let builderBusy = false;
  let builderError = '';
  let builderValidationGeneration = 0;
  $: agents = filterAndSortAgents(catalog?.agents ?? [], query, showArchived);
  $: recent = aggregateRecentWork(catalog?.agents ?? []);
  $: attention = agentsNeedingAttention(catalog?.agents ?? []);

  async function loadCatalog() {
    try {
      const next = await getDesktopCatalogStatus();
      if (disposed) return;
      catalog = next; error = next.error ?? '';
      if (next.loading) scheduleRefresh(500);
    }
    catch (cause) {
      if (!disposed) {
        error = String(cause);
        if (catalog?.loading) scheduleRefresh(500);
      }
    }
    finally { if (!disposed) loading = false; }
  }
  async function drainRefreshes() {
    try {
      while (refreshRequested && !disposed) {
        refreshRequested = false;
        await loadCatalog();
      }
    } finally {
      refreshTask = undefined;
      if (refreshRequested && !disposed) void refresh();
    }
  }
  function refresh(): Promise<void> {
    if (disposed) return Promise.resolve();
    refreshRequested = true;
    refreshTask ??= drainRefreshes();
    return refreshTask;
  }
  function scheduleRefresh(delay = 120) {
    if (refreshTimer !== undefined) return;
    refreshTimer = window.setTimeout(() => { refreshTimer = undefined; void refresh(); }, delay);
  }
  async function open(id: string) {
    openingId = id; error = '';
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try { await openAgentWindow(id); break; }
        catch (cause) {
          if (!String(cause).includes('is closing') || attempt === 4) throw cause;
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
      }
    } catch (cause) { error = String(cause); }
    finally { openingId = ''; }
  }
  async function quit(action: 'wait' | 'terminate' | 'cancel') {
    error = '';
    try {
      await (action === 'wait' ? quitWait() : action === 'terminate' ? quitTerminate() : quitCancel());
      await refresh();
    } catch (cause) { error = String(cause); }
  }
  async function exportProfile(agent: DesktopCatalogAgent) {
    lifecycleId = agent.id; error = '';
    try { await exportAgentConfig(agent.id, agent.configPath); }
    catch (cause) { error = String(cause); }
    finally { lifecycleId = ''; }
  }
  async function moveProfile(agent: DesktopCatalogAgent) {
    const action = agent.archived ? 'restore' : 'archive';
    if (!window.confirm(`${action === 'archive' ? 'Archive' : 'Restore'} ${agent.name}? ${action === 'archive' ? 'Its history and artifacts will remain available, but it cannot start new work until restored.' : 'It will be available for new work again.'}`)) return;
    lifecycleId = agent.id; error = '';
    try {
      await (agent.archived ? restoreAgentConfig(agent.id, agent.configPath) : archiveAgentConfig(agent.id, agent.configPath));
      await refresh();
    } catch (cause) { error = String(cause); }
    finally { lifecycleId = ''; }
  }
  function openBuilder(mode: 'describe' | 'json') {
    builderOpen = true; builderMode = mode; builderStep = 'input'; builderBrief = ''; builderJson = '';
    builderNotes = []; builderRecommendations = []; builderPreview = undefined; builderError = '';
  }
  function parseBuilderJson() {
    const value: unknown = JSON.parse(builderJson);
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Agent JSON must be an object.');
    return value as Record<string, unknown>;
  }
  async function prepareBuilder() {
    builderBusy = true; builderError = '';
    try {
      if (builderMode === 'describe') {
        const prepared = await generateAgentDraft(builderBrief);
        builderPreview = prepared; builderNotes = prepared.notes; builderRecommendations = prepared.recommendations;
        builderJson = JSON.stringify(prepared.agent, null, 2);
      } else {
        builderPreview = await validateAgentConfig(parseBuilderJson());
        builderNotes = []; builderRecommendations = [];
        builderJson = JSON.stringify(builderPreview.agent, null, 2);
      }
      builderStep = 'review';
    } catch (cause) { builderError = String(cause); }
    finally { builderBusy = false; }
  }
  async function revalidateBuilder() {
    const generation = ++builderValidationGeneration;
    builderBusy = true; builderError = '';
    try {
      const preview = await validateAgentConfig(parseBuilderJson());
      if (generation === builderValidationGeneration) builderPreview = preview;
    }
    catch (cause) { if (generation === builderValidationGeneration) { builderPreview = undefined; builderError = String(cause); } }
    finally { if (generation === builderValidationGeneration) builderBusy = false; }
  }
  function editedBuilderJson() { builderValidationGeneration += 1; builderPreview = undefined; builderError = ''; }
  async function saveBuilder() {
    builderBusy = true; builderError = '';
    try {
      const agent = parseBuilderJson();
      const preview = await validateAgentConfig(agent);
      builderPreview = preview;
      if (preview.duplicatePaths.length) throw new Error(`Choose a unique agent ID. It already exists at ${preview.duplicatePaths.join(', ')}.`);
      if (preview.exists && !window.confirm(`Overwrite the existing agent profile at ${preview.path}?`)) return;
      await saveAgentConfig(agent, undefined, preview.exists, preview.path, preview.targetFingerprint);
      builderOpen = false;
      await refresh();
    } catch (cause) { builderError = String(cause); }
    finally { builderBusy = false; }
  }
  const diagnosticText = (value: Record<string, unknown>) => typeof value.message === 'string' ? value.message : JSON.stringify(value);
  const date = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

  onMount(() => {
    let unlisten = () => {};
    void listenCatalogStatusChanged(scheduleRefresh).then((fn) => { if (disposed) fn(); else unlisten = fn; });
    void refresh();
    return () => { disposed = true; refreshRequested = false; unlisten(); if (refreshTimer !== undefined) clearTimeout(refreshTimer); };
  });
</script>

<main class="studio-shell">
  {#if catalog?.quitState === 'confirming'}
    <div class="modal-backdrop" role="presentation"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="studio-quit-title"><h2 id="studio-quit-title">Runs are still active</h2><p>Choose how AdaptiveAgent should finish before quitting.</p><div class="actions"><button on:click={() => quit('cancel')}>Cancel</button><button on:click={() => quit('wait')}>Wait for runs</button><button class="danger" on:click={() => quit('terminate')}>Terminate all and quit</button></div></div></div>
  {/if}
  {#if builderOpen}
    <div class="modal-backdrop" role="presentation">
      <div class="modal agent-builder" role="dialog" aria-modal="true" aria-labelledby="agent-builder-title">
        <header><div><span>Agent builder</span><h2 id="agent-builder-title">{builderStep === 'input' ? 'Create a specialist agent' : 'Review agent profile'}</h2></div><button type="button" aria-label="Close" on:click={() => builderOpen = false}>×</button></header>
        {#if builderStep === 'input'}
          <div class="builder-tabs"><button class:active={builderMode === 'describe'} on:click={() => builderMode = 'describe'}>Describe agent</button><button class:active={builderMode === 'json'} on:click={() => builderMode = 'json'}>Paste JSON</button></div>
          {#if builderMode === 'describe'}<label><span>Description</span><textarea rows="8" bind:value={builderBrief} placeholder="Build a security review agent that inspects TypeScript changes, explains risks, and recommends focused tests."></textarea></label>
          {:else}<label><span>Agent JSON</span><textarea class="code-editor" rows="16" bind:value={builderJson} placeholder={'{"version":1,"id":"security-reviewer",...}'}></textarea></label>{/if}
          <p class="builder-help">Description mode uses the existing <code>adaptive-agent agent-create</code> generation path. Nothing is written until you review and confirm.</p>
          {#if builderError}<div class="alert" role="alert">{builderError}</div>{/if}
          <div class="actions"><button on:click={() => builderOpen = false}>Cancel</button><button class="primary" disabled={builderBusy || (builderMode === 'describe' ? !builderBrief.trim() : !builderJson.trim())} on:click={prepareBuilder}>{builderBusy ? 'Preparing…' : 'Create draft'}</button></div>
        {:else}
          <div class="builder-summary"><div><span>Output path</span><code>{builderPreview?.path}</code></div><div><span>Status</span><strong>{builderPreview?.duplicatePaths.length ? 'Duplicate ID' : builderPreview?.exists ? 'Overwrite requires confirmation' : 'New profile'}</strong></div></div>
          <label><span>Review and edit JSON</span><textarea class="code-editor" rows="18" bind:value={builderJson} on:input={editedBuilderJson}></textarea></label>
          {#if builderNotes.length}<div class="builder-advice"><strong>Notes</strong><ul>{#each builderNotes as note}<li>{note}</li>{/each}</ul></div>{/if}
          {#if builderRecommendations.length}<div class="builder-advice"><strong>Recommendations</strong><ul>{#each builderRecommendations as recommendation}<li>{recommendation}</li>{/each}</ul></div>{/if}
          {#if builderPreview?.duplicatePaths.length}<div class="alert" role="alert">This ID is already used by {builderPreview.duplicatePaths.join(', ')}. Edit the ID and revalidate.</div>{/if}
          {#if builderError}<div class="alert" role="alert">{builderError}</div>{/if}
          <div class="actions"><button on:click={() => builderStep = 'input'}>Back</button><button disabled={builderBusy} on:click={revalidateBuilder}>Validate</button><button class="primary" disabled={builderBusy || !builderPreview || builderPreview.duplicatePaths.length > 0} on:click={saveBuilder}>{builderBusy ? 'Saving…' : builderPreview?.exists ? 'Confirm overwrite' : 'Save agent'}</button></div>
        {/if}
      </div>
    </div>
  {/if}
  <header class="studio-header">
    <div class="brand"><BrandMark /><div><strong>Adaptive Agent</strong><span>Agent Studio</span></div></div>
    <div class="studio-header-actions"><button type="button" on:click={() => openBuilder('json')}>Import JSON</button><button class="primary" type="button" on:click={() => openBuilder('describe')}>＋ New agent</button><button type="button" on:click={refresh} disabled={loading || catalog?.loading}>↻ Refresh</button></div>
  </header>
  <div class="studio-content">
    <section class="studio-hero" aria-labelledby="studio-title">
      <div><span>Fleet workspace</span><h1 id="studio-title">Agent Studio</h1><p>Monitor your agents and open a focused workspace.</p></div>
      <div class="studio-controls">
        <label><span>Search agents</span><input type="search" bind:value={query} placeholder="Name, description, or ID" /></label>
        <label class="archive-toggle"><input type="checkbox" bind:checked={showArchived} /> Show archived</label>
      </div>
    </section>
    {#if error}<div class="alert" role="alert">{error} <button type="button" on:click={refresh}>Try again</button></div>{/if}
    {#if (loading && !catalog) || catalog?.loading}<div class="studio-state" aria-live="polite">Loading agent catalog…</div>
    {:else if catalog}
      {#if agents.length}
        <section aria-labelledby="agents-heading"><h2 id="agents-heading">Agents <small>{agents.length}</small></h2>
          <div class="agent-grid">
            {#each agents as agent (agent.id)}
              <article class:agent-muted={agent.archived || agent.validationState !== 'valid'} class="agent-card">
                <header><span class="agent-avatar" aria-hidden="true">{agent.name.trim().charAt(0).toUpperCase() || 'A'}</span><div><h3>{agent.name}</h3><code>{agent.id}</code></div>{#if agent.archived}<span class="badge">Archived</span>{/if}<details class="agent-actions"><summary aria-label={`Actions for ${agent.name}`}>•••</summary><div><button type="button" disabled={lifecycleId !== '' || agent.validationState !== 'valid'} on:click={() => exportProfile(agent)}>Export JSON</button><button type="button" class:danger={!agent.archived} title={!agent.archived && catalog.currentAgentId === agent.id ? 'Select another startup agent before archiving this profile.' : undefined} disabled={lifecycleId !== '' || agent.validationState !== 'valid' || (!agent.archived && catalog.currentAgentId === agent.id)} on:click={() => moveProfile(agent)}>{agent.archived ? 'Restore agent' : 'Archive agent'}</button></div></details></header>
                <p>{agent.description || 'No description provided.'}</p>
                <div class="agent-metrics"><span class="status-dot" class:good={agent.status === 'ready'}>{agent.status}</span><span>{agent.occupiedSlots}/{agent.capacity} runs</span>{#if agent.attention !== 'none'}<strong class="attention">{agent.attention} needs attention</strong>{/if}</div>
                <div class="card-recent"><strong>Recent work</strong>{#if agent.recentWork[0]}<span>{agent.recentWork[0].title}</span><small>{agent.recentWork[0].status} · {date(agent.recentWork[0].createdAt)}</small>{:else}<small>No recent work</small>{/if}</div>
                <button class="primary" type="button" disabled={!isInspectable(agent) || openingId !== '' || lifecycleId !== ''} on:click={() => open(agent.id)}>{openingId === agent.id ? 'Opening…' : agent.archived ? 'Inspect history' : 'Open workspace'}</button>
                {#if agent.validationState !== 'valid'}<small class="invalid-copy">Configuration: {agent.validationState}. Resolve diagnostics before opening.</small>{/if}
              </article>
            {/each}
          </div>
        </section>
      {:else}<div class="studio-state"><h2>No agents found</h2><p>{query ? 'Try a different search or filter.' : 'No active agents are configured.'}</p></div>{/if}
      <div class="studio-lower">
        <section><h2>Needs attention</h2>{#if attention.length}<div class="studio-list">{#each attention as agent}<article><strong>{agent.name}</strong><span>{agent.attention}</span><small>{agent.status} · {agent.occupiedSlots}/{agent.capacity} runs</small></article>{/each}</div>{:else}<p class="empty-copy">Everything looks clear.</p>{/if}</section>
        <section><h2>Recent work</h2>{#if recent.length}<div class="studio-list">{#each recent as work}<article><strong>{work.title}</strong><span>{work.agentName}</span><small>{work.status} · {date(work.createdAt)}</small></article>{/each}</div>{:else}<p class="empty-copy">No work has been recorded yet.</p>{/if}</section>
      </div>
      <details class="diagnostics-panel" open={catalog.diagnostics.length > 0}><summary>Catalog diagnostics <span>{catalog.diagnostics.length}</span></summary>{#if catalog.diagnostics.length}<ul>{#each catalog.diagnostics as diagnostic}<li>{diagnosticText(diagnostic)}</li>{/each}</ul>{:else}<p>No catalog diagnostics.</p>{/if}</details>
    {/if}
  </div>
</main>
