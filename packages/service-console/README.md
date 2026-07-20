# Service Console

Internal Svelte 5 + Vite operations console for exercising the Adaptive Agent service HTTP and WebSocket APIs. The UI stores pasted JWTs only in memory; decoded claims are display context, not authentication validation.

```sh
bun run service-console:dev
bun run service-console:typecheck
bun run service-console:build
```

Development listens on port `5175`. Set `SERVICE_API_URL` (default `http://127.0.0.1:3000`) to select the Vite proxy target. Production output is `dist/client` and expects the UI plus `/v1` and `/health` to share an origin behind a reverse proxy.
