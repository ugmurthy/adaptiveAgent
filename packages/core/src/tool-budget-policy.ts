import type { AgentDefaults, ResearchPolicy, ResearchPolicyName, ToolBudget } from './types.js';

export interface ResolvedResearchPolicy {
  mode: ResearchPolicyName;
  maxSearches: number;
  maxPagesRead: number;
  checkpointAfter: number;
  requirePurpose: boolean;
}

export const RESEARCH_POLICY_PRESETS: Record<ResearchPolicyName, ResolvedResearchPolicy> = {
  none: {
    mode: 'none',
    maxSearches: 0,
    maxPagesRead: 0,
    checkpointAfter: 0,
    requirePurpose: true,
  },
  light: {
    mode: 'light',
    maxSearches: 2,
    maxPagesRead: 4,
    checkpointAfter: 1,
    requirePurpose: true,
  },
  standard: {
    mode: 'standard',
    maxSearches: 4,
    maxPagesRead: 8,
    checkpointAfter: 3,
    requirePurpose: true,
  },
  deep: {
    mode: 'deep',
    maxSearches: 8,
    maxPagesRead: 20,
    checkpointAfter: 5,
    requirePurpose: true,
  },
  gaia: {
    mode: 'gaia',
    maxSearches: 6,
    maxPagesRead: 12,
    checkpointAfter: 3,
    requirePurpose: true,
  },
};

export function resolveResearchPolicy(
  policy: ResearchPolicyName | ResearchPolicy | undefined,
): ResolvedResearchPolicy | undefined {
  if (!policy) {
    return undefined;
  }

  const base = typeof policy === 'string' ? RESEARCH_POLICY_PRESETS[policy] : RESEARCH_POLICY_PRESETS[policy.mode];
  return {
    ...base,
    ...(typeof policy === 'string' ? {} : filterDefinedResearchOverrides(policy)),
  };
}

export function resolveToolBudgets(defaults: Pick<AgentDefaults, 'researchPolicy' | 'toolBudgets'> | undefined): Record<string, ToolBudget> | undefined {
  const researchPolicy = resolveResearchPolicy(defaults?.researchPolicy);
  const presetBudgets = researchPolicy ? budgetsFromResearchPolicy(researchPolicy) : undefined;
  if (!presetBudgets && !defaults?.toolBudgets) {
    return undefined;
  }

  const merged: Record<string, ToolBudget> = {
    ...(presetBudgets ?? {}),
  };

  for (const [groupName, budget] of Object.entries(defaults?.toolBudgets ?? {})) {
    merged[groupName] = {
      ...(merged[groupName] ?? {}),
      ...budget,
    };
  }

  return merged;
}

export function budgetsFromResearchPolicy(policy: ResolvedResearchPolicy): Record<string, ToolBudget> {
  return {
    'web_research.search': {
      maxCalls: policy.maxSearches,
      checkpointAfter: policy.checkpointAfter,
      maxConsecutiveCalls: 2,
      onExhausted: 'ask_model',
    },
    'web_research.read': {
      maxCalls: policy.maxPagesRead,
      checkpointAfter: Math.max(1, Math.floor(policy.maxPagesRead * 0.75)),
      maxConsecutiveCalls: 4,
      onExhausted: 'ask_model',
    },
  };
}

function filterDefinedResearchOverrides(policy: ResearchPolicy): Partial<ResolvedResearchPolicy> {
  const overrides: Partial<ResolvedResearchPolicy> = {};
  if (policy.maxSearches !== undefined) {
    overrides.maxSearches = policy.maxSearches;
  }
  if (policy.maxPagesRead !== undefined) {
    overrides.maxPagesRead = policy.maxPagesRead;
  }
  if (policy.checkpointAfter !== undefined) {
    overrides.checkpointAfter = policy.checkpointAfter;
  }
  if (policy.requirePurpose !== undefined) {
    overrides.requirePurpose = policy.requirePurpose;
  }
  return overrides;
}
