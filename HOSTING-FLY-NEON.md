# Hosting the Gateway on Fly.io with Neon Postgres

This guide deploys only the Fastify gateway to Fly.io. The web app can stay local for now and point at the hosted gateway over `wss://`.

## What This Setup Uses

- Fly.io runs the Bun/Fastify gateway container from `Dockerfile`.
- Neon provides PostgreSQL through `DATABASE_URL`.
- `packages/gateway-fastify/src/start-fly.ts` writes runtime gateway and agent config from environment variables at container boot, so secrets are not committed.
- Fly exposes `/health` for health checks and `/ws` for gateway WebSocket traffic.

## 1. Create Neon Postgres

1. Create a Neon project.
2. Copy the direct PostgreSQL connection string. Prefer the direct connection over a pooled connection because the gateway runs schema migrations on startup.
3. Keep `sslmode=require` in the Neon URL if Neon provides it. The gateway also enables PostgreSQL SSL by default for hosted use.

## 2. Create or Configure the Fly App

Install and authenticate the Fly CLI if needed:

```sh
fly auth login
```

Choose a unique Fly app name and either edit `app` in `fly.toml` or pass it to `fly launch`:

```sh
fly launch --copy-config --name <your-fly-app-name> --region sjc --no-deploy
```

The included `fly.toml` uses `auto_stop_machines = "suspend"` and `min_machines_running = 0` to reduce idle cost while testing. The first connection after idle may have a cold start. For always-on behavior later, set `auto_stop_machines = "off"` and `min_machines_running = 1`.

## 3. Set Secrets

Generate a JWT secret and set Neon plus model credentials:

```sh
fly secrets set \
  DATABASE_URL='<neon-direct-postgres-url>' \
  GATEWAY_JWT_SECRET='<long-random-secret>' \
  MESH_API_KEY='<mesh-api-key>'
```

The default model config in `fly.toml` is:

```toml
GATEWAY_MODEL_PROVIDER = "mesh"
GATEWAY_MODEL = "qwen/qwen3.5-27b"
```

To use another provider, set both the provider/model and either `GATEWAY_MODEL_API_KEY` or the provider-specific key:

```sh
fly secrets set \
  GATEWAY_MODEL_PROVIDER=openrouter \
  GATEWAY_MODEL=openai/gpt-4o-mini \
  OPENROUTER_API_KEY='<openrouter-api-key>'
```

Supported provider-specific key names are `MESH_API_KEY`, `OPENROUTER_API_KEY`, and `MISTRAL_API_KEY`.

## 4. Deploy and Smoke Test

Deploy:

```sh
fly deploy
```

Check health:

```sh
curl https://<your-fly-app-name>.fly.dev/health
```

Expected response:

```json
{"status":"ok","websocketPath":"/ws"}
```

Watch logs if startup fails:

```sh
fly logs
```

Common startup failures are missing `DATABASE_URL`, missing `GATEWAY_JWT_SECRET`, or a missing model API key.

## 5. Test with the Local Web App

Start the local web app with the hosted socket URL and the same JWT secret you set on Fly:

```sh
GATEWAY_WEB_SOCKET_URL='wss://<your-fly-app-name>.fly.dev/ws' \
GATEWAY_JWT_SECRET='<same-long-random-secret>' \
bun run gateway:client:web
```

The local Vite middleware will:

- return the hosted `wss://` URL from `/api/gateway-defaults`;
- mint local dev JWTs using `GATEWAY_JWT_SECRET`;
- proxy `/api/runs` and `/api/images` to the hosted Fly gateway over HTTPS.

Alternatively, write the hosted defaults to `~/.adaptiveAgent/config/gateway.json`:

```json
{
  "server": {
    "publicSocketUrl": "wss://<your-fly-app-name>.fly.dev/ws"
  },
  "auth": {
    "provider": "jwt",
    "secret": "<same-long-random-secret>"
  }
}
```

Do not deploy the local web app's `/api/dev-token` helper publicly without replacing it with real auth. It is intended only for local testing against your hosted gateway.

## Useful Runtime Environment Variables

- `DATABASE_URL`: Neon direct PostgreSQL URL. Required.
- `GATEWAY_JWT_SECRET`: JWT signing secret used by gateway auth. Required.
- `GATEWAY_MODEL_PROVIDER`: `mesh`, `openrouter`, `mistral`, or `ollama`. Defaults to `mesh`.
- `GATEWAY_MODEL`: model name. Defaults based on provider.
- `GATEWAY_MODEL_API_KEY`: generic model API key override.
- `MESH_API_KEY`, `OPENROUTER_API_KEY`, `MISTRAL_API_KEY`: provider-specific API keys.
- `GATEWAY_TOOLS`: comma-separated built-in tool names to expose to the default hosted agent.
- `GATEWAY_RUNTIME_DIR`: runtime config/workspace directory. Defaults to `.runtime/gateway` inside the container.
- `GATEWAY_POSTGRES_SSL`: defaults to `true` for Neon.
- `GATEWAY_REQUEST_LOGGING`: `debug`, `info`, `warn`, `silent`, `true`, or `false`. Defaults to `info`.
