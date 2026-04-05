import { discoverInputFiles, type InputDiscoveryDiagnostic, type InputDiscoveryResult } from './discovery.js'
import { normalizeParsedEvents, type NormalizedLogEvent } from './normalize.js'
import { parseNdjsonFiles, type ParseDiagnostic, type ParseNdjsonResult } from './parser.js'
import { reconstructRunGraph, type RunGraph } from './runs.js'

export interface AnalyzeLogInputsResult {
  discovery: InputDiscoveryResult
  parseResult: ParseNdjsonResult
  normalizedEvents: NormalizedLogEvent[]
  runGraph: RunGraph
  diagnostics: Array<InputDiscoveryDiagnostic | ParseDiagnostic>
}

export async function analyzeLogInputs(inputs: string[]): Promise<AnalyzeLogInputsResult> {
  const discovery = await discoverInputFiles(inputs)
  const parseResult = await parseNdjsonFiles(discovery.files)
  const normalizedEvents = normalizeParsedEvents(parseResult.events)
  const runGraph = reconstructRunGraph(normalizedEvents)

  return {
    discovery,
    parseResult,
    normalizedEvents,
    runGraph,
    diagnostics: [...discovery.diagnostics, ...parseResult.diagnostics],
  }
}
