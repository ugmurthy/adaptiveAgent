import type { JsonObject } from '@adaptive-agent/core';

import type { GroundTruthSettingsConfig, WeekdayName } from './config-types.js';

const WEEKDAYS: WeekdayName[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const WEEKDAY_TO_INDEX: Record<WeekdayName, number> = {
  monday: 0,
  tuesday: 1,
  wednesday: 2,
  thursday: 3,
  friday: 4,
  saturday: 5,
  sunday: 6,
};

export interface GroundTruthContextOptions extends GroundTruthSettingsConfig {
  now?: Date;
}

interface PlainDate {
  year: number;
  month: number;
  day: number;
}

export function buildGroundTruthContext(options: GroundTruthContextOptions = {}): JsonObject {
  const now = options.now ?? new Date();
  const locale = options.locale ?? defaultLocale();
  const timezone = options.timezone ?? defaultTimezone();
  const weekStartsOn = options.weekStartsOn ?? inferWeekStart(locale);
  const fiscalYearStartMonth = options.fiscalYearStartMonth ?? 1;
  const fiscalQuarterNaming = options.fiscalQuarterNaming ?? 'startYear';
  const today = dateInTimezone(now, timezone);
  const calendarQuarterStartMonth = Math.floor((today.month - 1) / 3) * 3 + 1;
  const fiscalYear = fiscalYearRange(today, fiscalYearStartMonth);
  const fiscalQuarter = fiscalQuarterRange(today, fiscalYearStartMonth);

  return {
    generatedAt: now.toISOString(),
    timezone,
    locale,
    calendarPolicy: {
      weekStartsOn,
      fiscalYearStartMonth,
      fiscalQuarterNaming,
      businessDays: options.businessDays ?? ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
      dateRangeEndInclusive: true,
    },
    calendar: {
      today: formatDate(today),
      yesterday: formatDate(addDays(today, -1)),
      tomorrow: formatDate(addDays(today, 1)),
      thisWeek: weekRange(today, weekStartsOn),
      thisMonth: monthRange(today.year, today.month),
      thisQuarter: monthSpanRange(today.year, calendarQuarterStartMonth, 3),
      thisYear: {
        start: formatDate({ year: today.year, month: 1, day: 1 }),
        end: formatDate({ year: today.year, month: 12, day: 31 }),
      },
    },
    fiscal: {
      fiscalYearStartMonth,
      fiscalQuarterNaming,
      currentFiscalYear: {
        label: fiscalYearLabel(fiscalYear.start.year, fiscalYear.end.year, fiscalQuarterNaming),
        ...formatRange(fiscalYear),
      },
      currentFiscalQuarter: {
        label: `${fiscalYearLabel(fiscalYear.start.year, fiscalYear.end.year, fiscalQuarterNaming)} Q${fiscalQuarter.quarter}`,
        quarter: fiscalQuarter.quarter,
        ...formatRange(fiscalQuarter),
      },
    },
  };
}

export function mergeGroundTruthContext(
  context: Record<string, unknown> | undefined,
  settings: GroundTruthSettingsConfig | undefined,
  options: { now?: Date } = {},
): JsonObject | undefined {
  if (settings?.enabled === false) {
    return context as JsonObject | undefined;
  }

  return {
    ...(context ?? {}),
    groundTruth: buildGroundTruthContext({ ...(settings ?? {}), now: options.now }),
  } as JsonObject;
}

export function groundTruthSystemInstructions(enabled: boolean): string {
  return enabled
    ? [
        '## Ground Truth Context',
        '',
        'When the user uses relative temporal language such as today, yesterday, tomorrow, this week, this month, this quarter, this year, fiscal year, FY, or current financial year, interpret it using `context.groundTruth`.',
        'Do not infer the current date, timezone, locale, week boundary, or fiscal year from model knowledge.',
        'When calling tools, translate relative temporal language into explicit dates or date ranges whenever the tool schema allows it.',
      ].join('\n')
    : '';
}

function dateInTimezone(date: Date, timezone: string): PlainDate {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
  };
}

function weekRange(today: PlainDate, weekStartsOn: WeekdayName): JsonObject {
  const dayIndex = weekdayIndex(today);
  const startOffset = (dayIndex - WEEKDAY_TO_INDEX[weekStartsOn] + 7) % 7;
  const start = addDays(today, -startOffset);
  return {
    start: formatDate(start),
    end: formatDate(addDays(start, 6)),
  };
}

function monthRange(year: number, month: number): JsonObject {
  return {
    start: formatDate({ year, month, day: 1 }),
    end: formatDate({ year, month, day: daysInMonth(year, month) }),
  };
}

function monthSpanRange(year: number, startMonth: number, months: number): JsonObject {
  const endMonthDate = addMonths({ year, month: startMonth, day: 1 }, months - 1);
  return {
    start: formatDate({ year, month: startMonth, day: 1 }),
    end: formatDate({ ...endMonthDate, day: daysInMonth(endMonthDate.year, endMonthDate.month) }),
  };
}

function fiscalYearRange(today: PlainDate, fiscalYearStartMonth: number): { start: PlainDate; end: PlainDate } {
  const startYear = today.month >= fiscalYearStartMonth ? today.year : today.year - 1;
  const start = { year: startYear, month: fiscalYearStartMonth, day: 1 };
  const nextStart = addMonths(start, 12);
  return { start, end: addDays(nextStart, -1) };
}

function fiscalQuarterRange(today: PlainDate, fiscalYearStartMonth: number): { quarter: number; start: PlainDate; end: PlainDate } {
  const fiscalMonthOffset = (today.month - fiscalYearStartMonth + 12) % 12;
  const quarter = Math.floor(fiscalMonthOffset / 3) + 1;
  const fiscalYearStart = fiscalYearRange(today, fiscalYearStartMonth).start;
  const start = addMonths(fiscalYearStart, (quarter - 1) * 3);
  const nextStart = addMonths(start, 3);
  return { quarter, start, end: addDays(nextStart, -1) };
}

function fiscalYearLabel(startYear: number, endYear: number, naming: 'startYear' | 'endYear'): string {
  if (startYear === endYear) {
    return `FY${startYear}`;
  }
  return naming === 'endYear' ? `FY${endYear}` : `FY${startYear}-${endYear}`;
}

function formatRange(range: { start: PlainDate; end: PlainDate }): JsonObject {
  return {
    start: formatDate(range.start),
    end: formatDate(range.end),
  };
}

function addDays(date: PlainDate, days: number): PlainDate {
  const value = new Date(Date.UTC(date.year, date.month - 1, date.day + days, 12, 0, 0));
  return {
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: value.getUTCDate(),
  };
}

function addMonths(date: PlainDate, months: number): PlainDate {
  const value = new Date(Date.UTC(date.year, date.month - 1 + months, 1, 12, 0, 0));
  return {
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: Math.min(date.day, daysInMonth(value.getUTCFullYear(), value.getUTCMonth() + 1)),
  };
}

function weekdayIndex(date: PlainDate): number {
  const day = new Date(Date.UTC(date.year, date.month - 1, date.day, 12, 0, 0)).getUTCDay();
  return day === 0 ? 6 : day - 1;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0, 12, 0, 0)).getUTCDate();
}

function formatDate(date: PlainDate): string {
  return `${date.year.toString().padStart(4, '0')}-${date.month.toString().padStart(2, '0')}-${date.day.toString().padStart(2, '0')}`;
}

function inferWeekStart(locale: string): WeekdayName {
  const weekInfo = (new Intl.Locale(locale) as Intl.Locale & { weekInfo?: { firstDay: number } }).weekInfo;
  if (!weekInfo) {
    return 'monday';
  }
  const firstDay = weekInfo.firstDay;
  if (firstDay === 7) {
    return 'sunday';
  }
  return WEEKDAYS[firstDay - 1] ?? 'monday';
}

function defaultTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function defaultLocale(): string {
  return Intl.DateTimeFormat().resolvedOptions().locale || 'en-US';
}
