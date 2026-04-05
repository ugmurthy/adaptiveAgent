import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  DEFAULT_COMPARE_THRESHOLDS,
  resolveCompareThresholds,
  type CohortTimeWindow,
  type CompareThresholds,
} from './compare.js'
import { parseOutputFormats, type ReportOutputFormat, type ReportView } from './exporters.js'

export interface AnalysisConfigFile {
  inputs?: string[]
  profile?: string
  outputs?: {
    formats?: string[]
    output?: string
  }
  thresholds?: Partial<CompareThresholds>
  compare?: {
    timeWindow?: CohortTimeWindow
  }
  watch?: {
    pollIntervalMs?: number
  }
  profiles?: Record<string, AnalysisProfileConfig>
}

export interface AnalysisProfileConfig {
  view?: ReportView
  formats?: string[]
  output?: string
  thresholds?: Partial<CompareThresholds>
  timeWindow?: CohortTimeWindow
  watchPollIntervalMs?: number
}

export interface ResolveAnalysisSettingsOptions {
  cwd?: string
  configPath?: string
  inputs?: string[]
  formatSpecs?: string[]
  outputPath?: string
  profileName?: string
  watch?: boolean
  watchIntervalMs?: number
  timeWindow?: CohortTimeWindow
}

export interface ResolvedAnalysisSettings {
  configPath?: string
  inputs: string[]
  formats: ReportOutputFormat[]
  outputPath?: string
  profileName: string
  view: ReportView
  thresholds: CompareThresholds
  timeWindow: CohortTimeWindow
  watch: boolean
  watchPollIntervalMs: number
}

const DEFAULT_CONFIG_FILE = 'analysis.config.json'
const DEFAULT_WATCH_INTERVAL_MS = 1000
const BUILTIN_PROFILES: Record<string, Required<Pick<AnalysisProfileConfig, 'view' | 'formats'>> & AnalysisProfileConfig> = {
  overview: {
    view: 'overview',
    formats: ['terminal'],
  },
  failures: {
    view: 'failures',
    formats: ['terminal', 'csv:failures'],
  },
  bottlenecks: {
    view: 'bottlenecks',
    formats: ['terminal', 'csv:runs'],
  },
  compare: {
    view: 'compare',
    formats: ['terminal', 'csv:cohorts'],
    timeWindow: 'day',
  },
}

export async function loadAnalysisConfig(
  options: { cwd?: string; configPath?: string } = {},
): Promise<{ path?: string; config?: AnalysisConfigFile }> {
  const cwd = options.cwd ?? process.cwd()
  const candidatePath = options.configPath ? resolve(cwd, options.configPath) : resolve(cwd, DEFAULT_CONFIG_FILE)

  try {
    const configText = await readFile(candidatePath, 'utf8')
    const config = JSON.parse(configText) as AnalysisConfigFile

    return {
      path: candidatePath,
      config,
    }
  } catch (error) {
    if (options.configPath) {
      throw error
    }

    return {}
  }
}

export async function resolveAnalysisSettings(
  options: ResolveAnalysisSettingsOptions,
): Promise<ResolvedAnalysisSettings> {
  const cwd = options.cwd ?? process.cwd()
  const loadedConfig = await loadAnalysisConfig({ cwd, configPath: options.configPath })
  const config = loadedConfig.config ?? {}
  const profileName = options.profileName ?? config.profile ?? 'overview'
  const builtinProfile = BUILTIN_PROFILES[profileName]
  const customProfile = config.profiles?.[profileName]

  if (!builtinProfile && !customProfile) {
    throw new Error(`Unknown profile: ${profileName}.`)
  }

  const mergedThresholds = resolveCompareThresholds({
    ...DEFAULT_COMPARE_THRESHOLDS,
    ...builtinProfile?.thresholds,
    ...config.thresholds,
    ...customProfile?.thresholds,
  })

  const formatSpecs =
    options.formatSpecs && options.formatSpecs.length > 0
      ? options.formatSpecs
      : customProfile?.formats ?? config.outputs?.formats ?? builtinProfile?.formats ?? ['terminal']

  return {
    configPath: loadedConfig.path,
    inputs: options.inputs && options.inputs.length > 0 ? options.inputs : config.inputs ?? [],
    formats: parseOutputFormats(formatSpecs),
    outputPath: options.outputPath ?? customProfile?.output ?? config.outputs?.output,
    profileName,
    view: customProfile?.view ?? builtinProfile?.view ?? 'overview',
    thresholds: mergedThresholds,
    timeWindow: options.timeWindow ?? customProfile?.timeWindow ?? config.compare?.timeWindow ?? builtinProfile?.timeWindow ?? 'day',
    watch: options.watch ?? false,
    watchPollIntervalMs:
      options.watchIntervalMs ?? customProfile?.watchPollIntervalMs ?? config.watch?.pollIntervalMs ?? DEFAULT_WATCH_INTERVAL_MS,
  }
}
