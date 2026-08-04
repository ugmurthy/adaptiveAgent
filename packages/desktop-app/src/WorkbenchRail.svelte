<script lang="ts">
  import { filterRailItems, type RailGroup, type RailItem, type WorkbenchSelection } from './workbench-state';

  export let items: RailItem[] = [];
  export let selection: WorkbenchSelection;
  export let occupied = 0;
  export let capacity = 3;
  export let mobileOpen = false;
  export let onselect: (item: RailItem) => void;
  export let onnewtask: () => void;
  export let onnewchat: () => void;
  export let onsettings: () => void;
  export let onclose: () => void;
  const groups: RailGroup[] = ['Active', 'Needs input', 'History'];
  let query = '';
  $: filteredItems = filterRailItems(items, query);

  function selected(item: RailItem): boolean {
    return (selection.kind === 'task' || selection.kind === 'chat') && selection.itemId === item.id;
  }

  function historyDate(item: RailItem): string {
    const date = new Date(Number(item.createdAt));
    return Number.isNaN(date.valueOf())
      ? 'Earlier'
      : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
  }
</script>

<aside class:mobile-open={mobileOpen} class="workbench-rail" aria-label="Tasks and chats">
  <div class="rail-heading"><div><span class="mark">A</span><strong>AdaptiveAgent</strong></div><button class="rail-close" aria-label="Close navigation" on:click={onclose}>×</button></div>
  <div class="rail-composer">
    <button class="primary" on:click={onnewtask}>+ New task</button>
    <button on:click={onnewchat}>+ New chat</button>
  </div>
  <div class="slot-meter"><span>{occupied}/{capacity} slots</span><progress max={capacity} value={occupied}></progress></div>
  <label class="rail-search">
    <span class="sr-only">Search task and chat descriptions</span>
    <input bind:value={query} type="search" placeholder="Search history" aria-label="Search task and chat descriptions" />
  </label>
  <div class="rail-groups">
    {#each groups as group}
      {@const grouped = filteredItems.filter((item) => item.group === group)}
      {#if grouped.length}
        <section>
          <h2>{group}</h2>
          {#each grouped as item, index (item.id)}
            {#if group === 'History' && (index === 0 || historyDate(item) !== historyDate(grouped[index - 1]))}
              <h3 class="rail-date">{historyDate(item)}</h3>
            {/if}
              <button class:active={selected(item)} class="rail-item" on:click={() => onselect(item)}>
                <span class:item-active={item.group === 'Active'} class:item-input={item.group === 'Needs input'} class="item-dot"></span>
                <span><strong>{item.title}</strong><small>{item.kind} · {item.status}</small></span>
              </button>
            {/each}
        </section>
      {/if}
    {/each}
    {#if !items.length}<p class="empty-copy">Tasks and conversations will stay here.</p>
    {:else if !filteredItems.length}<p class="empty-copy">No tasks or chats match “{query}”.</p>{/if}
  </div>
  <button class:active={selection.kind === 'settings'} class="rail-settings" on:click={onsettings}>Settings & health</button>
</aside>
