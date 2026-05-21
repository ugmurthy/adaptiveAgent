#!/usr/bin/env bun

import { createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline/promises';

import type { JsonObject, JsonValue, ModelAdapterConfig, UsageSummary } from '@adaptive-agent/core';

import { createAgentSdk } from './index.js';

const SYSTEM_PROMPT = `You are an expert, impartial evaluation judge for AI model outputs on question-answering tasks (GAIA benchmark style).

Your job is to analyze a single JSON object, provided as a JSON string, and determine whether the model's predictionText contains the correct answer compared to the expectedAnswer.

STRICT EVALUATION RULES:

1. Ground Truth:
   - Use ONLY the value in "expectedAnswer" as the correct reference.
   - It is usually the shortest possible answer, such as a name, number, phrase, or entity.

2. Model Answer Extraction:
   - Look inside "predictionText" and optionally "prediction" to identify what the model actually claims is the answer.
   - The model may surround the answer with explanations, bolding, quotes, or extra context.
   - Extract the core answer the model is proposing.
   - Ignore reasoning, sources, and extra sentences. Focus on the final factual claim.

3. Correctness Criteria:
   - The extracted model answer must semantically match the expectedAnswer.
   - Minor formatting differences are allowed, including extra spaces, capitalization, articles, and punctuation.
   - Mark correct if the model clearly identifies the same answer, even when buried in a longer explanation.
   - Mark incorrect if:
     - The model gives a different name, number, phrase, or entity.
     - The model is uncertain or gives multiple possible answers.
     - The model hallucinates extra details that contradict the expected answer.
     - The model fails to provide a clear answer.

OUTPUT REQUIREMENTS:

- Return only valid JSON.
- Return exactly one JSON object with exactly one key: "answeredCorrectly".
- The value must be true or false.
- Do not echo the input object.
- Do not add explanations, markdown, or any other keys.`;

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    answeredCorrectly: { type: 'boolean' },
  },
  required: ['answeredCorrectly'],
} as const;

type Provider = ModelAdapterConfig['provider'];

interface CliOptions {
  inputPath: string;
  outputPath: string;
  provider: Provider;
  model: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  maxSteps: number;
  modelTimeoutMs: number;
  continueOnError: boolean;
}

interface Judgment extends JsonObject {
  answeredCorrectly: boolean;
}

interface EvaluationResult {
  judgment: Judgment;
  usage: UsageSummary;
}

const PROVIDER_DEFAULT_MODELS: Record<Provider, string> = {
  ollama: 'qwen3.5:latest',
  openrouter: 'openai/gpt-4.1-mini',
  mistral: 'mistral-large-latest',
  mesh: 'openai/gpt-4o-mini',
};

const PROVIDER_DEFAULT_API_KEY_ENV: Partial<Record<Provider, string>> = {
  openrouter: 'OPENROUTER_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  mesh: 'MESH_API_KEY',
};

const HELP = `GAIA JSONL evaluator using AdaptiveAgent.

Reads GAIA-style JSONL records, asks an AdaptiveAgent evaluator to return only
{ "answeredCorrectly": boolean }, merges that judgment into the original input
object, and writes judged JSONL output.

Usage:
  adaptive-agent-gaia-eval <input.jsonl> <output.jsonl> [options]
  bun run packages/agent-sdk/src/evaluate-gaia-jsonl.ts <input.jsonl> <output.jsonl> [options]

Options:
  --provider <name>         Model provider: ollama, openrouter, mistral, mesh.
                            Defaults to EVAL_PROVIDER or openrouter.
  --model <name>            Evaluator model name. Defaults to EVAL_MODEL or a
                            provider-specific default.
  --api-key-env <name>      Environment variable containing provider API key.
                            Defaults to EVAL_API_KEY_ENV, then provider default.
                            Not needed for ollama.
  --base-url <url>          Optional provider base URL. Defaults to EVAL_BASE_URL.
  --model-timeout-ms <n>    Per-row model timeout. Defaults to EVAL_MODEL_TIMEOUT_MS
                            or 60000.
  --max-steps <n>           AdaptiveAgent max steps per row. Defaults to 1.
  --continue-on-error       Write failed rows with answeredCorrectly=false and
                            evaluationError instead of stopping on the first error.
  -h, --help                Show this help.

Environment shortcuts:
  EVAL_PROVIDER             Same as --provider.
  EVAL_MODEL                Same as --model.
  EVAL_API_KEY_ENV          Same as --api-key-env.
  EVAL_BASE_URL             Same as --base-url.
  EVAL_MODEL_TIMEOUT_MS     Same as --model-timeout-ms.

Examples:
  OPENROUTER_API_KEY=sk-or-... \\
    adaptive-agent-gaia-eval gaia-results.jsonl gaia-judged.jsonl

  EVAL_PROVIDER=ollama EVAL_MODEL=qwen3.5:latest \\
    adaptive-agent-gaia-eval gaia-results.jsonl gaia-judged.jsonl
`;

const options = parseArgs(process.argv.slice(2));

const agent = await createAgentSdk({
  runtimeMode: 'memory',
  agentConfig: {
    id: 'gaia-evaluator',
    name: 'GAIA Evaluator',
    invocationModes: ['run'],
    defaultInvocationMode: 'run',
    model: {
      provider: options.provider,
      model: options.model,
      ...(options.apiKeyEnv ? { apiKeyEnv: options.apiKeyEnv } : {}),
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    },
    systemInstructions: SYSTEM_PROMPT,
    tools: [],
    defaults: {
      maxSteps: options.maxSteps,
      injectToolManifest: false,
      modelTimeoutMs: options.modelTimeoutMs,
    },
  },
});

const reader = createInterface({
  input: createReadStream(options.inputPath, { encoding: 'utf8' }),
  crlfDelay: Infinity,
});
const writer = createWriteStream(options.outputPath, { encoding: 'utf8' });

let lineNumber = 0;
let total = 0;
let correct = 0;
let failed = 0;
const totalUsage = createEmptyUsageSummary();

console.error(formatProgressHeader());

try {
  for await (const rawLine of reader) {
    lineNumber += 1;
    const line = rawLine.trim();
    if (!line) continue;

    try {
      const inputObject = parseInputObject(line, lineNumber);
      const { judgment, usage } = await evaluateLine(JSON.stringify(inputObject), lineNumber);
      addUsage(totalUsage, usage);
      const outputObject = Object.assign(inputObject, { answeredCorrectly: judgment.answeredCorrectly });

      writer.write(`${JSON.stringify(outputObject)}\n`);
      total += 1;
      if (judgment.answeredCorrectly) correct += 1;

      console.error(formatProgressRow(lineNumber, judgment.answeredCorrectly, usage));
    } catch (error) {
      failed += 1;
      if (!options.continueOnError) throw error;

      const fallbackObject = buildFallbackObject(line, error);
      writer.write(`${JSON.stringify(fallbackObject)}\n`);
      console.error(`line=${lineNumber} error=${formatError(error)}`);
    }
  }
} finally {
  await agent.close();
  writer.end();
}

const accuracy = total === 0 ? 0 : correct / total;
console.error(`Done. correct=${correct} total=${total} failed=${failed} accuracy=${accuracy.toFixed(4)} usage=${formatUsage(totalUsage)}`);

async function evaluateLine(inputJson: string, inputLine: number): Promise<EvaluationResult> {
  const result = await agent.run(inputJson, {
    outputSchema: OUTPUT_SCHEMA,
    metadata: {
      dataset: 'gaia',
      evaluator: 'adaptive-agent',
      inputLine,
    },
  });

  if (result.status !== 'success') {
    throw new Error(`AdaptiveAgent run did not succeed: status=${result.status}`);
  }

  const output = result.output;
  const judgment = typeof output === 'string' ? parseJudgmentOutput(output) : output;

  if (!isJsonObject(judgment) || typeof judgment.answeredCorrectly !== 'boolean') {
    throw new Error(`Evaluator returned invalid judgment: ${JSON.stringify(judgment)}`);
  }

  const keys = Object.keys(judgment);
  if (keys.length !== 1) {
    throw new Error(`Evaluator returned unexpected keys: ${keys.join(', ')}`);
  }

  return { judgment: judgment as Judgment, usage: result.usage };
}

function parseJudgmentOutput(output: string): JsonValue {
  const trimmed = output.trim();

  try {
    return JSON.parse(trimmed) as JsonValue;
  } catch {
    const fencedJson = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fencedJson) {
      return JSON.parse(fencedJson[1]) as JsonValue;
    }

    const objectJson = trimmed.match(/\{[\s\S]*\}/);
    if (objectJson) {
      return JSON.parse(objectJson[0]) as JsonValue;
    }

    throw new Error(`Evaluator returned non-JSON output: ${trimmed}`);
  }
}

function createEmptyUsageSummary(): UsageSummary {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimatedCostUSD: 0,
  };
}

function addUsage(total: UsageSummary, usage: UsageSummary): void {
  total.promptTokens += usage.promptTokens;
  total.completionTokens += usage.completionTokens;
  total.reasoningTokens = (total.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0);
  total.totalTokens = (total.totalTokens ?? 0) + (usage.totalTokens ?? usage.promptTokens + usage.completionTokens + (usage.reasoningTokens ?? 0));
  total.estimatedCostUSD += usage.estimatedCostUSD;
  total.provider = usage.provider ?? total.provider;
  total.model = usage.model ?? total.model;
}

function formatUsage(usage: UsageSummary): string {
  const totalTokens = usage.totalTokens ?? usage.promptTokens + usage.completionTokens + (usage.reasoningTokens ?? 0);
  const parts = [
    `prompt=${usage.promptTokens}`,
    `completion=${usage.completionTokens}`,
  ];

  if (usage.reasoningTokens !== undefined && usage.reasoningTokens > 0) {
    parts.push(`reasoning=${usage.reasoningTokens}`);
  }

  parts.push(`total=${totalTokens}`);
  parts.push(`cost=$${usage.estimatedCostUSD.toFixed(6)}`);

  return parts.join(',');
}

function formatProgressHeader(): string {
  return ['line', 'answeredCorrectly', 'prompt', 'completion', 'reasoning', 'total', 'cost'].join('\t');
}

function formatProgressRow(lineNumber: number, answeredCorrectly: boolean, usage: UsageSummary): string {
  const totalTokens = usage.totalTokens ?? usage.promptTokens + usage.completionTokens + (usage.reasoningTokens ?? 0);
  return [
    lineNumber,
    answeredCorrectly,
    usage.promptTokens,
    usage.completionTokens,
    usage.reasoningTokens ?? 0,
    totalTokens,
    `$${usage.estimatedCostUSD.toFixed(6)}`,
  ].join('\t');
}

function parseArgs(args: string[]): CliOptions {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    process.exit(0);
  }

  const positional: string[] = [];
  const flags = new Map<string, string | true>();

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('-')) {
      positional.push(arg);
      continue;
    }

    if (arg === '--continue-on-error') {
      flags.set(arg, true);
      continue;
    }

    const value = args[i + 1];
    if (!value || value.startsWith('-')) {
      failUsage(`Missing value for ${arg}`);
    }
    flags.set(arg, value);
    i += 1;
  }

  if (positional.length !== 2) {
    failUsage('Expected <input.jsonl> and <output.jsonl>.');
  }

  const provider = parseProvider(readStringFlag(flags, '--provider') ?? process.env.EVAL_PROVIDER ?? 'openrouter');
  const model = readStringFlag(flags, '--model') ?? process.env.EVAL_MODEL ?? PROVIDER_DEFAULT_MODELS[provider];
  const apiKeyEnv = readStringFlag(flags, '--api-key-env') ?? process.env.EVAL_API_KEY_ENV ?? PROVIDER_DEFAULT_API_KEY_ENV[provider];
  const baseUrl = readStringFlag(flags, '--base-url') ?? process.env.EVAL_BASE_URL;

  return {
    inputPath: positional[0],
    outputPath: positional[1],
    provider,
    model,
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    maxSteps: parsePositiveInt(readStringFlag(flags, '--max-steps') ?? process.env.EVAL_MAX_STEPS ?? '1', '--max-steps'),
    modelTimeoutMs: parsePositiveInt(
      readStringFlag(flags, '--model-timeout-ms') ?? process.env.EVAL_MODEL_TIMEOUT_MS ?? '60000',
      '--model-timeout-ms',
    ),
    continueOnError: flags.has('--continue-on-error'),
  };
}

function parseInputObject(line: string, lineNumber: number): JsonObject {
  const value = JSON.parse(line) as JsonValue;
  if (!isJsonObject(value) || Array.isArray(value)) {
    throw new Error(`Line ${lineNumber} is not a JSON object.`);
  }
  return value;
}

function buildFallbackObject(line: string, error: unknown): JsonObject {
  try {
    const inputObject = JSON.parse(line) as JsonValue;
    if (isJsonObject(inputObject) && !Array.isArray(inputObject)) {
      return Object.assign(inputObject, {
        answeredCorrectly: false,
        evaluationError: formatError(error),
      });
    }
  } catch {
    // Fall through to a synthetic failed row.
  }

  return {
    rawLine: line,
    answeredCorrectly: false,
    evaluationError: formatError(error),
  };
}

function parseProvider(value: string): Provider {
  if (value === 'ollama' || value === 'openrouter' || value === 'mistral' || value === 'mesh') return value;
  failUsage(`Unsupported provider "${value}". Expected ollama, openrouter, mistral, or mesh.`);
}

function parsePositiveInt(value: string, flagName: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    failUsage(`${flagName} must be a positive integer.`);
  }
  return parsed;
}

function readStringFlag(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

function isJsonObject(value: JsonValue | unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failUsage(message: string): never {
  console.error(`Error: ${message}\n`);
  console.error(HELP);
  process.exit(1);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
