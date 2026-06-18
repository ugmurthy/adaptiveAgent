import { resolve } from 'node:path';

import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import type {
  AgentEvent,
  ChatResult,
  JsonObject,
  JsonSchema,
  JsonValue,
  ModelContentPart,
  RunResult,
  SwarmRetryResult,
  SwarmRunResult,
  SwarmSubtask,
} from '@adaptive-agent/core';

import {
  createAgentSdk,
  inspectAgentSdkCatalog,
  inspectAgentSdkResolution,
  loadAgentSdkConfig,
  type OrchestratedRunResult,
  type OrchestrationLifecycleEvent,
  type TuiMessageType,
  type TuiSettingsConfig,
  type TuiTextStyleName,
} from './index.js';
import type {
  InspectionSummary,
  ManualTestCliOptions,
  ManualTestSpec,
  ManualTestSummary,
} from './cli-types.js';
import { agentEventColorKey, agentEventProgressPrefix, formatAgentEventSummary, summarizeAgentEvent } from './agent-event-rendering.js';
import { formatSwarmExecutionPlan, formatSwarmRunStatuses } from './swarm-format.js';
import { applyNamedStyle, formatStyledMessageBlock } from './tui/message-styles.js';

export const passthroughMarkdownStyle = (value: string): string => value;

export interface TerminalMarkdownExtension {
  renderer: Record<string, unknown>;
}

export interface MarkdownInlineToken {
  tokens?: unknown[];
}

export interface MarkdownRendererThis {
  parser: { parseInline: (tokens: unknown[]) => string };
}

export const terminalMarkdownExtension = markedTerminal({
  // The marked-terminal defaults wrap ordinary paragraphs and list items in
  // chalk.reset. In terminals that sanitize control characters, those reset
  // sequences can leak as visible "0m" text inside rendered reports.
  listitem: passthroughMarkdownStyle,
  paragraph: passthroughMarkdownStyle,
} as never) as unknown as TerminalMarkdownExtension;

// marked-terminal's `text` renderer (used for tight list items) returns the raw
// token text instead of parsing the inline tokens, unlike its `paragraph`
// renderer. This leaks literal `**bold**` and `` `code` `` markers inside list
// items. Parse the inline tokens ourselves so list-item markdown renders.
export const baseTextRenderer = terminalMarkdownExtension.renderer.text as (token: unknown) => string;
terminalMarkdownExtension.renderer.text = function (this: MarkdownRendererThis, token: unknown): string {
  const tokens = (token as MarkdownInlineToken | null)?.tokens;
  if (Array.isArray(tokens) && tokens.length > 0) {
    return this.parser.parseInline(tokens);
  }
  return baseTextRenderer.call(this, token);
};

marked.use(terminalMarkdownExtension as never);
export const RUN_COLOR_STYLES = ['cyan', 'magenta', 'yellow', 'blue', 'green'] as const satisfies readonly TuiTextStyleName[];
export function collectContentParts(spec: ManualTestSpec): ModelContentPart[] {
  if (spec.mode === 'run') {
    return [
      ...(spec.contentParts ?? []),
      ...((spec.images ?? []).map((image) => ({ type: 'image', image }) satisfies ModelContentPart)),
    ];
  }

  return spec.messages.flatMap((message) => {
    if (Array.isArray(message.content)) {
      return message.content;
    }
    return (message.images ?? []).map((image) => ({ type: 'image', image }) satisfies ModelContentPart);
  });
}

export function summarizeSpec(spec: ManualTestSpec): ManualTestSummary {
  const summary: ManualTestSummary = {
    textParts: 0,
    imageParts: 0,
    fileParts: 0,
    audioParts: 0,
    legacyImages: 0,
    messageCount: spec.mode === 'chat' ? spec.messages.length : 1,
  };

  if (spec.mode === 'chat') {
    for (const message of spec.messages) {
      if (typeof message.content === 'string') {
        if (message.content.trim().length > 0) summary.textParts += 1;
      } else {
        for (const part of message.content) incrementSummary(summary, part);
      }
      summary.legacyImages += message.images?.length ?? 0;
    }
  } else {
    summary.legacyImages += spec.images?.length ?? 0;
    for (const part of spec.contentParts ?? []) incrementSummary(summary, part);
  }

  return summary;
}

export function incrementSummary(summary: ManualTestSummary, part: ModelContentPart): void {
  switch (part.type) {
    case 'text':
      summary.textParts += 1;
      break;
    case 'image':
      summary.imageParts += 1;
      break;
    case 'file':
      summary.fileParts += 1;
      break;
    case 'audio':
      summary.audioParts += 1;
      break;
  }
}
export function summarizeCli(cli: ManualTestCliOptions): Record<string, JsonValue> {
  return {
    command: cli.command,
    ...(cli.specPath ? { specPath: resolve(cli.specPath) } : {}),
    ...(cli.promptFilePath ? { promptFilePath: resolve(cli.promptFilePath) } : {}),
    ...(cli.imagePaths.length > 0 ? { imagePaths: cli.imagePaths.map((path) => resolve(path)) } : {}),
    ...(cli.audioPaths.length > 0 ? { audioPaths: cli.audioPaths.map((path) => resolve(path)) } : {}),
    ...(cli.fileAttachmentPaths.length > 0 ? { fileAttachmentPaths: cli.fileAttachmentPaths.map((path) => resolve(path)) } : {}),
    orchestrate: cli.orchestrate,
    ...(cli.agentCatalogPaths.length > 0 ? { agentCatalogPaths: cli.agentCatalogPaths.map((path) => resolve(path)) } : {}),
    ...(cli.workerCatalogPaths.length > 0 ? { workerCatalogPaths: cli.workerCatalogPaths.map((path) => resolve(path)) } : {}),
    ...(cli.qualityAgentPath ? { qualityAgentPath: resolve(cli.qualityAgentPath) } : {}),
    ...(cli.synthesizerAgentPath ? { synthesizerAgentPath: resolve(cli.synthesizerAgentPath) } : {}),
    ...(cli.maxWorkers ? { maxWorkers: cli.maxWorkers } : {}),
    ...(cli.sessionId ? { sessionId: cli.sessionId } : {}),
    ...(cli.runId ? { runId: cli.runId } : {}),
    ...(cli.evalDataset ? { evalDataset: cli.evalDataset } : {}),
    ...(cli.evalInputPath ? { evalInputPath: resolve(cli.evalInputPath) } : {}),
    ...(cli.evalFilesDir ? { evalFilesDir: resolve(cli.evalFilesDir) } : {}),
    ...(cli.evalOutputPath ? { evalOutputPath: resolve(cli.evalOutputPath) } : {}),
    ...(cli.evalArtifactsDir ? { evalArtifactsDir: resolve(cli.evalArtifactsDir) } : {}),
    evalSwarm: cli.evalSwarm,
    ...(cli.evalLimit ? { evalLimit: cli.evalLimit } : {}),
    ...(cli.evalOffset ? { evalOffset: cli.evalOffset } : {}),
    ...(cli.evalIds ? { evalIds: cli.evalIds } : {}),
    ...(cli.evalLevel ? { evalLevel: cli.evalLevel } : {}),
    ...(cli.evalSplit ? { evalSplit: cli.evalSplit } : {}),
    ...(cli.evalType ? { evalType: cli.evalType } : {}),
    evalResume: cli.evalResume,
    evalFailFast: cli.evalFailFast,
    ...(cli.mode ? { modeOverride: cli.mode } : {}),
    ...(cli.cwd ? { cwd: resolve(cli.cwd) } : {}),
    ...(cli.agentConfigPath ? { agentConfigPath: resolve(cli.agentConfigPath) } : {}),
    ...(cli.settingsConfigPath ? { settingsConfigPath: resolve(cli.settingsConfigPath) } : {}),
    ...(cli.runtimeMode ? { runtimeMode: cli.runtimeMode } : {}),
    ...(cli.provider ? { provider: cli.provider } : {}),
    ...(cli.model ? { model: cli.model } : {}),
    ...(cli.approvalMode ? { approvalMode: cli.approvalMode } : {}),
    ...(cli.clarificationMode ? { clarificationMode: cli.clarificationMode } : {}),
    progress: cli.progress,
    events: cli.events,
    inspect: cli.inspect,
    showLines: cli.showLines,
    dryRun: cli.dryRun,
    output: cli.output,
  };
}

export function summarizeResolvedConfig(
  resolvedConfig: Awaited<ReturnType<typeof loadAgentSdkConfig>>,
  spec: ManualTestSpec,
): Record<string, JsonValue> {
  const summary = summarizeSpec(spec);
  return {
    agentId: resolvedConfig.agent.id,
    agentName: resolvedConfig.agent.name,
    provider: resolvedConfig.model.provider,
    model: resolvedConfig.model.model,
    runtimeMode: resolvedConfig.runtime.mode,
    requestedRuntimeMode: resolvedConfig.runtime.requestedMode,
    autoMigrate: resolvedConfig.runtime.autoMigrate,
    workspaceRoot: resolvedConfig.workspaceRoot,
    shellCwd: resolvedConfig.shellCwd,
    approvalMode: resolvedConfig.interaction.approvalMode,
    clarificationMode: resolvedConfig.interaction.clarificationMode,
    agentSearchDirs: resolvedConfig.agents.dirs,
    skillSearchDirs: resolvedConfig.skills.dirs,
    mode: spec.mode,
    messageCount: summary.messageCount,
    textParts: summary.textParts,
    imageParts: summary.imageParts,
    fileParts: summary.fileParts,
    audioParts: summary.audioParts,
    legacyImages: summary.legacyImages,
  };
}

export type CatalogInspection = Awaited<ReturnType<typeof inspectAgentSdkCatalog>>;

export function summarizeCatalog(catalog: CatalogInspection): Record<string, JsonValue> {
  return {
    command: 'catalog',
    activeAgent: {
      id: catalog.config.agent.id,
      name: catalog.config.agent.name,
      path: catalog.agentPath,
      provider: catalog.config.model.provider,
      model: catalog.config.model.model,
    },
    ...(catalog.settingsPath ? { settingsPath: catalog.settingsPath } : {}),
    workspaceRoot: catalog.config.workspaceRoot,
    shellCwd: catalog.config.shellCwd,
    runtimeMode: catalog.config.runtime.mode,
    requestedRuntimeMode: catalog.config.runtime.requestedMode,
    agentSearchDirs: catalog.config.agents.dirs,
    skillSearchDirs: catalog.config.skills.dirs,
    agents: catalog.agents.map(summarizeCatalogAgent) as unknown as JsonValue,
    tools: catalog.tools.map((tool) => ({
      name: tool.name,
      description: oneLine(tool.description),
      configured: tool.configured,
      requiresApproval: tool.requiresApproval === true,
      inputFields: catalogInputFieldNames(tool.inputSchema),
    })) as unknown as JsonValue,
    delegates: catalog.delegates.map((delegate) => ({
      name: delegate.name,
      description: oneLine(delegate.description),
      configured: delegate.configured,
      path: delegate.path,
      allowedTools: delegate.allowedTools,
      ...(delegate.triggers?.length ? { triggers: delegate.triggers } : {}),
      ...(delegate.handler ? { handler: delegate.handler } : {}),
    })) as unknown as JsonValue,
  };
}

export function summarizeCatalogAgent(agent: CatalogInspection['agents'][number]): Record<string, JsonValue> {
  return {
    id: agent.id,
    name: agent.name,
    ...(agent.description ? { description: oneLine(agent.description) } : {}),
    path: agent.path,
    active: agent.active,
    invocationModes: agent.invocationModes,
    defaultInvocationMode: agent.defaultInvocationMode,
    ...(agent.provider ? { provider: agent.provider } : {}),
    ...(agent.model ? { model: agent.model } : {}),
    tools: agent.tools,
    delegates: agent.delegates,
    ...(agent.capabilities && isJsonValueLike(agent.capabilities) ? { capabilities: agent.capabilities } : {}),
  };
}

export function formatCatalogMarkdown(catalog: CatalogInspection): string {
  const lines = [
    '# Agent Catalog',
    '',
    '## Active Agent',
    '',
    `- **Agent:** ${formatMarkdownInlineCode(catalog.config.agent.id)} (${catalog.config.agent.name})`,
    `- **Path:** ${formatMarkdownInlineCode(catalog.agentPath)}`,
    ...(catalog.settingsPath ? [`- **Settings:** ${formatMarkdownInlineCode(catalog.settingsPath)}`] : []),
    `- **Model:** ${formatMarkdownInlineCode(`${catalog.config.model.provider}/${catalog.config.model.model}`)}`,
    `- **Runtime:** ${formatMarkdownInlineCode(catalog.config.runtime.mode)} (requested ${formatMarkdownInlineCode(catalog.config.runtime.requestedMode)})`,
    `- **Workspace:** ${formatMarkdownInlineCode(catalog.config.workspaceRoot)}`,
    `- **Shell cwd:** ${formatMarkdownInlineCode(catalog.config.shellCwd)}`,
    `- **Agent search dirs:** ${formatMarkdownNameList(catalog.config.agents.dirs)}`,
    `- **Skill search dirs:** ${formatMarkdownNameList(catalog.config.skills.dirs)}`,
    '',
    `## Agents (${catalog.agents.length})`,
    '',
    ...catalog.agents.flatMap(formatCatalogAgentMarkdown),
    '',
    `## Tools (${catalog.tools.length})`,
    '',
    ...(catalog.tools.length === 0 ? ['- (none)'] : catalog.tools.flatMap(formatCatalogToolMarkdown)),
    '',
    `## Delegate Skills (${catalog.delegates.length})`,
    '',
    ...(catalog.delegates.length === 0 ? ['- (none)'] : catalog.delegates.flatMap(formatCatalogDelegateMarkdown)),
  ];

  return `${lines.join('\n')}\n`;
}

export function formatCatalogAgentMarkdown(agent: CatalogInspection['agents'][number]): string[] {
  const lines = [
    `- **${formatMarkdownInlineCode(agent.id)}** (${agent.name})${agent.active ? ' - **active**' : ''}`,
    `  - path: ${formatMarkdownInlineCode(agent.path)}`,
    ...(agent.description ? [`  - description: ${oneLine(agent.description)}`] : []),
    `  - model: ${formatMarkdownInlineCode(formatCatalogAgentModel(agent))}`,
    `  - modes: ${formatMarkdownNameList(agent.invocationModes)} (default ${formatMarkdownInlineCode(agent.defaultInvocationMode)})`,
    `  - tools: ${formatMarkdownNameList(agent.tools)}`,
    `  - delegates: ${formatMarkdownNameList(agent.delegates)}`,
  ];
  const capabilities = formatCatalogCapabilities(agent.capabilities);
  if (capabilities) lines.push(`  - capabilities: ${capabilities}`);
  return lines;
}

export function formatCatalogAgentModel(agent: CatalogInspection['agents'][number]): string {
  if (agent.provider && agent.model) return `${agent.provider}/${agent.model}`;
  if (agent.provider) return `${agent.provider}/(from settings or override)`;
  if (agent.model) return `(from settings or override)/${agent.model}`;
  return '(from settings or override)';
}

export function formatCatalogToolMarkdown(tool: CatalogInspection['tools'][number]): string[] {
  return [
    `- **${formatMarkdownInlineCode(tool.name)}**${tool.configured ? ' - **configured**' : ''}`,
    `  - description: ${oneLine(tool.description)}`,
    `  - approval: ${tool.requiresApproval === true ? '**required**' : 'not required'}`,
    `  - input: ${formatMarkdownNameList(catalogInputFieldNames(tool.inputSchema))}`,
  ];
}

export function formatCatalogDelegateMarkdown(delegate: CatalogInspection['delegates'][number]): string[] {
  return [
    `- **${formatMarkdownInlineCode(delegate.name)}**${delegate.configured ? ' - **configured**' : ''}`,
    `  - path: ${formatMarkdownInlineCode(delegate.path)}`,
    `  - description: ${oneLine(delegate.description)}`,
    `  - allowedTools: ${formatMarkdownNameList(delegate.allowedTools)}`,
    ...(delegate.triggers?.length ? [`  - triggers: ${formatMarkdownNameList(delegate.triggers)}`] : []),
    ...(delegate.handler ? [`  - handler: ${formatMarkdownInlineCode(delegate.handler)}`] : []),
  ];
}

export function formatMarkdownNameList(values: readonly string[]): string {
  return values.length > 0 ? values.map(formatMarkdownInlineCode).join(', ') : '(none)';
}

export function formatMarkdownInlineCode(value: string): string {
  const tickRuns = value.match(/`+/g)?.map((run) => run.length) ?? [0];
  const delimiter = '`'.repeat(Math.max(...tickRuns) + 1);
  const padding = value.startsWith('`') || value.endsWith('`') ? ' ' : '';
  return `${delimiter}${padding}${value}${padding}${delimiter}`;
}

export function catalogInputFieldNames(schema: JsonSchema): string[] {
  const schemaRecord = isRecordValue(schema) ? schema : undefined;
  const properties = isRecordValue(schemaRecord?.properties) ? schemaRecord.properties : undefined;
  if (!properties) return [];
  const required = new Set(
    Array.isArray(schemaRecord?.required)
      ? schemaRecord.required.filter((field): field is string => typeof field === 'string')
      : [],
  );
  return Object.keys(properties).map((field) => required.has(field) ? field : `${field}?`);
}

export function formatCatalogCapabilities(capabilities: unknown): string | undefined {
  if (!isRecordValue(capabilities)) return undefined;
  const parts = [
    formatCatalogStringArrayCapability(capabilities, 'modalitiesSupported', 'supports'),
    formatCatalogStringArrayCapability(capabilities, 'modalitiesPreferred', 'prefers'),
    formatCatalogStringArrayCapability(capabilities, 'subjectsPreferred', 'subjects'),
    formatCatalogRolesCapability(capabilities.modalityRoles),
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join('; ') : undefined;
}

export function formatCatalogStringArrayCapability(capabilities: Record<string, unknown>, key: string, label: string): string | undefined {
  const values = capabilities[key];
  return Array.isArray(values) && values.every((value) => typeof value === 'string') && values.length > 0
    ? `${label}=${values.join(',')}`
    : undefined;
}

export function formatCatalogRolesCapability(value: unknown): string | undefined {
  if (!isRecordValue(value)) return undefined;
  const roles = Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([modality, role]) => `${modality}:${role}`);
  return roles.length > 0 ? `roles=${roles.join(',')}` : undefined;
}

export function summarizeResult(result: RunResult | ChatResult): JsonValue {
  if (result.status === 'success') {
    return {
      status: result.status,
      runId: result.runId,
      stepsUsed: result.stepsUsed,
      usage: result.usage as unknown as JsonValue,
      output: result.output,
      ...(result.planId ? { planId: result.planId } : {}),
    };
  }
  if (result.status === 'failure') {
    return {
      status: result.status,
      runId: result.runId,
      code: result.code,
      error: result.error,
      stepsUsed: result.stepsUsed,
      usage: result.usage as unknown as JsonValue,
    };
  }
  return {
    status: result.status,
    runId: result.runId,
    message: result.message,
    ...('toolName' in result ? { toolName: result.toolName } : {}),
    ...('suggestedQuestions' in result && result.suggestedQuestions ? { suggestedQuestions: result.suggestedQuestions as unknown as JsonValue } : {}),
  };
}

export function formatCoordinatorDecompositionFailure(result: RunResult | ChatResult): string {
  return `Coordinator decomposition failed:\n${renderPrettyValue(summarizeResult(result))}`;
}
export function summarizeSwarmRun(result: SwarmRunResult, workerIds: string[], cli: ManualTestCliOptions, subtasks: SwarmSubtask[]): JsonValue {
  return {
    command: 'swarm-run',
    sessionId: result.sessionId,
    coordinatorRunId: result.coordinatorRunId,
    status: result.status,
    workerAgentIds: workerIds,
    maxWorkers: cli.maxWorkers ?? null,
    subtasks: subtasks as unknown as JsonValue,
    defaultsUsed: {
      qualityAgent: cli.qualityAgentPath ? 'explicit' : 'coordinator_with_quality_instructions',
      synthesizerAgent: cli.synthesizerAgentPath ? 'explicit' : 'coordinator_with_synthesis_instructions',
    },
    subtaskResults: result.subtaskResults as unknown as JsonValue,
    qualityRunId: result.qualityRunId ?? null,
    synthesizerRunId: result.synthesizerRunId ?? null,
    qualityAssessments: (result.qualityAssessments ?? []) as unknown as JsonValue,
    output: result.output,
    errorCode: result.errorCode ?? null,
    errorMessage: result.errorMessage ?? null,
    diagnostics: result.diagnostics ?? null,
  } as JsonValue;
}

export function summarizeSwarmRetry(result: SwarmRetryResult): JsonValue {
  return {
    command: 'retry',
    retryTarget: 'swarm-session',
    sessionId: result.sessionId,
    coordinatorRunId: result.coordinatorRunId,
    status: result.status,
    retriedWorkerRunIds: result.retriedWorkerRunIds,
    skippedWorkerRunIds: result.skippedWorkerRunIds as unknown as JsonValue,
    subtaskResults: result.subtaskResults as unknown as JsonValue,
    qualityRunId: result.qualityRunId ?? null,
    synthesizerRunId: result.synthesizerRunId ?? null,
    qualityAssessments: (result.qualityAssessments ?? []) as unknown as JsonValue,
    output: result.output,
    errorCode: result.errorCode ?? null,
    errorMessage: result.errorMessage ?? null,
  } as JsonValue;
}

export function printSwarmExecutionPlan(sessionId: string, coordinatorRunId: string, subtasks: SwarmSubtask[], wrapWidth?: number): void {
  console.log(formatSwarmExecutionPlan(sessionId, coordinatorRunId, subtasks, wrapWidth));
  console.log('');
}

export function printSwarmResult(result: SwarmRunResult, workerIds: string[], cli: ManualTestCliOptions): void {
  console.log(`orchestration: session=${result.sessionId} coordinator=${result.coordinatorRunId}`);
  console.log(`workers: ${workerIds.join(', ')} (max ${cli.maxWorkers ?? 'default'})`);
  console.log(formatSwarmRunStatuses(result));
  if (result.status === 'succeeded') {
    console.log(renderPrettyString(typeof result.output === 'string' ? result.output : JSON.stringify(result.output, null, 2)));
  } else {
    console.error(`swarm-run failed: ${result.errorCode ?? 'UNKNOWN'} ${result.errorMessage ?? ''}`.trim());
  }
}

export function printSwarmRetryResult(result: SwarmRetryResult): void {
  console.log(`retry: session=${result.sessionId} coordinator=${result.coordinatorRunId}`);
  console.log(`workers retried: ${result.retriedWorkerRunIds.join(', ') || '(none)'}`);
  if (result.skippedWorkerRunIds.length > 0) {
    console.log(`workers skipped: ${result.skippedWorkerRunIds.map((entry) => `${entry.runId}:${entry.reason}`).join(', ')}`);
  }
  console.log(formatSwarmRunStatuses(result));
  if (result.status === 'succeeded') {
    console.log(renderPrettyString(typeof result.output === 'string' ? result.output : JSON.stringify(result.output, null, 2)));
  } else {
    console.error(`retry failed: ${result.errorCode ?? 'UNKNOWN'} ${result.errorMessage ?? ''}`.trim());
  }
}

export function printSwarmDryRun(
  cli: ManualTestCliOptions,
  coordinatorConfig: Awaited<ReturnType<typeof loadAgentSdkConfig>>,
  workerConfigs: Array<Awaited<ReturnType<typeof loadAgentSdkConfig>>>,
  qualityConfig: Awaited<ReturnType<typeof loadAgentSdkConfig>>,
  synthesizerConfig: Awaited<ReturnType<typeof loadAgentSdkConfig>>,
): void {
  const output = {
    dryRun: true,
    cli: summarizeCli(cli),
    coordinator: summarizeSwarmAgentConfig(coordinatorConfig, 'coordinator', 'explicit'),
    workers: workerConfigs.map((config) => summarizeSwarmAgentConfig(config, 'worker', 'explicit')),
    quality: summarizeSwarmAgentConfig(qualityConfig, 'quality', cli.qualityAgentPath ? 'explicit' : 'derived'),
    synthesizer: summarizeSwarmAgentConfig(synthesizerConfig, 'synthesizer', cli.synthesizerAgentPath ? 'explicit' : 'derived'),
    defaultsUsed: {
      qualityAgent: cli.qualityAgentPath ? 'explicit' : 'coordinator_with_quality_instructions',
      synthesizerAgent: cli.synthesizerAgentPath ? 'explicit' : 'coordinator_with_synthesis_instructions',
    },
    maxWorkers: cli.maxWorkers ?? null,
  } satisfies JsonValue;
  if (cli.output === 'json') console.log(JSON.stringify(output, null, 2));
  else if (cli.output === 'jsonl') console.log(JSON.stringify(output));
  else {
    console.log('# Swarm dry run');
    printSwarmAgentConfigSummary('coordinator', coordinatorConfig, 'explicit');
    for (const workerConfig of workerConfigs) {
      printSwarmAgentConfigSummary('worker', workerConfig, 'explicit');
    }
    printSwarmAgentConfigSummary('quality', qualityConfig, cli.qualityAgentPath ? 'explicit' : 'derived');
    printSwarmAgentConfigSummary('synthesizer', synthesizerConfig, cli.synthesizerAgentPath ? 'explicit' : 'derived');
    console.log(`maxWorkers: ${cli.maxWorkers ?? 'default'}`);
  }
}

export function summarizeSwarmAgentConfig(
  resolvedConfig: Awaited<ReturnType<typeof loadAgentSdkConfig>>,
  role: 'coordinator' | 'worker' | 'quality' | 'synthesizer',
  source: 'explicit' | 'derived',
): JsonValue {
  return {
    role,
    source,
    agentId: resolvedConfig.agent.id,
    agentName: resolvedConfig.agent.name,
    description: resolvedConfig.agent.description ?? null,
    provider: resolvedConfig.model.provider,
    model: resolvedConfig.model.model,
    runtimeMode: resolvedConfig.runtime.mode,
    requestedRuntimeMode: resolvedConfig.runtime.requestedMode,
    workspaceRoot: resolvedConfig.workspaceRoot,
    shellCwd: resolvedConfig.shellCwd,
    approvalMode: resolvedConfig.interaction.approvalMode,
    clarificationMode: resolvedConfig.interaction.clarificationMode,
    tools: resolvedConfig.agent.tools,
    delegates: resolvedConfig.agent.delegates ?? [],
  } satisfies JsonValue;
}

export function printSwarmAgentConfigSummary(
  label: string,
  resolvedConfig: Awaited<ReturnType<typeof loadAgentSdkConfig>>,
  source: 'explicit' | 'derived',
): void {
  console.log(`${label}: ${resolvedConfig.agent.id} (${resolvedConfig.agent.name}) [${source}]`);
  console.log(`  model: ${resolvedConfig.model.provider}/${resolvedConfig.model.model}`);
  console.log(`  runtime: ${resolvedConfig.runtime.mode} (requested ${resolvedConfig.runtime.requestedMode})`);
  console.log(`  workspace: ${resolvedConfig.workspaceRoot}`);
  console.log(`  shellCwd: ${resolvedConfig.shellCwd}`);
  console.log(`  approval: ${resolvedConfig.interaction.approvalMode}`);
  console.log(`  clarification: ${resolvedConfig.interaction.clarificationMode}`);
  console.log(`  agentSearchDirs: ${formatNameList(resolvedConfig.agents.dirs)}`);
  console.log(`  tools: ${formatNameList(resolvedConfig.agent.tools)}`);
  console.log(`  delegates: ${formatNameList(resolvedConfig.agent.delegates ?? [])}`);
}

export function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isJsonRecordLike(value: unknown): value is Record<string, JsonValue> {
  return isRecordValue(value) && Object.values(value).every(isJsonValueLike);
}

export function isJsonValueLike(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.every(isJsonValueLike);
  return isJsonRecordLike(value);
}

export function summarizeOrchestration(result: OrchestratedRunResult): JsonValue {
  return {
    sessionId: result.sessionId,
    requestedAgentId: result.requestedAgentId,
    detectedModalities: result.detectedModalities,
    executionShape: result.executionShape,
    routingReason: result.plan.routingReason,
    routingDiagnostics: result.plan.routingDiagnostics as unknown as JsonValue,
    finalNodeId: result.plan.finalNodeId,
    stages: result.stages.map((stage) => ({
      nodeId: stage.nodeId,
      stage: stage.stage,
      agentId: stage.agentId,
      runId: stage.runId,
      rootRunId: stage.rootRunId,
      status: stage.result.status,
    })),
  };
}

export async function summarizeInspection(sdk: Awaited<ReturnType<typeof createAgentSdk>>, runId: string): Promise<InspectionSummary> {
  const inspection = await sdk.inspect(runId);
  const eventTypes = inspection.events.reduce<Record<string, number>>((counts, event) => {
    counts[event.type] = (counts[event.type] ?? 0) + 1;
    return counts;
  }, {});
  return {
    run: inspection.run,
    eventCount: inspection.events.length,
    eventTypes,
  };
}

export function isSuccessfulResult(result: RunResult | ChatResult): result is Extract<RunResult | ChatResult, { status: 'success' }> {
  return result.status === 'success';
}

export function shouldListenForCliEvents(cli: ManualTestCliOptions): boolean {
  return cli.events || cli.progress;
}

export function summarizeEvent(event: { type: string; runId: string; stepId?: string; toolCallId?: string; payload: JsonValue; createdAt: string }): Record<string, JsonValue> {
  const summary = summarizeAgentEvent(event);
  return {
    type: event.type,
    runId: event.runId,
    ...(summary.roleLabel ? { roleLabel: summary.roleLabel } : {}),
    ...(event.stepId ? { stepId: event.stepId } : {}),
    ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
    createdAt: event.createdAt,
    payload: summarizeEventPayload(event.payload),
  };
}

export function summarizeOrchestrationLifecycleEvent(event: OrchestrationLifecycleEvent): Record<string, JsonValue> {
  return {
    type: event.type,
    sessionId: event.sessionId,
    requestedAgentId: event.requestedAgentId,
    createdAt: event.createdAt,
    ...('executionShape' in event ? { executionShape: event.executionShape } : {}),
    ...('detectedModalities' in event ? { detectedModalities: event.detectedModalities } : {}),
    ...('routingReason' in event ? { routingReason: event.routingReason } : {}),
    ...('nodes' in event ? { nodes: event.nodes as unknown as JsonValue } : {}),
    ...('nodeId' in event ? { nodeId: event.nodeId, agentId: event.agentId, stage: event.stage } : {}),
    ...('runId' in event ? { runId: event.runId, rootRunId: event.rootRunId } : {}),
    ...('finalRunId' in event ? { finalRunId: event.finalRunId } : {}),
    ...('status' in event ? { status: event.status } : {}),
  };
}

export function summarizeEventPayload(payload: JsonValue): JsonValue {
  if (typeof payload !== 'object' || payload === null) {
    return payload;
  }
  const objectPayload = payload as JsonObject;
  const summary: JsonObject = {};
  for (const [key, value] of Object.entries(objectPayload)) {
    if (key === 'input' || key === 'output' || key === 'messages') {
      summary[key] = '[omitted]';
      continue;
    }
    summary[key] = value;
  }
  return summary;
}

export const ASSISTANT_CONTENT_PROGRESS_EVENT_TYPES = new Set([
  'tool.started',
  'approval.requested',
  'delegate.spawned',
]);

export class RunColorRegistry {
  private readonly stylesByRunId = new Map<string, TuiTextStyleName>();

  colorize(runId: string | undefined, value: string): string {
    if (!runId) return value;
    return applyNamedStyle(value, this.styleForRun(runId));
  }

  private styleForRun(runId: string): TuiTextStyleName {
    const cached = this.stylesByRunId.get(runId);
    if (cached) return cached;
    const style = RUN_COLOR_STYLES[this.stylesByRunId.size % RUN_COLOR_STYLES.length]!;
    this.stylesByRunId.set(runId, style);
    return style;
  }
}

export function shortRunId(runId: string): string {
  return runId.length > 8 ? runId.slice(0, 8) : runId;
}

export function printRunBoundaryEvent(event: AgentEvent, theme: TuiSettingsConfig, colors: RunColorRegistry, wrapWidth?: number): void {
  if (event.type === 'run.created') {
    printRunStartedEvent(event, theme, colors, wrapWidth);
    return;
  }
  if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'replan.required') {
    printRunEndedEvent(event, theme, colors, wrapWidth);
  }
}

export function printRunStartedEvent(event: AgentEvent, theme: TuiSettingsConfig, colors: RunColorRegistry, wrapWidth?: number): void {
  if (typeof event.payload !== 'object' || event.payload === null || Array.isArray(event.payload)) return;
  const payload = event.payload as JsonObject;
  if (typeof payload.rootRunId === 'string' && payload.rootRunId !== event.runId) return;
  if (typeof payload.delegationDepth === 'number' && payload.delegationDepth > 0) return;
  const label = agentEventProgressPrefix(event);
  const lines = [`[started] ${label} run: ${event.runId}`];
  if (typeof payload.goal === 'string') {
    lines.push(`goal: ${payload.goal.replace(/\s+/g, ' ').trim()}`);
  }
  const line = colors.colorize(agentEventColorKey(event), wrapRenderedText(lines.join('\n'), wrapWidth));
  console.error(renderStyledPrettyMessage('event', line, theme));
}

export function printRunEndedEvent(event: AgentEvent, theme: TuiSettingsConfig, colors: RunColorRegistry, wrapWidth?: number): void {
  const payload = typeof event.payload === 'object' && event.payload !== null && !Array.isArray(event.payload)
    ? event.payload as JsonObject
    : {};
  const status = event.type === 'run.completed'
    ? 'completed'
    : event.type === 'replan.required'
      ? 'replan required'
      : 'failed';
  const label = agentEventProgressPrefix(event);
  const lines = [`[${status}] ${label} run: ${event.runId}`];
  const lineage = renderRunLineage(event.runId, payload);
  if (lineage) {
    lines.push(lineage);
  }
  const error = typeof payload.error === 'string' ? payload.error.replace(/\s+/g, ' ').trim() : undefined;
  if (error) {
    lines.push(`error: ${error}`);
  }
  const code = typeof payload.code === 'string' ? payload.code : undefined;
  if (code) {
    lines.push(`code: ${code}`);
  }
  const colorRunId = terminalEventColorRunId(event.runId, payload);
  const line = colors.colorize(agentEventColorKey({ runId: colorRunId, payload }), wrapRenderedText(lines.join('\n'), wrapWidth));
  console.error(renderStyledPrettyMessage('event', line, theme));
}

export function terminalEventColorRunId(runId: string, payload: JsonObject): string {
  return typeof payload.parentRunId === 'string' ? payload.parentRunId : runId;
}

export function renderRunLineage(runId: string, payload: JsonObject): string | undefined {
  const rootRunId = typeof payload.rootRunId === 'string' ? payload.rootRunId : undefined;
  const parentRunId = typeof payload.parentRunId === 'string' ? payload.parentRunId : undefined;
  const parentStepId = typeof payload.parentStepId === 'string' ? payload.parentStepId : undefined;
  const delegateName = typeof payload.delegateName === 'string' ? payload.delegateName : undefined;
  const delegationDepth = typeof payload.delegationDepth === 'number' ? payload.delegationDepth : undefined;
  const parts: string[] = [];
  if (rootRunId && rootRunId !== runId) parts.push(`root=${rootRunId}`);
  if (parentRunId) parts.push(`parent=${parentRunId}`);
  if (parentStepId) parts.push(`parentStep=${parentStepId}`);
  if (delegateName) parts.push(`delegate=${delegateName}`);
  if (delegationDepth !== undefined && delegationDepth > 0) parts.push(`depth=${delegationDepth}`);
  return parts.length > 0 ? `context: ${parts.join(' ')}` : undefined;
}

export function printProgressEvent(
  event: { type: string; runId: string; payload: JsonValue },
  lastContentByRun: Map<string, string>,
  theme: TuiSettingsConfig,
  showLines: number,
  wrapWidth?: number,
  colors?: RunColorRegistry,
): void {
  const assistantContent = extractAssistantProgressContent(event);
  if (!assistantContent) {
    return;
  }
  if (lastContentByRun.get(event.runId) === assistantContent) {
    return;
  }
  lastContentByRun.set(event.runId, assistantContent);
  const rendered = limitRenderedProgressLines(wrapRenderedText(renderPrettyString(assistantContent), wrapWidth), showLines);
  if (colors) {
    const prefix = agentEventProgressPrefix(event);
    console.error(formatStyledMessageBlock('progress', wrapRenderedText(colors.colorize(agentEventColorKey(event), `${prefix} ${rendered}`), wrapWidth), swarmProgressTheme(theme)));
    return;
  }
  console.error(formatStyledMessageBlock('progress', rendered, theme));
}

export const ANSI_PATTERN = /\x1B\[[0-?]*[ -/]*[@-~]/g;

export function wrapRenderedText(rendered: string, requestedWidth?: number): string {
  const width = requestedWidth ?? resolveDefaultWrapWidth();
  if (!Number.isFinite(width) || width < 20) {
    return rendered.trim();
  }
  return rendered
    .trim()
    .split(/\r?\n/)
    .flatMap((line) => wrapRenderedLine(line, width))
    .join('\n');
}

export function wrapRenderedLine(line: string, width: number): string[] {
  if (visibleLength(line) <= width) {
    return [line];
  }
  const strippedLine = stripAnsi(line);
  const labelMatch = /^(\s*[^:\s]+:\s+)(.+)$/.exec(strippedLine);
  const leadingWhitespace = /^\s*/.exec(strippedLine)?.[0] ?? '';
  const continuationIndent = labelMatch ? ' '.repeat(labelMatch[1].length) : leadingWhitespace;
  const tokens = line.trim().split(/\s+/);
  const lines: string[] = [];
  let current = '';
  let currentWidth = 0;

  for (const token of tokens) {
    const tokenWidth = visibleLength(token);
    if (current && currentWidth + 1 + tokenWidth > width) {
      lines.push(current);
      current = `${continuationIndent}${token}`;
      currentWidth = continuationIndent.length + tokenWidth;
      continue;
    }
    if (!current) {
      current = token;
      currentWidth = tokenWidth;
      continue;
    }
    current += ` ${token}`;
    currentWidth += 1 + tokenWidth;
  }

  if (current) {
    lines.push(current);
  }
  return lines.length > 0 ? lines : [line];
}

export function visibleLength(value: string): number {
  return stripAnsi(value).length;
}

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '');
}

export function resolveDefaultWrapWidth(): number {
  const terminalWidth = process.stderr.columns || process.stdout.columns;
  if (!terminalWidth || terminalWidth < 20) {
    return 100;
  }
  return Math.max(40, Math.min(terminalWidth, 120));
}

export function limitRenderedProgressLines(rendered: string, showLines: number): string {
  return rendered.trim().split(/\r?\n/).slice(0, showLines).join('\n');
}

export function swarmProgressTheme(theme: TuiSettingsConfig): TuiSettingsConfig {
  return {
    ...theme,
    messages: {
      ...(theme.messages ?? {}),
      progress: {
        ...(theme.messages?.progress ?? {}),
        showPrefix: false,
      },
    },
  };
}

export function extractAssistantProgressContent(event: { type: string; payload: JsonValue }): string | undefined {
  if (!ASSISTANT_CONTENT_PROGRESS_EVENT_TYPES.has(event.type)) {
    return undefined;
  }
  if (typeof event.payload !== 'object' || event.payload === null || Array.isArray(event.payload)) {
    return undefined;
  }
  const assistantContent = (event.payload as JsonObject).assistantContent;
  if (typeof assistantContent !== 'string') {
    return undefined;
  }
  const trimmed = assistantContent.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function printResolvedConfigSummary(
  cli: ManualTestCliOptions,
  resolvedConfig: Awaited<ReturnType<typeof loadAgentSdkConfig>>,
  spec: ManualTestSpec,
  warnings: string[],
): void {
  const summary = summarizeSpec(spec);
  console.log(`spec: ${resolve(cli.specPath)}`);
  console.log(`mode: ${spec.mode}`);
  console.log(`agent: ${resolvedConfig.agent.id} (${resolvedConfig.agent.name})`);
  console.log(`model: ${resolvedConfig.model.provider}/${resolvedConfig.model.model}`);
  console.log(`runtime: ${resolvedConfig.runtime.mode} (requested ${resolvedConfig.runtime.requestedMode})`);
  console.log(`workspace: ${resolvedConfig.workspaceRoot}`);
  console.log(`messages: ${summary.messageCount}`);
  console.log(`content: text=${summary.textParts} image=${summary.imageParts + summary.legacyImages} file=${summary.fileParts} audio=${summary.audioParts}`);
  if (warnings.length > 0) {
    console.log(`warnings: ${warnings.length}`);
  }
  console.log('');
}

export function formatNameList(values: readonly string[]): string {
  return values.length > 0 ? values.join(', ') : '(none)';
}

export function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function printDryRun(
  cli: ManualTestCliOptions,
  inspection: Awaited<ReturnType<typeof inspectAgentSdkResolution>>,
  spec: ManualTestSpec,
  warnings: string[],
): void {
  const output = summarizeDryRun(cli, inspection, spec, warnings);
  if (cli.output === 'json') {
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  if (cli.output === 'jsonl') {
    console.log(JSON.stringify(output));
    return;
  }

  console.log(renderPrettyString(formatDryRunMarkdown(inspection, spec, warnings)));
}
export function formatDryRunMarkdown(
  inspection: Awaited<ReturnType<typeof inspectAgentSdkResolution>>,
  spec: ManualTestSpec,
  warnings: string[],
): string {
  const config = inspection.config;
  const summary = summarizeSpec(spec);
  const lines = [
    '# Dry run',
    '',
    '- `dryRun`: `true`',
    `- \`approval\`: \`${config.interaction.approvalMode}\``,
    `- \`clarification\`: \`${config.interaction.clarificationMode}\``,
    `- \`shellCwd\`: \`${config.shellCwd}\``,
    `- \`agentSearchDirs\`: ${formatNameList(config.agents.dirs)}`,
    `- \`skillSearchDirs\`: ${formatNameList(config.skills.dirs)}`,
    '',
    '## Request',
    '',
    `- \`mode\`: \`${spec.mode}\``,
    ...(spec.mode === 'run'
      ? [
          `- \`goalLength\`: \`${spec.goal.length}\``,
          `- \`input\`: \`${spec.input === undefined ? 'absent' : 'present'}\``,
        ]
      : []),
    `- \`messages\`: \`${summary.messageCount}\``,
    `- \`content\`: text=${summary.textParts} image=${summary.imageParts + summary.legacyImages} file=${summary.fileParts} audio=${summary.audioParts}`,
    '',
    '## Tools',
    '',
    ...(inspection.tools.length === 0 ? ['- (none)'] : inspection.tools.map((tool) => `- \`${tool.name}\``)),
    '',
    '## Delegates',
    '',
    ...(inspection.delegates.length === 0
      ? ['- (none)']
      : inspection.delegates.flatMap((delegate) => [
          `- \`${delegate.name}\``,
          ...(delegate.description ? [`  - description: ${oneLine(delegate.description)}`] : []),
          `  - allowedTools: ${formatNameList(delegate.allowedTools)}`,
        ])),
    '',
    `- \`registeredTools\`: ${formatNameList(inspection.registeredToolNames)}`,
  ];

  if (warnings.length > 0) {
    lines.push('', '## Warnings', '', ...warnings.map((warning) => `- ${warning}`));
  }

  return `${lines.join('\n')}\n`;
}

export function summarizeDryRun(
  cli: ManualTestCliOptions,
  inspection: Awaited<ReturnType<typeof inspectAgentSdkResolution>>,
  spec: ManualTestSpec,
  warnings: string[],
): Record<string, JsonValue> {
  return {
    dryRun: true,
    cli: summarizeCli(cli),
    resolvedConfig: summarizeResolvedConfig(inspection.config, spec),
    request: spec as unknown as JsonValue,
    tools: inspection.tools.map((tool) => tool.name),
    delegates: inspection.delegates as unknown as JsonValue,
    registeredToolNames: inspection.registeredToolNames,
    warnings,
  };
}
export function printInlineConfigSummary(
  cli: ManualTestCliOptions,
  resolvedConfig: Awaited<ReturnType<typeof loadAgentSdkConfig>>,
  spec: ManualTestSpec,
  warnings: string[],
): void {
  const summary = summarizeSpec(spec);
  console.log(`command: ${cli.command}`);
  console.log(`mode: ${spec.mode}`);
  console.log(`agent: ${resolvedConfig.agent.id} (${resolvedConfig.agent.name})`);
  console.log(`model: ${resolvedConfig.model.provider}/${resolvedConfig.model.model}`);
  console.log(`runtime: ${resolvedConfig.runtime.mode} (requested ${resolvedConfig.runtime.requestedMode})`);
  console.log(`workspace: ${resolvedConfig.workspaceRoot}`);
  console.log(`messages: ${summary.messageCount}`);
  console.log(`content: text=${summary.textParts} image=${summary.imageParts + summary.legacyImages} file=${summary.fileParts} audio=${summary.audioParts}`);
  if (warnings.length > 0) {
    console.log(`warnings: ${warnings.length}`);
  }
  console.log('');
}

export function printEvent(event: Record<string, JsonValue>, theme: TuiSettingsConfig, colors?: RunColorRegistry): void {
  const runId = typeof event.runId === 'string' ? event.runId : undefined;
  const rendered = runId
    ? `[event] ${formatAgentEventSummary({
        type: String(event.type),
        runId,
        ...(typeof event.roleLabel === 'string' ? { roleLabel: event.roleLabel } : {}),
        ...(typeof event.stepId === 'string' ? { stepId: event.stepId } : {}),
        ...(typeof event.toolCallId === 'string' ? { toolCallId: event.toolCallId } : {}),
        timestamp: new Date(),
      })}`
    : `[event] ${String(event.type)}`;
  console.error(renderStyledPrettyMessage('event', colors?.colorize(runId, rendered) ?? rendered, theme));
}

export function printOrchestrationLifecycleEvent(event: OrchestrationLifecycleEvent, theme: TuiSettingsConfig): void {
  const parts = [`[event] ${event.type}`, `session=${event.sessionId}`];
  if ('nodeId' in event) parts.push(`node=${event.nodeId}`, `agent=${event.agentId}`, `stage=${event.stage}`);
  if ('runId' in event) parts.push(`run=${event.runId}`);
  if ('finalRunId' in event) parts.push(`run=${event.finalRunId}`);
  if ('status' in event) parts.push(`status=${event.status}`);
  if ('executionShape' in event) parts.push(`shape=${event.executionShape}`);
  console.error(renderStyledPrettyMessage('event', parts.join(' '), theme));
}

export function printResult(
  result: RunResult | ChatResult,
  successType: Extract<TuiMessageType, 'assistant' | 'run'>,
  theme: TuiSettingsConfig,
): void {
  console.log(`status: ${result.status}`);
  console.log(`runId: ${result.runId}`);
  if (result.status === 'success') {
    console.log(`stepsUsed: ${result.stepsUsed}`);
    printUsage(result.usage);
    console.log('output:');
    console.log(renderStyledPrettyValue(successType, result.output, theme));
    return;
  }
  if (result.status === 'failure') {
    console.log(`code: ${result.code}`);
    console.log('error:');
    console.log(renderStyledPrettyMessage('system', result.error, theme));
    console.log(`stepsUsed: ${result.stepsUsed}`);
    printUsage(result.usage);
    return;
  }
  console.log('message:');
  console.log(renderStyledPrettyMessage('system', result.message, theme));
  if ('toolName' in result) {
    console.log(`tool: ${result.toolName}`);
  }
}

export function printOrchestration(result: OrchestratedRunResult): void {
  console.log(`orchestration: session=${result.sessionId} shape=${result.executionShape}`);
  console.log(`routing: ${result.plan.routingReason}`);
  console.log(`stages: ${result.stages.map((stage) => `${stage.nodeId}:${stage.agentId}:${stage.runId}`).join(', ') || '(none)'}`);
  console.log('');
}

export function printUsage(usage: { promptTokens: number; completionTokens: number; reasoningTokens?: number; totalTokens?: number; estimatedCostUSD: number; provider?: string; model?: string }): void {
  console.log(`usage: prompt=${usage.promptTokens} completion=${usage.completionTokens} total=${usage.totalTokens ?? usage.promptTokens + usage.completionTokens} costUsd=${usage.estimatedCostUSD}`);
}

export function printInspection(inspection: InspectionSummary): void {
  console.log('');
  console.log('inspection:');
  console.log(`runStatus: ${inspection.run?.status ?? 'missing'}`);
  console.log(`eventCount: ${inspection.eventCount}`);
  for (const [type, count] of Object.entries(inspection.eventTypes).sort(([left], [right]) => left.localeCompare(right))) {
    console.log(`  ${type}: ${count}`);
  }
}

export function renderPrettyValue(value: unknown): string {
  if (typeof value === 'string') {
    return renderPrettyString(value);
  }
  return JSON.stringify(value, null, 2) ?? String(value);
}

export function renderStyledPrettyValue(
  type: TuiMessageType,
  value: unknown,
  theme: TuiSettingsConfig = {},
): string {
  // renderPrettyValue already renders markdown to terminal ANSI. Wrap the
  // result in the styled block directly instead of routing back through
  // renderStyledPrettyMessage, which would re-run marked.parse on the
  // already-rendered ANSI and corrupt the escape sequences (e.g. the `1` in
  // `\x1b[1m` getting syntax-highlighted, leaking visible `1m`/`22m`).
  return formatStyledMessageBlock(type, renderPrettyValue(value), theme);
}

export function renderPrettyString(value: string): string {
  return marked.parse(value) as string;
}

export function renderStyledPrettyMessage(
  type: TuiMessageType,
  value: string,
  theme: TuiSettingsConfig = {},
): string {
  const rendered = type === 'assistant' || type === 'progress' || type === 'run'
    ? renderPrettyString(value)
    : value;
  return formatStyledMessageBlock(type, rendered, theme);
}
