import type { DesktopCatalogAgent, DesktopRecentWork } from './desktop';

const attentionRank: Record<string, number> = { error: 0, approval: 1, recovery: 2, none: 3 };

export function desktopTimestamp(value: string): number {
  const epochMilliseconds = Number(value);
  return value.trim() !== '' && Number.isFinite(epochMilliseconds) ? epochMilliseconds : Date.parse(value);
}

export function isLaunchable(agent: DesktopCatalogAgent): boolean {
  return !agent.archived && agent.validationState === 'valid';
}

export function isInspectable(agent: DesktopCatalogAgent): boolean {
  return agent.validationState === 'valid';
}

export function filterAndSortAgents(agents: DesktopCatalogAgent[], query: string, showArchived: boolean): DesktopCatalogAgent[] {
  const needle = query.trim().toLocaleLowerCase();
  return agents.filter((agent) => (showArchived || !agent.archived) && (!needle || `${agent.name} ${agent.description ?? ''} ${agent.id}`.toLocaleLowerCase().includes(needle)))
    .sort((a, b) => (attentionRank[a.attention] ?? 3) - (attentionRank[b.attention] ?? 3) || a.name.localeCompare(b.name));
}

export interface FleetRecentWork extends DesktopRecentWork { agentId: string; agentName: string }
export function aggregateRecentWork(agents: DesktopCatalogAgent[], limit = 8): FleetRecentWork[] {
  return agents.flatMap((agent) => agent.recentWork.map((work) => ({ ...work, agentId: agent.id, agentName: agent.name })))
    .sort((a, b) => desktopTimestamp(b.createdAt) - desktopTimestamp(a.createdAt) || b.runId.localeCompare(a.runId)).slice(0, limit);
}

export function agentsNeedingAttention(agents: DesktopCatalogAgent[]): DesktopCatalogAgent[] {
  return agents.filter((agent) => agent.attention !== 'none').sort((a, b) => (attentionRank[a.attention] ?? 3) - (attentionRank[b.attention] ?? 3) || a.name.localeCompare(b.name));
}

export function parseAgentJson(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Agent JSON must be an object.');
    return value as Record<string, unknown>;
  } catch (cause) {
    const smartQuote = findSmartJsonQuote(text);
    if (smartQuote !== undefined) {
      const before = text.slice(0, smartQuote);
      const line = before.split('\n').length;
      const column = smartQuote - before.lastIndexOf('\n');
      throw new Error(`Invalid JSON at line ${line}, column ${column}: typographic quote ${text[smartQuote]} cannot delimit a JSON string. Replace it with a plain double quote (").`);
    }
    throw cause;
  }
}

function findSmartJsonQuote(text: string): number | undefined {
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      else if ((character === '“' || character === '”') && /^\s*[,}\]]/.test(text.slice(index + 1))) return index;
    } else if (character === '"') inString = true;
    else if (character === '“' || character === '”') return index;
  }
  return undefined;
}
