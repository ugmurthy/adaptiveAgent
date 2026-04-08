import type { Logger } from 'pino';

import { createModelAdapter, type ModelAdapterConfig } from './adapters/create-model-adapter.js';
import { AdaptiveAgent } from './adaptive-agent.js';
import { InMemoryEventStore } from './in-memory-event-store.js';
import { InMemoryRunStore } from './in-memory-run-store.js';
import { InMemorySnapshotStore } from './in-memory-snapshot-store.js';
import { skillsToDelegate } from './skills/skill-to-delegate.js';
import type { SkillDefinition } from './skills/types.js';
import type {
  AdaptiveAgentOptions,
  DelegateDefinition,
  EventSink,
  EventStore,
  ModelAdapter,
  PlanStore,
  RunStore,
  SnapshotStore,
} from './types.js';

export type AdaptiveAgentModelInput = ModelAdapter | ModelAdapterConfig;

export interface AdaptiveAgentRuntime<
  TRunStore extends RunStore = InMemoryRunStore,
  TEventStore extends EventStore = InMemoryEventStore,
  TSnapshotStore extends SnapshotStore = InMemorySnapshotStore,
  TPlanStore extends PlanStore | undefined = undefined,
> {
  runStore: TRunStore;
  eventStore: TEventStore;
  snapshotStore: TSnapshotStore;
  planStore: TPlanStore;
}

export interface AdaptiveAgentRuntimeOptions<
  TRunStore extends RunStore = InMemoryRunStore,
  TEventStore extends EventStore = InMemoryEventStore,
  TSnapshotStore extends SnapshotStore = InMemorySnapshotStore,
  TPlanStore extends PlanStore | undefined = undefined,
> {
  runStore?: TRunStore;
  eventStore?: TEventStore;
  snapshotStore?: TSnapshotStore;
  planStore?: TPlanStore;
}

export interface CreateAdaptiveAgentOptions<
  TRunStore extends RunStore = InMemoryRunStore,
  TEventStore extends EventStore = InMemoryEventStore,
  TSnapshotStore extends SnapshotStore = InMemorySnapshotStore,
  TPlanStore extends PlanStore | undefined = undefined,
> extends Omit<
    AdaptiveAgentOptions,
    'model' | 'delegates' | 'runStore' | 'eventStore' | 'snapshotStore' | 'planStore' | 'eventSink' | 'logger'
  > {
  model: AdaptiveAgentModelInput;
  delegates?: DelegateDefinition[];
  skills?: SkillDefinition[];
  runtime?: AdaptiveAgentRuntimeOptions<TRunStore, TEventStore, TSnapshotStore, TPlanStore>;
  eventSink?: EventSink;
  logger?: Logger;
}

export interface CreatedAdaptiveAgent<
  TRunStore extends RunStore = InMemoryRunStore,
  TEventStore extends EventStore = InMemoryEventStore,
  TSnapshotStore extends SnapshotStore = InMemorySnapshotStore,
  TPlanStore extends PlanStore | undefined = undefined,
> {
  agent: AdaptiveAgent;
  runtime: AdaptiveAgentRuntime<TRunStore, TEventStore, TSnapshotStore, TPlanStore>;
}

export function createAdaptiveAgentRuntime<
  TRunStore extends RunStore = InMemoryRunStore,
  TEventStore extends EventStore = InMemoryEventStore,
  TSnapshotStore extends SnapshotStore = InMemorySnapshotStore,
  TPlanStore extends PlanStore | undefined = undefined,
>(
  options: AdaptiveAgentRuntimeOptions<TRunStore, TEventStore, TSnapshotStore, TPlanStore> = {},
): AdaptiveAgentRuntime<TRunStore, TEventStore, TSnapshotStore, TPlanStore> {
  return {
    runStore: (options.runStore ?? new InMemoryRunStore()) as TRunStore,
    eventStore: (options.eventStore ?? new InMemoryEventStore()) as TEventStore,
    snapshotStore: (options.snapshotStore ?? new InMemorySnapshotStore()) as TSnapshotStore,
    planStore: options.planStore as TPlanStore,
  };
}

export function createAdaptiveAgent<
  TRunStore extends RunStore = InMemoryRunStore,
  TEventStore extends EventStore = InMemoryEventStore,
  TSnapshotStore extends SnapshotStore = InMemorySnapshotStore,
  TPlanStore extends PlanStore | undefined = undefined,
>(
  options: CreateAdaptiveAgentOptions<TRunStore, TEventStore, TSnapshotStore, TPlanStore>,
): CreatedAdaptiveAgent<TRunStore, TEventStore, TSnapshotStore, TPlanStore> {
  const runtime = createAdaptiveAgentRuntime(options.runtime);
  const delegates = mergeDelegates(options.delegates, options.skills);
  const agent = new AdaptiveAgent({
    model: resolveModelAdapter(options.model),
    tools: options.tools,
    delegates: delegates.length > 0 ? delegates : undefined,
    delegation: options.delegation,
    runStore: runtime.runStore,
    eventStore: runtime.eventStore,
    snapshotStore: runtime.snapshotStore,
    planStore: runtime.planStore,
    eventSink: options.eventSink,
    logger: options.logger,
    defaults: options.defaults,
    systemInstructions: options.systemInstructions,
  });

  return {
    agent,
    runtime,
  };
}

function resolveModelAdapter(model: AdaptiveAgentModelInput): ModelAdapter {
  return isModelAdapter(model) ? model : createModelAdapter(model);
}

function isModelAdapter(model: AdaptiveAgentModelInput): model is ModelAdapter {
  return typeof (model as ModelAdapter).generate === 'function';
}

function mergeDelegates(
  delegates: DelegateDefinition[] | undefined,
  skills: SkillDefinition[] | undefined,
): DelegateDefinition[] {
  const merged = [...(delegates ?? []), ...skillsToDelegate(skills ?? [])];
  const seen = new Set<string>();

  for (const delegate of merged) {
    if (seen.has(delegate.name)) {
      throw new Error(`Duplicate delegate name ${delegate.name}`);
    }

    seen.add(delegate.name);
  }

  return merged;
}
