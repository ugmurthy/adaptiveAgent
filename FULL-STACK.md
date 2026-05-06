# Full Stack Local Docker Proposal

This proposal packages the AdaptiveAgent gateway, browser web app, TUI client, and PostgreSQL database for local use on another machine with the least possible setup. The target user should only need Docker, a model API key, and one command to start the full stack.

## Recommendation

Ship a versioned Docker image plus a small Docker Compose file.

- The image contains the Bun monorepo, the built web app, the Fastify gateway, and TUI/client entrypoints.
- Compose starts a local PostgreSQL container and the app container with a durable volume.
- The browser UI is served from the gateway origin, so users open one URL: `http://localhost:8080`.
- The TUI is launched on demand with `docker compose run --rm tui` instead of running permanently in the background.
- The published artifact is hosted in GitHub Container Registry (`ghcr.io`) and attached install files are hosted in GitHub Releases.

This is the best balance between easy installation and reliable data handling. Putting Postgres inside the same long-running container is possible, but it makes database upgrades, backups, and restarts harder. Compose still feels like one local product to the user while keeping Postgres isolated and durable.

## Target Local Experience

End user flow:

```sh
mkdir agentsmith-local
cd agentsmith-local
curl -fsSLO https://github.com/ugmurthy/multi-agent/releases/latest/download/docker-compose.yml
curl -fsSLO https://github.com/ugmurthy/multi-agent/releases/latest/download/.env.example
cp .env.example .env
# Edit .env and set MESH_API_KEY or another model provider key.
docker compose up -d
```

Then:

- Web app: `http://localhost:8080`
- Gateway health: `http://localhost:8080/health`
- Gateway WebSocket: `ws://localhost:8080/ws`
- TUI: `docker compose run --rm tui`
- Logs: `docker compose logs -f app`
- Stop: `docker compose down`
- Upgrade: `docker compose pull && docker compose up -d`

## Runtime Architecture

```text
+--------------------------- user machine ----------------------------+
|                                                                     |
|  Browser                                                            |
|    | http://localhost:8080                                          |
|    v                                                                |
|  app container                                                      |
|    - serves gateway-web/dist at /                                   |
|    - exposes Fastify gateway APIs                                   |
|    - exposes /ws for chat/run sessions                              |
|    - exposes local-only token/default endpoints                     |
|    - contains TUI binaries for one-off interactive use              |
|    |                                                                |
|    | DATABASE_URL=postgres://agentsmith:...@postgres:5432/agentsmith |
|    v                                                                |
|  postgres container                                                 |
|    - durable gateway and runtime tables                             |
|    - volume: agentsmith-postgres-data                               |
|                                                                     |
+---------------------------------------------------------------------+
```

## Current Repo Fit

The current repository already has most pieces:

- Root scripts start the gateway, web dev server, TUI, status checks, and JWT minting.
- `packages/gateway-fastify/src/start-fly.ts` already creates runtime config from environment variables and uses PostgreSQL.
- `packages/gateway-fastify` already exposes `/health`, `/ws`, `/api/runs`, and `/api/images`.
- `packages/gateway-web` builds a Vite/React web app.
- The TUI already runs through `bun run gateway:client:tui`.
- The current `Dockerfile` packages the gateway for Fly-style hosting.

The main gap is production local web serving. Today, `packages/gateway-web/vite.config.ts` provides local dev-only endpoints:

- `/api/gateway-defaults`
- `/api/dev-token`
- proxying `/api/runs` and `/api/images`

For a Docker packaged app, those routes should move into the gateway or a small production web server. The cleanest approach is to serve the built web app from Fastify and add local-only versions of `/api/gateway-defaults` and `/api/dev-token` behind an explicit environment flag.

## Required Product Changes

### 1. Add Production Web Serving

Add a gateway option such as `GATEWAY_WEB_DIST_DIR=/app/packages/gateway-web/dist`. When set, the gateway should:

- serve static files from that directory at `/`;
- return `index.html` for unknown non-API routes so the React app can use client-side routing;
- keep `/ws`, `/health`, `/api/runs`, and `/api/images` handled by the existing gateway routes;
- serve static assets with long cache headers and `index.html` with no-cache headers.

Implementation choices:

- Preferred: add `@fastify/static` to `packages/gateway-fastify` and register static routes in `server.ts`.
- Alternative: run Caddy or Nginx in the container to serve static files and reverse proxy gateway routes. This adds another process and config file, so it is less attractive for this repo.

### 2. Add Local Web Auth Endpoints

Move the Vite dev behavior into gateway routes enabled only for local packaging:

```sh
GATEWAY_ENABLE_LOCAL_WEB_AUTH=true
GATEWAY_PUBLIC_SOCKET_URL=ws://localhost:8080/ws
```

Routes:

- `GET /api/gateway-defaults` returns the socket URL, default channel, subject, tenant, and roles for the browser UI.
- `POST /api/dev-token` mints a short-lived JWT from `GATEWAY_JWT_SECRET`.

Security rule: these routes are for local installs only. They should not be enabled on Fly or any public deployment.

### 3. Use PostgreSQL By Default

The local container should use the existing hosted-style gateway startup, but pointed at local Postgres:

```sh
DATABASE_URL=postgres://agentsmith:${POSTGRES_PASSWORD}@postgres:5432/agentsmith
GATEWAY_POSTGRES_SSL=false
PORT=8080
HOST=0.0.0.0
```

This preserves restart-safe gateway state, run replay, dashboard traces, transcripts, and core runtime durability.

### 4. Add Container Modes

The same image should support multiple commands:

- `server`: start the gateway and serve the web app.
- `tui`: start the interactive TUI client against the local gateway.
- `ws-client`: start the simple WebSocket client.
- `status`: run the gateway status check.
- `mint-jwt`: mint a local JWT for scripts.

This avoids publishing separate images for the gateway, UI, and TUI.

## Proposed Files

Add these files:

```text
Dockerfile.fullstack
docker/entrypoint.sh
docker/docker-compose.yml
docker/.env.example
docker/install.sh
.github/workflows/fullstack-image.yml
```

Optionally add:

```text
packages/gateway-fastify/src/local-web-routes.ts
packages/gateway-fastify/src/static-web.ts
```

## Dockerfile.fullstack

Use a multi-stage build. The builder installs dependencies and builds the web app. The runtime image contains only the repo, installed dependencies, and built assets.

```dockerfile
FROM oven/bun:1.3.5 AS builder

WORKDIR /app

COPY package.json bun.lock ./
COPY packages/core/package.json packages/core/package.json
COPY packages/gateway-fastify/package.json packages/gateway-fastify/package.json
COPY packages/gateway-web/package.json packages/gateway-web/package.json
COPY packages/analysis/package.json packages/analysis/package.json

RUN bun install --frozen-lockfile

COPY . .
RUN bun run gateway:client:web:build

FROM oven/bun:1.3.5 AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080
ENV GATEWAY_RUNTIME_DIR=/data/runtime
ENV GATEWAY_LOG_DIR=/data/logs
ENV GATEWAY_WORKSPACE_ROOT=/data/workspace
ENV GATEWAY_WEB_DIST_DIR=/app/packages/gateway-web/dist
ENV GATEWAY_ENABLE_LOCAL_WEB_AUTH=true
ENV GATEWAY_POSTGRES_SSL=false

COPY --from=builder /app /app
COPY docker/entrypoint.sh /usr/local/bin/agentsmith
RUN chmod +x /usr/local/bin/agentsmith

EXPOSE 8080

ENTRYPOINT ["agentsmith"]
CMD ["server"]
```

This image expects Postgres to be provided by Compose. If an all-in-one single-container image is still required, add `postgresql`, `tini`, and a process supervisor to the runtime image, but keep that as a separate `Dockerfile.all-in-one` because it has different operational tradeoffs.

## Entrypoint

`docker/entrypoint.sh` should route commands to existing Bun scripts.

```sh
#!/usr/bin/env sh
set -eu

mode="${1:-server}"
shift || true

case "$mode" in
  server)
    exec bun run ./packages/gateway-fastify/src/start-fly.ts "$@"
    ;;
  tui)
    exec bun run ./packages/gateway-fastify/src/local-ws-client-tui.ts "$@"
    ;;
  ws-client)
    exec bun run ./packages/gateway-fastify/src/local-ws-client.ts "$@"
    ;;
  status)
    exec bun run ./packages/gateway-fastify/src/check-status.ts "$@"
    ;;
  mint-jwt)
    exec bun run ./packages/gateway-fastify/src/mint-local-jwt.ts "$@"
    ;;
  *)
    exec "$mode" "$@"
    ;;
esac
```

## Compose File

Release this as `docker-compose.yml`.

```yaml
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: agentsmith
      POSTGRES_USER: agentsmith
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U agentsmith -d agentsmith"]
      interval: 5s
      timeout: 5s
      retries: 20

  app:
    image: ghcr.io/ugmurthy/agentsmith-fullstack:${AGENTSMITH_VERSION:-latest}
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    ports:
      - "127.0.0.1:${AGENTSMITH_PORT:-8080}:8080"
    environment:
      DATABASE_URL: postgres://agentsmith:${POSTGRES_PASSWORD}@postgres:5432/agentsmith
      GATEWAY_JWT_SECRET: ${GATEWAY_JWT_SECRET:?set GATEWAY_JWT_SECRET in .env}
      GATEWAY_POSTGRES_SSL: "false"
      GATEWAY_PUBLIC_SOCKET_URL: ws://localhost:${AGENTSMITH_PORT:-8080}/ws
      GATEWAY_MODEL_PROVIDER: ${GATEWAY_MODEL_PROVIDER:-mesh}
      GATEWAY_MODEL: ${GATEWAY_MODEL:-qwen/qwen3.5-27b}
      GATEWAY_MODEL_API_KEY: ${GATEWAY_MODEL_API_KEY:-}
      MESH_API_KEY: ${MESH_API_KEY:-}
      OPENROUTER_API_KEY: ${OPENROUTER_API_KEY:-}
      MISTRAL_API_KEY: ${MISTRAL_API_KEY:-}
      GATEWAY_TOOLS: ${GATEWAY_TOOLS:-read_file,list_directory,write_file,shell_exec,web_search,read_web_page}
    volumes:
      - app-data:/data

  tui:
    image: ghcr.io/ugmurthy/agentsmith-fullstack:${AGENTSMITH_VERSION:-latest}
    profiles: ["tools"]
    depends_on:
      app:
        condition: service_started
    environment:
      GATEWAY_SOCKET_URL: ws://app:8080/ws
      GATEWAY_JWT_SECRET: ${GATEWAY_JWT_SECRET:?set GATEWAY_JWT_SECRET in .env}
    command: ["tui"]
    stdin_open: true
    tty: true

volumes:
  postgres-data:
  app-data:
```

Why bind `127.0.0.1` instead of `0.0.0.0`: the packaged local auth endpoints mint JWTs and are intended only for the user's machine. Users who want LAN access should explicitly change the port binding and disable local dev-token behavior in favor of real auth.

## .env.example

Release this beside the Compose file.

```sh
# Local product version. Use latest for quick starts or a pinned version for reproducibility.
AGENTSMITH_VERSION=latest
AGENTSMITH_PORT=8080

# Generate these with:
# openssl rand -hex 32
POSTGRES_PASSWORD=change-me-generate-a-random-value
GATEWAY_JWT_SECRET=change-me-generate-a-random-value

# Model provider. mesh is the current project default.
GATEWAY_MODEL_PROVIDER=mesh
GATEWAY_MODEL=qwen/qwen3.5-27b

# Set one provider key. For mesh, set MESH_API_KEY.
MESH_API_KEY=
OPENROUTER_API_KEY=
MISTRAL_API_KEY=
GATEWAY_MODEL_API_KEY=

# Default local tools exposed to the packaged agent.
GATEWAY_TOOLS=read_file,list_directory,write_file,shell_exec,web_search,read_web_page
```

## Install Script

`docker/install.sh` can make setup nearly one command:

```sh
#!/usr/bin/env sh
set -eu

install_dir="${AGENTSMITH_INSTALL_DIR:-$HOME/agentsmith-local}"
release_base="https://github.com/ugmurthy/multi-agent/releases/latest/download"

mkdir -p "$install_dir"
cd "$install_dir"

curl -fsSLO "$release_base/docker-compose.yml"
curl -fsSLO "$release_base/.env.example"

if [ ! -f .env ]; then
  cp .env.example .env
  if command -v openssl >/dev/null 2>&1; then
    postgres_password="$(openssl rand -hex 32)"
    jwt_secret="$(openssl rand -hex 32)"
    sed -i.bak "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$postgres_password/" .env
    sed -i.bak "s/^GATEWAY_JWT_SECRET=.*/GATEWAY_JWT_SECRET=$jwt_secret/" .env
    rm -f .env.bak
  fi
fi

echo "Created $install_dir"
echo "Edit $install_dir/.env and set your model API key, then run:"
echo "  cd $install_dir && docker compose up -d"
```

Users can install with:

```sh
curl -fsSL https://github.com/ugmurthy/multi-agent/releases/latest/download/install.sh | sh
```

## Hosting and Distribution

### Recommended Registry: GitHub Container Registry

Use GHCR because this repo is on GitHub and Actions can publish images without another registry account.

Image names:

- `ghcr.io/ugmurthy/agentsmith-fullstack:latest`
- `ghcr.io/ugmurthy/agentsmith-fullstack:v0.1.0`
- `ghcr.io/ugmurthy/agentsmith-fullstack:<git-sha>`

Publish multi-architecture images for Apple Silicon and Intel/AMD machines:

- `linux/arm64`
- `linux/amd64`

### Optional Registry: Docker Hub

Docker Hub is useful for discoverability, but GHCR is simpler for this repository. If Docker Hub is used later, mirror the same tags:

- `ugmurthy/agentsmith-fullstack:latest`
- `ugmurthy/agentsmith-fullstack:v0.1.0`

### Release Assets

Each GitHub Release should include:

- `docker-compose.yml`
- `.env.example`
- `install.sh`
- `SHA256SUMS`
- short release notes with the image digest

The image should be the source of truth. The release files are just the easy install wrapper.

## GitHub Actions Workflow

Use this shape for `.github/workflows/fullstack-image.yml`.

```yaml
name: fullstack-image

on:
  push:
    branches: [main]
    tags: ["v*"]
  workflow_dispatch:

permissions:
  contents: read
  packages: write

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-qemu-action@v3
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/metadata-action@v5
        id: meta
        with:
          images: ghcr.io/ugmurthy/agentsmith-fullstack
          tags: |
            type=raw,value=latest,enable={{is_default_branch}}
            type=ref,event=tag
            type=sha
      - uses: docker/build-push-action@v6
        with:
          context: .
          file: Dockerfile.fullstack
          platforms: linux/amd64,linux/arm64
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
```

For release assets, add a second job that uploads `docker/docker-compose.yml`, `docker/.env.example`, and `docker/install.sh` when a `v*` tag is pushed.

## Local Build and Test

Developer commands:

```sh
docker build -f Dockerfile.fullstack -t ghcr.io/ugmurthy/agentsmith-fullstack:dev .
```

Create a local `.env`:

```sh
cp docker/.env.example .env
```

Start from the local image by overriding the image in Compose:

```sh
AGENTSMITH_VERSION=dev docker compose -f docker/docker-compose.yml up -d
```

Smoke tests:

```sh
curl http://localhost:8080/health
curl http://localhost:8080/api/gateway-defaults
docker compose -f docker/docker-compose.yml run --rm tui
docker compose -f docker/docker-compose.yml logs -f app
```

Expected health response:

```json
{"status":"ok","websocketPath":"/ws"}
```

## User Operations

### Start

```sh
docker compose up -d
```

### Stop Without Deleting Data

```sh
docker compose down
```

### Stop and Delete All Local Data

```sh
docker compose down -v
```

### Upgrade

```sh
docker compose pull
docker compose up -d
```

### Open TUI

```sh
docker compose run --rm tui
```

### Inspect Logs

```sh
docker compose logs -f app
docker compose logs -f postgres
```

### Backup PostgreSQL Volume

```sh
docker compose exec postgres pg_dump -U agentsmith -d agentsmith > agentsmith-backup.sql
```

### Restore PostgreSQL Backup

```sh
cat agentsmith-backup.sql | docker compose exec -T postgres psql -U agentsmith -d agentsmith
```

## All-In-One Single Container Variant

If the hard requirement is exactly one container with gateway, web app, TUI, and Postgres in the same container, provide a separate `Dockerfile.all-in-one` and document it as the simplest demo mode, not the recommended durable mode.

Shape:

- Base image: Debian or `oven/bun` with PostgreSQL installed.
- Entrypoint initializes a Postgres data directory under `/data/postgres` on first boot.
- Entrypoint starts Postgres in the background, waits for readiness, exports `DATABASE_URL=postgres://...@127.0.0.1:5432/agentsmith`, then starts the gateway in the foreground.
- Docker volume: `/data`.
- Exposed port: `8080`.
- TUI is launched with `docker exec -it agentsmith agentsmith tui`.

Example user command:

```sh
docker run -d \
  --name agentsmith \
  -p 127.0.0.1:8080:8080 \
  -v agentsmith-data:/data \
  -e POSTGRES_PASSWORD='<random-password>' \
  -e GATEWAY_JWT_SECRET='<random-secret>' \
  -e MESH_API_KEY='<mesh-api-key>' \
  ghcr.io/ugmurthy/agentsmith-fullstack-all-in-one:latest
```

TUI:

```sh
docker exec -it agentsmith agentsmith tui
```

Tradeoffs:

- Easier one-command demo.
- Harder Postgres upgrades.
- Harder backups and disaster recovery.
- More complex entrypoint and shutdown handling.
- Less aligned with normal container practice.

Recommendation: publish this only if users strongly prefer a single `docker run` command. Otherwise keep the Compose-based install as the default.

## Security Notes

- Default port binding should be `127.0.0.1:8080:8080`, not public LAN binding.
- Local `/api/dev-token` must be disabled in hosted deployments.
- Generate `POSTGRES_PASSWORD` and `GATEWAY_JWT_SECRET`; do not ship fixed defaults.
- Model API keys live in `.env`; users should not commit that file.
- The packaged default tools can include `shell_exec`; inside Docker this is constrained to the container, but mounted host directories still need care.
- If users mount a host workspace, recommend mounting only the project directory they want the agent to access, not their whole home directory.

## Acceptance Criteria

The packaging is ready when a fresh machine with Docker can do all of the following:

- Run `docker compose up -d` from released files.
- Open `http://localhost:8080` and connect to the gateway without manually entering a socket URL.
- Start a chat or run from the web UI.
- Upload images through `/api/images` if image upload is enabled in the UI.
- View persisted runs through the dashboard after restarting containers.
- Run `docker compose run --rm tui` and connect to the same gateway.
- Restart with `docker compose restart` without losing sessions, transcripts, run traces, or plans.
- Upgrade with `docker compose pull && docker compose up -d`.

## Implementation Sequence

1. Add gateway production static serving for `packages/gateway-web/dist`.
2. Add local-only `/api/gateway-defaults` and `/api/dev-token` gateway routes.
3. Add `Dockerfile.fullstack`, `docker/entrypoint.sh`, Compose, `.env.example`, and install script.
4. Build and smoke-test the image locally on one machine.
5. Add GHCR publishing through GitHub Actions.
6. Publish a tagged release with Compose/install assets.
7. Test the release install on a clean Intel/AMD machine and a clean Apple Silicon machine.
