<script lang="ts">
  import { renderResult, type RenderedResult } from './result-renderer';

  export let value: unknown;
  let rendered: RenderedResult | undefined;
  let error = '';
  let sourceVisible = false;
  let generation = 0;
  $: source = rendered?.source ?? rawSource(value);

  $: void load(value);

  async function load(next: unknown) {
    const current = ++generation;
    rendered = undefined;
    error = '';
    try {
      const result = await renderResult(next);
      if (current === generation) rendered = result;
    } catch (cause) {
      if (current === generation) error = String(cause);
    }
  }

  function rawSource(next: unknown): string {
    if (typeof next === 'string') return next;
    try { return JSON.stringify(next, null, 2) ?? String(next); }
    catch { return '[Unable to serialize structured result]'; }
  }
</script>

<div class="result-renderer">
  <div class="result-renderer-tabs">
    <button class:active={!sourceVisible} on:click={() => sourceVisible = false}>Rendered</button>
    <button class:active={sourceVisible} on:click={() => sourceVisible = true}>Source</button>
  </div>
  {#if sourceVisible}
    <pre>{source}</pre>
  {:else if error}
    <pre>{error}</pre>
  {:else if !rendered}
    <p>Rendering result…</p>
  {:else}
    {#each rendered.warnings as warning}<div class="render-warning">{warning}</div>{/each}
    <div class="rendered-result">{@html rendered.html}</div>
  {/if}
</div>
