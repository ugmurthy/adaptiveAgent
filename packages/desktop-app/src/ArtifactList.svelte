<script lang="ts">
  import { type ArtifactPreview } from './desktop';
  import { desktopApi } from './desktop-context';
  import ResultRenderer from './ResultRenderer.svelte';

  const { readArtifact } = desktopApi();

  export let artifacts: Array<{ path: string; detail?: string; runId?: string }> = [];
  export let runId: string | undefined = undefined;
  let preview: ArtifactPreview | undefined;
  let previewPath = '';
  let previewError = '';
  let loading = false;
  let generation = 0;

  function baseName(path: string): string {
    return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
  }

  async function show(path: string, artifactRunId?: string) {
    const current = ++generation;
    previewPath = path;
    preview = undefined;
    previewError = '';
    loading = true;
    try {
      const loaded = await readArtifact(path, artifactRunId ?? runId);
      if (current === generation) preview = loaded;
    } catch (error) {
      if (current === generation) previewError = String(error);
    } finally {
      if (current === generation) loading = false;
    }
  }

  function close() {
    generation += 1;
    previewPath = '';
    preview = undefined;
    previewError = '';
    loading = false;
  }

  function jsonValue(content: string): unknown {
    try { return JSON.parse(content); }
    catch { return content; }
  }
</script>

<svelte:window on:keydown={(event) => { if (event.key === 'Escape' && previewPath) close(); }} />

<div class="artifact-list">
  {#each artifacts as artifact (`${artifact.runId ?? runId ?? ''}:${artifact.path}`)}
    <button class="artifact-file" title={artifact.path} on:click={() => show(artifact.path, artifact.runId)}>{baseName(artifact.path)}</button>
  {/each}
</div>

{#if previewPath}
  <div class="modal-backdrop">
    <div class="modal artifact-preview-modal" role="dialog" aria-modal="true" aria-labelledby="artifact-preview-title">
      <header><div><span>Artifact preview</span><h2 id="artifact-preview-title">{preview?.name ?? baseName(previewPath)}</h2></div><button aria-label="Close artifact preview" on:click={close}>×</button></header>
      <div class="artifact-preview-content">
        {#if loading}<p>Loading preview…</p>
        {:else if previewError}<div class="alert">{previewError}</div>
        {:else if preview?.kind === 'markdown'}<ResultRenderer value={preview.content}/>
        {:else if preview?.kind === 'html'}<iframe class="artifact-html-preview" srcdoc={preview.content} sandbox="" title={preview.name}></iframe>
        {:else if preview?.kind === 'json'}<pre>{JSON.stringify(jsonValue(preview.content), null, 2)}</pre>
        {:else if preview?.kind === 'text'}<pre>{preview.content}</pre>
        {:else if preview?.kind === 'image'}<img src={`data:${preview.mimeType};base64,${preview.content}`} alt={preview.name} />
        {:else if preview?.kind === 'video'}<video src={`data:${preview.mimeType};base64,${preview.content}`} controls><track kind="captions" /></video>{/if}
      </div>
    </div>
  </div>
{/if}
