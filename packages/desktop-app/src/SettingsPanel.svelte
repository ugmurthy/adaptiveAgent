<script lang="ts">
  import type { DesktopState, EditableDesktopSettings, ResolvedConfiguration } from './desktop';
  export let desktop: DesktopState;
  export let pending = false;
  export let error = '';
  export let onreload: () => void;
  export let onsave: (settings: EditableDesktopSettings) => void;

  let loadedConfiguration: ResolvedConfiguration | undefined;
  let settings: EditableDesktopSettings | undefined;
  $: if (desktop.configuration && desktop.configuration !== loadedConfiguration) {
    loadedConfiguration = desktop.configuration;
    settings = {
      agent: { configPath: desktop.configuration.agent.configPath ?? '', id: desktop.configuration.agent.id },
      inference: {
        mode: desktop.configuration.inference.mode as EditableDesktopSettings['inference']['mode'],
        tier: desktop.configuration.inference.tier as EditableDesktopSettings['inference']['tier'],
      },
      workspace: { ...desktop.configuration.workspace },
      interaction: {
        approvalMode: desktop.configuration.interaction.approvalMode as EditableDesktopSettings['interaction']['approvalMode'],
        clarificationMode: desktop.configuration.interaction.clarificationMode as EditableDesktopSettings['interaction']['clarificationMode'],
      },
    };
  }

  function save() {
    if (!settings) return;
    onsave({
      ...settings,
      workspace: { root: settings.workspace.root.trim(), shellCwd: settings.workspace.shellCwd.trim() },
    });
  }
</script>

<section class="center-card settings-view">
  <div class="view-heading"><div><span>Configuration</span><h2>Settings & sidecars</h2><p>Changes are saved to agent.settings.json and reload both sidecars. Credentials remain native.</p></div><button disabled={pending || desktop.status==='running'} on:click={onreload}>Reload settings</button></div>
  <div class="health-grid">
    <div><span>Execution</span><strong>{desktop.executionHealth}</strong></div>
    <div><span>Trace</span><strong>{desktop.traceHealth}</strong><small>{desktop.traceError ?? 'Read-only inspector sidecar'}</small></div>
    <div><span>Configuration</span><strong>{desktop.configurationValid?'Valid':'Invalid'}</strong></div>
  </div>
  {#if desktop.error}<div class="alert">{desktop.error}</div>{/if}
  {#if error}<div class="alert">{error}</div>{/if}
  {#if desktop.configuration && settings}
    <form class="settings-form" on:submit|preventDefault={save}>
      <div class="settings-summary">
        <span>Agent</span><strong>{desktop.configuration.agent.name}</strong><small>{desktop.configuration.agent.id}</small>
        <span>Runtime</span><strong>{desktop.configuration.runtime.mode}</strong>
        <span>Provider / model</span><strong>{desktop.configuration.model.provider} / {desktop.configuration.model.model}</strong>
        <span>Credential</span><strong>{desktop.configuration.model.credentialAvailable ? 'Available' : 'Unavailable'}</strong><small>value never exposed</small>
      </div>
      <div class="settings-grid">
        <label class="settings-wide"><span>Agent config path</span><input bind:value={settings.agent.configPath} disabled={pending} /></label>
        <label class="settings-wide"><span>Agent ID</span><input required bind:value={settings.agent.id} disabled={pending} /></label>
        <label><span>Inference mode</span><select bind:value={settings.inference.mode} disabled={pending}><option value="byok">BYOK</option><option value="local">Local</option><option value="gateway">Gateway</option></select></label>
        <label><span>Inference tier</span><select bind:value={settings.inference.tier} disabled={pending}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="xtra-high">Extra high</option></select></label>
        <label><span>Approval mode</span><select bind:value={settings.interaction.approvalMode} disabled={pending}><option value="auto">Auto</option><option value="manual">Manual</option><option value="reject">Reject</option></select></label>
        <label class="settings-wide"><span>Workspace root</span><input required bind:value={settings.workspace.root} disabled={pending} /></label>
        <label class="settings-wide"><span>Shell directory</span><input required bind:value={settings.workspace.shellCwd} disabled={pending} /></label>
      </div>
      <div class="actions"><button type="submit" disabled={pending || desktop.status==='running'}>{pending ? 'Saving…' : 'Save & reload'}</button></div>
    </form>
  {/if}
</section>
