import { createHash } from 'node:crypto';
import {
  StreamSequenceValidator,
  validateModelStreamEnvelope,
  type ModelGenerateParams,
  type ModelGenerateResult,
  type ModelStreamEnvelope,
  type ModelStreamEvent,
} from '@adaptive-agent/gateway-protocol';
import { GatewayError } from './errors.js';

export type ModelCallOutcome =
  | { ok: true; result: ModelGenerateResult }
  | { ok: false; error: GatewayError; traceId: string };

export type StreamSubscriber = (envelope: ModelStreamEnvelope) => void;

export class CachedModelCall {
  readonly controller = new AbortController();
  readonly events: ModelStreamEnvelope[] = [];
  readonly outcome: Promise<ModelCallOutcome>;
  private readonly subscribers = new Set<StreamSubscriber>();
  private readonly sequence: StreamSequenceValidator;
  private resolveOutcome!: (outcome: ModelCallOutcome) => void;
  private terminalOutcome?: ModelCallOutcome;
  touchedAt: number;

  constructor(
    readonly accountId: string,
    readonly callId: string,
    readonly requestHash: string,
    now: number,
  ) {
    this.touchedAt = now;
    this.sequence = new StreamSequenceValidator(callId);
    this.outcome = new Promise((resolve) => {
      this.resolveOutcome = resolve;
    });
  }

  get settled(): boolean {
    return this.terminalOutcome !== undefined;
  }

  append(event: ModelStreamEvent): ModelStreamEnvelope {
    if (this.settled) throw new Error('Cannot append to a settled model call');
    const envelope = validateModelStreamEnvelope({
      callId: this.callId,
      seq: this.events.length,
      event,
    });
    this.sequence.accept(envelope);
    this.events.push(structuredClone(envelope));
    for (const subscriber of this.subscribers) {
      try {
        subscriber(structuredClone(envelope));
      } catch {
        this.subscribers.delete(subscriber);
      }
    }
    return envelope;
  }

  subscribe(subscriber: StreamSubscriber): () => void {
    for (const event of this.events) subscriber(structuredClone(event));
    if (!this.settled) this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  succeed(result: ModelGenerateResult): void {
    if (this.settled) return;
    this.terminalOutcome = { ok: true, result: structuredClone(result) };
    this.subscribers.clear();
    this.resolveOutcome(this.terminalOutcome);
  }

  fail(error: GatewayError, traceId: string): void {
    if (this.settled) return;
    this.terminalOutcome = { ok: false, error, traceId };
    this.subscribers.clear();
    this.resolveOutcome(this.terminalOutcome);
  }
}

export interface ModelCallCacheOptions {
  maxEntries?: number;
  retentionMs?: number;
  now?: () => number;
}

export class ModelCallCache {
  private readonly calls = new Map<string, CachedModelCall>();
  private readonly maxEntries: number;
  private readonly retentionMs: number;
  private readonly now: () => number;

  constructor(options: ModelCallCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 1_000;
    this.retentionMs = options.retentionMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;
  }

  reserve(
    accountId: string,
    callId: string,
    requestHash: string,
  ): { call: CachedModelCall; created: boolean } {
    this.prune();
    const key = callKey(accountId, callId);
    const existing = this.calls.get(key);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new GatewayError('idempotency_conflict', { callId });
      }
      existing.touchedAt = this.now();
      return { call: existing, created: false };
    }
    if (this.calls.size >= this.maxEntries) {
      throw new GatewayError('rate_limited', { retryAfterMs: 1_000, callId });
    }
    const call = new CachedModelCall(accountId, callId, requestHash, this.now());
    this.calls.set(key, call);
    return { call, created: true };
  }

  cancel(accountId: string, callId: string): boolean {
    const call = this.calls.get(callKey(accountId, callId));
    if (!call || call.settled) return false;
    call.controller.abort(new GatewayError('cancelled', { callId }));
    return true;
  }

  activeCount(): number {
    let count = 0;
    for (const call of this.calls.values()) if (!call.settled) count += 1;
    return count;
  }

  abortAll(): void {
    for (const call of this.calls.values()) {
      if (!call.settled) {
        call.controller.abort(new GatewayError('cancelled', { callId: call.callId }));
      }
    }
  }

  async waitForActiveCalls(timeoutMs = 10_000): Promise<void> {
    const active = [...this.calls.values()]
      .filter((call) => !call.settled)
      .map((call) => call.outcome);
    if (active.length === 0) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(active),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private prune(): void {
    const cutoff = this.now() - this.retentionMs;
    for (const [key, call] of this.calls) {
      if (call.settled && call.touchedAt < cutoff) this.calls.delete(key);
    }
    if (this.calls.size < this.maxEntries) return;
    const terminal = [...this.calls.entries()]
      .filter(([, call]) => call.settled)
      .sort(([, left], [, right]) => left.touchedAt - right.touchedAt);
    while (this.calls.size >= this.maxEntries && terminal.length > 0) {
      this.calls.delete(terminal.shift()![0]);
    }
  }
}

export function stableModelRequestHash(params: ModelGenerateParams): string {
  return createHash('sha256')
    .update(stableJson({
      tier: params.tier,
      invocation: {
        runId: params.invocation.runId,
        rootRunId: params.invocation.rootRunId,
        stepId: params.invocation.stepId,
        purpose: params.invocation.purpose,
        attempt: params.invocation.attempt,
      },
      messages: params.messages,
      tools: params.tools,
      responseSchema: params.responseSchema,
      temperature: params.temperature,
      maxOutputTokens: params.maxOutputTokens,
    }))
    .digest('hex');
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return entry;
    }
    return Object.fromEntries(
      Object.entries(entry as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right)),
    );
  });
}

function callKey(accountId: string, callId: string): string {
  return `${accountId}\u0000${callId}`;
}
