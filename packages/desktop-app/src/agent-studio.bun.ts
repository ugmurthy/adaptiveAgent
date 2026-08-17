import { describe, expect, test } from 'bun:test';
import { aggregateRecentWork, agentsNeedingAttention, desktopTimestamp, filterAndSortAgents, isInspectable, isLaunchable, parseAgentJson } from './agent-studio';
import type { DesktopCatalogAgent } from './desktop';

const agent = (id: string, overrides: Partial<DesktopCatalogAgent> = {}): DesktopCatalogAgent => ({ id, name: id, configPath: `/${id}.json`, archived: false, validationState: 'valid', configurationFingerprint: id, status: 'ready', occupiedSlots: 0, capacity: 3, attention: 'none', recentWork: [], ...overrides });
describe('Agent Studio helpers', () => {
  test('hides archived by default and searches name, description, and id', () => {
    const agents = [agent('alpha', { description: 'Research' }), agent('old', { archived: true })];
    expect(filterAndSortAgents(agents, '', false).map((a) => a.id)).toEqual(['alpha']);
    expect(filterAndSortAgents(agents, 'research', true).map((a) => a.id)).toEqual(['alpha']);
  });
  test('prioritizes attention and aggregates newest work fleet-wide', () => {
    const agents = [agent('a', { attention: 'recovery', recentWork: [{ itemId:'1', runId:'1', title:'Earlier', status:'done', createdAt:'2026-01-01T00:00:00Z', invocationKind:'run' }] }), agent('b', { attention: 'error', recentWork: [{ itemId:'2', runId:'2', title:'Latest', status:'done', createdAt:'2026-02-01T00:00:00Z', invocationKind:'chat' }] })];
    expect(agentsNeedingAttention(agents).map((a) => a.id)).toEqual(['b', 'a']);
    expect(aggregateRecentWork(agents).map((w) => w.title)).toEqual(['Latest', 'Earlier']);
  });
  test('orders persisted epoch-millisecond timestamps and ISO timestamps', () => {
    const agents = [agent('a', { recentWork: [
      { itemId:'1', runId:'1', title:'ISO', status:'done', createdAt:'2026-01-01T00:00:00Z', invocationKind:'run' },
      { itemId:'2', runId:'2', title:'Epoch', status:'done', createdAt:'1786730064888', invocationKind:'run' },
    ] })];
    expect(desktopTimestamp('1786730064888')).toBe(1786730064888);
    expect(aggregateRecentWork(agents).map((work) => work.title)).toEqual(['Epoch', 'ISO']);
  });
  test('archived and invalid agents cannot launch', () => {
    expect(isLaunchable(agent('archived', { archived: true }))).toBe(false);
    expect(isLaunchable(agent('invalid', { validationState: 'invalid' }))).toBe(false);
    expect(isInspectable(agent('archived', { archived: true }))).toBe(true);
    expect(isInspectable(agent('invalid', { validationState: 'invalid' }))).toBe(false);
  });
  test('identifies typographic JSON delimiters without rejecting them inside strings', () => {
    expect(() => parseAgentJson('{\n  "defaultInvocationMode": “run"\n}')).toThrow('line 2, column 28: typographic quote “');
    expect(() => parseAgentJson('{"defaultInvocationMode": "run”}')).toThrow('line 1, column 31: typographic quote ”');
    expect(parseAgentJson('{"systemInstructions":"Use “quoted” words."}')).toEqual({ systemInstructions: 'Use “quoted” words.' });
  });
});
