// ============================================================
// Entitlements: what a workspace's plan allows. One server-side
// source of truth, called by API handlers before the action:
//   requireFeature(tx, accountId, 'api_campaigns')
//   requireWithinLimit(tx, accountId, 'segments', currentCount + 1)
// A workspace without a subscription is on 'enterprise' (unrestricted),
// so plans change nothing until billing assigns a smaller one; a
// suspended, cancelled or incomplete subscription falls back to 'free'.
// Active add-ons raise the limit they apply to (a null limit stays unlimited).
// ============================================================

import { AuthError } from '@/lib/auth/errors';
import type { TenantTransaction } from '@/lib/db/tenant';
import { ADDON_LIMIT, FEATURES, LIMITS, type AddonKind, type Feature, type LimitKey } from './entitlements-catalogue';

export { FEATURES, LIMITS, type Feature, type LimitKey };

export const DEFAULT_PLAN = 'enterprise';

export interface Entitlements {
  planId: string;
  planName: string;
  features: Record<Feature, boolean>;
  /** null = unlimited. */
  limits: Record<LimitKey, number | null>;
}

/** The plan that would unlock a feature or raise a limit, for upgrade messages. */
export class PlanLimitError extends AuthError {
  constructor(message: string) {
    super(message, 402, 'plan_limit');
  }
}

export async function getEntitlements(tx: TenantTransaction, accountId: string): Promise<Entitlements> {
  // addons: per-kind totals of this workspace's active add-ons (the rows themselves are admin-only).
  const rows = await tx.$queryRaw<{ id: string; name: string; features: Record<string, unknown>; limits: Record<string, unknown>; addons?: Record<string, unknown> }[]>`
    SELECT p.id, p.name, p.features, p.limits,
      (SELECT COALESCE(jsonb_object_agg(a.kind, a.quantity), '{}'::jsonb) FROM billing_addon_totals() a) AS addons
    FROM plans p
    WHERE p.id = COALESCE((SELECT CASE WHEN s.status IN ('suspended','cancelled','incomplete') THEN 'free' ELSE s.plan_id END
      FROM account_subscriptions s WHERE s.account_id=${accountId}::uuid), ${DEFAULT_PLAN})`;
  const plan = rows[0];
  if (!plan) throw new Error('Plan catalogue is missing');
  const extra: Partial<Record<LimitKey, number>> = {};
  for (const [kind, quantity] of Object.entries(plan.addons ?? {})) {
    const key = ADDON_LIMIT[kind as AddonKind];
    if (key && typeof quantity === 'number' && Number.isSafeInteger(quantity)) extra[key] = (extra[key] ?? 0) + quantity;
  }
  return {
    planId: plan.id,
    planName: plan.name,
    features: Object.fromEntries(FEATURES.map((f) => [f, plan.features?.[f] === true])) as Record<Feature, boolean>,
    limits: Object.fromEntries(LIMITS.map((k) => {
      const value = plan.limits?.[k];
      return [k, typeof value === 'number' && Number.isFinite(value) ? value + (extra[k] ?? 0) : null];
    })) as Record<LimitKey, number | null>,
  };
}

const FEATURE_NAMES: Record<Feature, string> = {
  campaign_scheduling: 'Scheduled campaigns',
  contact_export: 'Contact export',
  api_campaigns: 'API campaigns',
  click_tracking: 'Click tracking',
  retargeting: 'Retargeting by campaign',
  workspace_attributes: 'Workspace attributes',
  appointments: 'Appointments',
  storefront: 'Storefront and online payments',
  online_meetings: 'Online meetings (Zoom)',
  courier_shipping: 'Courier shipping (Shiprocket)',
  instagram: 'Instagram messaging',
};
const LIMIT_NAMES: Record<LimitKey, string> = {
  seats: 'team members',
  segments: 'saved segments',
  lists: 'lists',
  campaign_recipients: 'recipients per campaign',
  active_flows: 'active flows',
  active_automations: 'active automations',
  ai_messages: 'AI replies this month',
  monthly_active_contacts: 'active contacts this month',
  storage_bytes: 'bytes of media storage',
  whatsapp_numbers: 'WhatsApp numbers',
  appointment_staff: 'practitioners',
  instagram_accounts: 'Instagram accounts',
};

export async function requireFeature(tx: TenantTransaction, accountId: string, feature: Feature): Promise<void> {
  const e = await getEntitlements(tx, accountId);
  if (!e.features[feature]) throw new PlanLimitError(`${FEATURE_NAMES[feature]} are not included in the ${e.planName} plan. Upgrade to use them.`);
}

/**
 * Count-then-create under a transaction lock, so two simultaneous creates
 * cannot both pass a limit check: `count()` runs only after the lock.
 */
export async function requireRoomFor(tx: TenantTransaction, accountId: string, key: LimitKey, count: () => Promise<number>): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${accountId}:${key}`}))`;
  await requireWithinLimit(tx, accountId, key, (await count()) + 1);
}

/** Throws when `wanted` (the count after the action) would exceed the plan's limit. */
export async function requireWithinLimit(tx: TenantTransaction, accountId: string, key: LimitKey, wanted: number): Promise<void> {
  const e = await getEntitlements(tx, accountId);
  const limit = e.limits[key];
  if (limit !== null && wanted > limit)
    throw new PlanLimitError(`The ${e.planName} plan allows up to ${limit.toLocaleString('en')} ${LIMIT_NAMES[key]}. Upgrade for more.`);
}

/**
 * Before this workspace adds ANOTHER WhatsApp number (a new whatsapp_config
 * row): connected numbers and ones mid-setup count; a number an admin removed
 * (disconnected, token cleared) frees its slot. Reconnecting or updating a row
 * the workspace already has never calls this, so existing numbers are never
 * blocked. Serialised per workspace for the rest of the transaction.
 */
export async function requireWhatsAppNumberRoom(tx: TenantTransaction, accountId: string): Promise<void> {
  await requireRoomFor(tx, accountId, 'whatsapp_numbers', async () => {
    const [row] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM whatsapp_config
      WHERE account_id=${accountId}::uuid AND NOT (status='disconnected' AND access_token='')`;
    return row?.n ?? 0;
  });
}
