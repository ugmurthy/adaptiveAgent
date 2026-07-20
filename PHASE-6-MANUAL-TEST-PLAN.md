# Phase 6 Local Manual Test Plan

## Purpose

Validate private artifact management end to end:

```text
Worker workspace -> validate/hash/quota -> private MinIO object
                                      -> PostgreSQL metadata
                                      -> authorized list/download
                                      -> public artifact events
                                      -> retention reconciliation
```

The test covers happy-path ingestion, quarantine, exact-owner authorization, audited downloads, private storage, workspace cleanup, path and link rejection, quotas, event projection, expiry, abandoned uploads, orphan objects, version deletion, and API restart resilience.

## 1. Prerequisites and Automated Baseline

Required locally:

- Bun dependencies installed.
- Docker running.
- `curl`, `jq`, and `shasum`.
- An OpenRouter credential or a working local Ollama model.

Run from the repository root:

```bash
bunx vitest run --root packages/service
bun run --cwd packages/service-sdk typecheck
bunx vitest run --root packages/service-sdk
bun run --cwd packages/service build
```

Expected: service and Service SDK tests pass, Service SDK typecheck passes, and the service build succeeds.

## 2. Start PostgreSQL, Redis, and MinIO

Read local-only credentials into the shell instead of recording them in this file:

```bash
read -rsp 'Local PostgreSQL credential: ' LOCAL_DB_SECRET; echo
read -rsp 'Local MinIO credential: ' LOCAL_MINIO_SECRET; echo
read -rsp 'Local JWT signing credential (32+ bytes): ' LOCAL_JWT_SECRET; echo
export LOCAL_DB_SECRET LOCAL_MINIO_SECRET LOCAL_JWT_SECRET
```

Start PostgreSQL:

```bash
docker run --name adaptive-agent-postgres \
  -e POSTGRES_USER=adaptive \
  -e POSTGRES_PASSWORD="$LOCAL_DB_SECRET" \
  -e POSTGRES_DB=adaptive_agent \
  -p 5432:5432 \
  -d postgres:17
```

Start Redis:

```bash
docker run --name adaptive-agent-redis \
  -p 6379:6379 \
  -d redis:7-alpine
```

Start MinIO:

```bash
docker run --name adaptive-agent-minio \
  -p 9000:9000 \
  -p 9001:9001 \
  -e MINIO_ROOT_USER=minioadmin \
  -e MINIO_ROOT_PASSWORD="$LOCAL_MINIO_SECRET" \
  -d minio/minio server /data --console-address ':9001'
```

Create a private bucket:

```bash
docker run --rm \
  --network container:adaptive-agent-minio \
  -e MC_USER=minioadmin \
  -e MC_SECRET="$LOCAL_MINIO_SECRET" \
  --entrypoint sh \
  minio/mc -c '
    mc alias set local http://127.0.0.1:9000 "$MC_USER" "$MC_SECRET"
    mc mb --ignore-existing local/adaptive-agent-artifacts
    mc anonymous set none local/adaptive-agent-artifacts
  '
```

Verify dependencies:

```bash
docker exec adaptive-agent-postgres pg_isready -U adaptive
docker exec adaptive-agent-redis redis-cli ping
curl -I http://127.0.0.1:9000/minio/health/live
```

Expected: PostgreSQL accepts connections, Redis returns `PONG`, and MinIO returns HTTP `200`. The MinIO console is at `http://127.0.0.1:9001`.

## 3. Create an Artifact-Producing Agent

```bash
mkdir -p tmp/phase6 var/jobs

cat > tmp/phase6/artifact-agent.json <<'JSON'
{
  "id": "artifact-agent",
  "name": "Artifact Test Agent",
  "invocationModes": ["run"],
  "defaultInvocationMode": "run",
  "model": {
    "provider": "openrouter",
    "model": "qwen/qwen3.5-27b",
    "apiKeyEnv": "OPENROUTER_API_KEY"
  },
  "systemInstructions": "Follow the user instructions exactly. Generated downloadable files must be written directly into the artifacts directory under the current workspace.",
  "tools": ["read_file", "list_directory", "write_file", "shell_exec"],
  "delegates": [],
  "defaults": {
    "maxSteps": 20,
    "autoApproveAll": true
  }
}
JSON
```

To use Ollama, replace the model block with an installed model:

```json
"model": {
  "provider": "ollama",
  "model": "qwen3.5"
}
```

Create the allowlisted registry:

```bash
AGENT_HASH=$(shasum -a 256 tmp/phase6/artifact-agent.json | awk '{print $1}')

cat > tmp/phase6/registry.json <<JSON
{
  "agents": [
    {
      "id": "artifact-agent",
      "configPath": "./artifact-agent.json",
      "version": "1",
      "contentHash": "$AGENT_HASH",
      "allowedWorkloads": ["run"]
    }
  ]
}
JSON
```

## 4. Export Service Configuration

```bash
export DATABASE_URL="postgres://adaptive:${LOCAL_DB_SECRET}@127.0.0.1:5432/adaptive_agent"
export REDIS_URL='redis://127.0.0.1:6379'
export AGENT_REGISTRY_PATH="$PWD/tmp/phase6/registry.json"
export BOOTSTRAP_AGENT_ID='artifact-agent'

export JWT_ISSUER='http://adaptive-agent.local'
export JWT_AUDIENCE='adaptive-agent'
export JWT_HMAC_SECRET="$LOCAL_JWT_SECRET"

export ARTIFACT_S3_BUCKET='adaptive-agent-artifacts'
export ARTIFACT_S3_REGION='us-east-1'
export ARTIFACT_S3_ENDPOINT='http://127.0.0.1:9000'
export ARTIFACT_S3_ACCESS_KEY_ID='minioadmin'
export ARTIFACT_S3_SECRET_ACCESS_KEY="$LOCAL_MINIO_SECRET"
export ARTIFACT_S3_FORCE_PATH_STYLE='true'
export ARTIFACT_S3_SERVER_SIDE_ENCRYPTION='none'

export ARTIFACT_MAX_FILES='20'
export ARTIFACT_MAX_FILE_BYTES='52428800'
export ARTIFACT_MAX_TOTAL_BYTES='104857600'
export ARTIFACT_RETENTION_DAYS='7'
export ARTIFACT_QUARANTINE_RETENTION_DAYS='30'
export ARTIFACT_ABANDONED_UPLOAD_MS='5000'
export JOB_WORKSPACE_ROOT="$PWD/var/jobs"
export HTTP_LOG_LEVEL='info'

export RECONCILE_INTERVAL_MS='1000'
export PROJECTOR_INTERVAL_MS='250'
export DISPATCH_INTERVAL_MS='250'

# OpenRouter example only:
export OPENROUTER_API_KEY='<your-provider-key>'
```

Plain HTTP object storage is accepted only for localhost development. Production endpoints must use HTTPS.

## 5. Start the Five Service Processes

Use five terminals with the environment above exported in each.

```bash
# Terminal 1: HTTP API
bun run packages/service/src/http-main.ts

# Terminal 2: outbox dispatcher
bun run packages/service/src/dispatcher-main.ts

# Terminal 3: agent worker
bun run packages/service/src/agent-worker-main.ts

# Terminal 4: public event projector
bun run packages/service/src/projector-main.ts

# Terminal 5: stale job and artifact reconciler
bun run packages/service/src/reconciler-main.ts
```

Verify health:

```bash
curl -s http://127.0.0.1:3000/health/live | jq
curl -s http://127.0.0.1:3000/health/ready | jq
```

Expected: `{"status":"ok"}` and `{"status":"ready"}`. Migrations run automatically at startup.

## 6. Generate Test JWTs

```bash
make_token() {
  USER_ID="$1" TENANT_ID="$2" bun -e '
    import { SignJWT } from "jose";
    const key = new TextEncoder().encode(process.env.JWT_HMAC_SECRET);
    console.log(
      await new SignJWT({ tenant_id: process.env.TENANT_ID })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer(process.env.JWT_ISSUER)
        .setAudience(process.env.JWT_AUDIENCE)
        .setSubject(process.env.USER_ID)
        .setExpirationTime("2h")
        .sign(key)
    );
  '
}

export ALICE_TOKEN=$(make_token alice tenant-1)
export BOB_TOKEN=$(make_token bob tenant-1)
export OTHER_TENANT_TOKEN=$(make_token alice tenant-2)
```

Confirm an unauthenticated artifact request returns HTTP `401`:

```bash
curl -i http://127.0.0.1:3000/v1/jobs/unknown/artifacts
```

## 7. Happy-Path Ingestion and Quarantine

Submit a job that creates one safe text file and one unknown binary file:

```bash
SUBMISSION=$(curl -sS \
  -X POST http://127.0.0.1:3000/v1/jobs/run \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: phase6-happy-path-1' \
  -d '{
    "schemaVersion": 1,
    "agentId": "artifact-agent",
    "goal": "Create artifacts/result.txt containing exactly hello-phase-6 followed by a newline. Also create artifacts/sample.bin containing bytes 00 01 02. Do not create other files under artifacts."
  }')

echo "$SUBMISSION" | jq
export JOB_ID=$(echo "$SUBMISSION" | jq -r .jobId)
```

Poll until terminal:

```bash
while true; do
  JOB=$(curl -sS \
    -H "Authorization: Bearer $ALICE_TOKEN" \
    "http://127.0.0.1:3000/v1/jobs/$JOB_ID")
  echo "$JOB" | jq '{id,state,error}'
  STATE=$(echo "$JOB" | jq -r .state)
  case "$STATE" in succeeded|failed|cancelled) break ;; esac
  sleep 1
done
```

Expected: the job succeeds and neither responses nor logs expose an internal storage key.

List artifacts:

```bash
ARTIFACTS=$(curl -sS \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  "http://127.0.0.1:3000/v1/jobs/$JOB_ID/artifacts")
echo "$ARTIFACTS" | jq
```

Expected:

- `result.txt`: `text/plain`, `available`, SHA-256 hash, `availableAt`, and approximately seven-day expiry.
- `sample.bin`: `application/octet-stream`, `quarantined`, and approximately thirty-day expiry.
- No `storageKey`, bucket name, or signed URL.

Capture IDs:

```bash
export TEXT_ARTIFACT_ID=$(echo "$ARTIFACTS" | jq -r '.[] | select(.filename=="result.txt") | .id')
export BINARY_ARTIFACT_ID=$(echo "$ARTIFACTS" | jq -r '.[] | select(.filename=="sample.bin") | .id')
```

## 8. Authenticated Download

```bash
curl -sS -D tmp/phase6/download-headers.txt \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  "http://127.0.0.1:3000/v1/jobs/$JOB_ID/artifacts/$TEXT_ARTIFACT_ID/download" \
  -o tmp/phase6/downloaded-result.txt

cat tmp/phase6/download-headers.txt
cat tmp/phase6/downloaded-result.txt
shasum -a 256 tmp/phase6/downloaded-result.txt
```

Expected:

- Body is `hello-phase-6` followed by a newline.
- SHA-256 equals metadata `contentHash`.
- Headers include `Content-Type: text/plain`, attachment disposition, `Cache-Control: private, no-store`, and `X-Content-Type-Options: nosniff`.

Quarantined download must return HTTP `404`:

```bash
curl -i \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  "http://127.0.0.1:3000/v1/jobs/$JOB_ID/artifacts/$BINARY_ARTIFACT_ID/download"
```

## 9. Exact Initiator Authorization

Same tenant, different user:

```bash
curl -i -H "Authorization: Bearer $BOB_TOKEN" \
  "http://127.0.0.1:3000/v1/jobs/$JOB_ID/artifacts"
curl -i -H "Authorization: Bearer $BOB_TOKEN" \
  "http://127.0.0.1:3000/v1/jobs/$JOB_ID/artifacts/$TEXT_ARTIFACT_ID/download"
```

Same user ID, different tenant:

```bash
curl -i -H "Authorization: Bearer $OTHER_TENANT_TOKEN" \
  "http://127.0.0.1:3000/v1/jobs/$JOB_ID/artifacts"
curl -i -H "Authorization: Bearer $OTHER_TENANT_TOKEN" \
  "http://127.0.0.1:3000/v1/jobs/$JOB_ID/artifacts/$TEXT_ARTIFACT_ID/download"
```

Expected: all four requests return HTTP `404`, not `403`.

## 10. Download Auditing

```bash
docker exec adaptive-agent-postgres \
  psql -U adaptive -d adaptive_agent -c "
    select tenant_id,user_id,action,target_job_id,target_artifact_id,allowed,occurred_at
    from service_access_audit_records
    where target_job_id='$JOB_ID'
    order by occurred_at;
  "
```

Expected audit rows:

- Alice's text download: `allowed = true`.
- Alice's quarantined download: `allowed = false`.
- Bob's attempt: `allowed = false`.
- Other-tenant attempt: `allowed = false`.
- No row contains a storage key.

## 11. Private and Encrypted MinIO Storage

Use administrator-only database access to obtain the internal key:

```bash
export STORAGE_KEY=$(
  docker exec adaptive-agent-postgres \
  psql -U adaptive -d adaptive_agent -Atc \
  "select storage_key from service_artifacts where id='$TEXT_ARTIFACT_ID';"
)
```

Anonymous access must fail:

```bash
curl -i "http://127.0.0.1:9000/adaptive-agent-artifacts/$STORAGE_KEY"
```

Expected: HTTP `403`.

Inspect authenticated object metadata:

```bash
docker run --rm \
  --network container:adaptive-agent-minio \
  -e MC_USER=minioadmin \
  -e MC_SECRET="$LOCAL_MINIO_SECRET" \
  -e OBJECT_KEY="$STORAGE_KEY" \
  --entrypoint sh \
  minio/mc -c '
    mc alias set local http://127.0.0.1:9000 "$MC_USER" "$MC_SECRET"
    mc stat "local/adaptive-agent-artifacts/$OBJECT_KEY"
  '
```

Expected: object exists with `text/plain` and SHA-256 metadata. This local MinIO setup disables server-side encryption because it does not configure a KMS; production keeps `AES256` as the default.

## 12. Workspace Cleanup

```bash
find var/jobs -mindepth 1 -print
```

Expected: no completed job workspace or generated artifact remains. Repeat after successful and failed jobs.

## 13. Public Artifact Events

```bash
EVENTS=$(curl -sS \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  "http://127.0.0.1:3000/v1/jobs/$JOB_ID/events?afterSequence=0&limit=500")

echo "$EVENTS" | jq '.[] | select(.type | startswith("artifact."))'
echo "$EVENTS" | grep -Ei 'storage_key|storageKey|presigned|signedUrl|adaptive-agent-artifacts'
```

Expected:

- `artifact.available` for `result.txt`.
- `artifact.quarantined` for `sample.bin`.
- The `grep` command produces no output.

Optional WebSocket test:

1. Connect to `ws://127.0.0.1:3000/v1/ws` with Alice's bearer token.
2. Send `{"operation":"subscribe","requestId":"phase6","jobId":"<JOB_ID>","afterSequence":0}`.
3. Confirm both artifact events replay.
4. Reconnect from the last sequence and confirm no gap or duplicate.
5. Subscribe as Bob and confirm `code: "not_found"`.

## 14. Path, Link, and Nested-Directory Rejection

Submit a run whose goal is:

```text
Use shell_exec to create a symbolic link at artifacts/escape.txt pointing to /etc/hosts. Do not create any other artifact.
```

Expected:

- Job ends as `failed` with a sanitized public error.
- No `/etc/hosts` content is uploaded.
- No available artifact is listed.
- Workspace is removed.

Submit another run that creates `artifacts/nested/result.txt`.

Expected: ingestion fails because nested artifact directories are rejected.

## 15. Quota Enforcement

Restart only the worker with:

```bash
export ARTIFACT_MAX_FILES=1
export ARTIFACT_MAX_FILE_BYTES=4
export ARTIFACT_MAX_TOTAL_BYTES=4
bun run packages/service/src/agent-worker-main.ts
```

Test separately:

| Case | Artifact request | Expected |
| --- | --- | --- |
| Per-file limit | One five-byte file | Failure; no upload |
| File count | Two one-byte files | Failure; no upload |
| Total limit | Files totaling more than four bytes | Failure; no upload |
| Boundary | One four-byte file | Available artifact |

After each rejection, `find var/jobs -mindepth 1 -print` must produce no output. Restore normal quotas afterward.

## 16. Expiry and Version-Aware Deletion

Expire the available text artifact:

```bash
docker exec adaptive-agent-postgres \
  psql -U adaptive -d adaptive_agent -c "
    update service_artifacts
    set expires_at=now()-interval '1 minute'
    where id='$TEXT_ARTIFACT_ID';
  "
```

The download endpoint must return HTTP `404` immediately, before reconciliation:

```bash
curl -i -H "Authorization: Bearer $ALICE_TOKEN" \
  "http://127.0.0.1:3000/v1/jobs/$JOB_ID/artifacts/$TEXT_ARTIFACT_ID/download"
```

Wait for reconciliation and inspect metadata:

```bash
sleep 5
docker exec adaptive-agent-postgres \
  psql -U adaptive -d adaptive_agent -c \
  "select id,status,deleted_at from service_artifacts where id='$TEXT_ARTIFACT_ID';"
```

Expected: `status = deleted` and `deleted_at` is populated.

Verify no object version remains:

```bash
docker run --rm \
  --network container:adaptive-agent-minio \
  -e MC_USER=minioadmin \
  -e MC_SECRET="$LOCAL_MINIO_SECRET" \
  -e OBJECT_KEY="$STORAGE_KEY" \
  --entrypoint sh \
  minio/mc -c '
    mc alias set local http://127.0.0.1:9000 "$MC_USER" "$MC_SECRET"
    mc ls --versions "local/adaptive-agent-artifacts/$OBJECT_KEY"
  '
```

Expected: no versions.

## 17. Orphan Reconciliation

```bash
echo orphan > tmp/phase6/orphan.txt

docker run --rm \
  --network container:adaptive-agent-minio \
  -v "$PWD/tmp/phase6:/input:ro" \
  -e MC_USER=minioadmin \
  -e MC_SECRET="$LOCAL_MINIO_SECRET" \
  --entrypoint sh \
  minio/mc -c '
    mc alias set local http://127.0.0.1:9000 "$MC_USER" "$MC_SECRET"
    mc cp /input/orphan.txt local/adaptive-agent-artifacts/artifacts/orphan-test/object
  '

sleep 8
```

Then run `mc stat` for `artifacts/orphan-test/object` using the same alias setup. Expected: object not found.

## 18. Abandoned Upload Reconciliation

Simulate an abandoned upload:

```bash
docker exec adaptive-agent-postgres \
  psql -U adaptive -d adaptive_agent -c "
    update service_artifacts
    set status='uploading',updated_at=now()-interval '1 hour',available_at=null
    where id='$BINARY_ARTIFACT_ID';
  "

sleep 5

docker exec adaptive-agent-postgres \
  psql -U adaptive -d adaptive_agent -c \
  "select id,status,deleted_at from service_artifacts where id='$BINARY_ARTIFACT_ID';"
```

Expected: status becomes `deleted`, `deleted_at` is set, and the object has been removed.

## 19. API Restart Resilience

While an artifact-producing job is running:

1. Stop only the HTTP API.
2. Leave PostgreSQL, Redis, MinIO, dispatcher, worker, projector, and reconciler running.
3. Restart the HTTP API.
4. Poll the original job with Alice's token.
5. List and download its artifact after completion.

Expected: execution continues during API downtime; metadata, events, and downloads remain available after restart. Restart the projector separately and verify durable event replay still works.

## Acceptance Checklist

- [ ] Safe text and validated image artifacts become `available`.
- [ ] Unknown or unscanned content becomes `quarantined`.
- [ ] Storage keys and signed URLs never appear publicly.
- [ ] Anonymous MinIO access is denied.
- [ ] Objects are encrypted at rest.
- [ ] Only the exact initiating tenant and user can list or download.
- [ ] Quarantined and expired artifacts cannot be downloaded.
- [ ] Every allowed and denied download attempt is audited.
- [ ] Symbolic links, hard links, nested directories, and workspace escapes are rejected.
- [ ] File count, individual size, and total size quotas are enforced.
- [ ] Completed and failed worker workspaces are removed.
- [ ] Artifact events contain metadata only.
- [ ] Expired, abandoned, and orphaned objects are reconciled.
- [ ] Every version of a deleted object is removed.
- [ ] API restarts do not interrupt worker-side artifact processing.

## Cleanup

Stop service processes, then run:

```bash
docker rm -f adaptive-agent-postgres adaptive-agent-redis adaptive-agent-minio
rm -rf tmp/phase6 var/jobs
unset LOCAL_DB_SECRET LOCAL_MINIO_SECRET LOCAL_JWT_SECRET
```

Do not clean up until audit rows and MinIO object state have been inspected.
