#!/usr/bin/env bun

import { closeSync, createReadStream, createWriteStream, openSync } from 'node:fs';
import { access, appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { marked } from 'marked';
import type {
  AgentEvent,
  ChatMessage,
  ChatResult,
  ContextRef,
  ImageInput,
  JsonObject,
  JsonSchema,
  JsonValue,
  ModelContentPart,
  RunRecoveryPlan,
} from '@adaptive-agent/core';

import {
  createAgentSdk,
  createSwarmSdk,
  SwarmSdk,
  createOrchestrationSdk,
  inspectAgentSdkCatalog,
  inspectAgentSdkResolution,
  loadAgentSdkConfig,
  runAmbientStart,
  type AgentSdkOptions,
  type AgentSdkChatOptions,
  type AgentSdkRunOptions,
  type AmbientStartResult,
  type OrchestrationLifecycleEvent,
  type OrchestrationSdk,
} from './index.js';
import { doctorExitCode, renderDoctorReport, runDoctor } from './install/doctor.js';
import { renderInitReport, runInit, type InitProfile } from './install/init.js';
import { renderUninstallReport, runUninstall, uninstallExitCode } from './install/uninstall.js';
import { renderUpdateReport, runUpdate, updateExitCode } from './install/update.js';
import { getVersionInfo, renderVersion } from './install/version.js';
import { renderAgentCreateReport, runAgentCreate } from './agent-create.js';
import { AgentEventLabelRegistry, formatAgentEventSummary, summarizeAgentEvent } from './agent-event-rendering.js';
import {
  createProjectContextBundle,
  deleteProjectContextBundle,
  expandContextBundleInputs,
  getProjectContextBundle,
  listProjectContextBundles,
  mergeContextBundleMetadata,
  parseContextRef,
  parseContextRefFlag,
  projectContextBundleDirectory,
  type ProjectContextBundle,
} from './context-bundles.js';
import { formatSwarmExecutionPlan, formatSwarmRunStatuses, formatSwarmSubtasks } from './swarm-format.js';
import { resolveReadWebPageProvider, resolveWebSearchProvider } from './tool-registry.js';
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
  formatInteractiveChatResult,
  formatNameList,
  isSuccessfulResult,
  oneLine,
  printDryRun,
  printEvent,
  printInlineConfigSummary,
  printInspection,
  printInteractiveChatResult,
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
  renderPrettyValue,
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
export { formatCoordinatorDecompositionFailure, formatInteractiveChatResult, renderPrettyString, renderStyledPrettyMessage };
export type { BenchmarkAttachmentType, BenchmarkCase, ManualTestCliOptions };


const BENCHMARK_ATTACHMENT_TYPES = ['audio', 'image', 'video', 'other'] as const;
const IMAGE_FILE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff']);
const AUDIO_FILE_EXTENSIONS = new Set(['.wav', '.mp3', '.flac', '.m4a', '.ogg', '.aac', '.aiff', '.aif', '.opus', '.oga', '.weba']);
const VIDEO_FILE_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi', '.mpeg', '.mpg', '.ogv', '.wmv', '.flv', '.3gp', '.ts', '.mts', '.m2ts']);

const CLI_COMMANDS = ['run', 'chat', 'spec', 'config', 'catalog', 'eval', 'swarm-run', 'ambient', 'inspect', 'resume', 'retry', 'recover', 'continue', 'interrupt', 'replay', 'init', 'doctor', 'update', 'uninstall', 'agent-create', 'context'] as const;
type CliCommand = (typeof CLI_COMMANDS)[number];
const CLI_COMMAND_SET = new Set<string>(CLI_COMMANDS);

function isCliCommand(value: string): value is CliCommand {
  return CLI_COMMAND_SET.has(value);
}

function isSingleRunCommand(command: ManualTestCliOptions['command']): command is 'inspect' | 'resume' | 'recover' | 'continue' | 'interrupt' | 'replay' {
  return command === 'inspect' || command === 'resume' || command === 'recover' || command === 'continue' || command === 'interrupt' || command === 'replay';
}

const TOP_LEVEL_HELP_TEXT = `adaptive-agent

Run agent profiles, chat interactively, orchestrate swarm tasks, and inspect local config.

Usage:
  adaptive-agent <command> [options]
  adaptive-agent <command> --help
  adaptive-agent --version

Common commands:
  run                   Run a one-shot goal
  chat                  Start an interactive chat
  swarm-run             Decompose one task into worker runs and synthesize a result
  ambient               Start an ambient supervisor for filesystem and cron triggers
  retry                 Retry one failed run or swarm session
  recover               Choose the cheapest safe recovery action for one run

Recovery and inspection:
  inspect               Inspect a stored run and event summary
  resume                Resume an interrupted or waiting run in place
  continue              Start a new continuation run from a failed run
  interrupt             Request interruption for an active run
  replay                Render stored run events without re-executing

Setup and inspection:
  init                  Create first-run configuration under ~/.adaptiveAgent
  doctor                Check CLI installation and local configuration
  config                Print resolved SDK configuration
  catalog               List available agents, tools, and delegate skills
  context               Create and manage project-scoped context bundles

Other commands:
  agent-create          Generate and write a new agent config JSON file
  spec                  Run an existing JSON spec file
  eval                  Run benchmark cases
  update                Check for or apply GitHub Release updates
  uninstall             Remove the installed adaptive-agent CLI binary

Examples:
  adaptive-agent run "Summarize this repo"
  adaptive-agent chat
  adaptive-agent swarm-run --help
  adaptive-agent ambient start --config ambient.config.json
  adaptive-agent doctor --provider-check

Global options:
  --cwd <path>            Working directory used for SDK config lookup.
  --output <format>       Output format: pretty, json, or jsonl. Default: pretty.
  --version               Print adaptive-agent version.
  --help                  Show this overview.

More help:
  adaptive-agent <command> --help
  adaptive-agent help <command>
  adaptive-agent --help <command>`;

const COMMON_AGENT_OPTIONS_TEXT = `Agent/config options:
  --agent <path-or-name>  Explicit path to agent.json, or filename from agents.dirs.
  --settings <path>       Explicit path to agent.settings.json.
  --runtime <mode>        Runtime mode: memory or postgres.
  --provider <name>       Override provider: openrouter, ollama, mistral, mesh.
  --model <name>          Override model name.
  --approval <mode>       Approval mode: auto, manual, reject.
  --clarification <mode>  Clarification mode: interactive or fail.`;

const COMMON_RUNTIME_OPTIONS_TEXT = `Additional agent/config options:
  --settings <path>       Explicit path to agent.settings.json.
  --runtime <mode>        Runtime mode: memory or postgres.
  --provider <name>       Override provider: openrouter, ollama, mistral, mesh.
  --model <name>          Override model name.
  --approval <mode>       Approval mode: auto, manual, reject.
  --clarification <mode>  Clarification mode: interactive or fail.`;

const RUN_OUTPUT_OPTIONS_TEXT = `Output/debug options:
  --progress              Print assistant progress updates as they arrive.
  --events                Print lifecycle events as they arrive.
  --show-lines <n>        Maximum pretty-rendered progress lines to show. Default: 3.
  --wrap-width <n>        Fold progress/event text after this many columns. Default: terminal width or 100.
  --dry-run               Resolve config, request, tools, and delegates without running.`;

const INSPECTION_OPTIONS_TEXT = `Inspection options:
  --inspect               Print a compact inspection summary after completion.`;

const RUN_HELP_TEXT = `adaptive-agent run

Run a one-shot goal through an agent profile.

Usage:
  adaptive-agent run [options] <goal...>
  adaptive-agent run --file <path> [options]

Examples:
  adaptive-agent run "Summarize this repository"
  adaptive-agent run --file ./prompt.md
  adaptive-agent run --image ./diagram.png "Answer using this image"
  adaptive-agent run --image https://example.test/diagram.png "Answer using this image"

Run options:
  --file <path>           Read run prompt from a file.
  --input-json <json>     JSON input passed to run requests.
  --context-ref <ref>     Add prior context: run:<id> or session:<id>. Repeatable.
  --context-bundle <name>
                          Expand a project context bundle. Repeatable.
  --image <path-or-url>   Add an image attachment to a run request. Repeatable.
  --audio <path>          Add an audio attachment to a run request. Repeatable.
  --file-attachment <path>
                          Add a file attachment to a run request. Repeatable.
  --orchestrate           Route run requests through the orchestration SDK.
  --catalog <path>        Agent config path to add to orchestration catalog. Repeatable.

${COMMON_AGENT_OPTIONS_TEXT}

${RUN_OUTPUT_OPTIONS_TEXT}

${INSPECTION_OPTIONS_TEXT}`;

const CHAT_HELP_TEXT = `adaptive-agent chat

Start an interactive chat in a TTY. When no message is given and stdin is piped,
the command reads the piped message instead.

Usage:
  adaptive-agent chat [options] [message...]

Examples:
  adaptive-agent chat
  adaptive-agent chat "Help me review this plan"
  cat prompt.md | adaptive-agent chat

Chat options:
  --file <path>           Read chat message from a file.
  --context-ref <ref>     Add prior context: run:<id> or session:<id>. Repeatable.
  --context-bundle <name>
                          Expand a project context bundle. Repeatable.

${COMMON_AGENT_OPTIONS_TEXT}

${RUN_OUTPUT_OPTIONS_TEXT}

${INSPECTION_OPTIONS_TEXT}`;

const SWARM_RUN_HELP_TEXT = `adaptive-agent swarm-run

Decompose one top-level objective into bounded worker runs, optionally assess
quality, and synthesize a final answer.

Usage:
  adaptive-agent swarm-run --agent <path-or-name> --worker-catalog <paths-or-names> [options] <task...>
  adaptive-agent swarm-run --agent <path-or-name> --worker-catalog <paths-or-names> --file <path> [options]

Examples:
  adaptive-agent swarm-run --agent coordinator-agent --worker-catalog researcher.json,writer.json "Build a launch brief"
  adaptive-agent swarm-run --agent coordinator-agent --worker-catalog ./agents --file ./task.md --max-workers 3

Required:
  --agent <path-or-name>  Coordinator agent JSON path or filename.
  --worker-catalog <paths>
                          Comma-separated worker agent JSON paths or filenames.
  <task...> or --file     Top-level objective to decompose.

Swarm-run options:
  --file <path>           Read swarm task from a file.
  --input-json <json>     JSON input passed to swarm runs.
  --image <path-or-url>   Add an image attachment to the coordinator request. Repeatable.
  --audio <path>          Add an audio attachment to the coordinator request. Repeatable.
  --file-attachment <path>
                          Add a file attachment to the coordinator request. Repeatable.
  --quality-agent <path-or-name>
                          Optional quality agent JSON path or filename.
  --synthesizer-agent <path-or-name>
                          Optional synthesizer agent JSON path or filename.
  --max-workers <n>       Maximum concurrent swarm workers.
  --session-id <id>       Session id for run grouping.

${COMMON_RUNTIME_OPTIONS_TEXT}

${RUN_OUTPUT_OPTIONS_TEXT}`;

const AMBIENT_HELP_TEXT = `adaptive-agent ambient

Run a foreground ambient supervisor that turns external triggers into ordinary
durable agent runs. Supports filesystem inbox and cron triggers.

Usage:
  adaptive-agent ambient start --config <path> [options]

Filesystem trigger layout:
  <inbox>/pending      Drop .md task files here.
  <inbox>/processing   Claimed tasks while runs are active.
  <inbox>/processed    Source files after successful runs.
  <inbox>/failed       Source files after failed or waiting-for-user-action runs.

Cron trigger config:
  { "id": "daily", "type": "cron", "schedule": "0 8 * * 1-5",
    "timezone": "America/New_York", "goalFile": "tasks/daily.md" }

Ambient options:
  --config <path>        Ambient config JSON path.
  --dry-run              Validate and print resolved ambient config without starting.

${COMMON_AGENT_OPTIONS_TEXT}`;

const RETRY_HELP_TEXT = `adaptive-agent retry

Retry one failed run, or retry a swarm session by session id.

Usage:
  adaptive-agent retry --run-id <runId> [options]
  adaptive-agent retry --agent <path-or-name> --worker-catalog <paths-or-names> [options] <sessionId>

Examples:
  adaptive-agent retry --run-id run_123
  adaptive-agent retry --agent coordinator-agent --worker-catalog researcher.json,writer.json session_123

Retry options:
  --run-id <id>           Retry this single failed run instead of a swarm session.
  --worker-catalog <paths>
                          Comma-separated worker agent JSON paths or filenames for session retry.
  --quality-agent <path-or-name>
                          Optional quality agent JSON path or filename for session retry.
  --synthesizer-agent <path-or-name>
                          Optional synthesizer agent JSON path or filename for session retry.
  --max-workers <n>       Maximum concurrent swarm workers for session retry.

${COMMON_AGENT_OPTIONS_TEXT}

${RUN_OUTPUT_OPTIONS_TEXT}`;

const RECOVER_HELP_TEXT = `adaptive-agent recover

Choose the cheapest safe recovery action for one persisted run.

Usage:
  adaptive-agent recover <runId> [options]
  adaptive-agent recover --run-id <runId> [options]

Examples:
  adaptive-agent recover run_123 --dry-run
  adaptive-agent recover --run-id run_123 --strategy continue

Recover options:
  --strategy <mode>       Recovery mode: auto, resume, retry, or continue. Default: auto.
  --dry-run               Print the selected recovery plan without executing it.

${COMMON_AGENT_OPTIONS_TEXT}

${RUN_OUTPUT_OPTIONS_TEXT}`;

const CONTINUE_HELP_TEXT = `adaptive-agent continue

Create and execute a new continuation run from a failed persisted run. The
source run remains failed and the new run is linked to it for auditability.

Usage:
  adaptive-agent continue <runId> [options]
  adaptive-agent continue --run-id <runId> [options]

Examples:
  adaptive-agent continue run_123
  adaptive-agent continue --run-id run_123 --runtime postgres --progress

${COMMON_AGENT_OPTIONS_TEXT}

${RUN_OUTPUT_OPTIONS_TEXT}`;

const INSPECT_HELP_TEXT = `adaptive-agent inspect

Inspect a stored run and compact event summary.

Usage:
  adaptive-agent inspect <runId> [options]
  adaptive-agent inspect --run-id <runId> [options]

Examples:
  adaptive-agent inspect run_123
  adaptive-agent inspect --run-id run_123 --output json

${COMMON_AGENT_OPTIONS_TEXT}`;

const RESUME_HELP_TEXT = `adaptive-agent resume

Resume an interrupted or waiting persisted run in place.

Usage:
  adaptive-agent resume <runId> [options]
  adaptive-agent resume --run-id <runId> [options]

Examples:
  adaptive-agent resume run_123
  adaptive-agent resume --run-id run_123 --progress

${COMMON_AGENT_OPTIONS_TEXT}

${RUN_OUTPUT_OPTIONS_TEXT}`;

const INTERRUPT_HELP_TEXT = `adaptive-agent interrupt

Request interruption for an active run. This is most useful with a durable
runtime such as Postgres; memory runtime cannot interrupt a different process.

Usage:
  adaptive-agent interrupt <runId> [options]
  adaptive-agent interrupt --run-id <runId> [options]

Examples:
  adaptive-agent interrupt run_123
  adaptive-agent interrupt --run-id run_123 --runtime postgres

${COMMON_AGENT_OPTIONS_TEXT}`;

const REPLAY_HELP_TEXT = `adaptive-agent replay

Render stored run events without re-executing tools or reconstructing runtime state.

Usage:
  adaptive-agent replay <runId> [options]
  adaptive-agent replay --run-id <runId> [options]

Examples:
  adaptive-agent replay run_123
  adaptive-agent replay --run-id run_123 --output jsonl

${COMMON_AGENT_OPTIONS_TEXT}`;

const SPEC_HELP_TEXT = `adaptive-agent spec

Run the existing JSON spec format.

Usage:
  adaptive-agent spec <path> [options]
  adaptive-agent --spec <path> [options]
  bun run ./packages/agent-sdk/dist/adaptive-agent.js --spec <path> [options]

Spec options:
  --spec <path>           Path to the JSON spec file.
  --mode <chat|run>       Override the spec mode.
  --orchestrate           Route run-mode specs through the orchestration SDK.
  --catalog <path>        Agent config path to add to orchestration catalog. Repeatable.

${COMMON_AGENT_OPTIONS_TEXT}

${RUN_OUTPUT_OPTIONS_TEXT}

${INSPECTION_OPTIONS_TEXT}`;

const CONFIG_HELP_TEXT = `adaptive-agent config

Print resolved SDK configuration.

Usage:
  adaptive-agent config [options]

${COMMON_AGENT_OPTIONS_TEXT}`;

const CATALOG_HELP_TEXT = `adaptive-agent catalog

List available agents, tools, and delegate skills.

Usage:
  adaptive-agent catalog [options]

${COMMON_AGENT_OPTIONS_TEXT}`;

const EVAL_HELP_TEXT = `adaptive-agent eval

Run benchmark cases from JSON/JSONL files.

Usage:
  adaptive-agent eval cases --input <path> --out <path> [options]
  adaptive-agent eval gaia --input <path> --out <path> [options]

Eval commands:
  eval cases            Run generic benchmark cases from JSON/JSONL.
  eval gaia             Run GAIA benchmark rows from JSON/JSONL.

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

${COMMON_AGENT_OPTIONS_TEXT}

${RUN_OUTPUT_OPTIONS_TEXT}`;

const INIT_HELP_TEXT = `adaptive-agent init

Create first-run configuration under ~/.adaptiveAgent.

Usage:
  adaptive-agent init [options]

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
  --dry-run               Show what init would create without writing files.`;

const DOCTOR_HELP_TEXT = `adaptive-agent doctor

Check CLI installation and local configuration.

Usage:
  adaptive-agent doctor [options]

Doctor options:
  --agent <path-or-name>  Explicit path to agent.json, or filename from agents.dirs.
  --settings <path>       Explicit path to agent.settings.json.
  --runtime <mode>        Runtime store mode to validate: memory or postgres.
  --provider <name>       Provider override to validate: openrouter, ollama, mistral, mesh.
  --model <name>          Model override to validate.
  --network               Allow doctor network checks against GitHub.
  --provider-check        Allow doctor provider reachability checks.
  --strict                Treat doctor warnings as failures.`;

const UPDATE_HELP_TEXT = `adaptive-agent update

Check for or apply GitHub Release updates.

Usage:
  adaptive-agent update [options]

Update options:
  --check                 Check for updates without installing.
  --version <version>     Install or check a specific release version.
  --channel <name>        Update channel: stable or preview. Default: stable.
  --force                 Reinstall even when already up to date.
  --yes                   Accept update prompts when supported.
  --repo <owner/repo>     GitHub release repo for update checks.
  --base-url <url>        Release asset base URL for update downloads.`;

const UNINSTALL_HELP_TEXT = `adaptive-agent uninstall

Remove the installed adaptive-agent CLI binary.

Usage:
  adaptive-agent uninstall [options]

Uninstall options:
  --dry-run               Show which CLI binary would be removed.`;

const AGENT_CREATE_HELP_TEXT = `adaptive-agent agent-create

Generate and write a new agent config JSON file.

Usage:
  adaptive-agent agent-create [options] <agent-description...>
  adaptive-agent agent-create --file <path> [options]

Agent-create options:
  --file <path>           Read the new agent description from a text file.
  --generator-agent <path-or-name>
                          Existing agent used to generate the new config. Default: default-agent.
  --id <id>               Override the generated agent id.
  --provider <name>       Override generated config provider: openrouter, ollama, mistral, mesh.
  --model <name>          Override generated config model name.
  --yes                   Write without an interactive confirmation prompt.
  --force                 Overwrite an existing generated config path.
  --dry-run               Preview the config and ask before writing; Enter means no.`;

const CONTEXT_HELP_TEXT = `adaptive-agent context

Create and manage named, project-scoped context bundles stored under
<cwd>/.adaptiveAgent/context-bundles.

Usage:
  adaptive-agent context create <name> --ref <ref> [--ref <ref> ...] [options]
  adaptive-agent context list [options]
  adaptive-agent context show <name> [options]
  adaptive-agent context delete <name> [options]

Context options:
  --ref <ref>             Add run:<id> or session:<id> to a new bundle. Repeatable.
  --description <text>    Optional display-only description for a new bundle.
  --force                 Overwrite an existing bundle during create.
  --dry-run               Preview create or delete without changing files.
  --cwd <path>            Project root that owns the bundle registry.
  --output <format>       Output format: pretty, json, or jsonl.`;

const VERSION_HELP_TEXT = `adaptive-agent --version

Print adaptive-agent version.

Usage:
  adaptive-agent --version`;

function getHelpText(topic?: ManualTestCliOptions['helpTopic']): string {
  switch (topic) {
    case 'run':
      return RUN_HELP_TEXT;
    case 'chat':
      return CHAT_HELP_TEXT;
    case 'swarm-run':
      return SWARM_RUN_HELP_TEXT;
    case 'ambient':
      return AMBIENT_HELP_TEXT;
    case 'inspect':
      return INSPECT_HELP_TEXT;
    case 'resume':
      return RESUME_HELP_TEXT;
    case 'retry':
      return RETRY_HELP_TEXT;
    case 'recover':
      return RECOVER_HELP_TEXT;
    case 'continue':
      return CONTINUE_HELP_TEXT;
    case 'interrupt':
      return INTERRUPT_HELP_TEXT;
    case 'replay':
      return REPLAY_HELP_TEXT;
    case 'spec':
      return SPEC_HELP_TEXT;
    case 'config':
      return CONFIG_HELP_TEXT;
    case 'catalog':
      return CATALOG_HELP_TEXT;
    case 'eval':
      return EVAL_HELP_TEXT;
    case 'init':
      return INIT_HELP_TEXT;
    case 'doctor':
      return DOCTOR_HELP_TEXT;
    case 'update':
      return UPDATE_HELP_TEXT;
    case 'uninstall':
      return UNINSTALL_HELP_TEXT;
    case 'agent-create':
      return AGENT_CREATE_HELP_TEXT;
    case 'context':
      return CONTEXT_HELP_TEXT;
    case 'version':
      return VERSION_HELP_TEXT;
    default:
      return TOP_LEVEL_HELP_TEXT;
  }
}

const PROVIDER_INPUT_CAPABILITIES: Record<
  'openrouter' | 'ollama' | 'mistral' | 'mesh',
  Partial<Record<'image' | 'file' | 'audio', Array<'path' | 'url' | 'data' | 'file_id'>>>
> = {
  openrouter: {
    image: ['path', 'url'],
    file: ['path', 'url', 'file_id'],
    audio: ['path', 'data'],
  },
  ollama: {
    image: ['path', 'url'],
  },
  mistral: {
    image: ['path', 'url'],
    file: ['path', 'url', 'file_id'],
    audio: ['path', 'data'],
  },
  mesh: {
    image: ['path', 'url'],
    audio: ['path', 'data'],
  },
};

export async function main(argv = Bun.argv.slice(2)): Promise<number> {
  const cli = parseCliArgs(argv);
  if (cli.help) {
    console.log(getHelpText(cli.helpTopic));
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

  if (cli.command === 'context') {
    return runContextCommand(cli);
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

  if (cli.command === 'ambient') {
    return runAmbientCommand(cli);
  }

  if (cli.command === 'inspect') {
    return runInspectCommand(cli);
  }

  if (cli.command === 'resume') {
    return runResumeCommand(cli);
  }

  if (cli.command === 'retry') {
    return runRetryCommand(cli);
  }

  if (cli.command === 'recover') {
    return runRecoverCommand(cli);
  }

  if (cli.command === 'continue') {
    return runContinueCommand(cli);
  }

  if (cli.command === 'interrupt') {
    return runInterruptCommand(cli);
  }

  if (cli.command === 'replay') {
    return runReplayCommand(cli);
  }

  if (cli.command === 'chat') {
    return shouldRunInteractiveChat(cli) ? runInteractiveChatCommand(cli) : runInlineCommand(cli, 'chat');
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
  return report.actions.some((action) => action.status === 'failed') ? 1 : 0;
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

async function runContextCommand(cli: ManualTestCliOptions): Promise<number> {
  const projectRoot = resolve(cli.cwd ?? process.cwd());
  const action = cli.goalArgs[0] as 'create' | 'list' | 'show' | 'delete';
  const name = cli.goalArgs[1];
  let output: Record<string, unknown>;

  if (action === 'create') {
    const result = await createProjectContextBundle({
      cwd: projectRoot,
      name: name!,
      description: cli.contextBundleDescription,
      refs: cli.contextBundleRefs,
      force: cli.force,
      dryRun: cli.dryRun,
    });
    output = {
      command: 'context',
      action,
      status: result.status,
      dryRun: result.dryRun,
      bundle: contextBundleOutput(result.record),
    };
  } else if (action === 'list') {
    const bundles = await listProjectContextBundles(projectRoot);
    output = {
      command: 'context',
      action,
      scope: 'project',
      projectRoot,
      directory: projectContextBundleDirectory(projectRoot),
      bundles: bundles.map(contextBundleOutput),
    };
  } else if (action === 'show') {
    const bundle = await getProjectContextBundle(name!, projectRoot);
    output = {
      command: 'context',
      action,
      bundle: contextBundleOutput(bundle),
    };
  } else {
    const result = await deleteProjectContextBundle({ cwd: projectRoot, name: name!, dryRun: cli.dryRun });
    output = {
      command: 'context',
      action,
      status: result.status,
      dryRun: result.dryRun,
      bundle: contextBundleOutput(result.record),
    };
  }

  console.log(renderContextCommandOutput(output, cli.output));
  return 0;
}

function contextBundleOutput(record: ProjectContextBundle): Record<string, unknown> {
  return {
    scope: record.scope,
    projectRoot: record.projectRoot,
    path: record.path,
    digest: record.digest,
    ...record.bundle,
  };
}

function renderContextCommandOutput(output: Record<string, unknown>, format: ManualTestCliOptions['output']): string {
  if (format === 'json') return JSON.stringify(output, null, 2);
  if (format === 'jsonl') return JSON.stringify(output);

  const action = String(output.action);
  if (action === 'list') {
    const bundles = output.bundles as Array<Record<string, unknown>>;
    return [
      `Context bundles (${bundles.length})`,
      `directory: ${String(output.directory)}`,
      ...(bundles.length === 0
        ? ['  (none)']
        : bundles.map((bundle) => `  - ${String(bundle.name)} (${(bundle.refs as unknown[]).length} refs, ${String(bundle.digest)})`)),
    ].join('\n');
  }

  const bundle = output.bundle as Record<string, unknown>;
  const refs = bundle.refs as Array<{ kind: string; id: string }>;
  const status = output.status ? `${String(output.status)}${output.dryRun ? ' (dry run)' : ''}` : action;
  return [
    `Context bundle ${status}`,
    `name: ${String(bundle.name)}`,
    `scope: ${String(bundle.scope)}`,
    `description: ${bundle.description === undefined ? '(none)' : String(bundle.description)}`,
    `path: ${String(bundle.path)}`,
    `digest: ${String(bundle.digest)}`,
    'refs:',
    ...refs.map((ref) => `  - ${ref.kind}:${ref.id}`),
  ].join('\n');
}

async function runAmbientCommand(cli: ManualTestCliOptions): Promise<number> {
  if (cli.goalArgs[0] !== 'start') throw new Error('ambient currently supports only: adaptive-agent ambient start --config <path>');
  if (!cli.ambientConfigPath) throw new Error('ambient start requires --config <path>');

  const resolvedCwd = resolve(cli.cwd ?? process.cwd());
  const controller = new AbortController();
  let signalCount = 0;
  const stop = (signalName: string) => {
    signalCount += 1;
    if (signalCount > 1) {
      console.error(`received ${signalName} again; exiting immediately`);
      process.exit(130);
    }
    if (cli.output === 'pretty') console.error(`received ${signalName}; stopping ambient supervisor after active task drains...`);
    controller.abort();
  };
  const onSigint = () => stop('SIGINT');
  const onSigterm = () => stop('SIGTERM');

  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  try {
    const result = await runAmbientStart({
      configPath: cli.ambientConfigPath,
      cwd: resolvedCwd,
      agentConfigPath: cli.agentConfigPath,
      settingsConfigPath: cli.settingsConfigPath,
      runtimeMode: cli.runtimeMode,
      provider: cli.provider,
      model: cli.model,
      approvalMode: cli.approvalMode,
      clarificationMode: cli.clarificationMode,
      output: cli.output,
      dryRun: cli.dryRun,
      signal: controller.signal,
    });

    if (cli.output === 'json') {
      console.log(JSON.stringify(summarizeAmbientStartResult(result), null, 2));
      return 0;
    }
    if (cli.output === 'jsonl') {
      console.log(JSON.stringify(summarizeAmbientStartResult(result)));
      return 0;
    }
    if (cli.dryRun) {
      console.log(JSON.stringify(summarizeAmbientStartResult(result), null, 2));
      return 0;
    }
    console.log(`ambient supervisor stopped; tasks handled: ${result.tasks.length}`);
    return 0;
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  }
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
  const promptLabel = mode === 'run' ? 'run goal' : 'chat message';
  let goal: string;
  try {
    goal = await readInlinePrompt(cli, promptLabel);
  } catch (error) {
    if (mode === 'chat' && cli.output === 'pretty' && isMissingInlinePromptError(error, promptLabel)) {
      return runInteractiveChatCommand(cli);
    }
    throw error;
  }
  const preparedContext = await prepareCliContext(cli, resolvedCwd);
  const spec: ManualTestSpec = mode === 'run'
    ? {
        mode: 'run',
        goal,
        ...(cli.inputJson === undefined ? {} : { input: cli.inputJson }),
        ...(preparedContext.contextRefs.length > 0 ? { contextRefs: preparedContext.contextRefs } : {}),
        ...(preparedContext.metadata ? { metadata: preparedContext.metadata } : {}),
        ...(cli.imagePaths.length > 0 ? { images: cli.imagePaths.map((value) => buildInlineImageInput(value, resolvedCwd)) } : {}),
        ...(cli.audioPaths.length > 0 || cli.fileAttachmentPaths.length > 0
          ? { contentParts: buildInlineContentParts(cli, resolvedCwd, { includeImages: false }) }
          : {}),
      }
    : {
        mode: 'chat',
        messages: [{ role: 'user', content: goal }],
        ...(preparedContext.contextRefs.length > 0 ? { contextRefs: preparedContext.contextRefs } : {}),
        ...(preparedContext.metadata ? { metadata: preparedContext.metadata } : {}),
      };
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

function shouldRunInteractiveChat(cli: ManualTestCliOptions): boolean {
  return !cli.promptFilePath && process.stdin.isTTY === true && cli.output === 'pretty';
}

async function runInteractiveChatCommand(cli: ManualTestCliOptions): Promise<number> {
  const resolvedCwd = resolve(cli.cwd ?? process.cwd());
  const preparedContext = await prepareCliContext(cli, resolvedCwd);
  let nextUserMessage = cli.goalArgs.join(' ').trim();

  while (nextUserMessage.length === 0) {
    const line = await readChatLine();
    if (line === undefined) return 0;
    nextUserMessage = line.trim();
    if (isChatExitCommand(nextUserMessage)) return 0;
  }

  if (isChatExitCommand(nextUserMessage)) return 0;

  const sdkOptions = buildSdkOptions(cli, resolvedCwd);
  const inspection = cli.dryRun ? await inspectAgentSdkResolution(sdkOptions) : undefined;
  const resolvedConfig = inspection?.config ?? await loadAgentSdkConfig(sdkOptions);
  const eventLog: Array<Record<string, JsonValue>> = [];
  const lastProgressContentByRun = new Map<string, string>();
  const progressRunColors = cli.progress ? new RunColorRegistry() : undefined;
  const eventListener = shouldListenForCliEvents(cli) ? (event: AgentEvent) => {
    const entry = summarizeEvent(event);
    eventLog.push(entry);
    if (progressRunColors) {
      printRunBoundaryEvent(event, resolvedConfig.tui, progressRunColors, cli.wrapWidth);
    }
    if (cli.events) {
      printEvent(entry, resolvedConfig.tui);
    } else if (cli.progress) {
      printProgressEvent(event, lastProgressContentByRun, resolvedConfig.tui, cli.showLines, cli.wrapWidth);
    }
  } : undefined;

  const messages: ChatMessage[] = [];
  const sessionId = cli.sessionId ?? crypto.randomUUID();
  let summaryPrinted = false;
  let exitCode = 0;

  const sdk = cli.dryRun ? undefined : await createAgentSdk({
    ...sdkOptions,
    eventListener,
  });

  try {
    while (true) {
      const userMessage = nextUserMessage.trim();
      nextUserMessage = '';

      if (isChatExitCommand(userMessage)) break;
      if (userMessage.length === 0) {
        const line = await readChatLine();
        if (line === undefined) break;
        nextUserMessage = line;
        continue;
      }

      messages.push({ role: 'user', content: userMessage });
      const spec = buildInteractiveChatSpec(messages, preparedContext.contextRefs, preparedContext.metadata);
      const warnings = collectProviderWarnings(spec, resolvedConfig.model.provider);

      if (!summaryPrinted) {
        for (const warning of warnings) console.error(`warning: ${warning}`);
        summaryPrinted = true;
      }

      if (cli.dryRun) {
        printInlineConfigSummary(cli, resolvedConfig, spec, warnings);
        printDryRun(cli, inspection!, spec, warnings);
        return 0;
      }

      const result = await sdk!.chat(messages, { ...buildChatOptions(spec), sessionId });
      const resultInspection = cli.inspect ? await summarizeInspection(sdk!, result.runId) : undefined;
      if (result.status === 'success') {
        printInteractiveChatResult(result, resolvedConfig.tui, cli.wrapWidth);
      } else {
        printResult(result, 'assistant', resolvedConfig.tui);
      }
      if (cli.inspect && resultInspection) printInspection(resultInspection);

      if (result.status !== 'success') {
        exitCode = isSuccessfulResult(result) ? 0 : 1;
        messages.push({
          role: 'assistant',
          content: formatFailedChatTranscriptOutput(result),
        });
        const line = await readChatLine();
        if (line === undefined) break;
        nextUserMessage = line;
        continue;
      }

      messages.push({ role: 'assistant', content: formatChatTranscriptOutput(result.output) });

      const line = await readChatLine();
      if (line === undefined) break;
      nextUserMessage = line;
    }

    if (cli.events && eventLog.length > 0) console.error(`event log captured: ${eventLog.length}`);
    return exitCode;
  } finally {
    await sdk?.close();
  }
}

export function buildInteractiveChatSpec(
  messages: ChatMessage[],
  contextRefs: ContextRef[],
  metadata?: Record<string, JsonValue>,
): ManualChatSpec {
  return {
    mode: 'chat',
    messages,
    ...(contextRefs.length > 0 ? { contextRefs } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

async function prepareCliContext(
  cli: ManualTestCliOptions,
  cwd: string,
): Promise<{ contextRefs: ContextRef[]; metadata?: Record<string, JsonValue> }> {
  const expansion = await expandContextBundleInputs(cli.contextInputs, cwd);
  return {
    contextRefs: expansion.refs,
    metadata: mergeContextBundleMetadata(undefined, expansion.bundles),
  };
}

async function readChatLine(): Promise<string | undefined> {
  const tty = openPromptTty();
  const rl = createInterface({
    input: tty?.input ?? process.stdin,
    output: tty?.output ?? process.stderr,
  });
  try {
    return await rl.question('user> ');
  } catch {
    return undefined;
  } finally {
    rl.close();
    tty?.input.destroy();
    tty?.output.end();
  }
}

function openPromptTty(): { input: ReturnType<typeof createReadStream>; output: ReturnType<typeof createWriteStream> } | undefined {
  if (process.stdin.isTTY === true) return undefined;
  let inputFd: number | undefined;
  try {
    inputFd = openSync('/dev/tty', 'r');
    const outputFd = openSync('/dev/tty', 'w');
    return {
      input: createReadStream('', { fd: inputFd, autoClose: true }),
      output: createWriteStream('', { fd: outputFd, autoClose: true }),
    };
  } catch {
    if (inputFd !== undefined) closeSync(inputFd);
    return undefined;
  }
}

function isChatExitCommand(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return normalized === '/quit';
}

function formatChatTranscriptOutput(output: JsonValue): string {
  if (typeof output === 'string') return output;
  return `\`\`\`json\n${JSON.stringify(output, null, 2)}\n\`\`\``;
}

function formatFailedChatTranscriptOutput(result: Exclude<ChatResult, { status: 'success' }>): string {
  if (result.status === 'failure') {
    return `Previous assistant turn failed with ${result.code}: ${result.error}`;
  }

  if (result.status === 'clarification_requested') {
    return `Previous assistant turn requested clarification: ${result.message}`;
  }

  return `Previous assistant turn requested approval for ${result.toolName}: ${result.message}`;
}

async function runSwarmCommand(cli: ManualTestCliOptions): Promise<number> {
  const resolvedCwd = resolve(cli.cwd ?? process.cwd());
  const topLevelObjective = await readInlinePrompt(cli, 'swarm task');
  const sdkOptions = buildSdkOptions(cli, resolvedCwd);
  const eventLog: Array<Record<string, JsonValue>> = [];
  const resolvedSwarm = await SwarmSdk.resolveConfig({ ...sdkOptions, coordinatorConfigPath: cli.agentConfigPath ?? 'agent.json', workerConfigPaths: cli.workerCatalogPaths, qualityConfigPath: cli.qualityAgentPath, synthesizerConfigPath: cli.synthesizerAgentPath });
  const { coordinator: coordinatorConfig, workers: workerConfigs, quality: qualityConfig, synthesizer: synthesizerConfig, workerIds } = resolvedSwarm;

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

  const swarmSdk = await createSwarmSdk({ ...sdkOptions, eventListener, coordinatorConfig: coordinatorConfig, workerConfigs, qualityConfig, synthesizerConfig, maxWorkers: cli.maxWorkers });

  try {
    const sessionId = cli.sessionId ?? crypto.randomUUID();
    const contentParts = buildInlineContentParts(cli, resolvedCwd, { includeImages: true });
    const sdkResult = await swarmSdk.run({ sessionId, topLevelObjective, input: cli.inputJson, contentParts, maxWorkers: cli.maxWorkers });
    if (sdkResult.state !== 'completed') throw new Error(formatCoordinatorDecompositionFailure(sdkResult.decompositionResult));
    const { subtasks, executionResult: result } = sdkResult;
    if (cli.output === 'pretty') {
      printSwarmExecutionPlan(sessionId, sdkResult.coordinatorRunId, subtasks, cli.wrapWidth);
    }

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
    await swarmSdk.close();
  }
}

function readRunIdArgument(cli: ManualTestCliOptions): string {
  return cli.runId ?? cli.goalArgs[0]!;
}

async function assertRunAgentMatchesLoadedAgent(sdk: Awaited<ReturnType<typeof createAgentSdk>>, runId: string): Promise<void> {
  const inspection = await sdk.inspect(runId);
  if (!inspection.run && sdk.config.runtime.mode === 'memory' && process.env.DATABASE_URL) {
    throw new Error(`Run ${runId} was not found in the resolved memory runtime. DATABASE_URL is set, so this may be a Postgres-backed run; retry with --runtime postgres or update agent.settings.json runtime.mode to postgres.`);
  }
  const runAgentId = typeof inspection.run?.metadata?.agentId === 'string' ? inspection.run.metadata.agentId : undefined;
  if (runAgentId && runAgentId !== sdk.config.agent.id) {
    throw new Error(`Run ${runId} belongs to agent ${runAgentId}; loaded agent is ${sdk.config.agent.id}`);
  }
}

async function resolveSdkForRunAgent(
  sdk: Awaited<ReturnType<typeof createAgentSdk>>,
  sdkOptions: AgentSdkOptions,
  runId: string,
  explicitAgentConfigPath: string | undefined,
  eventListener: ((event: AgentEvent) => void) | undefined,
): Promise<Awaited<ReturnType<typeof createAgentSdk>>> {
  const inspection = await sdk.inspect(runId);
  if (!inspection.run && sdk.config.runtime.mode === 'memory' && process.env.DATABASE_URL) {
    throw new Error(`Run ${runId} was not found in the resolved memory runtime. DATABASE_URL is set, so this may be a Postgres-backed run; retry with --runtime postgres or update agent.settings.json runtime.mode to postgres.`);
  }

  const runAgentId = typeof inspection.run?.metadata?.agentId === 'string' ? inspection.run.metadata.agentId : undefined;
  if (!runAgentId || runAgentId === sdk.config.agent.id) {
    return sdk;
  }

  if (explicitAgentConfigPath) {
    throw new Error(`Run ${runId} belongs to agent ${runAgentId}; loaded agent is ${sdk.config.agent.id}`);
  }

  return createAgentSdk({
    ...sdkOptions,
    agentConfigPath: runAgentId,
    runtime: sdk.created.runtime,
    eventListener,
  });
}

async function runInspectCommand(cli: ManualTestCliOptions): Promise<number> {
  const runId = readRunIdArgument(cli);
  const resolvedCwd = resolve(cli.cwd ?? process.cwd());
  const sdk = await createAgentSdk(buildSdkOptions(cli, resolvedCwd));
  try {
    const inspection = await summarizeInspection(sdk, runId);
    if (cli.output === 'json') {
      console.log(JSON.stringify({ command: 'inspect', runId, inspection }, null, 2));
    } else if (cli.output === 'jsonl') {
      console.log(JSON.stringify({ command: 'inspect', runId, inspection }));
    } else {
      printInspection(inspection);
    }
    return inspection.run ? 0 : 1;
  } finally {
    await sdk.close();
  }
}

async function runResumeCommand(cli: ManualTestCliOptions): Promise<number> {
  const runId = readRunIdArgument(cli);
  const resolvedCwd = resolve(cli.cwd ?? process.cwd());
  const sdkOptions = buildSdkOptions(cli, resolvedCwd);
  const eventLog: Array<Record<string, JsonValue>> = [];
  const resolvedConfig = await loadAgentSdkConfig(sdkOptions);
  const lastProgressContentByRun = new Map<string, string>();
  const resumeColors = cli.output === 'pretty' ? new RunColorRegistry() : undefined;
  const eventListener = shouldListenForCliEvents(cli) ? (event: AgentEvent) => {
    const entry = summarizeEvent(event);
    eventLog.push(entry);
    if (resumeColors && cli.progress) {
      printRunBoundaryEvent(event, resolvedConfig.tui, resumeColors, cli.wrapWidth);
    }
    if (cli.events && cli.output === 'pretty') {
      printEvent(entry, resolvedConfig.tui, resumeColors);
    } else if (cli.progress && cli.output === 'pretty') {
      printProgressEvent(event, lastProgressContentByRun, resolvedConfig.tui, cli.showLines, cli.wrapWidth, resumeColors);
    }
  } : undefined;

  const sdk = await createAgentSdk({ ...sdkOptions, eventListener });
  try {
    await assertRunAgentMatchesLoadedAgent(sdk, runId);
    const result = await sdk.resume(runId);
    if (cli.output === 'json') {
      console.log(JSON.stringify({ command: 'resume', runId, result: summarizeResult(result) }, null, 2));
    } else if (cli.output === 'jsonl') {
      console.log(JSON.stringify({ command: 'resume', runId, result: summarizeResult(result) }));
    } else {
      printResult(result, 'run', resolvedConfig.tui);
      if (cli.events && eventLog.length > 0) console.error(`event log captured: ${eventLog.length}`);
    }
    return isSuccessfulResult(result) ? 0 : 1;
  } finally {
    await sdk.close();
  }
}

async function runRecoverCommand(cli: ManualTestCliOptions): Promise<number> {
  const runId = readRunIdArgument(cli);
  const resolvedCwd = resolve(cli.cwd ?? process.cwd());
  const sdkOptions = buildSdkOptions(cli, resolvedCwd);
  const eventLog: Array<Record<string, JsonValue>> = [];
  const resolvedConfig = await loadAgentSdkConfig(sdkOptions);
  const lastProgressContentByRun = new Map<string, string>();
  const recoverColors = cli.output === 'pretty' ? new RunColorRegistry() : undefined;
  const eventListener = shouldListenForCliEvents(cli) && !cli.dryRun ? (event: AgentEvent) => {
    const entry = summarizeEvent(event);
    eventLog.push(entry);
    if (recoverColors && cli.progress) {
      printRunBoundaryEvent(event, resolvedConfig.tui, recoverColors, cli.wrapWidth);
    }
    if (cli.events && cli.output === 'pretty') {
      printEvent(entry, resolvedConfig.tui, recoverColors);
    } else if (cli.progress && cli.output === 'pretty') {
      printProgressEvent(event, lastProgressContentByRun, resolvedConfig.tui, cli.showLines, cli.wrapWidth, recoverColors);
    }
  } : undefined;

  const initialSdk = await createAgentSdk({ ...sdkOptions, eventListener });
  let sdk = initialSdk;
  try {
    sdk = await resolveSdkForRunAgent(initialSdk, sdkOptions, runId, cli.agentConfigPath, eventListener);
    const plan = await sdk.getRecoveryPlan(runId);

    if (cli.dryRun) {
      if (cli.output === 'json') {
        console.log(JSON.stringify({ command: 'recover', runId, dryRun: true, plan }, null, 2));
      } else if (cli.output === 'jsonl') {
        console.log(JSON.stringify({ command: 'recover', runId, dryRun: true, plan }));
      } else {
        printRecoveryPlan(plan);
      }
      return plan.executable ? 0 : 1;
    }

    const recovered = await sdk.recover({
      runId,
      strategy: cli.recoveryStrategy,
    });

    if (cli.output === 'json') {
      console.log(JSON.stringify({
        command: 'recover',
        runId,
        action: recovered.action,
        plan: recovered.plan,
        result: recovered.result ? summarizeResult(recovered.result) : undefined,
      }, null, 2));
    } else if (cli.output === 'jsonl') {
      console.log(JSON.stringify({
        command: 'recover',
        runId,
        action: recovered.action,
        result: recovered.result ? summarizeResult(recovered.result) : undefined,
      }));
    } else {
      console.log(`recover: action=${recovered.action} run=${runId}`);
      if (recovered.result) {
        printResult(recovered.result, 'run', resolvedConfig.tui);
      }
      if (cli.events && eventLog.length > 0) console.error(`event log captured: ${eventLog.length}`);
    }

    return recovered.result ? (isSuccessfulResult(recovered.result) ? 0 : 1) : 0;
  } finally {
    if (sdk !== initialSdk) await sdk.close();
    await initialSdk.close();
  }
}

async function runContinueCommand(cli: ManualTestCliOptions): Promise<number> {
  const runId = readRunIdArgument(cli);
  const resolvedCwd = resolve(cli.cwd ?? process.cwd());
  const sdkOptions = buildSdkOptions(cli, resolvedCwd);
  const eventLog: Array<Record<string, JsonValue>> = [];
  const resolvedConfig = await loadAgentSdkConfig(sdkOptions);
  const lastProgressContentByRun = new Map<string, string>();
  const continuationColors = cli.output === 'pretty' ? new RunColorRegistry() : undefined;
  const eventListener = shouldListenForCliEvents(cli) && !cli.dryRun ? (event: AgentEvent) => {
    const entry = summarizeEvent(event);
    eventLog.push(entry);
    if (continuationColors && cli.progress) {
      printRunBoundaryEvent(event, resolvedConfig.tui, continuationColors, cli.wrapWidth);
    }
    if (cli.events && cli.output === 'pretty') {
      printEvent(entry, resolvedConfig.tui, continuationColors);
    } else if (cli.progress && cli.output === 'pretty') {
      printProgressEvent(event, lastProgressContentByRun, resolvedConfig.tui, cli.showLines, cli.wrapWidth, continuationColors);
    }
  } : undefined;

  const initialSdk = await createAgentSdk({ ...sdkOptions, eventListener });
  let sdk = initialSdk;
  try {
    sdk = await resolveSdkForRunAgent(initialSdk, sdkOptions, runId, cli.agentConfigPath, eventListener);

    if (cli.dryRun) {
      const recovery = await sdk.getRecoveryOptions(runId);
      if (cli.output === 'json') {
        console.log(JSON.stringify({ command: 'continue', sourceRunId: runId, dryRun: true, recovery }, null, 2));
      } else if (cli.output === 'jsonl') {
        console.log(JSON.stringify({ command: 'continue', sourceRunId: runId, dryRun: true, recovery }));
      } else {
        console.log(`continue ${runId}: ${recovery.decision}`);
        console.log(`continuable: ${recovery.continuable ? 'yes' : 'no'}`);
        console.log(`reason: ${recovery.reason}`);
        if (recovery.recommendedStrategy) console.log(`strategy: ${recovery.recommendedStrategy}`);
        if (recovery.lastCompletedStepId) console.log(`last completed step: ${recovery.lastCompletedStepId}`);
        if (recovery.nextStepId) console.log(`next step: ${recovery.nextStepId}`);
        if (recovery.unsafeReason) console.log(`unsafe reason: ${recovery.unsafeReason}`);
      }
      return recovery.continuable && !recovery.requiresReconciliation ? 0 : 1;
    }

    const result = await sdk.continueRun({ fromRunId: runId });

    if (cli.output === 'json') {
      console.log(JSON.stringify({ command: 'continue', sourceRunId: runId, result: summarizeResult(result) }, null, 2));
    } else if (cli.output === 'jsonl') {
      console.log(JSON.stringify({ command: 'continue', sourceRunId: runId, result: summarizeResult(result) }));
    } else {
      console.log(`continue: source=${runId} run=${result.runId}`);
      printResult(result, 'run', resolvedConfig.tui);
      if (cli.events && eventLog.length > 0) console.error(`event log captured: ${eventLog.length}`);
    }

    return isSuccessfulResult(result) ? 0 : 1;
  } finally {
    if (sdk !== initialSdk) await sdk.close();
    await initialSdk.close();
  }
}

function printRecoveryPlan(plan: RunRecoveryPlan): void {
  console.log(`recover ${plan.runId}: ${plan.action}`);
  console.log(`status: ${plan.status}`);
  console.log(`executable: ${plan.executable ? 'yes' : 'no'}`);
  console.log(`reason: ${plan.reason}`);
  if (plan.retryability) {
    console.log(`retryable: ${plan.retryability.retryable ? 'yes' : 'no'} (${plan.retryability.failureKind})`);
    if (plan.retryability.reason) console.log(`retry reason: ${plan.retryability.reason}`);
  }
  if (plan.recovery?.lastCompletedStepId) console.log(`last completed step: ${plan.recovery.lastCompletedStepId}`);
  if (plan.recovery?.nextStepId) console.log(`next step: ${plan.recovery.nextStepId}`);
  if (plan.recovery?.unsafeReason) console.log(`unsafe reason: ${plan.recovery.unsafeReason}`);
}

async function runInterruptCommand(cli: ManualTestCliOptions): Promise<number> {
  const runId = readRunIdArgument(cli);
  const resolvedCwd = resolve(cli.cwd ?? process.cwd());
  const sdkOptions = buildSdkOptions(cli, resolvedCwd);
  const resolvedConfig = await loadAgentSdkConfig(sdkOptions);
  const eventLog: Array<Record<string, JsonValue>> = [];
  const interruptColors = cli.output === 'pretty' ? new RunColorRegistry() : undefined;
  const eventListener = cli.events ? (event: AgentEvent) => {
    const entry = summarizeEvent(event);
    eventLog.push(entry);
    if (cli.output === 'pretty') {
      printEvent(entry, resolvedConfig.tui, interruptColors);
    }
  } : undefined;

  const sdk = await createAgentSdk({ ...sdkOptions, eventListener });
  try {
    await sdk.interrupt(runId);
    if (cli.output === 'json') {
      console.log(JSON.stringify({ command: 'interrupt', runId, status: 'requested' }, null, 2));
    } else if (cli.output === 'jsonl') {
      console.log(JSON.stringify({ command: 'interrupt', runId, status: 'requested' }));
    } else {
      console.log(`interrupt requested for ${runId}`);
      if (cli.events && eventLog.length > 0) console.error(`event log captured: ${eventLog.length}`);
    }
    return 0;
  } finally {
    await sdk.close();
  }
}

async function runReplayCommand(cli: ManualTestCliOptions): Promise<number> {
  const runId = readRunIdArgument(cli);
  const resolvedCwd = resolve(cli.cwd ?? process.cwd());
  const sdk = await createAgentSdk(buildSdkOptions(cli, resolvedCwd));
  try {
    const inspection = await sdk.inspect(runId);
    const events = inspection.events.map((event) => summarizeEvent(event));
    if (cli.output === 'json') {
      console.log(JSON.stringify({ command: 'replay', runId, run: inspection.run, eventCount: events.length, events }, null, 2));
    } else if (cli.output === 'jsonl') {
      console.log(JSON.stringify({ command: 'replay', runId, type: 'run', run: inspection.run, eventCount: events.length }));
      for (const event of events) {
        console.log(JSON.stringify({ command: 'replay', runId, type: 'event', event }));
      }
    } else {
      console.log(`replay ${runId}: ${events.length} event(s)`);
      const replayLabels = new AgentEventLabelRegistry();
      for (const event of inspection.events) {
        console.log(`[event] ${formatAgentEventSummary(summarizeAgentEvent(event, replayLabels))}`);
      }
      if (inspection.run?.result !== undefined) {
        console.log('');
        console.log('result:');
        console.log(renderPrettyValue(inspection.run.result));
      }
    }
    return inspection.run ? 0 : 1;
  } finally {
    await sdk.close();
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
      await assertRunAgentMatchesLoadedAgent(coordinatorSdk, cli.runId);
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
  const swarmSdk = await createSwarmSdk({ ...sdkOptions, coordinatorSdk, workerConfigPaths: cli.workerCatalogPaths, qualityConfigPath: cli.qualityAgentPath, synthesizerConfigPath: cli.synthesizerAgentPath, eventListener, maxWorkers: cli.maxWorkers });

  try {
    const result = await swarmSdk.retrySession(sessionId, { dryRun: cli.dryRun, maxWorkers: cli.maxWorkers });
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
    await swarmSdk.close();
    await coordinatorSdk.close();
  }
}

async function runConfigCommand(cli: ManualTestCliOptions): Promise<number> {
  const resolvedCwd = resolve(cli.cwd ?? process.cwd());
  const sdkOptions = buildSdkOptions(cli, resolvedCwd);
  const resolvedConfig = await loadAgentSdkConfig(sdkOptions);
  const providerEnv = { ...(sdkOptions.env ?? process.env), ...(resolvedConfig.settings.env ?? {}) };
  const webSearchProvider = resolveWebSearchProvider(providerEnv);
  const readWebPageProvider = resolveReadWebPageProvider(providerEnv);
  if (cli.output === 'json') {
    console.log(JSON.stringify({ ...resolvedConfig, webSearch: { provider: webSearchProvider }, readWebPage: { provider: readWebPageProvider } }, null, 2));
    return 0;
  }
  console.log(`agent: ${resolvedConfig.agent.id} (${resolvedConfig.agent.name})`);
  console.log(`model: ${resolvedConfig.model.provider}/${resolvedConfig.model.model}`);
  console.log(`webSearchProvider: ${webSearchProvider}`);
  console.log(`readWebPageProvider: ${readWebPageProvider}`);
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
    contextRefs: [],
    contextInputs: [],
    contextBundleRefs: [],
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
    recoveryStrategy: 'auto',
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
    if (!commandSeen && arg === 'help') {
      options.help = true;
      continue;
    }

    if (!commandSeen && isCliCommand(arg)) {
      options.command = arg;
      if (options.help) options.helpTopic = arg;
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
        if (commandSeen) options.helpTopic = options.command;
        break;
      case '--version':
        if (options.command === 'update') {
          options.updateVersion = requireOptionValue(arg, argv[++index]);
          break;
        }
        options.command = 'version';
        if (options.help) options.helpTopic = 'version';
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
        if (options.help) options.helpTopic = 'spec';
        break;
      case '--config':
        options.ambientConfigPath = requireOptionValue(arg, argv[++index]);
        break;
      case '--file':
        options.promptFilePath = requireOptionValue(arg, argv[++index]);
        break;
      case '--input-json':
        options.inputJson = parseJsonFlag(requireOptionValue(arg, argv[++index]), arg);
        break;
      case '--context-ref':
        {
          const ref = parseContextRefFlag(requireOptionValue(arg, argv[++index]), arg);
          options.contextRefs.push(ref);
          options.contextInputs.push({ kind: 'ref', ref });
        }
        break;
      case '--context-bundle':
        options.contextInputs.push({ kind: 'bundle', name: requireOptionValue(arg, argv[++index]) });
        break;
      case '--ref':
        options.contextBundleRefs.push(parseContextRefFlag(requireOptionValue(arg, argv[++index]), arg));
        break;
      case '--description':
        options.contextBundleDescription = requireOptionValue(arg, argv[++index]);
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
      case '--strategy':
        options.recoveryStrategy = parseEnumOption(arg, requireOptionValue(arg, argv[++index]), ['auto', 'resume', 'retry', 'continue']);
        break;
      case '--output':
        options.output = parseEnumOption(arg, requireOptionValue(arg, argv[++index]), ['pretty', 'json', 'jsonl']);
        break;
      default:
        if (options.command === 'run' || options.command === 'chat' || options.command === 'swarm-run' || options.command === 'ambient' || options.command === 'inspect' || options.command === 'resume' || options.command === 'retry' || options.command === 'recover' || options.command === 'continue' || options.command === 'interrupt' || options.command === 'replay' || options.command === 'agent-create' || options.command === 'context') {
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

  if (!options.help && options.ambientConfigPath && options.command !== 'ambient') {
    throw new Error('--config is supported for ambient start requests');
  }

  if (!options.help && options.command === 'ambient') {
    if (options.goalArgs.length !== 1 || options.goalArgs[0] !== 'start') {
      throw new Error('ambient currently supports only: adaptive-agent ambient start --config <path>');
    }
    if (!options.ambientConfigPath) {
      throw new Error('ambient start requires --config <path>');
    }
    if (options.promptFilePath) throw new Error('--file is not supported for ambient start requests');
    if (options.inputJson !== undefined) throw new Error('--input-json is not supported for ambient start requests');
    if (options.imagePaths.length > 0 || options.audioPaths.length > 0 || options.fileAttachmentPaths.length > 0) {
      throw new Error('--image, --audio, and --file-attachment are not supported for ambient start requests');
    }
    if (options.orchestrate) throw new Error('--orchestrate is not supported for ambient start requests');
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

  if (!options.help && options.command === 'context') {
    const [action, name, ...extra] = options.goalArgs;
    if (action !== 'create' && action !== 'list' && action !== 'show' && action !== 'delete') {
      throw new Error('context requires one of: create, list, show, delete');
    }
    if (action === 'list') {
      if (name !== undefined) throw new Error('context list does not accept a bundle name');
    } else if (!name || extra.length > 0) {
      throw new Error(`context ${action} requires exactly one bundle name`);
    }
    if (action === 'create') {
      if (options.contextBundleRefs.length === 0) throw new Error('context create requires at least one --ref run:<id> or --ref session:<id>');
    } else {
      if (options.contextBundleRefs.length > 0) throw new Error('--ref is supported for context create only');
      if (options.contextBundleDescription !== undefined) throw new Error('--description is supported for context create only');
      if (options.force) throw new Error('--force is supported for context create only');
    }
  }

  if (!options.help && options.command !== 'context') {
    if (options.contextBundleRefs.length > 0) throw new Error('--ref is supported for context create only');
    if (options.contextBundleDescription !== undefined) throw new Error('--description is supported for context create only');
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
    if (options.contextRefs.length > 0) {
      throw new Error('--context-ref is supported for direct run and chat requests, not swarm-run');
    }
  }

  if (!options.help && options.contextRefs.length > 0 && options.command !== 'run' && options.command !== 'chat') {
    throw new Error('--context-ref is supported for direct run and chat requests only');
  }

  const contextBundleInputCount = options.contextInputs.filter((input) => input.kind === 'bundle').length;
  if (!options.help && contextBundleInputCount > 0 && options.command !== 'run' && options.command !== 'chat') {
    throw new Error('--context-bundle is supported for direct run and chat requests only');
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

  if (!options.help && isSingleRunCommand(options.command)) {
    if (options.runId) {
      if (options.goalArgs.length > 0) {
        throw new Error(`${options.command} accepts --run-id <runId> or one positional <runId>, but not both`);
      }
    } else if (options.goalArgs.length !== 1 || !options.goalArgs[0]?.trim()) {
      throw new Error(`${options.command} requires --run-id <runId> or exactly one positional <runId>`);
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

  if (!options.help && options.orchestrate && contextBundleInputCount > 0) {
    throw new Error('--context-bundle is not supported with --orchestrate until stage propagation semantics are defined');
  }

  if (!options.help && options.orchestrate && options.contextRefs.length > 0) {
    throw new Error('--context-ref is not supported with --orchestrate until stage propagation semantics are defined');
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
      ? part.image.url ? 'url' : 'path'
      : part.type === 'file'
        ? part.file.source.kind
        : part.audio.source.kind;
    if (!supportedSources.includes(sourceKind)) {
      warnings.push(`Provider "${provider}" does not support ${part.type} source "${sourceKind}" in the current adapter; this request will likely fail.`);
    }
  }

  return warnings;
}

function buildSdkOptions(cli: ManualTestCliOptions, cwd: string): AgentSdkOptions {
  return {
    cwd,
    agentConfigPath: cli.agentConfigPath,
    settingsConfigPath: cli.settingsConfigPath,
    runtimeMode: cli.runtimeMode,
    model: cli.provider || cli.model ? { ...(cli.provider ? { provider: cli.provider } : {}), ...(cli.model ? { model: cli.model } : {}) } : undefined,
    settingsOverrides: cli.approvalMode || cli.clarificationMode
      ? {
          interaction: {
            ...(cli.approvalMode ? { approvalMode: cli.approvalMode } : {}),
            ...(cli.clarificationMode ? { clarificationMode: cli.clarificationMode } : {}),
          },
        }
      : undefined,
  };
}

function summarizeAmbientStartResult(result: AmbientStartResult): JsonValue {
  return {
    status: result.status,
    config: {
      workspaceRoot: result.config.workspaceRoot,
      artifactsRoot: result.config.artifactsRoot,
      agentConfigPath: result.config.agentConfigPath ?? null,
      settingsConfigPath: result.config.settingsConfigPath ?? null,
      runtimeMode: result.config.runtimeMode ?? null,
      interaction: result.config.interaction,
      triggers: result.config.triggers.map((trigger): JsonObject => trigger.type === 'filesystem'
        ? {
            id: trigger.id,
            type: trigger.type,
            inboxDir: trigger.inboxDir,
            pendingDir: trigger.pendingDir,
            processingDir: trigger.processingDir,
            processedDir: trigger.processedDir,
            failedDir: trigger.failedDir,
            pattern: trigger.pattern,
            pollIntervalMs: trigger.pollIntervalMs,
            stabilityDelayMs: trigger.stabilityDelayMs,
          }
        : {
            id: trigger.id,
            type: trigger.type,
            schedule: trigger.schedule,
            timezone: trigger.timezone,
            goalFilePath: trigger.goalFilePath ?? null,
            artifactPath: trigger.artifactPath ?? null,
            ledgerPath: trigger.ledgerPath,
            pollIntervalMs: trigger.pollIntervalMs,
            concurrency: trigger.concurrency,
            misfirePolicy: trigger.misfirePolicy,
          }),
    },
    sdk: {
      cwd: result.sdkOptions.cwd ?? null,
      agentConfigPath: result.sdkOptions.agentConfigPath ?? null,
      settingsConfigPath: result.sdkOptions.settingsConfigPath ?? null,
      runtimeMode: result.sdkOptions.runtimeMode ?? null,
    },
    tasks: result.tasks as unknown as JsonValue,
  };
}

function buildChatOptions(spec: ManualChatSpec): AgentSdkChatOptions {
  return {
    contextRefs: spec.contextRefs,
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
    contextRefs: spec.contextRefs,
    context: spec.context,
    outputSchema: spec.outputSchema,
    metadata: spec.metadata,
  };
}

function buildInlineContentParts(cli: ManualTestCliOptions, cwd: string, options: { includeImages: boolean }): ModelContentPart[] {
  return [
    ...(options.includeImages ? cli.imagePaths.map((value) => ({
      type: 'image' as const,
      image: buildInlineImageInput(value, cwd),
    })) : []),
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

function buildInlineImageInput(value: string, cwd: string): ImageInput {
  return isUrlInput(value)
    ? { url: value }
    : { path: resolveAssetPath(value, cwd) };
}

function isUrlInput(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'data:';
  } catch {
    return false;
  }
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
    contextRefs: parseOptionalContextRefs(raw.contextRefs, 'contextRefs'),
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
    contextRefs: parseOptionalContextRefs(raw.contextRefs, 'contextRefs'),
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
  const hasPath = raw.path !== undefined;
  const hasUrl = raw.url !== undefined;
  if (hasPath === hasUrl) {
    throw new Error(`${label} must include exactly one of path or url`);
  }
  return {
    ...(hasPath
      ? { path: resolveAssetPath(requireString(raw.path, `${label}.path`), baseDir) }
      : { url: requireString(raw.url, `${label}.url`) }),
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

function parseOptionalContextRefs(value: unknown, label: string): ContextRef[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value.map((entry, index) => parseContextRef(entry, `${label}[${index}]`));
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

function isMissingInlinePromptError(error: unknown, label: string): boolean {
  return error instanceof Error && error.message === `Missing ${label}; provide positional text, --file <path>, or stdin.`;
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
      path: pathFromImageInput(image),
    };
  }

  for (const part of benchmarkCase.contentParts ?? []) {
    if (part.type === 'image') {
      return {
        type: 'image',
        ...(part.image.name ? { fileName: part.image.name } : {}),
        path: pathFromImageInput(part.image),
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

function pathFromImageInput(image: ImageInput): string | undefined {
  if (image.path) return image.path;
  if (image.url) {
    try {
      return new URL(image.url).pathname;
    } catch {
      return image.url;
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
  const providerEnv = { ...process.env, ...(config.settings.env ?? {}) };
  const webSearchProvider = resolveWebSearchProvider(providerEnv);
  const readWebPageProvider = resolveReadWebPageProvider(providerEnv);
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
    `- \`webSearchProvider\`: \`${webSearchProvider}\``,
    `- \`readWebPageProvider\`: \`${readWebPageProvider}\``,
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
    webSearch: { provider: resolveWebSearchProvider({ ...process.env, ...(inspection.config.settings.env ?? {}) }) },
    readWebPage: { provider: resolveReadWebPageProvider({ ...process.env, ...(inspection.config.settings.env ?? {}) }) },
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
    if (part.type === 'image' && part.image.path) return [{ path: part.image.path, label: `image ${part.image.name ?? part.image.path}` }];
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
