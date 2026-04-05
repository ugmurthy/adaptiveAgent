import { describe, expect, it } from 'vitest'

import { buildAnalysisBundle } from './compare.js'
import { normalizeParsedEvents } from './normalize.js'
import { reconstructRunGraph } from './runs.js'

function buildRunEvents(options: {
  runId: string
  rootRunId?: string
  provider: string
  model: string
  startTime: number
  durationMs: number
  toolCount: number
  success: boolean
  totalTokens: number
}): Array<{ sourceFile: string; line: number; data: Record<string, unknown> }> {
  const rootRunId = options.rootRunId ?? options.runId
  const events: Array<{ sourceFile: string; line: number; data: Record<string, unknown> }> = [
    {
      sourceFile: '/tmp/events.log',
      line: 1,
      data: {
        time: options.startTime,
        event: 'run.created',
        runId: options.runId,
        rootRunId,
        provider: options.provider,
        model: options.model,
      },
    },
  ]

  for (let index = 0; index < options.toolCount; index += 1) {
    const stepId = `step-${index + 1}`
    events.push(
      {
        sourceFile: '/tmp/events.log',
        line: index + 2,
        data: {
          time: options.startTime + 100 + index * 100,
          event: 'tool.started',
          runId: options.runId,
          rootRunId,
          stepId,
          toolName: 'write_file',
          provider: options.provider,
          model: options.model,
        },
      },
      {
        sourceFile: '/tmp/events.log',
        line: index + 100,
        data: {
          time: options.startTime + 150 + index * 100,
          event: 'tool.completed',
          runId: options.runId,
          rootRunId,
          stepId,
          toolName: 'write_file',
          durationMs: 50,
          provider: options.provider,
          model: options.model,
          output: { success: index === options.toolCount - 1 ? options.success : false },
        },
      },
    )
  }

  events.push({
    sourceFile: '/tmp/events.log',
    line: 999,
    data: {
      time: options.startTime + options.durationMs,
      event: 'run.completed',
      runId: options.runId,
      rootRunId,
      durationMs: options.durationMs,
      provider: options.provider,
      model: options.model,
      output: { status: options.success ? 'success' : 'failure', error: options.success ? undefined : 'tool failed' },
      usage: {
        promptTokens: Math.floor(options.totalTokens * 0.6),
        completionTokens: Math.ceil(options.totalTokens * 0.4),
        totalTokens: options.totalTokens,
        provider: options.provider,
        model: options.model,
      },
    },
  })

  return events
}

describe('buildAnalysisBundle', () => {
  it('adds cohorts anomalies and enriched run metrics', () => {
    const events = normalizeParsedEvents([
      ...buildRunEvents({
        runId: 'run-a1',
        provider: 'openrouter',
        model: 'qwen',
        startTime: Date.parse('2026-04-04T08:00:00Z'),
        durationMs: 1000,
        toolCount: 1,
        success: true,
        totalTokens: 100,
      }),
      ...buildRunEvents({
        runId: 'run-a2',
        provider: 'openrouter',
        model: 'qwen',
        startTime: Date.parse('2026-04-04T09:00:00Z'),
        durationMs: 1200,
        toolCount: 1,
        success: true,
        totalTokens: 120,
      }),
      ...buildRunEvents({
        runId: 'run-b1',
        provider: 'openrouter',
        model: 'qwen',
        startTime: Date.parse('2026-04-05T08:00:00Z'),
        durationMs: 3200,
        toolCount: 3,
        success: false,
        totalTokens: 320,
      }),
      ...buildRunEvents({
        runId: 'run-b2',
        provider: 'openrouter',
        model: 'qwen',
        startTime: Date.parse('2026-04-05T09:00:00Z'),
        durationMs: 3600,
        toolCount: 3,
        success: true,
        totalTokens: 360,
      }),
    ])

    const bundle = buildAnalysisBundle(
      {
        inputCount: 1,
        fileCount: 1,
        eventCount: events.length,
        malformedLineCount: 0,
        diagnostics: [],
        runGraph: reconstructRunGraph(events),
      },
      {
        timeWindow: 'day',
        thresholds: {
          durationMultiplier: 1.5,
          successRateDrop: 0.2,
          tokenMultiplier: 1.5,
          toolCountMultiplier: 1.5,
        },
      },
    )

    expect(bundle.runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: 'run-a1', provider: 'openrouter', model: 'qwen', totalTokens: 100, toolInvocationCount: 1 }),
        expect.objectContaining({ runId: 'run-b1', provider: 'openrouter', model: 'qwen', totalTokens: 320, toolInvocationCount: 3 }),
      ]),
    )
    expect(bundle.cohorts).toHaveLength(2)
    expect(bundle.cohorts[0]).toMatchObject({
      provider: 'openrouter',
      model: 'qwen',
      delegateName: 'root',
      runCount: 2,
      successRate: 1,
    })
    expect(bundle.cohorts[1]).toMatchObject({
      provider: 'openrouter',
      model: 'qwen',
      delegateName: 'root',
      runCount: 2,
      successRate: 0.5,
      averageToolInvocationCount: 3,
    })
    expect(bundle.anomalies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'duration', baselineKind: 'previous_window' }),
        expect.objectContaining({ kind: 'success_rate', baselineKind: 'previous_window' }),
        expect.objectContaining({ kind: 'token_usage', baselineKind: 'previous_window' }),
        expect.objectContaining({ kind: 'tool_count', baselineKind: 'previous_window' }),
      ]),
    )
  })
})
