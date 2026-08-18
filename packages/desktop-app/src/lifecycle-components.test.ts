// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import App from './App.svelte';
import type { DesktopApi, DesktopState } from './desktop';

vi.mock('./desktop', async (loadOriginal) => ({
  ...await loadOriginal<typeof import('./desktop')>(),
  quitCancel: vi.fn(),
  quitTerminate: vi.fn(),
  quitWait: vi.fn(),
  saveWindowPresentation: vi.fn().mockResolvedValue(undefined),
}));

const mounted: Array<ReturnType<typeof mount>> = [];
const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
  }});
});

afterEach(async () => {
  while (mounted.length) await unmount(mounted.pop()!);
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const state: DesktopState = {
  agentId: 'agent', status: 'ready', configurationValid: true, runs: [], occupiedSlotCount: 0,
  capacity: 3, executionHealth: 'ready', traceHealth: 'ready', quitState: 'idle',
};

function api(overrides: Partial<DesktopApi> = {}): DesktopApi {
  return {
    getDesktopState: vi.fn().mockResolvedValue(state), reloadSettings: vi.fn().mockResolvedValue(state), saveSettings: vi.fn().mockResolvedValue(state),
    selectAttachments: vi.fn().mockResolvedValue([]), discardAttachmentDraft: vi.fn().mockResolvedValue(undefined),
    startRun: vi.fn(), stopRun: vi.fn(), getRunRecoveryPlan: vi.fn(), recoverRun: vi.fn(), steerRun: vi.fn(),
    getRunResult: vi.fn().mockResolvedValue(null), getRunOverview: vi.fn(), resolveApproval: vi.fn(),
    createChat: vi.fn(), listChats: vi.fn().mockResolvedValue([]), loadChat: vi.fn(), sendChatTurn: vi.fn(),
    previewHistoryDeletion: vi.fn(), deleteHistory: vi.fn(), listWorkspaceArtifacts: vi.fn().mockResolvedValue([]), readArtifact: vi.fn(),
    selectTrace: vi.fn().mockResolvedValue(0), getTracePrivacy: vi.fn().mockResolvedValue({ messages: false, reasoning: false, rawToolPayloads: false }), setTracePrivacy: vi.fn(),
    subscribe: vi.fn().mockResolvedValue(vi.fn()),
    ...overrides,
  } as DesktopApi;
}

describe('mounted component lifecycle ownership', () => {
  test('unmount releases a pending inspector pointer drag and desktop subscription', async () => {
    const unsubscribe = vi.fn();
    const desktopApi = api({ subscribe: vi.fn().mockResolvedValue(unsubscribe) });
    const remove = vi.spyOn(window, 'removeEventListener');
    const target = document.createElement('div');
    document.body.append(target);
    const component = mount(App, { target, props: { api: desktopApi } });
    mounted.push(component);
    await tick();
    await Promise.resolve();

    target.querySelector<HTMLButtonElement>('.inspector-resizer')?.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, clientX: 500 }),
    );
    await unmount(mounted.pop()!);

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(remove.mock.calls.some(([name]) => name === 'pointermove')).toBe(true);
    expect(remove.mock.calls.some(([name]) => name === 'pointerup')).toBe(true);
  });

  test('unmount before asynchronous subscription setup immediately releases the late listener', async () => {
    let finish!: (unsubscribe: () => void) => void;
    const unsubscribe = vi.fn();
    const desktopApi = api({ subscribe: vi.fn(() => new Promise<() => void>((resolve) => { finish = resolve; })) });
    const target = document.createElement('div');
    document.body.append(target);
    const component = mount(App, { target, props: { api: desktopApi } });
    await tick();
    await unmount(component);

    finish(unsubscribe);
    await Promise.resolve();
    await Promise.resolve();

    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
