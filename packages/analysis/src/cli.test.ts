import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it } from 'vitest'

import { formatAnalyzeHelp, formatHelp, runCli } from './cli.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('analysis cli', () => {
  it('renders help text with config profile and exporter options', () => {
    expect(formatHelp()).toContain('analysis analyze [options] <file|directory|glob>')
    expect(formatHelp()).toContain('--profile <name>')
    expect(formatHelp()).toContain('--watch')
    expect(formatHelp()).toContain('csv:cohorts')
  })

  it('renders analyze help text', () => {
    expect(formatAnalyzeHelp()).toContain('Analyze one or more adaptive-agent log inputs.')
    expect(formatAnalyzeHelp()).toContain('--window <hour|day>')
  })

  it('analyzes discovered files and prints the terminal overview report', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'analysis-cli-'))
    const logPath = join(tempDir, 'events.log')

    tempDirs.push(tempDir)

    await writeFile(
      logPath,
      [
        '{"time":1000,"event":"run.created","runId":"run-1","rootRunId":"run-1","provider":"openrouter","model":"qwen"}',
        'not json',
        '{"time":1100,"event":"tool.started","runId":"run-1","rootRunId":"run-1","stepId":"step-1","toolName":"write_file"}',
        '{"time":1400,"event":"tool.completed","runId":"run-1","rootRunId":"run-1","stepId":"step-1","toolName":"write_file","durationMs":300}',
        '{"time":2000,"event":"run.completed","runId":"run-1","rootRunId":"run-1","durationMs":1000,"usage":{"promptTokens":10,"completionTokens":5,"totalTokens":15}}',
      ].join('\n') + '\n',
    )

    const result = await runCli(['analyze', logPath, join(tempDir, 'missing.log')])

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('Inputs received: 2')
    expect(result.output).toContain('Files matched: 1')
    expect(result.output).toContain('Events parsed: 4')
    expect(result.output).toContain('Malformed lines: 1')
    expect(result.output).toContain('Runs discovered: 1')
    expect(result.output).toContain('Top tools:')
    expect(result.output).toContain('Cohorts:')
    expect(result.output).toContain('missing.log')
  })

  it('prints extended JSON reports to stdout when requested', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'analysis-cli-json-'))
    const logPath = join(tempDir, 'events.log')

    tempDirs.push(tempDir)

    await writeFile(
      logPath,
      [
        '{"time":1000,"event":"run.created","runId":"run-1","rootRunId":"run-1","provider":"openrouter","model":"qwen"}',
        '{"time":1100,"event":"tool.started","runId":"run-1","rootRunId":"run-1","stepId":"step-1","toolName":"write_file"}',
        '{"time":1400,"event":"tool.completed","runId":"run-1","rootRunId":"run-1","stepId":"step-1","toolName":"write_file","durationMs":300}',
        '{"time":2000,"event":"run.completed","runId":"run-1","rootRunId":"run-1","durationMs":1000,"usage":{"promptTokens":10,"completionTokens":5,"totalTokens":15,"provider":"openrouter","model":"qwen"}}',
      ].join('\n') + '\n',
    )

    const result = await runCli(['analyze', '--format', 'json', logPath])

    expect(result.exitCode).toBe(0)
    const parsed = JSON.parse(result.output) as {
      summary: { runCount: number; fileCount: number }
      runs: Array<{ runId: string; provider: string; totalTokens: number; toolInvocationCount: number }>
      tools: Array<{ toolName: string; invocationCount: number }>
      failures: { clusters: unknown[]; retrySignals: unknown[] }
      bottlenecks: { slowestRuns: unknown[] }
      cohorts: Array<{ provider: string }>
      anomalies: unknown[]
      diagnostics: unknown[]
    }

    expect(Object.keys(parsed)).toEqual([
      'summary',
      'runs',
      'tools',
      'failures',
      'bottlenecks',
      'cohorts',
      'anomalies',
      'diagnostics',
    ])
    expect(parsed.summary).toMatchObject({ runCount: 1, fileCount: 1 })
    expect(parsed.runs).toEqual([
      expect.objectContaining({ runId: 'run-1', provider: 'openrouter', totalTokens: 15, toolInvocationCount: 1 }),
    ])
    expect(parsed.tools).toEqual([expect.objectContaining({ toolName: 'write_file', invocationCount: 1 })])
    expect(parsed.cohorts).toEqual([expect.objectContaining({ provider: 'openrouter' })])
    expect(parsed.anomalies).toEqual([])
    expect(parsed.diagnostics).toEqual([])
  })

  it('writes multiple output formats to a directory when requested', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'analysis-cli-multi-'))
    const logPath = join(tempDir, 'events.log')
    const reportDir = join(tempDir, 'reports')

    tempDirs.push(tempDir)

    await writeFile(
      logPath,
      [
        '{"time":1000,"event":"run.created","runId":"run-1","rootRunId":"run-1","provider":"openrouter","model":"qwen"}',
        '{"time":2000,"event":"run.completed","runId":"run-1","rootRunId":"run-1","durationMs":1000,"usage":{"totalTokens":15}}',
      ].join('\n') + '\n',
    )

    const result = await runCli(['analyze', '--format', 'markdown,csv', '--output', reportDir, logPath])

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('Wrote 5 reports to')
    expect(await readFile(join(reportDir, 'analysis.md'), 'utf8')).toContain('# Analysis Report')
    expect(await readFile(join(reportDir, 'runs.csv'), 'utf8')).toContain('runId,rootRunId')
    expect(await readFile(join(reportDir, 'cohorts.csv'), 'utf8')).toContain('cohortId,provider,model')
  })

  it('uses config defaults and compare profile when inputs are omitted on the command line', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'analysis-cli-config-'))
    const logPath = join(tempDir, 'events.log')
    const configPath = join(tempDir, 'analysis.config.json')

    tempDirs.push(tempDir)

    await writeFile(
      logPath,
      [
        '{"time":1000,"event":"run.created","runId":"run-1","rootRunId":"run-1","provider":"openrouter","model":"qwen"}',
        '{"time":2000,"event":"run.completed","runId":"run-1","rootRunId":"run-1","durationMs":1000,"usage":{"totalTokens":15}}',
      ].join('\n') + '\n',
    )
    await writeFile(
      configPath,
      JSON.stringify(
        {
          inputs: [logPath],
          profile: 'compare',
          outputs: { formats: ['terminal'] },
        },
        null,
        2,
      ),
    )

    const result = await runCli(['analyze', '--config', configPath])

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('Cohorts:')
    expect(result.output).toContain('Anomalies:')
  })

  it('renders drill-down output when selecting a run tree', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'analysis-cli-drilldown-'))
    const logPath = join(tempDir, 'events.log')

    tempDirs.push(tempDir)

    await writeFile(
      logPath,
      [
        '{"time":1000,"event":"run.created","runId":"root","rootRunId":"root"}',
        '{"time":1200,"event":"tool.started","runId":"root","rootRunId":"root","stepId":"step-1","toolName":"delegate.code-executor","childRunId":"child"}',
        '{"time":1250,"event":"run.created","runId":"child","rootRunId":"root","parentRunId":"root","delegateName":"code-executor"}',
        '{"time":1500,"event":"tool.completed","runId":"child","rootRunId":"root","parentRunId":"root","stepId":"step-1","toolName":"e2b_run_code","output":{"success":false,"error":{"name":"ValueError","value":"probabilities do not sum to 1"}}}',
        '{"time":1800,"event":"tool.completed","runId":"root","rootRunId":"root","stepId":"step-1","toolName":"delegate.code-executor","childRunId":"child","output":{"status":"success"}}',
      ].join('\n') + '\n',
    )

    const result = await runCli(['analyze', '--root-run', 'root', logPath])

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('Selected run: root')
    expect(result.output).toContain('Requested via: rootRunId=root')
    expect(result.output).toContain('Timeline:')
    expect(result.output).toContain('Failures:')
    expect(result.output).toContain('e2b_run_code x1')
  })
})
