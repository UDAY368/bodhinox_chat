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

/** A plan's raw terms: a pinned version's features/limits, or the live plans row. */
export interface PlanTerms {
  planId: string;
  planName: string;
  /** The plan_versions row these terms come from; null when they are the live plans row. */
  versionId: string | null;
  version: number | null;
  features: Record<string, unknown>;
  limits: Record<string, unknown>;
}

type TermsRow = { id: string; name: string; features: Record<string, unknown> | null; limits: Record<string, unknown> | null;
  version_id: string | null; version: number | null };

const toTerms = (row: TermsRow): PlanTerms => ({ planId: row.id, planName: row.name, versionId: row.version_id, version: row.version,
  features: row.features ?? {}, limits: row.limits ?? {} });

/**
 * The terms a plan is held to: the pinned version when `versionId` names a version of that plan,
 * else the live plans row. Shared by getEntitlements and the downgrade archive, so the archive is
 * evaluated against exactly the terms the gates will enforce.
 */
export async function planTerms(tx: TenantTransaction, planId: string, versionId: string | null): Promise<PlanTerms> {
  const rows = await tx.$queryRaw<TermsRow[]>`
    SELECT p.id, p.name, COALESCE(v.features, p.features) AS features, COALESCE(v.limits, p.limits) AS limits,
      v.id AS version_id, v.version
    FROM plans p LEFT JOIN plan_versions v ON v.id = ${versionId}::uuid AND v.plan_id = p.id
    WHERE p.id = ${planId}`;
  if (!rows[0]) throw new Error('Plan catalogue is missing');
  return toTerms(rows[0]);
}

/** Per-limit totals of active add-ons, keyed by the limit each raises. */
export function addonExtras(addons: Record<string, unknown> | null | undefined): Partial<Record<LimitKey, number>> {
  const extra: Partial<Record<LimitKey, number>> = {};
  for (const [kind, quantity] of Object.entries(addons ?? {})) {
    const key = ADDON_LIMIT[kind as AddonKind];
    if (key && typeof quantity === 'number' && Number.isSafeInteger(quantity)) extra[key] = (extra[key] ?? 0) + quantity;
  }
  return extra;
}

/** Features and limits from raw terms plus add-ons. A missing key or JSON null is unlimited. */
export function entitlementsFromTerms(terms: PlanTerms, addons?: Record<string, unknown> | null): Entitlements {
  const extra = addonExtras(addons);
  return {
    planId: terms.planId,
    planName: terms.planName,
    features: Object.fromEntries(FEATURES.map((f) => [f, terms.features?.[f] === true])) as Record<Feature, boolean>,
    limits: Object.fromEntries(LIMITS.map((k) => {
      const value = terms.limits?.[k];
      return [k, typeof value === 'number' && Number.isFinite(value) ? value + (extra[k] ?? 0) : null];
    })) as Record<LimitKey, number | null>,
  };
}

/**
 * No subscription row -> the live 'enterprise' row (unrestricted). A suspended, cancelled or
 * incomplete subscription -> the live 'free' row. Otherwise the subscribed plan, held to its pinned
 * version when plan_version_id is set (renewals keep the pin), else the live row.
 */
export async function getEntitlements(tx: TenantTransaction, accountId: string): Promise<Entitlements> {
  // addons: per-kind totals of this workspace's active add-ons (the rows themselves are admin-only).
  const rows = await tx.$queryRaw<(TermsRow & { addons?: Record<string, unknown> })[]>`
    WITH sub AS (
      SELECT CASE WHEN s.status IN ('suspended','cancelled','incomplete') THEN 'free' ELSE s.plan_id END AS plan_id,
        CASE WHEN s.status IN ('suspended','cancelled','incomplete') THEN NULL ELSE s.plan_version_id END AS version_id
      FROM account_subscriptions s WHERE s.account_id=${accountId}::uuid)
    SELECT p.id, p.name, COALESCE(v.features, p.features) AS features, COALESCE(v.limits, p.limits) AS limits,
      v.id AS version_id, v.version,
      (SELECT COALESCE(jsonb_object_agg(a.kind, a.quantity), '{}'::jsonb) FROM billing_addon_totals() a) AS addons
    FROM plans p
    LEFT JOIN plan_versions v ON v.id = (SELECT version_id FROM sub) AND v.plan_id = p.id
    WHERE p.id = COALESCE((SELECT plan_id FROM sub), ${DEFAULT_PLAN})`;
  const plan = rows[0];
  if (!plan) throw new Error('Plan catalogue is missing');
  return entitlementsFromTerms(toTerms(plan), plan.addons);
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
  ai_tokens_monthly: 'AI tokens this month',
  contacts: 'contacts',
  integrations: 'connected integrations',
  messages_monthly: 'messages this month',
};

/** The refusal message for a limit (English; the UI localises by the 402 'plan_limit' code). */
export function limitMessage(planName: string, key: LimitKey, limit: number): string {
  return `The ${planName} plan allows up to ${limit.toLocaleString('en')} ${LIMIT_NAMES[key]}. Upgrade for more.`;
}

export async function requireFeature(tx: TenantTransaction, accountId: string, feature: Feature): Promise<void> {
  const e = await getEntitlements(tx, accountId);
  if (!e.features[feature]) throw new PlanLimitError(`${FEATURE_NAMES[feature]} are not included in the ${e.planName} plan. Upgrade to use them.`);
}

/**
 * Count-then-create under a transaction lock, so two simultaneous creates
 * cannot both pass a limit check: `count()` runs only after the lock, and the
 * caller's write must be in the same transaction. The limit is resolved first:
 * an unlimited key returns at once, with no lock and no count, so unlimited
 * workspaces (every workspace without a subscription) stay on the flat path.
 * `adding` is how many items the action creates (an import adds several).
 */
export async function requireRoomFor(tx: TenantTransaction, accountId: string, key: LimitKey, count: () => Promise<number>, adding = 1): Promise<void> {
  if (!Number.isSafeInteger(adding) || adding < 0) throw new Error('adding must be a non-negative integer');
  const e = await getEntitlements(tx, accountId);
  const limit = e.limits[key];
  if (limit === null || adding === 0) return;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${accountId}:${key}`}))`;
  if ((await count()) + adding > limit) throw new PlanLimitError(limitMessage(e.planName, key, limit));
}

/** Throws when `wanted` (the count after the action) would exceed the plan's limit. */
export async function requireWithinLimit(tx: TenantTransaction, accountId: string, key: LimitKey, wanted: number): Promise<void> {
  const e = await getEntitlements(tx, accountId);
  const limit = e.limits[key];
  if (limit !== null && wanted > limit) throw new PlanLimitError(limitMessage(e.planName, key, limit));
}

