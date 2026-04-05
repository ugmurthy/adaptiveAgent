#!/usr/bin/env bun

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { analyzeLogInputs } from './analyze.js'
import { buildAnalysisBundle, type CohortTimeWindow, type CompareThresholds } from './compare.js'
import { resolveAnalysisSettings } from './config.js'
import {
  getDefaultOutputFileName,
  renderAnalysisOutputs,
  type RenderedOutput,
  type ReportOutputFormat,
  type ReportView,
} from './exporters.js'
import { buildRunDrillDownReport } from './report.js'
import { watchLogInputs } from './watch.js'

export interface CliResult {
  exitCode: number
  output: string
}

export interface RunCliOptions {
  onWatchUpdate?: (output: string) => Promise<void> | void
  maxWatchIterations?: number
}

type ParsedAnalyzeArgs =
  | { kind: 'help' }
  | { kind: 'error'; error: string }
  | {
      kind: 'parsed'
      formatSpecs: string[]
      outputPath?: string
      configPath?: string
      profileName?: string
      watch: boolean
      watchIntervalMs?: number
      timeWindow?: CohortTimeWindow
      inputs: string[]
      runId?: string
      rootRunId?: string
    }

export function formatHelp(): string {
  return [
    'analysis',
    '',
    'Standalone Bun + TypeScript log analysis workspace for adaptive-agent logs.',
    '',
    'Usage:',
    '  analysis analyze [options] <file|directory|glob> [more inputs...]',
    '  analysis --help',
    '',
    'Commands:',
    '  analyze   Analyze one or more file, directory, or glob inputs',
    '',
    'Options:',
    '  --format, -f <formats>        terminal, json, markdown, html, csv, csv:runs, csv:tools, csv:failures, csv:cohorts',
    '  --output, -o <path>           Write one report file, or a directory when multiple formats are selected',
    '  --config <path>               Load defaults from analysis.config.json or a specific config file',
    '  --profile <name>              Use overview, failures, bottlenecks, compare, or a config-defined profile',
    '  --watch                       Re-run analysis when matched files grow or new files appear',
    '  --watch-interval <ms>         Poll interval for watch mode (default: 1000)',
    '  --window <hour|day>           Cohort comparison time window (default: day)',
    '  --run <runId>                 Drill into one run by runId',
    '  --root-run <rootRunId>        Drill into a root run tree by rootRunId',
    '',
    'Inputs:',
    '  file       Analyze a single newline-delimited JSON log file',
    '  directory  Recursively analyze every file beneath a directory',
    '  glob       Expand patterns such as logs/**/*.log or logs/*.ndjson',
    '',
    'Examples:',
    '  analysis analyze logs/adaptive-agent-example.log',
    '  analysis analyze --format markdown,html,csv --output reports logs/**/*.log',
    '  analysis analyze --profile compare --config analysis.config.json',
    '  analysis analyze --watch --watch-interval 2000 logs/',
    '  analysis analyze --run run-123 logs/',
  ].join('\n')
}

export function formatAnalyzeHelp(): string {
  return [
    'analysis analyze',
    '',
    'Analyze one or more adaptive-agent log inputs.',
    '',
    'Usage:',
    '  analysis analyze [options] <file|directory|glob> [more inputs...]',
    '',
    'Options:',
    '  --format, -f <formats>        Repeat or comma-separate terminal, json, markdown, html, csv, csv:runs, csv:tools, csv:failures, csv:cohorts',
    '  --output, -o <path>           Write one report file, or a directory for multi-format output',
    '  --config <path>               Load defaults from a config file',
    '  --profile <name>              Apply a named output profile such as overview, failures, bottlenecks, or compare',
    '  --watch                       Re-run analysis when inputs change on disk',
    '  --watch-interval <ms>         Poll interval for watch mode',
    '  --window <hour|day>           Cohort comparison time window',
    '  --run <runId>                 Drill into one run by runId',
    '  --root-run <rootRunId>        Drill into a root run tree by rootRunId',
    '',
    'Inputs:',
    '  file       Analyze one NDJSON log file directly',
    '  directory  Recursively discover every file under a directory',
    '  glob       Expand shell-style patterns such as logs/**/*.log',
  ].join('\n')
}

export async function runCli(args: string[], options: RunCliOptions = {}): Promise<CliResult> {
  const [command, ...commandArgs] = args

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    return { exitCode: 0, output: formatHelp() }
  }

  if (command !== 'analyze') {
    return {
      exitCode: 1,
      output: `Unknown command: ${command}\n\n${formatHelp()}`,
    }
  }

  const parsedArgs = parseAnalyzeArgs(commandArgs)
  if (parsedArgs.kind === 'help') {
    return { exitCode: 0, output: formatAnalyzeHelp() }
  }
  if (parsedArgs.kind === 'error') {
    return {
      exitCode: 1,
      output: `${parsedArgs.error}\n\n${formatAnalyzeHelp()}`,
    }
  }

  try {
    const settings = await resolveAnalysisSettings({
      configPath: parsedArgs.configPath,
      inputs: parsedArgs.inputs,
      formatSpecs: parsedArgs.formatSpecs,
      outputPath: parsedArgs.outputPath,
      profileName: parsedArgs.profileName,
      watch: parsedArgs.watch,
      watchIntervalMs: parsedArgs.watchIntervalMs,
      timeWindow: parsedArgs.timeWindow,
    })

    if (settings.inputs.length === 0) {
      return {
        exitCode: 1,
        output: `No inputs provided.\n\n${formatAnalyzeHelp()}`,
      }
    }

    const drillDownSelection = parsedArgs.runId
      ? { mode: 'runId' as const, value: parsedArgs.runId }
      : parsedArgs.rootRunId
        ? { mode: 'rootRunId' as const, value: parsedArgs.rootRunId }
        : undefined

    if (parsedArgs.watch) {
      const outputs: string[] = []

      await watchLogInputs(
        settings.inputs,
        async (update) => {
          const rendered = await renderAnalysisResult({
            inputCount: settings.inputs.length,
            outputPath: settings.outputPath,
            formats: settings.formats,
            view: settings.view,
            timeWindow: settings.timeWindow,
            thresholds: settings.thresholds,
            analysis: update.analysis,
            drillDownSelection,
          })

          const header =
            update.kind === 'initial'
              ? 'Initial analysis'
              : `Detected changes in ${update.changedFiles.length > 0 ? update.changedFiles.join(', ') : 'matched inputs'}`
          const message = `${header}\n\n${rendered.output}`

          if (options.onWatchUpdate) {
            await options.onWatchUpdate(message)
          } else {
            outputs.push(message)
          }
        },
        {
          pollIntervalMs: settings.watchPollIntervalMs,
          maxIterations: options.maxWatchIterations,
        },
      )

      return {
        exitCode: 0,
        output: outputs.join('\n\n---\n\n') || `Watching ${settings.inputs.join(', ')}`,
      }
    }

    const analysis = await analyzeLogInputs(settings.inputs)
    return renderAnalysisResult({
      inputCount: settings.inputs.length,
      outputPath: settings.outputPath,
      formats: settings.formats,
      view: settings.view,
      timeWindow: settings.timeWindow,
      thresholds: settings.thresholds,
      analysis,
      drillDownSelection,
    })
  } catch (error) {
    return {
      exitCode: 1,
      output: error instanceof Error ? error.message : String(error),
    }
  }
}

async function renderAnalysisResult(options: {
  inputCount: number
  outputPath?: string
  formats: ReportOutputFormat[]
  view: ReportView
  timeWindow: CohortTimeWindow
  thresholds: CompareThresholds
  analysis: Awaited<ReturnType<typeof analyzeLogInputs>>
  drillDownSelection?: { mode: 'runId' | 'rootRunId'; value: string }
}): Promise<CliResult> {
  const reportOptions = {
    inputCount: options.inputCount,
    fileCount: options.analysis.discovery.files.length,
    eventCount: options.analysis.parseResult.events.length,
    malformedLineCount: options.analysis.parseResult.malformedLineCount,
    diagnostics: options.analysis.diagnostics,
    runGraph: options.analysis.runGraph,
  }
  const drillDownReport = options.drillDownSelection
    ? buildRunDrillDownReport(options.analysis.runGraph, options.drillDownSelection)
    : undefined

  if (options.drillDownSelection && !drillDownReport) {
    return {
      exitCode: 1,
      output: `No run matched ${options.drillDownSelection.mode}=${options.drillDownSelection.value}.`,
    }
  }

  if (drillDownReport && options.formats.some((format) => format.startsWith('csv:'))) {
    return {
      exitCode: 1,
      output: 'CSV exporters are only available for overview reports, not single-run drill-down mode.',
    }
  }

  const bundle = buildAnalysisBundle(reportOptions, {
    timeWindow: options.timeWindow,
    thresholds: options.thresholds,
  })
  const renderedOutputs = renderAnalysisOutputs(bundle, {
    formats: options.formats,
    view: options.view,
    drillDownReport,
  })
  const exitCode = options.analysis.discovery.files.length > 0 ? 0 : 1

  if (options.outputPath) {
    return {
      exitCode,
      output: await writeRenderedOutputs(options.outputPath, renderedOutputs),
    }
  }

  return {
    exitCode,
    output: joinRenderedOutputs(renderedOutputs),
  }
}

async function writeRenderedOutputs(outputPath: string, outputs: RenderedOutput[]): Promise<string> {
  const resolvedOutputPath = resolve(outputPath)

  if (outputs.length === 1) {
    await mkdir(dirname(resolvedOutputPath), { recursive: true })
    await writeFile(resolvedOutputPath, `${outputs[0].content}\n`, 'utf8')
    return `Wrote ${outputs[0].format.toUpperCase()} report to ${resolvedOutputPath}`
  }

  await mkdir(resolvedOutputPath, { recursive: true })
  for (const output of outputs) {
    const destination = join(resolvedOutputPath, getDefaultOutputFileName(output.format))
    await writeFile(destination, `${output.content}\n`, 'utf8')
  }

  return `Wrote ${outputs.length} reports to ${resolvedOutputPath}`
}

function joinRenderedOutputs(outputs: RenderedOutput[]): string {
  if (outputs.length === 1) {
    return outputs[0].content
  }

  return outputs
    .map((output) => [`===== ${output.format.toUpperCase()} =====`, output.content].join('\n'))
    .join('\n\n')
}

function parseAnalyzeArgs(args: string[]): ParsedAnalyzeArgs {
  const formatSpecs: string[] = []
  let outputPath: string | undefined
  let configPath: string | undefined
  let profileName: string | undefined
  let watch = false
  let watchIntervalMs: number | undefined
  let timeWindow: CohortTimeWindow | undefined
  let runId: string | undefined
  let rootRunId: string | undefined
  const inputs: string[] = []

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]

    if (arg === '--help' || arg === '-h') {
      return { kind: 'help' }
    }

    if (arg === '--json') {
      formatSpecs.push('json')
      continue
    }

    if (arg === '--format' || arg === '-f') {
      const value = args[index + 1]
      if (!value) {
        return { kind: 'error', error: 'Missing value for --format.' }
      }

      formatSpecs.push(value)
      index += 1
      continue
    }

    if (arg === '--output' || arg === '-o') {
      const value = args[index + 1]
      if (!value) {
        return { kind: 'error', error: 'Missing value for --output.' }
      }

      outputPath = value
      index += 1
      continue
    }

    if (arg === '--config') {
      const value = args[index + 1]
      if (!value) {
        return { kind: 'error', error: 'Missing value for --config.' }
      }

      configPath = value
      index += 1
      continue
    }

    if (arg === '--profile') {
      const value = args[index + 1]
      if (!value) {
        return { kind: 'error', error: 'Missing value for --profile.' }
      }

      profileName = value
      index += 1
      continue
    }

    if (arg === '--watch') {
      watch = true
      continue
    }

    if (arg === '--watch-interval') {
      const value = args[index + 1]
      if (!value) {
        return { kind: 'error', error: 'Missing value for --watch-interval.' }
      }

      const parsedValue = Number(value)
      if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
        return { kind: 'error', error: 'Expected --watch-interval to be a positive number.' }
      }

      watchIntervalMs = parsedValue
      index += 1
      continue
    }

    if (arg === '--window') {
      const value = args[index + 1]
      if (!value) {
        return { kind: 'error', error: 'Missing value for --window.' }
      }
      if (value !== 'hour' && value !== 'day') {
        return { kind: 'error', error: `Unsupported window: ${value}. Expected hour or day.` }
      }

      timeWindow = value
      index += 1
      continue
    }

    if (arg === '--run') {
      const value = args[index + 1]
      if (!value) {
        return { kind: 'error', error: 'Missing value for --run.' }
      }
      if (rootRunId) {
        return { kind: 'error', error: 'Use either --run or --root-run, not both.' }
      }

      runId = value
      index += 1
      continue
    }

    if (arg === '--root-run') {
      const value = args[index + 1]
      if (!value) {
        return { kind: 'error', error: 'Missing value for --root-run.' }
      }
      if (runId) {
        return { kind: 'error', error: 'Use either --run or --root-run, not both.' }
      }

      rootRunId = value
      index += 1
      continue
    }

    if (arg.startsWith('-')) {
      return { kind: 'error', error: `Unknown option: ${arg}` }
    }

    inputs.push(arg)
  }

  return {
    kind: 'parsed',
    formatSpecs,
    outputPath,
    configPath,
    profileName,
    watch,
    watchIntervalMs,
    timeWindow,
    inputs,
    runId,
    rootRunId,
  }
}

if (import.meta.main) {
  const result = await runCli(process.argv.slice(2), {
    onWatchUpdate(output) {
      console.log(output)
    },
  })

  if (!result.output.includes('Initial analysis') && result.output) {
    console.log(result.output)
  }
  process.exit(result.exitCode)
}
