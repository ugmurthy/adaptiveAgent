import type { JsonObject, JsonValue } from './core.js';
import type { GatewayCronJobRecord, GatewayCronRunRecord, GatewayStores } from './stores.js';

export interface CronDeliveryContext {
  job: GatewayCronJobRecord;
  cronRun: GatewayCronRunRecord;
  stores: GatewayStores;
  now: () => Date;
}

export interface CronDeliveryResult {
  delivered: boolean;
  error?: string;
}

export async function deliverCronResult(context: CronDeliveryContext): Promise<CronDeliveryResult> {
  switch (context.job.deliveryMode) {
    case 'none':
      return { delivered: true };
    case 'session':
      return deliverToSession(context);
    case 'announce':
      return deliverAnnounce(context);
    case 'webhook':
      return deliverWebhook(context);
    default:
      return { delivered: false, error: `Unknown delivery mode "${context.job.deliveryMode}".` };
  }
}

async function deliverToSession(context: CronDeliveryContext): Promise<CronDeliveryResult> {
  const sessionId = context.cronRun.sessionId ?? (context.job.delivery.sessionId as string | undefined);
  if (!sessionId) {
    return { delivered: false, error: 'Session delivery requires a sessionId on the cron run or delivery config.' };
  }

  const session = await context.stores.sessions.get(sessionId);
  if (!session) {
    return { delivered: false, error: `Session "${sessionId}" does not exist for cron delivery.` };
  }

  const nowIso = context.now().toISOString();
  const transcriptMessages = await context.stores.transcriptMessages.listBySession(sessionId);
  const nextSequence = (transcriptMessages.at(-1)?.sequence ?? 0) + 1;

  await context.stores.transcriptMessages.append({
    id: `cron-delivery-${context.cronRun.id}`,
    sessionId,
    sequence: nextSequence,
    role: 'system',
    content: buildDeliverySummary(context),
    metadata: buildDeliveryMetadata(context),
    createdAt: nowIso,
  });

  return { delivered: true };
}

async function deliverAnnounce(context: CronDeliveryContext): Promise<CronDeliveryResult> {
  const channelId = (context.job.delivery.channelId as string) ?? (context.job.target.channelId as string);
  if (!channelId) {
    return { delivered: false, error: 'Announce delivery requires delivery.channelId or target.channelId.' };
  }

  return { delivered: true };
}

async function deliverWebhook(context: CronDeliveryContext): Promise<CronDeliveryResult> {
  const url = context.job.delivery.url as string | undefined;
  if (!url) {
    return { delivered: false, error: 'Webhook delivery requires delivery.url.' };
  }

  try {
    const payload = buildWebhookPayload(context);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    const secret = context.job.delivery.secret as string | undefined;
    if (secret) {
      headers['X-Webhook-Secret'] = secret;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      return {
        delivered: false,
        error: `Webhook delivery failed: HTTP ${response.status} ${response.statusText}`,
      };
    }

    return { delivered: true };
  } catch (error) {
    return {
      delivered: false,
      error: `Webhook delivery failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    };
  }
}

function buildWebhookPayload(context: CronDeliveryContext): JsonObject {
  return {
    type: 'cron.completed',
    jobId: context.job.id,
    cronRunId: context.cronRun.id,
    fireTime: context.cronRun.fireTime,
    status: context.cronRun.status,
    runId: context.cronRun.runId ?? null,
    rootRunId: context.cronRun.rootRunId ?? null,
    sessionId: context.cronRun.sessionId ?? null,
    error: context.cronRun.error ?? null,
    timestamp: context.now().toISOString(),
  };
}

function buildDeliverySummary(context: CronDeliveryContext): string {
  const { cronRun, job } = context;
  const statusLabel = cronRun.status === 'succeeded' ? 'completed successfully' : `finished with status "${cronRun.status}"`;
  return `[Scheduled job "${job.id}"] ${statusLabel} at ${cronRun.finishedAt ?? cronRun.startedAt}.${cronRun.error ? ` Error: ${cronRun.error}` : ''}`;
}

function buildDeliveryMetadata(context: CronDeliveryContext): JsonObject {
  return {
    cron: {
      jobId: context.job.id,
      cronRunId: context.cronRun.id,
      fireTime: context.cronRun.fireTime,
      status: context.cronRun.status,
    },
  };
}

export function applyCronApprovalPolicy(
  cronRun: GatewayCronRunRecord,
): GatewayCronRunRecord {
  if (cronRun.status === 'needs_review') {
    return cronRun;
  }

  return cronRun;
}

export function resolveCronRunStatusForApproval(
  originalStatus: string,
  approvalPolicy: 'fail' | 'needs_review',
): 'failed' | 'needs_review' {
  if (approvalPolicy === 'needs_review') {
    return 'needs_review';
  }
  return 'failed';
}
