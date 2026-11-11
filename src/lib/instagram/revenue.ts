// Instagram › Insights › Revenue (Stage 5, 5F): money earned through
// automations, from paid payment links that a flow run created
// (payment_links.flow_run_id) in an Instagram conversation, by paid_at.
//
//   earned        sum of amount_minor
//   sales         paid links
//   buyers        distinct contacts who paid
//   perBuyer      earned / buyers
//   perContact    earned / Instagram contacts (the total at the end of the range)
//   series        earned per local day of the workspace timezone
//   byFlow        earned and sales per flow
//
// Amounts are kept per currency (a workspace may sell in more than one); the
// page shows the currency with the most earned first. Payment links are visible
// to agents and above (RLS), so `visible` is false for a viewer and the page
// says so instead of showing zeros. Amounts and ids only: no customer data.
import { Prisma } from '@prisma/client';
import type { TenantTransaction } from '@/lib/db/tenant';
import type { AnalyticsRange } from '@/lib/analytics/range';
import { rangeDays } from './contact-series';

export interface RevenueRow {
  currency: string;
  day: string;
  flow_id: string | null;
  flow_name: string | null;
  contact_id: string | null;
  amount_minor: number;
}

export interface CurrencyRevenue {
  currency: string;
  earned: number;
  sales: number;
  buyers: number;
  /** Rounded to whole minor units; null without buyers / contacts. */
  perBuyer: number | null;
  perContact: number | null;
  series: Array<{ day: string; earned: number }>;
  byFlow: Array<{ id: string | null; name: string | null; earned: number; sales: number }>;
}

export interface InstagramRevenue {
  visible: boolean;
  currencies: CurrencyRevenue[];
}

/** Aggregates paid rows per currency (most earned first); `contacts` is the Instagram contact total. */
export function summariseRevenue(rows: readonly RevenueRow[], days: readonly string[], contacts: number): CurrencyRevenue[] {
  const byCurrency = new Map<string, RevenueRow[]>();
  for (const row of rows) {
    if (!(row.amount_minor > 0)) continue;
    const list = byCurrency.get(row.currency);
    if (list) list.push(row);
    else byCurrency.set(row.currency, [row]);
  }
  const result = [...byCurrency.entries()].map(([currency, list]): CurrencyRevenue => {
    const earned = list.reduce((sum, row) => sum + row.amount_minor, 0);
    const buyers = new Set(list.map((row) => row.contact_id).filter((id): id is string => !!id)).size;
    const perDay = new Map<string, number>();
    const flows = new Map<string, { id: string | null; name: string | null; earned: number; sales: number }>();
    for (const row of list) {
      perDay.set(row.day, (perDay.get(row.day) ?? 0) + row.amount_minor);
      const key = row.flow_id ?? '';
      const flow = flows.get(key) ?? { id: row.flow_id, name: row.flow_name, earned: 0, sales: 0 };
      flow.earned += row.amount_minor;
      flow.sales += 1;
      flows.set(key, flow);
    }
    return {
      currency,
      earned,
      sales: list.length,
      buyers,
      perBuyer: buyers > 0 ? Math.round(earned / buyers) : null,
      perContact: contacts > 0 ? Math.round(earned / contacts) : null,
      series: days.map((day) => ({ day, earned: perDay.get(day) ?? 0 })),
      byFlow: [...flows.values()].sort((a, b) => b.earned - a.earned || b.sales - a.sales).slice(0, 50),
    };
  });
  return result.sort((a, b) => b.earned - a.earned || a.currency.localeCompare(b.currency));
}

/** Revenue in a range; `contacts` is the Instagram contact total at the end of the range. */
export async function instagramRevenue(tx: TenantTransaction, accountId: string, range: AnalyticsRange,
  contacts: number): Promise<InstagramRevenue> {
  // Payment links are agent-and-above under RLS: ask the database, which applies the same rule.
  const [{ visible }] = await tx.$queryRaw<{ visible: boolean }[]>`SELECT app_write_allowed('agent') AS visible`;
  if (!visible) return { visible: false, currencies: [] };
  const rows = await tx.$queryRaw<Array<Omit<RevenueRow, 'amount_minor'> & { amount_minor: bigint | number }>>(Prisma.sql`
    SELECT p.currency, to_char((p.paid_at AT TIME ZONE ${range.timezone})::date, 'YYYY-MM-DD') AS day,
      r.flow_id::text AS flow_id, f.name AS flow_name, p.contact_id::text AS contact_id, p.amount_minor
    FROM payment_links p
    JOIN flow_runs r ON r.account_id=p.account_id AND r.id=p.flow_run_id
    JOIN conversations c ON c.account_id=p.account_id AND c.id=COALESCE(p.conversation_id, r.conversation_id)
    LEFT JOIN flows f ON f.account_id=r.account_id AND f.id=r.flow_id
    WHERE p.account_id=${accountId}::uuid AND p.status='paid' AND p.flow_run_id IS NOT NULL AND c.channel='instagram'
      AND p.paid_at >= ${range.from.toISOString()}::timestamptz AND p.paid_at < ${range.to.toISOString()}::timestamptz
    LIMIT 50000`);
  return {
    visible: true,
    currencies: summariseRevenue(rows.map((row) => ({ ...row, amount_minor: Number(row.amount_minor) })), rangeDays(range), contacts),
  };
}
