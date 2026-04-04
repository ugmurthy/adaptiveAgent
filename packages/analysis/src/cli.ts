#!/usr/bin/env bun

import { discoverInputFiles, type InputDiscoveryDiagnostic } from './discovery.js'
import { parseNdjsonFiles, type ParseDiagnostic } from './parser.js'

export interface CliResult {
  exitCode: number
  output: string
}

export function formatHelp(): string {
  return [
    'analysis',
    '',
    'Standalone Bun + TypeScript log analysis workspace for adaptive-agent logs.',
    '',
    'Usage:',
    '  analysis analyze <file|directory|glob> [more inputs...]',
    '  analysis --help',
    '',
    'Commands:',
    '  analyze   Analyze one or more file, directory, or glob inputs',
    '',
    'Inputs:',
    '  file       Analyze a single newline-delimited JSON log file',
    '  directory  Recursively analyze every file beneath a directory',
    '  glob       Expand patterns such as logs/**/*.log or logs/*.ndjson',
    '',
    'Examples:',
    '  analysis analyze logs/adaptive-agent-example.log',
    '  analysis analyze logs/',
    '  analysis analyze "logs/**/*.log" artifacts/**/*.ndjson',
  ].join('\n')
}

export function formatAnalyzeHelp(): string {
  return [
    'analysis analyze',
    '',
    'Analyze one or more adaptive-agent log inputs.',
    '',
    'Usage:',
    '  analysis analyze <file|directory|glob> [more inputs...]',
    '',
    'Inputs:',
    '  file       Analyze one NDJSON log file directly',
    '  directory  Recursively discover every file under a directory',
    '  glob       Expand shell-style patterns such as logs/**/*.log',
  ].join('\n')
}

export async function runCli(args: string[]): Promise<CliResult> {
  const [command, ...inputs] = args

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    return { exitCode: 0, output: formatHelp() }
  }

  if (command === 'analyze') {
    if (inputs.length === 0) {
      return {
        exitCode: 1,
        output: `No inputs provided.\n\n${formatAnalyzeHelp()}`,
      }
    }

    if (inputs.includes('--help') || inputs.includes('-h')) {
      return { exitCode: 0, output: formatAnalyzeHelp() }
    }

    const discovery = await discoverInputFiles(inputs)
    const parseResult = await parseNdjsonFiles(discovery.files)
    const diagnostics = [...discovery.diagnostics, ...parseResult.diagnostics]
    const output = formatAnalyzeSummary({
      inputCount: inputs.length,
      fileCount: discovery.files.length,
      eventCount: parseResult.events.length,
      malformedLineCount: parseResult.malformedLineCount,
      diagnostics,
    })

    return {
      exitCode: discovery.files.length > 0 ? 0 : 1,
      output,
    }
  }

  return {
    exitCode: 1,
    output: `Unknown command: ${command}\n\n${formatHelp()}`,
  }
}

function formatAnalyzeSummary(options: {
  inputCount: number
  fileCount: number
  eventCount: number
  malformedLineCount: number
  diagnostics: Array<InputDiscoveryDiagnostic | ParseDiagnostic>
}): string {
  const lines = [
    'analysis analyze',
    '',
    `Inputs received: ${options.inputCount}`,
    `Files matched: ${options.fileCount}`,
    `Events parsed: ${options.eventCount}`,
    `Malformed lines: ${options.malformedLineCount}`,
  ]

  if (options.diagnostics.length > 0) {
    lines.push('', 'Diagnostics:')
    for (const diagnostic of options.diagnostics) {
      lines.push(`- ${formatDiagnostic(diagnostic)}`)
    }
  }

  return lines.join('\n')
}

function formatDiagnostic(diagnostic: InputDiscoveryDiagnostic | ParseDiagnostic): string {
  if ('input' in diagnostic) {
    return `${diagnostic.input}: ${diagnostic.message}`
  }

  if (diagnostic.line !== undefined) {
    return `${diagnostic.sourceFile}:${diagnostic.line}: ${diagnostic.message}`
  }

  return `${diagnostic.sourceFile}: ${diagnostic.message}`
}

if (import.meta.main) {
  const result = await runCli(process.argv.slice(2))
  if (result.output) {
    console.log(result.output)
  }
  process.exit(result.exitCode)
}
