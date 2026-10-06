import { describe, expect, it } from 'vitest';
import { parseArgs } from './trace-session/cli.js';
import { reconstructRunSettings, historicalSettingsReport } from './trace-session/settings.js';
import { inspectSessionSettings, type PostgresClient } from './trace-session/data.js';

describe('historical settings', () => {
  it('accepts session inspection and rejects irrelevant targets/options', () => {
    expect(parseArgs(['settings', 'session', 'old-session', '--json'])).toMatchObject({ sessionId: 'old-session', inspectSettings: true, json: true });
    expect(parseArgs(['settings', '--help']).help).toBe(true);
    expect(parseArgs(['settings', 'session', 'old-session', '--help']).help).toBe(true);
    expect(() => parseArgs(['settings', 'run', 'run-id'])).toThrow(/expects session/);
    expect(() => parseArgs(['settings', 'session'])).toThrow(/session id is required/);
    expect(() => parseArgs(['settings', 'session', 'id', '--html', 'out.html'])).toThrow(/not available/);
  });

  it('keeps profile evidence separate from effective snapshot settings and never infers defaults', () => {
    const run = { id: 'child', rootRunId: 'root', parentRunId: 'root', delegateName: 'reviewer',
      metadata: { agentId: 'old-agent', agentConfigPath: '/nonexistent/profile.json', agentConfigurationFingerprint: 'historical-hash', secret: 'not exported' },
      modelProvider: 'mesh', modelName: 'old-model', modelParameters: { temperature: 0 }, executionContext: { inferenceMode: 'direct' } };
    const report = reconstructRunSettings(run,
      { snapshotSeq: 1, state: { messages: [{ role: 'system', content: 'Original instructions' }, { role: 'user', content: 'Private goal' }], outputSchema: { type: 'object' }, visibleToolNames: ['initial-tool'] } },
      { snapshotSeq: 9, state: { messages: [{ role: 'system', content: 'Compacted instructions' }], visibleToolNames: [] } });
    expect(report.agent).toEqual({ agentId: 'old-agent', agentName: null, runtimeMode: null, agentConfigPath: '/nonexistent/profile.json', agentConfigurationFingerprint: 'historical-hash' });
    expect(report.model).toEqual({ provider: 'mesh', name: 'old-model', parameters: { temperature: 0 } });
    expect(report.initialSnapshot).toEqual({ seq: 1, systemMessages: [{ role: 'system', content: 'Original instructions' }], outputSchema: { type: 'object' } });
    expect(report.latestSnapshot).toEqual({ seq: 9, visibleToolNames: [] });
    expect(report.parentRunId).toBe('root');
    expect(report.delegateName).toBe('reviewer');
    expect(reconstructRunSettings({ id: 'bare', rootRunId: 'bare' })).toMatchObject({ model: { provider: null, name: null, parameters: null }, initialSnapshot: null, latestSnapshot: null, executionContext: null });
    expect(historicalSettingsReport('missing', []).warnings[0]).toContain('was not found');
  });

  it('maps Postgres columns without changing nested JSON keys and resolves legacy session roots', async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const client: PostgresClient = {
      async query<T>(sql: string, params?: unknown[]) {
        queries.push({ sql, params });
        let rows: unknown[] = [];
        if (sql.includes('information_schema')) rows = [{ count: '0' }];
        else if (sql.includes("to_regclass")) rows = [{ exists: false }];
        else if (sql.includes('group by r.root_run_id')) rows = [{ root_run_id: 'root' }];
        else if (sql.includes('to_jsonb(r)')) rows = [{ run: { id: 'root', root_run_id: 'root', metadata: { agentId: 'persisted' }, model_parameters: { max_tokens: 17 } }, initial: { snapshot_seq: 3, state: { outputSchema: { snake_case: true }, messages: [{ role: 'system', content: 'Stored prompt' }] } }, latest: null }];
        return { rows: rows as T[], rowCount: rows.length };
      },
    };
    const report = await inspectSessionSettings(client, parseArgs(['settings', 'session', 'legacy']));
    expect(report.runs[0].model.parameters).toEqual({ max_tokens: 17 });
    expect(report.runs[0].initialSnapshot).toMatchObject({ seq: 3, outputSchema: { snake_case: true } });
    expect(report.runs[0].agent.agentId).toBe('persisted');
    expect(queries.find(query => query.sql.includes('to_jsonb(r)'))?.params).toEqual([['root']]);
    expect(queries.some(query => query.sql.includes("r.context ->> 'sessionId'"))).toBe(true);
  });
});
