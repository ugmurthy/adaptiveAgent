import { stat } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'

import type { AnalyzeLogInputsResult } from './analyze.js'
import { discoverInputFiles } from './discovery.js'
import { normalizeParsedEvents } from './normalize.js'
import { parseNdjsonFiles } from './parser.js'
import { reconstructRunGraph } from './runs.js'

export interface WatchUpdate {
  kind: 'initial' | 'changed'
  iteration: number
  changedFiles: string[]
  analysis: AnalyzeLogInputsResult
}

export interface WatchLogInputsOptions {
  cwd?: string
  pollIntervalMs?: number
  maxIterations?: number
  signal?: AbortSignal
}

export async function watchLogInputs(
  inputs: string[],
  onUpdate: (update: WatchUpdate) => Promise<boolean | void> | boolean | void,
  options: WatchLogInputsOptions = {},
): Promise<void> {
  const pollIntervalMs = options.pollIntervalMs ?? 1000
  let previousSnapshot: Map<string, string> | undefined
  let iteration = 0

  while (true) {
    const discovery = await discoverInputFiles(inputs, { cwd: options.cwd })
    const snapshot = await createSnapshot(discovery.files)
    const changedFiles = diffSnapshots(previousSnapshot, snapshot)

    if (!previousSnapshot || changedFiles.length > 0) {
      const parseResult = await parseNdjsonFiles(discovery.files)
      const normalizedEvents = normalizeParsedEvents(parseResult.events)
      const runGraph = reconstructRunGraph(normalizedEvents)
      const shouldContinue = await onUpdate({
        kind: previousSnapshot ? 'changed' : 'initial',
        iteration,
        changedFiles,
        analysis: {
          discovery,
          parseResult,
          normalizedEvents,
          runGraph,
          diagnostics: [...discovery.diagnostics, ...parseResult.diagnostics],
        },
      })

      if (shouldContinue === false) {
        return
      }
    }

    previousSnapshot = snapshot
    iteration += 1

    if (options.maxIterations !== undefined && iteration >= options.maxIterations) {
      return
    }

    await sleep(pollIntervalMs, undefined, { signal: options.signal })
  }
}

async function createSnapshot(files: string[]): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>()

  for (const filePath of files) {
    try {
      const fileStat = await stat(filePath)
      snapshot.set(filePath, `${fileStat.size}:${fileStat.mtimeMs}`)
    } catch {
      snapshot.set(filePath, 'missing')
    }
  }

  return snapshot
}

function diffSnapshots(previous: Map<string, string> | undefined, current: Map<string, string>): string[] {
  if (!previous) {
    return [...current.keys()].sort((left, right) => left.localeCompare(right))
  }

  const changed = new Set<string>()

  for (const [filePath, fingerprint] of current) {
    if (previous.get(filePath) !== fingerprint) {
      changed.add(filePath)
    }
  }

  for (const filePath of previous.keys()) {
    if (!current.has(filePath)) {
      changed.add(filePath)
    }
  }

  return [...changed].sort((left, right) => left.localeCompare(right))
}
