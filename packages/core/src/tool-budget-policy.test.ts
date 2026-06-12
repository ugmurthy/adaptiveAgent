import { describe, expect, it } from 'vitest';

import { resolveResearchPolicy, resolveToolBudgets } from './tool-budget-policy.js';

describe('tool budget policy', () => {
  it('resolves research policy presets', () => {
    expect(resolveResearchPolicy('standard')).toEqual({
      mode: 'standard',
      maxSearches: 4,
      maxPagesRead: 8,
      checkpointAfter: 3,
      requirePurpose: true,
    });

    expect(resolveResearchPolicy('gaia')).toEqual({
      mode: 'gaia',
      maxSearches: 6,
      maxPagesRead: 12,
      checkpointAfter: 3,
      requirePurpose: true,
    });
  });

  it('lets explicit tool budgets override preset-derived budgets', () => {
    const budgets = resolveToolBudgets({
      researchPolicy: 'light',
      toolBudgets: {
        'web_research.search': {
          maxCalls: 3,
          checkpointAfter: 2,
        },
      },
    });

    expect(budgets).toMatchObject({
      'web_research.search': {
        maxCalls: 3,
        checkpointAfter: 2,
        onExhausted: 'ask_model',
      },
      'web_research.read': {
        maxCalls: 4,
      },
    });
    expect(budgets?.['web_research.search']).not.toHaveProperty('maxConsecutiveCalls');
    expect(budgets?.['web_research.read']).not.toHaveProperty('maxConsecutiveCalls');
  });

  it('preserves explicit consecutive caps without deriving hidden ones from policy presets', () => {
    expect(
      resolveToolBudgets({
        researchPolicy: 'deep',
        toolBudgets: {
          'web_research.search': {
            maxConsecutiveCalls: 2,
          },
        },
      }),
    ).toMatchObject({
      'web_research.search': {
        maxCalls: 8,
        maxConsecutiveCalls: 2,
        onExhausted: 'ask_model',
      },
      'web_research.read': {
        maxCalls: 20,
      },
    });
  });
});
