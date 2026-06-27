import { describe, expect, it } from 'vitest';

import { buildGroundTruthContext, mergeGroundTruthContext } from './ground-truth-context.js';

describe('ground truth context', () => {
  it('resolves calendar ranges and fiscal ranges from configured policy', () => {
    const context = buildGroundTruthContext({
      now: new Date('2026-06-26T16:00:00.000Z'),
      timezone: 'Asia/Kolkata',
      locale: 'en-IN',
      weekStartsOn: 'monday',
      fiscalYearStartMonth: 4,
      fiscalQuarterNaming: 'startYear',
    });

    expect(context.calendar).toMatchObject({
      today: '2026-06-26',
      yesterday: '2026-06-25',
      tomorrow: '2026-06-27',
      thisWeek: { start: '2026-06-22', end: '2026-06-28' },
      thisMonth: { start: '2026-06-01', end: '2026-06-30' },
      thisQuarter: { start: '2026-04-01', end: '2026-06-30' },
      thisYear: { start: '2026-01-01', end: '2026-12-31' },
    });
    expect(context.fiscal).toMatchObject({
      fiscalYearStartMonth: 4,
      currentFiscalYear: { label: 'FY2026-2027', start: '2026-04-01', end: '2027-03-31' },
      currentFiscalQuarter: { label: 'FY2026-2027 Q1', quarter: 1, start: '2026-04-01', end: '2026-06-30' },
    });
  });

  it('supports fiscal year labels based on the ending year', () => {
    const context = buildGroundTruthContext({
      now: new Date('2026-02-10T12:00:00.000Z'),
      timezone: 'UTC',
      locale: 'en-GB',
      fiscalYearStartMonth: 4,
      fiscalQuarterNaming: 'endYear',
    });

    expect(context.fiscal).toMatchObject({
      currentFiscalYear: { label: 'FY2026', start: '2025-04-01', end: '2026-03-31' },
      currentFiscalQuarter: { label: 'FY2026 Q4', quarter: 4, start: '2026-01-01', end: '2026-03-31' },
    });
  });

  it('can be disabled without changing caller context', () => {
    expect(mergeGroundTruthContext({ requestId: 'abc' }, { enabled: false })).toEqual({ requestId: 'abc' });
  });
});
