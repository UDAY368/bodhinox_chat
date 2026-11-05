// The public price list: active plan_prices (platform catalogue, not tenant data)
// grouped by plan, monthly and annual. Empty, so the page shows "Contact us", when
// platform billing is not configured or the catalogue cannot be read.

import { getPrisma } from '@/lib/db/prisma';
import { listPlanPrices } from '@/lib/billing/prices';
import { billingConfigured } from '@/lib/billing/razorpay-billing';

export interface PublicPlan {
  id: string;
  name: string;
  month: number | null;
  year: number | null;
  currency: string;
}

export async function loadPublicPlans(): Promise<PublicPlan[]> {
  if (!billingConfigured()) return [];
  try {
    const prices = await listPlanPrices();
    if (!prices.length) return [];
    const names = await getPrisma().$queryRaw<{ id: string; name: string }[]>`SELECT id, name FROM plans`;
    const nameOf = new Map(names.map((p) => [p.id, p.name]));
    const plans = new Map<string, PublicPlan>();
    for (const price of prices) {
      const plan = plans.get(price.plan) ?? { id: price.plan, name: nameOf.get(price.plan) ?? price.plan, month: null, year: null, currency: price.currency };
      if (price.interval === 'month') plan.month = price.amountMinor;
      else plan.year = price.amountMinor;
      plans.set(price.plan, plan);
    }
    return [...plans.values()];
  } catch {
    // Category only; the page falls back to "Contact us".
    console.error('[pricing] price list unavailable');
    return [];
  }
}
