// ============================================================
// Entitlements: what a workspace's plan allows. One server-side
// source of truth, called by API handlers before the action:
//   requireFeature(tx, accountId, 'api_campaigns')
//   requireWithinLimit(tx, accountId, 'segments', currentCount + 1)
// A workspace without a subscription is on 'enterprise' (unrestricted),
// so plans change nothing until billing assigns a smaller one; a
// cancelled subscription falls back to 'free'.
// ============================================================

import { AuthError } from '@/lib/auth/errors';
import type { TenantTransaction } from '@/lib/db/tenant';
import { FEATURES, LIMITS, type Feature, type LimitKey } from './entitlements-catalogue';

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
  const rows = await tx.$queryRaw<{ id: string; name: string; features: Record<string, unknown>; limits: Record<string, unknown> }[]>`
    SELECT p.id, p.name, p.features, p.limits FROM plans p
    WHERE p.id = COALESCE((SELECT CASE WHEN s.status='canceled' THEN 'free' ELSE s.plan_id END
      FROM account_subscriptions s WHERE s.account_id=${accountId}::uuid), ${DEFAULT_PLAN})`;
  const plan = rows[0];
  if (!plan) throw new Error('Plan catalogue is missing');
  return {
    planId: plan.id,
    planName: plan.name,
    features: Object.fromEntries(FEATURES.map((f) => [f, plan.features?.[f] === true])) as Record<Feature, boolean>,
    limits: Object.fromEntries(LIMITS.map((k) => {
      const value = plan.limits?.[k];
      return [k, typeof value === 'number' && Number.isFinite(value) ? value : null];
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
};
const LIMIT_NAMES: Record<LimitKey, string> = {
  seats: 'team members',
  segments: 'saved segments',
  lists: 'lists',
  campaign_recipients: 'recipients per campaign',
  active_flows: 'active flows',
  active_automations: 'active automations',
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
