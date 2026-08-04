import { writable } from 'svelte/store';
import type { Chat, RunSummary } from './desktop';

export type WorkbenchSelection =
  | { kind: 'new-task' }
  | { kind: 'new-chat' }
  | { kind: 'task'; itemId: string; runId: string }
  | { kind: 'chat'; itemId: string }
  | { kind: 'settings' };

export type RailGroup = 'Active' | 'Needs input' | 'History';

export interface RailItem {
  id: string;
  kind: 'task' | 'chat';
  title: string;
  searchableText: string;
  createdAt: string;
  status: string;
  group: RailGroup;
  runId?: string;
}

export const workbenchSelection = writable<WorkbenchSelection>({ kind: 'new-task' });
export const inspectorOpen = writable(false);
export const mobileRailOpen = writable(false);

export function buildRailItems(runs: RunSummary[], chats: Chat[]): RailItem[] {
  const items: RailItem[] = [];
  const taskIds = new Set(runs.filter((run) => run.invocationKind === 'run').map((run) => run.itemId));
  for (const itemId of taskIds) {
    const attempts = runs.filter((run) => run.itemId === itemId && run.invocationKind === 'run');
    const selected = attempts.find((run) => run.occupiesSlot)
      ?? attempts.find((run) => run.pendingApproval)
      ?? attempts.at(-1)!;
    items.push({
      id: itemId,
      kind: 'task',
      title: selected.title,
      searchableText: selected.title,
      createdAt: selected.createdAt,
      status: selected.status,
      group: groupForRuns(attempts),
      runId: selected.runId,
    });
  }
  for (const chat of chats) {
    const chatRuns = runs.filter((run) => run.itemId === chat.itemId);
    const selected = chatRuns.find((run) => run.occupiesSlot) ?? chatRuns.at(-1);
    items.push({
      id: chat.itemId,
      kind: 'chat',
      title: chat.title,
      searchableText: [chat.title, ...chat.messages.map((message) => message.content)].join('\n'),
      createdAt: chat.createdAt,
      status: chat.readOnlyReason ? 'read only' : selected?.status ?? 'ready',
      group: groupForRuns(chatRuns),
      runId: selected?.runId,
    });
  }
  const groupOrder: Record<RailGroup, number> = { Active: 0, 'Needs input': 1, History: 2 };
  return items.sort((left, right) =>
    groupOrder[left.group] - groupOrder[right.group]
    || (left.group === 'History' ? Number(right.createdAt) - Number(left.createdAt) : left.title.localeCompare(right.title))
    || left.title.localeCompare(right.title),
  );
}

export function filterRailItems(items: RailItem[], query: string): RailItem[] {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return items;
  return items.filter((item) => {
    const text = item.searchableText.toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

function groupForRuns(runs: RunSummary[]): RailGroup {
  if (runs.some((run) => run.pendingApproval)) return 'Needs input';
  if (runs.some((run) => run.occupiesSlot)) return 'Active';
  return 'History';
}
