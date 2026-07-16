# `@adaptive-agent/trace-session`

`trace-session` is a decision-oriented Postgres trace reporter for persisted
AdaptiveAgent sessions and runs. It turns runtime records into a stable
human-readable, JSON, or HTML report that explains what ran, whether the
execution can be trusted, what it consumed, and what to inspect next.

The package reads the core runtime tables directly. Gateway session tables are
optional, so reports continue to work for core-only runs.

Reporting is read-only. `maintenance empty-goal-sql` prints reviewable SQL for
empty-goal gateway sessions; it does not execute that SQL.

## Principle: decision-oriented trace reporting

A trace should not begin as an event dump. It should answer four questions in a
fixed order:

1. **What was inspected?** Identity, run hierarchy, and goal.
2. **Can I trust the run?** Outcome, reliability, and data coverage.
3. **What did it consume?** Wall time, cumulative work, tokens, calls, and cost.
4. **What needs attention?** Ranked findings, persisted evidence, and commands
   for the next inspection.

This principle has several consequences:

- Persisted events, snapshots, tool executions, leases, and usage records are
  evidence. Missing evidence is reported as uncertainty rather than guessed.
- Runtime reliability and answer quality are separate. A coherent successful
  execution can still produce a poor answer. Unless an evaluator result is
  persisted, the report says `Output quality: not evaluated`.
- Reliability uses explainable classifications, not an opaque numeric score.
- Views change the depth of a report, not the meaning of its fields.
- Costs are named explicitly. Model/tool-output cost, external tool-provider
  cost, and their estimated total are never silently conflated.
- Wall time and cumulative model/tool time are different. Cumulative work can
  exceed wall time when work is nested or concurrent; it is not automatically
  critical-path latency.

The default `summary` view follows a stable information model: Identity,
Verdict, Reliability, Operations, Findings, Goal/final output, suggested next
commands, and data warnings.

## Quick start

From the monorepo root:

```bash
export DATABASE_URL="postgres://postgres:postgres@localhost:5432/adaptive_agent"

# Find a run and copy its complete ID.
bun run trace-session list traces --limit 20

# The decision-oriented summary is the default.
RUN_ID=019abcde-1234-5678-9012-abcdefabcdef
bun run trace-session view run "$RUN_ID"
```

The short `trace-session` executable and the
`adaptive-agent-trace-session` executable are equivalent when the package is
linked or installed as a CLI.

Trace a session, root run, or any child run:

```bash
SESSION_ID=incident-review-2026-07-12
ROOT_RUN_ID=019abcde-1234-5678-9012-abcdefabcdef
RUN_ID=019fedcb-4321-8765-2109-fedcbafedcba

trace-session view session "$SESSION_ID"
trace-session view root-run "$ROOT_RUN_ID"
trace-session view run "$RUN_ID"
```

Use `--database-url`, `--database-url-env <name>`, or `--pgssl` when the default
`DATABASE_URL` connection is not appropriate.

## Views

| View | Question answered |
| --- | --- |
| `summary` | What happened, can it be trusted, what did it cost, and what needs attention? This is the default. |
| `reliability` | Which reliability classification and dimensions were derived, from what evidence? |
| `operations` | Where were time, tokens, provider requests, and cost spent? |
| `investigate` | What was the primary cause, what recovery occurred, and what were the consequences? |
| `timeline` | What lifecycle and tool activity occurred chronologically? |
| `messages` | What snapshot-backed model context was effective? |
| `output` | What final root-run results were persisted? |
| `all` | Show all available report sections. |

Compatibility views remain available:

- `overview` maps to `summary`.
- `performance` maps to `operations`.
- `brief`, `policy`, `milestones`, `delegates`, and `plans` retain their focused
  behavior.
- `usage` provides the fast usage-only report.
- `--only-delegates` remains an investigation filter.

## Release 1: presentation and usability

Release 1 established the stable reporting surface.

It shipped:

- stable Identity, Reliability, Operations, Findings, and Coverage concepts;
- `summary` as the default report;
- copy-friendly `list traces` cards;
- goal, status, type, role, and limit filters applied before trace expansion;
- explicit model/tool-output, tool-provider, and estimated total cost
  semantics; and
- compatibility aliases for the focused report views.

### Summary by default

Running `trace-session view` without `--report` produces the decision-oriented
summary. Identity, runtime verdict, reliability, operations, findings, and
coverage retain the same meaning in terminal, JSON, and HTML output.

```bash
trace-session view run "$RUN_ID"
trace-session view run "$RUN_ID" --report summary
trace-session view run "$RUN_ID" --json
trace-session view run "$RUN_ID" --html ./trace-report.html
```

Use `--messages` when the HTML or JSON report should include snapshot-backed
model context. Assistant reasoning is excluded unless `--reasoning` is
explicitly supplied.

### Copy-friendly discovery

`list traces` produces cards with full session, run, and root IDs on dedicated
lines. Only descriptive text such as the goal is truncated, making IDs safe to
copy into the next command.

Representative card:

```text
session  incident-review-2026-07-12
run  019abcde-1234-5678-9012-abcdefabcdef
root  019abcde-1234-5678-9012-abcdefabcdef
type  run
status  succeeded
timestamp  2026-07-12T10:14:18.000Z
duration  total 18.4s  model 12.1s  tools 4.8s  snapshot 120ms  other 1.4s
goal  Explain the incident and identify the primary recovery action
```

List filters are applied before rendering. Repeated `--goal`, `--status`, and
`--type` values use OR semantics.

```bash
# Case-insensitive goal matching.
trace-session list traces --goal "market entry" --limit 20

# Repeat --goal for OR matching, or use a regular expression.
trace-session list traces --goal "incident review" --goal "postmortem"
trace-session list traces --goal-regex 'incident|outage|recovery'

# Presence and status filters.
trace-session list traces --has-goal --status failed --status replan_required
trace-session list sessions --no-goal --limit 50

# Inspect individual swarm members by role.
trace-session list traces --type swarm-run --swarm-role worker
trace-session list traces --type swarm-run --swarm-role quality
```

The displayed identity types are:

- `run`: a standalone non-swarm run.
- `chat`: a gateway-backed chat session or turn.
- `swarm`: an aggregate swarm execution identified by its session and
  coordinator.
- `swarm-run`: an individual coordinator, worker, quality, or synthesizer run.

Historical core-only data may not contain enough metadata to distinguish chat
from ordinary run invocation. The current list fallback is `run`; treat that
fallback as non-authoritative for historical records.

### Explicit operations semantics

Operations output distinguishes:

- operator-visible wall duration;
- cumulative model, tool, and snapshot work;
- model/tool-output token cost;
- external tool-provider request cost;
- estimated total cost, which is the sum of the known cost components; and
- unpriced tool-provider requests, which are not silently treated as priced.

```bash
trace-session usage session "$SESSION_ID"
trace-session view run "$RUN_ID" --report operations
```

## Release 2: reliability and investigation

Release 2 makes reliability explainable and investigation causal. The same
derived diagnostics are attached to `report.diagnostics` and reused by the
terminal renderer, JSON output, static HTML reports, exported reports, and
Trace Workbench consumers.

It shipped:

- explainable reliability classifications and dimensions;
- incomplete-lifecycle, liveness, recovery-pressure, and unresolved-approval
  detection;
- findings ranked into primary cause, recovery, consequences, and context;
- complete persisted evidence references and ready-to-run commands; and
- explicit data-confidence levels, coverage, and warnings.

### Reliability classification

| Classification | Meaning |
| --- | --- |
| `healthy` | Terminal success with coherent lifecycle evidence and no material runtime or policy findings. |
| `recovered` | Terminal success after retry, interruption/resume, replan, rejected call, or transient model/tool failure activity. |
| `degraded` | Terminal success with lifecycle, policy, recovery-pressure, outcome-integrity, or evidence-confidence gaps. |
| `failed` | Terminal failure with attributable persisted evidence. |
| `blocked` | Non-terminal work requires approval, clarification, recovery, or operator action. |
| `unknown` | Persisted evidence is insufficient to classify runtime reliability. |

A successful run with retries is still successful. The `recovered`
classification makes the recovery visible without rewriting the runtime
outcome as failure.

### Reliability dimensions

Every reliability report explains six dimensions:

- **Outcome integrity:** root and child outcomes are coherent, and successful
  roots have persisted results.
- **Lifecycle integrity:** model, step, tool, run, and snapshot lifecycle
  evidence is paired and ordered coherently.
- **Recovery pressure:** model/run retries, retry delay, interruptions, resumes,
  continuations, replans, and rejected tool calls.
- **Liveness:** lease expiry, heartbeat freshness, and stale active status.
- **Policy integrity:** unresolved approvals, rejected calls, and exhausted
  budgets.
- **Evidence confidence:** observability availability, event/performance
  coverage, snapshot coverage, and tool-pricing coverage.

```bash
trace-session view run "$RUN_ID" --report reliability
```

Representative output:

```text
VERDICT RECOVERED

Outcome integrity    healthy    Root and child outcomes are coherent.
Lifecycle integrity  healthy    Observed lifecycle evidence is coherent.
Recovery pressure    recovered  2 model retries (1500ms delay).
Liveness             healthy    No stale heartbeat or expired lease evidence.
Policy integrity     healthy    No unresolved approvals were detected.
Data confidence      high       184 events available; snapshots present.

Output quality not-evaluated
Runtime reliability does not establish answer quality.
```

### Detectors

Release 2 derives findings for conditions including:

- started model, step, or tool work without matching terminal evidence;
- terminal run statuses without the expected terminal event;
- snapshot sequence gaps/regressions and resume without a prior snapshot;
- expired leases, stale heartbeats, and stale active runs;
- failed children attached to apparently successful parents;
- successful roots without persisted results;
- repeated failures, retry exhaustion, excessive recovery, and replan loops;
- approval requests without matching resolution; and
- completed tool output absent from loaded snapshot-backed model context.

The stale-run threshold is five minutes, matching the core runtime recovery
scanner. Some checks require optional data: message-context checks run only
when messages are loaded, and missing historical observability is reported as
lower confidence instead of fabricated attribution.

Snapshot sequence checks tolerate historical `snapshot.created` events that do
not carry a sequence number. A gap is reported only when the available numbered
and unnumbered evidence cannot account for it. Likewise, `delegate.spawned` is
treated as the link between an existing delegate tool call and its child run,
not as a second tool operation. This keeps reliability and operation counts
aligned with the runtime lifecycle instead of double-counting delegation or
degrading traces because older evidence is sparse.

### Causal investigation

Findings are sorted by causal role and then severity:

1. **Primary cause**
2. **Recovery**
3. **Consequences**
4. **Context and data gaps**

Each finding can carry complete root/run IDs, step IDs, tool-call IDs, event
sequence/type, timestamp, detail, and ready-to-run inspection commands.

```bash
trace-session view run "$RUN_ID" --report investigate
```

Representative finding:

```text
Primary cause

1. ERROR primary-cause failure Tool failures observed
   Evidence
   - event #42  tool.failed
     at 2026-07-12T10:14:22.403Z
     run
       019abcde-1234-5678-9012-abcdefabcdef
     step research-market
     tool call
       019fedcb-4321-8765-2109-fedcbafedcba
   Inspect
   $ trace-session view run 019abcde-1234-5678-9012-abcdefabcdef --report timeline
   $ trace-session view run 019abcde-1234-5678-9012-abcdefabcdef --report messages --messages-view delta
```

### Data confidence

Data confidence is reported as `high`, `medium`, `low`, or `unknown`, with the
underlying counts and warnings. It includes:

- observed and performance-measured event counts;
- snapshot coverage across traced runs;
- required observability availability; and
- priced versus total tool-provider requests.

Data quality is not silently converted into runtime failure. For example,
missing provider pricing is shown as a cost-coverage warning but does not by
itself downgrade a healthy execution. Loading `--messages` may add a context
finding without changing the reliability classification derived from the core
runtime evidence.

Inspect the structured diagnostics directly:

```bash
trace-session view run "$RUN_ID" --json \
  | jq '.diagnostics | {reliability, findings, suggestedNextViews}'
```

## Investigation workflow

A typical investigation starts broad and narrows using the generated commands:

```bash
# 1. Discover and copy the complete run ID.
trace-session list traces --status failed --limit 10

# 2. Read the decision summary.
trace-session view run "$RUN_ID"

# 3. Explain reliability or follow the causal findings.
trace-session view run "$RUN_ID" --report reliability
trace-session view run "$RUN_ID" --report investigate

# 4. Inspect the referenced event/tool lifecycle and effective context.
trace-session view run "$RUN_ID" --report timeline
trace-session view run "$RUN_ID" --report messages --messages-view delta

# 5. Preserve a shareable report.
trace-session view run "$RUN_ID" --messages --html ./trace-report.html
```

Use `--focus-run "$RUN_ID"` to restrict a report to one run subtree and
`--include-plans` when plan execution details are relevant.

## Persistent cache

Terminal trace and usage reports are cached for five minutes by default;
active reports are not cached by default. Cache entries are scoped by database,
target, and data-affecting options.

```bash
trace-session view run "$RUN_ID" --fresh
trace-session view run "$RUN_ID" --no-cache
trace-session view run "$RUN_ID" --cache-ttl 30s
```

Environment controls:

- `TRACE_SESSION_CACHE=off` disables reads and writes.
- `TRACE_SESSION_CACHE_TTL=30s` overrides the TTL.
- `TRACE_SESSION_CACHE_DIR=/path` overrides the cache directory.

Cache files can contain persisted goals, outputs, and message context. The
cache directory and files are created with user-only permissions, but operators
should still treat them as trace data.

## Release 3: analysis

Every normal report now includes `diagnostics.analysis.runs`, with one entry per
persisted run. It covers wall and measured duration, logical model calls and
attempts, retry amplification, tool calls and output reduction, usage and cost,
child fan-out, output size, and per-run evidence coverage. Measured duration is
model duration + tool duration + snapshot save duration; other duration is
`max(0, wall - measured)`, and parallelism is measured / wall. Model duration
sums terminal `model.completed` and `model.failed` spans so the elapsed spans
repeated on `model.retry` evidence are not counted twice.

Tool-call analysis follows the same logical-operation rule: delegation lifecycle
milestones enrich the originating tool call and do not add another call to the
operations totals.

Runtime retries are events with `phase === "runtime"`; all other model retry
events are adapter retries. Retry amplification is `(model starts + adapter
retries) / max(0, model starts - runtime retries)` and is `null` when the
denominator is zero. Tool output reduction is `(raw - model-visible) / raw`.
Usage keeps run-model and non-delegate tool-output usage separate and also
reports their combined total. External provider accounting remains separate;
the grand estimate adds run-model, tool-output, and external provider
estimates, while provider request cost coverage excludes unpriced requests.
Use `--report operations` for the human-readable per-run tables or `--json` for
the complete structured metrics.

Context growth uses ordered snapshot performance samples exclusively when any
exist, otherwise model-request samples. It reports initial, latest, peak,
absolute growth, and percentage growth for message bytes and counts. Missing
measurements are `null`, not inferred as zero.

Compare two exact runs in terminal, JSON, or self-contained HTML form:

```bash
trace-session compare "$BASELINE_RUN_ID" "$CANDIDATE_RUN_ID"
trace-session compare "$BASELINE_RUN_ID" "$CANDIDATE_RUN_ID" --json
trace-session compare "$BASELINE_RUN_ID" "$CANDIDATE_RUN_ID" --html comparison.html
```

Each side selects the requested run's own operational analysis. Token and cost
metrics use the requested run's resolved root-run tree, matching
`usage run <id>`; this includes child-run model usage without counting
delegate tool output twice. Other metrics, including wall time, retries,
failures, context growth, and output bytes, describe the requested run. All
deltas and percentage changes are candidate minus baseline. Runtime status is
per requested run; the reliability classification is explicitly labeled
`root-tree` because it is derived from the surrounding focused trace evidence.
Unavailable metrics remain `null` and produce notes. A change is not
automatically a regression; interpretation depends on the workload and
intended outcome.

### Aggregate trends and grouping

Use `aggregate` to turn the selected time window into one observation per root
trace and group those observations by root model, root terminal status, or UTC
start day:

```bash
# Compare models over the last seven days.
trace-session aggregate model --since 7d

# Follow daily trends within a bounded ISO window.
trace-session aggregate day \
  --since 2026-07-01T00:00:00Z \
  --until 2026-07-15T23:59:59Z

# Group by actual terminal outcome.
trace-session aggregate status --since 7d

# Preserve the same structured aggregate as JSON or self-contained HTML.
trace-session aggregate model --since 24h --json
trace-session aggregate day --since 30d --html trend-report.html
```

Durations include nearest-rank p50, p90, and p95 distributions. Outcome rates
come from persisted root-run status, not from the derived reliability
classification. `recovered` means an actually successful root trace that also
recorded retry activity. Successful-trace token and cost averages exclude
failed traces and exclude successful traces whose corresponding metric is not
measured; missing values never become zero.

The aggregate also exposes retry frequency, model and tool failures, context
growth distributions, common persisted errors, and per-group confidence.
Confidence is the least complete observation in the group, and notes identify
missing duration, usage, cost, or context samples. `--since` and `--until`
bound the population before detailed trace rows are loaded.

Grouping and comparison reuse the same derived run observations as normal
reports. They do not automatically label changes as regressions: changes in
latency, cost, retries, or context growth require workload and outcome context.

## Development

```bash
bun run typecheck
bun test
bun run build
```

Run these commands from `packages/trace-session`, or use the corresponding
`trace-session:*` scripts from the monorepo root.
