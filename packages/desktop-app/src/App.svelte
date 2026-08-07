<script lang="ts">
  import { onMount } from 'svelte';
  import { addActivity, type ActivityEvent } from './activity';
  import ArtifactList from './ArtifactList.svelte';
  import BrandMark from './BrandMark.svelte';
  import ChatWorkspace from './ChatWorkspace.svelte';
  import NewComposer from './NewComposer.svelte';
  import RunInspector from './RunInspector.svelte';
  import SettingsPanel from './SettingsPanel.svelte';
  import TaskWorkspace from './TaskWorkspace.svelte';
  import WorkbenchRail from './WorkbenchRail.svelte';
  import {
    createChat,
    deleteHistory,
    getDesktopState,
    getRunRecoveryPlan,
    getRunResult,
    getTracePrivacy,
    listWorkspaceArtifacts,
    listChats,
    loadChat,
    previewHistoryDeletion,
    quitCancel,
    quitTerminate,
    quitWait,
    reloadSettings,
    saveSettings,
    recoverRun,
    resolveApproval,
    selectTrace,
    sendChatTurn,
    setTracePrivacy,
    startRun,
    steerRun,
    stopRun,
    subscribe,
    type Chat,
    type DeletionPreview,
    type DesktopState,
    type ProductDeletionTarget,
    type RunRecoveryPlan,
    type RunSummary,
    type TracePrivacy,
    type TraceReport,
  } from './desktop';
  import {
    inspectorOpen,
    mobileRailOpen,
    buildRailItems,
    filterRailItems,
    workbenchSelection,
    type RailItem,
  } from './workbench-state';
  import { historyResultArtifacts, type ResultArtifact } from './workbench-ux';

  const emptyDesktop: DesktopState = {
    status: 'starting',
    configurationValid: false,
    runs: [],
    occupiedSlotCount: 0,
    capacity: 3,
    executionHealth: 'error',
    traceHealth: 'starting',
    quitState: 'idle',
  };

  let desktop = emptyDesktop;
  let chats: Chat[] = [];
  let selectedChat: Chat | undefined;
  let selectedRunId = '';
  let selectedRecoveryPlan: RunRecoveryPlan | undefined;
  let task = '';
  let chatMessage = '';
  let activityByRoot: Record<string, ActivityEvent[]> = {};
  let resultsByRun: Record<string, { result?: unknown; error?: string }> = {};
  let finalValue: unknown;
  let finalError = '';
  let settingsError = '';
  let startPending = false;
  let controlPending = false;
  let deletionPending = false;
  let deletionPreview: DeletionPreview | undefined;
  let refreshGeneration = 0;
  let recoveryPlanGeneration = 0;
  let refreshScheduled = false;
  let now = Date.now();
  let traceRoot = '';
  let traceReport: TraceReport | undefined;
  let traceError = '';
  let tracePrivacy: TracePrivacy = { messages: false, reasoning: false, rawToolPayloads: false };
  let privacyPending = false;
  let titlePreview: { kind: 'task' | 'chat'; title: string } | undefined;
  let inspectorWidth = 380;
  let historyArtifacts: ResultArtifact[] = [];
  let artifactsPending = false;
  let artifactsError = '';
  let historyQuery = '';
  let loadedArtifactsFilterKey = '';
  let artifactsGeneration = 0;

  $: railItems = buildRailItems(desktop.runs, chats);
  $: filteredHistoryItems = filterRailItems(railItems, historyQuery).filter((item) => item.group === 'History');
  $: artifactsFilterKey = filteredHistoryItems.map((item) => item.id).join('\n');
  $: if ($workbenchSelection.kind === 'artifacts' && artifactsFilterKey !== loadedArtifactsFilterKey) {
    loadedArtifactsFilterKey = artifactsFilterKey;
    void loadArtifacts(filteredHistoryItems);
  }
  $: selectedRun = desktop.runs.find((run) => run.runId === selectedRunId);
  $: selectedActivity = selectedRunId ? activityByRoot[selectedRunId] ?? [] : [];
  $: inspectionRoot = $inspectorOpen ? selectedRunId : '';
  $: if (inspectionRoot !== traceRoot) {
    traceRoot = inspectionRoot;
    traceReport = undefined;
    traceError = '';
    void selectTrace(traceRoot || undefined).catch((error) => { traceError = String(error); });
  }

  onMount(() => {
    let unlisten = () => {};
    let cancelled = false;
    const storedWidth = Number(localStorage.getItem('adaptiveAgent.inspectorWidth'));
    if (storedWidth >= 320 && storedWidth <= 720) inspectorWidth = storedWidth;
    const timer = window.setInterval(() => { now = Date.now(); }, 100);
    void (async () => {
      unlisten = await subscribe(
        (event) => { activityByRoot = addActivity(activityByRoot, event); },
        (event) => {
          const previous = resultsByRun[event.runId];
          resultsByRun = {
            ...resultsByRun,
            [event.runId]: {
              result: event.result === undefined ? previous?.result : event.result,
              error: event.error === undefined ? previous?.error : event.error,
            },
          };
          if (event.runId === selectedRunId) {
            finalValue = resultsByRun[event.runId]?.result;
            finalError = resultsByRun[event.runId]?.error ?? '';
          }
          scheduleRefresh();
          if (event.runId === selectedRunId) void loadRecoveryPlan(event.runId);
        },
        (state) => {
          desktop = state;
          const run = state.runs.find((candidate) => candidate.runId === selectedRunId);
          if (run?.occupiesSlot) selectedRecoveryPlan = undefined;
          else if (run) void loadRecoveryPlan(run.runId);
          scheduleRefresh();
        },
        (event) => {
          if (event.rootRunId !== traceRoot || privacyPending) return;
          traceReport = event.report;
          traceError = event.error ?? '';
        },
      );
      if (cancelled) unlisten();
      else {
        await refresh();
        tracePrivacy = await getTracePrivacy();
      }
    })().catch((error) => { finalError = String(error); });
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      unlisten();
    };
  });

  function scheduleRefresh() {
    if (refreshScheduled) return;
    refreshScheduled = true;
    queueMicrotask(() => {
      refreshScheduled = false;
      void refresh();
    });
  }

  async function refresh() {
    const generation = ++refreshGeneration;
    const selectedChatId = selectedChat?.itemId;
    try {
      const [nextDesktop, nextChats, nextChat] = await Promise.all([
        getDesktopState(),
        listChats(),
        selectedChatId ? loadChat(selectedChatId) : Promise.resolve(undefined),
      ]);
      if (generation !== refreshGeneration) return;
      desktop = nextDesktop;
      chats = nextChats;
      if (selectedChatId && selectedChat?.itemId === selectedChatId) selectedChat = nextChat;
      if (selectedRunId && !nextDesktop.runs.some((run) => run.runId === selectedRunId)) {
        selectedRunId = '';
        finalValue = undefined;
        if ($workbenchSelection.kind === 'task') $workbenchSelection = { kind: 'new-task' };
      }
    } catch (error) {
      if (generation === refreshGeneration) finalError = String(error);
    }
  }

  async function selectRail(item: RailItem) {
    $mobileRailOpen = false;
    finalError = '';
    if (item.kind === 'chat') {
      await selectChat(item.id);
      return;
    }
    if (!item.runId) return;
    $workbenchSelection = { kind: 'task', itemId: item.id, runId: item.runId };
    selectedChat = undefined;
    await selectTaskRun(item.runId);
  }

  function showNewTask() {
    $workbenchSelection = { kind: 'new-task' };
    $mobileRailOpen = false;
    selectedChat = undefined;
    selectedRunId = '';
    task = '';
    finalValue = undefined;
    finalError = '';
  }

  function showNewChat() {
    $workbenchSelection = { kind: 'new-chat' };
    $mobileRailOpen = false;
    selectedChat = undefined;
    selectedRunId = '';
    task = '';
    finalValue = undefined;
    finalError = '';
  }

  function showSettings() {
    $workbenchSelection = { kind: 'settings' };
    $mobileRailOpen = false;
  }

  function showArtifacts() {
    loadedArtifactsFilterKey = artifactsFilterKey;
    $workbenchSelection = { kind: 'artifacts' };
    $mobileRailOpen = false;
    void loadArtifacts(filteredHistoryItems);
  }

  async function loadArtifacts(items: RailItem[]) {
    const generation = ++artifactsGeneration;
    artifactsPending = true;
    artifactsError = '';
    try {
      const itemIds = new Set(items.map((item) => item.id));
      const runs = desktop.runs.filter((run) => itemIds.has(run.itemId) && !run.occupiesSlot);
      const [workspace, results] = await Promise.all([
        listWorkspaceArtifacts(),
        Promise.all(runs.map((run) => getRunResult(run.runId))),
      ]);
      if (generation !== artifactsGeneration) return;
      historyArtifacts = historyResultArtifacts(results.filter((result) => result !== null), workspace);
    } catch (error) {
      if (generation === artifactsGeneration) {
        artifactsError = String(error);
        historyArtifacts = [];
      }
    } finally {
      if (generation === artifactsGeneration) artifactsPending = false;
    }
  }

  function refreshArtifacts() {
    loadedArtifactsFilterKey = artifactsFilterKey;
    void loadArtifacts(filteredHistoryItems);
  }

  async function selectChat(itemId: string) {
    selectedChat = await loadChat(itemId);
    $workbenchSelection = { kind: 'chat', itemId };
    const latestRun = desktop.runs.find((run) => run.itemId === itemId && run.occupiesSlot)
      ?? [...desktop.runs].reverse().find((run) => run.itemId === itemId);
    selectedRunId = latestRun?.runId
      ?? [...selectedChat.messages].reverse().find((message) => message.runId)?.runId
      ?? '';
  }

  async function newChat() {
    try {
      selectedChat = await createChat(task.trim() || 'New chat');
      task = '';
      chats = await listChats();
      selectedRunId = '';
      $workbenchSelection = { kind: 'chat', itemId: selectedChat.itemId };
    } catch (error) {
      finalError = String(error);
    }
  }

  function submitNew(kind: 'task' | 'chat') {
    return kind === 'task' ? void sendTask() : void newChat();
  }

  async function sendTask() {
    if (!task.trim()) return;
    finalValue = undefined;
    finalError = '';
    startPending = true;
    try {
      const started = await startRun(task.trim());
      task = '';
      selectedRunId = started.runId;
      $workbenchSelection = { kind: 'task', itemId: started.itemId, runId: started.runId };
      const early = resultsByRun[started.runId];
      finalValue = early?.result ?? await getRunResult(started.runId);
      finalError = early?.error ?? '';
    } catch (error) {
      finalError = String(error);
    }
    startPending = false;
    await refresh();
  }

  async function sendMessage() {
    if (!selectedChat || !chatMessage.trim()) return;
    startPending = true;
    finalError = '';
    try {
      const started = await sendChatTurn(selectedChat.itemId, chatMessage.trim());
      selectedRunId = started.runId;
      chatMessage = '';
      selectedChat = await loadChat(selectedChat.itemId);
    } catch (error) {
      finalError = String(error);
    }
    startPending = false;
    await refresh();
  }

  async function selectTaskRun(runId: string) {
    recoveryPlanGeneration += 1;
    selectedRecoveryPlan = undefined;
    selectedRunId = runId;
    const run = desktop.runs.find((candidate) => candidate.runId === runId);
    if (run && $workbenchSelection.kind === 'task') {
      $workbenchSelection = { kind: 'task', itemId: run.itemId, runId };
    }
    finalValue = resultsByRun[runId]?.result;
    finalError = resultsByRun[runId]?.error ?? '';
    try {
      const [result] = await Promise.all([getRunResult(runId), loadRecoveryPlan(runId)]);
      if (selectedRunId === runId) finalValue = result ?? resultsByRun[runId]?.result;
    } catch (error) {
      if (selectedRunId === runId) finalError = String(error);
    }
  }

  async function stop(runId: string) {
    controlPending = true;
    try { await stopRun(runId); }
    catch (error) { finalError = String(error); }
    controlPending = false;
    await refresh();
  }

  async function loadRecoveryPlan(runId: string) {
    const generation = ++recoveryPlanGeneration;
    const run = desktop.runs.find((candidate) => candidate.runId === runId);
    if (!run || run.occupiesSlot) {
      if (selectedRunId === runId) selectedRecoveryPlan = undefined;
      return;
    }
    if (selectedRunId === runId) selectedRecoveryPlan = undefined;
    try {
      const plan = await getRunRecoveryPlan(runId);
      const current = desktop.runs.find((candidate) => candidate.runId === runId);
      if (generation === recoveryPlanGeneration
        && selectedRunId === runId
        && current
        && !current.occupiesSlot
        && plan.runId === runId
        && plan.status === current.status) selectedRecoveryPlan = plan;
    } catch {
      if (generation === recoveryPlanGeneration && selectedRunId === runId) selectedRecoveryPlan = undefined;
    }
  }

  async function recover(plan: RunRecoveryPlan) {
    controlPending = true;
    finalError = '';
    finalValue = undefined;
    selectedRecoveryPlan = undefined;
    try { await recoverRun(plan); }
    catch (error) { finalError = String(error); }
    controlPending = false;
    await refresh();
  }

  async function steer(runId: string, message: string) {
    controlPending = true;
    finalError = '';
    try {
      await steerRun(runId, message);
      return true;
    }
    catch (error) {
      finalError = String(error);
      return false;
    } finally {
      controlPending = false;
    }
  }

  async function decide(run: RunSummary, approved: boolean) {
    if (!run.pendingApproval) return;
    controlPending = true;
    finalError = '';
    try { await resolveApproval(run.pendingApproval, approved); }
    catch (error) { finalError = String(error); }
    controlPending = false;
    await refresh();
  }

  async function requestDeletion(target: ProductDeletionTarget) {
    deletionPending = true;
    finalError = '';
    try { deletionPreview = await previewHistoryDeletion(target); }
    catch (error) { finalError = String(error); }
    deletionPending = false;
  }

  async function confirmDeletion() {
    if (!deletionPreview || deletionPreview.occupied) return;
    deletionPending = true;
    finalError = '';
    const target = deletionPreview.target;
    const deletedRunItemId = target.kind === 'run'
      ? desktop.runs.find((run) => run.runId === target.runId)?.itemId
      : undefined;
    try {
      await deleteHistory(target);
      deletionPreview = undefined;
      if (target.kind === 'item') {
        if (selectedChat?.itemId === target.itemId) selectedChat = undefined;
        if ($workbenchSelection.kind !== 'settings') $workbenchSelection = { kind: 'new-task' };
        selectedRunId = '';
      } else if (target.kind === 'run' && selectedRunId === target.runId) {
        selectedRunId = '';
        finalValue = undefined;
      } else if (target.kind === 'chat-turn' && selectedChat?.itemId === target.itemId) {
        selectedChat = await loadChat(target.itemId);
        selectedRunId = [...selectedChat.messages].reverse().find((message) => message.runId)?.runId ?? '';
      }
      await refresh();
      if (deletedRunItemId && target.kind === 'run') {
        const attempts = desktop.runs.filter((run) => run.itemId === deletedRunItemId);
        const next = attempts.find((run) => run.occupiesSlot)
          ?? attempts.find((run) => run.pendingApproval)
          ?? attempts.at(-1);
        if (next) {
          $workbenchSelection = { kind: 'task', itemId: next.itemId, runId: next.runId };
          await selectTaskRun(next.runId);
        } else {
          $workbenchSelection = { kind: 'new-task' };
        }
      }
    } catch (error) {
      finalError = String(error);
    }
    deletionPending = false;
  }

  async function reload() {
    controlPending = true;
    settingsError = '';
    try { desktop = await reloadSettings(); }
    catch (error) { settingsError = String(error); }
    controlPending = false;
  }

  async function save(settings: import('./desktop').EditableDesktopSettings) {
    controlPending = true;
    settingsError = '';
    try { desktop = await saveSettings(settings); }
    catch (error) { settingsError = String(error); }
    controlPending = false;
  }

  async function quit(action: 'wait' | 'terminate' | 'cancel') {
    controlPending = true;
    try {
      desktop = await (action === 'wait'
        ? quitWait()
        : action === 'terminate'
          ? quitTerminate()
          : quitCancel());
    } catch (error) {
      finalError = String(error);
    }
    controlPending = false;
  }

  async function savePrivacy(next: TracePrivacy) {
    privacyPending = true;
    traceReport = undefined;
    traceError = '';
    try { tracePrivacy = await setTracePrivacy(next); }
    catch (error) { traceError = String(error); }
    privacyPending = false;
  }

  function chatActivity(itemId: string): ActivityEvent[] {
    const root = desktop.runs.find((run) => run.itemId === itemId && run.occupiesSlot)?.runId
      ?? [...desktop.runs].reverse().find((run) => run.itemId === itemId)?.runId
      ?? (selectedChat?.itemId === itemId
        ? [...selectedChat.messages].reverse().find((message) => message.runId)?.runId
        : undefined);
    return root ? activityByRoot[root] ?? [] : [];
  }

  function resizeInspector(event: PointerEvent) {
    const startX = event.clientX; const startWidth = inspectorWidth;
    const move = (next: PointerEvent) => { inspectorWidth = Math.max(320, Math.min(720, startWidth + startX - next.clientX)); };
    const up = () => { localStorage.setItem('adaptiveAgent.inspectorWidth', String(inspectorWidth)); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }
</script>

<svelte:window on:keydown={(event) => { if (event.key === 'Escape') titlePreview = undefined; }} />

{#if desktop.quitState === 'confirming'}
  <div class="modal-backdrop" role="presentation">
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="quit-title">
      <h2 id="quit-title">Runs are still active</h2>
      <p>Choose how AdaptiveAgent should finish before quitting.</p>
      <div class="actions">
        <button disabled={controlPending} on:click={() => quit('cancel')}>Cancel</button>
        <button disabled={controlPending} on:click={() => quit('wait')}>Wait for runs</button>
        <button class="danger" disabled={controlPending} on:click={() => quit('terminate')}>Terminate all and quit</button>
      </div>
    </div>
  </div>
{/if}

{#if deletionPreview}
  <div class="modal-backdrop" role="presentation">
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="delete-title">
      <h2 id="delete-title">Delete {deletionPreview.label}?</h2>
      <p>{deletionPreview.warning}</p>
      <p>{deletionPreview.runCount} run{deletionPreview.runCount === 1 ? '' : 's'} and {deletionPreview.planCount} related plan{deletionPreview.planCount === 1 ? '' : 's'} are included.</p>
      {#if deletionPreview.occupied}
        <div class="alert">Stop or wait for every affected run before deleting this history.</div>
      {/if}
      <div class="actions">
        <button disabled={deletionPending} on:click={() => { deletionPreview = undefined; }}>Cancel</button>
        <button class="danger" disabled={deletionPending || deletionPreview.occupied} on:click={confirmDeletion}>Delete permanently</button>
      </div>
    </div>
  </div>
{/if}

{#if titlePreview}
  <div class="modal-backdrop" role="presentation">
    <div class="modal title-modal" role="dialog" aria-modal="true" aria-labelledby="description-title">
      <header>
        <div><span>{titlePreview.kind}</span><h2 id="description-title">Full description</h2></div>
        <button aria-label="Close description" on:click={() => { titlePreview = undefined; }}>×</button>
      </header>
      <p>{titlePreview.title}</p>
    </div>
  </div>
{/if}

<div class:open={$mobileRailOpen} class="rail-drawer">
  <WorkbenchRail
    items={railItems}
    selection={$workbenchSelection}
    occupied={desktop.occupiedSlotCount}
    capacity={desktop.capacity}
    mobileOpen={true}
    bind:query={historyQuery}
    onselect={selectRail}
    onnewtask={showNewTask}
    onartifacts={showArtifacts}
    onsettings={showSettings}
    onclose={() => { $mobileRailOpen = false; }}
  />
</div>
{#if $mobileRailOpen}
  <button class="drawer-backdrop rail-backdrop" aria-label="Close task rail" on:click={() => { $mobileRailOpen = false; }}></button>
{/if}

<main class:inspector-open={$inspectorOpen} class="workbench" style={`--inspector-width:${inspectorWidth}px`}>
  <aside class="desktop-rail">
    <WorkbenchRail
      items={railItems}
      selection={$workbenchSelection}
      occupied={desktop.occupiedSlotCount}
      capacity={desktop.capacity}
      bind:query={historyQuery}
      onselect={selectRail}
      onnewtask={showNewTask}
      onartifacts={showArtifacts}
      onsettings={showSettings}
      onclose={() => { $mobileRailOpen = false; }}
    />
  </aside>

  <section class="workspace-shell">
    <header class="workbench-header">
      <button class="icon-button rail-toggle" aria-label="Open task rail" on:click={() => { $mobileRailOpen = true; }}>☰</button>
      <div class="brand"><BrandMark /><div><strong>AdaptiveAgent</strong><span>Workbench</span></div></div>
      <div class="health-strip" aria-label="Runtime health">
        <span class:good={desktop.executionHealth === 'ready'} class="health-pill">Runtime {desktop.executionHealth}</span>
        <span class:good={desktop.traceHealth === 'ready'} class="health-pill">Trace {desktop.traceHealth}</span>
        <span class="slot-pill">{desktop.occupiedSlotCount}/{desktop.capacity} active</span>
      </div>
      <button class:active={$inspectorOpen} class="icon-button inspector-toggle" aria-label="Toggle run inspector" on:click={() => { $inspectorOpen = !$inspectorOpen; }}>Inspect</button>
    </header>

    {#if desktop.error && $workbenchSelection.kind !== 'settings'}
      <div class="shell-alert alert">{desktop.error}</div>
    {/if}

    <div class="workspace-content">
      {#if $workbenchSelection.kind === 'new-task' || $workbenchSelection.kind === 'new-chat'}
        <NewComposer
          bind:value={task}
          pending={startPending}
          disabled={!desktop.configurationValid || desktop.quitState !== 'idle'}
          status={`${desktop.occupiedSlotCount}/${desktop.capacity} execution slots occupied`}
          configuration={desktop.configuration}
          capacityAvailable={desktop.occupiedSlotCount < desktop.capacity}
          onsubmit={submitNew}
        />
      {:else if $workbenchSelection.kind === 'task' && selectedRun}
        <TaskWorkspace
          attempts={desktop.runs.filter((run) => run.itemId === selectedRun?.itemId)}
          {selectedRun}
          activity={selectedActivity}
          {now}
          result={finalValue}
          error={finalError}
          pending={controlPending || deletionPending}
          recoveryPlan={selectedRecoveryPlan}
          onselectrun={selectTaskRun}
          onstop={stop}
          onrecover={recover}
          onsteer={steer}
          ondecision={decide}
          ondelete={requestDeletion}
          onshowtitle={(kind, title) => { titlePreview = { kind, title }; }}
        />
      {:else if $workbenchSelection.kind === 'chat' && selectedChat}
        <ChatWorkspace
          chat={selectedChat}
          runs={desktop.runs.filter((run) => run.itemId === selectedChat?.itemId)}
          bind:message={chatMessage}
          activity={chatActivity(selectedChat.itemId)}
          {now}
          error={finalError}
          pending={startPending || controlPending || deletionPending}
          capacityAvailable={desktop.occupiedSlotCount < desktop.capacity && desktop.quitState === 'idle'}
          onsend={sendMessage}
          onstop={stop}
          ondecision={decide}
          ondelete={requestDeletion}
          oninspect={() => { $inspectorOpen = true; }}
          onshowtitle={(kind, title) => { titlePreview = { kind, title }; }}
        />
      {:else if $workbenchSelection.kind === 'settings'}
        <SettingsPanel {desktop} pending={controlPending} error={settingsError} onreload={reload} onsave={save} />
      {:else if $workbenchSelection.kind === 'artifacts'}
        <section class="center-card">
          <div class="view-heading">
            <div><span>Filtered history</span><h2>Artifacts</h2><p>Artifacts from {filteredHistoryItems.length} history item{filteredHistoryItems.length === 1 ? '' : 's'}{historyQuery.trim() ? ` matching “${historyQuery.trim()}”` : ''}.</p></div>
            <button disabled={artifactsPending} on:click={refreshArtifacts}>{artifactsPending ? 'Refreshing…' : 'Refresh'}</button>
          </div>
          {#if artifactsError}<div class="alert">{artifactsError}</div>{/if}
          {#if historyArtifacts.length}<ArtifactList artifacts={historyArtifacts}/>
          {:else if !artifactsPending && !artifactsError}<div class="empty-state"><strong>No artifacts found</strong><p>The filtered history does not reference any available artifact files.</p></div>{/if}
        </section>
      {:else}
        <div class="empty-state">
          <h2>History unavailable</h2>
          <p>This item may have been deleted. Choose another item from the rail.</p>
          <button on:click={showNewTask}>New task</button>
        </div>
      {/if}
    </div>
  </section>

  <aside class:open={$inspectorOpen} class="inspector-drawer">
    <button class="inspector-resizer" aria-label="Resize inspector" on:pointerdown={resizeInspector}></button>
    <RunInspector
      {desktop}
      root={selectedRunId}
      report={traceReport}
      error={traceError || desktop.traceError || ''}
      privacy={tracePrivacy}
      {privacyPending}
      onprivacy={savePrivacy}
      onclose={() => { $inspectorOpen = false; }}
    />
  </aside>
  {#if $inspectorOpen}
    <button class="drawer-backdrop inspector-backdrop" aria-label="Close run inspector" on:click={() => { $inspectorOpen = false; }}></button>
  {/if}
</main>
