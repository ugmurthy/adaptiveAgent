<script lang="ts">
  import { openArtifact, revealArtifact } from './desktop';

  export let artifacts: Array<{ path: string; detail?: string }> = [];
  let actionError = '';

  function baseName(path: string): string {
    return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
  }

  async function act(action: 'open' | 'reveal', path: string) {
    actionError = '';
    try {
      await (action === 'open' ? openArtifact(path) : revealArtifact(path));
    } catch (error) {
      actionError = String(error);
    }
  }
</script>

{#if actionError}<div class="alert">{actionError}</div>{/if}
<div class="artifact-grid">
  {#each artifacts as artifact (artifact.path)}
    <article title={artifact.path}>
      <strong>{baseName(artifact.path)}</strong>
      {#if artifact.detail}<small>{artifact.detail}</small>{/if}
      <div class="artifact-actions">
        <button on:click={() => act('open', artifact.path)}>Open</button>
        <button on:click={() => act('reveal', artifact.path)}>Show in Finder</button>
      </div>
    </article>
  {/each}
</div>
