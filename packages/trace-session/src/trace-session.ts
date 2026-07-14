#!/usr/bin/env bun

export { main, parseArgs } from './trace-session/cli.js';
export { createTracePostgresPool, resolveTracePostgresConfig } from './db.js';
export type { TraceConfigOptions, TracePostgresConfig, TracePostgresPool } from './db.js';
export { listSessionlessRuns, listSessionPerformance, listSessions, loadUsageForTraceTarget, traceSession } from './trace-session/data.js';
export {
  buildTraceDiagnostics,
  buildTimeline,
  computeDelegateReason,
  summarizePerformance,
  summarizeTrace,
} from './trace-session/report.js';
export {
  renderDeleteEmptyGoalSessionsSql,
  renderSessionPerformanceList,
  renderSessionList,
  renderSessionlessRunList,
  renderTraceHtml,
  renderTraceReport,
  renderUsageReport,
} from './trace-session/render.js';
export type {
  CliOptions,
  DelegateRow,
  EvidenceRef,
  MessageView,
  MilestoneEntry,
  PerformanceBucketSummary,
  PerformanceDigest,
  PerformanceSummary,
  PolicyBudgetGroupSummary,
  PolicyDigest,
  DataConfidence,
  DataConfidenceLevel,
  EventType,
  RecoveryPressure,
  ReliabilityClassification,
  ReliabilityDiagnostics,
  ReliabilityDimension,
  ReliabilityDimensionStatus,
  PlanRow,
  ProviderModelUsageSummary,
  ReportView,
  RootRun,
  RunMessageTrace,
  RunSnapshotSummary,
  RunTreeEntry,
  SessionListItem,
  SessionPerformanceListItem,
  SessionOverview,
  SessionUsageSummary,
  SessionlessRunListItem,
  TimelineEntry,
  ToolAccountingSummary,
  TopRunUsage,
  TopToolMetric,
  TopToolSpan,
  TraceBrief,
  TraceDiagnostics,
  TraceFinding,
  TraceFindingCategory,
  TraceFindingRole,
  TraceFindingSeverity,
  TraceMessage,
  TraceMessageRole,
  TraceReport,
  TraceRow,
  TraceTarget,
  TraceToolCall,
  UsageSummary,
} from './trace-session/types.js';

import { main } from './trace-session/cli.js';

if (import.meta.main) {
  await main();
}
