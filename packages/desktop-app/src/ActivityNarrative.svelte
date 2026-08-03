<script lang="ts">
  import { formatDuration, modelTiming, type ActivityEvent } from './activity';
  export let events: ActivityEvent[] = [];
  export let now = Date.now();
  $: timing = modelTiming(events, now);
</script>

{#if events.length}
  <section class="activity-block" aria-live="polite">
    <div class="model-timer">
      {#if timing.current}
        <strong>{timing.current.delegateName ?? 'Agent'} · {timing.current.provider ?? 'model'} / {timing.current.model ?? 'unknown'}</strong>
        <span>{formatDuration(timing.current.elapsedMs)} in progress</span>
      {:else}<strong>Model idle</strong>{/if}
      <span>{formatDuration(timing.completedMs)} model time</span>
    </div>
    <div class="narrative">
      {#each events as event (event.eventId)}
        <div><span>{event.runId === event.rootRunId ? 'Agent' : event.delegateName ?? 'Delegate'}</span><p>{event.message}{event.durationMs !== undefined ? ` · ${formatDuration(event.durationMs)}` : ''}</p></div>
      {/each}
    </div>
  </section>
{/if}
