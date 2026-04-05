import type { ParsedLogEvent } from './parser.js'

export type KnownNormalizedEventName =
  | 'run.created'
  | 'run.status_changed'
  | 'run.interrupted'
  | 'run.resumed'
  | 'run.completed'
  | 'run.failed'
  | 'plan.created'
  | 'plan.execution_started'
  | 'step.started'
  | 'step.completed'
  | 'tool.started'
  | 'tool.completed'
  | 'tool.failed'
  | 'delegate.spawned'
  | 'delegate.child_result'
  | 'approval.requested'
  | 'approval.resolved'
  | 'clarification.requested'
  | 'usage.updated'
  | 'snapshot.created'
  | 'replan.required'

export type NormalizedOutcome = 'success' | 'failure'

interface NormalizedEventBase {
  sourceFile: string
  line: number
  event: string
  raw: Record<string, unknown>
  time?: string
  timeMs?: number
  runId?: string
  subjectRunId?: string
  rootRunId?: string
  parentRunId?: string
  childRunId?: string
  stepId?: string
  toolName?: string
  delegateName?: string
  delegationDepth?: number
  durationMs?: number
  fromStatus?: string
  toStatus?: string
  provider?: string
  model?: string
  outcome?: NormalizedOutcome
  errorName?: string
  errorValue?: string
  errorCode?: string
}

export interface KnownNormalizedEvent extends NormalizedEventBase {
  kind: 'known'
  event: KnownNormalizedEventName
}

export interface GenericNormalizedEvent extends NormalizedEventBase {
  kind: 'generic'
}

export type NormalizedLogEvent = KnownNormalizedEvent | GenericNormalizedEvent

const KNOWN_EVENT_NAMES = new Set<KnownNormalizedEventName>([
  'run.created',
  'run.status_changed',
  'run.interrupted',
  'run.resumed',
  'run.completed',
  'run.failed',
  'plan.created',
  'plan.execution_started',
  'step.started',
  'step.completed',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'delegate.spawned',
  'delegate.child_result',
  'approval.requested',
  'approval.resolved',
  'clarification.requested',
  'usage.updated',
  'snapshot.created',
  'replan.required',
])

export function normalizeParsedEvents(parsedEvents: ParsedLogEvent[]): NormalizedLogEvent[] {
  return parsedEvents.map((parsedEvent) => normalizeParsedEvent(parsedEvent))
}

export function normalizeParsedEvent(parsedEvent: ParsedLogEvent): NormalizedLogEvent {
  const eventName = readString(parsedEvent.data.event) ?? 'unknown'
  const { time, timeMs } = normalizeTime(parsedEvent.data.time)
  const runId = readString(parsedEvent.data.runId)
  const parentRunId = readString(parsedEvent.data.parentRunId)
  const childRunId = readString(parsedEvent.data.childRunId)
  const outcomeFields = extractOutcomeFields(eventName, parsedEvent.data)
  const normalizedEvent: NormalizedEventBase = {
    sourceFile: parsedEvent.sourceFile,
    line: parsedEvent.line,
    event: eventName,
    raw: parsedEvent.data,
    time,
    timeMs,
    runId,
    subjectRunId: runId ?? parentRunId ?? childRunId,
    rootRunId: readString(parsedEvent.data.rootRunId) ?? runId,
    parentRunId,
    childRunId,
    stepId: readString(parsedEvent.data.stepId),
    toolName: readString(parsedEvent.data.toolName),
    delegateName: readString(parsedEvent.data.delegateName),
    delegationDepth: readNumber(parsedEvent.data.delegationDepth),
    durationMs: readNumber(parsedEvent.data.durationMs),
    fromStatus: readString(parsedEvent.data.fromStatus),
    toStatus: readString(parsedEvent.data.toStatus),
    provider: readString(parsedEvent.data.provider),
    model: readString(parsedEvent.data.model),
    ...outcomeFields,
  }

  if (KNOWN_EVENT_NAMES.has(eventName as KnownNormalizedEventName)) {
    return {
      ...normalizedEvent,
      kind: 'known',
      event: eventName as KnownNormalizedEventName,
    }
  }

  return {
    ...normalizedEvent,
    kind: 'generic',
  }
}

function normalizeTime(value: unknown): { time?: string; timeMs?: number } {
  const numericTime = readNumber(value)
  if (numericTime !== undefined) {
    return {
      time: new Date(numericTime).toISOString(),
      timeMs: numericTime,
    }
  }

  const stringTime = readString(value)
  if (!stringTime) {
    return {}
  }

  const parsedTime = Date.parse(stringTime)
  if (Number.isNaN(parsedTime)) {
    return {}
  }

  return {
    time: new Date(parsedTime).toISOString(),
    timeMs: parsedTime,
  }
}

function extractOutcomeFields(
  eventName: string,
  data: Record<string, unknown>,
): Pick<NormalizedEventBase, 'outcome' | 'errorName' | 'errorValue' | 'errorCode'> {
  if (eventName === 'tool.failed' || eventName === 'run.failed' || eventName === 'replan.required') {
    const failure = extractFailureMetadata(data)

    return {
      outcome: 'failure',
      errorCode: failure.errorCode,
      errorName: failure.errorName ?? (eventName === 'replan.required' ? 'REPLAN_REQUIRED' : undefined),
      errorValue:
        failure.errorValue ??
        readString(data.error) ??
        readString(data.code) ??
        (eventName === 'replan.required' ? 'Run requires replan before execution can continue.' : undefined),
    }
  }

  if (eventName === 'tool.completed' || eventName === 'run.completed') {
    return extractStructuredOutcome(readRecord(data.output)) ?? { outcome: 'success' }
  }

  if (eventName === 'delegate.child_result') {
    return extractStructuredOutcome(readRecord(data.result)) ?? {}
  }

  return {}
}

function extractStructuredOutcome(
  value: Record<string, unknown> | undefined,
): Pick<NormalizedEventBase, 'outcome' | 'errorName' | 'errorValue' | 'errorCode'> | undefined {
  if (!value) {
    return undefined
  }

  const status = readString(value.status)
  const success = readBoolean(value.success)

  if (
    success === false ||
    status === 'failure' ||
    status === 'error' ||
    status === 'clarification_requested' ||
    status === 'approval_requested'
  ) {
    const failure = extractFailureMetadata(value)

    return {
      outcome: 'failure',
      errorCode: failure.errorCode,
      errorName: failure.errorName ?? status?.toUpperCase(),
      errorValue:
        failure.errorValue ??
        (success === false ? 'Structured output reported success=false.' : undefined) ??
        (status ? `Structured output reported status=${status}.` : undefined),
    }
  }

  if (success === true || status === 'success') {
    return { outcome: 'success' }
  }

  return undefined
}

function extractFailureMetadata(
  value: Record<string, unknown>,
): { errorName?: string; errorValue?: string; errorCode?: string } {
  const errorRecord = readRecord(value.error)

  return {
    errorCode: readString(value.code),
    errorName:
      readString(errorRecord?.name) ?? readString(value.errorName) ?? readString(value.code) ?? readString(value.name),
    errorValue:
      readString(errorRecord?.value) ??
      readString(errorRecord?.message) ??
      readString(value.error) ??
      readString(value.message) ??
      readString(value.value),
  }
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  const unwrappedValue = unwrapCapturedValue(value)

  if (typeof unwrappedValue !== 'object' || unwrappedValue === null || Array.isArray(unwrappedValue)) {
    return undefined
  }

  return unwrappedValue as Record<string, unknown>
}

function unwrapCapturedValue(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value
  }

  const record = value as Record<string, unknown>
  if ('preview' in record) {
    return unwrapCapturedValue(record.preview)
  }

  return value
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
