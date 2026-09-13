# Core performance proposal

## Scope and conclusions

This review covers the runtime loop and the memory, SQLite, and Postgres stores
in `@adaptive-agent/core`. Model inference and external tools usually dominate
wall-clock time, so the estimates below apply to core overhead, not to total
latency for a remote-model run.

Recommended order:

1. Replace Postgres `MAX(seq) + 1` event allocation with a per-run atomic
   counter. This is both a correctness fix under concurrent writers and a
   measured performance improvement.
2. Collapse Postgres run mutation from a read plus update to one conditional
   `UPDATE ... RETURNING` without weakening optimistic concurrency.
3. Push SQLite recovery predicates, ordering, and limits into SQL instead of
   loading and parsing every run.
4. Reduce repeated snapshot serialization, then evaluate bounded delta
   snapshots behind replay/conformance tests.

One low-risk optimization is implemented with this proposal:
`InMemorySnapshotStore` now retains only the highest-sequence full snapshot per
run plus seen sequence numbers. `SnapshotStore` exposes only `save` and
`getLatest`, so retaining all historical payloads had no observable benefit.

## Measurements

Measurements ran on 2026-09-13 in a Linux Amp orb with Bun 1.3.10, 16 vCPUs,
local Postgres 15, and durability disabled for the disposable Postgres cluster
(`fsync=off`, `synchronous_commit=off`). Absolute database times are therefore
not production latency. Relative comparisons use the same client, connection,
schema, payload, warmup, and iteration count.

| Candidate | Synthetic workload | Current | Candidate | Headline estimate |
| --- | --- | ---: | ---: | ---: |
| Postgres run mutation | 2,000 local mutations | 0.238 ms/op | 0.114 ms/op | 52.0% lower store latency; 2.08x throughput |
| Postgres event sequence | 100k existing events, 2,000 appends | 311.7 ms | 260.1 ms | 16.6% lower append time |
| Concurrent event sequence | 8 writers x 100 appends to one run | 325/800 unique-key failures | 0/800 failures | Removes the observed race; counter took 40.8 ms vs 33.3 ms for the racy query |
| SQLite recovery predicate | 50k runs, 500 matching, limit 100, 30 scans | 60.02 ms/scan | 0.14 ms/scan | 434.7x for one indexed predicate; expect 10-100x for the complete scanner |
| Full snapshot retention | 30 tool steps, 60 snapshots, 4 KiB message/tool payloads | 11.55 MB | 0.37 MB | 96.8% lower retained payload in memory |
| Snapshot serialization | Same 60 snapshots, 300 rounds | 1,732.9 ms | 548.0 ms | 68.4% less serialization CPU; 3.16x for this CPU-only section |
| Delta snapshots | Same 60 snapshots, delta each transition and full checkpoint every 10 | 11.57 MB written | 1.81 MB written | 84.4% fewer snapshot bytes |

The SQLite candidate measurement isolates one predicate. The complete scanner
has several predicates and child/parent joins, so 434.7x must not be used as an
end-to-end claim. A 10-100x scanner improvement is a planning range to validate
against realistic databases.

## 1. Make Postgres event sequencing atomic per run

### Evidence

`POSTGRES_RUNTIME_EVENT_QUERIES.append` in
`src/postgres-runtime-stores.ts` computes `COALESCE(MAX(seq), 0) + 1` and then
inserts under `UNIQUE (run_id, seq)`. The `(run_id, seq)` index makes the maximum
lookup reasonably fast, but it does not serialize two writers that observe the
same maximum. The concurrent benchmark produced 325 unique-key failures from
800 attempted appends. `PostgresEventStore.append` does not retry those
conflicts.

### Change

Add a small `agent_event_sequences` table keyed by `run_id`, backfill it from
existing events, and allocate with one row-locking upsert in the same statement
or transaction as the event insert. Keep counters per run rather than global so
unrelated runs do not contend. Do not reuse `agent_runs.version`; event appends
must not create false optimistic-concurrency conflicts on run mutation.

The migration must be safe for existing runs and concurrent deployment:

- backfill each counter to `MAX(agent_events.seq)`;
- initialize a counter when a run is created or on first append;
- allocate and insert atomically;
- retain `UNIQUE (run_id, seq)` as defense in depth;
- add concurrent append and rollback tests to store conformance.

### Security and reliability

This removes a denial-of-service/reliability edge where concurrent legitimate
writers can fail a run. Parameterized SQL and the existing foreign key should
remain. A global sequence or application-memory counter would introduce either
cross-run contention or split-brain risk and is not recommended.

### Expected result

Expect about 10-20% lower sequential append overhead at large per-run histories
on a low-latency database, with the larger benefit being zero sequence races.
On a remote database the one-round-trip shape is preserved, so network latency
does not erase the benefit.

## 2. Remove the extra Postgres read before every run update

### Evidence

`PostgresRunStore.updateRun` first calls `getRun`, validates and merges the
patch in TypeScript, then issues an optimistic `UPDATE ... RETURNING`. This is
two sequential database round trips for frequent status, usage, current-step,
and lease-adjacent mutations. The local benchmark measured 52.0% lower latency
when the equivalent mutation used one returning update.

### Change

Use a fixed, parameterized conditional update that applies only mutable fields
and checks `WHERE id = $1 AND version = $expected`. Presence flags are needed
to distinguish an omitted field from an explicit null. Derive terminal
`completed_at` in SQL or in a dedicated terminal-transition query. Return the
updated row and distinguish missing run from version mismatch only when the
caller needs the more specific diagnostic; that error path may perform a read.

Do not generate column names dynamically. Keep `assertMutableRunPatch` (adapted
to reject immutable patch keys before SQL), status-transition validation, and
the expected-version predicate. Add asymmetric tests for omitted vs null
values, terminal transitions, missing runs, and stale versions.

### Security and reliability

The optimization must not become a generic JSON-to-SQL patch facility. A fixed
allowlist avoids SQL injection and mass assignment. Optimistic concurrency is
part of durable runtime correctness and must remain fail-closed.

### Expected result

Expect 40-55% lower latency for `updateRun` itself and close to 2x mutation
throughput when database round trips dominate. Total run speedup will be small
for remote-model workloads, but meaningful for local models, recovery, and
tool-heavy runs.

## 3. Query SQLite recovery candidates instead of parsing all runs

### Evidence

`SqliteRecoveryScanner.scan` in `src/sqlite-runtime-stores.ts` selects every
`record_json`, parses every run, constructs a full ID map, and repeatedly
filters and sorts the complete array. Work and memory are proportional to all
retained runs even when the caller requests a small limit. The SQLite schema
already stores and indexes status, timestamps, parent IDs, and current-child
IDs alongside `record_json`.

### Change

Implement one parameterized query per recovery reason, preserving the current
per-reason limit and ordering. Use joins for terminal-child, linkage-mismatch,
and orphan checks. Select and parse `record_json` only for bounded candidates
and linked children. Deduplicate only if current semantics require it; today a
run may legitimately appear under more than one reason.

Before merging, benchmark a mixed fixture that covers every recovery reason,
compare exact ordered output with the current scanner, and inspect `EXPLAIN
QUERY PLAN`. Add or change indexes only when those plans show a scan.

### Security and reliability

Use bound timestamps and limits, retain the existing limit validation, and cap
all result sets. SQL pushdown reduces the amount of attacker-influenced JSON
parsed in one recovery pass. Join logic must preserve missing-child and
linkage-mismatch distinctions because recovery decisions depend on them.

### Expected result

Expect 10-100x faster scans and bounded memory at tens of thousands of runs.
The isolated indexed-predicate benchmark reached 434.7x, but that is an upper
bound rather than a full-scanner estimate.

## 4. Reduce full-state snapshot amplification

### Evidence

`saveExecutionSnapshotWithStores` reads the latest snapshot, serializes the
entire accumulated message state, saves it, and appends a snapshot event.
`snapshotPerformanceMetrics` then JSON-serializes the full state, messages, and
pending calls for byte counts; Postgres serializes the full state again in
`jsonbParam`. Since the transcript grows each step, cumulative snapshot bytes
are quadratic in run length.

### Near-term change

First remove the sequence-allocation read using a store-owned atomic snapshot
counter. Then measure byte counts from the serialized representation instead of
serializing the same payload repeatedly. This likely requires an internal
prepared-snapshot representation or sampled detailed metrics; do not weaken
the public `SnapshotStore` JSON contract merely to optimize Postgres.

The implemented in-memory change keeps only the latest payload and a set of
seen sequence numbers. It preserves clone isolation, duplicate rejection, and
highest-sequence behavior, while removing per-save sorting and historical full
payload retention.

### Later change: bounded delta snapshots

If production traces confirm large snapshot payloads, add versioned deltas plus
a full checkpoint every fixed number of transitions. Recovery must verify the
base sequence and checksum, cap chain length and reconstructed bytes, and fail
closed on gaps or incompatible schema versions. Snapshot and corresponding
event writes must remain transactional.

Do not simply snapshot less often. The snapshot that records queued tool calls
and the snapshot after idempotent tool completion are crash-recovery boundaries.
Skipping either can repeat side effects or lose completion state.

### Security and reliability

Delta chains add parser and resource-exhaustion risk. Bound every chain and
payload, validate each delta, and retain periodic full checkpoints. Property
tests should interrupt after every persistence boundary and compare resumed
results with uninterrupted execution.

### Expected result

The implemented memory-store change reduced retained synthetic payload by
96.8%. Eliminating duplicate serialization measured 68.4% less CPU in the
serialization-only section; expect roughly 5-20% lower core snapshot latency
after database work is included. Bounded deltas reduced synthetic bytes by
84.4%; validate 70-90% on real long runs before implementation.

## Lower-priority observations

- `PostgresPlanStore.createPlan` inserts steps one round trip at a time. A
  parameterized batch insert should approach an N-to-1 round-trip reduction for
  large plans, but plans are usually small and model latency dominates. Measure
  real plan sizes before changing it.
- `InMemoryEventStore.listByRun(afterSeq)` scans the full array. Binary search
  followed by `slice` would help polling large histories, but memory mode is not
  the durable production path. Add it only with evidence of repeated tail reads.
- `EventStore.listByRun` has no page limit. A bounded/paginated API would reduce
  memory and response-size denial-of-service risk, but it is a public contract
  change and requires coordinated consumers.

## Changes not recommended now

- Do not parallelize arbitrary tool calls. Approval order, idempotency,
  workspace writes, child-run limits, and event ordering make unrestricted
  parallel execution unsafe even when nominal wall time would improve.
- Do not weaken cloning in public in-memory stores. Callers must not mutate
  persisted state through shared object references.
- Do not add indexes speculatively. Current Postgres event, snapshot, status,
  lease, parent, and session lookups already have relevant indexes; extra
  indexes increase write amplification.
- Do not compress or truncate model-visible tool results inside persistence.
  Any compaction must preserve replay and resume semantics and should occur at
  an explicit model-context boundary.

## Validation plan

For each durable-store change:

1. Run the shared memory, SQLite, and Postgres store-conformance suite.
2. Add concurrent writers and injected rollback/failure tests.
3. Interrupt before and after every snapshot/tool-completion boundary and
   compare recovery output and emitted event order.
4. Benchmark realistic small, median, and large histories with production-like
   Postgres durability and network latency.
5. Record p50, p95, failures, bytes written, and peak process memory. Ship only
   when correctness output is identical and the measured target improves.
