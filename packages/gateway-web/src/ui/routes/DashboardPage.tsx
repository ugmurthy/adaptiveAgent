import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';

import { loadGatewayDefaults } from '../../gateway/client';
import type { GatewayDefaults, GatewayIdentity } from '../../gateway/types';
import { createDashboardClient } from '../dashboard/client';
import { DashboardInspector } from '../dashboard/DashboardInspector';
import { DashboardRunList } from '../dashboard/DashboardRunList';
import { useDashboardState } from '../dashboard/useDashboardState';
import type { DashboardFilters } from '../dashboard/types';
import { getGatewayAccessToken } from '../shared/GatewayAuth';

type DashboardAuthMode = 'inherit' | 'admin-dev' | 'custom';

const defaultIdentity: GatewayIdentity = {
  channel: 'web',
  subject: 'local-dev-user',
  tenantId: 'free',
  roles: ['member'],
};

export function DashboardPage(): ReactElement {
  const [defaults, setDefaults] = useState<GatewayDefaults>({
    socketUrl: 'ws://127.0.0.1:8959/ws',
    ...defaultIdentity,
  });
  const [authMode, setAuthMode] = useState<DashboardAuthMode>('admin-dev');
  const [customAdminToken, setCustomAdminToken] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let active = true;
    loadGatewayDefaults()
      .then((loaded) => {
        if (active) {
          setDefaults(loaded);
        }
      })
      .catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
    return () => {
      active = false;
    };
  }, []);

  const client = useMemo(() => createDashboardClient(() => {
    const identity = authMode === 'admin-dev'
      ? { channel: defaults.channel, subject: defaults.subject, tenantId: defaults.tenantId, roles: ['admin'] }
      : { channel: defaults.channel, subject: defaults.subject, tenantId: defaults.tenantId, roles: defaults.roles };

    return getGatewayAccessToken({
      identity,
      mode: authMode === 'custom' ? 'custom' : 'dev',
      customToken: customAdminToken,
    });
  }), [authMode, customAdminToken, defaults.channel, defaults.roles, defaults.subject, defaults.tenantId]);

  const dashboard = useDashboardState(client, '/monitor');
  const selectedItem = dashboard.items.find((item) => item.rootRunId === dashboard.selectedRootRunId);
  const authBlocked = dashboard.error?.code === 'session_forbidden' || dashboard.error?.code === 'auth_required';
  const selectedRunCanDelete = Boolean(selectedItem && isSessionlessTerminalRun(selectedItem.sessionId, selectedItem.status));
  const summary = useMemo(() => ({
    loaded: dashboard.items.length,
    active: dashboard.items.filter((item) => ['running', 'awaiting_approval', 'blocked'].includes(item.status ?? '')).length,
    approvals: approvalCount(dashboard.items),
    sessionless: dashboard.items.filter((item) => item.sessionId === null).length,
  }), [dashboard.items]);

  return (
    <main className="dashboard-page monitor-page">
      <section className="monitor-hero" aria-label="Monitor overview">
        <div className="monitor-hero-copy">
          <p className="eyebrow">AgentSmith Gateway</p>
          <h1>Persisted run monitor</h1>
          <p className="monitor-hero-note">
            The persisted run dashboard now lives here, reframed for faster scan-and-respond workflows.
          </p>
          <div className="monitor-route-links" role="navigation" aria-label="Gateway routes">
            <a href="/">Composer</a>
            <a className="active" href="/monitor" aria-current="page">Monitor</a>
          </div>
        </div>

        <div className="monitor-stat-grid" aria-label="Loaded run summary">
          <article className="monitor-stat-card">
            <span>Runs loaded</span>
            <strong>{summary.loaded}</strong>
            <p>Current page results visible in the explorer.</p>
          </article>
          <article className="monitor-stat-card">
            <span>Active now</span>
            <strong>{summary.active}</strong>
            <p>Running, blocked, or awaiting approval.</p>
          </article>
          <article className="monitor-stat-card">
            <span>Needs approval</span>
            <strong>{summary.approvals}</strong>
            <p>Runs asking for an admin decision.</p>
          </article>
          <article className="monitor-stat-card">
            <span>Sessionless</span>
            <strong>{summary.sessionless}</strong>
            <p>Runs that can be cleaned up after completion.</p>
          </article>
        </div>
      </section>

      <section className="dashboard-command-rail monitor-command-rail" aria-label="Dashboard commands">
        <div className="dashboard-title">
          <p className="eyebrow">AgentSmith Gateway</p>
          <h2>Monitor control rail</h2>
          <p className="monitor-command-copy">Same filters, auth controls, and quick views from the old dashboard route.</p>
          <span>{defaults.channel} · {defaults.tenantId} · {authMode === 'admin-dev' ? 'admin dev token' : authMode}</span>
        </div>

        <div className="dashboard-auth-strip">
          <label>
            Dashboard auth
            <select value={authMode} onChange={(event) => setAuthMode(event.target.value as DashboardAuthMode)}>
              <option value="inherit">inherit</option>
              <option value="admin-dev">admin dev token</option>
              <option value="custom">custom admin JWT</option>
            </select>
          </label>
          {authMode === 'custom' ? (
            <label>
              Admin JWT
              <input value={customAdminToken} onChange={(event) => setCustomAdminToken(event.target.value)} placeholder="paste bearer token" />
            </label>
          ) : null}
          <button type="button" onClick={dashboard.refresh}>Refresh</button>
        </div>

        <DashboardFiltersBar filters={dashboard.filters} onChange={dashboard.setFilters} />

        <div className="dashboard-quick-views" role="group" aria-label="Saved dashboard views">
          {[
            ['all', 'All'],
            ['needs_approval', `Needs approval${approvalCount(dashboard.items) ? ` (${approvalCount(dashboard.items)})` : ''}`],
            ['failed', 'Failed'],
            ['running', 'Running'],
            ['sessionless', 'Sessionless'],
          ].map(([view, label]) => (
            <button
              className={dashboard.savedView === view ? 'selected' : ''}
              type="button"
              key={view}
              onClick={() => dashboard.applySavedView(view as Parameters<typeof dashboard.applySavedView>[0])}
            >
              {label}
            </button>
          ))}
        </div>
      </section>

      {notice ? <p className="dashboard-error">{notice}</p> : null}
      {dashboard.approvalError ? (
        <p className="dashboard-approval-error dashboard-approval-error-global">
          {dashboard.approvalError.status ? `${dashboard.approvalError.status} ` : ''}{dashboard.approvalError.code}: {dashboard.approvalError.message}
        </p>
      ) : null}
      {authBlocked ? (
        <section className="dashboard-lock">
          <p className="eyebrow">Admin access required</p>
          <h2>{dashboard.error?.message ?? 'Monitor route requires the admin role.'}</h2>
          <p>Unlock this page with an admin dev token or paste a custom admin JWT. The composer route can keep using its own non-admin socket identity.</p>
          <div className="dashboard-auth-strip">
            <button type="button" onClick={() => setAuthMode('admin-dev')}>Use admin dev token</button>
            <label>
              Admin JWT
              <input value={customAdminToken} onChange={(event) => setCustomAdminToken(event.target.value)} placeholder="paste bearer token" />
            </label>
          </div>
        </section>
      ) : (
        <section className="dashboard-workbench">
          <DashboardRunList
            items={dashboard.items}
            selectedRootRunId={dashboard.selectedRootRunId}
            mode={dashboard.explorerMode}
            isLoading={dashboard.isLoading}
            approvalError={dashboard.approvalError}
            actionError={dashboard.actionError}
            actingRunId={dashboard.actingRunId}
            actionRunId={dashboard.actionRunId}
            actionKind={dashboard.actionKind}
            actionMessage={dashboard.actionMessage}
            approvingRunId={dashboard.approvingRunId}
            nextOffset={dashboard.nextOffset}
            onSelect={dashboard.setSelectedRootRunId}
            onModeChange={dashboard.setExplorerMode}
            onLoadMore={dashboard.loadNextPage}
            onReplayRun={(rootRunId) => void dashboard.replayRun(rootRunId)}
            onRetryRun={(runId) => void dashboard.retryRun(runId)}
            onResolveApproval={(runId, approved) => void dashboard.resolveApproval(runId, approved)}
          />
          <DashboardInspector
            detail={dashboard.detail}
            selectedRootRunId={dashboard.selectedRootRunId}
            tab={dashboard.tab}
            messagesView={dashboard.messagesView}
            focusRunId={dashboard.focusRunId}
            isLoading={dashboard.isDetailLoading}
            errorMessage={dashboard.detailError?.message ?? dashboard.error?.message}
            approvalError={dashboard.approvalError}
            deleteError={dashboard.deleteError}
            approvingRunId={dashboard.approvingRunId}
            deletingRootRunId={dashboard.deletingRootRunId}
            pendingApproval={selectedItem?.pendingApproval}
            canDeleteRun={selectedRunCanDelete}
            onTabChange={dashboard.setTab}
            onMessagesViewChange={dashboard.setMessagesView}
            onFocusRunIdChange={dashboard.setFocusRunId}
            onDeleteRun={(rootRunId) => void dashboard.deleteRun(rootRunId)}
            onResolveApproval={(runId, approved) => void dashboard.resolveApproval(runId, approved)}
          />
        </section>
      )}
    </main>
  );
}

function DashboardFiltersBar(props: {
  filters: DashboardFilters;
  onChange: (filters: DashboardFilters) => void;
}): ReactElement {
  const update = (patch: Partial<DashboardFilters>) => props.onChange({ ...props.filters, ...patch });

  return (
    <div className="dashboard-filters">
      <label>
        Search
        <input value={props.filters.q} onChange={(event) => update({ q: event.target.value })} placeholder="goal, error, output" />
      </label>
      <label>
        From
        <input type="date" value={props.filters.from.slice(0, 10)} onChange={(event) => update({ from: event.target.value })} />
      </label>
      <label>
        To
        <input type="date" value={props.filters.to.slice(0, 10)} onChange={(event) => update({ to: event.target.value })} />
      </label>
      <label>
        Status
        <input value={props.filters.status} onChange={(event) => update({ status: event.target.value })} placeholder="failed,running" />
      </label>
      <label>
        Session
        <select value={props.filters.session} onChange={(event) => update({ session: event.target.value as DashboardFilters['session'] })}>
          <option value="any">any</option>
          <option value="linked">linked</option>
          <option value="sessionless">sessionless</option>
        </select>
      </label>
      <label>
        Sort
        <select value={props.filters.sort} onChange={(event) => update({ sort: event.target.value as DashboardFilters['sort'] })}>
          <option value="updated_desc">updated desc</option>
          <option value="created_desc">created desc</option>
          <option value="duration_desc">duration desc</option>
          <option value="cost_desc">cost desc</option>
        </select>
      </label>
    </div>
  );
}

function approvalCount(items: { pendingApproval: unknown }[]): number {
  return items.filter((item) => item.pendingApproval).length;
}

function isSessionlessTerminalRun(sessionId: string | null, status: string | null): boolean {
  return sessionId === null
    && status !== null
    && ['succeeded', 'failed', 'clarification_requested', 'replan_required', 'cancelled'].includes(status);
}
