<script lang="ts">
  import { onMount } from 'svelte';
  import BrandMark from './BrandMark.svelte';
  import { aggregateRecentWork, agentsNeedingAttention, filterAndSortAgents, isLaunchable } from './agent-studio';
  import { getDesktopCatalogStatus, listenCatalogStatusChanged, type DesktopCatalogStatus } from './desktop';

  export let onOpen: (agentId: string) => Promise<void>;
  let catalog: DesktopCatalogStatus | undefined;
  let loading = true;
  let error = '';
  let query = '';
  let showArchived = false;
  let openingId = '';
  let refreshTimer: number | undefined;
  let refreshGeneration = 0;
  let disposed = false;
  $: agents = filterAndSortAgents(catalog?.agents ?? [], query, showArchived);
  $: recent = aggregateRecentWork(catalog?.agents ?? []);
  $: attention = agentsNeedingAttention(catalog?.agents ?? []);

  async function refresh() {
    const generation = ++refreshGeneration;
    try {
      const next = await getDesktopCatalogStatus();
      if (disposed || generation !== refreshGeneration) return;
      catalog = next; error = '';
    }
    catch (cause) { if (!disposed && generation === refreshGeneration) error = String(cause); }
    finally { if (!disposed && generation === refreshGeneration) loading = false; }
  }
  function scheduleRefresh() {
    if (refreshTimer !== undefined) return;
    refreshTimer = window.setTimeout(() => { refreshTimer = undefined; void refresh(); }, 120);
  }
  async function open(id: string) {
    openingId = id; error = '';
    try { await onOpen(id); } catch (cause) { error = String(cause); openingId = ''; }
  }
  const diagnosticText = (value: Record<string, unknown>) => typeof value.message === 'string' ? value.message : JSON.stringify(value);
  const date = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

  onMount(() => {
    let unlisten = () => {};
    void listenCatalogStatusChanged(scheduleRefresh).then((fn) => { if (disposed) fn(); else unlisten = fn; });
    void refresh();
    return () => { disposed = true; refreshGeneration += 1; unlisten(); if (refreshTimer !== undefined) clearTimeout(refreshTimer); };
  });
</script>

<main class="studio-shell">
  <header class="studio-header">
    <div class="brand"><BrandMark /><div><strong>Adaptive Agent</strong><span>Agent Studio</span></div></div>
    <button type="button" on:click={refresh} disabled={loading}>↻ Refresh</button>
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
    {#if loading && !catalog}<div class="studio-state" aria-live="polite">Loading agent catalog…</div>
    {:else if catalog}
      {#if agents.length}
        <section aria-labelledby="agents-heading"><h2 id="agents-heading">Agents <small>{agents.length}</small></h2>
          <div class="agent-grid">
            {#each agents as agent (agent.id)}
              <article class:agent-muted={agent.archived || agent.validationState !== 'valid'} class="agent-card">
                <header><span class="agent-avatar" aria-hidden="true">{agent.name.trim().charAt(0).toUpperCase() || 'A'}</span><div><h3>{agent.name}</h3><code>{agent.id}</code></div>{#if agent.archived}<span class="badge">Archived</span>{/if}</header>
                <p>{agent.description || 'No description provided.'}</p>
                <div class="agent-metrics"><span class="status-dot" class:good={agent.status === 'ready'}>{agent.status}</span><span>{agent.occupiedSlots}/{agent.capacity} runs</span>{#if agent.attention !== 'none'}<strong class="attention">{agent.attention} needs attention</strong>{/if}</div>
                <div class="card-recent"><strong>Recent work</strong>{#if agent.recentWork[0]}<span>{agent.recentWork[0].title}</span><small>{agent.recentWork[0].status} · {date(agent.recentWork[0].createdAt)}</small>{:else}<small>No recent work</small>{/if}</div>
                <button class="primary" type="button" disabled={!isLaunchable(agent) || openingId !== ''} on:click={() => open(agent.id)}>{openingId === agent.id ? 'Opening…' : 'Open workspace'}</button>
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
