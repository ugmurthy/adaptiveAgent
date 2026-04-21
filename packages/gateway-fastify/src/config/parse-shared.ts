import type {
  AdaptiveAgentLogDestination,
  AdaptiveAgentLogLevel,
  AgentDefaults,
  JsonObject,
  JsonValue,
  ModelAdapterConfig,
} from '../core.js';
import {
  AGENT_RUNTIME_LOG_DESTINATIONS,
  AGENT_RUNTIME_LOG_LEVELS,
  CAPTURE_MODES,
  GATEWAY_HOOK_SLOTS,
  HOOK_FAILURE_POLICIES,
  INVOCATION_MODES,
  MODEL_PROVIDERS,
  RESEARCH_POLICIES,
  REQUEST_LOG_LEVELS,
  TOOL_BUDGET_EXHAUSTED_ACTIONS,
  type AgentRoutingConfig,
  type GatewayAgentRuntimeLoggingConfig,
  type GatewayHooksConfig,
  type GatewayRequestLogLevel,
  type HookFailurePolicy,
  type InvocationMode,
} from './types.js';

export function parseGatewayRequestLoggingValue(
  value: unknown,
  path: string,
  issues: string[],
): boolean | GatewayRequestLogLevel | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    return expectEnum(value, REQUEST_LOG_LEVELS, path, issues);
  }

  issues.push(`${path} must be a boolean or one of: ${REQUEST_LOG_LEVELS.map((entry) => `"${entry}"`).join(', ')}.`);
  return undefined;
}

export function parseGatewayAgentRuntimeLoggingConfig(
  value: unknown,
  path: string,
  issues: string[],
): GatewayAgentRuntimeLoggingConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  const logging = expectObject(value, path, issues);

  return {
    enabled: expectBoolean(logging?.enabled, `${path}.enabled`, issues) ?? false,
    level:
      logging?.level === undefined
        ? undefined
        : expectEnum(logging.level, AGENT_RUNTIME_LOG_LEVELS as readonly AdaptiveAgentLogLevel[], `${path}.level`, issues),
    destination:
      logging?.destination === undefined
        ? undefined
        : expectEnum(logging.destination, AGENT_RUNTIME_LOG_DESTINATIONS as readonly AdaptiveAgentLogDestination[], `${path}.destination`, issues),
    filePath: expectOptionalNonEmptyString(logging?.filePath, `${path}.filePath`, issues),
  };
}

export function createDefaultHooksConfig(): GatewayHooksConfig {
  return {
    failurePolicy: 'fail',
    modules: [],
    onAuthenticate: [],
    onSessionResolve: [],
    beforeRoute: [],
    beforeInboundMessage: [],
    beforeRunStart: [],
    afterRunResult: [],
    onAgentEvent: [],
    beforeOutboundFrame: [],
    onDisconnect: [],
    onError: [],
  };
}

export function parseHookFailurePolicy(value: unknown, path: string, issues: string[]): HookFailurePolicy {
  if (value === undefined) {
    return 'fail';
  }

  return expectEnum(value, HOOK_FAILURE_POLICIES, path, issues) ?? 'fail';
}

export function parseInvocationModes(value: unknown, path: string, issues: string[]): InvocationMode[] {
  const invocationModes = expectStringArray(value, path, issues) ?? [];

  if (invocationModes.length === 0) {
    issues.push(`${path} must include at least one invocation mode.`);
    return ['chat'];
  }

  const seen = new Set<InvocationMode>();
  const parsedModes: InvocationMode[] = [];

  for (const invocationMode of invocationModes) {
    const parsedMode = expectEnum(invocationMode, INVOCATION_MODES, path, issues);
    if (!parsedMode || seen.has(parsedMode)) {
      continue;
    }

    seen.add(parsedMode);
    parsedModes.push(parsedMode);
  }

  return parsedModes.length > 0 ? parsedModes : ['chat'];
}

export function parseOptionalInvocationModes(value: unknown, path: string, issues: string[]): InvocationMode[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  return parseInvocationModes(value, path, issues);
}

export function parseDefaultInvocationMode(
  value: unknown,
  invocationModes: InvocationMode[],
  path: string,
  issues: string[],
): InvocationMode {
  const defaultInvocationMode = expectEnum(value, INVOCATION_MODES, path, issues) ?? invocationModes[0] ?? 'chat';

  if (!invocationModes.includes(defaultInvocationMode)) {
    issues.push(`${path} must be included in invocationModes.`);
  }

  return defaultInvocationMode;
}

export function parseModelConfig(value: unknown, path: string, issues: string[]): ModelAdapterConfig {
  const model = expectObject(value, path, issues);
  const provider = expectEnum(model?.provider, MODEL_PROVIDERS, `${path}.provider`, issues) ?? 'ollama';
  const modelName = expectNonEmptyString(model?.model, `${path}.model`, issues) ?? 'invalid-model';
  const apiKey = expectOptionalNonEmptyString(model?.apiKey, `${path}.apiKey`, issues);
  const baseUrl = expectOptionalNonEmptyString(model?.baseUrl, `${path}.baseUrl`, issues);
  const siteUrl = expectOptionalNonEmptyString(model?.siteUrl, `${path}.siteUrl`, issues);
  const siteName = expectOptionalNonEmptyString(model?.siteName, `${path}.siteName`, issues);

  return {
    provider,
    model: modelName,
    apiKey,
    baseUrl,
    siteUrl,
    siteName,
  };
}

export function parseAgentDefaults(value: unknown, path: string, issues: string[]): Partial<AgentDefaults> | undefined {
  if (value === undefined) {
    return undefined;
  }

  const defaults = expectObject(value, path, issues);
  const parsedDefaults: Partial<AgentDefaults> = {};

  assignIfDefined(parsedDefaults, 'maxSteps', expectOptionalPositiveInteger(defaults?.maxSteps, `${path}.maxSteps`, issues));
  assignIfDefined(
    parsedDefaults,
    'toolTimeoutMs',
    expectOptionalPositiveInteger(defaults?.toolTimeoutMs, `${path}.toolTimeoutMs`, issues),
  );
  assignIfDefined(
    parsedDefaults,
    'modelTimeoutMs',
    expectOptionalPositiveInteger(defaults?.modelTimeoutMs, `${path}.modelTimeoutMs`, issues),
  );
  assignIfDefined(
    parsedDefaults,
    'maxRetriesPerStep',
    expectOptionalPositiveInteger(defaults?.maxRetriesPerStep, `${path}.maxRetriesPerStep`, issues),
  );
  assignIfDefined(
    parsedDefaults,
    'requireApprovalForWriteTools',
    expectOptionalBoolean(defaults?.requireApprovalForWriteTools, `${path}.requireApprovalForWriteTools`, issues),
  );
  assignIfDefined(parsedDefaults, 'autoApproveAll', expectOptionalBoolean(defaults?.autoApproveAll, `${path}.autoApproveAll`, issues));

  if (defaults?.capture !== undefined) {
    const capture = expectEnum(defaults.capture, CAPTURE_MODES, `${path}.capture`, issues);
    if (capture) {
      parsedDefaults.capture = capture;
    }
  }

  if (defaults?.researchPolicy !== undefined) {
    const researchPolicy = parseResearchPolicy(defaults.researchPolicy, `${path}.researchPolicy`, issues);
    if (researchPolicy !== undefined) {
      parsedDefaults.researchPolicy = researchPolicy;
    }
  }

  if (defaults?.toolBudgets !== undefined) {
    const toolBudgets = parseToolBudgets(defaults.toolBudgets, `${path}.toolBudgets`, issues);
    if (toolBudgets !== undefined) {
      parsedDefaults.toolBudgets = toolBudgets;
    }
  }

  return Object.keys(parsedDefaults).length > 0 ? parsedDefaults : {};
}

export function parseResearchPolicy(value: unknown, path: string, issues: string[]): AgentDefaults['researchPolicy'] | undefined {
  if (typeof value === 'string') {
    return expectEnum(value, RESEARCH_POLICIES, path, issues);
  }

  const policy = expectObject(value, path, issues);
  if (!policy) {
    return undefined;
  }

  const mode = expectEnum(policy.mode, RESEARCH_POLICIES, `${path}.mode`, issues);
  if (!mode) {
    return undefined;
  }

  return {
    mode,
    maxSearches: expectOptionalNonNegativeInteger(policy.maxSearches, `${path}.maxSearches`, issues),
    maxPagesRead: expectOptionalNonNegativeInteger(policy.maxPagesRead, `${path}.maxPagesRead`, issues),
    checkpointAfter: expectOptionalNonNegativeInteger(policy.checkpointAfter, `${path}.checkpointAfter`, issues),
    requirePurpose: expectOptionalBoolean(policy.requirePurpose, `${path}.requirePurpose`, issues),
  };
}

export function parseToolBudgets(value: unknown, path: string, issues: string[]): NonNullable<AgentDefaults['toolBudgets']> | undefined {
  const rawBudgets = expectObject(value, path, issues);
  if (!rawBudgets) {
    return undefined;
  }

  const parsedBudgets: NonNullable<AgentDefaults['toolBudgets']> = {};
  for (const [groupName, rawBudget] of Object.entries(rawBudgets)) {
    const budget = expectObject(rawBudget, `${path}.${groupName}`, issues);
    if (!budget) {
      continue;
    }

    parsedBudgets[groupName] = {
      maxCalls: expectOptionalNonNegativeInteger(budget.maxCalls, `${path}.${groupName}.maxCalls`, issues),
      maxConsecutiveCalls: expectOptionalNonNegativeInteger(
        budget.maxConsecutiveCalls,
        `${path}.${groupName}.maxConsecutiveCalls`,
        issues,
      ),
      checkpointAfter: expectOptionalNonNegativeInteger(
        budget.checkpointAfter,
        `${path}.${groupName}.checkpointAfter`,
        issues,
      ),
      onExhausted:
        budget.onExhausted === undefined
          ? undefined
          : expectEnum(budget.onExhausted, TOOL_BUDGET_EXHAUSTED_ACTIONS, `${path}.${groupName}.onExhausted`, issues),
    };
  }

  return parsedBudgets;
}

export function parseAgentRoutingConfig(value: unknown, path: string, issues: string[]): AgentRoutingConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  const routing = expectObject(value, path, issues);

  return {
    allowedChannels: expectOptionalStringArray(routing?.allowedChannels, `${path}.allowedChannels`, issues),
    allowedTenants: expectOptionalStringArray(routing?.allowedTenants, `${path}.allowedTenants`, issues),
    requiredRoles: expectOptionalStringArray(routing?.requiredRoles, `${path}.requiredRoles`, issues),
  };
}

export function expectObject(value: unknown, path: string, issues: string[]): Record<string, unknown> | undefined {
  if (isRecord(value)) {
    return value;
  }

  issues.push(`${path} must be a JSON object.`);
  return undefined;
}

export function expectArray(value: unknown, path: string, issues: string[]): unknown[] | undefined {
  if (Array.isArray(value)) {
    return value;
  }

  issues.push(`${path} must be an array.`);
  return undefined;
}

export function expectBoolean(value: unknown, path: string, issues: string[]): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }

  issues.push(`${path} must be a boolean.`);
  return undefined;
}

export function expectOptionalBoolean(value: unknown, path: string, issues: string[]): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  return expectBoolean(value, path, issues);
}

export function expectPositiveInteger(value: unknown, path: string, issues: string[]): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }

  issues.push(`${path} must be a positive integer.`);
  return undefined;
}

export function expectOptionalPositiveInteger(value: unknown, path: string, issues: string[]): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  return expectPositiveInteger(value, path, issues);
}

export function expectOptionalNonNegativeInteger(value: unknown, path: string, issues: string[]): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value;
  }

  issues.push(`${path} must be a non-negative integer.`);
  return undefined;
}

export function expectNonEmptyString(value: unknown, path: string, issues: string[]): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }

  issues.push(`${path} must be a non-empty string.`);
  return undefined;
}

export function expectOptionalNonEmptyString(value: unknown, path: string, issues: string[]): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return expectNonEmptyString(value, path, issues);
}

export function expectHttpPath(value: unknown, path: string, issues: string[]): string | undefined {
  const pathValue = expectNonEmptyString(value, path, issues);
  if (!pathValue) {
    return undefined;
  }

  if (!pathValue.startsWith('/')) {
    issues.push(`${path} must start with "/".`);
    return undefined;
  }

  return pathValue;
}

export function expectOptionalHttpPath(value: unknown, path: string, issues: string[]): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return expectHttpPath(value, path, issues);
}

export function expectStringArray(value: unknown, path: string, issues: string[]): string[] | undefined {
  const items = expectArray(value, path, issues);
  if (!items) {
    return undefined;
  }

  const values: string[] = [];
  for (const [index, item] of items.entries()) {
    const parsedItem = expectNonEmptyString(item, `${path}[${index}]`, issues);
    if (parsedItem) {
      values.push(parsedItem);
    }
  }

  return values;
}

export function expectOptionalStringArray(value: unknown, path: string, issues: string[]): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  return expectStringArray(value, path, issues);
}

export function expectEnum<TValue extends string>(
  value: unknown,
  allowedValues: readonly TValue[],
  path: string,
  issues: string[],
): TValue | undefined {
  if (typeof value === 'string' && allowedValues.includes(value as TValue)) {
    return value as TValue;
  }

  issues.push(`${path} must be one of: ${allowedValues.join(', ')}.`);
  return undefined;
}

export function expectOptionalJsonObject(value: unknown, path: string, issues: string[]): JsonObject | undefined {
  if (value === undefined) {
    return undefined;
  }

  const jsonValue = toJsonValue(value, path, issues);
  if (jsonValue && typeof jsonValue === 'object' && !Array.isArray(jsonValue)) {
    return jsonValue as JsonObject;
  }

  issues.push(`${path} must be a JSON object.`);
  return undefined;
}

export function toJsonValue(value: unknown, path: string, issues: string[]): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    for (const [index, item] of value.entries()) {
      const jsonValue = toJsonValue(item, `${path}[${index}]`, issues);
      if (jsonValue !== undefined) {
        result.push(jsonValue);
      }
    }

    return result;
  }

  if (isRecord(value)) {
    const result: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      const jsonValue = toJsonValue(item, `${path}.${key}`, issues);
      if (jsonValue !== undefined) {
        result[key] = jsonValue;
      }
    }

    return result;
  }

  issues.push(`${path} must contain only JSON-serializable values.`);
  return undefined;
}

export function assignIfDefined<TKey extends keyof AgentDefaults>(
  target: Partial<AgentDefaults>,
  key: TKey,
  value: AgentDefaults[TKey] | undefined,
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
