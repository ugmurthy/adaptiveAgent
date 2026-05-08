import type { Logger } from 'pino';

import { createModelAdapter, type ModelAdapterConfig } from './adapters/create-model-adapter.js';
import { AdaptiveAgent } from './adaptive-agent.js';
import { InMemoryContinuationStore } from './in-memory-continuation-store.js';
import { InMemoryEventStore } from './in-memory-event-store.js';
import { InMemoryRunStore } from './in-memory-run-store.js';
import { InMemorySnapshotStore } from './in-memory-snapshot-store.js';
import { skillsToDelegate } from './skills/skill-to-delegate.js';
import type { SkillDefinition } from './skills/types.js';
import type {
  AdaptiveAgentOptions,
  ContinuationStore,
  DelegateDefinition,
  EventSink,
  EventStore,
  ModelAdapter,
  PlanStore,
  RuntimeTransactionStore,
  RunStore,
  SnapshotStore,
  ToolExecutionStore,
} from './types.js';

export type AdaptiveAgentModelInput = ModelAdapter | ModelAdapterConfig;

export interface AdaptiveAgentRuntime<
  TRunStore extends RunStore = InMemoryRunStore,
  TEventStore extends EventStore = InMemoryEventStore,
  TSnapshotStore extends SnapshotStore = InMemorySnapshotStore,
  TPlanStore extends PlanStore | undefined = undefined,
  TContinuationStore extends ContinuationStore = InMemoryContinuationStore,
> {
  runStore: TRunStore;
  eventStore: TEventStore;
  snapshotStore: TSnapshotStore;
  planStore: TPlanStore;
  continuationStore: TContinuationStore;
  toolExecutionStore?: ToolExecutionStore;
  transactionStore?: RuntimeTransactionStore;
}

export interface AdaptiveAgentRuntimeOptions<
  TRunStore extends RunStore = InMemoryRunStore,
  TEventStore extends EventStore = InMemoryEventStore,
  TSnapshotStore extends SnapshotStore = InMemorySnapshotStore,
  TPlanStore extends PlanStore | undefined = undefined,
  TContinuationStore extends ContinuationStore = InMemoryContinuationStore,
> {
  runStore?: TRunStore;
  eventStore?: TEventStore;
  snapshotStore?: TSnapshotStore;
  planStore?: TPlanStore;
  continuationStore?: TContinuationStore;
  toolExecutionStore?: ToolExecutionStore;
  transactionStore?: RuntimeTransactionStore;
}

export interface CreateAdaptiveAgentOptions<
  TRunStore extends RunStore = InMemoryRunStore,
  TEventStore extends EventStore = InMemoryEventStore,
  TSnapshotStore extends SnapshotStore = InMemorySnapshotStore,
  TPlanStore extends PlanStore | undefined = undefined,
  TContinuationStore extends ContinuationStore = InMemoryContinuationStore,
> extends Omit<
    AdaptiveAgentOptions,
    | 'model'
    | 'delegates'
    | 'runStore'
    | 'eventStore'
    | 'snapshotStore'
    | 'planStore'
    | 'continuationStore'
    | 'toolExecutionStore'
    | 'eventSink'
    | 'logger'
  > {
  model: AdaptiveAgentModelInput;
  delegates?: DelegateDefinition[];
  skills?: SkillDefinition[];
  runtime?: AdaptiveAgentRuntimeOptions<TRunStore, TEventStore, TSnapshotStore, TPlanStore, TContinuationStore>;
  eventSink?: EventSink;
  logger?: Logger;
}

export interface CreatedAdaptiveAgent<
  TRunStore extends RunStore = InMemoryRunStore,
  TEventStore extends EventStore = InMemoryEventStore,
  TSnapshotStore extends SnapshotStore = InMemorySnapshotStore,
  TPlanStore extends PlanStore | undefined = undefined,
  TContinuationStore extends ContinuationStore = InMemoryContinuationStore,
> {
  agent: AdaptiveAgent;
  runtime: AdaptiveAgentRuntime<TRunStore, TEventStore, TSnapshotStore, TPlanStore, TContinuationStore>;
}

export function createAdaptiveAgentRuntime<
  TRunStore extends RunStore = InMemoryRunStore,
  TEventStore extends EventStore = InMemoryEventStore,
  TSnapshotStore extends SnapshotStore = InMemorySnapshotStore,
  TPlanStore extends PlanStore | undefined = undefined,
  TContinuationStore extends ContinuationStore = InMemoryContinuationStore,
>(
  options: AdaptiveAgentRuntimeOptions<TRunStore, TEventStore, TSnapshotStore, TPlanStore, TContinuationStore> = {},
): AdaptiveAgentRuntime<TRunStore, TEventStore, TSnapshotStore, TPlanStore, TContinuationStore> {
  const transactionStore = isRuntimeTransactionStore(options) ? options : options.transactionStore;
  return {
    runStore: (options.runStore ?? new InMemoryRunStore()) as TRunStore,
    eventStore: (options.eventStore ?? new InMemoryEventStore()) as TEventStore,
    snapshotStore: (options.snapshotStore ?? new InMemorySnapshotStore()) as TSnapshotStore,
    planStore: options.planStore as TPlanStore,
    continuationStore: (options.continuationStore ?? new InMemoryContinuationStore()) as TContinuationStore,
    toolExecutionStore: options.toolExecutionStore,
    transactionStore,
  };
}

export function createAdaptiveAgent<
  TRunStore extends RunStore = InMemoryRunStore,
  TEventStore extends EventStore = InMemoryEventStore,
  TSnapshotStore extends SnapshotStore = InMemorySnapshotStore,
  TPlanStore extends PlanStore | undefined = undefined,
  TContinuationStore extends ContinuationStore = InMemoryContinuationStore,
>(
  options: CreateAdaptiveAgentOptions<TRunStore, TEventStore, TSnapshotStore, TPlanStore, TContinuationStore>,
): CreatedAdaptiveAgent<TRunStore, TEventStore, TSnapshotStore, TPlanStore, TContinuationStore> {
  const runtime = createAdaptiveAgentRuntime(options.runtime);
  const delegates = mergeDelegates(options.delegates, options.skills);
  const agent = new AdaptiveAgent({
    model: resolveModelAdapter(options.model),
    tools: options.tools,
    delegates: delegates.length > 0 ? delegates : undefined,
    delegation: options.delegation,
    recovery: options.recovery,
    runStore: runtime.runStore,
    eventStore: runtime.eventStore,
    snapshotStore: runtime.snapshotStore,
    planStore: runtime.planStore,
    continuationStore: runtime.continuationStore,
    toolExecutionStore: runtime.toolExecutionStore,
    transactionStore: runtime.transactionStore,
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

function isRuntimeTransactionStore(value: unknown): value is RuntimeTransactionStore {
  return typeof (value as RuntimeTransactionStore | undefined)?.runInTransaction === 'function';
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
