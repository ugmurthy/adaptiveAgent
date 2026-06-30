import type {
  ChatMessage,
  ImageInput,
  JsonSchema,
  JsonValue,
  ModelContentPart,
} from '@adaptive-agent/core';

import type { ApprovalMode, ClarificationMode, RuntimeMode, createAgentSdk } from './index.js';
import type { InitProfile } from './install/init.js';

export interface ManualTestCliOptions {
  command: 'run' | 'chat' | 'spec' | 'config' | 'catalog' | 'eval' | 'swarm-run' | 'inspect' | 'resume' | 'retry' | 'recover' | 'interrupt' | 'replay' | 'init' | 'doctor' | 'update' | 'uninstall' | 'agent-create' | 'version';
  specPath: string;
  goalArgs: string[];
  runId?: string;
  promptFilePath?: string;
  inputJson?: JsonValue;
  imagePaths: string[];
  audioPaths: string[];
  fileAttachmentPaths: string[];
  orchestrate: boolean;
  agentCatalogPaths: string[];
  workerCatalogPaths: string[];
  qualityAgentPath?: string;
  synthesizerAgentPath?: string;
  maxWorkers?: number;
  sessionId?: string;
  evalDataset?: 'cases' | 'gaia';
  evalInputPath?: string;
  evalFilesDir?: string;
  evalOutputPath?: string;
  evalArtifactsDir?: string;
  evalResume: boolean;
  evalFailFast: boolean;
  evalSwarm: number;
  evalLimit?: number;
  evalOffset: number;
  evalIds?: string[];
  evalLevel?: string;
  evalSplit?: string;
  evalType?: BenchmarkAttachmentType;
  recoveryStrategy: 'auto' | 'resume' | 'retry' | 'continue';
  mode?: 'chat' | 'run';
  cwd?: string;
  agentConfigPath?: string;
  generatorAgentPath?: string;
  agentCreateId?: string;
  settingsConfigPath?: string;
  runtimeMode?: RuntimeMode;
  provider?: 'openrouter' | 'ollama' | 'mistral' | 'mesh';
  model?: string;
  apiKeyEnv?: string;
  profile?: InitProfile;
  minimal: boolean;
  bundles: string[];
  installAgents: string[];
  installSkills: string[];
  installManifests: string[];
  approvalMode?: ApprovalMode;
  clarificationMode?: ClarificationMode;
  yes: boolean;
  force: boolean;
  network: boolean;
  providerCheck: boolean;
  strict: boolean;
  updateCheck: boolean;
  updateVersion?: string;
  updateChannel: 'stable' | 'preview';
  updateRepo?: string;
  updateBaseUrl?: string;
  progress: boolean;
  events: boolean;
  inspect: boolean;
  showLines: number;
  wrapWidth?: number;
  dryRun: boolean;
  output: 'pretty' | 'json' | 'jsonl';
  help: boolean;
  helpTopic?: ManualTestCliOptions['command'];
}

export interface ManualChatSpec {
  mode: 'chat';
  messages: ChatMessage[];
  context?: Record<string, JsonValue>;
  outputSchema?: JsonSchema;
  metadata?: Record<string, JsonValue>;
}

export interface ManualRunSpec {
  mode: 'run';
  goal: string;
  input?: JsonValue;
  images?: ImageInput[];
  contentParts?: ModelContentPart[];
  context?: Record<string, JsonValue>;
  outputSchema?: JsonSchema;
  metadata?: Record<string, JsonValue>;
}

export type ManualTestSpec = ManualChatSpec | ManualRunSpec;

export interface ManualTestSummary {
  textParts: number;
  imageParts: number;
  fileParts: number;
  audioParts: number;
  legacyImages: number;
  messageCount: number;
}

export interface InspectionSummary {
  run: Awaited<ReturnType<Awaited<ReturnType<typeof createAgentSdk>>['created']['runtime']['runStore']['getRun']>>;
  eventCount: number;
  eventTypes: Record<string, number>;
}

export interface ManualTestJsonOutput {
  cli: Record<string, JsonValue>;
  resolvedConfig: Record<string, JsonValue>;
  request: JsonValue;
  warnings: string[];
  result: JsonValue;
  inspection?: JsonValue;
  orchestration?: JsonValue;
}

export interface BenchmarkCase {
  id: string;
  dataset?: string;
  split?: string;
  level?: string;
  question: string;
  input?: JsonValue;
  images?: ImageInput[];
  contentParts?: ModelContentPart[];
  expectedAnswer?: string;
  metadata?: Record<string, JsonValue>;
}

export interface BenchmarkResultRecord {
  schemaVersion: 1;
  dataset: string;
  taskId: string;
  level?: string;
  status: 'completed' | 'failed' | 'skipped';
  runId?: string;
  question: string;
  prediction?: JsonValue;
  predictionText?: string;
  expectedAnswer?: string;
  usage?: JsonValue;
  timings: { startedAt: string; finishedAt: string; durationMs: number };
  model: { provider: string; model: string };
  runtime: { mode: RuntimeMode };
  artifacts?: { eventLog?: string; inspection?: string; input?: string; output?: string; answer?: string };
  error?: { message: string; code?: string };
  metadata: Record<string, JsonValue>;
}

export type GaiaAttachment =
  | { kind: 'image'; path: string }
  | { kind: 'audio'; path: string; format: Extract<ModelContentPart, { type: 'audio' }>['audio']['format'] }
  | { kind: 'file'; path: string };

export type BenchmarkAttachmentType = 'audio' | 'image' | 'video' | 'other';
export type BenchmarkDryRunAttachmentType = BenchmarkAttachmentType | 'none';

export interface GaiaDryRunTaskSummary {
  taskId: string;
  attachmentType: BenchmarkDryRunAttachmentType;
  fileName?: string;
  path?: string;
  level?: string;
  split?: string;
}
