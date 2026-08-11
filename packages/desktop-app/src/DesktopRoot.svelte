<script lang="ts">
  import App from './App.svelte';
  import AgentStudio from './AgentStudio.svelte';
  import { createDesktopApi, openAgentWorkspace, type DesktopApi } from './desktop';

  let agentId = '';
  let api: DesktopApi | undefined;
  async function openWorkspace(id: string) {
    const state = await openAgentWorkspace(id);
    if (state.agentId !== id) throw new Error(`Agent workspace mismatch: requested '${id}', received '${state.agentId}'.`);
    api = createDesktopApi(id);
    agentId = id;
  }
  function closeWorkspace() { agentId = ''; api = undefined; }
</script>

{#if agentId && api}
  <button class="studio-back" type="button" on:click={closeWorkspace} aria-label="Return to Agent Studio">← Agent Studio</button>
  {#key agentId}<App {api} />{/key}
{:else}
  <AgentStudio onOpen={openWorkspace} />
{/if}
