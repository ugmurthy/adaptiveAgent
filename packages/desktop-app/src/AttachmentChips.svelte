<script lang="ts">
  import { type AttachmentDraft } from './desktop';
  import { desktopApi } from './desktop-context';

  const { discardAttachmentDraft, selectAttachments } = desktopApi();

  export let drafts: AttachmentDraft[] = [];
  export let disabled = false;
  export let onchange: (drafts: AttachmentDraft[]) => void;
  export let onerror: (message: string) => void = () => {};

  async function add() {
    try {
      const selected = await selectAttachments(drafts.map(({ id }) => id));
      onchange([...drafts, ...selected]);
    } catch (error) {
      onerror(String(error));
    }
  }

  async function remove(draft: AttachmentDraft) {
    try {
      await discardAttachmentDraft(draft.id);
      onchange(drafts.filter(({ id }) => id !== draft.id));
    } catch (error) {
      onerror(String(error));
    }
  }

  const size = (bytes: number) => bytes < 1024
    ? `${bytes} B`
    : bytes < 1_048_576
      ? `${(bytes / 1024).toFixed(1)} KiB`
      : `${(bytes / 1_048_576).toFixed(1)} MiB`;
</script>

<div class="attachment-control">
  <button type="button" {disabled} on:click={add}>Attach files</button>
  {#if drafts.length}
    <div class="attachment-chips" aria-label="Attachments">
      {#each drafts as draft (draft.id)}
        <span class="attachment-chip">
          <strong>{draft.name}</strong>
          <small>{draft.kind} · {size(draft.sizeBytes)}</small>
          <button aria-label={`Remove ${draft.name}`} disabled={disabled} on:click={() => remove(draft)}>×</button>
        </span>
      {/each}
    </div>
  {/if}
</div>
