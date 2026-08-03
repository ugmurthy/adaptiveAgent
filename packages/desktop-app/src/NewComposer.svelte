<script lang="ts">
  export let kind: 'task' | 'chat';
  export let value = '';
  export let pending = false;
  export let disabled = false;
  export let status = '';
  export let onsubmit: () => void;
</script>

<section class="center-card composer-view">
  <div class="view-heading"><div><span>New {kind}</span><h2>{kind === 'task' ? 'What should the agent accomplish?' : 'Start a persistent conversation'}</h2><p>{kind === 'task' ? 'The task gets a durable run and can use any free execution slot.' : 'The conversation stays pinned to the current agent and keeps one stable session.'}</p></div></div>
  <label for="new-composer">{kind === 'task' ? 'Objective' : 'Conversation title'}</label>
  {#if kind === 'task'}
    <textarea id="new-composer" bind:value disabled={disabled} placeholder="Describe the outcome, constraints, and useful context…"></textarea>
  {:else}
    <input id="new-composer" bind:value disabled={disabled} placeholder="New chat">
  {/if}
  <div class="actions"><button class="primary" disabled={disabled || pending || !value.trim()} on:click={onsubmit}>{kind === 'task' ? 'Run task' : 'Create chat'}</button><span class="run-status">{status}</span></div>
</section>
