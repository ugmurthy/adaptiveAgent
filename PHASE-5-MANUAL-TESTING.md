# Phase 5 Manual Test Plan

## Purpose

This runbook verifies durable public-event projection, HTTP replay, Redis/Valkey fanout, authenticated WebSockets, reconnect recovery, exact-user ownership, controls, and terminal result delivery on a local development machine.

Run commands from the repository root unless stated otherwise.

## 1. Automated preflight

```bash
bun run --cwd packages/service test
bun run --cwd packages/service build
```

Expected result: 24 passing service tests and a successful build that includes `projector-main`.

Use `bun run --cwd packages/service test`; this invokes the package's configured Vitest suite.

## 2. Start local infrastructure

Start existing containers:

```bash
docker start adaptive-agent-postgres adaptive-redis
docker ps
```

If Redis does not exist:

```bash
docker run --name adaptive-redis -p 6379:6379 -d redis:7
```

Create PostgreSQL using the local settings in `postgres.sh` if it does not exist. Confirm both services:

```bash
docker exec adaptive-redis redis-cli ping
docker exec adaptive-agent-postgres \
  psql -U adaptive -d adaptive_agent -c 'select 1'
```

Redis should return `PONG`.

## 3. Configure the environment

Export these variables in every terminal used to start a service process:

```bash
export DATABASE_URL='postgres://adaptive:<your-password>@localhost:5432/adaptive_agent'
export REDIS_URL='redis://localhost:6379'
export AGENT_REGISTRY_PATH="$PWD/tmp/local-service-registry.json"

export JWT_ISSUER='https://local.adaptive-agent'
export JWT_AUDIENCE='adaptive-agent-local'
export JWT_HMAC_SECRET='local-development-secret-at-least-32-characters'

export HTTP_HOST=127.0.0.1
export PORT=3000
export PROJECTOR_INTERVAL_MS=250
export PROJECTOR_BATCH_SIZE=100
```

Verify that the local allowlist hash matches its agent file:

```bash
shasum -a 256 /Users/ugmurthy/.adaptiveAgent/agents/default-agent.json
cat tmp/local-service-registry.json
```

Update `contentHash` in the registry if the values differ. Export the model-provider credentials required by the agent, for example:

```bash
export OPENROUTER_API_KEY='...'
```

## 4. Start all service processes

Use separate terminals or tmux panes. Each process needs the environment above.

```bash
# Terminal 1: HTTP and WebSocket API
bun run packages/service/src/http-main.ts

# Terminal 2: PostgreSQL outbox dispatcher
bun run packages/service/src/dispatcher-main.ts

# Terminal 3: agent worker
bun run packages/service/src/agent-worker-main.ts

# Terminal 4: Phase 5 event projector
bun run packages/service/src/projector-main.ts

# Terminal 5: stale-job reconciler (recommended, not required for the happy path)
bun run packages/service/src/reconciler-main.ts
```

Check the API:

```bash
curl -s http://localhost:3000/health/live | jq
curl -s http://localhost:3000/health/ready | jq
```

Expected statuses are `ok` and `ready`. OpenAPI documentation is at `http://localhost:3000/docs`.

## 5. Generate a local JWT

```bash
export TOKEN="$(
  bun -e '
    import { SignJWT } from "jose";
    const token = await new SignJWT({ tenant_id: "local-tenant" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(process.env.JWT_ISSUER)
      .setAudience(process.env.JWT_AUDIENCE)
      .setSubject("local-user")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(process.env.JWT_HMAC_SECRET));
    console.log(token);
  '
)"

test -n "$TOKEN" && echo 'JWT generated'
```

## 6. Submit and poll over HTTP

```bash
RESPONSE="$(
  curl -sS -X POST http://localhost:3000/v1/jobs/run \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -H 'Idempotency-Key: manual-run-1' \
    -d '{
      "schemaVersion": 1,
      "agentId": "default-agent",
      "goal": "Return a short greeting and explain that this is a local Phase 5 test."
    }'
)"

echo "$RESPONSE" | jq
export JOB_ID="$(echo "$RESPONSE" | jq -r .jobId)"
```

Expected submission response:

```json
{"schemaVersion":1,"jobId":"..."}
```

Poll the job:

```bash
watch -n 1 \
  "curl -sS -H 'Authorization: Bearer $TOKEN' \
  http://localhost:3000/v1/jobs/$JOB_ID | jq"
```

The happy path is `accepted -> running -> succeeded`. A provider failure may produce `failed`; that still permits state-projection and replay testing.

## 7. Verify HTTP event replay

```bash
curl -sS \
  -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3000/v1/jobs/$JOB_ID/events?afterSequence=0&limit=100" \
  | jq 'map({sequence, type, data})'
```

Verify:

- Sequences start at 1 and increase strictly.
- Core events expose safe progress metadata, not raw inputs, outputs, or errors.
- Terminal jobs have a durable `job.state_changed` event.
- No event exposes credentials, storage keys, signed URLs, or raw provider responses.

Test the cursor:

```bash
curl -sS \
  -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3000/v1/jobs/$JOB_ID/events?afterSequence=2&limit=100" \
  | jq
```

Every returned event must have `sequence > 2`.

## 8. Subscribe over WebSocket

```bash
bunx wscat \
  -c ws://localhost:3000/v1/ws \
  -H "Authorization: Bearer $TOKEN"
```

Paste this message, replacing `YOUR_JOB_ID`:

```json
{"operation":"subscribe","requestId":"subscribe-1","jobId":"YOUR_JOB_ID","afterSequence":0}
```

Expected ordering:

1. A `response` with `subscribed: true`.
2. Zero or more `event` messages in ascending sequence order.
3. A terminal `job` message if the job is already `succeeded`, `failed`, or `cancelled`.

Example event:

```json
{
  "type":"event",
  "event":{
    "schemaVersion":1,
    "jobId":"...",
    "sequence":1,
    "type":"job.state_changed",
    "data":{"state":"accepted"},
    "occurredAt":"..."
  }
}
```

## 9. Verify reconnect recovery

1. Note the highest received event sequence, for example `7`.
2. Close `wscat` with `Ctrl+C`.
3. Let the job produce more events.
4. Reconnect with the command above.
5. Subscribe from the last cursor:

```json
{"operation":"subscribe","requestId":"reconnect-1","jobId":"YOUR_JOB_ID","afterSequence":7}
```

Verify:

- Only sequences greater than 7 are returned.
- Events produced while disconnected are recovered.
- No sequence is duplicated within the replayed range.
- Terminal state remains available through `GET /v1/jobs/:jobId` even if live delivery was missed.

## 10. Submit over WebSocket

```json
{
  "operation":"submit",
  "requestId":"ws-submit-1",
  "kind":"run",
  "idempotencyKey":"ws-manual-run-1",
  "request":{
    "schemaVersion":1,
    "agentId":"default-agent",
    "goal":"Return a one-sentence WebSocket test response."
  }
}
```

The response should contain a new `jobId`. Subscribe immediately using `afterSequence: 0`; replay must transition into live events without a sequence gap.

Verify request validation by attempting a server-owned override:

```json
{
  "operation":"submit",
  "requestId":"invalid-submit-1",
  "kind":"run",
  "request":{
    "schemaVersion":1,
    "agentId":"default-agent",
    "goal":"This request must be rejected.",
    "model":"client-controlled-model"
  }
}
```

Expected response:

```json
{
  "type":"error",
  "requestId":"invalid-submit-1",
  "error":{
    "schemaVersion":1,
    "code":"invalid_request",
    "message":"Invalid request.",
    "retryable":false
  }
}
```

## 11. Exercise WebSocket controls

Control validity depends on the current job state.

Cancel a non-terminal job:

```json
{"operation":"cancel","requestId":"cancel-1","jobId":"YOUR_JOB_ID","idempotencyKey":"manual-cancel-1"}
```

Steer a running or waiting job:

```json
{"operation":"steer","requestId":"steer-1","jobId":"YOUR_JOB_ID","guidance":"Keep the answer concise.","idempotencyKey":"manual-steer-1"}
```

Resolve an approval while `waiting_approval`:

```json
{"operation":"approve","requestId":"approve-1","jobId":"YOUR_JOB_ID","approved":true,"idempotencyKey":"manual-approve-1"}
```

Answer while `waiting_clarification`:

```json
{"operation":"clarify","requestId":"clarify-1","jobId":"YOUR_JOB_ID","answer":"Use the local development environment.","idempotencyKey":"manual-clarify-1"}
```

Unsubscribe:

```json
{"operation":"unsubscribe","requestId":"unsubscribe-1","jobId":"YOUR_JOB_ID"}
```

After unsubscribing, that connection must not receive later live events for the job.

## 12. Verify exact-user isolation

Generate a second token in the same tenant:

```bash
export OTHER_TOKEN="$(
  bun -e '
    import { SignJWT } from "jose";
    const token = await new SignJWT({ tenant_id: "local-tenant" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(process.env.JWT_ISSUER)
      .setAudience(process.env.JWT_AUDIENCE)
      .setSubject("another-user")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(process.env.JWT_HMAC_SECRET));
    console.log(token);
  '
)"
```

HTTP must return the same non-enumerating `404` used for an unknown job:

```bash
curl -i \
  -H "Authorization: Bearer $OTHER_TOKEN" \
  "http://localhost:3000/v1/jobs/$JOB_ID"
```

Connect as the second user:

```bash
bunx wscat \
  -c ws://localhost:3000/v1/ws \
  -H "Authorization: Bearer $OTHER_TOKEN"
```

Attempt to subscribe:

```json
{"operation":"subscribe","requestId":"unauthorized-1","jobId":"YOUR_JOB_ID","afterSequence":0}
```

Expected error code and message:

```json
{"code":"not_found","message":"Resource not found."}
```

The response must not reveal whether the job exists or who owns it.

## 13. Verify projection in PostgreSQL

Inspect projected events:

```bash
docker exec adaptive-agent-postgres \
  psql -U adaptive -d adaptive_agent \
  -c "
    select job_id, sequence, event_type, source_event_id, occurred_at
    from service_public_events
    where job_id = '$JOB_ID'
    order by sequence;
  "
```

Check for duplicate source events:

```bash
docker exec adaptive-agent-postgres \
  psql -U adaptive -d adaptive_agent \
  -c "
    select job_id, source_event_id, count(*)
    from service_public_events
    group by job_id, source_event_id
    having count(*) > 1;
  "
```

Expected result: zero rows.

Check sequence uniqueness and continuity:

```bash
docker exec adaptive-agent-postgres \
  psql -U adaptive -d adaptive_agent \
  -c "
    select
      count(*) as event_count,
      count(distinct sequence) as distinct_sequences,
      min(sequence) as first_sequence,
      max(sequence) as last_sequence
    from service_public_events
    where job_id = '$JOB_ID';
  "
```

For a contiguous stream beginning at 1, `event_count`, `distinct_sequences`, and `last_sequence` are equal, and `first_sequence` is 1.

## 14. Inspect Redis fanout

While producing events:

```bash
docker exec adaptive-redis redis-cli MONITOR
```

The projector publishes to `adaptive-agent:service-events`. Messages should contain only a wake-up cursor:

```json
{"jobId":"...","sequence":7}
```

Redis messages must not contain full events, results, credentials, model output, storage keys, or signed URLs. WebSocket servers load authoritative envelopes from PostgreSQL.

## 15. Verify multi-instance fanout

Start a second HTTP process against the same PostgreSQL and Redis instances:

```bash
PORT=3001 bun run packages/service/src/http-main.ts
```

Then:

1. Connect one authenticated WebSocket client to port 3000.
2. Connect another as the same user to port 3001.
3. Subscribe both to the same job and cursor.
4. Submit or advance the job.

Both clients should receive the same new sequences. Reconnecting either client with its last sequence must recover any missed wake-up from PostgreSQL.

## 16. Connection and backpressure checks

Verify these expected behaviors with a small-limit local configuration or a script that opens connections without reading messages:

- Connections beyond the total or per-user limit close with WebSocket code `1013`.
- A connection whose buffered amount exceeds the configured threshold closes with code `1013`.
- Event wake-ups are coalesced and drained from PostgreSQL rather than accumulated in an unbounded queue.
- Connections that stop answering heartbeat pings are terminated.

## 17. Exit checklist

- [ ] HTTP submission, polling, and event pagination work.
- [ ] Public event sequences are monotonic per job.
- [ ] Re-running projection does not duplicate source events.
- [ ] Public projection omits sensitive raw core payload fields.
- [ ] WebSocket authentication is required.
- [ ] WebSocket submission uses the same SDK behavior as HTTP.
- [ ] Server-owned execution overrides are rejected.
- [ ] Replay begins strictly after the requested sequence.
- [ ] Live delivery follows replay without a gap.
- [ ] Reconnect recovers events produced while disconnected.
- [ ] Separate API instances receive Redis wake-ups.
- [ ] Another user in the same tenant cannot read or subscribe to the job.
- [ ] Terminal results remain available over HTTP and WebSocket.
- [ ] Redis messages contain only job and sequence wake-up data.
- [ ] Slow clients and excessive connections are bounded.

## 18. Stop the environment

Stop each Bun process with `Ctrl+C`. Optionally stop local infrastructure:

```bash
docker stop adaptive-agent-postgres adaptive-redis
```

Do not remove the containers unless their persisted local data is no longer needed.
