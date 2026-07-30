import {
  createReadWebPageTool,
  createWebSearchTool,
  type JsonObject,
  type JsonValue,
  type ToolAccounting,
  type ToolContext,
  type ToolDefinition,
} from '@adaptive-agent/core';
import {
  GatewayClientError,
  GatewayResponseError,
  type GatewayClient,
  type GatewayExecutionContext,
  type RunAuthorizeResult,
  type ToolExecuteResult,
} from '@adaptive-agent/gateway-client';

export type GatewayRemoteToolName = 'web_search' | 'read_web_page';

const WIRE_NAMES: Record<GatewayRemoteToolName, string> = {
  web_search: 'web_search@1',
  read_web_page: 'read_web_page@1',
};
const ACCOUNTING = Symbol('gateway-tool-accounting');

export interface GatewayProxyToolFactoryOptions {
  client: GatewayClient;
  toolName: GatewayRemoteToolName;
}

/** Creates a core-compatible tool whose provider execution is owned by the capability gateway. */
export function createGatewayProxyTool(options: GatewayProxyToolFactoryOptions): ToolDefinition<any, any> {
  const base = options.toolName === 'web_search'
    ? createWebSearchTool({ provider: 'duckduckgo' })
    : createReadWebPageTool({ provider: 'direct' });
  const permits = new Map<string, Promise<RunAuthorizeResult>>();
  const wireName = WIRE_NAMES[options.toolName];

  const authorize = (context: ToolContext, gatewayContext: GatewayExecutionContext, force = false): Promise<RunAuthorizeResult> => {
    const key = context.rootRunId;
    if (!force) {
      const existing = permits.get(key);
      if (existing) return existing;
      if (
        (gatewayContext.authorizationRunId === undefined ||
          gatewayContext.authorizationRunId === context.rootRunId) &&
        gatewayContext.authorizationRef
      ) {
        return Promise.resolve({
          permitId: gatewayContext.authorizationRef,
          inferenceMode: 'gateway',
          inferenceTier: gatewayContext.inferenceTier ?? 'medium',
          routePolicyVersion: gatewayContext.routePolicyRef ?? '',
          remoteCapabilities: [],
          expiresAt: '9999-12-31T23:59:59.999Z',
        });
      }
    }
    const pending = options.client.authorizeRun({
      runId: context.rootRunId,
      inferenceMode: 'gateway',
      requestedTier: gatewayContext.inferenceTier ?? 'medium',
      profileRefs: gatewayContext.profileRefs ?? [],
    }).then((authorization) => {
      if (!authorization.remoteCapabilities.includes(wireName)) {
        throw new GatewayClientError(
          `Gateway remote tool "${options.toolName}" is configured but is not authorized for this account`,
          { statusCode: 403, phase: 'http_status' },
        );
      }
      return authorization;
    });
    permits.set(key, pending);
    void pending.catch(() => { if (permits.get(key) === pending) permits.delete(key); });
    return pending;
  };

  return {
    ...base,
    async execute(input: JsonValue, context: ToolContext): Promise<JsonValue> {
      const gatewayContext = (context.executionContext ?? {}) as GatewayExecutionContext;
      if (gatewayContext.inferenceMode !== 'gateway' || !gatewayContext.authorizationRef) {
        throw new GatewayClientError(`Gateway ${options.toolName} requires a protected run authorization permit`);
      }
      const normalizedInput = typeof input === 'string'
        ? JSON.parse(input) as JsonObject
        : input as JsonObject;
      let permit = await authorize(context, gatewayContext);
      const execute = () => options.client.executeTool({
        permitId: permit.permitId,
        idempotencyKey: context.idempotencyKey,
        toolName: wireName,
        input: normalizedInput,
        ...(context.timeoutMs !== undefined && context.timeoutMs > 0 ? { timeoutMs: Math.min(context.timeoutMs, 300_000) } : {}),
      }, { signal: context.signal });
      let result: ToolExecuteResult;
      try {
        result = await execute();
      } catch (error) {
        if (!(error instanceof GatewayResponseError) || error.gatewayCode !== 'forbidden') {
          if (error instanceof GatewayResponseError && error.gatewayCode === 'capability_not_entitled') {
            throw new GatewayClientError(`Gateway remote tool "${options.toolName}" is configured but is not authorized for this account`, { cause: error, statusCode: 403, phase: 'http_status' });
          }
          throw error;
        }
        permits.delete(context.rootRunId);
        permit = await authorize(context, gatewayContext, true);
        result = await execute();
      }
      if (result.idempotencyKey !== context.idempotencyKey) throw new GatewayClientError('Gateway tool response idempotency key changed');
      if (result.output !== null && typeof result.output === 'object') {
        const provider = result.diagnostics?.provider ?? 'adaptive-agent-gateway';
        const accounting: ToolAccounting = {
          provider,
          operation: options.toolName,
          billable: true,
          ...(result.cacheHit ? { cached: true } : {}),
          units: { requests: result.cacheHit ? 0 : (result.usage?.units ?? 1) },
          ...(result.usage?.cost === undefined ? {} : { estimatedCostUSD: result.cacheHit ? 0 : result.usage.cost }),
          pricingSource: result.usage?.cost === undefined ? 'unpriced' : 'configured',
        };
        Object.defineProperty(result.output, ACCOUNTING, { value: accounting, enumerable: false });
      }
      return result.output;
    },
    getAccounting(output: JsonValue): ToolAccounting | undefined {
      return output !== null && typeof output === 'object'
        ? (output as { [ACCOUNTING]?: ToolAccounting })[ACCOUNTING]
        : undefined;
    },
  } as ToolDefinition<any, any>;
}
