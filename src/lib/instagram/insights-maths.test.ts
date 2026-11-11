// Stage 5 (5F) Instagram home and Insights maths without a database: the
// time-saved estimate, the next-moves list, the contact series and revenue
// aggregation. The SQL (timezone bucketing, tenancy) is covered by
// insights-stage5.integration.test.ts.
import { describe, expect, it } from 'vitest';
import { parseRange } from '@/lib/analytics/range';
import { buildContactSeries, rangeDays } from './contact-series';
import { estimateTimeSaved, NEXT_MOVES, nextMovesFrom, SECONDS_SAVED_PER_MESSAGE } from './home-summary';
import { summariseRevenue, type RevenueRow } from './revenue';

describe('time saved estimate', () => {
  it('counts 30 seconds per automated message, in whole hours and minutes', () => {
    expect(SECONDS_SAVED_PER_MESSAGE).toBe(30);
    expect(estimateTimeSaved(0)).toEqual({ seconds: 0, hours: 0, minutes: 0 });
    expect(estimateTimeSaved(1)).toEqual({ seconds: 30, hours: 0, minutes: 0 });
    expect(estimateTimeSaved(2)).toEqual({ seconds: 60, hours: 0, minutes: 1 });
    expect(estimateTimeSaved(130)).toEqual({ seconds: 3900, hours: 1, minutes: 5 });
  });

  it('never goes negative and ignores fractions', () => {
    expect(estimateTimeSaved(-4).seconds).toBe(0);
    expect(estimateTimeSaved(2.9).seconds).toBe(60);
  });
});

describe('next moves', () => {
  it('lists every move in order with its page, ticked from state', () => {
    const moves = nextMovesFrom({ conversationStarters: true, menu: false, defaultReply: true, refLink: false, aiComments: false, leadCapture: true });
    expect(moves.map((m) => m.key)).toEqual([...NEXT_MOVES]);
    expect(moves.filter((m) => m.done).map((m) => m.key)).toEqual(['conversationStarters', 'defaultReply', 'leadCapture']);
    expect(moves.every((m) => m.href.startsWith('/instagram/'))).toBe(true);
  });
});

describe('contact series', () => {
  it('lists every local day of the range', () => {
    const range = parseRange({ from: '2026-10-30', to: '2026-11-02' }, 'Asia/Kolkata', new Date('2026-11-10T00:00:00Z'));
    expect(rangeDays(range)).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
  });

  it('accumulates totals, zero-fills quiet days and splits active from inactive', () => {
    const days = ['2026-11-01', '2026-11-02', '2026-11-03'];
    const series = buildContactSeries(days, 10, new Map([['2026-11-02', 3]]), new Map([['2026-11-01', 4], ['2026-11-03', 2]]));
    expect(series).toEqual([
      { day: '2026-11-01', active: 4, inactive: 6, total: 10 },
      { day: '2026-11-02', active: 0, inactive: 13, total: 13 },
      { day: '2026-11-03', active: 2, inactive: 11, total: 13 },
    ]);
  });

  it('never shows more active contacts than exist, or negative counts', () => {
    const series = buildContactSeries(['d1'], -2, new Map([['d1', 1]]), new Map([['d1', 5], ['other', 9]]));
    expect(series).toEqual([{ day: 'd1', active: 1, inactive: 0, total: 1 }]);
  });
});

describe('revenue aggregation', () => {
  const row = (over: Partial<RevenueRow>): RevenueRow => ({
    currency: 'INR', day: '2026-11-01', flow_id: 'f1', flow_name: 'Reel shop', contact_id: 'c1', amount_minor: 1000, ...over,
  });
  const days = ['2026-11-01', '2026-11-02'];

  it('sums earnings, sales, buyers and averages per currency', () => {
    const [inr] = summariseRevenue([
      row({}),
      row({ contact_id: 'c1', amount_minor: 3000, day: '2026-11-02' }),
      row({ contact_id: 'c2', amount_minor: 2000, flow_id: 'f2', flow_name: 'Live offer' }),
    ], days, 12);
    expect(inr).toMatchObject({ currency: 'INR', earned: 6000, sales: 3, buyers: 2, perBuyer: 3000, perContact: 500 });
    expect(inr.series).toEqual([{ day: '2026-11-01', earned: 3000 }, { day: '2026-11-02', earned: 3000 }]);
    expect(inr.byFlow).toEqual([
      { id: 'f1', name: 'Reel shop', earned: 4000, sales: 2 },
      { id: 'f2', name: 'Live offer', earned: 2000, sales: 1 },
    ]);
  });

  it('keeps currencies apart, most earned first, and has no averages without a base', () => {
    const result = summariseRevenue([row({ currency: 'USD', amount_minor: 500, contact_id: null }), row({ amount_minor: 9000 })], days, 0);
    expect(result.map((c) => c.currency)).toEqual(['INR', 'USD']);
    expect(result[1]).toMatchObject({ earned: 500, buyers: 0, perBuyer: null, perContact: null });
  });

  it('is empty with no paid rows, and ignores non-positive amounts', () => {
    expect(summariseRevenue([], days, 5)).toEqual([]);
    expect(summariseRevenue([row({ amount_minor: 0 })], days, 5)).toEqual([]);
  });
});
