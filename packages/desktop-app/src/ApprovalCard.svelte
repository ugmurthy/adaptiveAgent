<script lang="ts">
  import type { RunSummary } from './desktop';
  export let run: RunSummary;
  export let pending = false;
  export let ondecision: (run: RunSummary, approved: boolean) => void;
</script>

{#if run.pendingApproval}
  <section class="approval-card" aria-live="polite">
    <div><span>Approval required</span><strong>{run.pendingApproval.toolName}</strong></div>
    <p>{run.pendingApproval.message}</p>
    <div class="actions">
      <button class="primary" disabled={pending || run.pendingApproval.decisionInFlight} on:click={() => ondecision(run, true)}>Approve</button>
      <button disabled={pending || run.pendingApproval.decisionInFlight} on:click={() => ondecision(run, false)}>Reject</button>
    </div>
  </section>
{/if}
