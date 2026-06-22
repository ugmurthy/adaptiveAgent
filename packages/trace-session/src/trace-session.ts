#!/usr/bin/env bun

export { main, parseArgs } from './trace-session/cli.js';
export { listSessionlessRuns, listSessionPerformance, listSessions, loadUsageForTraceTarget, traceSession } from './trace-session/data.js';
export {
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
  renderTraceReport,
  renderUsageReport,
} from './trace-session/render.js';
export type {
  CliOptions,
  DelegateRow,
  MessageView,
  MilestoneEntry,
  PerformanceBucketSummary,
  PerformanceSummary,
  PlanRow,
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
