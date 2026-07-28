# Phase 3 CLI Manual Test Plan

## Scope

Test `gateway` mode after `local` and `byok` pass.

```bash
cd /Users/ugmurthy/riding-amp/AgentSmith
export ROOT="$PWD"
AA=(bun run packages/agent-sdk/src/adaptive-agent.ts)
```

## Setup

### PostgreSQL

The CLI may use a memory core runtime, but the gateway requires PostgreSQL for
billing. Start an isolated container with generated credentials:

```bash
export PHASE3_DB_CONTAINER="adaptive-agent-gateway-pg-$(date +%s)"
export PHASE3_DB_PASSWORD="$(openssl rand -hex 24)"
export PHASE3_DB_PORT=55433

docker run --name "$PHASE3_DB_CONTAINER" \
  -e POSTGRES_USER=adaptive \
  -e POSTGRES_PASSWORD="$PHASE3_DB_PASSWORD" \
  -e POSTGRES_DB=adaptive_agent \
  -p "${PHASE3_DB_PORT}:5432" \
  -d postgres:17

export DATABASE_URL="postgres://adaptive:${PHASE3_DB_PASSWORD}@127.0.0.1:${PHASE3_DB_PORT}/adaptive_agent"
```

PostgreSQL error `28P01` means the username/password in `DATABASE_URL` does not
match that server. Existing containers retain their original database password;
restarting one with a new environment variable does not reset it.

Wait and verify before starting the gateway:

```bash
until docker exec "$PHASE3_DB_CONTAINER" pg_isready -U adaptive -d adaptive_agent; do sleep 1; done

bun -e '
  import { Client } from "pg";
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  console.log((await db.query("select current_database(), current_user")).rows);
  await db.end();
'
```

Create a protected environment file for both terminals:

```bash
export GATEWAY_JWT_HMAC_SECRET="$(openssl rand -hex 32)"
export GATEWAY_JWT_ISSUER='adaptive-agent-manual'
export GATEWAY_JWT_AUDIENCE='adaptive-agent-gateway'
umask 077
{
  printf 'export DATABASE_URL=%q\n' "$DATABASE_URL"
  printf 'export PHASE3_DB_CONTAINER=%q\n' "$PHASE3_DB_CONTAINER"
  printf 'export GATEWAY_JWT_HMAC_SECRET=%q\n' "$GATEWAY_JWT_HMAC_SECRET"
  printf 'export GATEWAY_JWT_ISSUER=%q\n' "$GATEWAY_JWT_ISSUER"
  printf 'export GATEWAY_JWT_AUDIENCE=%q\n' "$GATEWAY_JWT_AUDIENCE"
} >/tmp/adaptive-gateway-manual.env
```

### Route policy, agent, and settings

```bash
export MANUAL_MODEL='qwen3.5' # Replace with an installed tool-capable model.
ollama list

jq --arg model "$MANUAL_MODEL" '
  .version = "manual-ollama-v1"
  | .tiers |= with_entries(.value.targets = [{
      provider: "ollama",
      model: $model,
      baseUrl: "http://127.0.0.1:11434/v1",
      maxConcurrency: 4
    }])
' packages/capability-gateway/config/route-policy.example.json \
  >/tmp/adaptive-gateway-route-policy.json

cat >/tmp/adaptive-gateway-agent.json <<'JSON'
{
  "id": "gateway-manual-agent",
  "name": "Gateway Manual Agent",
  "invocationModes": ["run", "chat"],
  "defaultInvocationMode": "run",
  "model": { "provider": "ollama", "model": "client-placeholder" },
  "systemInstructions": "Do not delegate. Use local tools when explicitly required.",
  "tools": ["read_file", "list_directory"],
  "defaults": { "maxSteps": 12, "autoApproveAll": true }
}
JSON

cat >/tmp/adaptive-gateway.settings.json <<'JSON'
{
  "runtime": { "mode": "memory" },
  "inference": { "mode": "gateway", "tier": "medium" },
  "gateway": {
    "url": "ws://127.0.0.1:3000/rpc",
    "accessTokenEnv": "ADAPTIVE_AGENT_ACCESS_TOKEN",
    "connectTimeoutMs": 5000,
    "requestTimeoutMs": 180000,
    "reconnectAttempts": 2
  }
}
JSON
```

### Start the gateway

Terminal A:

```bash
cd /Users/ugmurthy/riding-amp/AgentSmith
source /tmp/adaptive-gateway-manual.env
export GATEWAY_ROUTE_POLICY_PATH=/tmp/adaptive-gateway-route-policy.json
export GATEWAY_HOST=127.0.0.1
export GATEWAY_PORT=3000

bun run --cwd packages/capability-gateway start \
  2>&1 | tee /tmp/adaptive-gateway.log
```

Pass: `capability_gateway.server.started` reports `ready`.

### Mint a token

Terminal B:

```bash
cd /Users/ugmurthy/riding-amp/AgentSmith
export ROOT="$PWD"
AA=(bun run packages/agent-sdk/src/adaptive-agent.ts)
source /tmp/adaptive-gateway-manual.env

mint_token() {
  ALLOWED_TIERS="${1:-[\"low\",\"medium\",\"high\",\"xtra-high\"]}" \
  PERMITTED_MODES="${2:-[\"gateway\"]}" bun -e '
    import { SignJWT } from "jose";
    console.log(await new SignJWT({
      account_id: "manual-account",
      tenant_id: "manual-tenant",
      allowed_tiers: JSON.parse(process.env.ALLOWED_TIERS),
      permitted_modes: JSON.parse(process.env.PERMITTED_MODES)
    })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("manual-user")
      .setIssuer(process.env.GATEWAY_JWT_ISSUER)
      .setAudience(process.env.GATEWAY_JWT_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("2h")
      .sign(new TextEncoder().encode(process.env.GATEWAY_JWT_HMAC_SECRET)));
  '
}

export ADAPTIVE_AGENT_ACCESS_TOKEN="$(mint_token)"

COMMON=(
  --cwd "$ROOT"
  --agent /tmp/adaptive-gateway-agent.json
  --settings /tmp/adaptive-gateway.settings.json
  --runtime memory
  --inference-mode gateway
)
```

Do not print the token.

## Tests 1-11

### 1. Configuration

```bash
"${AA[@]}" config "${COMMON[@]}" --output json | jq '.inference, .gateway'
```

Pass: mode `gateway`, tier `medium`, correct URL, and no token value.

### 2. Basic memory run

```bash
"${AA[@]}" run "Reply with exactly GATEWAY_OK." "${COMMON[@]}" \
  --tier medium --inspect --output json >/tmp/gateway-basic.json
```

Pass: success, permit present, and route policy `manual-ollama-v1`.

### 3. Server-owned route

Repeat Test 2 with `--model client-model-must-not-be-used`.

Pass: resolved client model has that value, while result usage reports Ollama
and `$MANUAL_MODEL`.

### 4. Exact authorization identity

```bash
jq -e '.inspection.run.id == .inspection.run.executionContext.authorizationRunId' \
  /tmp/gateway-basic.json
```

### 5. Local tool round-trip

```bash
export PROOF="GATEWAY_LOCAL_TOOL_$(date +%s)"
printf '%s\n' "$PROOF" >tmp/gateway-proof.txt

"${AA[@]}" run \
  "Call read_file exactly once for tmp/gateway-proof.txt, then return only its contents." \
  "${COMMON[@]}" --tier medium --inspect --output json >/tmp/gateway-tool.json
```

Pass: proof returned, one `tool.completed`, and at least two `model.completed`
events.

### 6. Per-run tier

Run Test 2 with `--tier high`.

Pass: inspection context and newest billing row both report `high`.

### 7. Tier denial

Mint a low-only token, attempt `--tier high`, then restore the original token:

```bash
export FULL_TOKEN="$ADAPTIVE_AGENT_ACCESS_TOKEN"
export ADAPTIVE_AGENT_ACCESS_TOKEN="$(mint_token '["low"]')"
# Run Test 2 with --tier high; expect failure.
export ADAPTIVE_AGENT_ACCESS_TOKEN="$FULL_TOKEN"
```

Pass: nonzero exit, `tier_not_entitled`, and no billing row.

### 8. Missing token

Temporarily unset `ADAPTIVE_AGENT_ACCESS_TOKEN` and run Test 2.

Pass: `Gateway access token is unavailable` and no billing row.

### 9. Gateway unavailable

Stop the gateway, run Test 2, then restart it.

Pass: bounded connection failure and no billing row.

### 10. Billing and leakage

```bash
docker exec "$PHASE3_DB_CONTAINER" psql -U adaptive -d adaptive_agent -x -c '
  select call_id, requested_tier, route_policy_version, provider, model,
         input_tokens, output_tokens, total_tokens, cost, status
  from capability_gateway_billing order by created_at desc limit 10;
'
```

Pass: metadata/usage only; no prompt, output, tool result, key, or token in
billing or `/tmp/adaptive-gateway.log`.

### 11. Trace correlation

Run once with `--runtime postgres`, save `.result.runId` as `RUN_ID`, then:

```bash
"${AA[@]}" replay --run-id "$RUN_ID" \
  --cwd "$ROOT" --agent /tmp/adaptive-gateway-agent.json \
  --settings /tmp/adaptive-gateway.settings.json \
  --runtime postgres --inference-mode gateway --output json \
  >/tmp/gateway-replay.json
```

Pass: local `model.completed` call ID and adapter trace ID match the gateway log
and billing row.

## Test 12: WebSocket reconnect with Toxiproxy

Reset only the CLI-to-gateway connection; do not kill the gateway. The gateway
must stay alive because Phase 3 replay uses its in-memory active/terminal call
cache. Toxiproxy breaks the TCP connection while provider work continues. The
client should reconnect, initialize again, and resend `model/generate` with the
same call ID. The gateway should replay cached stream events/result instead of
starting and billing another logical call.

### Start Toxiproxy

```bash
brew tap shopify/shopify
brew install toxiproxy
toxiproxy-server >/tmp/toxiproxy.log 2>&1 &
export TOXIPROXY_PID=$!

curl -fsS -X POST http://127.0.0.1:8474/proxies \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "adaptive-gateway",
    "listen": "127.0.0.1:3001",
    "upstream": "127.0.0.1:3000",
    "enabled": true
  }'
```

The CLI will use port `3001`; Toxiproxy forwards it to the real gateway on
`3000`:

```bash
jq '
  .gateway.url = "ws://127.0.0.1:3001/rpc"
  | .gateway.reconnectAttempts = 10
' /tmp/adaptive-gateway.settings.json >/tmp/adaptive-gateway-proxy.settings.json
```

### Start a long model call

```bash
"${AA[@]}" run \
  "Do not call tools. Write a detailed 1500-word explanation of WebSocket reconnect semantics." \
  --cwd "$ROOT" --agent /tmp/adaptive-gateway-agent.json \
  --settings /tmp/adaptive-gateway-proxy.settings.json \
  --runtime memory --inference-mode gateway --tier medium \
  --inspect --output json \
  >/tmp/gateway-reconnect.json 2>/tmp/gateway-reconnect.err &
export RECONNECT_PID=$!
```

Wait until the gateway has inserted the active billing row. This ensures the
logical request reached the server before the connection is reset:

```bash
until docker exec "$PHASE3_DB_CONTAINER" \
  psql -U adaptive -d adaptive_agent -Atc \
  "select exists(
     select 1 from capability_gateway_billing
     where account_id = 'manual-account' and status = 'active'
   );" | rg -q '^t$'
do
  sleep 0.05
done
```

### Reset the connection

Add a downstream `reset_peer` toxic. It sends a TCP reset to the CLI side. Remove
it immediately so the client's replacement WebSocket can connect normally:

```bash
curl -fsS -X POST \
  http://127.0.0.1:8474/proxies/adaptive-gateway/toxics \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "one-reset",
    "type": "reset_peer",
    "stream": "downstream",
    "toxicity": 1,
    "attributes": { "timeout": 0 }
  }'

curl -fsS -X DELETE \
  http://127.0.0.1:8474/proxies/adaptive-gateway/toxics/one-reset

wait "$RECONNECT_PID"
```

### Validate replay and billing

```bash
jq -e '.result.status == "success"' /tmp/gateway-reconnect.json

CALL_ID="$(docker exec "$PHASE3_DB_CONTAINER" \
  psql -U adaptive -d adaptive_agent -Atc \
  "select call_id from capability_gateway_billing
   where account_id = 'manual-account'
   order by created_at desc limit 1;")"

docker exec "$PHASE3_DB_CONTAINER" psql -U adaptive -d adaptive_agent -x -c \
  "select call_id, status, provider, model, requested_tier
   from capability_gateway_billing
   where account_id = 'manual-account' and call_id = '$CALL_ID';"
```

Pass criteria:

- Gateway remains running throughout the test.
- Gateway logs show WebSocket close followed by open/initialize.
- CLI completes with an untruncated response.
- The replayed request retains its original call ID.
- Exactly one billing row exists for that call ID.
- The billing row ends as `completed`.

The deterministic automated gateway test is the stronger proof that the
provider invocation count is exactly one. This manual test proves the real CLI,
transport reconnect, server replay, and billing behavior together.

## Repeat Tests 1-12 with SQLite (Phase 4 gate)

Repeat the Phase 3 tests with SQLite as the CLI/core runtime. PostgreSQL is
still required by the capability gateway for billing; do not unset
`DATABASE_URL` or stop the PostgreSQL container. SQLite replaces only the
memory/PostgreSQL runtime selected by the CLI.

Use Terminal B with the gateway, PostgreSQL container, Ollama, token minting
function, and access token from the original setup still active.

### Create an isolated SQLite runtime

Use a fresh database so runs from another test do not affect inspection or
recovery results:

```bash
export PHASE3_SQLITE_PATH="/tmp/adaptive-gateway-phase3-$(date +%s).sqlite"
export PHASE3_SQLITE_SETTINGS=/tmp/adaptive-gateway-sqlite.settings.json
export PHASE3_SQLITE_PROXY_SETTINGS=/tmp/adaptive-gateway-sqlite-proxy.settings.json

rm -f "$PHASE3_SQLITE_PATH" \
  "$PHASE3_SQLITE_PATH-wal" \
  "$PHASE3_SQLITE_PATH-shm"

jq --arg path "$PHASE3_SQLITE_PATH" '
  .runtime.mode = "sqlite"
  | .runtime.sqlitePath = $path
' /tmp/adaptive-gateway.settings.json >"$PHASE3_SQLITE_SETTINGS"

COMMON=(
  --cwd "$ROOT"
  --agent /tmp/adaptive-gateway-agent.json
  --settings "$PHASE3_SQLITE_SETTINGS"
  --runtime sqlite
  --inference-mode gateway
)
```

The explicit `--runtime sqlite` verifies the CLI option. The settings path
verifies that every new CLI process reopens the same database. No
`ADAPTIVE_AGENT_SQLITE_PATH` or core-runtime `DATABASE_URL` is needed.

### Repeat Tests 1-10

Run Tests 1 and 2 exactly as written with the SQLite `COMMON` array above.
Treat Test 2 as the basic SQLite run, then complete the persistence checkpoint
in the next section before continuing with Tests 3-10. The commands will
overwrite the earlier `/tmp/gateway-basic.json` and `/tmp/gateway-tool.json`
files; rename those outputs first if the memory-run evidence must be retained.

For Test 1, also verify the resolved SQLite mode and path:

```bash
"${AA[@]}" config "${COMMON[@]}" --output json \
  | tee /tmp/gateway-sqlite-config.json \
  | jq '.runtime, .inference, .gateway'

jq -e --arg path "$PHASE3_SQLITE_PATH" '
  .runtime.requestedMode == "sqlite"
  and .runtime.mode == "sqlite"
  and .runtime.sqlitePath == $path
  and .inference.mode == "gateway"
' /tmp/gateway-sqlite-config.json
```

Tests 7-9 retain the same negative-path expectations. Compare billing row
counts immediately before and after each rejected request if previous Phase 3
runs make the "no billing row" check ambiguous.

### Verify persistence across CLI processes

After Test 2 completes, its CLI process has closed the SQLite connection. Save
that successful output before later test variants can overwrite it, then open
the same run from a new CLI process:

```bash
cp /tmp/gateway-basic.json /tmp/gateway-sqlite-basic.json
export SQLITE_RUN_ID="$(jq -er '.result.runId' /tmp/gateway-sqlite-basic.json)"

"${AA[@]}" inspect --run-id "$SQLITE_RUN_ID" \
  "${COMMON[@]}" --output json \
  >/tmp/gateway-sqlite-inspect.json

jq -e --arg run_id "$SQLITE_RUN_ID" '
  .inspection.run.id == $run_id
  and .inspection.run.status == "succeeded"
  and .inspection.eventCount > 0
' /tmp/gateway-sqlite-inspect.json
```

Pass: the second process finds the completed run and its persisted events.
Continue with Tests 3-10 after this check passes.

Inspect the embedded database directly after all CLI commands have exited:

```bash
bun -e '
  import { Database } from "bun:sqlite";
  const db = new Database(process.env.PHASE3_SQLITE_PATH, { strict: true });
  console.log({
    journalMode: db.query("pragma journal_mode").get(),
    schemaVersion: db.query("pragma user_version").get(),
    runCount: db.query("select count(*) as count from agent_runs").get(),
    eventCount: db.query("select count(*) as count from agent_events").get()
  });
  db.close(false);
'
```

Pass: journal mode is `wal`, schema version is nonzero, and run/event counts
are nonzero.

### Repeat Test 11 with SQLite

Use the persisted Test 2 run instead of creating a PostgreSQL-backed core run:

```bash
"${AA[@]}" replay --run-id "$SQLITE_RUN_ID" \
  "${COMMON[@]}" --output json \
  >/tmp/gateway-sqlite-replay.json
```

Apply the same trace-correlation checks from Test 11. Pass: the replayed local
`model.completed` call ID and adapter trace ID match the gateway log and billing
row, and the run is available after reopening SQLite.

### Repeat Test 12 with SQLite

Create the proxy settings from the SQLite settings, not from the original
memory settings:

```bash
jq '
  .gateway.url = "ws://127.0.0.1:3001/rpc"
  | .gateway.reconnectAttempts = 10
' "$PHASE3_SQLITE_SETTINGS" >"$PHASE3_SQLITE_PROXY_SETTINGS"
```

If the Toxiproxy server and `adaptive-gateway` proxy from the original Test 12
are still running, reuse them instead of creating another server or proxy with
the same name. Otherwise, repeat the original Toxiproxy setup. Then repeat the
active-billing wait, connection reset, and billing validation from Test 12.
Replace only the long model-call command with:

```bash
"${AA[@]}" run \
  "Do not call tools. Write a detailed 1500-word explanation of WebSocket reconnect semantics." \
  --cwd "$ROOT" --agent /tmp/adaptive-gateway-agent.json \
  --settings "$PHASE3_SQLITE_PROXY_SETTINGS" \
  --runtime sqlite --inference-mode gateway --tier medium \
  --inspect --output json \
  >/tmp/gateway-reconnect.json 2>/tmp/gateway-reconnect.err &
export RECONNECT_PID=$!
```

After the original Test 12 validations pass, verify the completed reconnect run
from another process:

```bash
export SQLITE_RECONNECT_RUN_ID="$(jq -er '.result.runId' /tmp/gateway-reconnect.json)"

"${AA[@]}" inspect --run-id "$SQLITE_RECONNECT_RUN_ID" \
  --cwd "$ROOT" --agent /tmp/adaptive-gateway-agent.json \
  --settings "$PHASE3_SQLITE_PROXY_SETTINGS" \
  --runtime sqlite --inference-mode gateway --output json \
  >/tmp/gateway-sqlite-reconnect-inspect.json

jq -e --arg run_id "$SQLITE_RECONNECT_RUN_ID" '
  .inspection.run.id == $run_id
  and .inspection.run.status == "succeeded"
  and .inspection.eventTypes["model.completed"] >= 1
' /tmp/gateway-sqlite-reconnect-inspect.json
```

SQLite repeat pass criteria:

- Tests 1-12 retain all original Phase 3 pass criteria.
- Every command resolves runtime mode `sqlite` and the same database path.
- A new CLI process can inspect and replay the Test 2 run.
- The Toxiproxy reconnect still produces one logical gateway call and one
  billing row.
- The completed reconnect run remains inspectable after the originating CLI
  exits.
- No prompt, output, tool result, API key, or access token is persisted in
  gateway billing or gateway logs.

The SQLite database is local runtime state and may contain prompts, tool
inputs/results, and model output. Protect it as sensitive data and remove it
during cleanup.

## Cleanup

```bash
rm -f /tmp/adaptive-gateway*.json /tmp/gateway-*.json \
  /tmp/gateway-*.err /tmp/adaptive-gateway-manual.env tmp/gateway-proof.txt
test -z "${PHASE3_SQLITE_PATH:-}" || rm -f \
  "$PHASE3_SQLITE_PATH" "$PHASE3_SQLITE_PATH-wal" "$PHASE3_SQLITE_PATH-shm"
test -z "${TOXIPROXY_PID:-}" || kill "$TOXIPROXY_PID"
docker stop "$PHASE3_DB_CONTAINER"
```

Stopping the container preserves test data. Remove it only when no longer
needed.
