// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import AgentStudio from './AgentStudio.svelte';
import {
  generateAgentDraft,
  getDesktopCatalogStatus,
  listenCatalogStatusChanged,
  saveAgentConfig,
  validateAgentConfig,
  type DesktopCatalogAgent,
  type DesktopCatalogStatus,
} from './desktop';

vi.mock('./desktop', async (loadOriginal) => ({
  ...await loadOriginal<typeof import('./desktop')>(),
  generateAgentDraft: vi.fn(),
  getDesktopCatalogStatus: vi.fn(),
  listenCatalogStatusChanged: vi.fn().mockResolvedValue(vi.fn()),
  saveAgentConfig: vi.fn(),
  validateAgentConfig: vi.fn(),
}));

const mounted: Array<ReturnType<typeof mount>> = [];

const agent = (id: string, name: string): DesktopCatalogAgent => ({
  id, name, description: `${name} description`, configPath: `/agents/${id}.json`, archived: false,
  validationState: 'valid', configurationFingerprint: `${id}-fingerprint`, status: 'ready',
  occupiedSlots: 0, capacity: 3, attention: 'none', recentWork: [],
});

const catalog: DesktopCatalogStatus = {
  loading: false, currentAgentId: 'default-agent', diagnostics: [], quitState: 'idle',
  agents: [agent('default-agent', 'Default Agent'), agent('architect', 'Architect')],
};

beforeEach(() => {
  vi.mocked(getDesktopCatalogStatus).mockResolvedValue(catalog);
  vi.mocked(listenCatalogStatusChanged).mockResolvedValue(vi.fn());
  vi.mocked(generateAgentDraft).mockResolvedValue({
    brief: 'Build a reviewer', generatorAgent: { requested: 'architect', id: 'architect', name: 'Architect' },
    path: '/agents/reviewer.json', agentsDir: '/agents', exists: false, duplicatePaths: [], targetFingerprint: 'absent',
    agent: { version: 1, id: 'reviewer', name: 'Reviewer', model: { provider: 'mistral', model: 'codestral-latest' } },
    draft: {}, notes: ['Review the generated instructions.'], recommendations: [],
  });
  vi.mocked(validateAgentConfig).mockResolvedValue({
    path: '/agents/reviewer.json', agentsDir: '/agents', exists: false, duplicatePaths: [], targetFingerprint: 'absent',
    agent: { version: 1, id: 'reviewer', name: 'Reviewer', model: { provider: 'mistral', model: 'codestral-latest' } },
  });
  vi.mocked(saveAgentConfig).mockResolvedValue({
    path: '/agents/reviewer.json', agentsDir: '/agents', exists: false, duplicatePaths: [], targetFingerprint: 'absent',
    agent: { version: 1, id: 'reviewer', name: 'Reviewer' },
  });
});

afterEach(async () => {
  while (mounted.length) await unmount(mounted.pop()!);
  document.body.replaceChildren();
  vi.clearAllMocks();
});

function field(target: HTMLElement, label: string): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
  const element = [...target.querySelectorAll('label')].find((candidate) => candidate.querySelector('span')?.textContent === label)
    ?.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea');
  if (!element) throw new Error(`Missing field: ${label}`);
  return element;
}

function setValue(element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string): void {
  element.value = value;
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}

function button(target: HTMLElement, label: string): HTMLButtonElement {
  const match = [...target.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

describe('Agent Studio builder', () => {
  test('forwards draft controls, reviews before writing, and saves the validated profile', async () => {
    const target = document.createElement('div');
    document.body.append(target);
    mounted.push(mount(AgentStudio, { target }));
    await vi.waitFor(() => expect(target.textContent).toContain('Default Agent'));

    button(target, '＋ New agent').click();
    await tick();
    expect(field(target, 'Generator agent').value).toBe('default-agent');
    setValue(field(target, 'Description'), 'Build a reviewer');
    setValue(field(target, 'Generator agent'), 'architect');
    setValue(field(target, 'Agent ID'), ' reviewer ');
    setValue(field(target, 'Provider'), 'mistral');
    setValue(field(target, 'Model'), ' codestral-latest ');
    await tick();
    button(target, 'Create draft').click();

    await vi.waitFor(() => expect(generateAgentDraft).toHaveBeenCalledWith({
      brief: 'Build a reviewer', generatorAgent: 'architect', id: 'reviewer', provider: 'mistral', model: 'codestral-latest',
    }));
    expect(saveAgentConfig).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(target.textContent).toContain('Review agent profile'));
    expect(target.textContent).toContain('Review the generated instructions.');

    button(target, 'Save agent').click();
    await vi.waitFor(() => expect(validateAgentConfig).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'reviewer' }), undefined, undefined,
    ));
    await vi.waitFor(() => expect(saveAgentConfig).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'reviewer' }), undefined, undefined, false, '/agents/reviewer.json', 'absent',
    ));
  });
});
