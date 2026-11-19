import { describe, expect, it } from 'vitest';
import type { OverviewRow } from './board';
import { analyzeOverview, summarizeOverview, totalsByCurrency } from './board-summary';

const row = (status: OverviewRow['status'], stage_id: string, currency: string, count: number, total: number, this_month = 0): OverviewRow =>
  ({ status, stage_id, currency, count, total, this_month });
const stages = [{ id: 's1', position: 0 }, { id: 's2', position: 1 }, { id: 's3', position: 2 }];

describe('board summary', () => {
  it('keeps each currency separate, never summed together', () => {
    expect(totalsByCurrency([row('open', 's1', 'USD', 2, 100), row('open', 's2', 'INR', 1, 5000), row('open', 's2', 'USD', 1, 50)]))
      .toEqual([{ currency: 'INR', count: 1, total: 5000 }, { currency: 'USD', count: 3, total: 150 }]);
  });

  it('summarizes open and won value per currency and the win rate of closed deals', () => {
    const s = summarizeOverview([row('open', 's1', 'USD', 2, 150), row('won', 's3', 'USD', 2, 500), row('won', 's3', 'EUR', 1, 20),
      row('lost', 's2', 'USD', 3, 999)]);
    expect(s.open).toEqual([{ currency: 'USD', count: 2, total: 150 }]);
    expect(s.won).toEqual([{ currency: 'EUR', count: 1, total: 20 }, { currency: 'USD', count: 2, total: 500 }]);
    expect(s).toMatchObject({ openCount: 2, wonCount: 3, lostCount: 3, winRate: 50 });
    expect(summarizeOverview([row('open', 's1', 'USD', 1, 10)]).winRate).toBeNull();
  });

  it('weights open value by stage and counts deals closed this month', () => {
    const a = analyzeOverview([row('open', 's1', 'USD', 1, 100), row('open', 's3', 'USD', 1, 100), row('won', 's3', 'USD', 1, 40, 1),
      row('lost', 's2', 'USD', 2, 10, 2)], stages);
    expect(a.weighted).toEqual([{ currency: 'USD', count: 2, total: 110 }]);
    expect(a.totalCount).toBe(3);
    expect(a.value).toEqual([{ currency: 'USD', count: 3, total: 240 }]);
    expect(a.average).toEqual([{ currency: 'USD', count: 3, total: 80 }]);
    expect(a).toMatchObject({ wonThisMonth: 1, lostThisMonth: 2 });
  });
});
