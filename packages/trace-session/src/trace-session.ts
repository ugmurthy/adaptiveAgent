#!/usr/bin/env bun

export * from './index.js';
export { main, parseArgs } from './trace-session/cli.js';
export {
  renderDeleteEmptyGoalSessionsSql,
  renderSessionPerformanceList,
  renderSessionList,
  renderSessionlessRunList,
  renderTraceAggregate,
  renderTraceAggregateHtml,
  renderTraceHtml,
  renderTraceComparison,
  renderTraceComparisonHtml,
  renderTraceReport,
  renderUsageReport,
} from './trace-session/render.js';

import { main } from './trace-session/cli.js';

if (import.meta.main) {
  await main();
}
