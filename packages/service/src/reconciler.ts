import type { QueuePublisher } from './queue.js';
import { ServiceBackendStore } from './postgres.js';

export class StaleJobReconciler {
  private stopped = true;
  private loopPromise?: Promise<void>;
  constructor(private readonly store: ServiceBackendStore, private readonly publisher: QueuePublisher, private readonly intervalMs = 10_000, private readonly batchSize = 100) {}
  async reconcile(): Promise<number> {
    const jobs = await this.store.findStale(this.batchSize);
    for (const job of jobs) await this.publisher.publish(job.kind, job.jobId, job.commandVersion);
    return jobs.length;
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
      await this.reconcile();
      if (!this.stopped) await new Promise((resolve) => setTimeout(resolve, this.intervalMs));
    }
  }
}
