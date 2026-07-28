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

## Cleanup

```bash
rm -f /tmp/adaptive-gateway*.json /tmp/gateway-*.json \
  /tmp/gateway-*.err /tmp/adaptive-gateway-manual.env tmp/gateway-proof.txt
test -z "${TOXIPROXY_PID:-}" || kill "$TOXIPROXY_PID"
docker stop "$PHASE3_DB_CONTAINER"
```

Stopping the container preserves test data. Remove it only when no longer
needed.
