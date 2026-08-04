<script lang="ts">
  import { activityItems, formatDuration, modelTiming, toolSymbol, type ActivityEvent, type ActivityItem } from './activity';
  export let events: ActivityEvent[] = [];
  export let now = Date.now();
  let historyOpen = false;
  $: timing = modelTiming(events, now);
  $: items = activityItems(events);
  $: visibleItems = items.slice(-3);

  function closeOnEscape(event: KeyboardEvent) {
    if (historyOpen && event.key === 'Escape') historyOpen = false;
  }
</script>

<svelte:window on:keydown={closeOnEscape}/>

{#if events.length}
  <section class="activity-block" aria-live="polite">
    <div class="model-timer">
      {#if timing.current}
        <strong><i></i>Thinking…</strong>
        <span>{formatDuration(timing.current.elapsedMs)}</span>
      {:else}<strong>Activity</strong>{/if}
      <span>{formatDuration(timing.completedMs)} model time</span>
    </div>
    <button class="activity-window" type="button" aria-label={`Open all ${items.length} activity items`} on:click={() => { historyOpen = true; }}>
      <span class="activity-window-label">Live activity <small>{items.length} total · open history</small></span>
      <span class="activity-list compact">
      {#each visibleItems as item (item.key)}
        <span class="activity-arrival">{@render ActivityRow(item)}</span>
      {/each}
      </span>
    </button>
  </section>
{/if}

{#if historyOpen}
  <div class="modal-backdrop" role="presentation" on:click={(event) => { if (event.currentTarget === event.target) historyOpen = false; }}>
    <div class="modal activity-modal" role="dialog" aria-modal="true" aria-labelledby="activity-title">
      <header><div><span>Run timeline</span><h2 id="activity-title">All activity</h2></div><button aria-label="Close activity history" on:click={() => { historyOpen = false; }}>×</button></header>
      <div class="activity-list history">
        {#each items as item (item.key)}{@render ActivityRow(item)}{/each}
      </div>
    </div>
  </div>
{/if}

{#snippet ActivityRow(item: ActivityItem)}
  <span class:assistant-row={item.type === 'assistant'} class:tool-row={item.type === 'tool'} class="activity-row">
    {#if item.type === 'tool'}
      <span class="activity-symbol">{toolSymbol(item.toolName)}</span>
      <span class="activity-copy"><strong>{item.toolName}</strong>{#if item.toolContext}<small>{item.toolContext}</small>{/if}</span>
      <span class:failed={item.state === 'Failed'} class:approval={item.state === 'Approval'} class:running={item.state === 'Running'} class:skipped={item.state === 'Skipped'} class="tool-state">{item.state}</span>
    {:else}
      <span class="activity-actor">{item.type === 'assistant' ? '✦' : item.actor}</span>
      <span class="activity-copy"><span>{item.content}</span>{#if item.durationMs !== undefined}<small>{formatDuration(item.durationMs)}</small>{/if}</span>
    {/if}
  </span>
{/snippet}
