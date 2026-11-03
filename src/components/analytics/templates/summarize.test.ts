import { describe, expect, it } from 'vitest';
import { rateSeries, ratio, summarizeTemplateRows, templateRates, TEMPLATE_TOTALS_LIMIT } from './summarize';

const row = (day: string, templateName: string, sent: number, extra: Partial<Record<string, number>> = {}) => ({
  day, templateName, sent, delivered: 0, read: 0, replied: 0, clicked: 0, failed: 0, ...extra,
});

describe('summarizeTemplateRows', () => {
  it('zero-fills buckets and sums across templates', () => {
    const out = summarizeTemplateRows(
      [row('2026-11-01', 'promo', 10, { delivered: 8, read: 5 }), row('2026-11-01', 'otp', 2, { failed: 1 }), row('2026-11-03', 'promo', 4)],
      ['2026-11-01', '2026-11-02', '2026-11-03'],
    );
    expect(out.series.map((p) => [p.day, p.sent])).toEqual([['2026-11-01', 12], ['2026-11-02', 0], ['2026-11-03', 4]]);
    expect(out.totals).toEqual({ sent: 16, delivered: 8, read: 5, replied: 0, clicked: 0, failed: 1 });
    expect(out.templates.map((t) => [t.templateName, t.sent])).toEqual([['promo', 14], ['otp', 2]]);
  });

  it('keeps totals consistent with the per-template list when a row falls outside the keys', () => {
    const out = summarizeTemplateRows([row('2026-10-27', 'promo', 3)], ['2026-11-03']);
    expect(out.totals.sent).toBe(3);
    expect(out.series).toEqual([{ day: '2026-11-03', sent: 0, delivered: 0, read: 0, replied: 0, clicked: 0, failed: 0 }]);
    expect(out.templates[0].sent).toBe(3);
  });

  it('caps the per-template list', () => {
    const rows = Array.from({ length: TEMPLATE_TOTALS_LIMIT + 5 }, (_, i) => row('2026-11-01', `t${i}`, i + 1));
    const out = summarizeTemplateRows(rows, ['2026-11-01']);
    expect(out.templates).toHaveLength(TEMPLATE_TOTALS_LIMIT);
    expect(out.templates[0].templateName).toBe(`t${TEMPLATE_TOTALS_LIMIT + 4}`);
  });
});

describe('rates', () => {
  it('is null when nothing was sent', () => {
    expect(ratio(1, 0)).toBeNull();
    expect(templateRates({ sent: 0, delivered: 0, read: 0, replied: 0, clicked: 0, failed: 0 }).read).toBeNull();
    expect(templateRates({ sent: 4, delivered: 3, read: 2, replied: 1, clicked: 0, failed: 1 })).toEqual({
      delivered: 0.75, read: 0.5, replied: 0.25, clicked: 0, failed: 0.25,
    });
  });

  it('turns each bucket into percentages of its own sends', () => {
    expect(rateSeries([
      { day: 'a', sent: 3, delivered: 2, read: 1, replied: 0, clicked: 0, failed: 1 },
      { day: 'b', sent: 0, delivered: 0, read: 0, replied: 0, clicked: 0, failed: 0 },
    ])).toEqual([
      { day: 'a', delivered: 66.7, read: 33.3, replied: 0, clicked: 0, failed: 33.3 },
      { day: 'b', delivered: 0, read: 0, replied: 0, clicked: 0, failed: 0 },
    ]);
  });
});
