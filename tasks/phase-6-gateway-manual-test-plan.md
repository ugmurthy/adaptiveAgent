# Phase 6 Gateway Profile Manual Test Plan

## Scope

Validate declarative server profile distribution from the capability gateway
through the Gateway Client and Agent SDK. This plan specifically covers Phase
6 of `tasks/prd-gateway-plan.md`; it is unrelated to the older service artifact
phase documented in `PHASE-6-MANUAL-TEST-PLAN.md`.

Run commands from the repository root:

```bash
cd /Users/ugmurthy/riding-amp/AgentSmith
export ROOT="$PWD"
export PHASE6_DIR=/tmp/adaptive-agent-phase6-profiles
rm -rf "$PHASE6_DIR"
mkdir -p "$PHASE6_DIR/cache"
```

## 1. Automated Baseline

```bash
bun run --cwd packages/gateway-protocol test
bun run --cwd packages/gateway-client typecheck
bun run --cwd packages/gateway-client test
bun run --cwd packages/capability-gateway typecheck
bun run --cwd packages/capability-gateway test
bunx vitest run --root packages/agent-sdk \
  src/server-profiles.test.ts src/index.test.ts src/gateway-tools.test.ts
```

Expected:

- Gateway Protocol: 47 tests pass.
- Gateway Client: 15 tests pass.
- Capability gateway: 32 tests pass.
- Focused Agent SDK suites: 21 tests pass and one unrelated test is skipped.

## 2. Create a Declarative Profile and Manifest

Create a profile with a nested declarative delegate. Leave `contentHash` empty
until the canonical hash is calculated:

```bash
cat >"$PHASE6_DIR/profile.json" <<'JSON'
{
  "ref": {
    "source": "server",
    "id": "manual-researcher",
    "version": "1.0.0",
    "contentHash": ""
  },
  "schemaVersion": "1",
  "name": "Manual Researcher",
  "instructions": "Answer concisely. Use read_file when the user asks you to inspect a local file.",
  "tools": ["read_file"],
  "allowedTools": ["read_file"],
  "capabilities": ["model/generate"],
  "delegates": [
    {
      "id": "manual-reviewer",
      "instructions": "Review the supplied result for factual consistency.",
      "tools": ["read_file"],
      "delegates": [
        {
          "id": "manual-proofreader",
          "instructions": "Check the final wording."
        }
      ]
    }
  ]
}
JSON
```

Calculate the same canonical SHA-256 used by the server and write it into the
profile:

```bash
PROFILE_PATH="$PHASE6_DIR/profile.json" bun -e '
  import { createHash } from "node:crypto";
  const path = process.env.PROFILE_PATH!;
  const profile = await Bun.file(path).json();
  const canonical = (value: unknown): string => Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
          .join(",")}}`
      : JSON.stringify(value);
  profile.ref.contentHash = "";
  profile.ref.contentHash = createHash("sha256")
    .update(canonical(profile))
    .digest("hex");
  await Bun.write(path, `${JSON.stringify(profile, null, 2)}\n`);
  console.log(profile.ref.contentHash);
' | tee "$PHASE6_DIR/content-hash.txt"

export PROFILE_HASH="$(cat "$PHASE6_DIR/content-hash.txt")"

cat >"$PHASE6_DIR/manifest.json" <<JSON
{
  "schemaVersion": 1,
  "profiles": [
    {
      "id": "manual-researcher",
      "version": "1.0.0",
      "contentHash": "$PROFILE_HASH",
      "configPath": "profile.json",
      "allowedTiers": ["medium", "high"],
      "remoteCapabilities": ["model/generate"]
    }
  ]
}
JSON
```

Validate the manifest directly before starting the gateway:

```bash
MANIFEST_PATH="$PHASE6_DIR/manifest.json" bun -e '
  import { ProfileRegistry, RemoteToolRegistry } from "./packages/capability-gateway/src/index.ts";
  const registry = await ProfileRegistry.load(
    process.env.MANIFEST_PATH!,
    new RemoteToolRegistry(),
  );
  console.log(registry.schemaVersions());
' 
```

Pass: output is `[ "1" ]` or equivalent.

## 3. Start PostgreSQL and Configure the Gateway

The gateway uses PostgreSQL for billing even though profile lookup itself is
filesystem-backed:

```bash
export PHASE6_DB_CONTAINER="adaptive-agent-phase6-pg-$(date +%s)"
export PHASE6_DB_PASSWORD="$(openssl rand -hex 24)"
export PHASE6_DB_PORT=55436

docker run --name "$PHASE6_DB_CONTAINER" \
  -e POSTGRES_USER=adaptive \
  -e POSTGRES_PASSWORD="$PHASE6_DB_PASSWORD" \
  -e POSTGRES_DB=adaptive_agent \
  -p "${PHASE6_DB_PORT}:5432" \
  -d postgres:17

until docker exec "$PHASE6_DB_CONTAINER" pg_isready -U adaptive -d adaptive_agent; do
  sleep 1
done

export DATABASE_URL="postgres://adaptive:${PHASE6_DB_PASSWORD}@127.0.0.1:${PHASE6_DB_PORT}/adaptive_agent"
export GATEWAY_JWT_HMAC_SECRET="$(openssl rand -hex 32)"
export GATEWAY_JWT_ISSUER='adaptive-agent-phase6-manual'
export GATEWAY_JWT_AUDIENCE='adaptive-agent-gateway'
export GATEWAY_PROFILE_MANIFEST_PATH="$PHASE6_DIR/manifest.json"
export GATEWAY_ROUTE_POLICY_PATH="$PHASE6_DIR/route-policy.json"
export GATEWAY_HOST=127.0.0.1
export GATEWAY_PORT=3006
```

Save the shared values in a protected file so Terminal A and Terminal B use
the exact same database and JWT configuration:

```bash
umask 077
{
  printf 'export PHASE6_DIR=%q\n' "$PHASE6_DIR"
  printf 'export PHASE6_DB_CONTAINER=%q\n' "$PHASE6_DB_CONTAINER"
  printf 'export DATABASE_URL=%q\n' "$DATABASE_URL"
  printf 'export GATEWAY_JWT_HMAC_SECRET=%q\n' "$GATEWAY_JWT_HMAC_SECRET"
  printf 'export GATEWAY_JWT_ISSUER=%q\n' "$GATEWAY_JWT_ISSUER"
  printf 'export GATEWAY_JWT_AUDIENCE=%q\n' "$GATEWAY_JWT_AUDIENCE"
  printf 'export GATEWAY_PROFILE_MANIFEST_PATH=%q\n' "$GATEWAY_PROFILE_MANIFEST_PATH"
  printf 'export GATEWAY_ROUTE_POLICY_PATH=%q\n' "$GATEWAY_ROUTE_POLICY_PATH"
  printf 'export GATEWAY_HOST=%q\n' "$GATEWAY_HOST"
  printf 'export GATEWAY_PORT=%q\n' "$GATEWAY_PORT"
} >"$PHASE6_DIR/gateway.env"
```

Use one installed Ollama model for all tiers:

```bash
export MANUAL_MODEL='qwen3.5' # Replace if necessary.
ollama list

jq --arg model "$MANUAL_MODEL" '
  .version = "phase6-manual-v1"
  | .tiers |= with_entries(.value.targets = [{
      provider: "ollama",
      model: $model,
      baseUrl: "http://127.0.0.1:11434/v1",
      maxConcurrency: 4
    }])
' packages/capability-gateway/config/route-policy.example.json \
  >"$GATEWAY_ROUTE_POLICY_PATH"
```

Start the gateway in Terminal A:

```bash
source /tmp/adaptive-agent-phase6-profiles/gateway.env
bun run --cwd packages/capability-gateway start \
  2>&1 | tee "$PHASE6_DIR/gateway.log"
```

Pass: `capability_gateway.server.started` reports `ready`. Profile contents,
the manifest path, access tokens, and local filesystem paths must not appear in
the log.

## 4. Mint Authorized and Unauthorized Tokens

In Terminal B, source the protected environment file before minting tokens:

```bash
cd /Users/ugmurthy/riding-amp/AgentSmith
source /tmp/adaptive-agent-phase6-profiles/gateway.env
```

Then define:

```bash
mint_profile_token() {
  ALLOWED_TIERS="$1" bun -e '
    import { SignJWT } from "jose";
    console.log(await new SignJWT({
      account_id: "phase6-account",
      tenant_id: "phase6-tenant",
      allowed_tiers: JSON.parse(process.env.ALLOWED_TIERS!),
      permitted_modes: ["gateway"]
    })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("phase6-user")
      .setIssuer(process.env.GATEWAY_JWT_ISSUER)
      .setAudience(process.env.GATEWAY_JWT_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("2h")
      .sign(new TextEncoder().encode(process.env.GATEWAY_JWT_HMAC_SECRET)));
  '
}

export PHASE6_AUTHORIZED_TOKEN="$(mint_profile_token '["medium","high"]')"
export PHASE6_UNAUTHORIZED_TOKEN="$(mint_profile_token '["low"]')"
```

Do not print either token.

Before Step 5, confirm that the gateway is listening:

```bash
lsof -nP -iTCP:3006 -sTCP:LISTEN
curl -i http://127.0.0.1:3006/rpc
```

Pass: `lsof` shows a Bun listener. The plain HTTP request reaches the gateway
and returns an HTTP response such as `401` because it is not an authenticated
WebSocket upgrade. `Connection refused` means Terminal A is not running; check
`$PHASE6_DIR/gateway.log` before continuing.

## 5. Test Authorized List, Get, and Run Authorization

```bash
PHASE6_TOKEN="$PHASE6_AUTHORIZED_TOKEN" PHASE6_DIR="$PHASE6_DIR" bun -e '
  import { GatewayClient } from "./packages/gateway-client/src/index.ts";
  const client = new GatewayClient({
    url: "ws://127.0.0.1:3006/rpc",
    accessToken: () => process.env.PHASE6_TOKEN!,
    clientName: "phase6-manual",
    clientVersion: "1.0.0"
  });
  try {
    const profiles = await client.listProfiles("1");
    if (profiles.length !== 1) throw new Error(`expected one profile, got ${profiles.length}`);
    const summary = profiles[0]!;
    const bundle = await client.getProfile(summary.ref);
    const permit = await client.authorizeRun({
      runId: crypto.randomUUID(),
      inferenceMode: "gateway",
      requestedTier: "medium",
      profileRefs: [summary.ref]
    });
    await Bun.write(`${process.env.PHASE6_DIR}/profile-ref.json`, JSON.stringify(summary.ref));
    await Bun.write(`${process.env.PHASE6_DIR}/authorized-response.json`, JSON.stringify({ summary, bundle, permit }, null, 2));
    console.log({ summary, bundle, permit });
  } finally {
    client.close();
  }
'
```

Pass:

- One `manual-researcher` summary is returned.
- The exact version and hash match the manifest.
- Both nested delegates are present and contain no executable fields.
- The permit tier is `medium`.
- The response contains no `configPath`, manifest path, token, credential, or
  other server path.

Check common leaks explicitly:

```bash
! rg -n 'configPath|manifest|/tmp/|handler|script|credential|token|password' \
  "$PHASE6_DIR/authorized-response.json"
```

## 6. Test Profile Non-Enumerability

```bash
PHASE6_TOKEN="$PHASE6_UNAUTHORIZED_TOKEN" PROFILE_REF="$PHASE6_DIR/profile-ref.json" bun -e '
  import { GatewayClient, GatewayResponseError } from "./packages/gateway-client/src/index.ts";
  const client = new GatewayClient({
    url: "ws://127.0.0.1:3006/rpc",
    accessToken: () => process.env.PHASE6_TOKEN!,
    clientName: "phase6-unauthorized",
    clientVersion: "1.0.0"
  });
  try {
    const profiles = await client.listProfiles("1");
    if (profiles.length !== 0) throw new Error("unauthorized profile was enumerable");
    const ref = await Bun.file(process.env.PROFILE_REF!).json();
    try {
      await client.getProfile(ref);
      throw new Error("unauthorized profile/get unexpectedly succeeded");
    } catch (error) {
      if (!(error instanceof GatewayResponseError) || error.gatewayCode !== "capability_not_entitled") throw error;
      console.log("PASS: profile is non-enumerable");
    }
  } finally {
    client.close();
  }
'
```

Pass: the list is empty and exact `profile/get` returns only
`capability_not_entitled`, without revealing whether the ID or version exists.

## 7. Test Agent SDK Selection and Protected Pin Persistence

This step invokes the configured model. Ensure Ollama and `$MANUAL_MODEL` are
running.

```bash
PHASE6_TOKEN="$PHASE6_AUTHORIZED_TOKEN" PHASE6_DIR="$PHASE6_DIR" bun -e '
  import { GatewayClient } from "./packages/gateway-client/src/index.ts";
  import { createAgentSdk } from "./packages/agent-sdk/src/index.ts";
  const client = new GatewayClient({
    url: "ws://127.0.0.1:3006/rpc",
    accessToken: () => process.env.PHASE6_TOKEN!,
    clientName: "phase6-sdk-manual",
    clientVersion: "1.0.0",
    requestTimeoutMs: 180000
  });
  const sdk = await createAgentSdk({
    agentConfigPath: "server:manual-researcher",
    gatewayClient: client,
    profileCachePath: `${process.env.PHASE6_DIR}/cache`,
    runtimeMode: "memory",
    inferenceTier: "medium",
    env: {}
  });
  try {
    const result = await sdk.runRaw("Reply with exactly PHASE6_PROFILE_OK.");
    const inspection = await sdk.inspect(result.runId);
    console.log(JSON.stringify({ result, executionContext: inspection.run?.executionContext }, null, 2));
    if (inspection.run?.executionContext?.profileRefs?.[0]?.id !== "manual-researcher") {
      throw new Error("exact profile pin was not persisted");
    }
  } finally {
    await sdk.close();
  }
'
```

Pass: the run succeeds and `executionContext.profileRefs[0]` contains source
`server`, ID `manual-researcher`, version `1.0.0`, and the exact manifest hash.
No bundle body, handler, server path, or token is persisted in execution
context.

## 8. Test Exact Offline Cache Resolution

Test the resolver without stopping the gateway first:

```bash
PHASE6_DIR="$PHASE6_DIR" bun -e '
  import { resolveServerProfile } from "./packages/agent-sdk/src/server-profiles.ts";
  const ref = await Bun.file(`${process.env.PHASE6_DIR}/profile-ref.json`).json();
  const resolved = await resolveServerProfile(ref, {
    cachePath: `${process.env.PHASE6_DIR}/cache`
  });
  console.log(resolved.ref, resolved.bundle.name);
'
```

Then stop the gateway in Terminal A with `Ctrl-C` and run the same command
again.

Pass: both invocations resolve version `1.0.0` from cache without attempting a
network connection.

Confirm that a different exact version is not silently substituted:

```bash
PHASE6_DIR="$PHASE6_DIR" bun -e '
  import { resolveServerProfile } from "./packages/agent-sdk/src/server-profiles.ts";
  const original = await Bun.file(`${process.env.PHASE6_DIR}/profile-ref.json`).json();
  const missing = { ...original, version: "9.9.9", contentHash: "0".repeat(64) };
  try {
    await resolveServerProfile(missing, { cachePath: `${process.env.PHASE6_DIR}/cache` });
    throw new Error("missing exact version unexpectedly resolved");
  } catch (error) {
    if (!String(error).includes("not cached")) throw error;
    console.log("PASS: exact missing version was not substituted");
  }
'
```

## 9. Test Hash and Executable-Field Rejection

Create a hash-mismatched copy and verify loading fails:

```bash
cp "$PHASE6_DIR/profile.json" "$PHASE6_DIR/profile.safe.json"
jq '.instructions = "tampered after hashing"' \
  "$PHASE6_DIR/profile.safe.json" >"$PHASE6_DIR/profile.json"

MANIFEST_PATH="$PHASE6_DIR/manifest.json" bun -e '
  import { ProfileRegistry, RemoteToolRegistry } from "./packages/capability-gateway/src/index.ts";
  try {
    await ProfileRegistry.load(process.env.MANIFEST_PATH!, new RemoteToolRegistry());
    throw new Error("tampered profile unexpectedly loaded");
  } catch (error) {
    if (!String(error).includes("content hash mismatch")) throw error;
    console.log("PASS: hash mismatch rejected");
  }
'
```

Create a transitive downloaded handler and verify the whole bundle is rejected:

```bash
jq '.delegates[0].delegates[0].handler = "./downloaded-handler.ts"' \
  "$PHASE6_DIR/profile.safe.json" >"$PHASE6_DIR/profile.json"

MANIFEST_PATH="$PHASE6_DIR/manifest.json" bun -e '
  import { ProfileRegistry, RemoteToolRegistry } from "./packages/capability-gateway/src/index.ts";
  try {
    await ProfileRegistry.load(process.env.MANIFEST_PATH!, new RemoteToolRegistry());
    throw new Error("profile with downloaded handler unexpectedly loaded");
  } catch (error) {
    if (!/handler|prohibited|forbidden/i.test(String(error))) throw error;
    console.log("PASS: transitive handler rejected");
  }
'

mv "$PHASE6_DIR/profile.safe.json" "$PHASE6_DIR/profile.json"
```

## 10. Test Explicit Namespace Ambiguity

```bash
bun -e '
  import { resolveProfileNamespace } from "./packages/agent-sdk/src/server-profiles.ts";
  try {
    await resolveProfileNamespace("manual-researcher", true, true);
    throw new Error("ambiguous unqualified profile unexpectedly resolved");
  } catch (error) {
    if (!String(error).includes("Ambiguous profile")) throw error;
  }
  if (await resolveProfileNamespace("local:manual-researcher", true, true) !== "local") throw new Error("local namespace failed");
  if (await resolveProfileNamespace("server:manual-researcher", true, true) !== "server") throw new Error("server namespace failed");
  console.log("PASS: explicit namespaces resolve ambiguity");
'
```

## 11. Cleanup

If the gateway is still running, stop it with `Ctrl-C`, then run:

```bash
docker rm -f "$PHASE6_DB_CONTAINER"
rm -rf "$PHASE6_DIR"
unset PHASE6_AUTHORIZED_TOKEN PHASE6_UNAUTHORIZED_TOKEN
unset GATEWAY_JWT_HMAC_SECRET DATABASE_URL
```

## Completion Checklist

- [ ] Automated baseline passes.
- [ ] Valid manifest loads and advertises schema version `1`.
- [ ] Authorized clients can list/get the exact immutable bundle.
- [ ] Profile tier and capability restrictions apply to run authorization.
- [ ] Unauthorized clients cannot enumerate or probe the profile.
- [ ] Responses and logs contain no server paths, secrets, or executable data.
- [ ] `server:<id>` creates an Agent SDK run with an exact protected pin.
- [ ] Exact cached pins resolve with the gateway offline.
- [ ] A missing/newer version is never silently substituted.
- [ ] Hash mismatches reject distribution.
- [ ] A handler in a transitive delegate rejects the entire bundle.
- [ ] Ambiguous profile IDs require an explicit source namespace.
