# AdaptiveAgent Gateway Diagrams

These diagrams are derived from [adaptive-agent-gateway-proposal.md](file:///Users/ugmurthy/riding-amp/AgentSmith/adaptive-agent-gateway-proposal.md) and are intentionally presentation-oriented.

## 1. High-Level Architecture

```mermaid
flowchart LR
    Client[Authenticated WebSocket Clients]

    subgraph Gateway[AdaptiveAgent Gateway]
        WS[Fastify WebSocket Server]
        Auth[Auth and Session Layer]
        Route[Deterministic Router]
        Orchestrator[Run Orchestrator]
        Fanout[Event Fanout]
    end

    subgraph Config[Configuration and Extensions]
        GatewayConfig[gateway.json]
        AgentConfig[agent configs]
        Modules[hooks, tools, auth modules]
    end

    subgraph Runtime[@adaptive-agent/core]
        Agent[AdaptiveAgent]
        Runs[Root Runs and Child Runs]
        Events[EventStore]
    end

    subgraph Storage[Persistence]
        SessionStore[Gateway session and transcript store]
        RunStore[Runtime run store]
    end

    Client -->|connect and send frames| WS
    WS --> Auth
    Auth -->|resolve or create session| Route
    Route -->|select configured agent| Orchestrator
    GatewayConfig --> Route
    AgentConfig --> Orchestrator
    Modules --> Orchestrator
    Orchestrator -->|chat(), run(), resume()| Agent
    Agent --> Runs
    Agent --> Events
    Auth --> SessionStore
    Orchestrator --> SessionStore
    Runs --> RunStore
    Events --> Fanout
    Fanout -->|session, run, root-run, agent channels| Client
```

## 2. Runtime Sequence

```mermaid
sequenceDiagram
    participant C as Client
    participant G as Fastify Gateway
    participant A as Auth and Session Layer
    participant R as Router
    participant O as Run Orchestrator
    participant AG as AdaptiveAgent
    participant E as EventStore and Fanout

    C->>G: WebSocket connect with JWT
    G->>A: Validate token and normalize authContext
    A-->>G: Principal is authorized

    C->>G: session.open or message.send
    G->>A: Resolve or create session
    A-->>G: sessionId and session state

    G->>R: Match bindings and select agent
    R-->>G: agentId and invocation mode

    G->>O: Dispatch request with session context
    O->>AG: chat() or run()
    AG-->>O: runId and rootRunId

    AG->>E: Emit lifecycle events
    E-->>C: agent.event frames on subscribed channels

    AG-->>O: Final output or approval requested
    O-->>G: Persist session and run linkage

    alt Run completed
        G-->>C: message.output or run.output
        G-->>C: session.updated
    else Approval required
        G-->>C: approval.requested
        C->>G: approval.resolve
        G->>O: Resume pending run
        O->>AG: resume(runId)
        AG->>E: Emit resumed lifecycle events
        E-->>C: Updated agent.event frames
        AG-->>G: Final result
        G-->>C: message.output or run.output
    end
```
