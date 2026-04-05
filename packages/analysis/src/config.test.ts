import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it } from 'vitest'

import { resolveAnalysisSettings } from './config.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('resolveAnalysisSettings', () => {
  it('merges config defaults and profile overrides', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'analysis-config-'))
    const configPath = join(tempDir, 'analysis.config.json')

    tempDirs.push(tempDir)

    await writeFile(
      configPath,
      JSON.stringify(
        {
          inputs: ['logs/**/*.log'],
          outputs: { formats: ['json'] },
          thresholds: { durationMultiplier: 2 },
          compare: { timeWindow: 'hour' },
          profiles: {
            focused: {
              view: 'failures',
              formats: ['html', 'csv:failures'],
              watchPollIntervalMs: 250,
            },
          },
        },
        null,
        2,
      ),
    )

    const settings = await resolveAnalysisSettings({
      cwd: tempDir,
      configPath,
      profileName: 'focused',
    })

    expect(settings.inputs).toEqual(['logs/**/*.log'])
    expect(settings.formats).toEqual(['html', 'csv:failures'])
    expect(settings.view).toBe('failures')
    expect(settings.timeWindow).toBe('hour')
    expect(settings.thresholds.durationMultiplier).toBe(2)
    expect(settings.watchPollIntervalMs).toBe(250)
  })
})
