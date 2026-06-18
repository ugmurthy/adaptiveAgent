import Ajv, { type ErrorObject } from 'ajv';

import { AgentConfigValidationError, AgentSettingsValidationError } from './errors.js';
import type { AgentConfigFile, AgentSettingsFile } from './config-types.js';

const STRUCTURED_OUTPUT_MODES = ['prompted', 'strict'] as const;

const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
const agentValidator = ajv.compile({ type: 'object', required: ['id', 'name', 'invocationModes', 'defaultInvocationMode', 'model', 'tools'], additionalProperties: true, properties: { id: { type: 'string', minLength: 1 }, name: { type: 'string', minLength: 1 }, invocationModes: { type: 'array', items: { enum: ['run', 'chat'] }, minItems: 1 }, defaultInvocationMode: { enum: ['run', 'chat'] }, model: { type: 'object', additionalProperties: true }, tools: { type: 'array', items: { type: 'string', minLength: 1 } }, delegates: { type: 'array', items: { type: 'string' }, nullable: true }, metadata: { type: 'object', nullable: true }, routing: { type: 'object', additionalProperties: true, nullable: true, properties: { keywords: { type: 'array', nullable: true, items: { type: 'string', minLength: 1 } } } }, capabilities: { type: 'object', additionalProperties: true, nullable: true, properties: { modalitiesSupported: { type: 'array', nullable: true, items: { enum: ['text', 'image', 'file', 'audio'] } }, modalitiesPreferred: { type: 'array', nullable: true, items: { enum: ['text', 'image', 'file', 'audio'] } }, modalityRoles: { type: 'object', additionalProperties: { enum: ['ingest', 'analyze', 'summarize', 'synthesize'] }, nullable: true }, subjectsPreferred: { type: 'array', nullable: true, items: { type: 'string', minLength: 1 } } } } } });
const settingsValidator = ajv.compile({ type: 'object', additionalProperties: true, properties: { runtime: { type: 'object', additionalProperties: true, nullable: true, properties: { mode: { type: 'string', enum: ['memory', 'postgres'], nullable: true }, autoMigrate: { type: 'boolean', nullable: true } } }, logging: { type: 'object', additionalProperties: true, nullable: true, properties: { destination: { type: 'string', enum: ['console', 'file', 'both'], nullable: true } } } } });

export function validateAgent(value: unknown, path: string): AgentConfigFile {
  if (!agentValidator(value)) throw new AgentConfigValidationError(path, formatAjvErrors('agent', agentValidator.errors));
  const config = value as AgentConfigFile;
  if (!config.invocationModes.includes(config.defaultInvocationMode)) throw new AgentConfigValidationError(path, ['agent.defaultInvocationMode must be included in agent.invocationModes']);
  validateStructuredOutputMode(config.model.structuredOutputMode, path, 'agent.model.structuredOutputMode', AgentConfigValidationError);
  return { ...config, delegates: config.delegates ?? [] };
}

export function validateSettings(value: unknown, path: string): AgentSettingsFile {
  if (!settingsValidator(value)) throw new AgentSettingsValidationError(path, formatAjvErrors('settings', settingsValidator.errors));
  const settings = value as AgentSettingsFile;
  if ((settings.logging?.destination === 'file' || settings.logging?.destination === 'both') && !settings.logging.filePath) throw new AgentSettingsValidationError(path, ['settings.logging.filePath is required when logging.destination is "file" or "both"']);
  validateStructuredOutputMode(settings.model?.overrideStructuredOutputMode, path, 'settings.model.overrideStructuredOutputMode', AgentSettingsValidationError);
  return settings;
}

function validateStructuredOutputMode(
  value: unknown,
  path: string,
  propertyPath: string,
  ErrorClass: typeof AgentConfigValidationError | typeof AgentSettingsValidationError,
): void {
  if (value === undefined || STRUCTURED_OUTPUT_MODES.includes(value as (typeof STRUCTURED_OUTPUT_MODES)[number])) {
    return;
  }

  throw new ErrorClass(path, [`${propertyPath} must be one of: ${STRUCTURED_OUTPUT_MODES.join(', ')}`]);
}

function formatAjvErrors(prefix: string, errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) => `${prefix}${error.instancePath.replaceAll('/', '.')} ${error.message ?? 'is invalid'}`);
}
