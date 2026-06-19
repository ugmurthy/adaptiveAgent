#!/usr/bin/env bun

import { access, appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';

import { marked } from 'marked';
import type {
  AgentEvent,
  ChatMessage,
  ImageInput,
  JsonObject,
  JsonSchema,
  JsonValue,
  ModelContentPart,
} from '@adaptive-agent/core';

import {
  createAgentSdk,
  createOrchestrationSdk,
  inspectAgentSdkCatalog,
  inspectAgentSdkResolution,
  loadAgentSdkConfig,
  type AgentSdkOptions,
  type AgentSdkChatOptions,
  type AgentSdkRunOptions,
  type OrchestrationLifecycleEvent,
  type OrchestrationSdk,
} from './index.js';
import { doctorExitCode, renderDoctorReport, runDoctor } from './install/doctor.js';
import { renderInitReport, runInit, type InitProfile } from './install/init.js';
import { renderUninstallReport, runUninstall, uninstallExitCode } from './install/uninstall.js';
import { renderUpdateReport, runUpdate, updateExitCode } from './install/update.js';
import { getVersionInfo, renderVersion } from './install/version.js';
import { renderAgentCreateReport, runAgentCreate } from './agent-create.js';
import { formatSwarmExecutionPlan, formatSwarmRunStatuses, formatSwarmSubtasks } from './swarm-format.js';
import { createSwarmRoleAgentConfig } from './swarm-role-config.js';
import { buildSwarmCoordinator, parseSwarmSubtasks, runSwarmDecomposition, validateSdkDecomposition } from './swarm-runner.js';
import type {
  BenchmarkAttachmentType,
  BenchmarkCase,
  BenchmarkDryRunAttachmentType,
  BenchmarkResultRecord,
  GaiaAttachment,
  GaiaDryRunTaskSummary,
  ManualChatSpec,
  ManualRunSpec,
  ManualTestCliOptions,
  ManualTestJsonOutput,
  ManualTestSpec,
} from './cli-types.js';
import {
  collectContentParts,
  formatCatalogMarkdown,
  formatCoordinatorDecompositionFailure,
  formatNameList,
  isSuccessfulResult,
  oneLine,
  printDryRun,
  printEvent,
  printInlineConfigSummary,
  printInspection,
  printOrchestration,
  printOrchestrationLifecycleEvent,
  printProgressEvent,
  printResolvedConfigSummary,
  printResult,
  printRunBoundaryEvent,
  printSwarmDryRun,
  printSwarmExecutionPlan,
  printSwarmResult,
  printSwarmRetryResult,
  renderPrettyString,
  renderStyledPrettyMessage,
  RunColorRegistry,
  shouldListenForCliEvents,
  summarizeCatalog,
  summarizeCli,
  summarizeEvent,
  summarizeInspection,
  summarizeOrchestration,
  summarizeOrchestrationLifecycleEvent,
  summarizeResolvedConfig,
  summarizeResult,
  summarizeSwarmRetry,
  summarizeSwarmRun,
} from './cli-render.js';

export { formatSwarmExecutionPlan, formatSwarmRunStatuses, formatSwarmSubtasks } from './swarm-format.js';
export { formatCoordinatorDecompositionFailure, renderPrettyString, renderStyledPrettyMessage };
export type { BenchmarkAttachmentType, BenchmarkCase, ManualTestCliOptions };


const BENCHMARK_ATTACHMENT_TYPES = ['audio', 'image', 'video', 'other'] as const;
const IMAGE_FILE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff']);
const AUDIO_FILE_EXTENSIONS = new Set(['.wav', '.mp3', '.flac', '.m4a', '.ogg', '.aac', '.aiff', '.aif', '.opus', '.oga', '.weba']);
const VIDEO_FILE_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi', '.mpeg', '.mpg', '.ogv', '.wmv', '.flv', '.3gp', '.ts', '.mts', '.m2ts']);

const HELP_TEXT = `adaptive-agent

Agent SDK CLI

Usage:
  adaptive-agent run [options] <goal...>
  adaptive-agent swarm-run --agent <path-or-name> --worker-catalog <paths-or-names> [options] <task...>
  adaptive-agent retry --run-id <runId> [options]
  adaptive-agent retry --agent <path-or-name> --worker-catalog <paths-or-names> [options] <sessionId>
  adaptive-agent chat [options] [message...]
  adaptive-agent init [options]
  adaptive-agent doctor [options]
  adaptive-agent update [options]
  adaptive-agent uninstall [options]
  adaptive-agent agent-create [options] <agent-description...>
  adaptive-agent spec <path> [options]
  adaptive-agent config [options]
  adaptive-agent catalog [options]
  adaptive-agent --version
  adaptive-agent --spec <path> [options]
  bun run ./packages/agent-sdk/dist/adaptive-agent.js --spec <path> [options]

Eval usage:
  adaptive-agent eval cases --input <path> --out <path> [options]
  adaptive-agent eval gaia --input <path> --out <path> [options]

Commands:
  run                   Run a one-shot goal.
  swarm-run             Decompose one task into bounded worker runs and synthesize a final result.
  retry                 Retry one failed run, or retry a swarm session by session id.
  chat                  Send one chat turn. Reads stdin when no message is given.
  init                  Create first-run configuration under ~/.adaptiveAgent.
  doctor                Check CLI installation and local configuration.
  update                Check for or apply GitHub Release updates.
  uninstall             Remove the installed adaptive-agent CLI binary.
  agent-create          Generate and write a new agent config JSON file.
  spec                  Run the existing JSON spec format.
  config                Print resolved SDK configuration.
  catalog               List available agents, tools, and delegate skills.

Eval commands:
  eval cases            Run generic benchmark cases from JSON/JSONL.
  eval gaia             Run GAIA benchmark rows from JSON/JSONL.

Global options:
  --cwd <path>            Working directory used for SDK config lookup.
  --output <format>       Output format: pretty, json, or jsonl. Default: pretty.
  --version               Print adaptive-agent version.
  --help                  Show this help text.

Agent/config options (run, chat, spec, config, catalog, eval, swarm-run, retry):
  --agent <path-or-name>  Explicit path to agent.json, or filename from agents.dirs.
  --settings <path>       Explicit path to agent.settings.json.
  --runtime <mode>        Runtime mode: memory or postgres.
  --provider <name>       Override provider: openrouter, ollama, mistral, mesh.
  --model <name>          Override model name.
  --approval <mode>       Approval mode: auto, manual, reject.
  --clarification <mode>  Clarification mode: interactive or fail.

Run options:
  --file <path>           Read run prompt from a file.
  --input-json <json>     JSON input passed to run requests.
  --image <path>          Add an image attachment to a run request. Repeatable.
  --audio <path>          Add an audio attachment to a run request. Repeatable.
  --file-attachment <path>
                          Add a file attachment to a run request. Repeatable.
  --orchestrate           Route run requests through the orchestration SDK.
  --catalog <path>        Agent config path to add to orchestration catalog. Repeatable.

Chat options:
  --file <path>           Read chat message from a file.

Spec options:
  --spec <path>           Path to the JSON spec file.
  --mode <chat|run>       Override the spec mode.
  --orchestrate           Route run-mode specs through the orchestration SDK.
  --catalog <path>        Agent config path to add to orchestration catalog. Repeatable.

Swarm-run options:
  --file <path>           Read swarm task from a file.
  --input-json <json>     JSON input passed to swarm runs.
  --image <path>          Add an image attachment to the coordinator request. Repeatable.
  --audio <path>          Add an audio attachment to the coordinator request. Repeatable.
  --file-attachment <path>
                          Add a file attachment to the coordinator request. Repeatable.
  --worker-catalog <paths>
                          Comma-separated worker agent JSON paths or filenames.
  --quality-agent <path-or-name>
                          Optional quality agent JSON path or filename.
  --synthesizer-agent <path-or-name>
                          Optional synthesizer agent JSON path or filename.
  --max-workers <n>       Maximum concurrent swarm workers.
  --session-id <id>       Session id for run grouping.

Retry options:
  --run-id <id>           Retry this single failed run instead of a swarm session.
  --worker-catalog <paths>
                          Comma-separated worker agent JSON paths or filenames for session retry.
  --quality-agent <path-or-name>
                          Optional quality agent JSON path or filename for session retry.
  --synthesizer-agent <path-or-name>
                          Optional synthesizer agent JSON path or filename for session retry.
  --max-workers <n>       Maximum concurrent swarm workers for session retry.

Init options:
  --provider <name>       Provider to write: openrouter, ollama, mistral, mesh.
  --model <name>          Model name to write.
  --api-key-env <name>    Environment variable containing provider API key.
  --profile <name>        Init profile: safe or coding.
  --minimal               Create only the default agent and getting-started skill.
  --bundle <name>         Install a bundled agent/skill pack. Repeatable.
  --install-agent <path>  Install an additional agent JSON file or directory.
                          Repeatable.
  --install-skill <path>  Install an additional skill directory or parent dir.
                          Repeatable.
  --install-manifest <path>
                          Install agents, skills, or bundles from a manifest.
                          Repeatable.
  --yes                   Accept command defaults for non-interactive setup.
  --force                 Overwrite files when supported.
  --dry-run               Show what init would create without writing files.

Doctor options:
  --agent <path-or-name>  Explicit path to agent.json, or filename from agents.dirs.
  --settings <path>       Explicit path to agent.settings.json.
  --runtime <mode>        Runtime store mode to validate: memory or postgres.
  --provider <name>       Provider override to validate: openrouter, ollama, mistral, mesh.
  --model <name>          Model override to validate.
  --network               Allow doctor network checks against GitHub.
  --provider-check        Allow doctor provider reachability checks.
  --strict                Treat doctor warnings as failures.

Update options:
  --check                 Check for updates without installing.
  --version <version>     Install or check a specific release version.
  --channel <name>        Update channel: stable or preview. Default: stable.
  --force                 Reinstall even when already up to date.
  --yes                   Accept update prompts when supported.
  --repo <owner/repo>     GitHub release repo for update checks.
  --base-url <url>        Release asset base URL for update downloads.

Uninstall options:
  --dry-run               Show which CLI binary would be removed.

Agent-create options:
  --file <path>           Read the new agent description from a text file.
  --generator-agent <path-or-name>
                          Existing agent used to generate the new config. Default: default-agent.
  --id <id>               Override the generated agent id.
  --provider <name>       Override generated config provider: openrouter, ollama, mistral, mesh.
  --model <name>          Override generated config model name.
  --yes                   Write without an interactive confirmation prompt.
  --force                 Overwrite an existing generated config path.
  --dry-run               Preview the config and ask before writing; Enter means no.

Run output/debug options (run, chat, spec, eval, swarm-run, retry):
  --progress              Print assistant progress updates as they arrive.
  --events                Print lifecycle events as they arrive.
  --show-lines <n>        Maximum pretty-rendered progress lines to show. Default: 3.
  --wrap-width <n>        Fold progress/event text after this many columns. Default: terminal width or 100.
  --dry-run               Resolve config, request, tools, and delegates without running.

Inspection options (run, chat, spec):
  --inspect               Print a compact inspection summary after completion.

Eval options:
  --input <path>          Benchmark input JSONL for eval cases.
  --files-dir <path>      Directory for benchmark attachments.
  --out <path>            Benchmark result JSONL path. Required unless --dry-run
                          is used without --resume.
  --artifacts <dir>       Benchmark artifact directory.
  --resume                Skip benchmark cases already present in --out.
  --fail-fast             Stop eval after the first failed case.
  --swarm <n>             Run eval cases in batches of up to n concurrent runs.
  --limit <n>             Limit benchmark cases after filtering.
  --offset <n>            Skip benchmark cases before filtering.
  --ids <id,id,...>       Run only the listed benchmark case ids.
  --level <value>         Run only matching benchmark level.
  --split <value>         Add/filter benchmark split metadata.
  --type <value>          Run only rows with a matching attachment type: audio,
                          image, video, or other. Rows without attachments do not match.
  --orchestrate           Route benchmark cases through the orchestration SDK.
  --catalog <path>        Agent config path to add to orchestration catalog. Repeatable.
`;

const PROVIDER_INPUT_CAPABILITIES: Record<
  'openrouter' | 'ollama' | 'mistral' | 'mesh',
  Partial<Record<'image' | 'file' | 'audio', Array<'path' | 'url' | 'data' | 'file_id'>>>
> = {
  openrouter: {
    image: ['path'],
    file: ['path', 'url', 'file_id'],
    audio: ['path', 'data'],
  },
  ollama: {
    image: ['path'],
  },
  mistral: {
    image: ['path'],
    file: ['path', 'url', 'file_id'],
    audio: ['path', 'data'],
  },
  mesh: {
    image: ['path'],
    audio: ['path', 'data'],
  },
};

export async function main(argv = Bun.argv.slice(2)): Promise<number> {
  const cli = parseCliArgs(argv);
  if (cli.help) {
    console.log(HELP_TEXT);
    return 0;
  }

  if (cli.command === 'version') {
    console.log(renderVersion(getVersionInfo()));
    return 0;
  }

  if (cli.command === 'init') {
    return runInitCommand(cli);
  }

  if (cli.command === 'doctor') {
    return runDoctorCommand(cli);
  }

  if (cli.command === 'update') {
    return runUpdateCommand(cli);
  }

  if (cli.command === 'uninstall') {
    return runUninstallCommand(cli);
  }

  if (cli.command === 'agent-create') {
    return runAgentCreateCommand(cli);
  }

  if (cli.command === 'config') {
    return runConfigCommand(cli);
  }

  if (cli.command === 'catalog') {
    return runCatalogCommand(cli);
  }

  if (cli.command === 'run') {
    return runInlineCommand(cli, 'run');
  }

  if (cli.command === 'swarm-run') {
    return runSwarmCommand(cli);
  }

  if (cli.command === 'retry') {
    return runRetryCommand(cli);
  }

  if (cli.command === 'chat') {
    return runInlineCommand(cli, 'chat');
  }

  if (cli.command === 'eval') {
    return runEvalCommand(cli);
  }

  return runSpecCommand(cli);
}

async function runInitCommand(cli: ManualTestCliOptions): Promise<number> {
  const report = await runInit({
    cwd: cli.cwd,
    provider: cli.provider,
    model: cli.model,
    apiKeyEnv: cli.apiKeyEnv,
    profile: cli.profile,
    minimal: cli.minimal,
    bundles: cli.bundles,
    installAgents: cli.installAgents,
    installSkills: cli.installSkills,
    installManifests: cli.installManifests,
    yes: cli.yes,
    force: cli.force,
    dryRun: cli.dryRun,
  });
  console.log(renderInitReport(report, cli.output));
  return report.actions.some((action) => action.kind === 'file' && action.status === 'exists') ? 1 : 0;
}

async function runDoctorCommand(cli: ManualTestCliOptions): Promise<number> {
  const report = await runDoctor({
    cwd: cli.cwd,
    agent: cli.agentConfigPath,
    settings: cli.settingsConfigPath,
    runtime: cli.runtimeMode,
    provider: cli.provider,
    model: cli.model,
    network: cli.network,
    providerCheck: cli.providerCheck,
    strict: cli.strict,
  });
  console.log(renderDoctorReport(report, cli.output));
  return doctorExitCode(report, cli.strict);
}

async function runUpdateCommand(cli: ManualTestCliOptions): Promise<number> {
  const report = await runUpdate({
    check: cli.updateCheck,
    targetVersion: cli.updateVersion,
    channel: cli.updateChannel,
    force: cli.force,
    yes: cli.yes,
    repo: cli.updateRepo,
    baseUrl: cli.updateBaseUrl,
  });
  console.log(renderUpdateReport(report, cli.output));
  return updateExitCode(report, cli.updateCheck);
}

async function runUninstallCommand(cli: ManualTestCliOptions): Promise<number> {
  const report = await runUninstall({
    dryRun: cli.dryRun,
  });
  console.log(renderUninstallReport(report, cli.output));
  return uninstallExitCode(report);
}

async function runAgentCreateCommand(cli: ManualTestCliOptions): Promise<number> {
  const brief = await readInlinePrompt(cli, 'agent description');
  const report = await runAgentCreate({
    brief,
    cwd: cli.cwd,
    settingsConfigPath: cli.settingsConfigPath,
    generatorAgent: cli.generatorAgentPath,
    id: cli.agentCreateId,
    provider: cli.provider,
    model: cli.model,
    runtimeMode: cli.runtimeMode,
    yes: cli.yes,
    force: cli.force,
    dryRun: cli.dryRun,
  });
  console.log(renderAgentCreateReport(report, cli.output));
  return report.status === 'created' || report.status === 'overwritten' ? 0 : 1;
}

async function runSpecCommand(cli: ManualTestCliOptions): Promise<number> {
  const specPath = resolve(cli.specPath);
  const spec = await parseAndValidateSpec(specPath, cli.mode);
  const resolvedCwd = resolve(cli.cwd ?? process.cwd());
  const sdkOptions = buildSdkOptions(cli, resolvedCwd);
  const inspection = cli.dryRun ? await inspectAgentSdkResolution(sdkOptions) : undefined;
  const resolvedConfig = inspection?.config ?? await loadAgentSdkConfig(sdkOptions);
  const warnings = collectProviderWarnings(spec, resolvedConfig.model.provider);
  const eventLog: Array<Record<string, JsonValue>> = [];
  const lastProgressContentByRun = new Map<string, string>();
  const progressRunColors = cli.progress && cli.output === 'pretty' ? new RunColorRegistry() : undefined;
  const eventListener = shouldListenForCliEvents(cli) ? (event: AgentEvent) => {
    const entry = summarizeEvent(event);
    eventLog.push(entry);
    if (progressRunColors) {
      printRunBoundaryEvent(event, resolvedConfig.tui, progressRunColors, cli.wrapWidth);
    }
    if (cli.events && cli.output === 'pretty') {
      printEvent(entry, resolvedConfig.tui);
    } else if (cli.progress && cli.output === 'pretty') {
      printProgressEvent(event, lastProgressContentByRun, resolvedConfig.tui, cli.showLines, cli.wrapWidth);
    }
  } : undefined;
  const orchestrationListener = shouldListenForCliEvents(cli) ? (event: OrchestrationLifecycleEvent) => {
    const entry = summarizeOrchestrationLifecycleEvent(event);
    eventLog.push(entry);
    if ((cli.events || cli.progress) && cli.output === 'pretty') {
      printOrchestrationLifecycleEvent(event, resolvedConfig.tui);
    }
  } : undefined;

  for (const warning of warnings) {
    if (cli.output === 'pretty') {
      console.error(`warning: ${warning}`);
    }
  }

  if (cli.output === 'pretty') {
    printResolvedConfigSummary(cli, resolvedConfig, spec, warnings);
  }

  if (cli.dryRun) {
    printDryRun(cli, inspection!, spec, warnings);
    return 0;
  }

  const sdk = await createAgentSdk({
    ...sdkOptions,
    eventListener,
  });
  const orchestrationSdk = cli.orchestrate && spec.mode === 'run'
    ? await createOrchestrationSdk({
        ...sdkOptions,
        requestedAgentConfig: sdk.config.agent,
        agentCatalogPaths: cli.agentCatalogPaths,
        runtime: sdk.created.runtime,
        eventListener,
        orchestrationListener,
      })
    : undefined;

  try {
    const orchestrated = orchestrationSdk && spec.mode === 'run'
      ? await orchestrationSdk.runRaw(spec.goal, buildRunOptions(spec))
      : undefined;
    const result = orchestrated?.finalResult ?? (spec.mode === 'chat'
      ? await sdk.chat(spec.messages, buildChatOptions(spec))
      : await sdk.run(spec.goal, buildRunOptions(spec)));

    const inspection = cli.inspect ? await summarizeInspection(sdk, result.runId) : undefined;
    if (cli.output === 'json') {
      const jsonOutput: ManualTestJsonOutput = {
        cli: summarizeCli(cli),
        resolvedConfig: summarizeResolvedConfig(resolvedConfig, spec),
        request: spec as unknown as JsonValue,
        warnings,
        result: summarizeResult(result),
        ...(inspection ? { inspection: inspection as unknown as JsonValue } : {}),
        ...(orchestrated ? { orchestration: summarizeOrchestration(orchestrated) } : {}),
      };
      console.log(JSON.stringify(jsonOutput, null, 2));
      return isSuccessfulResult(result) ? 0 : 1;
    }

    if (orchestrated) printOrchestration(orchestrated);
    printResult(result, spec.mode === 'chat' ? 'assistant' : 'run', resolvedConfig.tui);
    if (cli.inspect && inspection) {
      printInspection(inspection);
    }
    if (cli.events && eventLog.length > 0) {
      console.error(`event log captured: ${eventLog.length}`);
    }
    return isSuccessfulResult(result) ? 0 : 1;
  } finally {
    await orchestrationSdk?.close();
    await sdk.close();
  }
}

async function runInlineCommand(cli: ManualTestCliOptions, mode: 'run' | 'chat'): Promise<number> {
  const resolvedCwd = resolve(cli.cwd ?? process.cwd());
  const goal = await readInlinePrompt(cli, mode === 'run' ? 'run goal' : 'chat message');
  const spec: ManualTestSpec = mode === 'run'
    ? {
        mode: 'run',
        goal,
        ...(cli.inputJson === undefined ? {} : { input: cli.inputJson }),
        ...(cli.imagePaths.length > 0 ? { images: cli.imagePaths.map((path) => ({ path: resolveAssetPath(path, resolvedCwd) })) } : {}),
        ...(cli.audioPaths.length > 0 || cli.fileAttachmentPaths.length > 0
          ? { contentParts: buildInlineContentParts(cli, resolvedCwd) }
          : {}),
      }
    : { mode: 'chat', messages: [{ role: 'user', content: goal }] };
  await validateLocalPaths(spec);

  const sdkOptions = buildSdkOptions(cli, resolvedCwd);
  const inspection = cli.dryRun ? await inspectAgentSdkResolution(sdkOptions) : undefined;
  const resolvedConfig = inspection?.config ?? await loadAgentSdkConfig(sdkOptions);
  const warnings = collectProviderWarnings(spec, resolvedConfig.model.provider);
  const eventLog: Array<Record<string, JsonValue>> = [];
  const lastProgressContentByRun = new Map<string, string>();
  const progressRunColors = cli.progress && cli.output === 'pretty' ? new RunColorRegistry() : undefined;
  const eventListener = shouldListenForCliEvents(cli) ? (event: AgentEvent) => {
    const entry = summarizeEvent(event);
    eventLog.push(entry);
    if (progressRunColors) {
      printRunBoundaryEvent(event, resolvedConfig.tui, progressRunColors, cli.wrapWidth);
    }
    if (cli.events && cli.output === 'pretty') {
      printEvent(entry, resolvedConfig.tui);
    } else if (cli.progress && cli.output === 'pretty') {
      printProgressEvent(event, lastProgressContentByRun, resolvedConfig.tui, cli.showLines, cli.wrapWidth);
    }
  } : undefined;
  const orchestrationListener = shouldListenForCliEvents(cli) ? (event: OrchestrationLifecycleEvent) => {
    const entry = summarizeOrchestrationLifecycleEvent(event);
    eventLog.push(entry);
    if ((cli.events || cli.progress) && cli.output === 'pretty') {
      printOrchestrationLifecycleEvent(event, resolvedConfig.tui);
    }
  } : undefined;

  for (const warning of warnings) {
    if (cli.output === 'pretty') console.error(`warning: ${warning}`);
  }

  if (cli.output === 'pretty') {
    printInlineConfigSummary(cli, resolvedConfig, spec, warnings);
  }

  if (cli.dryRun) {
    printDryRun(cli, inspection!, spec, warnings);
    return 0;
  }

  const sdk = await createAgentSdk({
    ...sdkOptions,
    eventListener,
  });
  const orchestrationSdk = cli.orchestrate && spec.mode === 'run'
    ? await createOrchestrationSdk({
        ...sdkOptions,
        requestedAgentConfig: sdk.config.agent,
        agentCatalogPaths: cli.agentCatalogPaths,
        runtime: sdk.created.runtime,
        eventListener,
        orchestrationListener,
      })
    : undefined;

  try {
    const orchestrated = orchestrationSdk && spec.mode === 'run'
      ? await orchestrationSdk.runRaw(spec.goal, buildRunOptions(spec))
      : undefined;
    const result = orchestrated?.finalResult ?? (spec.mode === 'chat'
      ? await sdk.chat(spec.messages, buildChatOptions(spec))
      : await sdk.run(spec.goal, buildRunOptions(spec)));
    const inspection = cli.inspect ? await summarizeInspection(sdk, result.runId) : undefined;

    if (cli.output === 'json') {
      const jsonOutput: ManualTestJsonOutput = {
        cli: summarizeCli(cli),
        resolvedConfig: summarizeResolvedConfig(resolvedConfig, spec),
        request: spec as unknown as JsonValue,
        warnings,
        result: summarizeResult(result),
        ...(inspection ? { inspection: inspection as unknown as JsonValue } : {}),
        ...(orchestrated ? { orchestration: summarizeOrchestration(orchestrated) } : {}),
      };
      console.log(JSON.stringify(jsonOutput, null, 2));
      return isSuccessfulResult(result) ? 0 : 1;
    }

    if (orchestrated) printOrchestration(orchestrated);
    printResult(result, spec.mode === 'chat' ? 'assistant' : 'run', resolvedConfig.tui);
    if (cli.inspect && inspection) printInspection(inspection);
    if (cli.events && eventLog.length > 0) console.error(`event log captured: ${eventLog.length}`);
    return isSuccessfulResult(result) ? 0 : 1;
  } finally {
    await orchestrationSdk?.close();
    await sdk.close();
  }
}

async function runSwarmCommand(cli: ManualTestCliOptions): Promise<number> {
  const resolvedCwd = resolve(cli.cwd ?? process.cwd());
  const topLevelObjective = await readInlinePrompt(cli, 'swarm task');
  const sdkOptions = buildSdkOptions(cli, resolvedCwd);
  const eventLog: Array<Record<string, JsonValue>> = [];
  const coordinatorConfig = await loadFlaggedAgentSdkConfig(sdkOptions, '--agent', cli.agentConfigPath ?? 'agent.json');
  const workerConfigs = await Promise.all(cli.workerCatalogPaths.map((agentConfigPath) => loadFlaggedAgentSdkConfig(sdkOptions, '--worker-catalog', agentConfigPath)));
  const qualityConfig = cli.qualityAgentPath
    ? await loadFlaggedAgentSdkConfig(sdkOptions, '--quality-agent', cli.qualityAgentPath)
    : await loadAgentSdkConfig({ ...sdkOptions, agentConfig: createSwarmRoleAgentConfig(coordinatorConfig.agent, 'quality') });
  const synthesizerConfig = cli.synthesizerAgentPath
    ? await loadFlaggedAgentSdkConfig(sdkOptions, '--synthesizer-agent', cli.synthesizerAgentPath)
    : await loadAgentSdkConfig({ ...sdkOptions, agentConfig: createSwarmRoleAgentConfig(coordinatorConfig.agent, 'synthesizer') });
  const workerIds = workerConfigs.map((config) => config.agent.id);
  const duplicateWorkerId = workerIds.find((id, index) => workerIds.indexOf(id) !== index);
  if (duplicateWorkerId) throw new Error(`swarm-run worker catalog contains duplicate agent id: ${duplicateWorkerId}`);

  if (cli.dryRun) {
    printSwarmDryRun(cli, coordinatorConfig, workerConfigs, qualityConfig, synthesizerConfig);
    return 0;
  }

  const lastProgressContentByRun = new Map<string, string>();
  const swarmColors = cli.output === 'pretty' ? new RunColorRegistry() : undefined;
  const eventListener = shouldListenForCliEvents(cli) ? (event: AgentEvent) => {
    const entry = summarizeEvent(event);
    eventLog.push(entry);
    if (swarmColors && cli.progress) {
      printRunBoundaryEvent(event, coordinatorConfig.tui, swarmColors, cli.wrapWidth);
    }
    if (cli.events && cli.output === 'pretty') {
      printEvent(entry, coordinatorConfig.tui, swarmColors);
    } else if (cli.progress && cli.output === 'pretty') {
      printProgressEvent(event, lastProgressContentByRun, coordinatorConfig.tui, cli.showLines, cli.wrapWidth, swarmColors);
    }
  } : undefined;

  const coordinatorSdk = await createFlaggedAgentSdk({ ...sdkOptions, eventListener }, '--agent', cli.agentConfigPath ?? 'agent.json');
  const workerSdks = await Promise.all(cli.workerCatalogPaths.map((agentConfigPath) => createFlaggedAgentSdk({ ...sdkOptions, agentConfigPath, runtime: coordinatorSdk.created.runtime, eventListener }, '--worker-catalog', agentConfigPath)));
  const qualitySdk = cli.qualityAgentPath
    ? await createFlaggedAgentSdk({ ...sdkOptions, agentConfigPath: cli.qualityAgentPath, runtime: coordinatorSdk.created.runtime, eventListener }, '--quality-agent', cli.qualityAgentPath)
    : await createAgentSdk({ ...sdkOptions, agentConfig: createSwarmRoleAgentConfig(coordinatorSdk.config.agent, 'quality'), runtime: coordinatorSdk.created.runtime, eventListener });
  const synthesizerSdk = cli.synthesizerAgentPath
    ? await createFlaggedAgentSdk({ ...sdkOptions, agentConfigPath: cli.synthesizerAgentPath, runtime: coordinatorSdk.created.runtime, eventListener }, '--synthesizer-agent', cli.synthesizerAgentPath)
    : await createAgentSdk({ ...sdkOptions, agentConfig: createSwarmRoleAgentConfig(coordinatorSdk.config.agent, 'synthesizer'), runtime: coordinatorSdk.created.runtime, eventListener });

  try {
    const sessionId = cli.sessionId ?? crypto.randomUUID();
    const contentParts = buildInlineContentParts(cli, resolvedCwd);
    const decompositionResult = await runSwarmDecomposition({
      coordinatorSdk,
      sessionId,
      topLevelObjective,
      inputJson: cli.inputJson,
      workerAgents: workerConfigs.map((config) => config.agent),
      workerIds,
      contentParts,
    });

    if (decompositionResult.status !== 'success') {
      throw new Error(formatCoordinatorDecompositionFailure(decompositionResult));
    }

    const subtasks = parseSwarmSubtasks(decompositionResult.output);
    validateSdkDecomposition(subtasks, workerIds);
    if (cli.output === 'pretty') {
      printSwarmExecutionPlan(sessionId, decompositionResult.runId, subtasks, cli.wrapWidth);
    }
    const swarm = buildSwarmCoordinator({
      coordinatorSdk,
      workerSdks,
      qualitySdk,
      synthesizerSdk,
      defaultMaxWorkers: cli.maxWorkers,
    });
    const result = await swarm.execute({
      sessionId,
      coordinatorRunId: decompositionResult.runId,
      topLevelObjective,
      input: cli.inputJson,
      contentParts: contentParts.length > 0 ? contentParts : undefined,
      maxWorkers: cli.maxWorkers,
      metadata: {
        defaultsUsed: {
          qualityAgent: cli.qualityAgentPath ? 'explicit' : 'coordinator_with_quality_instructions',
          synthesizerAgent: cli.synthesizerAgentPath ? 'explicit' : 'coordinator_with_synthesis_instructions',
        },
      },
      subtasks,
    });

    if (cli.output === 'json') {
      console.log(JSON.stringify(summarizeSwarmRun(result, workerIds, cli, subtasks), null, 2));
    } else if (cli.output === 'jsonl') {
      console.log(JSON.stringify(summarizeSwarmRun(result, workerIds, cli, subtasks)));
    } else {
      printSwarmResult(result, workerIds, cli);
      if (cli.events && eventLog.length > 0) console.error(`event log captured: ${eventLog.length}`);
    }
    return result.status === 'succeeded' ? 0 : 1;
  } finally {
    await Promise.allSettled([
      ...workerSdks.map((sdk) => sdk.close()),
      qualitySdk.close(),
      synthesizerSdk.close(),
      coordinatorSdk.close(),
    ]);
  }
}

async function runRetryCommand(cli: ManualTestCliOptions): Promise<number> {
  const resolvedCwd = resolve(cli.cwd ?? process.cwd());
  const sdkOptions = buildSdkOptions(cli, resolvedCwd);
  const eventLog: Array<Record<string, JsonValue>> = [];
  const resolvedConfig = await loadAgentSdkConfig(sdkOptions);
  const lastProgressContentByRun = new Map<string, string>();
  const retryColors = cli.output === 'pretty' ? new RunColorRegistry() : undefined;
  const eventListener = shouldListenForCliEvents(cli) ? (event: AgentEvent) => {
    const entry = summarizeEvent(event);
    eventLog.push(entry);
    if (retryColors && cli.progress) {
      printRunBoundaryEvent(event, resolvedConfig.tui, retryColors, cli.wrapWidth);
    }
    if (cli.events && cli.output === 'pretty') {
      printEvent(entry, resolvedConfig.tui, retryColors);
    } else if (cli.progress && cli.output === 'pretty') {
      printProgressEvent(event, lastProgressContentByRun, resolvedConfig.tui, cli.showLines, cli.wrapWidth, retryColors);
    }
  } : undefined;

  const coordinatorSdk = await createAgentSdk({ ...sdkOptions, eventListener });
  if (cli.runId) {
    try {
      const inspection = await coordinatorSdk.inspect(cli.runId);
      const runAgentId = typeof inspection.run?.metadata?.agentId === 'string' ? inspection.run.metadata.agentId : undefined;
      if (runAgentId && runAgentId !== coordinatorSdk.config.agent.id) {
        throw new Error(`Run ${cli.runId} belongs to agent ${runAgentId}; loaded agent is ${coordinatorSdk.config.agent.id}`);
      }
      const result = await coordinatorSdk.retry(cli.runId);
      if (cli.output === 'json') {
        console.log(JSON.stringify({ command: 'retry', runId: cli.runId, result: summarizeResult(result) }, null, 2));
      } else if (cli.output === 'jsonl') {
        console.log(JSON.stringify({ command: 'retry', runId: cli.runId, result: summarizeResult(result) }));
      } else {
        printResult(result, 'run', resolvedConfig.tui);
        if (cli.events && eventLog.length > 0) console.error(`event log captured: ${eventLog.length}`);
      }
      return isSuccessfulResult(result) ? 0 : 1;
    } finally {
      await coordinatorSdk.close();
    }
  }

  const sessionId = cli.goalArgs[0]!;
  const workerConfigs = await Promise.all(cli.workerCatalogPaths.map((agentConfigPath) => loadFlaggedAgentSdkConfig(sdkOptions, '--worker-catalog', agentConfigPath)));
  const workerIds = workerConfigs.map((config) => config.agent.id);
  const duplicateWorkerId = workerIds.find((id, index) => workerIds.indexOf(id) !== index);
  if (duplicateWorkerId) throw new Error(`retry worker catalog contains duplicate agent id: ${duplicateWorkerId}`);

  const qualitySdk = cli.qualityAgentPath
    ? await createFlaggedAgentSdk({ ...sdkOptions, agentConfigPath: cli.qualityAgentPath, runtime: coordinatorSdk.created.runtime, eventListener }, '--quality-agent', cli.qualityAgentPath)
    : await createAgentSdk({ ...sdkOptions, agentConfig: createSwarmRoleAgentConfig(coordinatorSdk.config.agent, 'quality'), runtime: coordinatorSdk.created.runtime, eventListener });
  const synthesizerSdk = cli.synthesizerAgentPath
    ? await createFlaggedAgentSdk({ ...sdkOptions, agentConfigPath: cli.synthesizerAgentPath, runtime: coordinatorSdk.created.runtime, eventListener }, '--synthesizer-agent', cli.synthesizerAgentPath)
    : await createAgentSdk({ ...sdkOptions, agentConfig: createSwarmRoleAgentConfig(coordinatorSdk.config.agent, 'synthesizer'), runtime: coordinatorSdk.created.runtime, eventListener });
  const workerSdks = await Promise.all(cli.workerCatalogPaths.map((agentConfigPath) => createFlaggedAgentSdk({ ...sdkOptions, agentConfigPath, runtime: coordinatorSdk.created.runtime, eventListener }, '--worker-catalog', agentConfigPath)));

  try {
    const swarm = buildSwarmCoordinator({
      coordinatorSdk,
      workerSdks,
      qualitySdk,
      synthesizerSdk,
      defaultMaxWorkers: cli.maxWorkers,
    });
    const result = await swarm.retrySession({ sessionId, dryRun: cli.dryRun, maxWorkers: cli.maxWorkers });
    if (cli.output === 'json') {
      console.log(JSON.stringify(summarizeSwarmRetry(result), null, 2));
    } else if (cli.output === 'jsonl') {
      console.log(JSON.stringify(summarizeSwarmRetry(result)));
    } else {
      printSwarmRetryResult(result);
      if (cli.events && eventLog.length > 0) console.error(`event log captured: ${eventLog.length}`);
    }
    return result.status === 'succeeded' ? 0 : 1;
  } finally {
    await Promise.allSettled([
      ...workerSdks.map((sdk) => sdk.close()),
      qualitySdk.close(),
      synthesizerSdk.close(),
      coordinatorSdk.close(),
    ]);
  }
}

async function runConfigCommand(cli: ManualTestCliOptions): Promise<number> {
  const resolvedCwd = resolve(cli.cwd ?? process.cwd());
  const resolvedConfig = await loadAgentSdkConfig(buildSdkOptions(cli, resolvedCwd));
  if (cli.output === 'json') {
    console.log(JSON.stringify(resolvedConfig, null, 2));
    return 0;
  }
  console.log(`agent: ${resolvedConfig.agent.id} (${resolvedConfig.agent.name})`);
  console.log(`model: ${resolvedConfig.model.provider}/${resolvedConfig.model.model}`);
  console.log(`runtime: ${resolvedConfig.runtime.mode} (requested ${resolvedConfig.runtime.requestedMode})`);
  console.log(`workspace: ${resolvedConfig.workspaceRoot}`);
  console.log(`shellCwd: ${resolvedConfig.shellCwd}`);
  console.log(`approval: ${resolvedConfig.interaction.approvalMode}`);
  console.log(`clarification: ${resolvedConfig.interaction.clarificationMode}`);
  console.log(`agentSearchDirs: ${resolvedConfig.agents.dirs.join(', ')}`);
  console.log(`tools: ${resolvedConfig.agent.tools.join(', ')}`);
  console.log(`delegates: ${(resolvedConfig.agent.delegates ?? []).join(', ') || '(none)'}`);
  return 0;
}

async function runCatalogCommand(cli: ManualTestCliOptions): Promise<number> {
  const resolvedCwd = resolve(cli.cwd ?? process.cwd());
  const catalog = await inspectAgentSdkCatalog(buildSdkOptions(cli, resolvedCwd));
  const output = summarizeCatalog(catalog);
  if (cli.output === 'json') {
    console.log(JSON.stringify(output, null, 2));
    return 0;
  }
  if (cli.output === 'jsonl') {
    console.log(JSON.stringify(output));
    return 0;
  }

  console.log(renderPrettyString(formatCatalogMarkdown(catalog)));
  return 0;
}

async function runEvalCommand(cli: ManualTestCliOptions): Promise<number> {
  if (!cli.evalInputPath) {
    throw new Error(`eval ${cli.evalDataset ?? 'benchmark'} requires --input <path>`);
  }
  if (!cli.evalOutputPath && (!cli.dryRun || cli.evalResume)) {
    if (cli.dryRun && cli.evalResume) {
      throw new Error(`eval ${cli.evalDataset ?? 'benchmark'} --dry-run --resume requires --out <path>`);
    }
    throw new Error(`eval ${cli.evalDataset ?? 'benchmark'} requires --out <path>`);
  }

  const resolvedCwd = resolve(cli.cwd ?? process.cwd());
  const outputPath = cli.evalOutputPath ? resolve(cli.evalOutputPath) : undefined;
  const artifactsDir = cli.evalArtifactsDir ? resolve(cli.evalArtifactsDir) : undefined;
  const allCases = cli.evalDataset === 'gaia'
    ? await loadGaiaBenchmarkCases(cli.evalInputPath, resolvedCwd, cli.evalFilesDir, cli.evalSplit)
    : await loadBenchmarkCases(cli.evalInputPath, resolvedCwd);
  const completedIds = cli.evalResume && outputPath ? await readCompletedBenchmarkIds(outputPath) : new Set<string>();
  const selectedCases = selectBenchmarkCases(allCases, cli, completedIds);
  const sdkOptions = buildSdkOptions(cli, resolvedCwd);
  const inspection = cli.dryRun ? await inspectAgentSdkResolution(sdkOptions) : undefined;
  const resolvedConfig = inspection?.config ?? await loadAgentSdkConfig(sdkOptions);

  if (cli.output === 'pretty') {
    console.log(`benchmark: ${cli.evalDataset}`);
    console.log(`input: ${resolve(resolvedCwd, cli.evalInputPath)}`);
    if (cli.evalFilesDir) console.log(`files: ${resolve(resolvedCwd, cli.evalFilesDir)}`);
    if (cli.evalType) console.log(`type: ${cli.evalType}`);
    if (outputPath) console.log(`out: ${outputPath}`);
    console.log(`selected: ${selectedCases.length}/${allCases.length}`);
    console.log(`swarm: ${cli.evalSwarm}`);
    console.log(`model: ${resolvedConfig.model.provider}/${resolvedConfig.model.model}`);
    console.log(`runtime: ${resolvedConfig.runtime.mode}`);
    console.log('');
  }

  if (cli.dryRun) {
    printEvalDryRun(cli, inspection!, selectedCases, allCases.length);
    return 0;
  }

  if (cli.evalSwarm > 1) {
    validateEvalSwarmRuntime(resolvedConfig);
  }

  if (!outputPath) {
    throw new Error(`eval ${cli.evalDataset ?? 'benchmark'} requires --out <path>`);
  }
  await mkdir(dirname(outputPath), { recursive: true });
  if (artifactsDir) await mkdir(artifactsDir, { recursive: true });

  const eventLog: Array<Record<string, JsonValue>> = [];
  const lastProgressContentByRun = new Map<string, string>();
  const swarmColors = cli.evalSwarm > 1 && cli.output === 'pretty' ? new RunColorRegistry() : undefined;
  const eventListener = (event: AgentEvent) => {
    const entry = summarizeEvent(event);
    eventLog.push(entry);
    if (swarmColors && cli.progress) {
      printRunBoundaryEvent(event, resolvedConfig.tui, swarmColors, cli.wrapWidth);
    }
    if (cli.events && cli.output === 'pretty') {
      printEvent(entry, resolvedConfig.tui, swarmColors);
    } else if (cli.progress && cli.output === 'pretty') {
      printProgressEvent(event, lastProgressContentByRun, resolvedConfig.tui, cli.showLines, cli.wrapWidth, swarmColors);
    }
  };
  const sdk = await createAgentSdk({
    ...sdkOptions,
    eventListener,
  });
  const orchestrationListener = (event: OrchestrationLifecycleEvent) => {
    const entry = summarizeOrchestrationLifecycleEvent(event);
    eventLog.push(entry);
    if ((cli.events || cli.progress) && cli.output === 'pretty') {
      printOrchestrationLifecycleEvent(event, resolvedConfig.tui);
    }
  };
  const orchestrationSdk = cli.orchestrate
    ? await createOrchestrationSdk({
        ...sdkOptions,
        requestedAgentConfig: sdk.config.agent,
        agentCatalogPaths: cli.agentCatalogPaths,
        runtime: sdk.created.runtime,
        eventListener,
        orchestrationListener,
      })
    : undefined;

  let failed = 0;
  let completed = 0;
  let processed = 0;
  const removeProcessErrorGuard = installEvalProcessErrorGuard();
  try {
    for (let batchStart = 0; batchStart < selectedCases.length; batchStart += cli.evalSwarm) {
      const batch = selectedCases.slice(batchStart, batchStart + cli.evalSwarm);
      const records = await Promise.all(batch.map((benchmarkCase) => runBenchmarkCase({
        sdk,
        benchmarkCase,
        resolvedConfig,
        outputPath,
        artifactsDir,
        eventLog,
        orchestrationSdk,
        includeEventArtifacts: cli.evalSwarm === 1,
      })));

      for (const [batchIndex, record] of records.entries()) {
        await appendJsonLine(outputPath, record as unknown as JsonValue);
        printEvalRecord(record, batchStart + batchIndex, cli, swarmColors);
        processed += 1;
        if (record.status === 'completed') {
          completed += 1;
        } else {
          failed += 1;
        }
      }

      if (cli.evalFailFast && records.some((record) => record.status !== 'completed')) {
        break;
      }
    }
  } finally {
    removeProcessErrorGuard();
    await orchestrationSdk?.close();
    await sdk.close();
  }

  if (cli.output === 'pretty') {
    console.log('');
    console.log(`completed: ${completed}`);
    console.log(`failed: ${failed}`);
    if (processed < selectedCases.length) console.log(`skipped: ${selectedCases.length - processed}`);
  }
  return failed === 0 ? 0 : 1;
}

export function parseCliArgs(argv: string[]): ManualTestCliOptions {
  const options: ManualTestCliOptions = {
    command: 'spec',
    specPath: '',
    goalArgs: [],
    imagePaths: [],
    audioPaths: [],
    fileAttachmentPaths: [],
    orchestrate: false,
    agentCatalogPaths: [],
    workerCatalogPaths: [],
    evalResume: false,
    evalFailFast: false,
    evalSwarm: 1,
    evalOffset: 0,
    minimal: false,
    bundles: [],
    installAgents: [],
    installSkills: [],
    installManifests: [],
    yes: false,
    force: false,
    network: false,
    providerCheck: false,
    strict: false,
    updateCheck: false,
    updateChannel: 'stable',
    progress: false,
    events: false,
    inspect: false,
    showLines: 3,
    dryRun: false,
    output: 'pretty',
    help: false,
  };

  let commandSeen = false;
  let swarmSpecified = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!commandSeen && (arg === 'run' || arg === 'chat' || arg === 'spec' || arg === 'config' || arg === 'catalog' || arg === 'eval' || arg === 'swarm-run' || arg === 'retry' || arg === 'init' || arg === 'doctor' || arg === 'update' || arg === 'uninstall' || arg === 'agent-create')) {
      options.command = arg;
      commandSeen = true;
      if (arg === 'spec' && argv[index + 1] && !argv[index + 1].startsWith('--')) {
        options.specPath = argv[++index];
      }
      if (arg === 'eval' && argv[index + 1] && !argv[index + 1].startsWith('--')) {
        options.evalDataset = parseEnumOption(arg, argv[++index], ['cases', 'gaia']);
      }
      continue;
    }

    switch (arg) {
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--version':
        if (options.command === 'update') {
          options.updateVersion = requireOptionValue(arg, argv[++index]);
          break;
        }
        options.command = 'version';
        break;
      case '--check':
        options.updateCheck = true;
        break;
      case '--events':
        options.events = true;
        break;
      case '--progress':
        options.progress = true;
        break;
      case '--inspect':
        options.inspect = true;
        break;
      case '--show-lines':
        options.showLines = parsePositiveIntegerOption(arg, requireOptionValue(arg, argv[++index]));
        break;
      case '--wrap-width':
        options.wrapWidth = parsePositiveIntegerOption(arg, requireOptionValue(arg, argv[++index]));
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--yes':
        options.yes = true;
        break;
      case '--force':
        options.force = true;
        break;
      case '--network':
        options.network = true;
        break;
      case '--provider-check':
        options.providerCheck = true;
        options.network = true;
        break;
      case '--strict':
        options.strict = true;
        break;
      case '--channel':
        options.updateChannel = parseEnumOption(arg, requireOptionValue(arg, argv[++index]), ['stable', 'preview']);
        break;
      case '--repo':
        options.updateRepo = requireOptionValue(arg, argv[++index]);
        break;
      case '--base-url':
        options.updateBaseUrl = requireOptionValue(arg, argv[++index]);
        break;
      case '--spec':
        options.specPath = requireOptionValue(arg, argv[++index]);
        options.command = 'spec';
        break;
      case '--file':
        options.promptFilePath = requireOptionValue(arg, argv[++index]);
        break;
      case '--input-json':
        options.inputJson = parseJsonFlag(requireOptionValue(arg, argv[++index]), arg);
        break;
      case '--input':
        options.evalInputPath = requireOptionValue(arg, argv[++index]);
        break;
      case '--files-dir':
        options.evalFilesDir = requireOptionValue(arg, argv[++index]);
        break;
      case '--out':
        options.evalOutputPath = requireOptionValue(arg, argv[++index]);
        break;
      case '--artifacts':
        options.evalArtifactsDir = requireOptionValue(arg, argv[++index]);
        break;
      case '--resume':
        options.evalResume = true;
        break;
      case '--fail-fast':
        options.evalFailFast = true;
        break;
      case '--swarm':
        options.evalSwarm = parsePositiveIntegerOption(arg, requireOptionValue(arg, argv[++index]));
        swarmSpecified = true;
        break;
      case '--limit':
        options.evalLimit = parsePositiveIntegerOption(arg, requireOptionValue(arg, argv[++index]));
        break;
      case '--offset':
        options.evalOffset = parseNonNegativeIntegerOption(arg, requireOptionValue(arg, argv[++index]));
        break;
      case '--ids':
        options.evalIds = requireOptionValue(arg, argv[++index]).split(',').map((id) => id.trim()).filter(Boolean);
        break;
      case '--level':
        options.evalLevel = requireOptionValue(arg, argv[++index]);
        break;
      case '--split':
        options.evalSplit = requireOptionValue(arg, argv[++index]);
        break;
      case '--type':
        options.evalType = parseEnumOption(arg, requireOptionValue(arg, argv[++index]), BENCHMARK_ATTACHMENT_TYPES);
        break;
      case '--image':
        options.imagePaths.push(requireOptionValue(arg, argv[++index]));
        break;
      case '--audio':
        options.audioPaths.push(requireOptionValue(arg, argv[++index]));
        break;
      case '--file-attachment':
        options.fileAttachmentPaths.push(requireOptionValue(arg, argv[++index]));
        break;
      case '--orchestrate':
        options.orchestrate = true;
        break;
      case '--catalog':
        options.agentCatalogPaths.push(requireOptionValue(arg, argv[++index]));
        break;
      case '--worker-catalog':
        options.workerCatalogPaths.push(...requireOptionValue(arg, argv[++index]).split(',').map((path) => path.trim()).filter(Boolean));
        break;
      case '--quality-agent':
        options.qualityAgentPath = requireOptionValue(arg, argv[++index]);
        break;
      case '--synthesizer-agent':
        options.synthesizerAgentPath = requireOptionValue(arg, argv[++index]);
        break;
      case '--max-workers':
        options.maxWorkers = parsePositiveIntegerOption(arg, requireOptionValue(arg, argv[++index]));
        break;
      case '--session-id':
        options.sessionId = requireOptionValue(arg, argv[++index]);
        break;
      case '--run-id':
        options.runId = requireOptionValue(arg, argv[++index]);
        break;
      case '--mode':
        options.mode = parseEnumOption(arg, requireOptionValue(arg, argv[++index]), ['chat', 'run']);
        break;
      case '--cwd':
        options.cwd = requireOptionValue(arg, argv[++index]);
        break;
      case '--agent':
        options.agentConfigPath = requireOptionValue(arg, argv[++index]);
        break;
      case '--generator-agent':
        options.generatorAgentPath = requireOptionValue(arg, argv[++index]);
        break;
      case '--id':
        options.agentCreateId = requireOptionValue(arg, argv[++index]);
        break;
      case '--settings':
        options.settingsConfigPath = requireOptionValue(arg, argv[++index]);
        break;
      case '--runtime':
        options.runtimeMode = parseEnumOption(arg, requireOptionValue(arg, argv[++index]), ['memory', 'postgres']);
        break;
      case '--provider':
        options.provider = parseEnumOption(arg, requireOptionValue(arg, argv[++index]), ['openrouter', 'ollama', 'mistral', 'mesh']);
        break;
      case '--model':
        options.model = requireOptionValue(arg, argv[++index]);
        break;
      case '--api-key-env':
        options.apiKeyEnv = requireOptionValue(arg, argv[++index]);
        break;
      case '--profile':
        options.profile = parseEnumOption(arg, requireOptionValue(arg, argv[++index]), ['safe', 'coding']);
        break;
      case '--minimal':
        options.minimal = true;
        break;
      case '--bundle':
        options.bundles.push(requireOptionValue(arg, argv[++index]));
        break;
      case '--install-agent':
        options.installAgents.push(requireOptionValue(arg, argv[++index]));
        break;
      case '--install-skill':
        options.installSkills.push(requireOptionValue(arg, argv[++index]));
        break;
      case '--install-manifest':
        options.installManifests.push(requireOptionValue(arg, argv[++index]));
        break;
      case '--approval':
        options.approvalMode = parseEnumOption(arg, requireOptionValue(arg, argv[++index]), ['auto', 'manual', 'reject']);
        break;
      case '--clarification':
        options.clarificationMode = parseEnumOption(arg, requireOptionValue(arg, argv[++index]), ['interactive', 'fail']);
        break;
      case '--output':
        options.output = parseEnumOption(arg, requireOptionValue(arg, argv[++index]), ['pretty', 'json', 'jsonl']);
        break;
      default:
        if (options.command === 'run' || options.command === 'chat' || options.command === 'swarm-run' || options.command === 'retry' || options.command === 'agent-create') {
          options.goalArgs.push(arg);
          break;
        }
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.help && options.command === 'spec' && !options.specPath) {
    throw new Error('Missing required --spec <path> argument');
  }

  if (!options.help && options.command === 'eval' && !options.evalDataset) {
    throw new Error('Missing eval dataset. Expected `adaptive-agent eval cases` or `adaptive-agent eval gaia`.');
  }

  if (!options.help && options.command !== 'agent-create' && options.generatorAgentPath) {
    throw new Error('--generator-agent is supported for agent-create requests');
  }

  if (!options.help && options.command !== 'agent-create' && options.agentCreateId) {
    throw new Error('--id is supported for agent-create requests');
  }

  if (!options.help && options.command !== 'init') {
    if (options.minimal) throw new Error('--minimal is supported for init requests');
    if (options.bundles.length > 0) throw new Error('--bundle is supported for init requests');
    if (options.installAgents.length > 0) throw new Error('--install-agent is supported for init requests');
    if (options.installSkills.length > 0) throw new Error('--install-skill is supported for init requests');
    if (options.installManifests.length > 0) throw new Error('--install-manifest is supported for init requests');
  }

  if (!options.help && options.command === 'init' && options.minimal && options.bundles.length > 0) {
    throw new Error('init accepts --minimal or --bundle <name>, but not both');
  }

  if (!options.help && options.command === 'agent-create') {
    if (options.agentConfigPath) {
      throw new Error('agent-create uses --generator-agent <path-or-name>; --agent is not supported for this command');
    }
    if (options.promptFilePath && options.goalArgs.length > 0) {
      throw new Error('agent-create accepts positional description text or --file <path>, but not both');
    }
    if (options.orchestrate) {
      throw new Error('--orchestrate is not supported for agent-create requests');
    }
    if (options.imagePaths.length > 0 || options.audioPaths.length > 0 || options.fileAttachmentPaths.length > 0) {
      throw new Error('--image, --audio, and --file-attachment are not supported for agent-create requests');
    }
    if (options.inputJson !== undefined) {
      throw new Error('--input-json is not supported for agent-create requests');
    }
  }

  if (!options.help && swarmSpecified && options.command !== 'eval') {
    throw new Error('--swarm is supported for eval requests, not other command requests');
  }

  if (!options.help && options.command === 'swarm-run') {
    if (!options.agentConfigPath) {
      throw new Error('swarm-run requires --agent <path-or-name> for the coordinator agent');
    }
    if (options.workerCatalogPaths.length === 0) {
      throw new Error('swarm-run requires --worker-catalog <path-or-name,...>');
    }
    if (options.promptFilePath && options.goalArgs.length > 0) {
      throw new Error('swarm-run accepts positional task text or --file <path>, but not both');
    }
    if (!options.promptFilePath && options.goalArgs.length === 0) {
      throw new Error('swarm-run requires positional task text or --file <path>');
    }
    if (options.orchestrate) {
      throw new Error('--orchestrate is not used with swarm-run; swarm-run already uses coordinated decomposition');
    }
  }

  if (!options.help && options.command === 'retry') {
    if (options.runId) {
      if (options.goalArgs.length > 0) {
        throw new Error('retry accepts --run-id <runId> or one positional <sessionId>, but not both');
      }
    } else {
      if (options.goalArgs.length !== 1 || !options.goalArgs[0]?.trim()) {
        throw new Error('retry requires --run-id <runId> or exactly one positional <sessionId>');
      }
      if (!options.agentConfigPath) {
        throw new Error('retry <sessionId> requires --agent <path-or-name> for the coordinator agent');
      }
      if (options.workerCatalogPaths.length === 0) {
        throw new Error('retry <sessionId> requires --worker-catalog <path-or-name,...>');
      }
    }
  }

  if (!options.help && options.command === 'chat' && options.imagePaths.length > 0) {
    throw new Error('--image is supported for run requests, not chat requests');
  }

  if (!options.help && options.command === 'chat' && options.audioPaths.length > 0) {
    throw new Error('--audio is supported for run requests, not chat requests');
  }

  if (!options.help && options.command === 'chat' && options.fileAttachmentPaths.length > 0) {
    throw new Error('--file-attachment is supported for run requests, not chat requests');
  }

  if (!options.help && options.command === 'chat' && options.inputJson !== undefined) {
    throw new Error('--input-json is supported for run requests, not chat requests');
  }

  if (!options.help && options.command === 'chat' && options.orchestrate) {
    throw new Error('--orchestrate is supported for run requests, not chat requests');
  }

  return options;
}

export async function loadManualTestSpec(specPath: string, modeOverride?: 'chat' | 'run'): Promise<ManualTestSpec> {
  const raw = await readSpecJson(specPath);
  const mode = modeOverride ?? readMode(raw);
  if (mode === 'chat') {
    return parseManualChatSpec(raw, specPath);
  }
  return parseManualRunSpec(raw, specPath);
}

export function collectProviderWarnings(spec: ManualTestSpec, provider: 'openrouter' | 'ollama' | 'mistral' | 'mesh'): string[] {
  const parts = collectContentParts(spec);
  const capabilities = PROVIDER_INPUT_CAPABILITIES[provider];
  const warnings: string[] = [];

  for (const part of parts) {
    if (part.type === 'text') continue;
    const supportedSources = capabilities[part.type];
    if (!supportedSources) {
      warnings.push(`Provider "${provider}" does not declare ${part.type} input support; this request will likely fail.`);
      continue;
    }

    const sourceKind = part.type === 'image'
      ? 'path'
      : part.type === 'file'
        ? part.file.source.kind
        : part.audio.source.kind;
    if (!supportedSources.includes(sourceKind)) {
      warnings.push(`Provider "${provider}" does not support ${part.type} source "${sourceKind}" in the current adapter; this request will likely fail.`);
    }
  }

  return warnings;
}

function buildSdkOptions(cli: ManualTestCliOptions, cwd: string) {
  return {
    cwd,
    agentConfigPath: cli.agentConfigPath,
    settingsConfigPath: cli.settingsConfigPath,
    runtimeMode: cli.runtimeMode,
    model: cli.provider || cli.model ? { ...(cli.provider ? { provider: cli.provider } : {}), ...(cli.model ? { model: cli.model } : {}) } : undefined,
    settingsConfig: cli.approvalMode || cli.clarificationMode
      ? {
          interaction: {
            ...(cli.approvalMode ? { approvalMode: cli.approvalMode } : {}),
            ...(cli.clarificationMode ? { clarificationMode: cli.clarificationMode } : {}),
          },
        }
      : undefined,
  };
}

function buildChatOptions(spec: ManualChatSpec): AgentSdkChatOptions {
  return {
    context: spec.context,
    outputSchema: spec.outputSchema,
    metadata: spec.metadata,
  };
}

function buildRunOptions(spec: ManualRunSpec): AgentSdkRunOptions {
  return {
    input: spec.input,
    images: spec.images,
    contentParts: spec.contentParts,
    context: spec.context,
    outputSchema: spec.outputSchema,
    metadata: spec.metadata,
  };
}

function buildInlineContentParts(cli: ManualTestCliOptions, cwd: string): ModelContentPart[] {
  return [
    ...cli.fileAttachmentPaths.map((path) => ({
      type: 'file' as const,
      file: { source: { kind: 'path' as const, path: resolveAssetPath(path, cwd) } },
    })),
    ...cli.audioPaths.map((path) => ({
      type: 'audio' as const,
      audio: { source: { kind: 'path' as const, path: resolveAssetPath(path, cwd) }, format: inferAudioFormat(path) },
    })),
  ];
}

function inferAudioFormat(path: string): Extract<ModelContentPart, { type: 'audio' }>['audio']['format'] {
  switch (extname(path).toLowerCase()) {
    case '.wav': return 'wav';
    case '.mp3': return 'mp3';
    case '.flac': return 'flac';
    case '.m4a': return 'm4a';
    case '.ogg': return 'ogg';
    case '.aac': return 'aac';
    case '.aiff':
    case '.aif': return 'aiff';
    default: return 'mp3';
  }
}

async function readSpecJson(specPath: string): Promise<JsonObject> {
  const content = await readFile(specPath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Spec file ${specPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return ensureObject(parsed, `Spec file ${specPath}`);
}

function readMode(raw: JsonObject): 'chat' | 'run' {
  const mode = raw.mode;
  if (mode !== 'chat' && mode !== 'run') {
    throw new Error('Spec file must include "mode": "chat" or "mode": "run"');
  }
  return mode;
}

function parseManualChatSpec(raw: JsonObject, specPath: string): ManualChatSpec {
  const messagesValue = raw.messages;
  if (!Array.isArray(messagesValue) || messagesValue.length === 0) {
    throw new Error('Chat spec requires a non-empty "messages" array');
  }

  const baseDir = dirname(specPath);
  const messages = messagesValue.map((value, index) => parseChatMessage(value, baseDir, `messages[${index}]`));
  return {
    mode: 'chat',
    messages,
    context: parseOptionalRecord(raw.context, 'context'),
    outputSchema: parseOptionalSchema(raw.outputSchema),
    metadata: parseOptionalRecord(raw.metadata, 'metadata'),
  };
}

function parseManualRunSpec(raw: JsonObject, specPath: string): ManualRunSpec {
  const goal = requireString(raw.goal, 'goal');
  const baseDir = dirname(specPath);
  const images = parseOptionalImageArray(raw.images, baseDir, 'images');
  const contentParts = parseOptionalContentPartArray(raw.contentParts, baseDir, 'contentParts');
  if (images && contentParts?.some((part) => part.type === 'image')) {
    throw new Error('Run spec must not include both "images" and image entries in "contentParts"');
  }

  return {
    mode: 'run',
    goal,
    ...(raw.input === undefined ? {} : { input: raw.input as JsonValue }),
    ...(images ? { images } : {}),
    ...(contentParts ? { contentParts } : {}),
    context: parseOptionalRecord(raw.context, 'context'),
    outputSchema: parseOptionalSchema(raw.outputSchema),
    metadata: parseOptionalRecord(raw.metadata, 'metadata'),
  };
}

function parseChatMessage(value: unknown, baseDir: string, label: string): ChatMessage {
  const raw = ensureObject(value, label);
  const role = parseEnumField(raw.role, `${label}.role`, ['system', 'user', 'assistant']);
  const content = parseMessageContent(raw.content, baseDir, `${label}.content`);
  const images = parseOptionalImageArray(raw.images, baseDir, `${label}.images`);
  if (Array.isArray(content) && images && images.length > 0) {
    throw new Error(`${label}.images is allowed only when ${label}.content is a string`);
  }
  return {
    role,
    content,
    ...(images ? { images } : {}),
  };
}

function parseMessageContent(value: unknown, baseDir: string, label: string): string | ModelContentPart[] {
  if (typeof value === 'string') {
    return value;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be a string or an array of content parts`);
  }
  return value.map((part, index) => parseContentPart(part, baseDir, `${label}[${index}]`));
}

function parseOptionalContentPartArray(value: unknown, baseDir: string, label: string): ModelContentPart[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value.map((part, index) => parseContentPart(part, baseDir, `${label}[${index}]`));
}

function parseContentPart(value: unknown, baseDir: string, label: string): ModelContentPart {
  const raw = ensureObject(value, label);
  const type = parseEnumField(raw.type, `${label}.type`, ['text', 'image', 'file', 'audio']);
  switch (type) {
    case 'text':
      return { type, text: requireString(raw.text, `${label}.text`) };
    case 'image':
      return { type, image: parseImageInput(raw.image, baseDir, `${label}.image`) };
    case 'file':
      return { type, file: parseFileInput(raw.file, baseDir, `${label}.file`) };
    case 'audio':
      return { type, audio: parseAudioInput(raw.audio, baseDir, `${label}.audio`) };
  }
}

function parseOptionalImageArray(value: unknown, baseDir: string, label: string): ImageInput[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value.map((entry, index) => parseImageInput(entry, baseDir, `${label}[${index}]`));
}

function parseImageInput(value: unknown, baseDir: string, label: string): ImageInput {
  const raw = ensureObject(value, label);
  const path = resolveAssetPath(requireString(raw.path, `${label}.path`), baseDir);
  return {
    path,
    ...(raw.mimeType === undefined ? {} : { mimeType: requireString(raw.mimeType, `${label}.mimeType`) }),
    ...(raw.detail === undefined ? {} : { detail: parseEnumField(raw.detail, `${label}.detail`, ['auto', 'low', 'high']) }),
    ...(raw.name === undefined ? {} : { name: requireString(raw.name, `${label}.name`) }),
  };
}

function parseFileInput(value: unknown, baseDir: string, label: string): Extract<ModelContentPart, { type: 'file' }>['file'] {
  const raw = ensureObject(value, label);
  const source = ensureObject(raw.source, `${label}.source`);
  const kind = parseEnumField(source.kind, `${label}.source.kind`, ['path', 'url', 'file_id']);
  return {
    source: kind === 'path'
      ? { kind, path: resolveAssetPath(requireString(source.path, `${label}.source.path`), baseDir) }
      : kind === 'url'
        ? { kind, url: requireString(source.url, `${label}.source.url`) }
        : { kind, fileId: requireString(source.fileId, `${label}.source.fileId`) },
    ...(raw.mimeType === undefined ? {} : { mimeType: requireString(raw.mimeType, `${label}.mimeType`) }),
    ...(raw.name === undefined ? {} : { name: requireString(raw.name, `${label}.name`) }),
  };
}

function parseAudioInput(value: unknown, baseDir: string, label: string): Extract<ModelContentPart, { type: 'audio' }>['audio'] {
  const raw = ensureObject(value, label);
  const source = ensureObject(raw.source, `${label}.source`);
  const kind = parseEnumField(source.kind, `${label}.source.kind`, ['path', 'url', 'data', 'file_id']);
  const format = parseEnumField(raw.format, `${label}.format`, ['wav', 'mp3', 'flac', 'm4a', 'ogg', 'aac', 'aiff', 'pcm16', 'pcm24']);
  return {
    source: kind === 'path'
      ? { kind, path: resolveAssetPath(requireString(source.path, `${label}.source.path`), baseDir) }
      : kind === 'url'
        ? { kind, url: requireString(source.url, `${label}.source.url`) }
        : kind === 'data'
          ? { kind, data: requireString(source.data, `${label}.source.data`) }
          : { kind, fileId: requireString(source.fileId, `${label}.source.fileId`) },
    format,
    ...(raw.mimeType === undefined ? {} : { mimeType: requireString(raw.mimeType, `${label}.mimeType`) }),
    ...(raw.name === undefined ? {} : { name: requireString(raw.name, `${label}.name`) }),
  };
}

function parseOptionalRecord(value: unknown, label: string): Record<string, JsonValue> | undefined {
  if (value === undefined) {
    return undefined;
  }
  return ensureObject(value, label) as Record<string, JsonValue>;
}

function parseOptionalSchema(value: unknown): JsonSchema | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('outputSchema must be an object');
  }
  return value as JsonSchema;
}

function ensureObject(value: unknown, label: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function parseEnumField<const T extends string>(value: unknown, label: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${label} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function parseEnumOption<const T extends string>(flag: string, value: string, allowed: readonly T[]): T {
  if (!allowed.includes(value as T)) {
    throw new Error(`${flag} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function parsePositiveIntegerOption(flag: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeIntegerOption(flag: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  return parsed;
}

function requireOptionValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parseJsonFlag(value: string, flag: string): JsonValue {
  try {
    return JSON.parse(value) as JsonValue;
  } catch (error) {
    throw new Error(`${flag} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readInlinePrompt(cli: ManualTestCliOptions, label: string): Promise<string> {
  if (cli.promptFilePath) {
    const prompt = await readFile(resolve(cli.promptFilePath), 'utf-8');
    if (prompt.trim().length === 0) {
      throw new Error(`Prompt file for ${label} is empty: ${cli.promptFilePath}`);
    }
    return prompt;
  }

  const prompt = cli.goalArgs.join(' ').trim();
  if (prompt.length > 0) {
    return prompt;
  }

  if (!process.stdin.isTTY) {
    const stdinText = await Bun.stdin.text();
    if (stdinText.trim().length > 0) {
      return stdinText;
    }
  }

  throw new Error(`Missing ${label}; provide positional text, --file <path>, or stdin.`);
}

function resolveAssetPath(inputPath: string, baseDir: string): string {
  return resolve(baseDir, inputPath);
}

export async function loadBenchmarkCases(inputPath: string, cwd = process.cwd()): Promise<BenchmarkCase[]> {
  const resolvedInputPath = resolve(cwd, inputPath);
  const baseDir = dirname(resolvedInputPath);
  const content = await readFile(resolvedInputPath, 'utf-8');
  const trimmed = content.trim();
  if (!trimmed) return [];

  let rawCases: unknown[];
  if (trimmed.startsWith('[')) {
    rawCases = JSON.parse(trimmed) as unknown[];
  } else if (trimmed.startsWith('{')) {
    try {
      rawCases = [JSON.parse(trimmed) as unknown];
    } catch {
      rawCases = parseBenchmarkJsonLines(trimmed);
    }
  } else {
    rawCases = parseBenchmarkJsonLines(trimmed);
  }

  if (!Array.isArray(rawCases)) {
    throw new Error('Benchmark input must be a JSON array, JSON object, or JSONL records');
  }
  return rawCases.map((value, index) => parseBenchmarkCase(value, baseDir, `case[${index}]`));
}

export async function loadGaiaBenchmarkCases(
  inputPath: string,
  cwd = process.cwd(),
  filesDir?: string,
  split?: string,
): Promise<BenchmarkCase[]> {
  const resolvedInputPath = resolve(cwd, inputPath);
  const baseDir = filesDir ? resolve(cwd, filesDir) : dirname(resolvedInputPath);
  const rawRows = await loadBenchmarkRawRecords(resolvedInputPath);
  return rawRows.map((value, index) => parseGaiaBenchmarkCase(value, baseDir, split, `gaia[${index}]`));
}

async function loadBenchmarkRawRecords(inputPath: string): Promise<unknown[]> {
  const content = await readFile(inputPath, 'utf-8');
  const trimmed = content.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) return JSON.parse(trimmed) as unknown[];
  if (trimmed.startsWith('{')) {
    try {
      return [JSON.parse(trimmed) as unknown];
    } catch {
      return parseBenchmarkJsonLines(trimmed);
    }
  }
  return parseBenchmarkJsonLines(trimmed);
}

function parseGaiaBenchmarkCase(value: unknown, baseDir: string, split: string | undefined, label: string): BenchmarkCase {
  const raw = ensureObject(value, label);
  const id = requireString(raw.task_id ?? raw.taskId ?? raw.id, `${label}.task_id`);
  const question = requireString(raw.Question ?? raw.question, `${label}.Question`);
  const fileName = readOptionalString(raw.file_name ?? raw.fileName ?? raw.file, `${label}.file_name`);
  const level = readOptionalString(raw.Level ?? raw.level, `${label}.Level`);
  const expectedAnswer = readOptionalString(raw['Final answer'] ?? raw.final_answer ?? raw.expectedAnswer ?? raw.answer, `${label}.Final answer`);
  const attachment = fileName ? gaiaAttachmentForFile(resolve(baseDir, fileName), fileName) : undefined;
  return {
    id,
    dataset: 'gaia',
    ...(split ? { split } : {}),
    ...(level ? { level } : {}),
    question,
    ...(attachment?.kind === 'image' ? { images: [{ path: attachment.path, name: fileName }] } : {}),
    ...(attachment?.kind === 'audio'
      ? { contentParts: [{ type: 'audio' as const, audio: { source: { kind: 'path' as const, path: attachment.path }, format: attachment.format, name: fileName } }] }
      : {}),
    ...(attachment?.kind === 'file' ? { contentParts: [{ type: 'file', file: { source: { kind: 'path', path: attachment.path }, name: fileName } }] } : {}),
    ...(expectedAnswer ? { expectedAnswer } : {}),
    metadata: {
      source: 'gaia',
      ...(fileName ? { fileName } : {}),
      ...(level ? { level } : {}),
      ...(split ? { split } : {}),
    },
  };
}

function readOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  return value;
}

function gaiaAttachmentForFile(path: string, name: string): GaiaAttachment {
  if (isImageFileName(name)) return { kind: 'image', path };
  const audioFormat = inferAudioFormatFromFileName(name);
  if (audioFormat) return { kind: 'audio', path, format: audioFormat };
  return { kind: 'file', path };
}

function isImageFileName(name: string): boolean {
  return hasFileExtension(name, IMAGE_FILE_EXTENSIONS);
}

function inferAudioFormatFromFileName(name: string): Extract<ModelContentPart, { type: 'audio' }>['audio']['format'] | undefined {
  switch (extname(name).toLowerCase()) {
    case '.wav': return 'wav';
    case '.mp3': return 'mp3';
    case '.flac': return 'flac';
    case '.m4a': return 'm4a';
    case '.ogg': return 'ogg';
    case '.aac': return 'aac';
    case '.aiff':
    case '.aif': return 'aiff';
    default: return undefined;
  }
}

function benchmarkCaseHasAttachmentType(benchmarkCase: BenchmarkCase, type: BenchmarkAttachmentType): boolean {
  if (type === 'image' && (benchmarkCase.images?.length ?? 0) > 0) {
    return true;
  }

  for (const part of benchmarkCase.contentParts ?? []) {
    if (part.type === 'image' && type === 'image') return true;
    if (part.type === 'audio' && type === 'audio') return true;
    if (part.type === 'file' && inferFileAttachmentType(part.file) === type) return true;
  }

  return false;
}

export function summarizeGaiaDryRunTasks(cases: BenchmarkCase[]): GaiaDryRunTaskSummary[] {
  return cases.map((benchmarkCase) => {
    const attachment = summarizeBenchmarkCaseAttachment(benchmarkCase);
    return {
      taskId: benchmarkCase.id,
      attachmentType: attachment.type,
      ...(attachment.fileName ? { fileName: attachment.fileName } : {}),
      ...(attachment.path ? { path: attachment.path } : {}),
      ...(benchmarkCase.level ? { level: benchmarkCase.level } : {}),
      ...(benchmarkCase.split ? { split: benchmarkCase.split } : {}),
    };
  });
}

function summarizeBenchmarkCaseAttachment(
  benchmarkCase: BenchmarkCase,
): { type: BenchmarkDryRunAttachmentType; fileName?: string; path?: string } {
  const image = benchmarkCase.images?.[0];
  if (image) {
    return {
      type: 'image',
      ...(image.name ? { fileName: image.name } : {}),
      path: image.path,
    };
  }

  for (const part of benchmarkCase.contentParts ?? []) {
    if (part.type === 'image') {
      return {
        type: 'image',
        ...(part.image.name ? { fileName: part.image.name } : {}),
        path: part.image.path,
      };
    }
    if (part.type === 'audio') {
      const path = pathFromAudioInputSource(part.audio.source);
      return {
        type: 'audio',
        ...(part.audio.name ? { fileName: part.audio.name } : {}),
        ...(path ? { path } : {}),
      };
    }
    if (part.type === 'file') {
      const path = pathFromFileInputSource(part.file.source);
      return {
        type: inferFileAttachmentType(part.file),
        ...(part.file.name ? { fileName: part.file.name } : {}),
        ...(path ? { path } : {}),
      };
    }
  }

  return { type: 'none' };
}

function inferFileAttachmentType(file: Extract<ModelContentPart, { type: 'file' }>['file']): BenchmarkAttachmentType {
  return inferAttachmentType(file.mimeType, file.name ?? nameFromFileInputSource(file.source));
}

function inferAttachmentType(mimeType: string | undefined, name: string | undefined): BenchmarkAttachmentType {
  const normalizedMimeType = mimeType?.split(';', 1)[0]?.trim().toLowerCase();
  if (normalizedMimeType?.startsWith('image/')) return 'image';
  if (normalizedMimeType?.startsWith('audio/')) return 'audio';
  if (normalizedMimeType?.startsWith('video/')) return 'video';

  if (name) {
    if (hasFileExtension(name, IMAGE_FILE_EXTENSIONS)) return 'image';
    if (hasFileExtension(name, AUDIO_FILE_EXTENSIONS)) return 'audio';
    if (hasFileExtension(name, VIDEO_FILE_EXTENSIONS)) return 'video';
  }

  return 'other';
}

function nameFromFileInputSource(source: Extract<ModelContentPart, { type: 'file' }>['file']['source']): string | undefined {
  return pathFromFileInputSource(source);
}

function pathFromFileInputSource(source: Extract<ModelContentPart, { type: 'file' }>['file']['source']): string | undefined {
  if (source.kind === 'path') return source.path;
  if (source.kind === 'url') {
    try {
      return new URL(source.url).pathname;
    } catch {
      return source.url;
    }
  }
  return undefined;
}

function pathFromAudioInputSource(source: Extract<ModelContentPart, { type: 'audio' }>['audio']['source']): string | undefined {
  if (source.kind === 'path') return source.path;
  if (source.kind === 'url') {
    try {
      return new URL(source.url).pathname;
    } catch {
      return source.url;
    }
  }
  return undefined;
}

function hasFileExtension(name: string, extensions: ReadonlySet<string>): boolean {
  return extensions.has(extname(name).toLowerCase());
}

function parseBenchmarkJsonLines(content: string): unknown[] {
  return content.split(/\r?\n/).filter((line) => line.trim().length > 0).map((line, index) => {
        try {
          return JSON.parse(line) as unknown;
        } catch (error) {
          throw new Error(`Invalid benchmark JSONL at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
}

function parseBenchmarkCase(value: unknown, baseDir: string, label: string): BenchmarkCase {
  const raw = ensureObject(value, label);
  const id = requireString(raw.id ?? raw.taskId ?? raw.task_id, `${label}.id`);
  const question = requireString(raw.question, `${label}.question`);
  const images = parseOptionalImageArray(raw.images, baseDir, `${label}.images`);
  const contentParts = parseOptionalContentPartArray(raw.contentParts, baseDir, `${label}.contentParts`);
  if (images && contentParts?.some((part) => part.type === 'image')) {
    throw new Error(`${label} must not include both images and image content parts`);
  }
  return {
    id,
    ...(raw.dataset === undefined ? {} : { dataset: requireString(raw.dataset, `${label}.dataset`) }),
    ...(raw.split === undefined ? {} : { split: requireString(raw.split, `${label}.split`) }),
    ...(raw.level === undefined ? {} : { level: requireString(raw.level, `${label}.level`) }),
    question,
    ...(raw.input === undefined ? {} : { input: raw.input as JsonValue }),
    ...(images ? { images } : {}),
    ...(contentParts ? { contentParts } : {}),
    ...(raw.expectedAnswer === undefined ? {} : { expectedAnswer: requireString(raw.expectedAnswer, `${label}.expectedAnswer`) }),
    ...(raw.metadata === undefined ? {} : { metadata: parseOptionalRecord(raw.metadata, `${label}.metadata`) }),
  };
}

async function readCompletedBenchmarkIds(outputPath: string): Promise<Set<string>> {
  const completed = new Set<string>();
  let content = '';
  try {
    content = await readFile(outputPath, 'utf-8');
  } catch {
    return completed;
  }
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      const record = ensureObject(JSON.parse(line) as unknown, `result[${index}]`);
      if (record.status === 'completed' && typeof record.taskId === 'string') {
        completed.add(record.taskId);
      }
    } catch {
      // Ignore malformed historical result lines so a partially written file does not block resume.
    }
  }
  return completed;
}

export function selectBenchmarkCases(cases: BenchmarkCase[], cli: ManualTestCliOptions, completedIds: Set<string>): BenchmarkCase[] {
  const allowedIds = cli.evalIds ? new Set(cli.evalIds) : undefined;
  let selected = cases.slice(cli.evalOffset).filter((benchmarkCase) => {
    if (allowedIds && !allowedIds.has(benchmarkCase.id)) return false;
    if (cli.evalLevel && benchmarkCase.level !== cli.evalLevel) return false;
    if (cli.evalSplit && benchmarkCase.split && benchmarkCase.split !== cli.evalSplit) return false;
    if (cli.evalType && !benchmarkCaseHasAttachmentType(benchmarkCase, cli.evalType)) return false;
    if (completedIds.has(benchmarkCase.id)) return false;
    return true;
  });
  if (cli.evalLimit !== undefined) {
    selected = selected.slice(0, cli.evalLimit);
  }
  return selected;
}

function validateEvalSwarmRuntime(resolvedConfig: Awaited<ReturnType<typeof loadAgentSdkConfig>>): void {
  if (resolvedConfig.interaction.approvalMode === 'manual' || resolvedConfig.interaction.clarificationMode === 'interactive') {
    throw new Error('--swarm > 1 requires non-interactive eval settings; use --approval auto|reject and --clarification fail');
  }
}

async function runBenchmarkCase(options: {
  sdk: Awaited<ReturnType<typeof createAgentSdk>>;
  benchmarkCase: BenchmarkCase;
  resolvedConfig: Awaited<ReturnType<typeof loadAgentSdkConfig>>;
  outputPath: string;
  artifactsDir?: string;
  eventLog: Array<Record<string, JsonValue>>;
  orchestrationSdk?: OrchestrationSdk;
  includeEventArtifacts?: boolean;
}): Promise<BenchmarkResultRecord> {
  const startedAt = new Date();
  const eventStartIndex = options.eventLog.length;
  const runOptions = buildRunOptions({
    mode: 'run',
    goal: options.benchmarkCase.question,
    input: options.benchmarkCase.input,
    images: options.benchmarkCase.images,
    contentParts: options.benchmarkCase.contentParts,
    metadata: {
      dataset: options.benchmarkCase.dataset ?? 'cases',
      taskId: options.benchmarkCase.id,
      ...(options.benchmarkCase.metadata ?? {}),
    },
  });

  try {
    const orchestrated = options.orchestrationSdk
      ? await options.orchestrationSdk.runRaw(options.benchmarkCase.question, runOptions)
      : undefined;
    const result = orchestrated?.finalResult ?? await options.sdk.run(options.benchmarkCase.question, runOptions);
    const finishedAt = new Date();
    const artifacts = await writeBenchmarkArtifacts(options, result, eventStartIndex);
    return {
      schemaVersion: 1,
      dataset: options.benchmarkCase.dataset ?? 'cases',
      taskId: options.benchmarkCase.id,
      ...(options.benchmarkCase.level ? { level: options.benchmarkCase.level } : {}),
      status: isSuccessfulResult(result) ? 'completed' : 'failed',
      runId: result.runId,
      question: options.benchmarkCase.question,
      ...(isSuccessfulResult(result) ? { prediction: result.output, predictionText: stringifyPrediction(result.output) } : {}),
      ...(options.benchmarkCase.expectedAnswer ? { expectedAnswer: options.benchmarkCase.expectedAnswer } : {}),
      ...('usage' in result ? { usage: result.usage as unknown as JsonValue } : {}),
      timings: { startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), durationMs: finishedAt.getTime() - startedAt.getTime() },
      model: { provider: options.resolvedConfig.model.provider, model: options.resolvedConfig.model.model },
      runtime: { mode: options.resolvedConfig.runtime.mode },
      ...(artifacts ? { artifacts } : {}),
      ...(!isSuccessfulResult(result) && result.status === 'failure' ? { error: { message: result.error, code: isModelTimeoutLike(result.error) ? 'model_timeout' : result.code } } : {}),
      metadata: options.benchmarkCase.metadata ?? {},
    };
  } catch (error) {
    const finishedAt = new Date();
    const artifacts = await writeBenchmarkArtifacts(options, { error: error instanceof Error ? error.message : String(error) }, eventStartIndex);
    return {
      schemaVersion: 1,
      dataset: options.benchmarkCase.dataset ?? 'cases',
      taskId: options.benchmarkCase.id,
      ...(options.benchmarkCase.level ? { level: options.benchmarkCase.level } : {}),
      status: 'failed',
      question: options.benchmarkCase.question,
      ...(options.benchmarkCase.expectedAnswer ? { expectedAnswer: options.benchmarkCase.expectedAnswer } : {}),
      timings: { startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), durationMs: finishedAt.getTime() - startedAt.getTime() },
      model: { provider: options.resolvedConfig.model.provider, model: options.resolvedConfig.model.model },
      runtime: { mode: options.resolvedConfig.runtime.mode },
      ...(artifacts ? { artifacts } : {}),
      error: {
        message: error instanceof Error ? error.message : String(error),
        ...(isModelTimeoutLike(error) ? { code: 'model_timeout' } : {}),
      },
      metadata: options.benchmarkCase.metadata ?? {},
    };
  }
}

function installEvalProcessErrorGuard(): () => void {
  const onUncaughtException = (error: Error) => {
    if (isModelTimeoutLike(error)) {
      console.error(`warning: captured unhandled model timeout during eval: ${error.message}`);
      return;
    }
    throw error;
  };
  const onUnhandledRejection = (reason: unknown) => {
    if (isModelTimeoutLike(reason)) {
      console.error(`warning: captured unhandled model timeout during eval: ${reason instanceof Error ? reason.message : String(reason)}`);
      return;
    }
    throw reason;
  };
  process.on('uncaughtException', onUncaughtException);
  process.on('unhandledRejection', onUnhandledRejection);
  return () => {
    process.off('uncaughtException', onUncaughtException);
    process.off('unhandledRejection', onUnhandledRejection);
  };
}

function isModelTimeoutLike(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return String(error).toLowerCase().includes('model timed out');
  }
  const name = error.name.toLowerCase();
  const message = error.message.toLowerCase();
  return name.includes('timeout') || message.includes('model timed out') || message.includes('model timeout');
}

async function writeBenchmarkArtifacts(
  options: { sdk: Awaited<ReturnType<typeof createAgentSdk>>; benchmarkCase: BenchmarkCase; artifactsDir?: string; eventLog: Array<Record<string, JsonValue>>; includeEventArtifacts?: boolean },
  output: unknown,
  eventStartIndex: number,
): Promise<BenchmarkResultRecord['artifacts'] | undefined> {
  if (!options.artifactsDir) return undefined;
  const taskDir = resolve(options.artifactsDir, safePathSegment(options.benchmarkCase.id));
  await mkdir(taskDir, { recursive: true });
  const inputPath = resolve(taskDir, 'input.json');
  const outputPath = resolve(taskDir, 'output.json');
  const eventLogPath = options.includeEventArtifacts === false ? undefined : resolve(taskDir, 'events.jsonl');
  const answerPath = resolve(taskDir, 'answer.txt');
  await writeFile(inputPath, JSON.stringify(options.benchmarkCase, null, 2));
  await writeFile(outputPath, JSON.stringify(output, null, 2));
  if (eventLogPath) {
    const events = options.eventLog.slice(eventStartIndex);
    await writeFile(eventLogPath, events.map((event) => JSON.stringify(event)).join('\n') + (events.length > 0 ? '\n' : ''));
  }
  if (typeof output === 'object' && output && 'output' in output) {
    await writeFile(answerPath, stringifyPrediction((output as { output?: unknown }).output));
  }
  return { input: inputPath, output: outputPath, ...(eventLogPath ? { eventLog: eventLogPath } : {}), answer: answerPath };
}

function stringifyPrediction(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function appendJsonLine(path: string, value: JsonValue): Promise<void> {
  await appendFile(path, `${JSON.stringify(value)}\n`);
}

function printEvalRecord(
  record: BenchmarkResultRecord,
  caseIndex: number,
  cli: ManualTestCliOptions,
  colors?: RunColorRegistry,
): void {
  if (cli.output === 'json' || cli.output === 'jsonl') {
    console.log(JSON.stringify(record));
    return;
  }
  const countPrefix = cli.evalDataset === 'gaia' ? `${caseIndex + 1} : ` : '';
  const line = `${countPrefix}${record.status === 'completed' ? '✓' : '✗'} ${record.taskId}${record.runId ? ` run=${record.runId}` : ''}`;
  console.log(colors?.colorize(record.runId, line) ?? line);
}



async function loadFlaggedAgentSdkConfig(
  baseOptions: AgentSdkOptions,
  flagName: '--agent' | '--worker-catalog' | '--quality-agent' | '--synthesizer-agent',
  agentConfigPath: string,
): Promise<Awaited<ReturnType<typeof loadAgentSdkConfig>>> {
  try {
    return await loadAgentSdkConfig({ ...baseOptions, agentConfigPath });
  } catch (error) {
    throw contextualAgentLoadError(flagName, agentConfigPath, error);
  }
}

async function createFlaggedAgentSdk(
  options: AgentSdkOptions,
  flagName: '--agent' | '--worker-catalog' | '--quality-agent' | '--synthesizer-agent',
  agentConfigPath: string,
): Promise<Awaited<ReturnType<typeof createAgentSdk>>> {
  try {
    return await createAgentSdk(options);
  } catch (error) {
    throw contextualAgentLoadError(flagName, agentConfigPath, error);
  }
}

function contextualAgentLoadError(flagName: string, value: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const wrapped = new Error(`Unable to load ${flagName} agent "${value}": ${message}`);
  if (error instanceof Error) {
    wrapped.stack = `${wrapped.stack ?? wrapped.message}\nCaused by: ${error.stack ?? error.message}`;
  }
  return wrapped;
}


function printEvalDryRun(
  cli: ManualTestCliOptions,
  inspection: Awaited<ReturnType<typeof inspectAgentSdkResolution>>,
  selectedCases: BenchmarkCase[],
  totalCases: number,
): void {
  const output = summarizeEvalDryRun(cli, inspection, selectedCases, totalCases);
  if (cli.output === 'json') {
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  if (cli.output === 'jsonl') {
    console.log(JSON.stringify(output));
    return;
  }

  console.log(renderPrettyString(formatEvalDryRunMarkdown(cli, inspection, selectedCases, totalCases)));
}

function formatEvalDryRunMarkdown(
  cli: ManualTestCliOptions,
  inspection: Awaited<ReturnType<typeof inspectAgentSdkResolution>>,
  selectedCases: BenchmarkCase[],
  totalCases: number,
): string {
  const config = inspection.config;
  const lines = [
    '# Dry run',
    '',
    '- `dryRun`: `true`',
    '- `command`: `eval`',
    `- \`benchmark\`: \`${cli.evalDataset ?? 'benchmark'}\``,
    `- \`requests\`: \`0\``,
    `- \`selected\`: \`${selectedCases.length}/${totalCases}\``,
    `- \`swarm\`: \`${cli.evalSwarm}\``,
    `- \`approval\`: \`${config.interaction.approvalMode}\``,
    `- \`clarification\`: \`${config.interaction.clarificationMode}\``,
    `- \`shellCwd\`: \`${config.shellCwd}\``,
    `- \`agentSearchDirs\`: ${formatNameList(config.agents.dirs)}`,
    `- \`skillSearchDirs\`: ${formatNameList(config.skills.dirs)}`,
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

  if (cli.evalDataset === 'gaia') {
    lines.push('', '## GAIA Tasks', '');
    const tasks = summarizeGaiaDryRunTasks(selectedCases);
    lines.push(...(tasks.length === 0 ? ['- (none)'] : tasks.map(formatGaiaDryRunTaskLine)));
    lines.push('', `- \`totalTaskIds\`: \`${tasks.length}\``);
  }

  return `${lines.join('\n')}\n`;
}

function formatGaiaDryRunTaskLine(task: GaiaDryRunTaskSummary): string {
  const details = [
    `attachment=${task.attachmentType}`,
    ...(task.fileName ? [`file=${task.fileName}`] : []),
    ...(task.level ? [`level=${task.level}`] : []),
    ...(task.split ? [`split=${task.split}`] : []),
  ];
  return `- \`${task.taskId}\` ${details.join(' ')}`;
}


function summarizeEvalDryRun(
  cli: ManualTestCliOptions,
  inspection: Awaited<ReturnType<typeof inspectAgentSdkResolution>>,
  selectedCases: BenchmarkCase[],
  totalCases: number,
): Record<string, JsonValue> {
  return {
    dryRun: true,
    cli: summarizeCli(cli),
    resolvedConfig: summarizeEvalResolvedConfig(inspection.config),
    benchmark: {
      dataset: cli.evalDataset ?? 'benchmark',
      inputPath: cli.evalInputPath ? resolve(cli.cwd ? resolve(cli.cwd) : process.cwd(), cli.evalInputPath) : undefined,
      filesDir: cli.evalFilesDir ? resolve(cli.cwd ? resolve(cli.cwd) : process.cwd(), cli.evalFilesDir) : undefined,
      outputPath: cli.evalOutputPath ? resolve(cli.evalOutputPath) : undefined,
      selectedCases: selectedCases.length,
      totalCases,
      requests: 0,
      swarm: cli.evalSwarm,
    } as JsonValue,
    tools: inspection.tools.map((tool) => tool.name),
    delegates: inspection.delegates as unknown as JsonValue,
    registeredToolNames: inspection.registeredToolNames,
    ...(cli.evalDataset === 'gaia'
      ? {
          gaiaTaskCount: selectedCases.length,
          gaiaTasks: summarizeGaiaDryRunTasks(selectedCases) as unknown as JsonValue,
        }
      : {}),
  };
}

function summarizeEvalResolvedConfig(
  resolvedConfig: Awaited<ReturnType<typeof loadAgentSdkConfig>>,
): Record<string, JsonValue> {
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
  };
}


async function validateLocalPaths(spec: ManualTestSpec): Promise<void> {
  const checks = collectContentParts(spec).flatMap((part) => {
    if (part.type === 'image') return [{ path: part.image.path, label: `image ${part.image.name ?? part.image.path}` }];
    if (part.type === 'file' && part.file.source.kind === 'path') return [{ path: part.file.source.path, label: `file ${part.file.name ?? part.file.source.path}` }];
    if (part.type === 'audio' && part.audio.source.kind === 'path') return [{ path: part.audio.source.path, label: `audio ${part.audio.name ?? part.audio.source.path}` }];
    return [];
  });

  for (const check of checks) {
    try {
      await access(check.path);
    } catch {
      throw new Error(`Referenced ${check.label} does not exist: ${check.path}`);
    }
  }
}

if (import.meta.main) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export async function parseAndValidateSpec(specPath: string, modeOverride?: 'chat' | 'run'): Promise<ManualTestSpec> {
  const spec = await loadManualTestSpec(specPath, modeOverride);
  await validateLocalPaths(spec);
  return spec;
}
