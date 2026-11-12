// Ad management, phase A: see the connected ad account's campaigns, ad sets
// and ads, pause / resume them, and change budgets, end dates and names.
//
// Sync (meta.ad_objects_sync, worker): caches every campaign, ad set and ad in
// meta_ad_objects, hourly with the insights sync and right after a change.
//
// Change: requestChange runs after the route's session, CSRF and admin checks.
// In one worker transaction it re-checks the workspace's spending cap, records
// the change (one open change per object and field) and queues its
// meta.ad_change job, so nothing is acknowledged before it is durable. The job
// sends the change once through an outbound intent. Meta's values are set, not
// added, so after an ambiguous outcome the job reads the object back: when it
// shows the new value the change is 'applied', otherwise it is 'unknown' until
// an admin re-checks (a read) or dismisses it. It is never re-sent blindly.
// Only Meta's code[:subcode] is stored or logged; tokens never leave the worker.
import { Prisma } from '@prisma/client';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { hasMinRole } from '@/lib/auth/roles';
import { dispatchOnce, UncertainDispatchError } from '@/lib/jobs/dispatch';
import { MetaApiError } from '@/lib/whatsapp/meta-api';
import { metaAdsConfig, metaAdsManageEnabled, missingScopes } from './config';
import { loadActiveConnectionTx, MetaAdsError, type MetaAdsActor } from './connection';
import {
  getAdObject, isMetaThrottle, isMetaTokenInvalid, listAdObjects, metaErrorCode, updateAdObject,
  type AdObjectLevel, type MetaAdObject,
} from './graph';

import { AD_OBJECTS_SYNC_JOB } from './schedule';
export { AD_OBJECTS_SYNC_JOB };
export const AD_CHANGE_JOB = 'meta.ad_change';
/** One send attempt, then reads only: a throttle or a crash is retried, never re-sent after Meta may have applied it. */
export const AD_CHANGE_MAX_ATTEMPTS = 4;

export const AD_CHANGE_FIELDS = ['status', 'daily_budget', 'lifetime_budget', 'end_time', 'name'] as const;
export type AdChangeField = (typeof AD_CHANGE_FIELDS)[number];
export type AdChangeStatus = 'queued' | 'applied' | 'failed' | 'unknown' | 'dismissed';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const META_ID = /^\d{1,32}$/;
const DAY_MS = 86_400_000;
/** Largest budget accepted, in minor units (well inside bigint and the column CHECKs). */
export const MAX_BUDGET_MINOR = 999_999_999_999_999;
const CHUNK = 500;

const worker = <T>(accountId: string, work: (tx: TenantTransaction) => Promise<T>, userId?: string) =>
  withTenant({ accountId, userId, role: 'owner' }, work, getWorkerPrisma());

const audit = (tx: TenantTransaction, actor: MetaAdsActor, action: string, resourceId: string, metadata: Record<string, unknown>) =>
  tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
    VALUES(${actor.accountId}::uuid,${actor.userId}::uuid,${action},${resourceId},${JSON.stringify(metadata)}::jsonb)`;

/** Reading campaigns needs ads_read; ads_management also allows it. */
const canRead = (scopes: readonly string[]) => scopes.includes('ads_read') || scopes.includes('ads_management');

function errorCodeOf(error: unknown): string | null {
  const code = metaErrorCode(error);
  if (code && /^[0-9:]{1,32}$/.test(code)) return code;
  return error instanceof MetaApiError ? String(error.httpStatus).slice(0, 32) : null;
}

// ---------------------------------------------------------------------------
// Sync

/** meta.ad_objects_sync: replaces the cached campaigns, ad sets and ads with what Meta has now. */
export async function handleAdObjectsSyncJob(accountId: string): Promise<void> {
  if (!metaAdsConfig()) return;
  const connection = await worker(accountId, (tx) => loadActiveConnectionTx(tx, accountId));
  if (!connection?.adAccountId || !connection.userToken || !canRead(connection.scopes)) return;

  let objects: MetaAdObject[];
  try {
    objects = await listAdObjects(connection.adAccountId, connection.userToken);
  } catch (error) {
    const code = metaErrorCode(error);
    console.error('[meta-ads] ad objects sync failed', code ?? (error instanceof Error ? error.name : 'unknown'));
    if (isMetaTokenInvalid(error)) {
      await worker(accountId, (tx) => tx.$executeRaw`UPDATE meta_ad_connections SET last_error_code=${code},
          status='token_invalid', updated_at=now()
        WHERE account_id=${accountId}::uuid AND id=${connection.id}::uuid AND status='active'`);
      return;
    }
    throw error;
  }

  await worker(accountId, async (tx) => {
    // Still the same active connection: a disconnect during the fetch wins.
    const live = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM meta_ad_connections
      WHERE account_id=${accountId}::uuid AND id=${connection.id}::uuid AND status='active' FOR UPDATE`;
    if (!live[0]) return;
    for (let i = 0; i < objects.length; i += CHUNK) {
      const part = objects.slice(i, i + CHUNK);
      await tx.$executeRaw`
        INSERT INTO meta_ad_objects(account_id, connection_id, level, object_id, campaign_id, adset_id, name, status,
          effective_status, objective, daily_budget_minor, lifetime_budget_minor, start_time, end_time, synced_at)
        SELECT ${accountId}::uuid, ${connection.id}::uuid, r.level, r.object_id, r.campaign_id, r.adset_id, r.name, r.status,
          r.effective_status, r.objective, r.daily, r.lifetime, r.start_time, r.end_time, now()
        FROM unnest(${part.map((o) => o.level)}::text[], ${part.map((o) => o.id)}::text[],
          ${part.map((o) => o.campaignId)}::text[], ${part.map((o) => o.adsetId)}::text[], ${part.map((o) => o.name)}::text[],
          ${part.map((o) => o.status)}::text[], ${part.map((o) => o.effectiveStatus)}::text[], ${part.map((o) => o.objective)}::text[],
          ${part.map((o) => (o.dailyBudgetMinor === null ? null : String(o.dailyBudgetMinor)))}::bigint[],
          ${part.map((o) => (o.lifetimeBudgetMinor === null ? null : String(o.lifetimeBudgetMinor)))}::bigint[],
          ${part.map((o) => o.startTime)}::timestamptz[], ${part.map((o) => o.endTime)}::timestamptz[])
          AS r(level, object_id, campaign_id, adset_id, name, status, effective_status, objective, daily, lifetime, start_time, end_time)
        ON CONFLICT (account_id, object_id) DO UPDATE SET
          connection_id=EXCLUDED.connection_id, level=EXCLUDED.level, campaign_id=EXCLUDED.campaign_id, adset_id=EXCLUDED.adset_id,
          name=EXCLUDED.name, status=EXCLUDED.status, effective_status=EXCLUDED.effective_status, objective=EXCLUDED.objective,
          daily_budget_minor=EXCLUDED.daily_budget_minor, lifetime_budget_minor=EXCLUDED.lifetime_budget_minor,
          start_time=EXCLUDED.start_time, end_time=EXCLUDED.end_time, synced_at=now()`;
    }
    // Objects Meta no longer returns (deleted there) and rows of an earlier connection go.
    await tx.$executeRaw`DELETE FROM meta_ad_objects WHERE account_id=${accountId}::uuid
      AND (connection_id <> ${connection.id}::uuid OR NOT (object_id = ANY(${objects.map((o) => o.id)}::text[])))`;
    await tx.$executeRaw`UPDATE meta_ad_connections SET objects_synced_at=now(), updated_at=now()
      WHERE account_id=${accountId}::uuid AND id=${connection.id}::uuid`;
  });
}

const SYNC_BUCKET_MS = 5 * 60_000;

async function queueSyncTx(tx: TenantTransaction, accountId: string, dedupeKey: string): Promise<void> {
  await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,max_attempts)
    VALUES(${AD_OBJECTS_SYNC_JOB},${accountId}::uuid,'{}'::jsonb,${dedupeKey},3)
    ON CONFLICT(dedupe_key) DO NOTHING`;
}

/** Admin "Refresh": at most one sync per 5 minutes. False without an active connection. */
export async function queueAdObjectsSync(actor: MetaAdsActor, now: number = Date.now()): Promise<boolean> {
  if (!metaAdsConfig()) throw new MetaAdsError('meta_ads_not_enabled');
  if (!hasMinRole(actor.role, 'admin')) throw new MetaAdsError('forbidden');
  return worker(actor.accountId, async (tx) => {
    const live = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM meta_ad_connections
      WHERE account_id=${actor.accountId}::uuid AND status='active' LIMIT 1`;
    if (!live[0]) return false;
    await queueSyncTx(tx, actor.accountId, `meta-ad-objects-manual:${actor.accountId}:${Math.floor(now / SYNC_BUCKET_MS)}`);
    return true;
  }, actor.userId);
}

// ---------------------------------------------------------------------------
// Read (any member)

export interface AdObjectDto {
  level: AdObjectLevel;
  id: string;
  campaignId: string | null;
  adsetId: string | null;
  name: string | null;
  status: string | null;
  effectiveStatus: string | null;
  objective: string | null;
  /** Minor units of the ad account currency. */
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  startTime: string | null;
  endTime: string | null;
  /** Last 30 days from the stored insights (campaigns and ads only); null when unknown. */
  spend: number | null;
  conversationsStarted: number | null;
}

export interface AdChangeDto {
  id: string;
  level: AdObjectLevel;
  objectId: string;
  objectName: string | null;
  field: AdChangeField;
  fromValue: string | null;
  toValue: string;
  status: AdChangeStatus;
  lastErrorCode: string | null;
  createdAt: string;
  appliedAt: string | null;
}

export interface AdManageView {
  objects: AdObjectDto[];
  changes: AdChangeDto[];
  currency: string | null;
  syncedAt: string | null;
  /** Workspace cap on any daily budget (minor units); null when none is set. */
  maxDailyBudget: number | null;
  /** META_ADS_MANAGE_ENABLED is set (changes can be sent). */
  manageEnabled: boolean;
  /** Permissions the grant lacks for changes. */
  missingScopes: string[];
}

interface ChangeRow {
  id: string; level: AdObjectLevel; object_id: string; object_name: string | null; field: AdChangeField;
  from_value: string | null; to_value: string; status: AdChangeStatus; last_error_code: string | null;
  created_at: Date; applied_at: Date | null;
}

const changeDto = (r: ChangeRow): AdChangeDto => ({
  id: r.id, level: r.level, objectId: r.object_id, objectName: r.object_name, field: r.field, fromValue: r.from_value,
  toValue: r.to_value, status: r.status, lastErrorCode: r.last_error_code, createdAt: r.created_at.toISOString(),
  appliedAt: r.applied_at?.toISOString() ?? null,
});

const CHANGE_COLUMNS = Prisma.sql`id::text AS id, level, object_id, object_name, field, from_value, to_value, status,
  last_error_code, created_at, applied_at`;

const num = (value: bigint | number | Prisma.Decimal | string | null) => (value == null ? null : Number(value));
const iso = (value: Date | null) => value?.toISOString() ?? null;

const MAX_OBJECTS = 3000;

/** The cached tree, the open and recent changes, and the cap. App-role read; no Meta call. */
export async function getAdManageView(actor: MetaAdsActor): Promise<AdManageView> {
  const { accountId } = actor;
  return withTenant({ accountId, userId: actor.userId, role: actor.role }, async (tx) => {
    const [connection] = await tx.$queryRaw<{
      ad_account_currency: string | null; objects_synced_at: Date | null; max_daily_budget_minor: bigint | null; scopes: string[];
    }[]>`SELECT ad_account_currency, objects_synced_at, max_daily_budget_minor, scopes FROM meta_ad_connections
      WHERE account_id=${accountId}::uuid AND status<>'disconnected' ORDER BY created_at DESC LIMIT 1`;
    const objects = await tx.$queryRaw<{
      level: AdObjectLevel; object_id: string; campaign_id: string | null; adset_id: string | null; name: string | null;
      status: string | null; effective_status: string | null; objective: string | null; daily_budget_minor: bigint | null;
      lifetime_budget_minor: bigint | null; start_time: Date | null; end_time: Date | null;
      spend: Prisma.Decimal | null; conversations: bigint | null;
    }[]>`
      SELECT o.level, o.object_id, o.campaign_id, o.adset_id, o.name, o.status, o.effective_status, o.objective,
        o.daily_budget_minor, o.lifetime_budget_minor, o.start_time, o.end_time, i.spend, i.conversations
      FROM meta_ad_objects o
      LEFT JOIN (
        SELECT level, object_id, sum(spend) AS spend, sum(conversations_started) AS conversations FROM meta_ad_insights
        WHERE account_id=${accountId}::uuid AND day >= current_date - 29 GROUP BY level, object_id
      ) i ON i.object_id = o.object_id AND i.level = o.level
      WHERE o.account_id=${accountId}::uuid
      ORDER BY CASE o.level WHEN 'campaign' THEN 0 WHEN 'adset' THEN 1 ELSE 2 END, o.name NULLS LAST, o.object_id
      LIMIT ${MAX_OBJECTS}`;
    const changes = await tx.$queryRaw<ChangeRow[]>`
      (SELECT ${CHANGE_COLUMNS} FROM meta_ad_changes WHERE account_id=${accountId}::uuid AND status IN ('queued','unknown'))
      UNION ALL
      (SELECT ${CHANGE_COLUMNS} FROM meta_ad_changes WHERE account_id=${accountId}::uuid AND status NOT IN ('queued','unknown')
        ORDER BY created_at DESC LIMIT 20)
      ORDER BY created_at DESC`;
    return {
      objects: objects.map((o) => ({
        level: o.level, id: o.object_id, campaignId: o.campaign_id, adsetId: o.adset_id, name: o.name, status: o.status,
        effectiveStatus: o.effective_status, objective: o.objective, dailyBudget: num(o.daily_budget_minor),
        lifetimeBudget: num(o.lifetime_budget_minor), startTime: iso(o.start_time), endTime: iso(o.end_time),
        spend: num(o.spend), conversationsStarted: num(o.conversations),
      })),
      changes: changes.map(changeDto),
      currency: connection?.ad_account_currency ?? null,
      syncedAt: iso(connection?.objects_synced_at ?? null),
      maxDailyBudget: num(connection?.max_daily_budget_minor ?? null),
      manageEnabled: metaAdsManageEnabled(),
      missingScopes: missingScopes(connection?.scopes ?? [], 'manage'),
    };
  });
}

// ---------------------------------------------------------------------------
// Request a change (admin)

export interface AdChangeInput {
  objectId: string;
  field: AdChangeField;
  /** The new value as Meta takes it: ACTIVE / PAUSED, minor units, an ISO time, or a name. */
  value: string;
}

const MAX_NAME = 400;
// Control characters (C0, DEL, C1) never belong in a name.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Validates a change request body. Null when invalid. `now` bounds end dates. */
export function parseAdChangeInput(body: unknown, now: number = Date.now()): AdChangeInput | null {
  if (!body || typeof body !== 'object') return null;
  const { objectId, field, value } = body as Record<string, unknown>;
  if (typeof objectId !== 'string' || !META_ID.test(objectId)) return null;
  if (typeof field !== 'string' || !(AD_CHANGE_FIELDS as readonly string[]).includes(field)) return null;
  switch (field as AdChangeField) {
    case 'status':
      return value === 'ACTIVE' || value === 'PAUSED' ? { objectId, field: 'status', value } : null;
    case 'daily_budget':
    case 'lifetime_budget': {
      const text = typeof value === 'number' ? String(value) : value;
      if (typeof text !== 'string' || !/^[1-9]\d{0,14}$/.test(text) || Number(text) > MAX_BUDGET_MINOR) return null;
      return { objectId, field: field as AdChangeField, value: text };
    }
    case 'end_time': {
      if (typeof value !== 'string' || value.length > 40) return null;
      const ms = Date.parse(value);
      // At least an hour ahead, at most three years.
      if (!Number.isFinite(ms) || ms < now + 3_600_000 || ms > now + 3 * 365 * DAY_MS) return null;
      return { objectId, field: 'end_time', value: new Date(ms).toISOString() };
    }
    case 'name': {
      if (typeof value !== 'string') return null;
      const name = value.trim();
      if (!name || name.length > MAX_NAME || CONTROL.test(name)) return null;
      return { objectId, field: 'name', value: name };
    }
  }
  return null;
}

interface CachedObject {
  level: AdObjectLevel;
  object_id: string;
  campaign_id: string | null;
  adset_id: string | null;
  name: string | null;
  status: string | null;
  daily_budget_minor: bigint | null;
  lifetime_budget_minor: bigint | null;
  start_time: Date | null;
  end_time: Date | null;
}

/** Days a lifetime budget is spread over (at least one). Null when the object has no end. */
function budgetDays(object: Pick<CachedObject, 'start_time' | 'end_time'>, now: number): number | null {
  if (!object.end_time) return null;
  const from = Math.max(now, object.start_time?.getTime() ?? now);
  return Math.max(1, Math.ceil((object.end_time.getTime() - from) / DAY_MS));
}

/**
 * Whether a budget breaks the workspace cap: a daily budget above it, or a
 * lifetime budget above cap x the days it runs (a lifetime budget with no end
 * date cannot be checked, so it is refused while a cap is set).
 */
export function exceedsCap(cap: number | null, budget: { daily: number | null; lifetime: number | null },
  object: Pick<CachedObject, 'start_time' | 'end_time'>, now: number = Date.now()): boolean {
  if (cap === null) return false;
  if (budget.daily !== null && budget.daily > cap) return true;
  if (budget.lifetime !== null) {
    const days = budgetDays(object, now);
    if (days === null || budget.lifetime > cap * days) return true;
  }
  return false;
}

/** The Graph fields for one change. */
export function changeFields(field: AdChangeField, value: string): Record<string, string> {
  return { [field]: value };
}

/** Records the change and queues its job in one transaction (the 202 follows the commit). */
export async function requestAdChange(actor: MetaAdsActor, input: AdChangeInput, now: number = Date.now()): Promise<AdChangeDto> {
  if (!metaAdsManageEnabled()) throw new MetaAdsError('manage_not_enabled');
  if (!hasMinRole(actor.role, 'admin')) throw new MetaAdsError('forbidden');
  return worker(actor.accountId, async (tx) => {
    const [connection] = await tx.$queryRaw<{ id: string; status: string; scopes: string[]; max_daily_budget_minor: bigint | null }[]>`
      SELECT id::text AS id, status, scopes, max_daily_budget_minor FROM meta_ad_connections
      WHERE account_id=${actor.accountId}::uuid AND status<>'disconnected' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`;
    if (!connection) throw new MetaAdsError('not_connected');
    if (connection.status === 'token_invalid') throw new MetaAdsError('token_invalid');
    if (connection.status !== 'active') throw new MetaAdsError('not_connected');
    if (missingScopes(connection.scopes, 'manage').length) throw new MetaAdsError('missing_scope');

    const objects = await tx.$queryRaw<CachedObject[]>`
      SELECT level, object_id, campaign_id, adset_id, name, status, daily_budget_minor, lifetime_budget_minor, start_time, end_time
      FROM meta_ad_objects WHERE account_id=${actor.accountId}::uuid AND connection_id=${connection.id}::uuid
        AND object_id IN (SELECT unnest(ARRAY[o.object_id, o.campaign_id, o.adset_id]) FROM meta_ad_objects o
          WHERE o.account_id=${actor.accountId}::uuid AND o.object_id=${input.objectId})`;
    const object = objects.find((o) => o.object_id === input.objectId);
    if (!object) throw new MetaAdsError('not_found');
    const cap = num(connection.max_daily_budget_minor);
    const daily = num(object.daily_budget_minor);
    const lifetime = num(object.lifetime_budget_minor);

    let fromValue: string | null;
    switch (input.field) {
      case 'status':
        // Archived or deleted objects stay as they are; only ACTIVE <-> PAUSED.
        if (object.status !== 'ACTIVE' && object.status !== 'PAUSED') throw new MetaAdsError('invalid_request');
        if (object.status === input.value) throw new MetaAdsError('invalid_request');
        fromValue = object.status;
        // Resuming starts spending: its own budget and every budget above it (ad set, campaign) must fit the cap.
        if (input.value === 'ACTIVE' && objects.some((o) =>
          exceedsCap(cap, { daily: num(o.daily_budget_minor), lifetime: num(o.lifetime_budget_minor) }, o, now))) {
          throw new MetaAdsError('over_budget_cap');
        }
        break;
      case 'daily_budget':
        if (daily === null) throw new MetaAdsError('invalid_request');
        fromValue = String(daily);
        if (exceedsCap(cap, { daily: Number(input.value), lifetime: null }, object, now)) throw new MetaAdsError('over_budget_cap');
        break;
      case 'lifetime_budget':
        if (lifetime === null) throw new MetaAdsError('invalid_request');
        fromValue = String(lifetime);
        if (exceedsCap(cap, { daily: null, lifetime: Number(input.value) }, object, now)) throw new MetaAdsError('over_budget_cap');
        break;
      case 'end_time':
        // Ad sets carry the schedule; a lifetime budget is re-checked over the new dates.
        if (object.level !== 'adset') throw new MetaAdsError('invalid_request');
        fromValue = object.end_time?.toISOString() ?? null;
        if (exceedsCap(cap, { daily: null, lifetime }, { start_time: object.start_time, end_time: new Date(input.value) }, now)) {
          throw new MetaAdsError('over_budget_cap');
        }
        break;
      case 'name':
        if (object.name === input.value) throw new MetaAdsError('invalid_request');
        fromValue = object.name;
        break;
    }
    if (input.field === 'daily_budget' || input.field === 'lifetime_budget') {
      if (fromValue === input.value) throw new MetaAdsError('invalid_request');
    }

    const [row] = await tx.$queryRaw<ChangeRow[]>`
      INSERT INTO meta_ad_changes(account_id, connection_id, level, object_id, object_name, field, from_value, to_value, requested_by)
      VALUES(${actor.accountId}::uuid, ${connection.id}::uuid, ${object.level}, ${object.object_id}, ${object.name}, ${input.field},
        ${fromValue}, ${input.value}, ${actor.userId}::uuid)
      ON CONFLICT (account_id, object_id, field) WHERE status IN ('queued','unknown') DO NOTHING
      RETURNING ${CHANGE_COLUMNS}`;
    if (!row) throw new MetaAdsError('change_pending');
    await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,max_attempts)
      VALUES(${AD_CHANGE_JOB},${actor.accountId}::uuid,${JSON.stringify({ changeId: row.id })}::jsonb,
        ${`meta-ad-change:${row.id}`},${AD_CHANGE_MAX_ATTEMPTS})`;
    await audit(tx, actor, 'meta_ads.change_request', row.id, {
      level: object.level, objectId: object.object_id, field: input.field, from: fromValue, to: input.value,
    });
    return changeDto(row);
  }, actor.userId);
}

// ---------------------------------------------------------------------------
// Apply (worker)

/** Whether Meta's object shows the change's new value. */
export function showsValue(object: MetaAdObject, field: AdChangeField, value: string): boolean {
  switch (field) {
    case 'status': return object.status === value;
    case 'daily_budget': return object.dailyBudgetMinor !== null && String(object.dailyBudgetMinor) === value;
    case 'lifetime_budget': return object.lifetimeBudgetMinor !== null && String(object.lifetimeBudgetMinor) === value;
    case 'end_time': {
      if (!object.endTime) return false;
      // Meta keeps whole seconds in the ad account's time zone; allow a minute either way.
      return Math.abs(Date.parse(object.endTime) - Date.parse(value)) <= 60_000;
    }
    case 'name': return object.name === value;
  }
}

interface QueuedChange {
  id: string; level: AdObjectLevel; object_id: string; field: AdChangeField; to_value: string; status: AdChangeStatus;
}

async function settleTx(tx: TenantTransaction, accountId: string, change: QueuedChange, status: AdChangeStatus,
  extra: { errorCode?: string | null; from?: AdChangeStatus } = {}): Promise<boolean> {
  const updated = await tx.$executeRaw`UPDATE meta_ad_changes SET status=${status},
      last_error_code=COALESCE(${extra.errorCode ?? null}, last_error_code),
      applied_at=CASE WHEN ${status === 'applied'} THEN now() ELSE applied_at END, updated_at=now()
    WHERE account_id=${accountId}::uuid AND id=${change.id}::uuid AND status=${extra.from ?? 'queued'}`;
  if (updated && status === 'applied') {
    // The cache shows the new value at once; the sync queued here brings Meta's own view (effective status) soon after.
    const v = change.to_value;
    const where = Prisma.sql`WHERE account_id=${accountId}::uuid AND object_id=${change.object_id}`;
    switch (change.field) {
      case 'status': await tx.$executeRaw`UPDATE meta_ad_objects SET status=${v} ${where}`; break;
      case 'daily_budget': await tx.$executeRaw`UPDATE meta_ad_objects SET daily_budget_minor=${v}::bigint ${where}`; break;
      case 'lifetime_budget': await tx.$executeRaw`UPDATE meta_ad_objects SET lifetime_budget_minor=${v}::bigint ${where}`; break;
      case 'end_time': await tx.$executeRaw`UPDATE meta_ad_objects SET end_time=${v}::timestamptz ${where}`; break;
      case 'name': await tx.$executeRaw`UPDATE meta_ad_objects SET name=${v} ${where}`; break;
    }
    await queueSyncTx(tx, accountId, `meta-ad-objects-change:${change.id}`);
  }
  return updated > 0;
}

const settle = (accountId: string, change: QueuedChange, status: AdChangeStatus, extra: { errorCode?: string | null } = {}) =>
  worker(accountId, (tx) => settleTx(tx, accountId, change, status, extra));

type ChangePlan =
  | { kind: 'noop' }
  | { kind: 'settle'; change: QueuedChange; status: AdChangeStatus }
  | { kind: 'read_back' | 'send'; change: QueuedChange; token: string; connectionId: string };

/**
 * meta.ad_change: sends one queued change through an outbound intent. Once a
 * send was claimed, later attempts only read the object back: Meta's values
 * are set, not added, but an advertiser's own edit in between must never be
 * overwritten by a blind re-send.
 */
export async function handleAdChangeJob(accountId: string, payload: Record<string, unknown>,
  attempt?: { attempts: number; maxAttempts: number }): Promise<void> {
  const changeId = typeof payload.changeId === 'string' && UUID.test(payload.changeId) ? payload.changeId : null;
  if (!changeId) throw new Error('Invalid ad change job');
  const lastAttempt = !!attempt && attempt.maxAttempts > 1 && attempt.attempts >= attempt.maxAttempts;
  const key = `adchange:${changeId}`;

  const plan = await worker(accountId, async (tx): Promise<ChangePlan> => {
    const [change] = await tx.$queryRaw<QueuedChange[]>`SELECT id::text AS id, level, object_id, field, to_value, status
      FROM meta_ad_changes WHERE account_id=${accountId}::uuid AND id=${changeId}::uuid`;
    if (!change || change.status !== 'queued') return { kind: 'noop' };
    const [intent] = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM outbound_intents
      WHERE account_id=${accountId}::uuid AND idempotency_key=${`${accountId}:${key}`}`;
    if (intent?.status === 'accepted') return { kind: 'settle', change, status: 'applied' };
    const conn = await loadActiveConnectionTx(tx, accountId);
    const claimed = !!intent && intent.status !== 'failed';
    if (!conn?.userToken) return { kind: 'settle', change, status: claimed ? 'unknown' : 'failed' };
    if (claimed) return { kind: 'read_back', change, token: conn.userToken, connectionId: conn.id };
    // Every earlier attempt failed before claiming a send: nothing reached Meta.
    if (lastAttempt) return { kind: 'settle', change, status: 'failed' };
    if (!metaAdsManageEnabled() || missingScopes(conn.scopes, 'manage').length) return { kind: 'settle', change, status: 'failed' };
    return { kind: 'send', change, token: conn.userToken, connectionId: conn.id };
  });
  if (plan.kind === 'noop') return;
  const queued = plan.change;
  if (plan.kind === 'settle') {
    await settle(accountId, queued, plan.status);
    return;
  }

  if (plan.kind === 'send') {
    try {
      await dispatchOnce(accountId, key, () => updateAdObject(queued.object_id, plan.token, changeFields(queued.field, queued.to_value)),
        { retryRejected: true });
      await settle(accountId, queued, 'applied');
      return;
    } catch (error) {
      if (!(error instanceof UncertainDispatchError)) {
        if (error instanceof MetaApiError && error.httpStatus >= 400 && error.httpStatus < 500) {
          const code = errorCodeOf(error);
          console.error('[meta-ads] ad change rejected', { code });
          // Rejected: nothing applied, the intent is 'failed' and a later attempt may claim it again.
          if (isMetaThrottle(error) && attempt && attempt.attempts < attempt.maxAttempts - 1) throw error;
          if (isMetaTokenInvalid(error)) {
            await worker(accountId, (tx) => tx.$executeRaw`
              UPDATE meta_ad_connections SET status='token_invalid', last_error_code=${code}, updated_at=now()
              WHERE account_id=${accountId}::uuid AND id=${plan.connectionId}::uuid AND status='active'`);
          }
          await settle(accountId, queued, 'failed', { errorCode: code });
          return;
        }
        throw error;
      }
      console.error('[meta-ads] ad change outcome unknown; reading it back');
    }
  }

  // The send may or may not have reached Meta: read the object back.
  try {
    const current = await getAdObject(queued.object_id, queued.level, plan.token);
    await settle(accountId, queued, current && showsValue(current, queued.field, queued.to_value) ? 'applied' : 'unknown');
  } catch (error) {
    console.error('[meta-ads] ad change read-back failed', metaErrorCode(error) ?? (error instanceof Error ? error.name : 'unknown'));
    // A later attempt reads again; the last one leaves it for an admin.
    if (!lastAttempt && !isMetaTokenInvalid(error)) throw error;
    await settle(accountId, queued, 'unknown');
  }
}

// ---------------------------------------------------------------------------
// Reconcile (admin)

async function loadOpenChange(actor: MetaAdsActor, changeId: string) {
  if (!UUID.test(changeId)) throw new MetaAdsError('not_found');
  return worker(actor.accountId, async (tx) => {
    const [row] = await tx.$queryRaw<QueuedChange[]>`SELECT id::text AS id, level, object_id, field, to_value, status
      FROM meta_ad_changes WHERE account_id=${actor.accountId}::uuid AND id=${changeId}::uuid`;
    if (!row) throw new MetaAdsError('not_found');
    if (row.status !== 'unknown') throw new MetaAdsError('invalid_request');
    const conn = await loadActiveConnectionTx(tx, actor.accountId);
    return { row, token: conn?.userToken ?? null };
  }, actor.userId);
}

/**
 * "Check with Meta": reads an 'unknown' change's object back (a read only,
 * never a send). Applied when Meta shows the new value; otherwise it stays
 * unknown and the admin may dismiss it.
 */
export async function recheckAdChange(actor: MetaAdsActor, changeId: string): Promise<AdChangeDto> {
  if (!metaAdsConfig()) throw new MetaAdsError('meta_ads_not_enabled');
  if (!hasMinRole(actor.role, 'admin')) throw new MetaAdsError('forbidden');
  const { row, token } = await loadOpenChange(actor, changeId);
  if (!token) throw new MetaAdsError('not_connected');
  let current: MetaAdObject | null;
  try {
    current = await getAdObject(row.object_id, row.level, token);
  } catch (error) {
    console.error('[meta-ads] ad change re-check failed', metaErrorCode(error) ?? (error instanceof Error ? error.name : 'unknown'));
    if (isMetaTokenInvalid(error)) throw new MetaAdsError('token_invalid');
    if (isMetaThrottle(error)) throw new MetaAdsError('rate_limited');
    throw new MetaAdsError('meta_error');
  }
  return worker(actor.accountId, async (tx) => {
    if (current && showsValue(current, row.field, row.to_value)) {
      const moved = await tx.$executeRaw`UPDATE meta_ad_changes SET resolved_by=${actor.userId}::uuid, resolved_at=now()
        WHERE account_id=${actor.accountId}::uuid AND id=${row.id}::uuid AND status='unknown'`;
      if (moved) {
        await settleTx(tx, actor.accountId, row, 'applied', { from: 'unknown' });
        await audit(tx, actor, 'meta_ads.change_recheck', row.id, { result: 'applied' });
      }
    } else {
      await audit(tx, actor, 'meta_ads.change_recheck', row.id, { result: 'not_shown' });
    }
    const [fresh] = await tx.$queryRaw<ChangeRow[]>`SELECT ${CHANGE_COLUMNS} FROM meta_ad_changes
      WHERE account_id=${actor.accountId}::uuid AND id=${row.id}::uuid`;
    return changeDto(fresh);
  }, actor.userId);
}

/** An admin closes an 'unknown' change after checking Ads Manager; a new change can then be asked for. */
export async function dismissAdChange(actor: MetaAdsActor, changeId: string): Promise<AdChangeDto> {
  if (!metaAdsConfig()) throw new MetaAdsError('meta_ads_not_enabled');
  if (!hasMinRole(actor.role, 'admin')) throw new MetaAdsError('forbidden');
  if (!UUID.test(changeId)) throw new MetaAdsError('not_found');
  return worker(actor.accountId, async (tx) => {
    const [row] = await tx.$queryRaw<ChangeRow[]>`UPDATE meta_ad_changes SET status='dismissed', resolved_by=${actor.userId}::uuid,
        resolved_at=now(), updated_at=now()
      WHERE account_id=${actor.accountId}::uuid AND id=${changeId}::uuid AND status='unknown'
      RETURNING ${CHANGE_COLUMNS}`;
    if (!row) {
      const [exists] = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM meta_ad_changes
        WHERE account_id=${actor.accountId}::uuid AND id=${changeId}::uuid`;
      throw new MetaAdsError(exists ? 'invalid_request' : 'not_found');
    }
    await audit(tx, actor, 'meta_ads.change_dismiss', row.id, {});
    return changeDto(row);
  }, actor.userId);
}

// ---------------------------------------------------------------------------
// Spending cap (admin)

/** Validates { maxDailyBudget: minor units | null }. Undefined when invalid. */
export function parseBudgetCap(body: unknown): number | null | undefined {
  if (!body || typeof body !== 'object' || !('maxDailyBudget' in body)) return undefined;
  const value = (body as { maxDailyBudget: unknown }).maxDailyBudget;
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_BUDGET_MINOR) return undefined;
  return value;
}

/** Sets or clears the workspace's maximum daily budget. */
export async function setBudgetCap(actor: MetaAdsActor, cap: number | null): Promise<number | null> {
  if (!metaAdsConfig()) throw new MetaAdsError('meta_ads_not_enabled');
  if (!hasMinRole(actor.role, 'admin')) throw new MetaAdsError('forbidden');
  return worker(actor.accountId, async (tx) => {
    const [row] = await tx.$queryRaw<{ id: string; previous: bigint | null }[]>`
      UPDATE meta_ad_connections c SET max_daily_budget_minor=${cap === null ? null : String(cap)}::bigint, updated_at=now()
      FROM (SELECT id, max_daily_budget_minor FROM meta_ad_connections
        WHERE account_id=${actor.accountId}::uuid AND status<>'disconnected' ORDER BY created_at DESC LIMIT 1 FOR UPDATE) old
      WHERE c.account_id=${actor.accountId}::uuid AND c.id=old.id
      RETURNING c.id::text AS id, old.max_daily_budget_minor AS previous`;
    if (!row) throw new MetaAdsError('not_connected');
    await audit(tx, actor, 'meta_ads.budget_cap', row.id, { from: num(row.previous), to: cap });
    return cap;
  }, actor.userId);
}
