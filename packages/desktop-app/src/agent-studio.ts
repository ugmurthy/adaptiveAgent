import type { DesktopCatalogAgent, DesktopRecentWork } from './desktop';

const attentionRank: Record<string, number> = { error: 0, approval: 1, recovery: 2, none: 3 };

export function isLaunchable(agent: DesktopCatalogAgent): boolean {
  return !agent.archived && agent.validationState === 'valid';
}

export function filterAndSortAgents(agents: DesktopCatalogAgent[], query: string, showArchived: boolean): DesktopCatalogAgent[] {
  const needle = query.trim().toLocaleLowerCase();
  return agents.filter((agent) => (showArchived || !agent.archived) && (!needle || `${agent.name} ${agent.description ?? ''} ${agent.id}`.toLocaleLowerCase().includes(needle)))
    .sort((a, b) => (attentionRank[a.attention] ?? 3) - (attentionRank[b.attention] ?? 3) || a.name.localeCompare(b.name));
}

export interface FleetRecentWork extends DesktopRecentWork { agentId: string; agentName: string }
export function aggregateRecentWork(agents: DesktopCatalogAgent[], limit = 8): FleetRecentWork[] {
  return agents.flatMap((agent) => agent.recentWork.map((work) => ({ ...work, agentId: agent.id, agentName: agent.name })))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.runId.localeCompare(a.runId)).slice(0, limit);
}

export function agentsNeedingAttention(agents: DesktopCatalogAgent[]): DesktopCatalogAgent[] {
  return agents.filter((agent) => agent.attention !== 'none').sort((a, b) => (attentionRank[a.attention] ?? 3) - (attentionRank[b.attention] ?? 3) || a.name.localeCompare(b.name));
}
