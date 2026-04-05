import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it } from 'vitest'

import { watchLogInputs } from './watch.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('watchLogInputs', () => {
  it('emits updates when files are appended and when new matches appear', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'analysis-watch-'))
    const firstLogPath = join(tempDir, 'first.log')
    const secondLogPath = join(tempDir, 'second.log')
    const updates: Array<{ kind: string; changedFiles: string[] }> = []

    tempDirs.push(tempDir)

    await writeFile(firstLogPath, '{"event":"run.created","runId":"run-1"}\n')

    setTimeout(() => {
      void appendFile(firstLogPath, '{"event":"run.completed","runId":"run-1"}\n')
    }, 30)
    setTimeout(() => {
      void writeFile(secondLogPath, '{"event":"run.created","runId":"run-2"}\n')
    }, 75)

    await watchLogInputs(
      ['*.log'],
      (update) => {
        updates.push({ kind: update.kind, changedFiles: update.changedFiles })
      },
      {
        cwd: tempDir,
        pollIntervalMs: 20,
        maxIterations: 7,
      },
    )

    expect(updates[0]).toMatchObject({ kind: 'initial', changedFiles: [firstLogPath] })
    expect(updates.some((update) => update.changedFiles.includes(firstLogPath))).toBe(true)
    expect(updates.some((update) => update.changedFiles.includes(secondLogPath))).toBe(true)
  })
})
