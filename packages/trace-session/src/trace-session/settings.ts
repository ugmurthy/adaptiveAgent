/** Evidence-backed inspection, not a runnable settings/profile export. */
export interface HistoricalRunSettings {
  runId: string;
  rootRunId: string;
  parentRunId: unknown;
  delegateName: unknown;
  agent: Record<string, unknown>;
  model: { provider: unknown; name: unknown; parameters: unknown };
  executionContext: unknown;
  initialSnapshot: { seq: unknown; systemMessages: unknown[]; outputSchema: unknown } | null;
  latestSnapshot: { seq: unknown; visibleToolNames: unknown } | null;
}

export interface HistoricalSettingsReport {
  sessionId: string;
  completeness: 'partial';
  runs: HistoricalRunSettings[];
  warnings: string[];
}

export function reconstructRunSettings(
  run: Record<string, unknown>,
  initial?: Record<string, unknown>,
  latest?: Record<string, unknown>,
): HistoricalRunSettings {
  const metadata = object(run.metadata);
  const firstState = object(initial?.state);
  const lastState = object(latest?.state);
  return {
    runId: String(run.id), rootRunId: String(run.rootRunId),
    parentRunId: run.parentRunId ?? null, delegateName: run.delegateName ?? null,
    agent: Object.fromEntries(['agentId', 'agentName', 'runtimeMode', 'agentConfigPath', 'agentConfigurationFingerprint']
      .map(key => [key, metadata[key] ?? null])),
    model: { provider: run.modelProvider ?? null, name: run.modelName ?? null, parameters: run.modelParameters ?? null },
    executionContext: run.executionContext ?? null,
    initialSnapshot: initial ? {
      seq: initial.snapshotSeq ?? null,
      systemMessages: Array.isArray(firstState.messages) ? firstState.messages.filter(message => object(message).role === 'system') : [],
      outputSchema: firstState.outputSchema ?? null,
    } : null,
    latestSnapshot: latest ? { seq: latest.snapshotSeq ?? null, visibleToolNames: lastState.visibleToolNames ?? null } : null,
  };
}

export function historicalSettingsReport(sessionId: string, runs: HistoricalRunSettings[]): HistoricalSettingsReport {
  return {
    sessionId, completeness: 'partial', runs,
    warnings: [
      ...(!runs.length ? [`Session "${sessionId}" was not found.`] : []),
      'Full settings and agent/delegate profiles were not archived. Limits, retry policies, tool definitions, credentials, and configured allowed tools cannot be reconstructed reliably.',
      'Null means unavailable, not a default. System messages are effective initial snapshot instructions, not the original profile. Latest visibleToolNames is runtime visibility, not configured allowed tools.',
      'Only persisted evidence is used; current profile files are not read. Paths and fingerprints identify profiles but do not recover their contents. This report is not a runnable configuration.',
      'Persisted execution context and system messages may contain sensitive data; review before sharing.',
    ],
  };
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
