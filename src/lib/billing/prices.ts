// Platform plan prices (plan_prices): what each plan costs per interval and the
// provider plan it maps to. Not tenant data.
//
// How prices are configured:
//   1. Create the plans in the Razorpay dashboard (platform account), one per
//      plan and interval, amounts in paise INCLUDING GST (the charged amount
//      is the invoice total; invoices.ts splits the GST out of it). To change
//      a price, create a new Razorpay plan and PUT its id: the old row is kept
//      (inactive) so existing subscriptions on it still map to the plan.
//   2. Either set BILLING_PLAN_PRICES to a JSON array, e.g.
//        [{"plan":"basic","interval":"month","amount_minor":99900,"provider_plan_id":"plan_ABC"},
//         {"plan":"pro","interval":"year","amount_minor":2999900,"provider_plan_id":"plan_DEF"}]
//      and have a platform admin call PUT /api/billing/admin/prices {"source":"env"},
//      or PUT one price at a time: {"plan","interval","amount_minor","provider_plan_id","active"?}.
//   Platform admins are the verified emails listed in PLATFORM_ADMIN_EMAILS
//   (comma separated). Writes go through the worker role; the app role and the
//   browser can only read active prices.

import type { Prisma } from '@prisma/client';
import { getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import type { BillingInterval } from './provider';

export interface PlanPrice {
  plan: string;
  interval: BillingInterval;
  currency: string;
  amountMinor: number;
}

export interface PlanPriceInput extends PlanPrice {
  provider: 'razorpay';
  providerPlanId: string;
  active: boolean;
}

export class PriceInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PriceInputError';
  }
}

type Env = Record<string, string | undefined>;

export function platformAdminEmails(env: Env = process.env): Set<string> {
  return new Set((env.PLATFORM_ADMIN_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter((e) => e.includes('@')));
}

/** Whether a (session-verified) email is a platform admin. False when the list is empty. */
export function isPlatformAdmin(email: string | null | undefined, env: Env = process.env): boolean {
  return typeof email === 'string' && platformAdminEmails(env).has(email.trim().toLowerCase());
}

/** Validates one price from a request body or the env seed. Throws PriceInputError. */
export function parsePlanPrice(raw: unknown): PlanPriceInput {
  const r = (raw ?? {}) as Record<string, unknown>;
  const plan = r.plan, interval = r.interval, amount = r.amount_minor, planId = r.provider_plan_id;
  const currency = r.currency ?? 'INR', provider = r.provider ?? 'razorpay', active = r.active ?? true;
  if (typeof plan !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(plan)) throw new PriceInputError('Invalid plan');
  if (interval !== 'month' && interval !== 'year') throw new PriceInputError('Invalid interval');
  if (currency !== 'INR') throw new PriceInputError('Only INR prices are supported');
  if (provider !== 'razorpay') throw new PriceInputError('Unsupported provider');
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) throw new PriceInputError('Invalid amount');
  if (typeof planId !== 'string' || !/^plan_[A-Za-z0-9]{1,40}$/.test(planId)) throw new PriceInputError('Invalid provider plan id');
  if (typeof active !== 'boolean') throw new PriceInputError('Invalid active flag');
  return { plan, interval, currency, amountMinor: amount, provider, providerPlanId: planId, active };
}

/** BILLING_PLAN_PRICES parsed and validated; [] when unset. Throws PriceInputError on bad JSON or entries. */
export function pricesFromEnv(env: Env = process.env): PlanPriceInput[] {
  const raw = env.BILLING_PLAN_PRICES?.trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PriceInputError('BILLING_PLAN_PRICES is not valid JSON');
  }
  if (!Array.isArray(parsed) || parsed.length > 50) throw new PriceInputError('BILLING_PLAN_PRICES must be an array');
  return parsed.map(parsePlanPrice);
}

/** Active prices for the pricing page and checkout (any signed-in user). */
export async function listPlanPrices(db: Prisma.TransactionClient | ReturnType<typeof getPrisma> = getPrisma()): Promise<PlanPrice[]> {
  const rows = await db.$queryRaw<{ plan: string; interval: BillingInterval; currency: string; amount_minor: bigint }[]>`
    SELECT pp.plan, pp."interval", pp.currency, pp.amount_minor FROM plan_prices pp JOIN plans p ON p.id = pp.plan
    WHERE pp.active ORDER BY p.sort, pp."interval"`;
  return rows.map((r) => ({ plan: r.plan, interval: r.interval, currency: r.currency, amountMinor: Number(r.amount_minor) }));
}

/** The provider plan for a plan + interval, for creating a subscription (server only). */
export async function providerPlanFor(plan: string, interval: BillingInterval): Promise<{ providerPlanId: string; amountMinor: number } | null> {
  const rows = await getWorkerPrisma().$queryRaw<{ provider_plan_id: string; amount_minor: bigint }[]>`
    SELECT provider_plan_id, amount_minor FROM plan_prices
    WHERE plan=${plan} AND "interval"=${interval} AND currency='INR' AND provider='razorpay' AND active`;
  return rows[0] ? { providerPlanId: rows[0].provider_plan_id, amountMinor: Number(rows[0].amount_minor) } : null;
}

/**
 * Inserts or updates prices (worker role). Call only after isPlatformAdmin or
 * from deploy tooling. Rows are never overwritten with another provider plan:
 * a new provider plan for a plan + interval deactivates the active row and adds
 * one, so subscriptions on the old provider plan keep mapping to our plan. The
 * same provider plan updates its own row. A provider plan already used for a
 * different plan or interval is refused.
 */
export async function upsertPlanPrices(prices: PlanPriceInput[]): Promise<number> {
  const db = getWorkerPrisma();
  await db.$transaction(async (tx) => {
    const known = new Set((await tx.$queryRaw<{ id: string }[]>`SELECT id FROM plans`).map((r) => r.id));
    const missing = prices.find((p) => !known.has(p.plan));
    if (missing) throw new PriceInputError('Unknown plan');
    for (const p of prices) {
      // One active row per plan + interval: retire the current one when another provider plan takes over.
      if (p.active)
        await tx.$executeRaw`
          UPDATE plan_prices SET active = false
          WHERE plan=${p.plan} AND "interval"=${p.interval} AND currency=${p.currency} AND provider=${p.provider}
            AND active AND provider_plan_id <> ${p.providerPlanId}`;
      const saved = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO plan_prices (plan, "interval", currency, amount_minor, provider, provider_plan_id, active)
        VALUES (${p.plan}, ${p.interval}, ${p.currency}, ${p.amountMinor}, ${p.provider}, ${p.providerPlanId}, ${p.active})
        ON CONFLICT (provider, provider_plan_id) DO UPDATE
          SET amount_minor = EXCLUDED.amount_minor, active = EXCLUDED.active
          WHERE plan_prices.plan = EXCLUDED.plan AND plan_prices."interval" = EXCLUDED."interval" AND plan_prices.currency = EXCLUDED.currency
        RETURNING id`;
      if (!saved[0]) throw new PriceInputError('Provider plan id is already used for another plan or interval');
    }
  });
  return prices.length;
}
