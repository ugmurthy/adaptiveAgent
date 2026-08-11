import { describe, expect, test } from 'bun:test';
import { aggregateRecentWork, agentsNeedingAttention, filterAndSortAgents, isLaunchable } from './agent-studio';
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
  test('archived and invalid agents cannot launch', () => {
    expect(isLaunchable(agent('archived', { archived: true }))).toBe(false);
    expect(isLaunchable(agent('invalid', { validationState: 'invalid' }))).toBe(false);
  });
});
