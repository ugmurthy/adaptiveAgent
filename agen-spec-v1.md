**High-Level Product Specification: AdaptiveAgent Library**  
**Version**: 1.2 (Updated April 2026)  
**Target Stack**: Bun + TypeScript (pure provider SDKs — OpenAI, Anthropic, xAI/Grok, etc.). No LangChain or similar frameworks.  
**Dashboard**: Svelte 5.x + SvelteKit (using runes for reactivity: `$state`, `$derived`, `$effect`). Styled with **Tailwind CSS**. Includes exportable reports (CSV/JSON for token usage & costs).  
**Pricing Map**: Static JSON file (editable by developers, loaded at startup — no runtime DB editing).

### 1. Product Overview
`AdaptiveAgent` is a lightweight, standalone TypeScript library for building customizable, observable, and resilient goal-seeking AI agents.  

Key capabilities:
- Per-task customization of allowed/forbidden **Tools** (structured function calls) and **Skills** (higher-level multi-step behaviors).
- Configurable priority: tools-first or skills-first.
- Dynamic placeholder replacement (`today` → `{{CurrentDate}}`, etc.) during every reasoning step.
- Full observability via structured events.
- Interruptible, resumable from last checkpoint.
- Goal-seeking with final evaluation (optional external evaluator or LLM self-check).
- Always returns clean JSON result (success/failure/clarification).
- Real-time stats: token usage + estimated cost (collected per LLM call).
- Streaming support for LLM reasoning thoughts (live "thinking" on dashboard).

The library is designed for production use: Postgres persistence, WebSocket-ready events, and a ready-to-run Svelte 5 dashboard example.

### 2. Core Agentic Features (Inside Agent) vs External
**Inside AdaptiveAgent**:
- ReAct-style loop with tool/skill selection & priority.
- Dynamic placeholder replacement on every thought.
- Checkpointing & resumption logic.
- Final goal evaluation.
- Streaming + usage extraction from provider SDKs.
- Clean success/failure/clarification output.

**Outside (Host Application)**:
- WebSocket server for broadcasting events.
- Postgres connection & schema (library provides Drizzle/Prisma schema).
- Dashboard hosting (SvelteKit app consumes events via WS + REST).
- Authentication, rate limiting, long-term memory, multi-agent coordination.

### 3. Architecture
```
adaptive-agent (library)
├── src/
│   ├── AdaptiveAgent.ts          // main class
│   ├── LLMAdapter.ts             // pluggable per provider + streaming + usage
│   ├── ToolRegistry.ts / SkillRegistry.ts
│   ├── PlaceholderEngine.ts      // dynamic replacement
│   ├── StateMachine.ts           // planning → acting → observing → evaluating
│   ├── CheckpointService.ts      // Postgres
│   ├── Observer.ts               // EventEmitter with token_usage_updated
│   ├── CostCalculator.ts         // static prices.json
│   └── types.ts
└── prompts/                      // plain .txt files for easy editing

examples/
├── dashboard/                    // SvelteKit 5 + Tailwind
└── simple-node-usage/            // minimal Bun/TS example
```

### 4. Data Model (Postgres — Drizzle recommended for Bun)
Core tables (library ships schema definitions):

- `agent_runs`: id, task_id, goal, config (JSONB), status, current_step, checkpoint (JSONB), result (JSONB), error, totalPromptTokens, totalCompletionTokens, estimatedCostUSD, created_at, updated_at.
- `agent_events`: run_id, step, type (thought | tool_call | placeholder_replaced | token_usage_updated | clarification | eval | ...), payload (JSONB), created_at.

### 5. Configuration (JSON + runtime overrides, per-task)
```ts
// Global or file-based
const config: AgentConfig = {
  llm: { provider: 'openai', model: 'gpt-4o', apiKey: '...' },
  tools: ['*'],                    // or specific list
  forbiddenTools: ['email_send'],
  skills: ['research', 'booking'],
  toolPriorityFirst: true,
  maxSteps: 30,
  enableStreaming: true,           // for reasoning thoughts
  // placeholder rules (built-in + custom regex/mappings)
};

// Per-task
const result = await agent.runTask({
  goal: "Book flights from Delhi to NYC on today for 2 adults",
  configOverrides: { toolPriorityFirst: false }
});
```

### 6. Dynamic Placeholder Replacement
Happens **during reasoning** (before/after every LLM thought).  
Built-in rules + configurable regex.  
Example: `today` → `{{CurrentDate}}`, `next week` → `{{CurrentDate+7d}}`.  
Reversible for audit (original text stored in events/checkpoint).

### 7. Execution Flow & Streaming
1. Create/load run → checkpoint.
2. **Planning/Reasoning**: LLM call with `stream: true` (if enabled).  
   - Emit `thought_chunk` events (dashboard shows live typing).  
   - On complete: `thought_completed`, run placeholder replacement, emit event.
3. **Acting**: Call selected Tool or Skill (priority respected). Emit start/complete.
4. Observe result → checkpoint.
5. Repeat until goal or maxSteps.
6. **Final Evaluation** (at end only): external fn or LLM self-check → `goalAchieved`.
7. Collect cumulative token usage + cost on every LLM call.

**Token Usage & Cost Collection**:
- `LLMAdapter` normalizes usage from provider responses (`usage: { prompt_tokens, completion_tokens, ... }` — works for OpenAI, Anthropic, Grok/xAI).
- After each call: calculate cost using static `prices.json`, emit `token_usage_updated` event, accumulate in run record.
- Dashboard shows live totals + per-step breakdown.

### 8. Interruption, Resumption, Failure
- Interrupt: `agent.interrupt(runId)` or process signal.
- Resume: `agent.resume(runId)` — restores from last checkpoint.
- Failure: clean error in result JSON, status = 'failed'.

### 9. Observability & Real-Time
- `Observer` (EventEmitter) fires structured events on every step + `token_usage_updated`.
- Host wires to:
  - Postgres (`agent_events`).
  - WebSocket (e.g. `/runs/:runId` room).
- **Real-time on Dashboard**: Svelte 5 subscribes to WebSocket. Events update reactive state (`$state`, `$derived` for stats/cost/progress). Live thought streaming gives "agent is thinking" feel.

### 10. Proposed Output JSON Schema
```ts
type AgentResult =
  | {
      status: 'success';
      result: any;                    // task-specific JSON
      goalAchieved: boolean;
      stepsUsed: number;
      totalPromptTokens: number;
      totalCompletionTokens: number;
      estimatedCostUSD: number;
      placeholdersResolved: Record<string, string>;
    }
  | {
      status: 'failure';
      error: string;
      code?: string;                  // e.g. MAX_STEPS, TOOL_ERROR
      stepsUsed: number;
      totalPromptTokens: number;
      estimatedCostUSD: number;
    }
  | {
      status: 'clarification_requested';
      message: string;
      suggestedQuestions?: string[];
    };
```

### 11. Dashboard (Svelte 5 + Tailwind)
- **Folder**: `examples/dashboard`
- Built with SvelteKit (runes mode).
- Features:
  - Run list with live status & progress.
  - Per-run trace timeline (thoughts, tool calls, placeholders, stats).
  - Live log feed with streaming thoughts.
  - Statistics panel: real-time token usage, cost (updated via WS), latency, steps.
  - Controls: Interrupt, Resume, Send clarification.
  - Export reports: CSV/JSON for run history (tokens, costs, events).
- UI: Pure Tailwind (no extra component libs). Clean, responsive, dark mode.
- WebSocket handling with auto-reconnect.
- REST fallback for historical data.

### 12. Implementation Guidance
- **LLMAdapter**: One class per provider. Support `stream` option + mandatory usage extraction.
- **Prompts**: Store as `.txt` files with simple placeholders.
- **Tool/Skill Registration**: Use decorators or explicit register methods.
- **CostCalculator**: Load `prices.json` at init. Example entries for gpt-4o, claude-3.5-sonnet, grok-4, etc.
- **Svelte 5 Best Practices**: Use runes (`$state`, `$derived`, `$effect`). Avoid legacy reactivity.
- **Bun Optimizations**: Fast startup, native TypeScript support.
- **Extensibility**: Hooks (`beforeLLMCall`, `afterStep`, etc.).
- **Testing**: Mock LLMAdapter for unit tests; integration with real providers (keys in env).

**Potential Pitfalls**:
- Keep checkpoints lightweight (compress history if large).
- Streaming requires careful event ordering on WebSocket.
- Provider usage formats may have slight variations — normalize carefully.

### 13. Monorepo Starter Structure
```
adaptive-agent/
├── packages/
│   ├── core/                          # the main library
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── AdaptiveAgent.ts
│   │   │   ├── LLMAdapter.ts
│   │   │   ├── adapters/              # openai.ts, anthropic.ts, grok.ts
│   │   │   ├── PlaceholderEngine.ts
│   │   │   ├── registries/
│   │   │   ├── observer/
│   │   │   ├── checkpoint/
│   │   │   ├── evaluator.ts
│   │   │   ├── cost-calculator.ts
│   │   │   ├── types.ts
│   │   │   └── prompts/               # .txt files
│   │   ├── drizzle/                   # schema
│   │   ├── prices.json
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── dashboard/                     # Svelte 5 example
│       ├── src/
│       │   ├── routes/
│       │   │   ├── +page.svelte       # run list
│       │   │   ├── runs/[id]/+page.svelte  # trace viewer
│       │   ├── lib/
│       │   │   ├── components/        # RunList.svelte, TraceTimeline.svelte, StatsPanel.svelte, etc.
│       │   │   ├── ws.ts              # WebSocket client
│       │   │   └── utils.ts           # export helpers
│       │   ├── app.html
│       │   └── app.css                # Tailwind
│       ├── svelte.config.js
│       ├── tailwind.config.js
│       ├── vite.config.ts
│       └── package.json
├── examples/
│   └── simple-usage/                  # plain Bun TS script
├── README.md
├── package.json                       # workspace root (bun)
└── tsconfig.json
```

**Quick Start Commands** (in root):
- `bun install`
- `bun --cwd packages/core build` (or watch)
- `bun --cwd packages/dashboard dev` (SvelteKit dev server)

**To Use the Library**:
```ts
import { AdaptiveAgent } from 'adaptive-agent';

const agent = new AdaptiveAgent(config);
const result = await agent.runTask({ goal: "..." });
```

This structure is ready for a coding agent or developer to implement incrementally:

1. Core library (AdaptiveAgent + StateMachine + LLMAdapter skeleton).
2. Tool/Skill/Placeholder systems.
3. Checkpoint + Observer + Cost tracking.
4. Dashboard (Svelte 5 pages + components + WS integration).
5. Polish: streaming, exports, full examples.

**Next Actions**:
- If you want me to generate the **skeleton code for specific files** (e.g. `AdaptiveAgent.ts`, `LLMAdapter.ts`, key Svelte components, or `prices.json` template), tell me the priority.
- Or say “generate full starter files for core + dashboard skeleton” and I’ll provide the initial code files.

Let me know how you'd like to proceed!