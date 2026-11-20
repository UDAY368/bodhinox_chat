'use client';

import { useEffect, useState } from 'react';
import { authFetch } from '@/lib/auth/client';
import { formatMoney, type MoneyFormatOptions } from '@/lib/format/money';
import type { CampaignSales } from '@/lib/broadcasts/attribution';

/**
 * The orders and revenue each listed campaign brought in (GET /api/broadcasts/sales, one request
 * for the whole page; the rule is in src/lib/broadcasts/attribution.ts). Re-read only when the set of
 * campaigns changes, never on the sending poll. Missing while loading or when the read failed.
 */
export function useCampaignSales(ids: readonly string[]): Record<string, CampaignSales> {
  const key = [...ids].sort().join(',');
  const [sales, setSales] = useState<Record<string, CampaignSales>>({});
  useEffect(() => {
    if (!key) return;
    let live = true;
    authFetch(`/api/broadcasts/sales?ids=${encodeURIComponent(key)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => { if (live && body?.sales) setSales(body.sales); })
      .catch(() => {});
    return () => { live = false; };
  }, [key]);
  return sales;
}

/** Revenue as text: one amount per currency, never added across currencies ("₹1,200.00 + $9.99"); "–" with none. */
export function revenueText(sales: CampaignSales | undefined, options?: MoneyFormatOptions): string {
  if (!sales?.revenue.length) return '–';
  return sales.revenue.map((r) => formatMoney(r.minor, r.currency, options)).join(' + ');
}
