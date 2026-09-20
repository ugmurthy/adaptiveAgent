import type { AgentConfigFile, SupportedModality } from './config-types.js';

export type ExecutionRoutingMode = 'direct' | 'orchestration';
export type ExecutionRoutingSource = 'deterministic' | 'agent' | 'typesafe';

export interface ExecutionRoutingAssignment {
  agentId: string;
  modalities: SupportedModality[];
  reason: string;
}

export interface ExecutionRoutingDecision {
  mode: ExecutionRoutingMode;
  primaryAgentId: string;
  synthesisAgentId?: string;
  assignments: ExecutionRoutingAssignment[];
  selectedCatalogAgentIds: string[];
  reason: string;
  confidence?: number;
  source: ExecutionRoutingSource;
}

export interface ExecutionRoutingCatalogEntry {
  agentId: string;
  agentConfig: AgentConfigFile;
}

export function buildDeterministicExecutionRoutingDecision(params: {
  requestedAgentId: string;
  detectedModalities: SupportedModality[];
  catalog: Map<string, ExecutionRoutingCatalogEntry>;
  forceOrchestration: boolean;
  synthesize: boolean;
}): ExecutionRoutingDecision {
  const requested = params.catalog.get(params.requestedAgentId);
  if (!requested) throw new Error(`Unknown requested agent "${params.requestedAgentId}"`);

  const assignments = new Map<string, SupportedModality[]>();
  for (const modality of params.detectedModalities) {
    const requestedSupports = supportedModalities(requested.agentConfig).includes(modality);
    const specialist = modality === 'text'
      ? undefined
      : chooseModalitySpecialist(params.catalog, modality, params.requestedAgentId);
    const useSpecialist = specialist && (
      !requestedSupports
      || specialistScore(specialist, modality) > specialistScore(requested, modality)
    );
    const selected = useSpecialist ? specialist : requestedSupports ? requested : undefined;
    if (!selected) throw new Error(`No agent supports required modality "${modality}".`);
    assignments.set(selected.agentId, [...(assignments.get(selected.agentId) ?? []), modality]);
  }

  const grouped = [...assignments].map(([agentId, modalities]) => ({
      agentId,
      modalities,
      reason: agentId === params.requestedAgentId
        ? `Requested agent "${agentId}" handles ${modalities.join(', ')}.`
        : `Specialist agent "${agentId}" handles ${modalities.join(', ')}.`,
    }));
  const specialistAssignments = grouped.filter((assignment) => assignment.agentId !== params.requestedAgentId);
  const decision: ExecutionRoutingDecision = {
    mode: params.forceOrchestration ? 'orchestration' : specialistAssignments.length > 0 ? 'orchestration' : 'direct',
    primaryAgentId: params.requestedAgentId,
    ...(params.synthesize && specialistAssignments.length > 0 ? { synthesisAgentId: params.requestedAgentId } : {}),
    assignments: grouped,
    selectedCatalogAgentIds: unique([params.requestedAgentId, ...grouped.map((assignment) => assignment.agentId)]),
    reason: specialistAssignments.length > 0
      ? `Assigned ${specialistAssignments.flatMap((assignment) => assignment.modalities).join(', ')} to modality specialist agent(s).`
      : `Requested agent "${params.requestedAgentId}" supports detected modalities: ${params.detectedModalities.join(', ')}.`,
    source: 'deterministic',
  };
  validateExecutionRoutingDecision(decision, params.detectedModalities, params.catalog);
  return decision;
}

export function validateExecutionRoutingDecision(
  decision: ExecutionRoutingDecision,
  detectedModalities: SupportedModality[],
  catalog: Map<string, ExecutionRoutingCatalogEntry>,
): void {
  const selectedIds = new Set(decision.selectedCatalogAgentIds);
  if (!selectedIds.has(decision.primaryAgentId)) {
    throw new Error('Execution routing decision must include its primary agent in selectedCatalogAgentIds.');
  }
  for (const agentId of selectedIds) validateSelectedAgent(agentId, catalog);
  if (decision.synthesisAgentId) {
    validateSelectedAgent(decision.synthesisAgentId, catalog);
    if (!selectedIds.has(decision.synthesisAgentId)) {
      throw new Error('Execution routing decision must include its synthesis agent in selectedCatalogAgentIds.');
    }
  }

  const assigned = new Map<SupportedModality, string>();
  for (const assignment of decision.assignments) {
    const entry = validateSelectedAgent(assignment.agentId, catalog);
    if (!selectedIds.has(assignment.agentId)) {
      throw new Error(`Execution routing assignment references unselected agent "${assignment.agentId}".`);
    }
    if (assignment.modalities.length === 0) {
      throw new Error(`Execution routing assignment for "${assignment.agentId}" has no modalities.`);
    }
    const supported = supportedModalities(entry.agentConfig);
    for (const modality of assignment.modalities) {
      if (!detectedModalities.includes(modality)) {
        throw new Error(`Execution routing assignment contains undetected modality "${modality}".`);
      }
      if (!supported.includes(modality)) {
        throw new Error(`Agent "${assignment.agentId}" does not support assigned modality "${modality}".`);
      }
      const prior = assigned.get(modality);
      if (prior) throw new Error(`Modality "${modality}" is assigned to both "${prior}" and "${assignment.agentId}".`);
      assigned.set(modality, assignment.agentId);
    }
  }
  for (const modality of detectedModalities) {
    if (!assigned.has(modality)) throw new Error(`Execution routing decision does not assign modality "${modality}".`);
  }
  if (decision.mode === 'direct' && [...assigned.values()].some((agentId) => agentId !== decision.primaryAgentId)) {
    throw new Error('Direct execution routing may assign modalities only to the primary agent.');
  }
}

export function supportedModalities(config: AgentConfigFile): SupportedModality[] {
  return config.capabilities?.modalitiesSupported?.length ? config.capabilities.modalitiesSupported : ['text'];
}

function validateSelectedAgent(
  agentId: string,
  catalog: Map<string, ExecutionRoutingCatalogEntry>,
): ExecutionRoutingCatalogEntry {
  const entry = catalog.get(agentId);
  if (!entry) throw new Error(`Execution routing selected unknown agent "${agentId}".`);
  if (!entry.agentConfig.invocationModes.includes('run')) {
    throw new Error(`Execution routing selected agent "${agentId}" without run invocation support.`);
  }
  return entry;
}

function chooseModalitySpecialist(
  catalog: Map<string, ExecutionRoutingCatalogEntry>,
  modality: SupportedModality,
  excludeAgentId: string,
): ExecutionRoutingCatalogEntry | undefined {
  return [...catalog.values()]
    .filter((entry) => entry.agentId !== excludeAgentId)
    .filter((entry) => supportedModalities(entry.agentConfig).includes(modality))
    .sort((left, right) => specialistScore(right, modality) - specialistScore(left, modality)
      || supportedModalities(left.agentConfig).length - supportedModalities(right.agentConfig).length
      || left.agentId.localeCompare(right.agentId))[0];
}

function specialistScore(entry: ExecutionRoutingCatalogEntry, modality: SupportedModality): number {
  let score = 0;
  if (entry.agentConfig.capabilities?.modalitiesPreferred?.includes(modality)) score += 4;
  if (entry.agentConfig.capabilities?.modalityRoles?.[modality] === 'analyze') score += 2;
  if (entry.agentId.toLowerCase().includes(modality)) score += 1;
  return score;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
