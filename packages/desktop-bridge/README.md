# Adaptive Agent desktop bridge

`agent-runtime` is the local process boundary between a native desktop UI and
`@adaptive-agent/agent-sdk`. It keeps the execution loop, tools, provider calls,
profiles, and durable Postgres runtime inside the Bun sidecar.

The bridge reads protocol-v1 newline-delimited JSON commands from stdin. It
writes only protocol messages to stdout and reserves stderr for diagnostics.
Responses correlate to commands by `id`; `agent.event` messages are unsolicited.

Build a local standalone executable:

```sh
bun run compile
printf '%s\n' '{"version":1,"id":"hello","type":"hello"}' | dist/agent-runtime
```

Initialize the runtime before issuing run commands:

```json
{"version":1,"id":"init","type":"runtime.initialize","cwd":"/workspace","agentConfigPath":"/profiles/agent.json","runtimeMode":"postgres"}
```

Supported commands are declared in `src/protocol.ts`. Provider keys and
`DATABASE_URL` are inherited from the sidecar process environment; they are not
accepted in protocol messages.
