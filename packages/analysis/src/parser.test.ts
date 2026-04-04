import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it } from 'vitest'

import { parseNdjsonFile } from './parser.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('parseNdjsonFile', () => {
  it('streams valid object lines with source metadata', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'analysis-parser-'))
    const filePath = join(tempDir, 'events.log')

    tempDirs.push(tempDir)

    await writeFile(filePath, '{"event":"run.created","runId":"run-1"}\n\n{"event":"tool.started","toolName":"read_file"}\n')

    const result = await parseNdjsonFile(filePath)

    expect(result.events).toEqual([
      {
        sourceFile: filePath,
        line: 1,
        data: { event: 'run.created', runId: 'run-1' },
      },
      {
        sourceFile: filePath,
        line: 3,
        data: { event: 'tool.started', toolName: 'read_file' },
      },
    ])
    expect(result.malformedLineCount).toBe(0)
    expect(result.diagnostics).toEqual([])
  })

  it('counts malformed lines and reports diagnostics', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'analysis-parser-'))
    const filePath = join(tempDir, 'events.log')

    tempDirs.push(tempDir)

    await writeFile(filePath, '{"event":"run.created"}\nnot json\n[1,2,3]\n')

    const result = await parseNdjsonFile(filePath)

    expect(result.events).toEqual([
      {
        sourceFile: filePath,
        line: 1,
        data: { event: 'run.created' },
      },
    ])
    expect(result.malformedLineCount).toBe(2)
    expect(result.diagnostics).toEqual([
      {
        sourceFile: filePath,
        line: 2,
        message: expect.stringContaining('Invalid JSON:'),
      },
      {
        sourceFile: filePath,
        line: 3,
        message: 'Line did not parse to a JSON object.',
      },
    ])
  })
})
