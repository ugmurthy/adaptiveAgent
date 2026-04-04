import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it } from 'vitest'

import { formatAnalyzeHelp, formatHelp, runCli } from './cli.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('analysis cli scaffold', () => {
  it('renders help text', () => {
    expect(formatHelp()).toContain('analysis analyze <file|directory|glob>')
    expect(formatHelp()).toContain('logs/**/*.log')
  })

  it('renders analyze help text', () => {
    expect(formatAnalyzeHelp()).toContain('Analyze one or more adaptive-agent log inputs.')
  })

  it('analyzes discovered files and surfaces malformed lines', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'analysis-cli-'))
    const logPath = join(tempDir, 'events.log')

    tempDirs.push(tempDir)

    await writeFile(logPath, '{"event":"run.created"}\nnot json\n{"event":"run.completed"}\n')

    const result = await runCli(['analyze', logPath, join(tempDir, 'missing.log')])

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('Inputs received: 2')
    expect(result.output).toContain('Files matched: 1')
    expect(result.output).toContain('Events parsed: 2')
    expect(result.output).toContain('Malformed lines: 1')
    expect(result.output).toContain('missing.log')
  })
})
