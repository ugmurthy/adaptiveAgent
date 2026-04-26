import { useEffect, useRef, useState } from 'react';
import type { MouseEvent, ReactElement } from 'react';

import { shortId } from '../../gateway/format';
import type { DashboardError, DashboardExplorerMode, DashboardRunListItem } from './types';

export function DashboardRunList(props: {
  items: DashboardRunListItem[];
  selectedRootRunId: string;
  mode: DashboardExplorerMode;
  isLoading: boolean;
  approvalError?: DashboardError;
  actionError?: DashboardError;
  actingRunId: string;
  actionRunId: string;
  actionKind: 'replay' | 'retry' | '';
  actionMessage?: {
    runId: string;
    kind: 'replay' | 'retry';
    message: string;
  };
  approvingRunId: string;
  nextOffset: number | null;
  onSelect: (rootRunId: string) => void;
  onModeChange: (mode: DashboardExplorerMode) => void;
  onLoadMore: () => void;
  onReplayRun: (rootRunId: string) => void;
  onRetryRun: (runId: string) => void;
  onResolveApproval: (runId: string, approved: boolean) => void;
}): ReactElement {
  const [copiedRunId, setCopiedRunId] = useState<string | null>(null);
  const copiedResetTimeoutRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (copiedResetTimeoutRef.current !== null) {
      window.clearTimeout(copiedResetTimeoutRef.current);
    }
  }, []);

  const handleCopyGoal = async (event: MouseEvent<HTMLButtonElement>, item: DashboardRunListItem): Promise<void> => {
    event.stopPropagation();
    const goalText = item.goal ?? item.goalPreview ?? `run:${shortId(item.rootRunId)}`;

    try {
      await navigator.clipboard.writeText(goalText);
      setCopiedRunId(item.rootRunId);
      if (copiedResetTimeoutRef.current !== null) {
        window.clearTimeout(copiedResetTimeoutRef.current);
      }
      copiedResetTimeoutRef.current = window.setTimeout(() => {
        setCopiedRunId((current) => current === item.rootRunId ? null : current);
        copiedResetTimeoutRef.current = null;
      }, 1800);
    } catch {
      setCopiedRunId(null);
    }
  };

  return (
    <section className="dashboard-explorer" aria-label="Run explorer">
      <div className="dashboard-panel-head">
        <div>
          <p className="eyebrow">Run Explorer</p>
          <h2>Persisted root runs</h2>
        </div>
        <div className="dashboard-segmented" role="group" aria-label="Explorer mode">
          <button className={props.mode === 'cards' ? 'selected' : ''} type="button" onClick={() => props.onModeChange('cards')}>
            Cards
          </button>
          <button className={props.mode === 'table' ? 'selected' : ''} type="button" onClick={() => props.onModeChange('table')}>
            Table
          </button>
        </div>
      </div>

      {props.mode === 'table' ? (
        <div className="dashboard-table-wrap">
          <table className="dashboard-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Goal</th>
                <th>Session</th>
                <th>Updated</th>
                <th>Cost</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {props.items.map((item) => (
              <tr className={item.rootRunId === props.selectedRootRunId ? 'selected' : ''} key={item.rootRunId} onClick={() => props.onSelect(item.rootRunId)}>
                  <td><StatusChip status={item.status} /></td>
                  <td>
                    <div className="dashboard-goal-cell">
                      <span title={item.goal ?? item.goalPreview ?? `run:${shortId(item.rootRunId)}`}>
                        {item.goalPreview ?? `run:${shortId(item.rootRunId)}`}
                      </span>
                      <button
                        className={`dashboard-copy-button ${copiedRunId === item.rootRunId ? 'copied' : ''}`}
                        type="button"
                        aria-label={copiedRunId === item.rootRunId ? 'Goal copied to clipboard' : 'Copy goal to clipboard'}
                        title={copiedRunId === item.rootRunId ? 'Copied' : 'Copy goal'}
                        onClick={(event) => void handleCopyGoal(event, item)}
                      >
                        {copiedRunId === item.rootRunId ? <CheckIcon /> : <CopyIcon />}
                      </button>
                    </div>
                  </td>
                  <td>{item.sessionId ? `linked ${shortId(item.sessionId)}` : 'sessionless'}</td>
                  <td>{formatDateTime(item.updatedAt)}</td>
                  <td>{formatCost(item.estimatedCostUSD)}</td>
                  <td>
                    <RowActions
                      item={item}
                      actingRunId={props.actingRunId}
                      actionRunId={props.actionRunId}
                      actionKind={props.actionKind}
                      actionError={props.actionError}
                      actionMessage={props.actionMessage}
                      onReplayRun={props.onReplayRun}
                      onRetryRun={props.onRetryRun}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="dashboard-run-cards">
          {props.items.map((item) => (
            <article
              className={`dashboard-run-card ${item.rootRunId === props.selectedRootRunId ? 'selected' : ''}`}
              key={item.rootRunId}
              role="button"
              tabIndex={0}
              onClick={() => props.onSelect(item.rootRunId)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  props.onSelect(item.rootRunId);
                }
              }}
            >
              <div className="dashboard-run-card-top">
                <StatusChip status={item.status} />
                <span>{item.sessionId ? 'linked session' : 'sessionless'}</span>
              </div>
              <div className="dashboard-run-goal-row">
                <strong title={item.goal ?? item.goalPreview ?? `run:${shortId(item.rootRunId)}`}>
                  {item.goalPreview ?? `run:${shortId(item.rootRunId)}`}
                </strong>
                <button
                  className={`dashboard-copy-button dashboard-copy-button-inline ${copiedRunId === item.rootRunId ? 'copied' : ''}`}
                  type="button"
                  aria-label={copiedRunId === item.rootRunId ? 'Goal copied to clipboard' : 'Copy goal to clipboard'}
                  title={copiedRunId === item.rootRunId ? 'Copied' : 'Copy goal'}
                  onClick={(event) => void handleCopyGoal(event, item)}
                >
                  {copiedRunId === item.rootRunId ? <CheckIcon /> : <CopyIcon />}
                  <span>{copiedRunId === item.rootRunId ? 'Copied' : 'Copy'}</span>
                </button>
              </div>
              <span className="dashboard-run-meta">
                updated {formatDateTime(item.updatedAt)} · {item.childRunCount} children · {item.toolCallCount} tools
              </span>
              <span className="dashboard-run-meta">
                {formatTokens(item.totalPromptTokens + item.totalCompletionTokens + (item.totalReasoningTokens ?? 0))} · {formatCost(item.estimatedCostUSD)}
              </span>
              <RowActions
                item={item}
                actingRunId={props.actingRunId}
                actionRunId={props.actionRunId}
                actionKind={props.actionKind}
                actionError={props.actionError}
                actionMessage={props.actionMessage}
                onReplayRun={props.onReplayRun}
                onRetryRun={props.onRetryRun}
              />
              {item.pendingApproval ? (
                <span className="dashboard-approval-band" onClick={(event) => event.stopPropagation()}>
                  {item.pendingApproval.toolName ?? 'Approval required'}
                  <span>
                    <button type="button" disabled={props.approvingRunId === item.pendingApproval.runId} onClick={() => props.onResolveApproval(item.pendingApproval?.runId ?? '', true)}>
                      Approve
                    </button>
                    <button type="button" disabled={props.approvingRunId === item.pendingApproval.runId} onClick={() => props.onResolveApproval(item.pendingApproval?.runId ?? '', false)}>
                      Reject
                    </button>
                  </span>
                  {props.approvalError && props.approvalError.code === 'approval_session_unavailable' ? (
                    <span className="dashboard-approval-error">{props.approvalError.message}</span>
                  ) : null}
                </span>
              ) : null}
            </article>
          ))}
        </div>
      )}

      {props.items.length === 0 && !props.isLoading ? <p className="dashboard-empty">No persisted runs match these filters.</p> : null}
      <div className="dashboard-list-footer">
        <span>{props.isLoading ? 'Loading runs...' : `${props.items.length} runs loaded`}</span>
        {props.nextOffset !== null && props.items.length > 0 ? (
          <button className="ghost-button" type="button" onClick={props.onLoadMore} disabled={props.isLoading}>
            Load more
          </button>
        ) : null}
      </div>
    </section>
  );
}

export function StatusChip(props: { status: string | null | undefined }): ReactElement {
  const status = props.status ?? 'unknown';
  return <span className={`dashboard-status ${status}`}>{status}</span>;
}

function RowActions(props: {
  item: DashboardRunListItem;
  actingRunId: string;
  actionRunId: string;
  actionKind: 'replay' | 'retry' | '';
  actionError?: DashboardError;
  actionMessage?: {
    runId: string;
    kind: 'replay' | 'retry';
    message: string;
  };
  onReplayRun: (rootRunId: string) => void;
  onRetryRun: (runId: string) => void;
}): ReactElement {
  const isRowBusy = props.actingRunId === props.item.rootRunId;
  const canReplay = props.item.sessionId !== null;
  const canRetry = props.item.sessionId !== null && props.item.status === 'failed';
  const rowMessage = props.actionMessage?.runId === props.item.rootRunId ? props.actionMessage.message : null;
  const rowError = props.actionError && props.actionRunId === props.item.rootRunId
    ? `${props.actionError.code}: ${props.actionError.message}`
    : null;

  return (
    <div className="dashboard-row-actions" onClick={(event) => event.stopPropagation()}>
      <div className="dashboard-row-action-buttons">
        <button className="ghost-button" type="button" disabled={!canReplay || isRowBusy} onClick={() => props.onReplayRun(props.item.rootRunId)}>
          {isRowBusy && props.actionKind === 'replay' ? 'Replaying...' : 'Replay'}
        </button>
        <button className="ghost-button" type="button" disabled={!canRetry || isRowBusy} onClick={() => props.onRetryRun(props.item.rootRunId)}>
          {isRowBusy && props.actionKind === 'retry' ? 'Retrying...' : 'Retry'}
        </button>
      </div>
      {rowMessage ? <span className="dashboard-row-action-note">{rowMessage}</span> : null}
      {rowError ? <span className="dashboard-row-action-error">{rowError}</span> : null}
    </div>
  );
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
}

function formatTokens(value: number): string {
  return `${Intl.NumberFormat().format(value)} tokens`;
}

function formatCost(value: number): string {
  return value > 0 ? `$${value.toFixed(4)}` : '$0.00';
}

function CopyIcon(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M5 3.5A1.5 1.5 0 0 1 6.5 2h5A1.5 1.5 0 0 1 13 3.5v7A1.5 1.5 0 0 1 11.5 12h-5A1.5 1.5 0 0 1 5 10.5v-7Zm-2 3A1.5 1.5 0 0 1 4.5 5v6A1.5 1.5 0 0 0 6 12.5h4"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.35"
      />
    </svg>
  );
}

function CheckIcon(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M3.5 8.5 6.5 11.5 12.5 4.5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
    </svg>
  );
}
