export type GatewayLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface GatewayLogFields {
  connectionId?: string;
  traceId?: string;
  accountId?: string;
  tenantId?: string;
  method?: string;
  callId?: string;
  idempotencyKey?: string;
  toolName?: string;
  tier?: string;
  routePolicyVersion?: string;
  routeIndex?: number;
  provider?: string;
  model?: string;
  status?: string;
  durationMs?: number;
  errorType?: string;
}

export interface GatewayLogger {
  log(level: GatewayLogLevel, event: string, fields?: GatewayLogFields): void;
}

export function createMetadataLogger(
  write: (record: string) => void = (record) => console.info(record),
): GatewayLogger {
  return {
    log(level, event, fields = {}) {
      const metadata = Object.fromEntries([
        'connectionId',
        'traceId',
        'accountId',
        'tenantId',
        'method',
        'callId',
        'idempotencyKey',
        'toolName',
        'tier',
        'routePolicyVersion',
        'routeIndex',
        'provider',
        'model',
        'status',
        'durationMs',
        'errorType',
      ].flatMap((key) => {
        const value = (fields as Record<string, unknown>)[key];
        return value === undefined ? [] : [[key, value]];
      }));
      write(JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        event: `capability_gateway.${event}`,
        ...metadata,
      }));
    },
  };
}

export const silentGatewayLogger: GatewayLogger = {
  log() {},
};
