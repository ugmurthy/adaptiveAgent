import type { JsonValue, ToolExecutionRecord, ToolExecutionStore } from './types.js';

function cloneRecord(record: ToolExecutionRecord): ToolExecutionRecord {
  return structuredClone(record);
}

export class InMemoryToolExecutionStore implements ToolExecutionStore {
  private readonly recordsByKey = new Map<string, ToolExecutionRecord>();

  async getByIdempotencyKey(idempotencyKey: string): Promise<ToolExecutionRecord | null> {
    const record = this.recordsByKey.get(idempotencyKey);
    return record ? cloneRecord(record) : null;
  }

  async markStarted(record: Parameters<ToolExecutionStore['markStarted']>[0]): Promise<ToolExecutionRecord> {
    const existing = this.recordsByKey.get(record.idempotencyKey);
    if (existing) {
      return cloneRecord(existing);
    }

    const startedRecord: ToolExecutionRecord = {
      ...record,
      status: 'started',
      startedAt: new Date().toISOString(),
    };
    this.recordsByKey.set(record.idempotencyKey, startedRecord);
    return cloneRecord(startedRecord);
  }

  async markCompleted(idempotencyKey: string, output: JsonValue): Promise<ToolExecutionRecord> {
    const current = this.requireRecord(idempotencyKey);
    const completedRecord: ToolExecutionRecord = {
      ...current,
      status: 'completed',
      output,
      errorCode: undefined,
      errorMessage: undefined,
      completedAt: new Date().toISOString(),
    };
    this.recordsByKey.set(idempotencyKey, completedRecord);
    return cloneRecord(completedRecord);
  }

  async markFailed(idempotencyKey: string, errorCode: string, errorMessage: string): Promise<ToolExecutionRecord> {
    const current = this.requireRecord(idempotencyKey);
    const failedRecord: ToolExecutionRecord = {
      ...current,
      status: 'failed',
      errorCode,
      errorMessage,
      completedAt: new Date().toISOString(),
    };
    this.recordsByKey.set(idempotencyKey, failedRecord);
    return cloneRecord(failedRecord);
  }

  private requireRecord(idempotencyKey: string): ToolExecutionRecord {
    const record = this.recordsByKey.get(idempotencyKey);
    if (!record) {
      throw new Error(`Tool execution ${idempotencyKey} does not exist`);
    }

    return record;
  }
}
