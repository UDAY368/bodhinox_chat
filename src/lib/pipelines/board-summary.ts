// Pure helpers over the board's SQL aggregate (OverviewRow: status x stage x currency),
// for the summary cards and "More stats". Every value stays per currency: amounts in
// different currencies are shown side by side, never added together.
import type { CurrencyTotal, OverviewRow } from './board';

type Stage = { id: string; position: number };

/** Rows -> one total per currency (sorted by currency code), with deal counts. */
export function totalsByCurrency(rows: Pick<OverviewRow, 'currency' | 'count' | 'total'>[]): CurrencyTotal[] {
  const map = new Map<string, CurrencyTotal>();
  for (const r of rows) {
    const t = map.get(r.currency) ?? { currency: r.currency, count: 0, total: 0 };
    t.count += r.count;
    t.total += Number(r.total) || 0;
    map.set(r.currency, t);
  }
  return [...map.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

const count = (rows: OverviewRow[]) => rows.reduce((n, r) => n + r.count, 0);

/** The three summary cards: open value, won value and the win rate of closed deals. */
export function summarizeOverview(rows: OverviewRow[]) {
  const open = rows.filter((r) => r.status === 'open');
  const won = rows.filter((r) => r.status === 'won');
  const lost = rows.filter((r) => r.status === 'lost');
  const wonCount = count(won), lostCount = count(lost);
  return {
    open: totalsByCurrency(open), openCount: count(open),
    won: totalsByCurrency(won), wonCount, lostCount,
    winRate: wonCount + lostCount > 0 ? Math.round((wonCount / (wonCount + lostCount)) * 100) : null,
  };
}

/**
 * Likelihood of an open deal closing by stage position: the first stage ≈ 10%, rising
 * to 90% before the last stage, the last stage 100%.
 */
export function stageProbability(stageId: string, sortedStages: Stage[]): number {
  const n = sortedStages.length;
  if (n <= 1) return 1;
  const index = sortedStages.findIndex((s) => s.id === stageId);
  if (index < 0) return 0;
  if (index === n - 1) return 1;
  const slots = n - 1;
  if (slots <= 1) return 0.1;
  return 0.1 + (index / (slots - 1)) * 0.8;
}

/** "More stats": counts, value and average of active (open + won) deals, weighted open value, closed this month. */
export function analyzeOverview(rows: OverviewRow[], stages: Stage[]) {
  const sorted = [...stages].sort((a, b) => a.position - b.position);
  const active = rows.filter((r) => r.status !== 'lost');
  const value = totalsByCurrency(active);
  const weighted = totalsByCurrency(rows.filter((r) => r.status === 'open')
    .map((r) => ({ ...r, total: Number(r.total) * stageProbability(r.stage_id, sorted) })));
  const thisMonth = (status: OverviewRow['status']) => rows.filter((r) => r.status === status).reduce((n, r) => n + r.this_month, 0);
  return {
    totalCount: count(active),
    value,
    average: value.map((t) => ({ ...t, total: t.count > 0 ? t.total / t.count : 0 })),
    weighted,
    wonThisMonth: thisMonth('won'),
    lostThisMonth: thisMonth('lost'),
  };
}
