import type { ChangeEvent, FormEvent } from 'react';
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { marked } from 'marked';

import { GatewayWebClient, loadGatewayDefaults } from '../../gateway/client';
import {
  formatClockTime,
  formatDuration,
  formatLiveProgressUpdate,
  formatRunOutput,
  formatToolProgressDetail,
  isClarificationRequestOutput,
  shortId,
  summarizeAgentEvent,
} from '../../gateway/format';
import type {
  ComposerMode,
  FeedEntry,
  GatewayDefaults,
  GatewayIdentity,
  GatewayImageInput,
  LiveAgentEventSummary,
  LiveGatewayState,
  ModelActivitySnapshot,
  PendingApproval,
  RunActivity,
} from '../../gateway/types';
import type { OutboundFrame, SessionStatus } from '../../gateway/protocol';
import { getGatewayAccessToken } from '../shared/GatewayAuth';

type MinimalProgressIndicator = {
  kind: 'delegate' | 'step';
  label: string;
};

type MinimalOutputBlock =
  | {
      kind: 'markdown';
      id: string;
      source: string;
    }
  | {
      kind: 'assistant-progress';
      id: string;
      assistantContent: string;
      toolMessages: string[];
      runId?: string;
    };

interface ToolActivitySummary {
  key: string;
  label: string;
  tone: 'tool' | 'approval' | 'delegate' | 'activity';
  count: number;
  title: string;
}

type Action =
  | { type: 'socket'; state: LiveGatewayState['socketState']; detail?: string }
  | { type: 'session.ids'; sessionId?: string; runSessionId?: string }
  | { type: 'feed'; entry: FeedEntry }
  | { type: 'frame'; frame: OutboundFrame }
  | { type: 'reset-live' }
  | { type: 'hydrate'; state: LiveGatewayState }
  | { type: 'clear-attention'; runId: string };

const initialState: LiveGatewayState = {
  socketState: 'idle',
  socketDetail: '',
  session: {
    status: 'idle',
  },
  feed: [
    {
      id: crypto.randomUUID(),
      kind: 'system',
      content: 'Connect to the gateway, start a chat turn or run, and watch live agent events become the progress stream.',
      timestamp: new Date(),
    },
  ],
  events: [],
  runs: [],
};

const defaultIdentity: GatewayIdentity = {
  channel: 'web',
  subject: 'local-dev-user',
  tenantId: 'free',
  roles: ['member'],
};

interface SavedConnectionSettings {
  socketUrl: string;
  identity: GatewayIdentity;
  useDevToken: boolean;
  customToken: string;
}

type ComposerPageVariant = 'composer' | 'run';

interface ComposerPageProps {
  variant?: ComposerPageVariant;
}

const runPageDefaultIdentity: GatewayIdentity = {
  channel: 'web',
  subject: 'local-dev-user',
  tenantId: 'free',
  roles: ['member'],
};

export function ComposerPage(props: ComposerPageProps = {}): ReactElement {
  const isRunPage = props.variant === 'run';
  const routeDefaultIdentity = isRunPage ? runPageDefaultIdentity : defaultIdentity;
  const liveStateStorageKey = isRunPage ? RUN_LIVE_STATE_STORAGE_KEY : LIVE_STATE_STORAGE_KEY;
  const connectionSettingsStorageKey = isRunPage ? RUN_CONNECTION_SETTINGS_STORAGE_KEY : CONNECTION_SETTINGS_STORAGE_KEY;
  const [state, dispatch] = useReducer(reducer, initialState);
  const [defaults, setDefaults] = useState<GatewayDefaults>({
    socketUrl: 'ws://127.0.0.1:8959/ws',
    ...routeDefaultIdentity,
  });
  const [socketUrl, setSocketUrl] = useState(defaults.socketUrl);
  const [identity, setIdentity] = useState<GatewayIdentity>(routeDefaultIdentity);
  const [customToken, setCustomToken] = useState('');
  const [useDevToken, setUseDevToken] = useState(true);
  const [showConnect, setShowConnect] = useState(false);
  const [composerMode, setComposerMode] = useState<ComposerMode>('run');
  const [composerText, setComposerText] = useState('');
  const [composerImageFiles, setComposerImageFiles] = useState<File[]>([]);
  const [composerImageDetail, setComposerImageDetail] = useState<GatewayImageInput['detail']>('high');
  const [isComposerCollapsed, setIsComposerCollapsed] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState('');
  const [settingsNotice, setSettingsNotice] = useState('');
  const [clockTick, setClockTick] = useState(() => Date.now());
  const clientRef = useRef<GatewayWebClient | null>(null);
  const outputRef = useRef<HTMLDivElement | null>(null);
  const composerImageInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let active = true;
    loadGatewayDefaults()
      .then((loaded) => {
        if (!active) {
          return;
        }

        const saved = loadSavedConnectionSettings(connectionSettingsStorageKey);
        setDefaults(loaded);
        if (saved) {
          setSocketUrl(saved.socketUrl);
          setIdentity(saved.identity);
          setUseDevToken(saved.useDevToken);
          setCustomToken(saved.customToken);
          return;
        }

        setSocketUrl(loaded.socketUrl);
        setIdentity(isRunPage ? gatewayRunIdentityFromDefaults(loaded) : gatewayIdentityFromDefaults(loaded));
        setUseDevToken(true);
        setCustomToken('');
      })
      .catch((loadError) => {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      });

    return () => {
      active = false;
    };
  }, [connectionSettingsStorageKey, isRunPage]);

  useEffect(() => {
    const saved = loadSavedLiveState(liveStateStorageKey);
    if (saved) {
      dispatch({ type: 'hydrate', state: saved });
    }
  }, [liveStateStorageKey]);

  useEffect(() => {
    saveLiveState(liveStateStorageKey, state);
  }, [liveStateStorageKey, state]);

  useEffect(() => {
    return () => {
      clientRef.current?.disconnect(1000, 'page teardown');
    };
  }, []);

  useEffect(() => {
    const intervalId = window.setInterval(() => setClockTick(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    if (!settingsNotice) {
      return;
    }

    const timeoutId = window.setTimeout(() => setSettingsNotice(''), 2200);
    return () => window.clearTimeout(timeoutId);
  }, [settingsNotice]);

  const activeRun = useMemo(() => {
    if (state.session.activeRootRunId) {
      return state.runs.find((run) => run.rootRunId === state.session.activeRootRunId) ?? state.runs[0];
    }
    if (state.session.activeRunId) {
      return state.runs.find((run) => run.runId === state.session.activeRunId) ?? state.runs[0];
    }
    return state.runs[0];
  }, [state.runs, state.session.activeRootRunId, state.session.activeRunId]);

  const minimalOutputBlocks = useMemo(() => buildMinimalOutputBlocks(state), [state]);
  const exportName = useMemo(() => buildExportFileStem(state), [state]);
  const activeApproval = resolvePendingApproval(state, activeRun);

  useEffect(() => {
    const node = outputRef.current;
    if (!node) {
      return;
    }

    node.scrollTo({
      top: node.scrollHeight,
      behavior: 'auto',
    });
  }, [minimalOutputBlocks]);

  async function connect(options: { openSession?: boolean } = {}): Promise<boolean> {
    setIsConnecting(true);
    setError('');
    dispatch({ type: 'reset-live' });

    try {
      clientRef.current?.disconnect(1000, 'reconnecting');
      const token = await getGatewayAccessToken({
        identity,
        mode: useDevToken ? 'dev' : 'custom',
        customToken,
      });

      const client = new GatewayWebClient({
        socketUrl,
        identity,
        token,
        onFrame: (frame) => dispatch({ type: 'frame', frame }),
        onSocketStateChange: (socketState, detail) => dispatch({ type: 'socket', state: socketState, detail }),
        onSessionIdsChange: (sessionIds) => dispatch({ type: 'session.ids', ...sessionIds }),
      });
      clientRef.current = client;
      await client.connect({
        openSession: options.openSession ?? false,
      });
      setShowConnect(false);
      addFeed('system', `Connected as ${identity.subject} on ${identity.channel} (${identity.tenantId}, ${identity.roles.join(', ')}).`);
      return true;
    } catch (connectError) {
      const message = connectError instanceof Error ? connectError.message : String(connectError);
      setError(message);
      dispatch({ type: 'socket', state: 'error', detail: message });
      addFeed('system', `Connect failed: ${message}`);
      return false;
    } finally {
      setIsConnecting(false);
    }
  }

  function disconnect(): void {
    clientRef.current?.disconnect(1000, 'user disconnected');
    clientRef.current = null;
    dispatch({ type: 'socket', state: 'closed', detail: 'user disconnected' });
    addFeed('system', 'Disconnected from the gateway.');
  }

  async function submitComposer(event: FormEvent): Promise<void> {
    event.preventDefault();
    const text = composerText.trim();
    if (!text) {
      return;
    }
    if (!clientRef.current) {
      addFeed('system', 'Connect before sending a message.');
      return;
    }

    try {
      let images: GatewayImageInput[] | undefined;
      if (!isRunPage) {
        const uploadedImages = await clientRef.current.uploadImages(composerImageFiles);
        images = uploadedImages.length > 0
          ? uploadedImages.map((image) => ({
              uploadId: image.uploadId,
              mimeType: image.mimeType,
              name: image.name,
              detail: composerImageDetail,
            }))
          : undefined;
      }

      if (!isRunPage && composerMode === 'chat') {
        await clientRef.current.sendChat(text, images);
        addFeed('user', describeComposerSubmission(text, images));
      } else {
        await clientRef.current.startRun(text, images);
        addFeed('user', `Run: ${describeComposerSubmission(text, images)}`);
      }
      setComposerText('');
      if (!isRunPage) {
        clearComposerImages();
        setComposerImageDetail('high');
      }
    } catch (sendError) {
      addFeed('system', `Send failed: ${sendError instanceof Error ? sendError.message : String(sendError)}`);
    }
  }

  function chooseComposerImages(): void {
    composerImageInputRef.current?.click();
  }

  function updateComposerImageFiles(event: ChangeEvent<HTMLInputElement>): void {
    setComposerImageFiles(Array.from(event.target.files ?? []));
  }

  function clearComposerImages(): void {
    setComposerImageFiles([]);
    if (composerImageInputRef.current) {
      composerImageInputRef.current.value = '';
    }
  }

  async function submitMinimalComposer(event: FormEvent): Promise<void> {
    event.preventDefault();

    if (state.pendingClarification) {
      const message = composerText.trim();
      if (!message) {
        return;
      }

      try {
        clientRef.current?.resolveClarification(state.pendingClarification.runId, message);
        dispatch({ type: 'clear-attention', runId: state.pendingClarification.runId });
        addFeed('user', `Clarification: ${message}`);
        setComposerText('');
      } catch (clarificationError) {
        addFeed('system', `Clarification failed: ${clarificationError instanceof Error ? clarificationError.message : String(clarificationError)}`);
      }
      return;
    }

    if (!clientRef.current || state.socketState !== 'connected') {
      const connected = await connect({ openSession: false });
      if (!connected) {
        return;
      }
    }

    await submitComposer(event);
  }

  function handleMinimalConnectionButtonClick(): void {
    if (isConnecting || state.socketState === 'connecting') {
      return;
    }

    if (state.socketState === 'connected') {
      disconnect();
      return;
    }

    void connect({ openSession: false });
  }

  function saveCurrentConnectionSettings(): void {
    saveConnectionSettings(connectionSettingsStorageKey, {
      socketUrl,
      identity,
      useDevToken,
      customToken,
    });
    setError('');
    setSettingsNotice('Saved to this browser for future sessions.');
    setShowConnect(false);
  }

  function resetConnectionSettingsForm(): void {
    setSocketUrl(defaults.socketUrl);
    setIdentity(isRunPage ? gatewayRunIdentityFromDefaults(defaults) : gatewayIdentityFromDefaults(defaults));
    setUseDevToken(true);
    setCustomToken('');
    setError('');
    setSettingsNotice('Defaults restored. Save to keep them across sessions.');
  }

  function resolveApproval(approval: PendingApproval, approved: boolean): void {
    try {
      clientRef.current?.resolveApproval(approval.runId, approved, approval.sessionId);
      dispatch({ type: 'clear-attention', runId: approval.runId });
      addFeed('system', `${approved ? 'Approved' : 'Rejected'} ${shortId(approval.runId)}.`);
    } catch (approvalError) {
      addFeed('system', `Approval failed: ${approvalError instanceof Error ? approvalError.message : String(approvalError)}`);
    }
  }

  function addFeed(kind: FeedEntry['kind'], content: string, runId?: string): void {
    dispatch({
      type: 'feed',
      entry: {
        id: crypto.randomUUID(),
        kind,
        content,
        timestamp: new Date(),
        runId,
      },
    });
  }

  const pendingApproval = activeApproval;
  const pendingClarification = state.pendingClarification;
  const composerPlaceholder = pendingClarification
    ? pendingClarification.message
    : !isRunPage && composerMode === 'chat'
      ? 'Keep it brief. Ask, steer, refine.'
      : 'Describe the run goal in a sentence or two.';
  const composerActionLabel = pendingClarification ? 'Reply' : !isRunPage && composerMode === 'chat' ? 'Send' : 'Run';
  const progressIndicator = useMemo(
    () => resolveMinimalProgressIndicator(activeRun, activeRun?.latestEvent ?? state.events[0], state.session.status),
    [activeRun, state.events, state.session.status],
  );

  return (
    <main className="minimal-page">
        <div className="minimal-composer-dock">
          <section className="minimal-session-shell" aria-label="Minimal workspace">
            <section ref={outputRef} className="minimal-markdown-output" aria-label="Rendered session output">
              <MinimalOutput blocks={minimalOutputBlocks} />
            </section>

            <section className="minimal-composer-frame" aria-label="Minimal composer">
              <div className="minimal-composer-top">
                <div className="minimal-control-cluster">
                  {!isRunPage ? (
                    <div className="minimal-mode-switch" role="group" aria-label="Composer mode">
                      <button className={composerMode === 'run' ? 'selected' : ''} type="button" onClick={() => setComposerMode('run')}>
                        Run
                      </button>
                      <button className={composerMode === 'chat' ? 'selected' : ''} type="button" onClick={() => setComposerMode('chat')}>
                        Chat
                      </button>
                    </div>
                  ) : null}
                  <button
                    className={`minimal-connect-button ${state.socketState}`}
                    type="button"
                    aria-label={state.socketState === 'connected' ? 'Disconnect gateway' : 'Connect gateway'}
                    aria-pressed={state.socketState === 'connected'}
                    title={state.socketState === 'connected' ? 'Disconnect gateway' : state.socketState === 'connecting' ? 'Connecting gateway' : 'Connect gateway'}
                    onClick={handleMinimalConnectionButtonClick}
                    disabled={isConnecting || state.socketState === 'connecting'}
                  >
                    <ConnectionIcon state={state.socketState} />
                  </button>
                  <button
                    className={`minimal-toolbar-icon-button ${showConnect ? 'active' : ''}`}
                    type="button"
                    aria-label={showConnect ? 'Hide connection settings' : 'Show connection settings'}
                    aria-pressed={showConnect}
                    title={showConnect ? 'Hide connection settings' : 'Show connection settings'}
                    onClick={() => setShowConnect((value) => !value)}
                  >
                    <SettingsIcon />
                  </button>
                </div>
                <button
                  className={`minimal-composer-collapse-toggle ${isComposerCollapsed ? 'collapsed' : ''}`}
                  type="button"
                  aria-label={isComposerCollapsed ? 'Expand composer' : 'Collapse composer'}
                  aria-expanded={!isComposerCollapsed}
                  title={isComposerCollapsed ? 'Expand composer' : 'Collapse composer'}
                  onClick={() => setIsComposerCollapsed((value) => !value)}
                />
                {state.modelActivity ? (
                  <span
                    className={`minimal-thinking-chip ${state.modelActivity.status}`}
                    aria-live="polite"
                    title={buildThinkingChipTitle(state.modelActivity)}
                  >
                    {buildThinkingChipLabel(state.modelActivity, clockTick)}
                  </span>
                ) : null}
                <span className="minimal-runtime-chip">{buildRuntimeLabel(activeRun, state.session.status, clockTick)}</span>
              </div>

              <div className={`minimal-composer-body ${isComposerCollapsed ? 'collapsed' : ''}`}>
                {showConnect ? (
                  <section className="minimal-settings-sheet" aria-label="Connection settings">
                    <div className="minimal-settings-head">
                      <div className="minimal-settings-copy">
                        <p className="eyebrow">Connection settings</p>
                        <h2>Gateway session defaults</h2>
                      </div>
                      <div className="minimal-settings-actions">
                        <button
                          className="minimal-settings-icon-button"
                          type="button"
                          aria-label="Reset connection settings to defaults"
                          title="Reset connection settings to defaults"
                          onClick={resetConnectionSettingsForm}
                        >
                          <ResetIcon />
                        </button>
                        <button
                          className="minimal-settings-icon-button primary"
                          type="button"
                          aria-label="Save connection settings"
                          title="Save connection settings"
                          onClick={saveCurrentConnectionSettings}
                        >
                          <SaveIcon />
                        </button>
                      </div>
                    </div>

                    <div className="minimal-settings-fields">
                      <label>
                        Gateway socket
                        <input value={socketUrl} onChange={(event) => setSocketUrl(event.target.value)} />
                      </label>
                      <label>
                        Channel
                        <input value={identity.channel} onChange={(event) => setIdentity({ ...identity, channel: event.target.value })} />
                      </label>
                      <label>
                        Subject
                        <input value={identity.subject} onChange={(event) => setIdentity({ ...identity, subject: event.target.value })} />
                      </label>
                      <label>
                        Tenant
                        <input value={identity.tenantId} onChange={(event) => setIdentity({ ...identity, tenantId: event.target.value })} />
                      </label>
                      <label>
                        Roles
                        <input
                          value={identity.roles.join(', ')}
                          onChange={(event) => setIdentity({ ...identity, roles: parseRoles(event.target.value) })}
                        />
                      </label>
                      <label className="minimal-settings-toggle">
                        Use local dev token
                        <span>
                          <input type="checkbox" checked={useDevToken} onChange={(event) => setUseDevToken(event.target.checked)} />
                          <span>{useDevToken ? 'Enabled' : 'Disabled'}</span>
                        </span>
                      </label>
                      {!useDevToken ? (
                        <label>
                          JWT
                          <textarea value={customToken} onChange={(event) => setCustomToken(event.target.value)} rows={3} />
                        </label>
                      ) : null}
                    </div>

                    {settingsNotice ? <p className="minimal-settings-note">{settingsNotice}</p> : null}
                    {error ? <p className="minimal-settings-error">{error}</p> : null}
                  </section>
                ) : null}

                <form className="minimal-composer" onSubmit={(event) => void submitMinimalComposer(event)}>
                  {progressIndicator ? (
                    <div
                      className={`minimal-progress-lane ${progressIndicator.kind}`}
                      aria-live="polite"
                      aria-label={progressIndicator.label}
                      title={progressIndicator.label}
                    >
                      <span className="minimal-progress-chip">
                        {progressIndicator.kind === 'delegate' ? (
                          <span className="minimal-progress-dot" aria-hidden="true" />
                        ) : (
                          <span className="minimal-progress-spinner" aria-hidden="true" />
                        )}
                        <span>{progressIndicator.label}</span>
                      </span>
                    </div>
                  ) : null}
                  <div className="minimal-composer-input">
                    <textarea
                      value={composerText}
                      onChange={(event) => setComposerText(event.target.value)}
                      placeholder={composerPlaceholder}
                      rows={4}
                    />
                    <button className="minimal-send-button" type="submit" aria-label={composerActionLabel} title={composerActionLabel}>
                      <SendIcon />
                    </button>
                  </div>
                  {!isRunPage ? (
                    <div className="minimal-composer-attachments">
                      <div className="minimal-composer-file-field">
                        <input
                          ref={composerImageInputRef}
                          className="minimal-composer-file-input"
                          type="file"
                          accept="image/png,image/jpeg,image/webp,image/gif"
                          multiple
                          onChange={updateComposerImageFiles}
                        />
                        <button
                          className="minimal-attachment-button"
                          type="button"
                          onClick={chooseComposerImages}
                          aria-label="Attach images"
                          title="Attach images"
                        >
                          <PaperclipIcon />
                          <span>{formatSelectedImageFiles(composerImageFiles)}</span>
                        </button>
                        {composerImageFiles.length > 0 ? (
                          <button
                            className="minimal-attachment-clear"
                            type="button"
                            onClick={clearComposerImages}
                            aria-label="Clear attached images"
                            title="Clear attached images"
                          >
                            x
                          </button>
                        ) : null}
                      </div>
                      <label className="minimal-composer-detail-field">
                        <span>Detail</span>
                        <select
                          value={composerImageDetail ?? 'high'}
                          onChange={(event) => setComposerImageDetail(event.target.value as GatewayImageInput['detail'])}
                        >
                          <option value="high">high</option>
                          <option value="auto">auto</option>
                          <option value="low">low</option>
                        </select>
                      </label>
                    </div>
                  ) : null}
                </form>
              </div>

              {pendingApproval ? (
                <div className="minimal-status-bar pending">
                  <div className="minimal-status-copy">
                    <strong>{pendingApproval.toolName ?? 'Approval required'}</strong>
                    <span>{pendingApproval.reason ?? 'The active run is waiting for a decision.'}</span>
                  </div>
                  <div className="minimal-status-actions">
                    <button
                      className="minimal-icon-button"
                      type="button"
                      aria-label="Approve"
                      title="Approve"
                      onClick={() => resolveApproval(pendingApproval, true)}
                    >
                      <ApproveIcon />
                    </button>
                    <button
                      className="minimal-icon-button reject"
                      type="button"
                      aria-label="Reject"
                      title="Reject"
                      onClick={() => resolveApproval(pendingApproval, false)}
                    >
                      <RejectIcon />
                    </button>
                  </div>
                </div>
              ) : pendingClarification ? (
                <div className="minimal-status-bar clarification">
                  <div className="minimal-status-copy">
                    <strong>Clarification requested</strong>
                    <span>{pendingClarification.message}</span>
                  </div>
                </div>
              ) : null}
            </section>
          </section>
        </div>
    </main>
  );
}

function reducer(state: LiveGatewayState, action: Action): LiveGatewayState {
  switch (action.type) {
    case 'socket':
      return {
        ...state,
        socketState: action.state,
        socketDetail: action.detail ?? '',
      };
    case 'session.ids':
      return {
        ...state,
        session: {
          ...state.session,
          sessionId: action.sessionId ?? state.session.sessionId,
          runSessionId: action.runSessionId ?? state.session.runSessionId,
        },
      };
    case 'feed':
      return {
        ...state,
        feed: [...state.feed, action.entry],
      };
    case 'frame':
      return applyFrame(state, action.frame);
    case 'reset-live':
      return {
        ...initialState,
        feed: [
          ...initialState.feed,
          {
            id: crypto.randomUUID(),
            kind: 'system',
            content: 'Preparing a fresh gateway session.',
            timestamp: new Date(),
          },
        ],
      };
    case 'hydrate':
      return {
        ...action.state,
        socketState: 'idle',
        socketDetail: '',
      };
    case 'clear-attention':
      return {
        ...state,
        pendingApproval: state.pendingApproval?.runId === action.runId ? undefined : state.pendingApproval,
        pendingClarification: state.pendingClarification?.runId === action.runId ? undefined : state.pendingClarification,
      };
    default:
      return state;
  }
}

function applyFrame(state: LiveGatewayState, frame: OutboundFrame): LiveGatewayState {
  switch (frame.type) {
    case 'session.opened':
      return appendFeed({
        ...state,
        session: {
          ...state.session,
          sessionId: state.session.sessionId ?? frame.sessionId,
          status: frame.status,
        },
      }, 'system', `Session opened: ${shortId(frame.sessionId)} (${frame.status})`);
    case 'session.updated':
      return appendFeed({
        ...state,
        session: {
          ...state.session,
          status: frame.status,
          activeRunId: frame.activeRunId,
          activeRootRunId: frame.activeRootRunId,
        },
      }, 'system', `Session updated: ${frame.status}${frame.activeRunId ? ` · run:${shortId(frame.activeRunId)}` : ''}`);
    case 'message.output':
      return appendFeed(state, 'assistant', frame.message.content, frame.runId);
    case 'run.output': {
      if (frame.status === 'failed') {
        return appendFeed({
          ...state,
          runs: upsertRun(state.runs, {
            runId: frame.runId,
            rootRunId: frame.rootRunId,
            sessionId: frame.sessionId,
            status: 'failed',
            error: frame.error ?? 'Run failed.',
          }),
        }, 'system', `Run failed: ${frame.error ?? 'unknown error'}`, frame.runId);
      }

      if (isClarificationRequestOutput(frame.output)) {
        return appendFeed({
          ...state,
          pendingClarification: {
            runId: frame.runId,
            sessionId: frame.sessionId,
            message: frame.output.message,
            suggestedQuestions: frame.output.suggestedQuestions,
          },
          runs: upsertRun(state.runs, {
            runId: frame.runId,
            rootRunId: frame.rootRunId,
            sessionId: frame.sessionId,
            status: 'awaiting_approval',
          }),
        }, 'system', `Clarification requested for run:${shortId(frame.runId)}.`, frame.runId);
      }

      const output = formatRunOutput(frame.output);
      return appendFeed({
        ...state,
        runs: upsertRun(state.runs, {
          runId: frame.runId,
          rootRunId: frame.rootRunId,
          sessionId: frame.sessionId,
          status: 'succeeded',
          output,
        }),
      }, 'run', output || `Run ${shortId(frame.runId)} succeeded.`, frame.runId);
    }
    case 'approval.requested':
      return appendFeed({
        ...state,
        pendingApproval: {
          runId: frame.runId,
          rootRunId: frame.rootRunId,
          sessionId: frame.sessionId,
          toolName: frame.toolName,
          reason: frame.reason,
        },
        runs: upsertRun(state.runs, {
          runId: frame.runId,
          rootRunId: frame.rootRunId,
          sessionId: frame.sessionId,
          status: 'awaiting_approval',
        }),
      }, 'system', `Approval requested${frame.toolName ? ` for ${frame.toolName}` : ''}.`, frame.runId);
    case 'agent.event': {
      const summary = summarizeAgentEvent(frame);
      const eventRunId = frame.runId ?? frame.rootRunId ?? 'unknown';
      const existingRun = state.runs.find((run) => run.runId === eventRunId);
      const existingSettled = existingRun?.status === 'succeeded' || existingRun?.status === 'failed';
      const nextStatus = existingSettled ? existingRun!.status : inferRunStatus(summary, state.session.status);
      const nextState = {
        ...state,
        events: [summary, ...state.events].slice(0, 250),
        runs: upsertRun(state.runs, {
          runId: eventRunId,
          rootRunId: frame.rootRunId,
          status: nextStatus,
          latestEvent: summary,
        }),
        modelActivity: nextModelActivity(state.modelActivity, frame),
      };

      const progressMessage = formatLiveProgressUpdate(frame);
      if (!progressMessage) {
        return nextState;
      }

      return appendFeed(nextState, 'assistant', formatProgressFeedEntry(summary, progressMessage), frame.runId ?? frame.rootRunId);
    }
    case 'error':
      return appendFeed(state, 'system', `error[${frame.code}]: ${frame.message}`);
    case 'pong':
      return appendFeed(state, 'system', `pong${frame.id ? ` (${frame.id})` : ''}`);
    default:
      return state;
  }
}

function appendFeed(state: LiveGatewayState, kind: FeedEntry['kind'], content: string, runId?: string): LiveGatewayState {
  return {
    ...state,
    feed: [
      ...state.feed,
      {
        id: crypto.randomUUID(),
        kind,
        content,
        timestamp: new Date(),
        runId,
      },
    ],
  };
}

function formatProgressFeedEntry(summary: LiveAgentEventSummary, progressMessage: string): string {
  const assistantContent = summary.assistantContent?.trim();
  if (!assistantContent || !shouldShowAssistantContentWithProgress(summary.eventType)) {
    return progressMessage;
  }

  return `${assistantContent}\n\n${progressMessage}`;
}

function shouldShowAssistantContentWithProgress(eventType: string): boolean {
  return eventType === 'tool.started' || eventType === 'approval.requested' || eventType === 'delegate.spawned';
}

function upsertRun(runs: RunActivity[], patch: Partial<RunActivity> & { runId: string }): RunActivity[] {
  const now = new Date();
  const existing = runs.find((run) => run.runId === patch.runId);
  if (!existing) {
    return [
      {
        runId: patch.runId,
        rootRunId: patch.rootRunId,
        sessionId: patch.sessionId,
        status: patch.status ?? 'unknown',
        goal: patch.goal,
        latestEvent: patch.latestEvent,
        eventCount: patch.latestEvent ? 1 : 0,
        startedAt: now,
        updatedAt: now,
        output: patch.output,
        error: patch.error,
      },
      ...runs,
    ];
  }

  return runs.map((run) =>
    run.runId === patch.runId
      ? {
          ...run,
          ...patch,
          eventCount: patch.latestEvent ? run.eventCount + 1 : run.eventCount,
          updatedAt: now,
        }
      : run,
  );
}

function nextModelActivity(
  current: ModelActivitySnapshot | undefined,
  frame: { eventType: string; data: unknown; runId?: string; rootRunId?: string; createdAt?: string },
): ModelActivitySnapshot | undefined {
  const payload = frame.data && typeof frame.data === 'object' && !Array.isArray(frame.data)
    ? (frame.data as Record<string, unknown>)
    : {};
  const runId = frame.runId ?? frame.rootRunId;
  const eventTime = frame.createdAt ? new Date(frame.createdAt) : new Date();

  switch (frame.eventType) {
    case 'model.started': {
      const provider = readPayloadString(payload, 'provider');
      const model = readPayloadString(payload, 'model');
      const target = [provider, model].filter((part): part is string => Boolean(part)).join('/');
      const timeoutMs = readPayloadNumber(payload, 'modelTimeoutMs');
      return {
        status: 'thinking',
        runId,
        target: target || undefined,
        startedAt: eventTime,
        timeoutMs,
      };
    }
    case 'model.completed': {
      if (!current || (current.runId && runId && current.runId !== runId)) {
        return undefined;
      }
      return {
        ...current,
        status: 'completed',
        completedAt: eventTime,
        durationMs: readPayloadNumber(payload, 'durationMs'),
        finishReason: readPayloadString(payload, 'finishReason'),
        toolCallCount: readPayloadNumber(payload, 'toolCallCount'),
      };
    }
    case 'model.failed': {
      if (!current || (current.runId && runId && current.runId !== runId)) {
        return undefined;
      }
      const errorRecord = payload.error && typeof payload.error === 'object' && !Array.isArray(payload.error)
        ? (payload.error as Record<string, unknown>)
        : {};
      const errorMessage =
        readPayloadString(errorRecord, 'message') ??
        readPayloadString(payload, 'error') ??
        readPayloadString(payload, 'reason') ??
        readPayloadString(payload, 'message');
      return {
        ...current,
        status: 'failed',
        completedAt: eventTime,
        durationMs: readPayloadNumber(payload, 'durationMs'),
        timedOut: payload.timedOut === true,
        error: errorMessage,
      };
    }
    case 'run.completed':
    case 'run.failed':
    case 'run.interrupted':
      if (!current || (current.runId && runId && current.runId !== runId)) {
        return current;
      }
      return undefined;
    default:
      return current;
  }
}

function readPayloadString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readPayloadNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function inferRunStatus(event: LiveAgentEventSummary, sessionStatus: SessionStatus): RunActivity['status'] {
  if (event.eventType.includes('failed')) {
    return 'failed';
  }
  if (event.eventType.includes('completed') || event.eventType.includes('succeeded')) {
    return 'succeeded';
  }
  if (sessionStatus === 'awaiting_approval') {
    return 'awaiting_approval';
  }
  return 'running';
}

function resolvePendingApproval(state: LiveGatewayState, activeRun: RunActivity | undefined): PendingApproval | undefined {
  if (state.pendingApproval) {
    return state.pendingApproval;
  }

  if (state.session.status !== 'awaiting_approval') {
    return undefined;
  }

  const runId = state.session.activeRunId ?? activeRun?.runId;
  if (!runId) {
    return undefined;
  }

  const latestApprovalEvent = activeRun?.latestEvent?.eventType.includes('approval') ? activeRun.latestEvent : undefined;
  return {
    runId,
    rootRunId: state.session.activeRootRunId ?? activeRun?.rootRunId,
    sessionId: activeRun?.sessionId ?? state.session.runSessionId ?? state.session.sessionId,
    toolName: latestApprovalEvent?.toolName,
    reason: latestApprovalEvent?.detail,
  };
}

function parseRoles(value: string): string[] {
  const roles = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return roles.length > 0 ? roles : ['member'];
}

function MinimalOutput(props: { blocks: MinimalOutputBlock[] }): ReactElement {
  if (props.blocks.length === 0) {
    return <MarkdownBlock source="_No output yet._" />;
  }

  return (
    <div className="minimal-output-stream">
      {props.blocks.map((block) =>
        block.kind === 'assistant-progress' ? (
          <AssistantProgressBlock key={block.id} block={block} />
        ) : (
          <article key={block.id} className="minimal-output-block">
            <MarkdownBlock source={block.source} />
          </article>
        ),
      )}
    </div>
  );
}

function AssistantProgressBlock(props: { block: Extract<MinimalOutputBlock, { kind: 'assistant-progress' }> }): ReactElement {
  const summaries = summarizeToolActivity(props.block.toolMessages);

  return (
    <article className="assistant-progress-card">
      <div className="assistant-progress-content">
        <MarkdownBlock source={props.block.assistantContent} />
      </div>
      <div className="assistant-progress-tools" aria-label="Tool activity">
        <span className="assistant-progress-tools-label">Tools</span>
        <div className="assistant-progress-tool-chips">
          {summaries.map((summary) => (
            <span key={summary.key} className={`assistant-progress-tool-chip ${summary.tone}`} title={summary.title}>
              <code>{summary.label}</code>
              {summary.count > 1 ? <span>{`x${summary.count}`}</span> : null}
            </span>
          ))}
        </div>
      </div>
    </article>
  );
}

function MarkdownBlock(props: { source: string }): ReactElement {
  const html = useMemo(() => marked.parse(props.source.trim().length > 0 ? props.source : '_No output yet._', { async: false }) as string, [props.source]);
  return <div className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />;
}

function SendIcon(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20V4" />
      <path d="m5 11 7-7 7 7" />
    </svg>
  );
}

function PaperclipIcon(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m21 11.5-8.7 8.7a5.1 5.1 0 0 1-7.2-7.2l9.2-9.2a3.4 3.4 0 0 1 4.8 4.8l-9.1 9.1a1.7 1.7 0 0 1-2.4-2.4l8.4-8.4" />
    </svg>
  );
}

function SaveIcon(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 4h11l3 3v13H5z" />
      <path d="M9 4v5h6" />
      <path d="M9 16h6" />
    </svg>
  );
}

function ResetIcon(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 11a8 8 0 1 0 2.35-5.66L3 8" />
      <path d="M3 4v4h4" />
    </svg>
  );
}

function SettingsIcon(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9.6 2.8h4.8l.6 3.1a7.5 7.5 0 0 1 1.7.9l3-1.1 2.4 4.1-2.4 2a7.9 7.9 0 0 1 0 2l2.4 2-2.4 4.1-3-1.1a7.5 7.5 0 0 1-1.7.9l-.6 3.1H9.6L9 19.7a7.5 7.5 0 0 1-1.7-.9l-3 1.1-2.4-4.1 2.4-2a7.9 7.9 0 0 1 0-2l-2.4-2 2.4-4.1 3 1.1A7.5 7.5 0 0 1 9 5.9z" />
      <circle cx="12" cy="12.8" r="4.6" />
    </svg>
  );
}

function ApproveIcon(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m5 13 4 4L19 7" />
    </svg>
  );
}

function RejectIcon(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m7 7 10 10" />
      <path d="m17 7-10 10" />
    </svg>
  );
}

function ConnectionIcon(props: { state: LiveGatewayState['socketState'] }): ReactElement {
  if (props.state === 'connected') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <g transform="rotate(-45 12 12)">
          <path d="M2.6 12h2.6" />
          <rect x="5.2" y="8.4" width="4.4" height="7.2" rx="1.3" />
          <path d="M9.6 10.5h2.6" />
          <path d="M9.6 13.5h2.6" />
          <path d="M21.4 12h-2.6" />
          <rect x="14.4" y="8.4" width="4.4" height="7.2" rx="1.3" />
          <path d="M14.4 10.5h-2.6" />
          <path d="M14.4 13.5h-2.6" />
        </g>
      </svg>
    );
  }

  if (props.state === 'connecting') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="2.4" />
        <path d="M12 4a8 8 0 0 1 8 8" />
        <path d="M12 7.5a4.5 4.5 0 0 1 4.5 4.5" />
        <path d="M12 20a8 8 0 0 1-8-8" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <g transform="rotate(-45 12 12)">
        <path d="M2.6 12h2.6" />
        <rect x="5.2" y="8.4" width="4.4" height="7.2" rx="1.3" />
        <path d="M9.6 10.5h1.6" />
        <path d="M9.6 13.5h1.6" />
        <path d="M21.4 12h-2.6" />
        <rect x="14.4" y="8.4" width="4.4" height="7.2" rx="1.3" />
        <path d="M14.4 10.5h-1.6" />
        <path d="M14.4 13.5h-1.6" />
      </g>
    </svg>
  );
}

const LIVE_STATE_STORAGE_KEY = 'agent-smith.gateway-web.live-state.v1';
const CONNECTION_SETTINGS_STORAGE_KEY = 'agent-smith.gateway-web.connection-settings.v1';
const RUN_LIVE_STATE_STORAGE_KEY = 'agent-smith.gateway-web.run-live-state.v1';
const RUN_CONNECTION_SETTINGS_STORAGE_KEY = 'agent-smith.gateway-web.run-connection-settings.v1';

function gatewayIdentityFromDefaults(defaults: GatewayDefaults): GatewayIdentity {
  return {
    channel: defaults.channel,
    subject: defaults.subject,
    tenantId: defaults.tenantId,
    roles: defaults.roles,
  };
}

function gatewayRunIdentityFromDefaults(defaults: GatewayDefaults): GatewayIdentity {
  return {
    ...gatewayIdentityFromDefaults(defaults),
    channel: 'web',
    tenantId: 'free',
    roles: ['member'],
  };
}

function saveConnectionSettings(storageKey: string, settings: SavedConnectionSettings): void {
  localStorage.setItem(storageKey, JSON.stringify(settings));
}

function loadSavedConnectionSettings(storageKey: string): SavedConnectionSettings | undefined {
  const raw = localStorage.getItem(storageKey);
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<SavedConnectionSettings> & {
      identity?: Partial<GatewayIdentity>;
    };
    if (
      typeof parsed.socketUrl !== 'string' ||
      typeof parsed.identity?.channel !== 'string' ||
      typeof parsed.identity.subject !== 'string' ||
      typeof parsed.identity.tenantId !== 'string'
    ) {
      return undefined;
    }

    return {
      socketUrl: parsed.socketUrl,
      identity: {
        channel: parsed.identity.channel,
        subject: parsed.identity.subject,
        tenantId: parsed.identity.tenantId,
        roles: Array.isArray(parsed.identity.roles)
          ? parsed.identity.roles.filter((role): role is string => typeof role === 'string' && role.trim().length > 0)
          : ['member'],
      },
      useDevToken: typeof parsed.useDevToken === 'boolean' ? parsed.useDevToken : true,
      customToken: typeof parsed.customToken === 'string' ? parsed.customToken : '',
    };
  } catch {
    return undefined;
  }
}

function saveLiveState(storageKey: string, state: LiveGatewayState): void {
  const snapshot: LiveGatewayState = {
    ...state,
    socketState: 'idle',
    socketDetail: '',
  };
  localStorage.setItem(storageKey, JSON.stringify(snapshot));
}

function loadSavedLiveState(storageKey: string): LiveGatewayState | undefined {
  const raw = localStorage.getItem(storageKey);
  if (!raw) {
    return undefined;
  }

  try {
    return reviveLiveState(JSON.parse(raw) as LiveGatewayState);
  } catch {
    return undefined;
  }
}

function reviveLiveState(state: LiveGatewayState): LiveGatewayState {
  return {
    ...state,
    feed: state.feed.map((entry) => ({ ...entry, timestamp: new Date(entry.timestamp) })),
    events: state.events.map((event) => ({ ...event, timestamp: new Date(event.timestamp) })),
    runs: state.runs.map((run) => ({
      ...run,
      startedAt: new Date(run.startedAt),
      updatedAt: new Date(run.updatedAt),
      latestEvent: run.latestEvent ? { ...run.latestEvent, timestamp: new Date(run.latestEvent.timestamp) } : undefined,
    })),
    modelActivity: state.modelActivity
      ? {
          ...state.modelActivity,
          startedAt: new Date(state.modelActivity.startedAt),
          completedAt: state.modelActivity.completedAt ? new Date(state.modelActivity.completedAt) : undefined,
        }
      : undefined,
  };
}

function buildTranscriptMarkdown(state: LiveGatewayState): string {
  const sessionId = readCurrentSessionId(state);
  const lines = [
    '# AgentSmith Session Export',
    '',
    `- Exported: ${new Date().toISOString()}`,
    `- Session: ${sessionId ?? 'none'}`,
    `- Status: ${state.session.status}`,
    `- Active run: ${state.session.activeRunId ?? state.session.activeRootRunId ?? 'none'}`,
    '',
    '## Transcript',
    '',
  ];

  for (const entry of state.feed) {
    lines.push(`### ${entry.kind} · ${formatClockTime(entry.timestamp)}`);
    lines.push('');
    if (entry.kind === 'assistant' || entry.kind === 'run') {
      lines.push(entry.content.trim().length > 0 ? entry.content : '_No output._');
    } else {
      lines.push('~~~text');
      lines.push(entry.content);
      lines.push('~~~');
    }
    lines.push('');
  }

  if (state.events.length > 0) {
    lines.push('## Live Events');
    lines.push('');
    for (const event of state.events.slice(0, 40).reverse()) {
      lines.push(`- ${formatClockTime(event.timestamp)} · ${event.compactText}`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

function buildMinimalOutputMarkdown(state: LiveGatewayState): string {
  return state.feed
    .filter((entry) => entry.kind === 'assistant' || entry.kind === 'run')
    .map((entry) => entry.content.trim())
    .filter((content) => content.length > 0)
    .join('\n\n---\n\n');
}

function buildMinimalOutputBlocks(state: LiveGatewayState): MinimalOutputBlock[] {
  const blocks: MinimalOutputBlock[] = [];
  let activeProgressBlock: Extract<MinimalOutputBlock, { kind: 'assistant-progress' }> | undefined;

  for (const entry of state.feed) {
    if (entry.kind !== 'assistant' && entry.kind !== 'run') {
      continue;
    }

    const progressEntry = entry.kind === 'assistant' ? splitAssistantProgressEntry(entry.content) : undefined;
    if (progressEntry) {
      if (
        activeProgressBlock &&
        activeProgressBlock.runId === entry.runId &&
        activeProgressBlock.assistantContent === progressEntry.assistantContent
      ) {
        activeProgressBlock.toolMessages.push(progressEntry.toolMessage);
        continue;
      }

      activeProgressBlock = {
        kind: 'assistant-progress',
        id: entry.id,
        assistantContent: progressEntry.assistantContent,
        toolMessages: [progressEntry.toolMessage],
        runId: entry.runId,
      };
      blocks.push(activeProgressBlock);
      continue;
    }

    const source = entry.content.trim();
    if (source.length === 0) {
      continue;
    }

    activeProgressBlock = undefined;
    blocks.push({ kind: 'markdown', id: entry.id, source });
  }

  return blocks;
}

function splitAssistantProgressEntry(content: string): { assistantContent: string; toolMessage: string } | undefined {
  const trimmed = content.trim();
  const separatorIndex = trimmed.lastIndexOf('\n\n');
  if (separatorIndex < 0) {
    return undefined;
  }

  const assistantContent = trimmed.slice(0, separatorIndex).trim();
  const toolMessage = trimmed.slice(separatorIndex + 2).trim();
  if (!assistantContent || !toolMessage || toolMessage.includes('\n') || !isAssistantToolProgressMessage(toolMessage)) {
    return undefined;
  }

  return { assistantContent, toolMessage };
}

function isAssistantToolProgressMessage(value: string): boolean {
  return (
    value.startsWith('Running `') ||
    value.startsWith('Waiting for approval to run `') ||
    value.startsWith('Delegating to `') ||
    value === 'Delegating to a child run.'
  );
}

function summarizeToolActivity(messages: string[]): ToolActivitySummary[] {
  const summaries = new Map<string, ToolActivitySummary>();

  for (const message of messages) {
    const parsed = parseToolActivityMessage(message);
    const key = `${parsed.tone}:${parsed.label}`;
    const existing = summaries.get(key);
    if (existing) {
      summaries.set(key, {
        ...existing,
        count: existing.count + 1,
        title: `${existing.title}\n${message}`,
      });
      continue;
    }

    summaries.set(key, {
      key,
      label: parsed.label,
      tone: parsed.tone,
      count: 1,
      title: message,
    });
  }

  return Array.from(summaries.values());
}

function parseToolActivityMessage(message: string): Pick<ToolActivitySummary, 'label' | 'tone'> {
  const approvalToolName = message.match(/^Waiting for approval to run `([^`]+)`/)?.[1];
  if (approvalToolName) {
    return { label: approvalToolName, tone: 'approval' };
  }

  const runningToolName = message.match(/^Running `([^`]+)`/)?.[1];
  if (runningToolName) {
    return { label: runningToolName, tone: 'tool' };
  }

  const delegateName = message.match(/^Delegating to `([^`]+)`/)?.[1];
  if (delegateName) {
    return { label: delegateName, tone: 'delegate' };
  }

  return { label: 'activity', tone: 'activity' };
}

function resolveMinimalProgressIndicator(
  run: RunActivity | undefined,
  latestEvent: LiveAgentEventSummary | undefined,
  sessionStatus: SessionStatus,
): MinimalProgressIndicator | undefined {
  const runInProgress = sessionStatus === 'running' || run?.status === 'running';
  if (!runInProgress) {
    return undefined;
  }

  if (!latestEvent) {
    return { kind: 'step', label: 'Run in progress' };
  }

  if (isDelegateToolInProgress(latestEvent)) {
    const delegateName = latestEvent.toolName?.replace(/^delegate\./, '');
    const detail = latestEvent.toolName ? formatToolProgressDetail(latestEvent.toolName, latestEvent.input) : undefined;
    return {
      kind: 'delegate',
      label: delegateName
        ? `Delegating to ${delegateName}${detail ? ` ${detail}` : ''}`
        : 'Delegate tool in progress',
    };
  }

  if (isSettledProgressEvent(latestEvent.eventType)) {
    return { kind: 'step', label: 'Preparing next step' };
  }

  if (latestEvent.toolName) {
    const detail = formatToolProgressDetail(latestEvent.toolName, latestEvent.input);
    return { kind: 'step', label: `Running ${latestEvent.toolName}${detail ? ` ${detail}` : ''}` };
  }

  if (latestEvent.eventType === 'run.retry_started') {
    return { kind: 'step', label: 'Retrying run' };
  }

  return { kind: 'step', label: 'Run in progress' };
}

function isDelegateToolInProgress(event: LiveAgentEventSummary): boolean {
  if (isSettledProgressEvent(event.eventType)) {
    return false;
  }

  return event.eventType === 'delegate.spawned' || event.toolName?.startsWith('delegate.') === true;
}

function isSettledProgressEvent(eventType: string): boolean {
  return ['completed', 'succeeded', 'resolved', 'failed', 'error'].some((token) => eventType.includes(token));
}

function buildThinkingChipLabel(activity: ModelActivitySnapshot, now: number): string {
  if (activity.status === 'thinking') {
    const elapsed = Math.max(0, now - activity.startedAt.getTime());
    return `thinking ${formatThinkingElapsed(elapsed)}`;
  }
  if (activity.status === 'completed') {
    return activity.durationMs !== undefined ? `model ${formatDuration(activity.durationMs)}` : 'model done';
  }
  if (activity.timedOut) {
    return activity.durationMs !== undefined
      ? `model timed out (${formatDuration(activity.durationMs)})`
      : 'model timed out';
  }
  return activity.durationMs !== undefined ? `model failed (${formatDuration(activity.durationMs)})` : 'model failed';
}

function buildThinkingChipTitle(activity: ModelActivitySnapshot): string {
  const parts: string[] = [];
  if (activity.target) {
    parts.push(activity.target);
  }
  if (activity.status === 'thinking' && activity.timeoutMs !== undefined) {
    parts.push(`timeout ${formatDuration(activity.timeoutMs)}`);
  }
  if (activity.status === 'completed') {
    if (activity.finishReason) parts.push(`finish=${activity.finishReason}`);
    if (activity.toolCallCount !== undefined && activity.toolCallCount > 0) {
      parts.push(`toolCalls=${activity.toolCallCount}`);
    }
  }
  if (activity.status === 'failed' && activity.error) {
    parts.push(activity.error);
  }
  return parts.join(' · ');
}

function formatThinkingElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
}

function buildRuntimeLabel(run: RunActivity | undefined, sessionStatus: SessionStatus, now: number): string {
  if (!run) {
    return `session ${sessionStatus}`;
  }

  const settled = run.status === 'succeeded' || run.status === 'failed';
  const active =
    !settled &&
    (run.status === 'running' ||
      run.status === 'awaiting_approval' ||
      sessionStatus === 'running' ||
      sessionStatus === 'awaiting_approval');
  const end = active ? now : run.updatedAt.getTime();
  const label = active ? 'working' : run.status;
  return `${label} ${formatElapsedClock(end - run.startedAt.getTime())}`;
}

function describeComposerSubmission(text: string, images?: GatewayImageInput[]): string {
  if (!images || images.length === 0) {
    return text;
  }

  const detail = images[0].detail ?? 'auto';
  const imageNames = images.map(formatImageInputLabel).join(', ');
  return `${text}\n[image${images.length === 1 ? '' : 's'}: ${imageNames} (${detail})]`;
}

function formatImageInputLabel(image: GatewayImageInput): string {
  if ('path' in image) {
    return image.name ?? image.path;
  }

  return image.name ?? image.uploadId;
}

function formatSelectedImageFiles(files: File[]): string {
  if (files.length === 0) {
    return 'Attach image';
  }

  if (files.length === 1) {
    return files[0].name;
  }

  return `${files.length} images selected`;
}

function formatElapsedClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }

  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function buildExportFileStem(state: LiveGatewayState): string {
  const sessionId = readCurrentSessionId(state);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `agent-smith-${sessionId ? shortId(sessionId) : 'session'}-${timestamp}`;
}

function readCurrentSessionId(state: LiveGatewayState): string | undefined {
  return state.session.sessionId ?? state.session.runSessionId;
}

function downloadTextFile(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function openPrintPreview(markdown: string, title: string): void {
  const printWindow = window.open('', '_blank', 'noopener,noreferrer');
  if (!printWindow) {
    return;
  }

  const rendered = marked.parse(markdown, { async: false }) as string;
  printWindow.document.write(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <style>
      :root {
        color: #17201d;
        background: #ffffff;
        font-family: "IBM Plex Sans", system-ui, sans-serif;
      }
      body {
        margin: 0;
        padding: 2rem;
      }
      main {
        margin: 0 auto;
        max-width: 52rem;
      }
      h1, h2, h3 {
        color: #123b34;
      }
      p, li, blockquote {
        line-height: 1.65;
      }
      pre {
        background: #f1f5f3;
        border-radius: 12px;
        overflow: auto;
        padding: 1rem;
      }
      code {
        font-family: "IBM Plex Mono", ui-monospace, monospace;
      }
      table {
        border-collapse: collapse;
        width: 100%;
      }
      td, th {
        border: 1px solid #dce6e1;
        padding: 0.55rem;
        text-align: left;
      }
      blockquote {
        border-left: 4px solid #16705e;
        color: #435851;
        margin-left: 0;
        padding-left: 1rem;
      }
      @page {
        margin: 16mm;
      }
    </style>
  </head>
  <body>
    <main>${rendered}</main>
  </body>
</html>`);
  printWindow.document.close();
  printWindow.focus();
  printWindow.setTimeout(() => printWindow.print(), 150);
}
