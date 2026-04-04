import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

export interface ParsedLogEvent {
  sourceFile: string
  line: number
  data: Record<string, unknown>
}

export interface ParseDiagnostic {
  sourceFile: string
  line?: number
  message: string
}

export interface ParseNdjsonResult {
  events: ParsedLogEvent[]
  diagnostics: ParseDiagnostic[]
  malformedLineCount: number
}

export async function parseNdjsonFiles(filePaths: string[]): Promise<ParseNdjsonResult> {
  const events: ParsedLogEvent[] = []
  const diagnostics: ParseDiagnostic[] = []
  let malformedLineCount = 0

  for (const filePath of filePaths) {
    const fileResult = await parseNdjsonFile(filePath)
    events.push(...fileResult.events)
    diagnostics.push(...fileResult.diagnostics)
    malformedLineCount += fileResult.malformedLineCount
  }

  return { events, diagnostics, malformedLineCount }
}

export async function parseNdjsonFile(filePath: string): Promise<ParseNdjsonResult> {
  const events: ParsedLogEvent[] = []
  const diagnostics: ParseDiagnostic[] = []
  let malformedLineCount = 0
  const stream = createReadStream(filePath, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })

  try {
    let lineNumber = 0

    for await (const rawLine of lines) {
      lineNumber += 1
      const line = rawLine.trim()

      if (line.length === 0) {
        continue
      }

      try {
        const parsed = JSON.parse(line)
        if (!isRecord(parsed)) {
          malformedLineCount += 1
          diagnostics.push({
            sourceFile: filePath,
            line: lineNumber,
            message: 'Line did not parse to a JSON object.',
          })
          continue
        }

        events.push({
          sourceFile: filePath,
          line: lineNumber,
          data: parsed,
        })
      } catch (error) {
        malformedLineCount += 1
        diagnostics.push({
          sourceFile: filePath,
          line: lineNumber,
          message: `Invalid JSON: ${formatError(error)}`,
        })
      }
    }
  } catch (error) {
    diagnostics.push({
      sourceFile: filePath,
      message: `Failed to read file: ${formatError(error)}`,
    })
  } finally {
    lines.close()
    stream.destroy()
  }

  return { events, diagnostics, malformedLineCount }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function formatError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message
  }

  return String(error)
}
