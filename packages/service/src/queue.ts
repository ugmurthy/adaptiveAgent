import { Queue, Worker, type ConnectionOptions, type JobsOptions } from 'bullmq';
import type { JobKind } from '@adaptive-agent/service-sdk';

export interface ServiceQueuePayload { jobId: string }
export interface QueueRoute { name: string; concurrency: number }
export type QueueRoutes = Record<JobKind, QueueRoute>;

export function queueJobId(jobId: string, commandVersion: number): string {
  return `service-${jobId.replace(/[^a-zA-Z0-9_-]/g, '_')}-v${commandVersion}`;
}

export interface QueuePublisher {
  publish(kind: JobKind, jobId: string, commandVersion: number): Promise<void>;
  close(): Promise<void>;
}

export class BullMqPublisher implements QueuePublisher {
  private readonly queues = new Map<string, Queue<ServiceQueuePayload>>();

  constructor(
    private readonly connection: ConnectionOptions,
    private readonly routes: QueueRoutes,
    private readonly jobOptions: JobsOptions = {},
  ) {}

  async publish(kind: JobKind, jobId: string, commandVersion: number): Promise<void> {
    const route = this.routes[kind];
    let queue = this.queues.get(route.name);
    if (!queue) {
      queue = new Queue<ServiceQueuePayload>(route.name, { connection: this.connection });
      this.queues.set(route.name, queue);
    }
    await queue.add('service-job', { jobId }, {
      ...this.jobOptions,
      jobId: queueJobId(jobId, commandVersion),
      // PostgreSQL command leases are the idempotency boundary. Completed or
      // failed BullMQ records must not prevent the reconciler from redelivering.
      removeOnComplete: this.jobOptions.removeOnComplete ?? true,
      removeOnFail: this.jobOptions.removeOnFail ?? true,
    });
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
  }
}

export function createBullMqWorkers(
  connection: ConnectionOptions,
  routes: QueueRoutes,
  process: (payload: ServiceQueuePayload) => Promise<void>,
): Worker<ServiceQueuePayload>[] {
  const unique = new Map<string, number>();
  for (const route of Object.values(routes)) {
    unique.set(route.name, Math.max(unique.get(route.name) ?? 0, route.concurrency));
  }
  return [...unique].map(([name, concurrency]) => new Worker<ServiceQueuePayload>(
    name,
    async (job) => process(job.data),
    { connection, concurrency },
  ));
}
