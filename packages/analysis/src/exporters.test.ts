import { describe, expect, it } from 'vitest'

import { buildAnalysisBundle } from './compare.js'
import { parseOutputFormats, renderAnalysisOutputs } from './exporters.js'
import { normalizeParsedEvents } from './normalize.js'
import { reconstructRunGraph } from './runs.js'

describe('exporters', () => {
  it('renders markdown html and csv outputs from the shared analysis bundle', () => {
    const events = normalizeParsedEvents([
      {
        sourceFile: '/tmp/events.log',
        line: 1,
        data: { time: 1000, event: 'run.created', runId: 'run-1', rootRunId: 'run-1', provider: 'openrouter', model: 'qwen' },
      },
      {
        sourceFile: '/tmp/events.log',
        line: 2,
        data: { time: 1100, event: 'tool.started', runId: 'run-1', rootRunId: 'run-1', stepId: 'step-1', toolName: 'write_file' },
      },
      {
        sourceFile: '/tmp/events.log',
        line: 3,
        data: { time: 1200, event: 'tool.completed', runId: 'run-1', rootRunId: 'run-1', stepId: 'step-1', toolName: 'write_file', durationMs: 100 },
      },
      {
        sourceFile: '/tmp/events.log',
        line: 4,
        data: {
          time: 2000,
          event: 'run.completed',
          runId: 'run-1',
          rootRunId: 'run-1',
          durationMs: 1000,
          usage: { totalTokens: 42, provider: 'openrouter', model: 'qwen' },
        },
      },
    ])

    const bundle = buildAnalysisBundle({
      inputCount: 1,
      fileCount: 1,
      eventCount: events.length,
      malformedLineCount: 0,
      diagnostics: [],
      runGraph: reconstructRunGraph(events),
    })

    const outputs = renderAnalysisOutputs(bundle, {
      formats: parseOutputFormats(['markdown,html,csv:runs,csv:cohorts']),
      view: 'compare',
    })

    expect(outputs.find((output) => output.format === 'markdown')?.content).toContain('# Analysis Report')
    expect(outputs.find((output) => output.format === 'markdown')?.content).toContain('## Cohorts')
    expect(outputs.find((output) => output.format === 'html')?.content).toContain('<!doctype html>')
    expect(outputs.find((output) => output.format === 'csv:runs')?.content).toContain('runId,rootRunId,parentRunId')
    expect(outputs.find((output) => output.format === 'csv:cohorts')?.content).toContain('cohortId,provider,model')
  })
})
