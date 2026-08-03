<script lang="ts">
  import type { DesktopState } from './desktop';
  export let desktop: DesktopState;
  export let pending = false;
  export let onreload: () => void;
</script>

<section class="center-card settings-view">
  <div class="view-heading"><div><span>Configuration</span><h2>Settings & sidecars</h2><p>Resolved read-only values. Credentials remain native.</p></div><button disabled={pending || desktop.status==='running'} on:click={onreload}>Reload settings</button></div>
  <div class="health-grid">
    <div><span>Execution</span><strong>{desktop.executionHealth}</strong></div>
    <div><span>Trace</span><strong>{desktop.traceHealth}</strong><small>{desktop.traceError ?? 'Read-only inspector sidecar'}</small></div>
    <div><span>Configuration</span><strong>{desktop.configurationValid?'Valid':'Invalid'}</strong></div>
  </div>
  {#if desktop.error}<div class="alert">{desktop.error}</div>{/if}
  {#if desktop.configuration}
    <dl>
      <dt>Agent</dt><dd>{desktop.configuration.agent.name} <small>{desktop.configuration.agent.id}</small></dd>
      <dt>Provider / model</dt><dd>{desktop.configuration.model.provider} / {desktop.configuration.model.model}</dd>
      <dt>Credential</dt><dd>{desktop.configuration.model.credentialAvailable ? 'Available' : 'Unavailable'} <small>value never exposed</small></dd>
      <dt>Inference</dt><dd>{desktop.configuration.inference.mode} · {desktop.configuration.inference.tier}</dd>
      <dt>Runtime</dt><dd>{desktop.configuration.runtime.mode}</dd>
      <dt>Workspace</dt><dd>{desktop.configuration.workspace.root}</dd>
      <dt>Shell directory</dt><dd>{desktop.configuration.workspace.shellCwd}</dd>
      <dt>Approval</dt><dd>{desktop.configuration.interaction.approvalMode}</dd>
      <dt>Clarification</dt><dd>{desktop.configuration.interaction.clarificationMode}</dd>
    </dl>
  {/if}
</section>
