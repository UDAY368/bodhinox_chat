// Shapes the template report for the browser: zero-filled buckets, totals and
// per-template totals from templateDaily rows. Shared by the route (which
// builds it) and the view (which reads it). Counts only, never message text.

export interface TemplateCounts {
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  clicked: number;
  failed: number;
}

export interface TemplateSeriesPoint extends TemplateCounts {
  /** Local day, or the Monday of the ISO week when bucket is 'week'. */
  day: string;
}

export interface TemplateTotalsRow extends TemplateCounts {
  templateName: string;
}

export interface TemplateInfo {
  id: string;
  name: string;
  language: string | null;
  category: string | null;
  status: string | null;
  quality_score: string | null;
}

export interface TemplateAnalyticsResponse {
  range: { preset: string; startDay: string; endDay: string; days: number; bucket: 'day' | 'week'; timezone: string };
  /** The template asked for by id, or null for the whole workspace. */
  template: TemplateInfo | null;
  totals: TemplateCounts;
  series: TemplateSeriesPoint[];
  /** Per template name, most sent first (empty when one template was asked for). */
  templates: TemplateTotalsRow[];
}

/** At most this many templates are listed in the workspace view. */
export const TEMPLATE_TOTALS_LIMIT = 200;

const KEYS = ['sent', 'delivered', 'read', 'replied', 'clicked', 'failed'] as const;

export const emptyCounts = (): TemplateCounts => ({ sent: 0, delivered: 0, read: 0, replied: 0, clicked: 0, failed: 0 });

function add(into: TemplateCounts, row: TemplateCounts): void {
  for (const key of KEYS) into[key] += Number(row[key]) || 0;
}

/**
 * Sums rows per bucket (over every template), zero-filling `bucketKeys`, and
 * per template name. Rows whose day is outside the keys still count toward
 * the totals, so totals never disagree with the per-template list.
 */
export function summarizeTemplateRows(
  rows: readonly (TemplateCounts & { day: string; templateName: string })[],
  bucketKeys: readonly string[],
): Pick<TemplateAnalyticsResponse, 'totals' | 'series' | 'templates'> {
  const byDay = new Map<string, TemplateSeriesPoint>(bucketKeys.map((day) => [day, { day, ...emptyCounts() }]));
  const byName = new Map<string, TemplateTotalsRow>();
  const totals = emptyCounts();
  for (const row of rows) {
    add(totals, row);
    const point = byDay.get(row.day);
    if (point) add(point, row);
    let named = byName.get(row.templateName);
    if (!named) byName.set(row.templateName, (named = { templateName: row.templateName, ...emptyCounts() }));
    add(named, row);
  }
  const templates = [...byName.values()]
    .sort((a, b) => b.sent - a.sent || a.templateName.localeCompare(b.templateName))
    .slice(0, TEMPLATE_TOTALS_LIMIT);
  return { totals, series: [...byDay.values()], templates };
}

/** part / whole as a 0–1 ratio; null when nothing was sent. */
export function ratio(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

export const RATE_KEYS = ['delivered', 'read', 'replied', 'clicked', 'failed'] as const;
export type RateKey = (typeof RATE_KEYS)[number];

/** Each bucket's rates as percentages of that bucket's sends (0 when nothing was sent). */
export function rateSeries(series: readonly TemplateSeriesPoint[]): ({ day: string } & Record<RateKey, number>)[] {
  return series.map((p) => {
    const row = { day: p.day } as { day: string } & Record<RateKey, number>;
    for (const key of RATE_KEYS) row[key] = p.sent > 0 ? Math.round((p[key] / p.sent) * 1000) / 10 : 0;
    return row;
  });
}

/** Delivered, read, replied, clicked and failed as shares of sent. */
export function templateRates(c: TemplateCounts) {
  return {
    delivered: ratio(c.delivered, c.sent),
    read: ratio(c.read, c.sent),
    replied: ratio(c.replied, c.sent),
    clicked: ratio(c.clicked, c.sent),
    failed: ratio(c.failed, c.sent),
  };
}
