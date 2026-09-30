import type { AgentEvent, JsonObject, JsonValue } from '@adaptive-agent/core';

import { AgentSdk, discoverAgentSdkAgents } from './index.js';
import type { AgentSdkOptions } from './config-types.js';
import { selectAgentProfile, type AgentSelectionResult } from './agent-selection.js';
import {
  directRoutingFallback,
  ExecutionRoutingConfidenceError,
  selectExecutionRoutingWithAgent,
  selectExecutionRoutingWithTypeSafe,
  type AdaptiveExecutionRoutingResult,
} from './adaptive-execution-routing.js';
import type { TaskPreparationAttachmentSummary } from './task-preparation.js';
import {
  AgentSelectionConfidenceError,
  createTypeSafeAgentSelectionClient,
  loadTypeSafeAgentSelectionPolicy,
  selectAgentProfileWithTypeSafe,
} from './typesafe-agent-selection.js';

export interface AutomaticRunDecisionRequest {
  fallbackSdk: AgentSdk;
  sdkOptions: AgentSdkOptions;
  cwd: string;
  originalObjective: string;
  attachments: TaskPreparationAttachmentSummary;
  sessionId: string;
  executionRoutingMode?: 'single';
  selectorEventListener?: (event: AgentEvent) => void;
}

export type AutomaticRunDecision =
  | { kind: 'selection'; selection: AgentSelectionResult }
  | { kind: 'routing'; routing: AdaptiveExecutionRoutingResult };

export function agentSelectionMetadata(selection: AgentSelectionResult): JsonObject {
  return {
    mode: 'auto',
    selectedAgentId: selection.selectedAgentId,
    reason: selection.reason,
    selectionAgentId: selection.selectionAgentId,
    ...(selection.selectionRunId ? { selectionRunId: selection.selectionRunId } : {}),
    ...(selection.selectionModel ? { selectionModel: selection.selectionModel } : {}),
    ...(selection.confidence === undefined ? {} : { confidence: selection.confidence }),
    ...(selection.relevance === undefined ? {} : { relevance: selection.relevance }),
    ...(selection.probabilities ? { probabilities: selection.probabilities as unknown as JsonValue } : {}),
    ...(selection.rejectedTypeSafe ? { rejectedTypeSafe: {
      ...selection.rejectedTypeSafe,
      decision: agentSelectionMetadata(selection.rejectedTypeSafe.decision),
    } } : {}),
    ...(selection.selectionAgentId.startsWith('typesafe:') ? {
      typesafe: {
        ...(selection.usage ? { usage: selection.usage } : {}),
        inputRatePerMillionTokens: 0,
        outputRatePerMillionTokens: 0,
      },
    } : {}),
  };
}

export function executionRoutingMetadata(routing: AdaptiveExecutionRoutingResult): JsonObject {
  return {
    ...routing.decision,
    routerId: routing.routerId,
    ...(routing.routingRunId ? { routingRunId: routing.routingRunId } : {}),
    ...(routing.routingModel ? { routingModel: routing.routingModel } : {}),
    ...(routing.usage ? { typesafe: { usage: routing.usage } } : {}),
    ...(routing.rejectedTypeSafe ? { rejectedTypeSafe: routing.rejectedTypeSafe } : {}),
  } as unknown as JsonObject;
}

/** One Agent SDK interpretation of the selection engine and execution shape for automatic runs. */
export async function decideAutomaticRun(request: AutomaticRunDecisionRequest): Promise<AutomaticRunDecision> {
  const { fallbackSdk, sdkOptions, cwd, originalObjective, attachments, sessionId } = request;
  const settings = fallbackSdk.config.settings;
  const discovery = await discoverAgentSdkAgents(sdkOptions);
  const selectionSettings = settings.agentSelection;
  const adaptive = request.executionRoutingMode !== 'single' && settings.executionRouting?.mode === 'adaptive';
  const selectionRequest = {
    originalObjective,
    candidates: discovery.agents,
    workspaceRoot: fallbackSdk.config.workspaceRoot,
    attachments,
    sessionId,
  };
  const routingRequest = {
    ...selectionRequest,
    maxSpecialists: settings.executionRouting?.maxSpecialists ?? 4,
  };
  const runWithSelectorAgent = async (): Promise<AutomaticRunDecision> => {
    // taskPreparation.agent is retained only as a compatibility fallback for old configurations.
    const configuredAgent = selectionSettings?.agent ?? settings.taskPreparation?.agent;
    if (!configuredAgent) throw new Error('Automatic run selection requires settings.agentSelection.agent for the agent engine or fallback.');
    const runner = await AgentSdk.create({
      ...sdkOptions,
      cwd,
      agentConfigPath: configuredAgent,
      settingsConfigPath: undefined,
      settingsConfig: { ...settings, agent: undefined },
      settingsOverrides: undefined,
      model: undefined,
      runtime: fallbackSdk.created.runtime,
      eventListener: request.selectorEventListener,
    });
    try {
      return adaptive
        ? { kind: 'routing', routing: await selectExecutionRoutingWithAgent(runner, routingRequest) }
        : { kind: 'selection', selection: await selectAgentProfile(runner, selectionRequest) };
    } finally {
      await runner.close();
    }
  };

  const legacyDirectFallback = (error: ExecutionRoutingConfidenceError): AutomaticRunDecision => {
    const fallback = discovery.currentAgent
      ?? discovery.agents.find((candidate) => candidate.configPath === fallbackSdk.agentPath);
    if (!fallback) throw new Error('Low-confidence routing could not resolve the configured direct fallback profile.');
    return {
      kind: 'routing',
      routing: {
        decision: directRoutingFallback(fallback, attachments, error.confidence),
        routerId: 'deterministic:low-confidence-fallback',
      },
    };
  };

  if (selectionSettings?.engine !== 'typesafe') {
    try {
      return await runWithSelectorAgent();
    } catch (error) {
      if (adaptive && error instanceof ExecutionRoutingConfidenceError
        && settings.executionRouting?.lowConfidenceFallback === 'direct') return legacyDirectFallback(error);
      throw error;
    }
  }
  const typesafe = selectionSettings.typesafe;
  if (!typesafe) throw new Error('Automatic run selection requires settings.agentSelection.typesafe.');
  const env = { ...process.env, ...(sdkOptions.env ?? {}), ...(settings.env ?? {}) };
  const apiKeyEnv = typesafe.apiKeyEnv ?? 'TYPESAFE_API_KEY';
  const apiKey = env[apiKeyEnv];
  if (!apiKey) throw new Error(`TypeSafe run selection requires environment variable "${apiKeyEnv}".`);
  const policy = await loadTypeSafeAgentSelectionPolicy(cwd, typesafe.policyPath, typesafe.policy, env);
  const client = createTypeSafeAgentSelectionClient({
    apiKey,
    baseUrl: typesafe.baseUrl,
    timeoutMs: typesafe.timeoutMs,
  });
  const model = typesafe.model ?? 'jev-latest';
  try {
    return adaptive
      ? { kind: 'routing', routing: await selectExecutionRoutingWithTypeSafe(client, routingRequest, model, policy) }
      : { kind: 'selection', selection: await selectAgentProfileWithTypeSafe(client, selectionRequest, model, policy) };
  } catch (error) {
    if (!(error instanceof AgentSelectionConfidenceError || error instanceof ExecutionRoutingConfidenceError)) throw error;
    if (selectionSettings.lowConfidenceFallback !== 'error' && selectionSettings.agent) {
      const fallback = await runWithSelectorAgent();
      if (fallback.kind === 'selection' && error instanceof AgentSelectionConfidenceError) {
        return { kind: 'selection', selection: { ...fallback.selection, rejectedTypeSafe: error.rejectedTypeSafe } };
      }
      if (fallback.kind === 'routing' && error instanceof ExecutionRoutingConfidenceError) {
        return { kind: 'routing', routing: { ...fallback.routing, rejectedTypeSafe: error.rejectedTypeSafe } };
      }
      return fallback;
    }
    throw error;
  }
}
