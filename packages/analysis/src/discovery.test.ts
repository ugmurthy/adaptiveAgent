import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it } from 'vitest'

import { discoverInputFiles } from './discovery.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('discoverInputFiles', () => {
  it('resolves direct files, directories, and glob patterns', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'analysis-discovery-'))
    const rootFile = join(tempDir, 'root.log')
    const nestedDir = join(tempDir, 'nested')
    const nestedFile = join(nestedDir, 'child.ndjson')

    tempDirs.push(tempDir)

    await mkdir(nestedDir)
    await writeFile(rootFile, '{"event":"run.created"}\n')
    await writeFile(nestedFile, '{"event":"tool.started"}\n')

    const result = await discoverInputFiles([rootFile, nestedDir, '*.log'], { cwd: tempDir })

    expect(result.files).toEqual([nestedFile, rootFile])
    expect(result.discoveredFiles.map((file) => file.sourceType)).toContain('file')
    expect(result.discoveredFiles.map((file) => file.sourceType)).toContain('directory')
    expect(result.discoveredFiles.map((file) => file.sourceType)).toContain('glob')
    expect(result.diagnostics).toEqual([])
  })

  it('reports unreadable or missing paths without aborting discovery', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'analysis-discovery-'))
    const readableFile = join(tempDir, 'events.log')

    tempDirs.push(tempDir)

    await writeFile(readableFile, '{"event":"run.created"}\n')

    const result = await discoverInputFiles([readableFile, join(tempDir, 'missing.log')], { cwd: tempDir })

    expect(result.files).toEqual([readableFile])
    expect(result.diagnostics).toEqual([
      {
        input: join(tempDir, 'missing.log'),
        message: 'Path does not exist.',
      },
    ])
  })
})
