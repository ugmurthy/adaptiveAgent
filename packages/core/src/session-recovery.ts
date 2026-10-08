import type { AgentRun, RuntimeStores } from './types.js';

export interface SessionRecoveryTarget {
  kind: 'run' | 'swarm' | 'orchestration';
  id: string;
  status: string;
  runIds: string[];
  /** Original run identity, used to detect branching continuation histories. */
  lineageRootRunId?: string;
}

/** Resolve logical executions, not every historical attempt or delegate child. Read-only. */
export async function getSessionRecoveryTargets(stores: RuntimeStores, sessionId: string): Promise<SessionRecoveryTarget[]> {
  if (!stores.runStore.listBySession) throw new Error('Run store does not support session lookup');
  const runs = await stores.runStore.listBySession(sessionId, { order: 'asc' });
  const executions = await stores.orchestrationStore?.listBySession(sessionId) ?? [];
  const targets: SessionRecoveryTarget[] = [];
  const covered = new Set<string>();
  for (const execution of executions) {
    const stages = await stores.orchestrationStore!.listStages(execution.id);
    const runIds = stages.map((stage) => stage.runId);
    for (const id of runIds) covered.add(id);
    targets.push({ kind: 'orchestration', id: execution.id, status: execution.status, runIds });
  }

  const superseded = new Set<string>();
  const continuationSources = new Map<string, string>();
  for (const run of runs) {
    const source = await stores.continuationStore?.getByContinuationRun(run.id);
    const sourceId = source?.sourceRunId ?? run.metadata?.continuationOfRunId;
    if (typeof sourceId === 'string') {
      superseded.add(sourceId);
      continuationSources.set(run.id, sourceId);
    }
  }
  const swarm = new Map<string, AgentRun[]>();
  for (const run of runs) {
    const metadata = run.metadata?.orchestration;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) continue;
    if (metadata.kind === 'catalog' && typeof metadata.executionId === 'string') {
      covered.add(run.id);
      if (!targets.some((target) => target.id === metadata.executionId && target.kind === 'orchestration')) {
        targets.push({ kind: 'orchestration', id: metadata.executionId, status: 'unknown', runIds: [run.id] });
      }
    }
    if (metadata.kind === 'swarm') {
      let id = metadata.coordinatorRunId;
      if (id === 'pending' && metadata.role === 'coordinator') {
        id = run.id;
        let source = run.metadata?.continuationOfRunId;
        const visited = new Set<string>();
        while (typeof source === 'string' && !visited.has(source)) {
          visited.add(source);
          id = source;
          source = runs.find((candidate) => candidate.id === source)?.metadata?.continuationOfRunId;
        }
      }
      if (typeof id !== 'string' || !id || id === 'pending') continue;
      const group = swarm.get(id) ?? [];
      group.push(run);
      swarm.set(id, group);
      covered.add(run.id);
    }
  }
  for (const [id, group] of swarm) {
    const coordinator = runs.find((run) => run.id === id);
    // A partial synthesis may have succeeded while a worker still needs recovery.
    const unfinished = group.some((run) => !superseded.has(run.id) && run.status !== 'succeeded'
      && !group.some((next) => {
        const metadata = next.metadata?.orchestration;
        return metadata && typeof metadata === 'object' && !Array.isArray(metadata) && metadata.supersedesRunId === run.id;
      }));
    targets.push({ kind: 'swarm', id, status: unfinished ? 'unfinished' : coordinator?.status ?? 'unknown', runIds: group.map((run) => run.id) });
  }
  for (const run of runs) {
    if (run.parentRunId || covered.has(run.id) || superseded.has(run.id)) continue;
    let rootId = run.id;
    const visited = new Set<string>();
    while (continuationSources.has(rootId) && !visited.has(rootId)) {
      visited.add(rootId);
      rootId = continuationSources.get(rootId)!;
    }
    targets.push({ kind: 'run', id: run.id, status: run.status, runIds: [run.id],
      ...(rootId !== run.id ? { lineageRootRunId: rootId } : {}),
    });
  }
  return targets.sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
}
