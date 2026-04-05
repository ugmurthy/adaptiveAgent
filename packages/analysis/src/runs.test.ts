import { describe, expect, it } from 'vitest'

import { normalizeParsedEvents } from './normalize.js'
import { reconstructRunGraph } from './runs.js'

describe('reconstructRunGraph', () => {
  it('groups timelines by run and links parent child relationships', () => {
    const events = normalizeParsedEvents([
      {
        sourceFile: '/tmp/events.log',
        line: 1,
        data: {
          time: 1_000,
          event: 'run.created',
          runId: 'root',
          rootRunId: 'root',
        },
      },
      {
        sourceFile: '/tmp/events.log',
        line: 2,
        data: {
          time: 2_000,
          event: 'delegate.spawned',
          parentRunId: 'root',
          childRunId: 'child',
          rootRunId: 'root',
          delegateName: 'code-executor',
          toolName: 'delegate.code-executor',
          stepId: 'step-1',
        },
      },
      {
        sourceFile: '/tmp/events.log',
        line: 3,
        data: {
          time: 2_100,
          event: 'run.created',
          runId: 'child',
          rootRunId: 'root',
          parentRunId: 'root',
          delegateName: 'code-executor',
        },
      },
      {
        sourceFile: '/tmp/events.log',
        line: 4,
        data: {
          time: 3_500,
          event: 'tool.completed',
          runId: 'child',
          rootRunId: 'root',
          parentRunId: 'root',
          toolName: 'e2b_run_code',
          stepId: 'step-1',
          durationMs: 1400,
        },
      },
      {
        sourceFile: '/tmp/events.log',
        line: 5,
        data: {
          time: 4_000,
          event: 'run.completed',
          runId: 'child',
          rootRunId: 'root',
          parentRunId: 'root',
          durationMs: 1900,
        },
      },
      {
        sourceFile: '/tmp/events.log',
        line: 6,
        data: {
          time: 7_000,
          event: 'run.completed',
          runId: 'root',
          rootRunId: 'root',
          durationMs: 6000,
        },
      },
    ])

    const graph = reconstructRunGraph(events)
    const rootRun = graph.runs.find((run) => run.runId === 'root')
    const childRun = graph.runs.find((run) => run.runId === 'child')

    expect(graph.unassignedEvents).toEqual([])
    expect(rootRun).toMatchObject({
      runId: 'root',
      rootRunId: 'root',
      childRunIds: ['child'],
      summary: {
        eventCount: 3,
        status: 'succeeded',
        startTimeMs: 1_000,
        endTimeMs: 7_000,
        durationMs: 6000,
      },
    })
    expect(childRun).toMatchObject({
      runId: 'child',
      rootRunId: 'root',
      parentRunId: 'root',
      delegateName: 'code-executor',
      childRunIds: [],
      summary: {
        eventCount: 3,
        status: 'succeeded',
        startTimeMs: 2_100,
        endTimeMs: 4_000,
        durationMs: 1900,
      },
    })
    expect(childRun?.timeline.map((event) => event.event)).toEqual(['run.created', 'tool.completed', 'run.completed'])
  })
})
