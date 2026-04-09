import type { InvocationMode } from './config.js';
import type { SessionStatus } from './protocol.js';
import type { JsonObject } from './core.js';

export type GatewayInvocationKind = 'chat' | 'run' | 'approval' | 'system';
export type TranscriptMessageRole = 'system' | 'user' | 'assistant' | 'tool';
export type CronTargetKind = 'session_event' | 'isolated_run' | 'isolated_chat';
export type CronDeliveryMode = 'session' | 'announce' | 'webhook' | 'none';
export type CronRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'needs_review';

export interface GatewaySessionRecord {
  id: string;
  channelId: string;
  agentId?: string;
  invocationMode?: InvocationMode;
  authSubject: string;
  tenantId?: string;
  status: SessionStatus;
  currentRunId?: string;
  currentRootRunId?: string;
  lastCompletedRootRunId?: string;
  transcriptVersion: number;
  transcriptSummary?: string;
  metadata?: JsonObject;
  createdAt: string;
  updatedAt: string;
}

export interface TranscriptMessageRecord {
  id: string;
  sessionId: string;
  sequence: number;
  role: TranscriptMessageRole;
  content: string;
  metadata?: JsonObject;
  createdAt: string;
}

export interface SessionRunLinkRecord {
  sessionId: string;
  runId: string;
  rootRunId: string;
  invocationKind: GatewayInvocationKind;
  turnIndex?: number;
  metadata?: JsonObject;
  createdAt: string;
}

export interface GatewayCronJobRecord {
  id: string;
  schedule: string;
  targetKind: CronTargetKind;
  target: JsonObject;
  deliveryMode: CronDeliveryMode;
  delivery: JsonObject;
  enabled: boolean;
  nextFireAt: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  metadata?: JsonObject;
  createdAt: string;
  updatedAt: string;
}

export interface GatewayCronRunRecord {
  id: string;
  jobId: string;
  fireTime: string;
  status: CronRunStatus;
  sessionId?: string;
  runId?: string;
  rootRunId?: string;
  leaseOwner?: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  metadata?: JsonObject;
}

export interface SessionStore {
  create(session: GatewaySessionRecord): Promise<GatewaySessionRecord>;
  get(sessionId: string): Promise<GatewaySessionRecord | undefined>;
  update(session: GatewaySessionRecord): Promise<GatewaySessionRecord>;
  delete(sessionId: string): Promise<void>;
  listByAuthSubject(authSubject: string): Promise<GatewaySessionRecord[]>;
}

export interface TranscriptMessageStore {
  append(message: TranscriptMessageRecord): Promise<TranscriptMessageRecord>;
  listBySession(sessionId: string): Promise<TranscriptMessageRecord[]>;
  deleteBySession(sessionId: string): Promise<void>;
}

export interface SessionRunLinkStore {
  append(link: SessionRunLinkRecord): Promise<SessionRunLinkRecord>;
  getByRunId(runId: string): Promise<SessionRunLinkRecord | undefined>;
  listBySession(sessionId: string): Promise<SessionRunLinkRecord[]>;
  deleteBySession(sessionId: string): Promise<void>;
}

export interface CronJobStore {
  create(job: GatewayCronJobRecord): Promise<GatewayCronJobRecord>;
  get(jobId: string): Promise<GatewayCronJobRecord | undefined>;
  update(job: GatewayCronJobRecord): Promise<GatewayCronJobRecord>;
  delete(jobId: string): Promise<void>;
  listDue(now: string): Promise<GatewayCronJobRecord[]>;
}

export interface CronRunStore {
  create(run: GatewayCronRunRecord): Promise<GatewayCronRunRecord>;
  get(runId: string): Promise<GatewayCronRunRecord | undefined>;
  update(run: GatewayCronRunRecord): Promise<GatewayCronRunRecord>;
  listByJob(jobId: string): Promise<GatewayCronRunRecord[]>;
  findByFireTime(jobId: string, fireTime: string): Promise<GatewayCronRunRecord | undefined>;
}

export interface GatewayStores {
  sessions: SessionStore;
  transcriptMessages: TranscriptMessageStore;
  sessionRunLinks: SessionRunLinkStore;
  cronJobs: CronJobStore;
  cronRuns: CronRunStore;
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, GatewaySessionRecord>();

  async create(session: GatewaySessionRecord): Promise<GatewaySessionRecord> {
    if (this.sessions.has(session.id)) {
      throw new Error(`Session "${session.id}" already exists.`);
    }

    const storedSession = cloneRecord(session);
    this.sessions.set(storedSession.id, storedSession);
    return cloneRecord(storedSession);
  }

  async get(sessionId: string): Promise<GatewaySessionRecord | undefined> {
    const session = this.sessions.get(sessionId);
    return session ? cloneRecord(session) : undefined;
  }

  async update(session: GatewaySessionRecord): Promise<GatewaySessionRecord> {
    if (!this.sessions.has(session.id)) {
      throw new Error(`Session "${session.id}" does not exist.`);
    }

    const storedSession = cloneRecord(session);
    this.sessions.set(storedSession.id, storedSession);
    return cloneRecord(storedSession);
  }

  async delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  async listByAuthSubject(authSubject: string): Promise<GatewaySessionRecord[]> {
    return [...this.sessions.values()]
      .filter((session) => session.authSubject === authSubject)
      .sort((left, right) => compareByTimestamp(left.createdAt, right.createdAt) || left.id.localeCompare(right.id))
      .map((session) => cloneRecord(session));
  }
}

export class InMemoryTranscriptMessageStore implements TranscriptMessageStore {
  private readonly messages = new Map<string, TranscriptMessageRecord>();

  async append(message: TranscriptMessageRecord): Promise<TranscriptMessageRecord> {
    if (this.messages.has(message.id)) {
      throw new Error(`Transcript message "${message.id}" already exists.`);
    }

    const storedMessage = cloneRecord(message);
    this.messages.set(storedMessage.id, storedMessage);
    return cloneRecord(storedMessage);
  }

  async listBySession(sessionId: string): Promise<TranscriptMessageRecord[]> {
    return [...this.messages.values()]
      .filter((message) => message.sessionId === sessionId)
      .sort(
        (left, right) =>
          left.sequence - right.sequence || compareByTimestamp(left.createdAt, right.createdAt) || left.id.localeCompare(right.id),
      )
      .map((message) => cloneRecord(message));
  }

  async deleteBySession(sessionId: string): Promise<void> {
    for (const [messageId, message] of this.messages.entries()) {
      if (message.sessionId === sessionId) {
        this.messages.delete(messageId);
      }
    }
  }
}

export class InMemorySessionRunLinkStore implements SessionRunLinkStore {
  private readonly linksByRunId = new Map<string, SessionRunLinkRecord>();

  async append(link: SessionRunLinkRecord): Promise<SessionRunLinkRecord> {
    if (this.linksByRunId.has(link.runId)) {
      throw new Error(`Run linkage for run "${link.runId}" already exists.`);
    }

    const storedLink = cloneRecord(link);
    this.linksByRunId.set(storedLink.runId, storedLink);
    return cloneRecord(storedLink);
  }

  async getByRunId(runId: string): Promise<SessionRunLinkRecord | undefined> {
    const link = this.linksByRunId.get(runId);
    return link ? cloneRecord(link) : undefined;
  }

  async listBySession(sessionId: string): Promise<SessionRunLinkRecord[]> {
    return [...this.linksByRunId.values()]
      .filter((link) => link.sessionId === sessionId)
      .sort((left, right) => compareByTimestamp(left.createdAt, right.createdAt) || left.runId.localeCompare(right.runId))
      .map((link) => cloneRecord(link));
  }

  async deleteBySession(sessionId: string): Promise<void> {
    for (const [runId, link] of this.linksByRunId.entries()) {
      if (link.sessionId === sessionId) {
        this.linksByRunId.delete(runId);
      }
    }
  }
}

export class InMemoryCronJobStore implements CronJobStore {
  private readonly jobs = new Map<string, GatewayCronJobRecord>();

  async create(job: GatewayCronJobRecord): Promise<GatewayCronJobRecord> {
    if (this.jobs.has(job.id)) {
      throw new Error(`Cron job "${job.id}" already exists.`);
    }

    const storedJob = cloneRecord(job);
    this.jobs.set(storedJob.id, storedJob);
    return cloneRecord(storedJob);
  }

  async get(jobId: string): Promise<GatewayCronJobRecord | undefined> {
    const job = this.jobs.get(jobId);
    return job ? cloneRecord(job) : undefined;
  }

  async update(job: GatewayCronJobRecord): Promise<GatewayCronJobRecord> {
    if (!this.jobs.has(job.id)) {
      throw new Error(`Cron job "${job.id}" does not exist.`);
    }

    const storedJob = cloneRecord(job);
    this.jobs.set(storedJob.id, storedJob);
    return cloneRecord(storedJob);
  }

  async delete(jobId: string): Promise<void> {
    this.jobs.delete(jobId);
  }

  async listDue(now: string): Promise<GatewayCronJobRecord[]> {
    return [...this.jobs.values()]
      .filter((job) => job.enabled && job.nextFireAt <= now)
      .sort((left, right) => compareByTimestamp(left.nextFireAt, right.nextFireAt) || left.id.localeCompare(right.id))
      .map((job) => cloneRecord(job));
  }
}

export class InMemoryCronRunStore implements CronRunStore {
  private readonly runs = new Map<string, GatewayCronRunRecord>();

  async create(run: GatewayCronRunRecord): Promise<GatewayCronRunRecord> {
    if (this.runs.has(run.id)) {
      throw new Error(`Cron run "${run.id}" already exists.`);
    }

    const storedRun = cloneRecord(run);
    this.runs.set(storedRun.id, storedRun);
    return cloneRecord(storedRun);
  }

  async get(runId: string): Promise<GatewayCronRunRecord | undefined> {
    const run = this.runs.get(runId);
    return run ? cloneRecord(run) : undefined;
  }

  async update(run: GatewayCronRunRecord): Promise<GatewayCronRunRecord> {
    if (!this.runs.has(run.id)) {
      throw new Error(`Cron run "${run.id}" does not exist.`);
    }

    const storedRun = cloneRecord(run);
    this.runs.set(storedRun.id, storedRun);
    return cloneRecord(storedRun);
  }

  async listByJob(jobId: string): Promise<GatewayCronRunRecord[]> {
    return [...this.runs.values()]
      .filter((run) => run.jobId === jobId)
      .sort((left, right) => compareByTimestamp(left.fireTime, right.fireTime) || left.id.localeCompare(right.id))
      .map((run) => cloneRecord(run));
  }

  async findByFireTime(jobId: string, fireTime: string): Promise<GatewayCronRunRecord | undefined> {
    const run = [...this.runs.values()].find((entry) => entry.jobId === jobId && entry.fireTime === fireTime);
    return run ? cloneRecord(run) : undefined;
  }
}

export function createInMemoryGatewayStores(): GatewayStores {
  return {
    sessions: new InMemorySessionStore(),
    transcriptMessages: new InMemoryTranscriptMessageStore(),
    sessionRunLinks: new InMemorySessionRunLinkStore(),
    cronJobs: new InMemoryCronJobStore(),
    cronRuns: new InMemoryCronRunStore(),
  };
}

function cloneRecord<TRecord>(record: TRecord): TRecord {
  return structuredClone(record);
}

function compareByTimestamp(left: string, right: string): number {
  return left.localeCompare(right);
}
