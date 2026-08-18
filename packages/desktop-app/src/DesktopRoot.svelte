<script lang="ts">
  import App from './App.svelte';
  import AgentStudio from './AgentStudio.svelte';
  import { onMount } from 'svelte';
  import { createDesktopApi, desktopWindowBootstrap, type DesktopApi, type WindowPresentation } from './desktop';

  let mode: 'loading' | 'studio' | 'agent' | 'error' = 'loading';
  let agentId = '';
  let api: DesktopApi | undefined;
  let presentation: WindowPresentation | undefined;
  let error = '';

  onMount(() => {
    let disposed = false;
    void desktopWindowBootstrap().then((bootstrap) => {
      if (disposed) return;
      if (bootstrap.kind === 'studio') { mode = 'studio'; return; }
      if (!bootstrap.agentId || bootstrap.state?.agentId !== bootstrap.agentId) throw new Error('Agent window bootstrap did not match its native window context.');
      agentId = bootstrap.agentId;
      api = createDesktopApi(agentId);
      presentation = bootstrap.presentation;
      mode = 'agent';
    }).catch((cause) => { if (!disposed) { error = String(cause); mode = 'error'; } });
    return () => { disposed = true; };
  });
</script>

{#if mode === 'loading'}<main class="studio-shell"><div class="studio-state">Opening AdaptiveAgent…</div></main>
{:else if mode === 'error'}<main class="studio-shell"><div class="alert" role="alert">{error}</div></main>
{:else if mode === 'agent' && agentId && api}{#key agentId}<App {api} initialPresentation={presentation} />{/key}
{:else}<AgentStudio />{/if}
