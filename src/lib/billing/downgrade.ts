// Moving to a smaller plan never deletes anything. When a workspace has more
// saved segments, lists, active flows or active automations than its plan
// allows, an admin picks which stay; the rest are archived (archived_at):
//   segments, lists   kept with their members, refused for new campaigns
//   flows             status 'archived' (never run)
//   automations       is_active false (never run)
// plan_archives remembers each archived item's prior state, and applyPlanLimits
// restores items (most recently archived first) once the limits allow again.
//
// When the change takes effect (the billing sweep or webhook switches the plan),
// the caller runs applyPlanLimits in the same tenant transaction, or
// enforcePlanLimits(accountId) on its own. Without an admin choice for that
// plan, the most recently used items are kept.

import type { PrismaClient } from '@prisma/client';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { getEntitlements } from './entitlements';
import { ADDON_LIMIT, LIMITS, type AddonKind, type LimitKey } from './entitlements-catalogue';

export const ARCHIVABLE_KINDS = ['segments', 'lists', 'flows', 'automations'] as const;
export type ArchivableKind = (typeof ARCHIVABLE_KINDS)[number];
export const KIND_LIMIT: Record<ArchivableKind, LimitKey> = {
  segments: 'segments', lists: 'lists', flows: 'active_flows', automations: 'active_automations',
};

/** 'kept' for segments and lists; a flow's or automation's running state. */
export type PriorState = 'kept' | 'active' | 'draft';

export interface ArchivableItem {
  id: string;
  name: string;
  lastUsedAt: string | null;
  state: PriorState;
}
export type KeepSelection = Partial<Record<ArchivableKind, string[]>>;

export interface KindOverage {
  kind: ArchivableKind;
  limit: number | null;
  /** In use now (counting toward the limit), most recently used first. */
  items: ArchivableItem[];
  /** How many must be archived to fit. */
  excess: number;
}

export interface ArchivedItem {
  kind: ArchivableKind;
  id: string;
  name: string;
  archivedAt: string;
}

export interface DowngradeOverview {
  plan: { id: string; name: string };
  /** When the plan takes effect; null when it is already the current plan. */
  effectiveAt: string | null;
  pending: boolean;
  kinds: KindOverage[];
  selection: KeepSelection | null;
  archived: ArchivedItem[];
}

/** A refusal that is safe to show; `code` picks the message. */
export class DowngradeInputError extends Error {
  constructor(public code: 'invalid_selection' | 'stale_plan' | 'too_many', public status = 400) {
    super(code);
  }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_IDS = 1000;

/**
 * Which items stay. `items` are most recently used first. The admin's
 * `selected` ids (when given and still in use) are kept first, in their order;
 * free places go to the most recently used. Nothing changes within the limit.
 */
export function chooseKept(items: ArchivableItem[], limit: number | null, selected?: readonly string[]): { keep: string[]; archive: string[] } {
  const ids = items.map((i) => i.id);
  if (limit === null || ids.length <= limit) return { keep: ids, archive: [] };
  const keep: string[] = [];
  for (const id of [...(selected ?? []), ...ids]) {
    if (keep.length >= limit) break;
    if (ids.includes(id) && !keep.includes(id)) keep.push(id);
  }
  return { keep, archive: ids.filter((id) => !keep.includes(id)) };
}

/** Validates a selection body: { segments?: uuid[], lists?: uuid[], flows?: uuid[], automations?: uuid[] }. */
export function parseSelection(input: unknown): KeepSelection {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DowngradeInputError('invalid_selection');
  const out: KeepSelection = {};
  for (const [key, value] of Object.entries(input)) {
    if (!(ARCHIVABLE_KINDS as readonly string[]).includes(key)) throw new DowngradeInputError('invalid_selection');
    if (!Array.isArray(value) || value.length > MAX_IDS || value.some((v) => typeof v !== 'string' || !uuid.test(v)))
      throw new DowngradeInputError('invalid_selection');
    out[key as ArchivableKind] = [...new Set((value as string[]).map((v) => v.toLowerCase()))];
  }
  return out;
}

/** Items counting toward a kind's limit, most recently used first. */
export async function itemsInUse(tx: TenantTransaction, accountId: string, kind: ArchivableKind): Promise<ArchivableItem[]> {
  type Row = { id: string; name: string; last_used: Date | null; state: PriorState };
  let rows: Row[];
  switch (kind) {
    case 'segments':
      rows = await tx.$queryRaw<Row[]>`SELECT id::text, name, GREATEST(updated_at, created_at) AS last_used, 'kept' AS state
        FROM segments WHERE account_id=${accountId}::uuid AND archived_at IS NULL ORDER BY last_used DESC NULLS LAST, id`;
      break;
    case 'lists':
      rows = await tx.$queryRaw<Row[]>`SELECT id::text, name, GREATEST(updated_at, created_at) AS last_used, 'kept' AS state
        FROM contact_lists WHERE account_id=${accountId}::uuid AND archived_at IS NULL ORDER BY last_used DESC NULLS LAST, id`;
      break;
    case 'flows':
      rows = await tx.$queryRaw<Row[]>`SELECT id::text, name, COALESCE(last_executed_at, updated_at) AS last_used,
          CASE WHEN status='active' THEN 'active' ELSE 'draft' END AS state
        FROM flows WHERE account_id=${accountId}::uuid AND (status='active' OR (status='draft' AND cardinality(test_numbers)>0))
        ORDER BY last_used DESC NULLS LAST, id`;
      break;
    case 'automations':
      rows = await tx.$queryRaw<Row[]>`SELECT id::text, name, COALESCE(last_executed_at, updated_at) AS last_used, 'active' AS state
        FROM automations WHERE account_id=${accountId}::uuid AND is_active ORDER BY last_used DESC NULLS LAST, id`;
      break;
  }
  return rows.map((r) => ({ id: r.id, name: r.name, lastUsedAt: r.last_used?.toISOString() ?? null, state: r.state }));
}

/** A plan's limits plus this workspace's active add-ons (null = unlimited). */
export async function planLimits(tx: TenantTransaction, planId: string): Promise<{ name: string; limits: Record<LimitKey, number | null> }> {
  const [plan] = await tx.$queryRaw<{ name: string; limits: Record<string, unknown>; addons: Record<string, unknown> }[]>`
    SELECT p.name, p.limits, (SELECT COALESCE(jsonb_object_agg(a.kind, a.quantity), '{}'::jsonb) FROM billing_addon_totals() a) AS addons
    FROM plans p WHERE p.id=${planId}`;
  if (!plan) throw new DowngradeInputError('stale_plan', 409);
  const extra: Partial<Record<LimitKey, number>> = {};
  for (const [kind, quantity] of Object.entries(plan.addons ?? {})) {
    const key = ADDON_LIMIT[kind as AddonKind];
    if (key && typeof quantity === 'number' && Number.isSafeInteger(quantity)) extra[key] = (extra[key] ?? 0) + quantity;
  }
  return {
    name: plan.name,
    limits: Object.fromEntries(LIMITS.map((k) => {
      const value = plan.limits?.[k];
      return [k, typeof value === 'number' && Number.isFinite(value) ? value + (extra[k] ?? 0) : null];
    })) as Record<LimitKey, number | null>,
  };
}

/** The plan the workspace is moving to: a scheduled change or cancellation, else its current plan. */
export async function targetPlan(tx: TenantTransaction, accountId: string): Promise<{ id: string; effectiveAt: Date | null; pending: boolean }> {
  const [sub] = await tx.$queryRaw<{ scheduled_plan: string | null; cancel_at_period_end: boolean; current_period_end: Date | null }[]>`
    SELECT scheduled_plan, cancel_at_period_end, current_period_end FROM account_subscriptions WHERE account_id=${accountId}::uuid`;
  if (sub?.cancel_at_period_end) return { id: 'free', effectiveAt: sub.current_period_end, pending: true };
  if (sub?.scheduled_plan) return { id: sub.scheduled_plan, effectiveAt: sub.current_period_end, pending: true };
  return { id: (await getEntitlements(tx, accountId)).planId, effectiveAt: null, pending: false };
}

async function readSelection(tx: TenantTransaction, accountId: string): Promise<{ planId: string; keep: KeepSelection } | null> {
  const [row] = await tx.$queryRaw<{ plan_id: string; keep: unknown }[]>`
    SELECT plan_id, keep FROM downgrade_selections WHERE account_id=${accountId}::uuid`;
  if (!row) return null;
  try { return { planId: row.plan_id, keep: parseSelection(row.keep) }; } catch { return null; }
}

async function archivedItems(tx: TenantTransaction, accountId: string): Promise<ArchivedItem[]> {
  const rows = await tx.$queryRaw<{ kind: ArchivableKind; id: string; name: string; archived_at: Date }[]>`
    SELECT pa.kind, pa.item_id::text AS id, COALESCE(s.name, l.name, f.name, a.name) AS name, pa.archived_at
    FROM plan_archives pa
    LEFT JOIN segments s ON pa.kind='segments' AND s.account_id=pa.account_id AND s.id=pa.item_id AND s.archived_at IS NOT NULL
    LEFT JOIN contact_lists l ON pa.kind='lists' AND l.account_id=pa.account_id AND l.id=pa.item_id AND l.archived_at IS NOT NULL
    LEFT JOIN flows f ON pa.kind='flows' AND f.account_id=pa.account_id AND f.id=pa.item_id AND f.archived_at IS NOT NULL
    LEFT JOIN automations a ON pa.kind='automations' AND a.account_id=pa.account_id AND a.id=pa.item_id AND a.archived_at IS NOT NULL
    WHERE pa.account_id=${accountId}::uuid AND pa.restored_at IS NULL
      AND COALESCE(s.id, l.id, f.id, a.id) IS NOT NULL
    ORDER BY pa.archived_at DESC, pa.item_id LIMIT 500`;
  return rows.map((r) => ({ kind: r.kind, id: r.id, name: r.name, archivedAt: r.archived_at.toISOString() }));
}

/** What the target plan's limits would archive, the stored choice and what is archived now. */
export async function downgradeOverview(tx: TenantTransaction, accountId: string): Promise<DowngradeOverview> {
  const target = await targetPlan(tx, accountId);
  const { name, limits } = await planLimits(tx, target.id);
  const kinds: KindOverage[] = [];
  for (const kind of ARCHIVABLE_KINDS) {
    const items = await itemsInUse(tx, accountId, kind);
    const limit = limits[KIND_LIMIT[kind]];
    kinds.push({ kind, limit, items, excess: limit === null ? 0 : Math.max(0, items.length - limit) });
  }
  const selection = await readSelection(tx, accountId);
  return {
    plan: { id: target.id, name },
    effectiveAt: target.effectiveAt?.toISOString() ?? null,
    pending: target.pending,
    kinds,
    selection: selection?.planId === target.id ? selection.keep : null,
    archived: await archivedItems(tx, accountId),
  };
}

/**
 * Stores an admin's choice for the target plan. When that plan is already in
 * effect, it is applied at once. Every id must be in use and each kind must
 * fit the plan's limit.
 */
export async function saveDowngradeSelection(tx: TenantTransaction, accountId: string, userId: string, planId: string, keep: KeepSelection):
  Promise<{ applied: boolean }> {
  const target = await targetPlan(tx, accountId);
  if (target.id !== planId) throw new DowngradeInputError('stale_plan', 409);
  const { limits } = await planLimits(tx, planId);
  for (const kind of ARCHIVABLE_KINDS) {
    const ids = keep[kind];
    if (!ids) continue;
    const inUse = new Set((await itemsInUse(tx, accountId, kind)).map((i) => i.id));
    if (ids.some((id) => !inUse.has(id))) throw new DowngradeInputError('invalid_selection');
    const limit = limits[KIND_LIMIT[kind]];
    if (limit !== null && ids.length > limit) throw new DowngradeInputError('too_many');
  }
  await tx.$executeRaw`INSERT INTO downgrade_selections(account_id, plan_id, keep, chosen_by, chosen_at, applied_at)
    VALUES (${accountId}::uuid, ${planId}, ${JSON.stringify(keep)}::jsonb, ${userId}::uuid, now(), NULL)
    ON CONFLICT (account_id) DO UPDATE SET plan_id=EXCLUDED.plan_id, keep=EXCLUDED.keep, chosen_by=EXCLUDED.chosen_by,
      chosen_at=EXCLUDED.chosen_at, applied_at=NULL`;
  if (target.pending) return { applied: false };
  await applyPlanLimits(tx, accountId);
  return { applied: true };
}

async function archive(tx: TenantTransaction, accountId: string, kind: ArchivableKind, items: ArchivableItem[], planId: string): Promise<number> {
  if (!items.length) return 0;
  const ids = items.map((i) => i.id);
  let n: number;
  switch (kind) {
    case 'segments':
      n = await tx.$executeRaw`UPDATE segments SET archived_at=now() WHERE account_id=${accountId}::uuid AND id=ANY(${ids}::uuid[]) AND archived_at IS NULL`;
      break;
    case 'lists':
      n = await tx.$executeRaw`UPDATE contact_lists SET archived_at=now() WHERE account_id=${accountId}::uuid AND id=ANY(${ids}::uuid[]) AND archived_at IS NULL`;
      break;
    case 'flows':
      n = await tx.$executeRaw`UPDATE flows SET status='archived', archived_at=now()
        WHERE account_id=${accountId}::uuid AND id=ANY(${ids}::uuid[]) AND status IN ('active','draft')`;
      break;
    case 'automations':
      n = await tx.$executeRaw`UPDATE automations SET is_active=false, archived_at=now()
        WHERE account_id=${accountId}::uuid AND id=ANY(${ids}::uuid[]) AND is_active`;
      break;
  }
  await tx.$executeRaw`INSERT INTO plan_archives(account_id, kind, item_id, prior_state, plan_id)
    SELECT ${accountId}::uuid, ${kind}, x.id::uuid, x.state, ${planId}
    FROM jsonb_to_recordset(${JSON.stringify(items.map((i) => ({ id: i.id, state: i.state })))}::jsonb) AS x(id text, state text)
    ON CONFLICT (account_id, kind, item_id) DO UPDATE SET prior_state=EXCLUDED.prior_state, plan_id=EXCLUDED.plan_id,
      archived_at=now(), restored_at=NULL`;
  return n;
}

async function restore(tx: TenantTransaction, accountId: string, kind: ArchivableKind, room: number): Promise<number> {
  if (room <= 0) return 0;
  // Still archived (not re-activated or deleted since), most recently archived first.
  const rows = await tx.$queryRaw<{ id: string; prior_state: PriorState }[]>`
    SELECT pa.item_id::text AS id, pa.prior_state FROM plan_archives pa
    WHERE pa.account_id=${accountId}::uuid AND pa.kind=${kind} AND pa.restored_at IS NULL AND (
      (pa.kind='segments' AND EXISTS (SELECT 1 FROM segments t WHERE t.account_id=pa.account_id AND t.id=pa.item_id AND t.archived_at IS NOT NULL))
      OR (pa.kind='lists' AND EXISTS (SELECT 1 FROM contact_lists t WHERE t.account_id=pa.account_id AND t.id=pa.item_id AND t.archived_at IS NOT NULL))
      OR (pa.kind='flows' AND EXISTS (SELECT 1 FROM flows t WHERE t.account_id=pa.account_id AND t.id=pa.item_id AND t.archived_at IS NOT NULL AND t.status='archived'))
      OR (pa.kind='automations' AND EXISTS (SELECT 1 FROM automations t WHERE t.account_id=pa.account_id AND t.id=pa.item_id AND t.archived_at IS NOT NULL AND NOT t.is_active)))
    ORDER BY pa.archived_at DESC, pa.item_id LIMIT ${Number.isFinite(room) ? room : 100000}`;
  if (!rows.length) return 0;
  const ids = rows.map((r) => r.id);
  const active = rows.filter((r) => r.prior_state === 'active').map((r) => r.id);
  switch (kind) {
    case 'segments':
      await tx.$executeRaw`UPDATE segments SET archived_at=NULL WHERE account_id=${accountId}::uuid AND id=ANY(${ids}::uuid[])`;
      break;
    case 'lists':
      await tx.$executeRaw`UPDATE contact_lists SET archived_at=NULL WHERE account_id=${accountId}::uuid AND id=ANY(${ids}::uuid[])`;
      break;
    case 'flows':
      await tx.$executeRaw`UPDATE flows SET archived_at=NULL, status=CASE WHEN id=ANY(${active}::uuid[]) THEN 'active' ELSE 'draft' END
        WHERE account_id=${accountId}::uuid AND id=ANY(${ids}::uuid[]) AND status='archived'`;
      break;
    case 'automations':
      await tx.$executeRaw`UPDATE automations SET archived_at=NULL, is_active=true
        WHERE account_id=${accountId}::uuid AND id=ANY(${ids}::uuid[]) AND NOT is_active`;
      break;
  }
  await tx.$executeRaw`UPDATE plan_archives SET restored_at=now()
    WHERE account_id=${accountId}::uuid AND kind=${kind} AND item_id=ANY(${ids}::uuid[])`;
  return rows.length;
}

export type ApplyResult = Record<ArchivableKind, { archived: number; restored: number }>;

/**
 * Brings the workspace within its current plan's limits: archives what does
 * not fit (the admin's choice for this plan, else the most recently used are
 * kept) and restores archived items while there is room. Idempotent.
 */
export async function applyPlanLimits(tx: TenantTransaction, accountId: string): Promise<ApplyResult> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${accountId}:plan_limits`}))`;
  const entitlements = await getEntitlements(tx, accountId);
  const selection = await readSelection(tx, accountId);
  const chosen = selection?.planId === entitlements.planId ? selection.keep : undefined;
  const result = {} as ApplyResult;
  for (const kind of ARCHIVABLE_KINDS) {
    const limit = entitlements.limits[KIND_LIMIT[kind]];
    const items = await itemsInUse(tx, accountId, kind);
    const { archive: ids } = chooseKept(items, limit, chosen?.[kind]);
    const archived = await archive(tx, accountId, kind, items.filter((i) => ids.includes(i.id)), entitlements.planId);
    const restored = ids.length ? 0 : await restore(tx, accountId, kind, limit === null ? Infinity : limit - items.length);
    result[kind] = { archived, restored };
  }
  if (chosen) await tx.$executeRaw`UPDATE downgrade_selections SET applied_at=now() WHERE account_id=${accountId}::uuid`;
  return result;
}

/** applyPlanLimits in its own worker-role transaction, for the billing sweep or webhook. */
export async function enforcePlanLimits(accountId: string, db: PrismaClient = getWorkerPrisma()): Promise<ApplyResult> {
  return withTenant({ accountId }, (tx) => applyPlanLimits(tx, accountId), db);
}
