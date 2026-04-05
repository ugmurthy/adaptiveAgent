import type { NormalizedLogEvent } from './normalize.js'

export interface RunSummary {
  runId: string
  rootRunId: string
  parentRunId?: string
  delegateName?: string
  startTime?: string
  startTimeMs?: number
  endTime?: string
  endTimeMs?: number
  durationMs?: number
  eventCount: number
  status: 'succeeded' | 'failed' | 'replan_required' | 'running' | 'unknown'
}

export interface ReconstructedRun {
  runId: string
  rootRunId: string
  parentRunId?: string
  delegateName?: string
  childRunIds: string[]
  timeline: NormalizedLogEvent[]
  summary: RunSummary
}

export interface RunGraph {
  runs: ReconstructedRun[]
  unassignedEvents: NormalizedLogEvent[]
}

interface MutableRunNode {
  runId: string
  rootRunId?: string
  parentRunId?: string
  delegateName?: string
  timeline: NormalizedLogEvent[]
  childRunIds: Set<string>
}

export function reconstructRunGraph(events: NormalizedLogEvent[]): RunGraph {
  const runs = new Map<string, MutableRunNode>()
  const unassignedEvents: NormalizedLogEvent[] = []

  for (const event of events) {
    const subjectRunId = event.subjectRunId
    if (!subjectRunId) {
      unassignedEvents.push(event)
      continue
    }

    const runNode = getOrCreateRunNode(runs, subjectRunId)
    runNode.timeline.push(event)
    mergeRunMetadata(runNode, event)

    if (event.parentRunId && event.parentRunId !== subjectRunId) {
      const parentNode = getOrCreateRunNode(runs, event.parentRunId)
      parentNode.childRunIds.add(subjectRunId)
      if (!runNode.parentRunId) {
        runNode.parentRunId = event.parentRunId
      }
    }

    if (event.childRunId && event.parentRunId) {
      const parentNode = getOrCreateRunNode(runs, event.parentRunId)
      const childNode = getOrCreateRunNode(runs, event.childRunId)

      parentNode.childRunIds.add(event.childRunId)
      if (!childNode.parentRunId) {
        childNode.parentRunId = event.parentRunId
      }
      if (!childNode.rootRunId && event.rootRunId) {
        childNode.rootRunId = event.rootRunId
      }
      if (!childNode.delegateName && event.delegateName) {
        childNode.delegateName = event.delegateName
      }
    }
  }

  const reconstructedRuns = [...runs.values()]
    .map((runNode) => finalizeRunNode(runNode, runs))
    .sort((left, right) => left.runId.localeCompare(right.runId))

  return {
    runs: reconstructedRuns,
    unassignedEvents,
  }
}

function getOrCreateRunNode(runs: Map<string, MutableRunNode>, runId: string): MutableRunNode {
  const existingNode = runs.get(runId)
  if (existingNode) {
    return existingNode
  }

  const runNode: MutableRunNode = {
    runId,
    timeline: [],
    childRunIds: new Set<string>(),
  }
  runs.set(runId, runNode)
  return runNode
}

function mergeRunMetadata(runNode: MutableRunNode, event: NormalizedLogEvent): void {
  if (!runNode.rootRunId && event.rootRunId) {
    runNode.rootRunId = event.rootRunId
  }
  if (!runNode.parentRunId && event.parentRunId && event.parentRunId !== runNode.runId) {
    runNode.parentRunId = event.parentRunId
  }
  if (!runNode.delegateName && event.delegateName) {
    runNode.delegateName = event.delegateName
  }
}

function finalizeRunNode(runNode: MutableRunNode, runs: Map<string, MutableRunNode>): ReconstructedRun {
  const timeline = [...runNode.timeline].sort(compareEvents)
  const summary = buildRunSummary(runNode, runs, timeline)

  return {
    runId: runNode.runId,
    rootRunId: summary.rootRunId,
    parentRunId: runNode.parentRunId,
    delegateName: runNode.delegateName,
    childRunIds: [...runNode.childRunIds].sort((left, right) => left.localeCompare(right)),
    timeline,
    summary,
  }
}

function buildRunSummary(
  runNode: MutableRunNode,
  runs: Map<string, MutableRunNode>,
  timeline: NormalizedLogEvent[],
): RunSummary {
  const timedEvents = timeline.filter((event) => event.timeMs !== undefined)
  const startEvent = timedEvents[0]
  const endEvent = timedEvents.at(-1)
  const status = deriveRunStatus(timeline)
  const terminalDurationMs = [...timeline]
    .reverse()
    .find((event) => {
      return (
        (event.event === 'run.completed' || event.event === 'run.failed' || event.event === 'replan.required') &&
        event.durationMs !== undefined
      )
    })
    ?.durationMs

  return {
    runId: runNode.runId,
    rootRunId: resolveRootRunId(runNode, runs),
    parentRunId: runNode.parentRunId,
    delegateName: runNode.delegateName,
    startTime: startEvent?.time,
    startTimeMs: startEvent?.timeMs,
    endTime: endEvent?.time,
    endTimeMs: endEvent?.timeMs,
    durationMs: terminalDurationMs ?? inferDurationMs(startEvent?.timeMs, endEvent?.timeMs),
    eventCount: timeline.length,
    status,
  }
}

function resolveRootRunId(runNode: MutableRunNode, runs: Map<string, MutableRunNode>, seen = new Set<string>()): string {
  if (runNode.rootRunId) {
    return runNode.rootRunId
  }

  if (!runNode.parentRunId || seen.has(runNode.runId)) {
    return runNode.runId
  }

  const parentNode = runs.get(runNode.parentRunId)
  if (!parentNode) {
    return runNode.parentRunId
  }

  seen.add(runNode.runId)
  return resolveRootRunId(parentNode, runs, seen)
}

function deriveRunStatus(timeline: NormalizedLogEvent[]): RunSummary['status'] {
  for (const event of [...timeline].reverse()) {
    if (event.event === 'run.completed') {
      if (event.outcome === 'failure') {
        return 'failed'
      }

      return 'succeeded'
    }
    if (event.event === 'run.failed') {
      return 'failed'
    }
    if (event.event === 'replan.required') {
      return 'replan_required'
    }
    if (event.toStatus === 'failed') {
      return 'failed'
    }
    if (event.toStatus === 'succeeded') {
      return 'succeeded'
    }
    if (event.toStatus === 'running') {
      return 'running'
    }
  }

  return timeline.length > 0 ? 'unknown' : 'running'
}

function inferDurationMs(startTimeMs?: number, endTimeMs?: number): number | undefined {
  if (startTimeMs === undefined || endTimeMs === undefined) {
    return undefined
  }

  return Math.max(0, endTimeMs - startTimeMs)
}

function compareEvents(left: NormalizedLogEvent, right: NormalizedLogEvent): number {
  if (left.timeMs !== undefined && right.timeMs !== undefined && left.timeMs !== right.timeMs) {
    return left.timeMs - right.timeMs
  }

  if (left.timeMs !== undefined && right.timeMs === undefined) {
    return -1
  }

  if (left.timeMs === undefined && right.timeMs !== undefined) {
    return 1
  }

  if (left.sourceFile !== right.sourceFile) {
    return left.sourceFile.localeCompare(right.sourceFile)
  }

  if (left.line !== right.line) {
    return left.line - right.line
  }

  return left.event.localeCompare(right.event)
}
