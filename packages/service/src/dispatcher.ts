import type { QueuePublisher } from './queue.js';
import { ServiceBackendStore } from './postgres.js';

export class OutboxDispatcher {
  private stopped = true;
  private loopPromise?: Promise<void>;
  constructor(private readonly store: ServiceBackendStore, private readonly publisher: QueuePublisher, private readonly intervalMs = 500, private readonly batchSize = 50) {}

  async poll(): Promise<number> {
    return this.store.dispatchBatch(this.batchSize, (record) => this.publisher.publish(record.kind, record.jobId, record.commandVersion));
  }

  async start(): Promise<void> {
    if (this.loopPromise) return this.loopPromise;
    this.stopped = false;
    this.loopPromise = this.runLoop();
    return this.loopPromise;
  }

  stop(): void { this.stopped = true; }
  async close(): Promise<void> {
    this.stop();
    await this.loopPromise;
    await this.publisher.close();
  }

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      const count = await this.poll();
      if (count === 0 && !this.stopped) await sleep(this.intervalMs);
    }
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
