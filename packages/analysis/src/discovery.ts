import { access, constants, readdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import { glob, hasMagic } from 'glob'

export interface DiscoveredInputFile {
  path: string
  sourceInput: string
  sourceType: 'file' | 'directory' | 'glob'
}

export interface InputDiscoveryDiagnostic {
  input: string
  message: string
}

export interface InputDiscoveryResult {
  files: string[]
  discoveredFiles: DiscoveredInputFile[]
  diagnostics: InputDiscoveryDiagnostic[]
}

export async function discoverInputFiles(
  inputs: string[],
  options: { cwd?: string } = {},
): Promise<InputDiscoveryResult> {
  const cwd = options.cwd ?? process.cwd()
  const files = new Map<string, DiscoveredInputFile>()
  const discoveredFiles: DiscoveredInputFile[] = []
  const diagnostics: InputDiscoveryDiagnostic[] = []

  for (const input of inputs) {
    const literalPath = resolve(cwd, input)
    const literalType = await getPathType(literalPath)

    if (literalType === 'file') {
      if (await isReadable(literalPath)) {
        addDiscoveredFile(files, discoveredFiles, {
          path: literalPath,
          sourceInput: input,
          sourceType: 'file',
        })
      } else {
        diagnostics.push({ input, message: 'Path exists but is not readable.' })
      }
      continue
    }

    if (literalType === 'directory') {
      if (!(await isReadable(literalPath))) {
        diagnostics.push({ input, message: 'Path exists but is not readable.' })
        continue
      }

      const nestedFiles = await walkDirectory(literalPath)
      for (const filePath of nestedFiles) {
        addDiscoveredFile(files, discoveredFiles, {
          path: filePath,
          sourceInput: input,
          sourceType: 'directory',
        })
      }
      continue
    }

    if (hasMagic(input)) {
      const matches = await glob(input, {
        absolute: true,
        cwd,
        nodir: true,
      })

      if (matches.length === 0) {
        diagnostics.push({ input, message: 'Glob did not match any files.' })
        continue
      }

      const readableMatches = await filterReadableFiles(matches)
      for (const filePath of readableMatches.files) {
        addDiscoveredFile(files, discoveredFiles, {
          path: filePath,
          sourceInput: input,
          sourceType: 'glob',
        })
      }
      diagnostics.push(...readableMatches.diagnostics.map((message) => ({ input, message })))
      continue
    }

    diagnostics.push({ input, message: 'Path does not exist.' })
  }

  return {
    files: [...files.keys()].sort(),
    discoveredFiles: discoveredFiles.sort((left, right) => {
      return left.path === right.path
        ? left.sourceType.localeCompare(right.sourceType)
        : left.path.localeCompare(right.path)
    }),
    diagnostics,
  }
}

function addDiscoveredFile(
  files: Map<string, DiscoveredInputFile>,
  discoveredFiles: DiscoveredInputFile[],
  discoveredFile: DiscoveredInputFile,
): void {
  discoveredFiles.push(discoveredFile)
  if (!files.has(discoveredFile.path)) {
    files.set(discoveredFile.path, discoveredFile)
  }
}

async function walkDirectory(directoryPath: string): Promise<string[]> {
  if (!(await isReadable(directoryPath))) {
    return []
  }

  const entries = await readdir(directoryPath, { withFileTypes: true })
  const files: string[] = []

  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = resolve(directoryPath, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await walkDirectory(entryPath)))
      continue
    }

    if (entry.isFile() && (await isReadable(entryPath))) {
      files.push(entryPath)
    }
  }

  return files
}

async function filterReadableFiles(paths: string[]): Promise<{ files: string[]; diagnostics: string[] }> {
  const readableFiles: string[] = []
  const diagnostics: string[] = []

  for (const filePath of [...paths].sort((left, right) => left.localeCompare(right))) {
    if (await isReadable(filePath)) {
      readableFiles.push(filePath)
    } else {
      diagnostics.push(`${filePath} exists but is not readable.`)
    }
  }

  return { files: readableFiles, diagnostics }
}

async function getPathType(path: string): Promise<'file' | 'directory' | 'missing'> {
  try {
    const stats = await stat(path)
    if (stats.isFile()) {
      return 'file'
    }

    if (stats.isDirectory()) {
      return 'directory'
    }

    return 'missing'
  } catch {
    return 'missing'
  }
}

async function isReadable(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}
