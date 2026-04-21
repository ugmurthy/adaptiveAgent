import { ConfigValidationError } from '../errors.js';
import type { AgentConfig } from './types.js';
import {
  expectNonEmptyString,
  expectObject,
  expectOptionalJsonObject,
  expectOptionalNonEmptyString,
  expectStringArray,
  parseAgentDefaults,
  parseAgentRoutingConfig,
  parseDefaultInvocationMode,
  parseInvocationModes,
  parseModelConfig,
} from './parse-shared.js';

export function validateAgentConfig(value: unknown, sourcePath: string): AgentConfig {
  const issues: string[] = [];
  const root = expectObject(value, 'agent', issues);

  const id = expectNonEmptyString(root?.id, 'id', issues) ?? 'invalid-agent-id';
  const name = expectNonEmptyString(root?.name, 'name', issues) ?? 'Invalid Agent';
  const invocationModes = parseInvocationModes(root?.invocationModes, 'invocationModes', issues);
  const defaultInvocationMode = parseDefaultInvocationMode(
    root?.defaultInvocationMode,
    invocationModes,
    'defaultInvocationMode',
    issues,
  );
  const model = parseModelConfig(root?.model, 'model', issues);
  const systemInstructions = expectOptionalNonEmptyString(root?.systemInstructions, 'systemInstructions', issues);
  const tools = expectStringArray(root?.tools, 'tools', issues) ?? [];
  const delegates = expectStringArray(root?.delegates, 'delegates', issues) ?? [];
  const defaults = parseAgentDefaults(root?.defaults, 'defaults', issues);
  const routing = parseAgentRoutingConfig(root?.routing, 'routing', issues);
  const metadata = expectOptionalJsonObject(root?.metadata, 'metadata', issues);

  if (issues.length > 0) {
    throw new ConfigValidationError('agent', sourcePath, issues);
  }

  return {
    id,
    name,
    invocationModes,
    defaultInvocationMode,
    model,
    systemInstructions,
    tools,
    delegates,
    defaults,
    routing,
    metadata,
  };
}
