import { describe, expect, it } from 'vitest'

import { normalizeParsedEvents } from './normalize.js'

describe('normalizeParsedEvents', () => {
  it('normalizes known lifecycle fields into typed records', () => {
    const [event] = normalizeParsedEvents([
      {
        sourceFile: '/tmp/events.log',
        line: 4,
        data: {
          time: 1_775_285_247_759,
          event: 'tool.completed',
          runId: 'run-1',
          rootRunId: 'root-1',
          parentRunId: 'root-1',
          stepId: 'step-2',
          toolName: 'write_file',
          durationMs: 5117,
          provider: 'openrouter',
          model: 'qwen/qwen3.5-27b',
        },
      },
    ])

    expect(event).toMatchObject({
      kind: 'known',
      event: 'tool.completed',
      sourceFile: '/tmp/events.log',
      line: 4,
      runId: 'run-1',
      subjectRunId: 'run-1',
      rootRunId: 'root-1',
      parentRunId: 'root-1',
      stepId: 'step-2',
      toolName: 'write_file',
      durationMs: 5117,
      provider: 'openrouter',
      model: 'qwen/qwen3.5-27b',
      outcome: 'success',
      time: '2026-04-04T06:47:27.759Z',
      timeMs: 1_775_285_247_759,
    })
  })

  it('extracts structured failure details from summarized completion payloads', () => {
    const [event] = normalizeParsedEvents([
      {
        sourceFile: '/tmp/events.log',
        line: 8,
        data: {
          time: 2_000,
          event: 'tool.completed',
          runId: 'run-2',
          rootRunId: 'run-2',
          stepId: 'step-1',
          toolName: 'e2b_run_code',
          output: {
            type: 'object',
            preview: {
              success: false,
              error: {
                type: 'object',
                preview: {
                  name: 'ValueError',
                  value: 'probabilities do not sum to 1',
                },
              },
            },
          },
        },
      },
    ])

    expect(event).toMatchObject({
      event: 'tool.completed',
      outcome: 'failure',
      errorName: 'ValueError',
      errorValue: 'probabilities do not sum to 1',
    })
  })

  it('preserves unknown event types as generic normalized events', () => {
    const [event] = normalizeParsedEvents([
      {
        sourceFile: '/tmp/events.log',
        line: 9,
        data: {
          event: 'custom.metric_recorded',
          parentRunId: 'run-2',
          custom: 'value',
        },
      },
    ])

    expect(event).toMatchObject({
      kind: 'generic',
      event: 'custom.metric_recorded',
      parentRunId: 'run-2',
      subjectRunId: 'run-2',
      raw: {
        event: 'custom.metric_recorded',
        parentRunId: 'run-2',
        custom: 'value',
      },
    })
  })
})
