import type { AgentConfigFile } from '../config-types.js';
import type { InitProvider } from './init.js';
import { GENERATED_BUNDLED_INSTALL_CATALOG } from './bundled-assets.generated.js';

export interface BundledAgentAsset {
  id: string;
  fileName: string;
  config: Omit<AgentConfigFile, 'model'>;
}

export interface BundledSkillAsset {
  name: string;
  files: Record<string, string>;
}

export interface BundledInstallBundle {
  agents: string[];
  skills: string[];
}

export interface BundledInstallCatalog {
  defaultBundles: string[];
  bundles: Record<string, BundledInstallBundle>;
  agents: Record<string, BundledAgentAsset>;
  skills: Record<string, BundledSkillAsset>;
}

const DEFAULT_BUNDLED_INSTALL_CATALOG: BundledInstallCatalog = {
  defaultBundles: ['core'],
  bundles: {
    core: {
      agents: ['planner', 'reviewer'],
      skills: ['research', 'code-review'],
    },
    coding: {
      agents: ['planner', 'reviewer'],
      skills: ['code-review'],
    },
    research: {
      agents: ['researcher'],
      skills: ['research'],
    },
  },
  agents: {
    planner: {
      id: 'planner',
      fileName: 'planner.json',
      config: {
        version: 1,
        id: 'planner',
        name: 'Planner Agent',
        description: 'Breaks ambiguous objectives into concise execution plans and risks.',
        invocationModes: ['run'],
        defaultInvocationMode: 'run',
        workspaceRoot: '.',
        systemInstructions: 'You are a planning specialist. Turn a user objective into a compact plan with assumptions, dependencies, risks, and verification steps. Do not perform implementation work unless explicitly asked.',
        tools: ['read_file', 'list_directory', 'web_search', 'read_web_page'],
        delegates: ['research'],
        capabilities: { subjectsPreferred: ['planning', 'decomposition', 'risk analysis'] },
        defaults: { maxSteps: 20, capture: 'summary' },
      },
    },
    reviewer: {
      id: 'reviewer',
      fileName: 'reviewer.json',
      config: {
        version: 1,
        id: 'reviewer',
        name: 'Review Agent',
        description: 'Reviews code, docs, and plans for correctness, maintainability, and gaps.',
        invocationModes: ['run'],
        defaultInvocationMode: 'run',
        workspaceRoot: '.',
        systemInstructions: 'You are a pragmatic reviewer. Identify concrete issues, explain impact, and suggest the smallest safe correction. Prioritize correctness, contracts, security, and verification gaps.',
        tools: ['read_file', 'list_directory', 'web_search', 'read_web_page'],
        delegates: ['code-review'],
        capabilities: { subjectsPreferred: ['code review', 'quality', 'maintainability'] },
        defaults: { maxSteps: 25, capture: 'summary' },
      },
    },
    researcher: {
      id: 'researcher',
      fileName: 'researcher.json',
      config: {
        version: 1,
        id: 'researcher',
        name: 'Research Agent',
        description: 'Finds and summarizes external information with source-aware caveats.',
        invocationModes: ['run'],
        defaultInvocationMode: 'run',
        workspaceRoot: '.',
        systemInstructions: 'You are a research specialist. Gather relevant information, cite source URLs when available, separate facts from assumptions, and call out uncertainty clearly.',
        tools: ['web_search', 'read_web_page'],
        delegates: ['research'],
        capabilities: { subjectsPreferred: ['research', 'source synthesis', 'market and technical discovery'] },
        defaults: { maxSteps: 25, capture: 'summary' },
      },
    },
  },
  skills: {
    research: {
      name: 'research',
      files: {
        'SKILL.md': `---
name: research
description: Use for focused web or document research with source-aware synthesis.
allowedTools: [web_search, read_web_page, read_file, list_directory]
triggers: [research, sources, web, evidence]
---

# Research

Gather only information needed for the assigned sub-objective. Prefer authoritative sources, preserve important URLs or file paths, distinguish evidence from inference, and summarize uncertainty or missing data explicitly.
`,
      },
    },
    'code-review': {
      name: 'code-review',
      files: {
        'SKILL.md': `---
name: code-review
description: Use for reviewing implementation changes, tests, specs, or architecture notes.
allowedTools: [read_file, list_directory, web_search, read_web_page]
triggers: [review, code review, correctness, tests]
---

# Code Review

Review for correctness, contract drift, security issues, edge cases, and missing verification. Keep findings concrete and ordered by impact. Prefer small fixes that match existing project patterns.
`,
      },
    },
  },
};

export const BUNDLED_INSTALL_CATALOG: BundledInstallCatalog = mergeBundledInstallCatalog(DEFAULT_BUNDLED_INSTALL_CATALOG, GENERATED_BUNDLED_INSTALL_CATALOG);

function mergeBundledInstallCatalog(base: BundledInstallCatalog, generated: BundledInstallCatalog): BundledInstallCatalog {
  const bundleNames = new Set([...Object.keys(base.bundles), ...Object.keys(generated.bundles)]);
  const bundles: Record<string, BundledInstallBundle> = {};
  for (const name of bundleNames) {
    const baseBundle = base.bundles[name] ?? { agents: [], skills: [] };
    const generatedBundle = generated.bundles[name] ?? { agents: [], skills: [] };
    bundles[name] = {
      agents: [...new Set([...baseBundle.agents, ...generatedBundle.agents])],
      skills: [...new Set([...baseBundle.skills, ...generatedBundle.skills])],
    };
  }

  return {
    defaultBundles: [...new Set([...base.defaultBundles, ...generated.defaultBundles])],
    bundles,
    agents: { ...base.agents, ...generated.agents },
    skills: { ...base.skills, ...generated.skills },
  };
}

export function materializeBundledAgent(asset: BundledAgentAsset, provider: InitProvider, model: string, apiKeyEnv: string | undefined): AgentConfigFile {
  return {
    ...asset.config,
    model: { provider, model, ...(apiKeyEnv ? { apiKeyEnv } : {}) },
  };
}
