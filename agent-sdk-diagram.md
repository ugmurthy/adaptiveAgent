# AdaptiveAgent Agent SDK Diagram

This diagram is derived from [packages/agent-sdk/README.md](file:///Users/ugmurthy/riding-amp/AgentSmith/packages/agent-sdk/README.md) and [CORE-SESSION-SWARM-SPEC.md](file:///Users/ugmurthy/riding-amp/AgentSmith/CORE-SESSION-SWARM-SPEC.md). It is intentionally presentation-oriented.

## 0. Executive View: CLI Setup, Durable Core

**Caption:** The Agent SDK resolves local agent profiles and user intent, then hands prepared requests to core; core owns validation, durable runs, sessions, tools, events, snapshots, and swarm execution semantics.

```mermaid
flowchart TD
    A([Users, Shell, TUI, Specs])
    B[Agent SDK Entry Points<br>run + chat + spec + retry<br>swarm-run + agent-create<br>catalog + eval + config<br>init + doctor + update]
    C[Agent Profile Setup<br>agent.json + settings<br>model + runtime + tools + delegates]
    D[CLI Intent Translation<br>friendly validation + defaults<br>prepared core requests]
    E{{Execution Shape}}
    F[Direct Core Calls<br>AdaptiveAgent.run/chat/resume<br>single root run]
    G[Swarm Decomposition Setup<br>safe worker catalog<br>structured SwarmSubtask list]
    H[Core Runtime<br>strict validation before execution<br>runs + sessions + events + snapshots]
    I{{Runs Execute Through Tools}}
    J[Regular Tools<br>registered built-ins and host tools]
    K[Delegate Profiles<br>delegate dot star tools<br>child runs]
    L[Swarm Runs<br>worker + quality + synthesizer<br>sessionId + coordinatorRunId]
    M[SDK Output Layer<br>pretty/json/jsonl<br>progress + inspection]

    A -->|commands and specs| B
    B -->|resolve config| C
    C -->|agent profiles and runtime handles| D
    D -->|choose path| E
    E -->|run/chat/spec/retry| F
    E -->|swarm-run| G
    F -->|RunRequest or ChatRequest| H
    G -->|SwarmExecutionRequest| H
    H -->|model-selected calls| I
    I -->|tool execution| J
    I -->|delegate calls| K
    H -->|bounded independent root runs| L
    J -->|tool results| H
    K -->|child run results| H
    L -->|worker results and assessments| H
    H -->|events and run results| M
    M -->|answers and diagnostics| A

    %% Light Professional Theme
    classDef edge      fill:#f8fafc, stroke:#64748b, color:#1e2937, stroke-width:3px, rx:10px, ry:10px
    classDef sdk       fill:#f1f5f9, stroke:#0ea5e9, color:#0c4a6e, stroke-width:3.5px
    classDef profile   fill:#f8fafc, stroke:#f59e0b, color:#78350f, stroke-width:3.5px
    classDef request   fill:#f8fafc, stroke:#14b8a6, color:#134e4a, stroke-width:3.5px
    classDef core      fill:#f8fafc, stroke:#10b981, color:#064e3b, stroke-width:3.5px
    classDef concept   fill:#f8fafc, stroke:#8b5cf6, color:#4c1d95, stroke-width:4px, font-weight:bold
    classDef tool      fill:#f8fafc, stroke:#7c3aed, color:#4c1d95, stroke-width:3px
    classDef delegate  fill:#f8fafc, stroke:#ec4899, color:#831843, stroke-width:3.5px
    classDef swarm     fill:#f8fafc, stroke:#22c55e, color:#14532d, stroke-width:3.5px
    classDef output    fill:#f8fafc, stroke:#64748b, color:#1e2937, stroke-width:3px

    %% Thicker professional arrows
    linkStyle default stroke:#475569, stroke-width:4.5px, stroke-opacity:0.95

    class A edge
    class B sdk
    class C profile
    class D request
    class E concept
    class F core
    class G request
    class H core
    class I concept
    class J tool
    class K delegate
    class L swarm
    class M output
```

### Simplified View: SDK-Prepared Core Root Agent

**Caption:** The Agent SDK turns local configuration and CLI input into a configured core root agent; the root agent runs through the core tool interface and returns events/results to the SDK output layer.

```mermaid
flowchart TD
    A([CLI, TUI, or Spec])
    B[Agent SDK<br>load agent.json + settings<br>apply CLI defaults]
    C[Core Root Agent<br>provider + model + defaults<br>system prompt]
    D{{Everything Becomes a Tool}}
    E[Regular Tools<br>built-ins and host tools]
    F[Delegate Profiles<br>delegate dot star tools<br>child runs]
    G[Durable Core Runtime<br>run + sessionId<br>events + snapshots]
    H[SDK Output<br>pretty/json/jsonl<br>progress + inspection]

    A -->|user intent| B
    B -->|configured request| C
    C -->|calls tools| D
    D -->|standard tool calls| E
    D -->|delegate calls| F
    E -->|tool result| C
    F -->|child run result| C
    C -->|run state| G
    G -->|events and final result| H
    H -->|answer and diagnostics| A

    %% Light Professional Theme
    classDef edge      fill:#f8fafc, stroke:#64748b, color:#1e2937, stroke-width:3px, rx:10px, ry:10px
    classDef sdk       fill:#f1f5f9, stroke:#0ea5e9, color:#0c4a6e, stroke-width:3.5px
    classDef core      fill:#f8fafc, stroke:#10b981, color:#064e3b, stroke-width:3.5px
    classDef concept   fill:#f8fafc, stroke:#8b5cf6, color:#4c1d95, stroke-width:4px, font-weight:bold
    classDef tool      fill:#f8fafc, stroke:#7c3aed, color:#4c1d95, stroke-width:3px
    classDef delegate  fill:#f8fafc, stroke:#ec4899, color:#831843, stroke-width:3.5px
    classDef output    fill:#f8fafc, stroke:#64748b, color:#1e2937, stroke-width:3px

    %% Thicker professional arrows
    linkStyle default stroke:#475569, stroke-width:4.5px, stroke-opacity:0.95

    class A edge
    class B sdk
    class C core
    class D concept
    class E tool
    class F delegate
    class G core
    class H output
```

### Core Idea

The central idea in `@adaptive-agent/agent-sdk` is that CLI and TUI workflows are setup layers over `@adaptive-agent/core`. The SDK loads `agent.json` and `agent.settings.json`, resolves model/runtime/tool/delegate configuration, applies CLI-friendly defaults, and translates commands or specs into strict core requests.

The SDK also owns agent-profile creation workflows such as `agent-create`, which generates and writes new agent config JSON files before those profiles are used to configure core root agents.

For `swarm-run`, the SDK also owns the user-facing decomposition setup: it loads coordinator, worker, quality, and synthesizer agent profiles, builds a safe worker catalog summary, asks the coordinator for structured `SwarmSubtask[]`, and prevalidates the result for clear errors. Core still validates before execution and owns the durable run/session behavior.

### Why This Matters

- The SDK stays user-facing. Command names, config lookup, agent discovery, agent creation, dry runs, output formatting, progress, inspection, and friendly errors live close to the CLI/TUI.
- The core stays reusable. It does not depend on Agent SDK config paths, default agent specs, CLI commands, or agent-profile loading.
- Validation stays layered. The SDK may prevalidate for usability, but core still validates model output and execution requests before running them.
- Runtime semantics stay durable. Core owns runs, sessions, child runs, retries, continuation, snapshots, eventing, and runtime metadata.
- Swarm execution stays correlated. Worker, quality, and synthesizer runs are independent root runs grouped by `sessionId` and `coordinatorRunId`, not parallel child runs.
