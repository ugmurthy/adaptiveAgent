import { useCallback, useEffect, useMemo, useState } from 'react';

import { isDashboardError } from './client';
import type { DashboardClient } from './client';
import type {
  DashboardError,
  DashboardExplorerMode,
  DashboardFilters,
  DashboardMessagesView,
  DashboardRunListItem,
  DashboardSavedView,
  DashboardTab,
  TraceReport,
} from './types';

const EXPLORER_MODE_KEY = 'agent-smith.gateway-web.dashboard.explorer-mode.v1';

export interface DashboardState {
  filters: DashboardFilters;
  setFilters: (filters: DashboardFilters) => void;
  savedView: DashboardSavedView;
  applySavedView: (view: DashboardSavedView) => void;
  items: DashboardRunListItem[];
  selectedRootRunId: string;
  setSelectedRootRunId: (rootRunId: string) => void;
  detail: TraceReport | undefined;
  tab: DashboardTab;
  setTab: (tab: DashboardTab) => void;
  messagesView: DashboardMessagesView;
  setMessagesView: (view: DashboardMessagesView) => void;
  focusRunId: string;
  setFocusRunId: (runId: string) => void;
  explorerMode: DashboardExplorerMode;
  setExplorerMode: (mode: DashboardExplorerMode) => void;
  isLoading: boolean;
  isDetailLoading: boolean;
  error: DashboardError | undefined;
  detailError: DashboardError | undefined;
  approvalError: DashboardError | undefined;
  actionError: DashboardError | undefined;
  deleteError: DashboardError | undefined;
  approvingRunId: string;
  actingRunId: string;
  actionRunId: string;
  actionKind: 'replay' | 'retry' | '';
  actionMessage?: {
    runId: string;
    kind: 'replay' | 'retry';
    message: string;
  };
  deletingRootRunId: string;
  nextOffset: number | null;
  refresh: () => void;
  loadNextPage: () => void;
  replayRun: (rootRunId: string) => Promise<void>;
  retryRun: (runId: string) => Promise<void>;
  deleteRun: (rootRunId: string) => Promise<void>;
  resolveApproval: (runId: string, approved: boolean) => Promise<void>;
}

export function useDashboardState(client: DashboardClient, basePath: '/monitor' = '/monitor'): DashboardState {
  const initialUrlState = useMemo(readUrlState, []);
  const [filters, setFiltersState] = useState<DashboardFilters>(initialUrlState.filters);
  const [savedView, setSavedView] = useState<DashboardSavedView>('all');
  const [items, setItems] = useState<DashboardRunListItem[]>([]);
  const [selectedRootRunId, setSelectedRootRunIdState] = useState(initialUrlState.rootRunId);
  const [detail, setDetail] = useState<TraceReport>();
  const [tab, setTabState] = useState<DashboardTab>(initialUrlState.tab);
  const [messagesView, setMessagesViewState] = useState<DashboardMessagesView>(initialUrlState.messagesView);
  const [focusRunId, setFocusRunIdState] = useState(initialUrlState.focusRunId);
  const [explorerMode, setExplorerModeState] = useState<DashboardExplorerMode>(readExplorerMode);
  const [isLoading, setIsLoading] = useState(false);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [error, setError] = useState<DashboardError>();
  const [detailError, setDetailError] = useState<DashboardError>();
  const [approvalError, setApprovalError] = useState<DashboardError>();
  const [actionError, setActionError] = useState<DashboardError>();
  const [deleteError, setDeleteError] = useState<DashboardError>();
  const [approvingRunId, setApprovingRunId] = useState('');
  const [actingRunId, setActingRunId] = useState('');
  const [actionRunId, setActionRunId] = useState('');
  const [actionKind, setActionKind] = useState<'replay' | 'retry' | ''>('');
  const [actionMessage, setActionMessage] = useState<DashboardState['actionMessage']>();
  const [deletingRootRunId, setDeletingRootRunId] = useState('');
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const setFilters = useCallback((next: DashboardFilters) => {
    setFiltersState({ ...next, offset: 0 });
  }, []);

  const setSelectedRootRunId = useCallback((rootRunId: string) => {
    setApprovalError(undefined);
    setActionError(undefined);
    setDeleteError(undefined);
    setSelectedRootRunIdState(rootRunId);
  }, []);

  const setTab = useCallback((next: DashboardTab) => {
    setTabState(next);
  }, []);

  const setMessagesView = useCallback((next: DashboardMessagesView) => {
    setMessagesViewState(next);
  }, []);

  const setFocusRunId = useCallback((runId: string) => {
    setFocusRunIdState(runId);
  }, []);

  const setExplorerMode = useCallback((mode: DashboardExplorerMode) => {
    localStorage.setItem(EXPLORER_MODE_KEY, mode);
    setExplorerModeState(mode);
  }, []);

  const applySavedView = useCallback((view: DashboardSavedView) => {
    setSavedView(view);
    setFiltersState((current) => ({
      ...current,
      offset: 0,
      status: view === 'failed' ? 'failed' : view === 'running' ? 'running,awaiting_approval' : '',
      session: view === 'sessionless' ? 'sessionless' : 'any',
      requiresApproval: view === 'needs_approval' ? 'true' : '',
    }));
  }, []);

  const refresh = useCallback(() => setRefreshKey((value) => value + 1), []);

  const loadNextPage = useCallback(() => {
    if (nextOffset === null) {
      return;
    }
    setFiltersState((current) => ({ ...current, offset: nextOffset }));
  }, [nextOffset]);

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    setError(undefined);
    client
      .listRuns(filters)
      .then((result) => {
        if (!active) {
          return;
        }
        setItems((current) => (filters.offset > 0 ? [...current, ...result.items] : result.items));
        setNextOffset(result.nextOffset);
        if (!selectedRootRunId && result.items[0]) {
          setSelectedRootRunIdState(result.items[0].rootRunId);
        }
      })
      .catch((listError) => {
        if (active) {
          setError(normalizeError(listError));
        }
      })
      .finally(() => {
        if (active) {
          setIsLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [client, filters, refreshKey, selectedRootRunId]);

  useEffect(() => {
    if (!selectedRootRunId) {
      setDetail(undefined);
      return;
    }

    let active = true;
    setIsDetailLoading(true);
    setDetailError(undefined);
    client
      .getRun(selectedRootRunId, { messagesView, focusRunId })
      .then((report) => {
        if (active) {
          setDetail(report);
        }
      })
      .catch((runError) => {
        if (active) {
          setDetailError(normalizeError(runError));
        }
      })
      .finally(() => {
        if (active) {
          setIsDetailLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [client, selectedRootRunId, messagesView, focusRunId, refreshKey]);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.pathname = basePath;
    url.search = encodeUrlState({ filters, rootRunId: selectedRootRunId, tab, messagesView, focusRunId });
    window.history.replaceState({}, '', url);
  }, [basePath, filters, selectedRootRunId, tab, messagesView, focusRunId]);

  const resolveApproval = useCallback(async (runId: string, approved: boolean) => {
    if (!runId) {
      return;
    }

    setApprovalError(undefined);
    setApprovingRunId(runId);
    try {
      await client.resolveApproval(runId, approved);
      refresh();
    } catch (approvalFailure) {
      setApprovalError(normalizeError(approvalFailure));
    } finally {
      setApprovingRunId('');
    }
  }, [client, refresh]);

  const replayRun = useCallback(async (rootRunId: string) => {
    if (!rootRunId) {
      return;
    }

    setActionError(undefined);
    setActionMessage(undefined);
    setActionRunId(rootRunId);
    setActingRunId(rootRunId);
    setActionKind('replay');
    try {
      const replayResult = await client.replayRun(rootRunId);
      const message = replayResult.replayedFrameType === 'run.output'
        ? `Replayed ${replayResult.status} output from ${replayResult.sessionId}.`
        : replayResult.replayedFrameType === 'approval.requested'
          ? `Replayed pending approval from ${replayResult.sessionId}.`
          : `Reattached ${replayResult.sessionId} with ${replayResult.policy} recovery.`;
      setActionMessage({ runId: rootRunId, kind: 'replay', message });
      refresh();
    } catch (actionFailure) {
      setActionError(normalizeError(actionFailure));
    } finally {
      setActingRunId('');
      setActionKind('');
    }
  }, [client, refresh]);

  const retryRun = useCallback(async (runId: string) => {
    if (!runId) {
      return;
    }

    setActionError(undefined);
    setActionMessage(undefined);
    setActionRunId(runId);
    setActingRunId(runId);
    setActionKind('retry');
    try {
      const retryResult = await client.retryRun(runId);
      const message = retryResult.type === 'approval.requested'
        ? `Retry paused for approval on ${retryResult.runId}.`
        : `Retry returned ${retryResult.status ?? 'unknown'} for ${retryResult.runId}.`;
      setActionMessage({ runId, kind: 'retry', message });
      refresh();
    } catch (actionFailure) {
      setActionError(normalizeError(actionFailure));
    } finally {
      setActingRunId('');
      setActionKind('');
    }
  }, [client, refresh]);

  const deleteRun = useCallback(async (rootRunId: string) => {
    if (!rootRunId) {
      return;
    }

    setDeleteError(undefined);
    setDeletingRootRunId(rootRunId);
    try {
      await client.deleteRun(rootRunId);
      const remaining = items.filter((item) => item.rootRunId !== rootRunId);
      setItems(remaining);
      setSelectedRootRunIdState((selected) => selected === rootRunId ? remaining[0]?.rootRunId ?? '' : selected);
      setDetail(undefined);
      refresh();
    } catch (deleteFailure) {
      setDeleteError(normalizeError(deleteFailure));
    } finally {
      setDeletingRootRunId('');
    }
  }, [client, items, refresh]);

  return {
    filters,
    setFilters,
    savedView,
    applySavedView,
    items,
    selectedRootRunId,
    setSelectedRootRunId,
    detail,
    tab,
    setTab,
    messagesView,
    setMessagesView,
    focusRunId,
    setFocusRunId,
    explorerMode,
    setExplorerMode,
    isLoading,
    isDetailLoading,
    error,
    detailError,
    approvalError,
    actionError,
    deleteError,
    approvingRunId,
    actingRunId,
    actionRunId,
    actionKind,
    actionMessage,
    deletingRootRunId,
    nextOffset,
    refresh,
    loadNextPage,
    replayRun,
    retryRun,
    deleteRun,
    resolveApproval,
  };
}

function normalizeError(error: unknown): DashboardError {
  if (isDashboardError(error)) {
    return error;
  }
  return {
    status: 0,
    code: 'request_failed',
    message: error instanceof Error ? error.message : String(error),
  };
}

function readUrlState(): {
  filters: DashboardFilters;
  rootRunId: string;
  tab: DashboardTab;
  messagesView: DashboardMessagesView;
  focusRunId: string;
} {
  const params = new URLSearchParams(window.location.search);
  return {
    filters: {
      from: params.get('from') ?? defaultFrom(),
      to: params.get('to') ?? '',
      status: params.get('status') ?? '',
      session: readEnum(params.get('session'), ['any', 'linked', 'sessionless'], 'any'),
      requiresApproval: readEnum(params.get('requiresApproval'), ['', 'true', 'false'], ''),
      q: params.get('q') ?? '',
      sort: readEnum(params.get('sort'), ['created_desc', 'updated_desc', 'duration_desc', 'cost_desc'], 'updated_desc'),
      limit: 50,
      offset: 0,
    },
    rootRunId: params.get('rootRunId') ?? '',
    tab: readEnum(params.get('tab'), ['overview', 'output', 'messages', 'timeline', 'plans'], 'overview'),
    messagesView: readEnum(params.get('messagesView'), ['compact', 'delta', 'full'], 'compact'),
    focusRunId: params.get('focusRunId') ?? '',
  };
}

function encodeUrlState(state: {
  filters: DashboardFilters;
  rootRunId: string;
  tab: DashboardTab;
  messagesView: DashboardMessagesView;
  focusRunId: string;
}): string {
  const params = new URLSearchParams();
  setParam(params, 'rootRunId', state.rootRunId);
  setParam(params, 'from', state.filters.from);
  setParam(params, 'to', state.filters.to);
  setParam(params, 'status', state.filters.status);
  setParam(params, 'session', state.filters.session === 'any' ? '' : state.filters.session);
  setParam(params, 'requiresApproval', state.filters.requiresApproval);
  setParam(params, 'q', state.filters.q);
  setParam(params, 'sort', state.filters.sort);
  setParam(params, 'messagesView', state.messagesView === 'compact' ? '' : state.messagesView);
  setParam(params, 'focusRunId', state.focusRunId);
  setParam(params, 'tab', state.tab === 'overview' ? '' : state.tab);
  return params.toString();
}

function setParam(params: URLSearchParams, key: string, value: string): void {
  if (value) {
    params.set(key, value);
  }
}

function readEnum<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return value && allowed.includes(value as T) ? value as T : fallback;
}

function readExplorerMode(): DashboardExplorerMode {
  return readEnum(localStorage.getItem(EXPLORER_MODE_KEY), ['cards', 'table'], 'cards');
}

function defaultFrom(): string {
  const date = new Date();
  date.setDate(date.getDate() - 7);
  return date.toISOString().slice(0, 10);
}
