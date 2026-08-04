<script lang="ts">
  import type { ResolvedConfiguration } from './desktop';
  import { resolveComposerMode, type ComposerMode } from './workbench-ux';
  export let value = '';
  export let pending = false;
  export let disabled = false;
  export let status = '';
  export let configuration: ResolvedConfiguration | undefined;
  export let capacityAvailable = true;
  export let onsubmit: (kind: 'task' | 'chat') => void;
  let mode: ComposerMode = 'auto';
  let advanced = false;
  $: resolved = resolveComposerMode(mode, value);
</script>

<section class="center-card composer-view">
  <div class="view-heading"><div><span>Create</span><h2>What would you like to do?</h2><p>Start durable work or open a persistent conversation.</p></div></div>
  <div class="segmented" aria-label="Creation mode">{#each ['auto','task','chat'] as choice}<button class:active={mode===choice} on:click={() => mode=choice as ComposerMode}>{choice}</button>{/each}</div>
  <label for="new-composer">Prompt</label>
  <textarea id="new-composer" bind:value disabled={disabled} placeholder="Describe the outcome, question, or topic…"></textarea>
  <p class="composer-helper">{mode === 'auto' ? `Auto chooses Chat only for “chat:”, “discuss:”, or “talk about”; this will create a ${resolved}.` : mode === 'task' ? 'Task starts an execution run.' : 'Chat creates a title and opens the conversation.'}</p>
  <div class="unavailable-control" title="Attachments are not supported by the desktop backend"><button disabled>Attach</button><span>Attachments unavailable</span></div>
  <button class="advanced-toggle" on:click={() => advanced=!advanced}>Advanced {advanced ? '▴' : '▾'}</button>
  {#if advanced}<dl class="advanced-readonly"><dt>Agent</dt><dd>{configuration?.agent.name ?? 'Not resolved'}</dd><dt>Model</dt><dd>{configuration ? `${configuration.model.provider} / ${configuration.model.model}` : 'Not resolved'}</dd><dt>Runtime</dt><dd>{configuration?.runtime.mode ?? 'Not resolved'}</dd></dl>{/if}
  <div class="actions"><button class="primary" disabled={disabled || pending || !value.trim() || (resolved === 'task' && !capacityAvailable)} on:click={() => onsubmit(resolved)}>{resolved === 'task' ? 'Run task' : 'Create chat'}</button><span class="run-status">{resolved === 'task' && !capacityAvailable ? 'Task capacity is full' : status}</span></div>
</section>
