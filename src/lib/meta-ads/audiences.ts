// Meta custom audiences (ads gaps, phase 1): a customer list built from a
// contact segment, kept in sync, and lookalikes of it. Ads can include or
// exclude them (create.ts).
//
// Request: admin routes run after the session, CSRF and admin checks; one
// worker transaction re-checks the connection, permissions and ad account,
// records the audience and queues its meta.audience_sync job.
//
// Create: the audience object is made once through an outbound intent
// (audience:<id>:create). After an unclear outcome it is looked up by name
// (names are unique per ad account): one match is adopted, otherwise the row is
// 'unknown' until an admin re-checks or removes it.
//
// Upload: segment members with a phone or email, never blocked or opted-out
// ones, are hashed (SHA-256, Meta's normalisation) and sent with Meta's replace
// call in batches of 10,000. Replace leaves the audience holding exactly the
// uploaded people, so a repeated sync is harmless and needs no intent. Raw
// phone numbers and emails never leave Bodhinox; nothing about a contact is
// logged.
//
// Engagement audiences (people who engaged with the connected Facebook Page or
// its Instagram account) and website-visitor audiences (a Meta pixel) are
// rules Meta keeps up to date itself: they are created once the same way and
// never uploaded to.
import { createHash, randomInt } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { hasMinRole } from '@/lib/auth/roles';
import { dispatchOnce, UncertainDispatchError } from '@/lib/jobs/dispatch';
import { MetaApiError } from '@/lib/whatsapp/meta-api';
import { compileAudienceFilter } from '@/lib/audience/filter';
import { loadSegmentFilter } from '@/lib/audience/segments';
import { metaAdsConfig, metaAdsManageEnabled, missingScopes } from './config';
import { loadActiveConnectionTx, MetaAdsError, type MetaAdsActor } from './connection';
import {
  createCustomerListAudience, createLookalikeAudience, createRuleAudience, findAudiencesByName, getAudienceSize, getPageInstagramAccount, hasCustomAudienceTerms,
  isMetaThrottle, isMetaTokenInvalid, metaErrorCode, replaceAudienceUsers,
} from './graph';

export const AUDIENCE_SYNC_JOB = 'meta.audience_sync';
export const AUDIENCE_SYNC_MAX_ATTEMPTS = 5;
export const MAX_AUDIENCES = 50;
export const UPLOAD_BATCH = 10_000;
// shortcut: one sync uploads at most 200,000 contacts (20 batches inside one job lease); larger lists need a resumable upload.
export const MAX_UPLOAD = 200_000;
export const AUTO_SYNC_MS = 6 * 3_600_000;
export const AUDIENCE_KINDS = ['customer_list', 'lookalike', 'engagement', 'website'] as const;
export type AudienceKind = (typeof AUDIENCE_KINDS)[number];
export type AudienceStatus = 'queued' | 'ready' | 'failed' | 'unknown';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const META_ID = /^\d{1,32}$/;
const COUNTRY = /^[A-Z]{2}$/;

// ---------------------------------------------------------------------------
// Hashing (Meta's customer-file normalisation)

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

/** Digits with the country code, no '+' or leading zeros; '' when it cannot be a phone number. */
export function hashPhone(phone: string | null | undefined): string {
  const digits = (phone ?? '').replace(/\D/g, '').replace(/^0+/, '');
  return digits.length >= 7 && digits.length <= 15 ? sha256(digits) : '';
}

/** Trimmed, lower-case; '' when it is not an email address. */
export function hashEmail(email: string | null | undefined): string {
  const value = (email ?? '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254 ? sha256(value) : '';
}

// ---------------------------------------------------------------------------
// Rows and DTOs

interface AudienceRow {
  id: string;
  connection_id: string;
  ad_account_id: string;
  kind: AudienceKind;
  name: string;
  segment_id: string | null;
  segment_name: string | null;
  origin_id: string | null;
  origin_meta_id: string | null;
  lookalike_country: string | null;
  lookalike_percent: number | null;
  rule_source: string | null;
  retention_days: number | null;
  meta_audience_id: string | null;
  status: AudienceStatus;
  auto_sync: boolean;
  uploaded_count: number | null;
  matched_lower: bigint | null;
  matched_upper: bigint | null;
  last_synced_at: Date | null;
  last_error_code: string | null;
  created_at: Date;
}

const COLUMNS = Prisma.sql`a.id::text AS id, a.connection_id::text AS connection_id, a.ad_account_id, a.kind, a.name,
  a.segment_id::text AS segment_id, s.name AS segment_name, a.origin_id::text AS origin_id, o.meta_audience_id AS origin_meta_id,
  a.lookalike_country, a.lookalike_percent, a.rule_source, a.retention_days, a.meta_audience_id, a.status, a.auto_sync, a.uploaded_count, a.matched_lower,
  a.matched_upper, a.last_synced_at, a.last_error_code, a.created_at`;
const FROM = Prisma.sql`meta_audiences a
  LEFT JOIN segments s ON s.account_id = a.account_id AND s.id = a.segment_id
  LEFT JOIN meta_audiences o ON o.account_id = a.account_id AND o.id = a.origin_id`;

export interface AudienceDto {
  id: string;
  adAccountId: string;
  kind: AudienceKind;
  name: string;
  segmentId: string | null;
  segmentName: string | null;
  originId: string | null;
  lookalikeCountry: string | null;
  lookalikePercent: number | null;
  /** Engagement and website audiences: 'page', 'instagram' or 'pixel', and the days people stay in. */
  ruleSource: 'page' | 'instagram' | 'pixel' | null;
  retentionDays: number | null;
  metaAudienceId: string | null;
  status: AudienceStatus;
  autoSync: boolean;
  uploadedCount: number | null;
  matchedLower: number | null;
  matchedUpper: number | null;
  lastSyncedAt: string | null;
  lastErrorCode: string | null;
  createdAt: string;
}

const dto = (r: AudienceRow): AudienceDto => ({
  id: r.id, adAccountId: r.ad_account_id, kind: r.kind, name: r.name, segmentId: r.segment_id, segmentName: r.segment_name,
  originId: r.origin_id, lookalikeCountry: r.lookalike_country, lookalikePercent: r.lookalike_percent,
  ruleSource: (r.rule_source?.split(':')[0] as AudienceDto['ruleSource']) ?? null, retentionDays: r.retention_days,
  metaAudienceId: r.meta_audience_id, status: r.status, autoSync: r.auto_sync, uploadedCount: r.uploaded_count,
  matchedLower: r.matched_lower === null ? null : Number(r.matched_lower),
  matchedUpper: r.matched_upper === null ? null : Number(r.matched_upper),
  lastSyncedAt: r.last_synced_at?.toISOString() ?? null, lastErrorCode: r.last_error_code, createdAt: r.created_at.toISOString(),
});

const worker = <T>(accountId: string, work: (tx: TenantTransaction) => Promise<T>, userId?: string) =>
  withTenant({ accountId, userId, role: 'owner' }, work, getWorkerPrisma());

const audit = (tx: TenantTransaction, actor: MetaAdsActor, action: string, resourceId: string, metadata: Record<string, unknown>) =>
  tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
    VALUES(${actor.accountId}::uuid,${actor.userId}::uuid,${action},${resourceId},${JSON.stringify(metadata)}::jsonb)`;

const queueSync = (tx: TenantTransaction, accountId: string, audienceId: string | null, key: string) =>
  tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,max_attempts)
    VALUES(${AUDIENCE_SYNC_JOB},${accountId}::uuid,${JSON.stringify(audienceId ? { audienceId } : {})}::jsonb,${key},
      ${AUDIENCE_SYNC_MAX_ATTEMPTS})
    ON CONFLICT(dedupe_key) DO NOTHING`;

/** Audiences need ads_management (customer lists are written to the ad account). */
export const missingAudienceScopes = (scopes: readonly string[]) => missingScopes(scopes, 'manage');

function requireAdmin(actor: MetaAdsActor): void {
  if (!metaAdsConfig()) throw new MetaAdsError('meta_ads_not_enabled');
  if (!metaAdsManageEnabled()) throw new MetaAdsError('manage_not_enabled');
  if (!hasMinRole(actor.role, 'admin')) throw new MetaAdsError('forbidden');
}

// ---------------------------------------------------------------------------
// Input

export type AudienceCreateInput =
  | { kind: 'customer_list'; adAccountId: string; name: string; segmentId: string; autoSync: boolean }
  | { kind: 'lookalike'; adAccountId: string; name: string; originId: string; country: string; percent: number }
  | { kind: 'engagement'; adAccountId: string; name: string; source: 'page' | 'instagram'; retentionDays: number }
  | { kind: 'website'; adAccountId: string; name: string; pixelId: string; retentionDays: number };

const cleanName = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/\s+/g, ' ');
  return name.length >= 1 && name.length <= 200 ? name : null;
};

export function parseAudienceCreateInput(body: unknown): AudienceCreateInput | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const name = cleanName(b.name);
  const adAccountId = typeof b.adAccountId === 'string' && META_ID.test(b.adAccountId) ? b.adAccountId : null;
  if (!name || !adAccountId) return null;
  if (b.kind === 'customer_list') {
    if (typeof b.segmentId !== 'string' || !UUID.test(b.segmentId)) return null;
    return { kind: 'customer_list', adAccountId, name, segmentId: b.segmentId, autoSync: b.autoSync !== false };
  }
  if (b.kind === 'lookalike') {
    const country = typeof b.country === 'string' ? b.country.trim().toUpperCase() : '';
    const percent = b.percent;
    if (typeof b.originId !== 'string' || !UUID.test(b.originId) || !COUNTRY.test(country)) return null;
    if (typeof percent !== 'number' || !Number.isInteger(percent) || percent < 1 || percent > 10) return null;
    return { kind: 'lookalike', adAccountId, name, originId: b.originId, country, percent };
  }
  const retentionDays = b.retentionDays;
  if (typeof retentionDays !== 'number' || !Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) return null;
  if (b.kind === 'engagement' && (b.source === 'page' || b.source === 'instagram'))
    return { kind: 'engagement', adAccountId, name, source: b.source, retentionDays };
  if (b.kind === 'website' && typeof b.pixelId === 'string' && META_ID.test(b.pixelId))
    return { kind: 'website', adAccountId, name, pixelId: b.pixelId, retentionDays };
  return null;
}

// ---------------------------------------------------------------------------
// Member and admin actions

/** Every audience of the workspace (any member). */
export async function listAudiences(actor: MetaAdsActor): Promise<AudienceDto[]> {
  return withTenant({ accountId: actor.accountId, userId: actor.userId, role: actor.role }, async (tx) => {
    const rows = await tx.$queryRaw<AudienceRow[]>`SELECT ${COLUMNS} FROM ${FROM}
      WHERE a.account_id=${actor.accountId}::uuid ORDER BY a.created_at DESC LIMIT ${MAX_AUDIENCES}`;
    return rows.map(dto);
  });
}

/** Records the audience and queues its creation (admin). */
export async function requestAudienceCreate(actor: MetaAdsActor, input: AudienceCreateInput): Promise<AudienceDto> {
  requireAdmin(actor);
  const ruleSource = input.kind === 'engagement' || input.kind === 'website' ? await resolveRuleSource(actor, input) : null;
  return worker(actor.accountId, async (tx) => {
    const [conn] = await tx.$queryRaw<{ id: string; status: string; scopes: string[] }[]>`
      SELECT id::text AS id, status, scopes FROM meta_ad_connections
      WHERE account_id=${actor.accountId}::uuid AND status<>'disconnected' LIMIT 1 FOR UPDATE`;
    if (!conn) throw new MetaAdsError('not_connected');
    if (conn.status === 'token_invalid') throw new MetaAdsError('token_invalid');
    if (conn.status !== 'active') throw new MetaAdsError('not_connected');
    if (missingAudienceScopes(conn.scopes).length) throw new MetaAdsError('missing_scope');
    const [linked] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM meta_ad_accounts
      WHERE account_id=${actor.accountId}::uuid AND connection_id=${conn.id}::uuid AND ad_account_id=${input.adAccountId}`;
    if (!linked?.n) throw new MetaAdsError('invalid_choice');
    const [count] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM meta_audiences WHERE account_id=${actor.accountId}::uuid`;
    if ((count?.n ?? 0) >= MAX_AUDIENCES) throw new MetaAdsError('limit_reached');
    const [taken] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM meta_audiences
      WHERE account_id=${actor.accountId}::uuid AND ad_account_id=${input.adAccountId} AND lower(name)=lower(${input.name})`;
    if (taken?.n) throw new MetaAdsError('name_taken');

    let inserted: { id: string }[];
    if (input.kind === 'customer_list') {
      const [segment] = await tx.$queryRaw<{ archived: boolean }[]>`SELECT archived_at IS NOT NULL AS archived FROM segments
        WHERE account_id=${actor.accountId}::uuid AND id=${input.segmentId}::uuid`;
      if (!segment || segment.archived) throw new MetaAdsError('invalid_choice');
      inserted = await tx.$queryRaw<{ id: string }[]>`INSERT INTO meta_audiences(account_id, connection_id, ad_account_id, kind,
          name, segment_id, auto_sync, created_by)
        VALUES(${actor.accountId}::uuid, ${conn.id}::uuid, ${input.adAccountId}, 'customer_list', ${input.name},
          ${input.segmentId}::uuid, ${input.autoSync}, ${actor.userId}::uuid)
        RETURNING id::text AS id`;
    } else if (input.kind === 'engagement' || input.kind === 'website') {
      inserted = await tx.$queryRaw<{ id: string }[]>`INSERT INTO meta_audiences(account_id, connection_id, ad_account_id, kind,
          name, rule_source, retention_days, auto_sync, created_by)
        VALUES(${actor.accountId}::uuid, ${conn.id}::uuid, ${input.adAccountId}, ${input.kind}, ${input.name},
          ${ruleSource}, ${input.retentionDays}, false, ${actor.userId}::uuid)
        RETURNING id::text AS id`;
    } else {
      const [origin] = await tx.$queryRaw<{ kind: string; ad_account_id: string; meta_audience_id: string | null }[]>`
        SELECT kind, ad_account_id, meta_audience_id FROM meta_audiences
        WHERE account_id=${actor.accountId}::uuid AND id=${input.originId}::uuid`;
      // A lookalike is built from a customer list Meta already has, in the same ad account.
      if (!origin || origin.kind !== 'customer_list' || origin.ad_account_id !== input.adAccountId || !origin.meta_audience_id)
        throw new MetaAdsError('invalid_choice');
      inserted = await tx.$queryRaw<{ id: string }[]>`INSERT INTO meta_audiences(account_id, connection_id, ad_account_id, kind,
          name, origin_id, lookalike_country, lookalike_percent, auto_sync, created_by)
        VALUES(${actor.accountId}::uuid, ${conn.id}::uuid, ${input.adAccountId}, 'lookalike', ${input.name},
          ${input.originId}::uuid, ${input.country}, ${input.percent}, false, ${actor.userId}::uuid)
        RETURNING id::text AS id`;
    }
    const audienceId = inserted[0].id;
    await queueSync(tx, actor.accountId, audienceId, `audience:${audienceId}`);
    await audit(tx, actor, 'meta_ads.audience_create', audienceId, { kind: input.kind, adAccountId: input.adAccountId });
    const [row] = await tx.$queryRaw<AudienceRow[]>`SELECT ${COLUMNS} FROM ${FROM}
      WHERE a.account_id=${actor.accountId}::uuid AND a.id=${audienceId}::uuid`;
    return dto(row);
  }, actor.userId);
}

/** 'page:<id>' (the connected Page), 'instagram:<id>' (its Instagram account) or 'pixel:<id>'. */
async function resolveRuleSource(actor: MetaAdsActor,
  input: Extract<AudienceCreateInput, { kind: 'engagement' | 'website' }>): Promise<string> {
  if (input.kind === 'website') return `pixel:${input.pixelId}`;
  const conn = await worker(actor.accountId, (tx) => loadActiveConnectionTx(tx, actor.accountId), actor.userId);
  if (!conn?.pageId || !conn.userToken) throw new MetaAdsError('not_connected');
  if (input.source === 'page') return `page:${conn.pageId}`;
  let igId: string | null;
  try {
    igId = await getPageInstagramAccount(conn.pageId, conn.pageToken ?? conn.userToken);
  } catch (error) {
    console.error('[meta-ads] instagram account lookup failed', metaErrorCode(error) ?? (error instanceof Error ? error.name : 'unknown'));
    throw new MetaAdsError(isMetaTokenInvalid(error) ? 'token_invalid' : isMetaThrottle(error) ? 'rate_limited' : 'meta_error');
  }
  if (!igId) throw new MetaAdsError('invalid_choice');
  return `instagram:${igId}`;
}

async function adminAudience(tx: TenantTransaction, actor: MetaAdsActor, audienceId: string): Promise<AudienceRow> {
  if (!UUID.test(audienceId)) throw new MetaAdsError('not_found');
  const [row] = await tx.$queryRaw<AudienceRow[]>`SELECT ${COLUMNS} FROM ${FROM}
    WHERE a.account_id=${actor.accountId}::uuid AND a.id=${audienceId}::uuid FOR UPDATE OF a`;
  if (!row) throw new MetaAdsError('not_found');
  return row;
}

const reread = async (tx: TenantTransaction, accountId: string, audienceId: string) =>
  dto((await tx.$queryRaw<AudienceRow[]>`SELECT ${COLUMNS} FROM ${FROM}
    WHERE a.account_id=${accountId}::uuid AND a.id=${audienceId}::uuid`)[0]);

/** Queues a customer-list upload now (admin). Repeated clicks within a minute queue one job. */
export async function requestAudienceSync(actor: MetaAdsActor, audienceId: string, now: number = Date.now()): Promise<AudienceDto> {
  requireAdmin(actor);
  return worker(actor.accountId, async (tx) => {
    const row = await adminAudience(tx, actor, audienceId);
    if (row.kind !== 'customer_list' || !row.meta_audience_id || row.status === 'unknown' || row.status === 'queued')
      throw new MetaAdsError('invalid_request');
    await tx.$executeRaw`UPDATE meta_audiences SET status='queued', last_error_code=NULL, updated_at=now()
      WHERE account_id=${actor.accountId}::uuid AND id=${audienceId}::uuid`;
    await queueSync(tx, actor.accountId, audienceId, `audsync:${audienceId}:${Math.floor(now / 60_000)}`);
    await audit(tx, actor, 'meta_ads.audience_sync', audienceId, {});
    return reread(tx, actor.accountId, audienceId);
  }, actor.userId);
}

/** Turns the 6-hourly upload of a customer list on or off (admin). */
export async function setAudienceAutoSync(actor: MetaAdsActor, audienceId: string, autoSync: boolean): Promise<AudienceDto> {
  requireAdmin(actor);
  return worker(actor.accountId, async (tx) => {
    const row = await adminAudience(tx, actor, audienceId);
    if (row.kind !== 'customer_list') throw new MetaAdsError('invalid_request');
    await tx.$executeRaw`UPDATE meta_audiences SET auto_sync=${autoSync}, updated_at=now()
      WHERE account_id=${actor.accountId}::uuid AND id=${audienceId}::uuid`;
    await audit(tx, actor, 'meta_ads.audience_auto_sync', audienceId, { autoSync });
    return reread(tx, actor.accountId, audienceId);
  }, actor.userId);
}

/**
 * Stops tracking an audience in Bodhinox (admin); its lookalikes go with it.
 * The audience stays in the Meta ad account, where ads may still use it.
 */
export async function removeAudience(actor: MetaAdsActor, audienceId: string): Promise<void> {
  requireAdmin(actor);
  await worker(actor.accountId, async (tx) => {
    const row = await adminAudience(tx, actor, audienceId);
    await tx.$executeRaw`DELETE FROM meta_audiences WHERE account_id=${actor.accountId}::uuid AND id=${audienceId}::uuid`;
    await audit(tx, actor, 'meta_ads.audience_remove', audienceId, { kind: row.kind, metaAudienceId: row.meta_audience_id });
  }, actor.userId);
}

/** An 'unknown' audience: looks it up by name again (a read); one match is adopted and its upload queued. */
export async function recheckAudience(actor: MetaAdsActor, audienceId: string): Promise<AudienceDto> {
  requireAdmin(actor);
  const { row, token } = await worker(actor.accountId, async (tx) => ({
    row: await adminAudience(tx, actor, audienceId), token: (await loadActiveConnectionTx(tx, actor.accountId))?.userToken ?? null,
  }), actor.userId);
  if (row.status !== 'unknown' || row.meta_audience_id) return dto(row);
  if (!token) throw new MetaAdsError('not_connected');
  let found: string[];
  try {
    found = await findAudiencesByName(row.ad_account_id, token, row.name);
  } catch (error) {
    console.error('[meta-ads] audience re-check failed', metaErrorCode(error) ?? 'unknown');
    if (isMetaTokenInvalid(error)) throw new MetaAdsError('token_invalid');
    if (isMetaThrottle(error)) throw new MetaAdsError('rate_limited');
    throw new MetaAdsError('meta_error');
  }
  return worker(actor.accountId, async (tx) => {
    if (found.length === 1) {
      await tx.$executeRaw`UPDATE meta_audiences SET meta_audience_id=${found[0]}, status='queued', last_error_code=NULL, updated_at=now()
        WHERE account_id=${actor.accountId}::uuid AND id=${audienceId}::uuid AND status='unknown' AND meta_audience_id IS NULL`;
      await queueSync(tx, actor.accountId, audienceId, `audience:${audienceId}:resume`);
    }
    await audit(tx, actor, 'meta_ads.audience_recheck', audienceId, { adopted: found.length === 1 });
    return reread(tx, actor.accountId, audienceId);
  }, actor.userId);
}

// ---------------------------------------------------------------------------
// The job

const errorCode = (error: unknown): string | null => {
  const code = metaErrorCode(error);
  return code && /^[0-9:]{1,40}$/.test(code) ? code : error instanceof MetaApiError ? String(error.httpStatus).slice(0, 40) : null;
};

async function settle(accountId: string, audienceId: string, status: 'failed' | 'unknown', code: string | null): Promise<void> {
  await worker(accountId, (tx) => tx.$executeRaw`UPDATE meta_audiences SET status=${status}, last_error_code=${code}, updated_at=now()
    WHERE account_id=${accountId}::uuid AND id=${audienceId}::uuid`);
}

async function adopt(accountId: string, audienceId: string, metaAudienceId: string): Promise<void> {
  await worker(accountId, (tx) => tx.$executeRaw`UPDATE meta_audiences SET meta_audience_id=${metaAudienceId}, updated_at=now()
    WHERE account_id=${accountId}::uuid AND id=${audienceId}::uuid AND meta_audience_id IS NULL`);
}

/** Uploads the segment's reachable members with Meta's replace call; returns how many rows were sent. */
async function uploadSegment(accountId: string, row: AudienceRow, token: string): Promise<number | 'segment_missing' | 'empty_segment'> {
  const plan = await worker(accountId, async (tx) => {
    if (!row.segment_id) return null;
    const filter = await loadSegmentFilter(tx, accountId, row.segment_id).catch(() => null);
    if (!filter) return null;
    const where = Prisma.sql`${compileAudienceFilter(accountId, filter)} AND c.opted_out_at IS NULL AND c.blocked_at IS NULL
      AND (c.phone IS NOT NULL OR c.email IS NOT NULL)`;
    const [count] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM contacts c WHERE ${where}`;
    return { where, total: Math.min(count?.n ?? 0, MAX_UPLOAD) };
  });
  if (!plan) return 'segment_missing';
  if (!plan.total) return 'empty_segment';
  const sessionId = randomInt(1, 2 ** 47);
  const batches = Math.ceil(plan.total / UPLOAD_BATCH);
  let after = '00000000-0000-0000-0000-000000000000';
  let sent = 0;
  for (let batch = 1; batch <= batches; batch++) {
    const contacts = await worker(accountId, (tx) => tx.$queryRaw<{ id: string; phone: string | null; email: string | null }[]>`
      SELECT c.id::text AS id, c.phone, c.email FROM contacts c WHERE ${plan.where} AND c.id > ${after}::uuid
      ORDER BY c.id LIMIT ${Math.min(UPLOAD_BATCH, plan.total - sent)}`);
    const last = batch === batches || contacts.length < UPLOAD_BATCH;
    const rows = contacts.map((c) => [hashPhone(c.phone), hashEmail(c.email)] as [string, string])
      .filter(([phone, email]) => phone || email);
    await replaceAudienceUsers(row.meta_audience_id!, token, { sessionId, batch, last, estimatedTotal: plan.total }, rows);
    sent += contacts.length;
    after = contacts.at(-1)?.id ?? after;
    if (last) break;
  }
  return sent;
}

function createOne(row: AudienceRow, token: string): Promise<{ id: string }> {
  if (row.kind === 'customer_list') return createCustomerListAudience(row.ad_account_id, token, row.name);
  if (row.kind === 'lookalike') {
    return createLookalikeAudience(row.ad_account_id, token, {
      name: row.name, originAudienceId: row.origin_meta_id!, country: row.lookalike_country!, percent: row.lookalike_percent!,
    });
  }
  const [type, id] = (row.rule_source ?? '').split(':') as ['page' | 'instagram' | 'pixel', string];
  return createRuleAudience(row.ad_account_id, token, { name: row.name, source: { type, id }, retentionDays: row.retention_days ?? 30 });
}

async function syncOne(accountId: string, audienceId: string, lastAttempt: boolean): Promise<void> {
  const state = await worker(accountId, async (tx) => {
    const [row] = await tx.$queryRaw<AudienceRow[]>`SELECT ${COLUMNS} FROM ${FROM}
      WHERE a.account_id=${accountId}::uuid AND a.id=${audienceId}::uuid`;
    if (!row || row.status === 'unknown') return null;
    const [intent] = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM outbound_intents
      WHERE account_id=${accountId}::uuid AND idempotency_key=${`${accountId}:audience:${audienceId}:create`}`;
    const conn = await loadActiveConnectionTx(tx, accountId);
    return { row, intent: intent?.status ?? null, conn };
  });
  if (!state) return;
  const { row, intent, conn } = state;
  const claimed = !row.meta_audience_id && (intent === 'dispatching' || intent === 'unknown');
  if (!conn?.userToken || conn.id !== row.connection_id) return settle(accountId, audienceId, claimed ? 'unknown' : 'failed', 'not_connected');
  const token = conn.userToken;

  try {
    if (!row.meta_audience_id) {
      if (claimed) {
        const found = await findAudiencesByName(row.ad_account_id, token, row.name);
        if (found.length !== 1) return settle(accountId, audienceId, 'unknown', null);
        await adopt(accountId, audienceId, found[0]);
        row.meta_audience_id = found[0];
      } else {
        if (lastAttempt && intent !== 'accepted') return settle(accountId, audienceId, 'failed', 'attempts_exhausted');
        if (!metaAdsManageEnabled() || missingAudienceScopes(conn.scopes).length) return settle(accountId, audienceId, 'failed', 'missing_scope');
        if (row.kind === 'customer_list' && !(await hasCustomAudienceTerms(row.ad_account_id, token)))
          return settle(accountId, audienceId, 'failed', 'terms_not_accepted');
        if (row.kind === 'lookalike' && !row.origin_meta_id) return settle(accountId, audienceId, 'failed', 'origin_missing');
        try {
          const result = await dispatchOnce(accountId, `audience:${audienceId}:create`, () => createOne(row, token), { retryRejected: true });
          await adopt(accountId, audienceId, result.id);
          row.meta_audience_id = result.id;
        } catch (error) {
          if (!(error instanceof UncertainDispatchError)) throw error;
          console.error('[meta-ads] audience create outcome unknown; looking it up');
          const found = await findAudiencesByName(row.ad_account_id, token, row.name).catch(() => []);
          if (found.length !== 1) return settle(accountId, audienceId, 'unknown', null);
          await adopt(accountId, audienceId, found[0]);
          row.meta_audience_id = found[0];
        }
      }
    }

    let uploaded: number | null = null;
    let note: string | null = null;
    if (row.kind === 'customer_list') {
      if (!(await hasCustomAudienceTerms(row.ad_account_id, token))) return settle(accountId, audienceId, 'failed', 'terms_not_accepted');
      const result = await uploadSegment(accountId, row, token);
      if (result === 'segment_missing') return settle(accountId, audienceId, 'failed', 'segment_missing');
      // shortcut: an emptied segment leaves Meta's last upload in place (replace needs at least one row).
      if (result === 'empty_segment') { uploaded = 0; note = 'empty_segment'; } else uploaded = result;
    }
    const size = await getAudienceSize(row.meta_audience_id!, token).catch(() => ({ lower: null, upper: null }));
    await worker(accountId, (tx) => tx.$executeRaw`UPDATE meta_audiences SET status='ready',
        uploaded_count=COALESCE(${uploaded}::int, uploaded_count), matched_lower=${size.lower}, matched_upper=${size.upper},
        last_synced_at=now(), last_error_code=${note}, updated_at=now()
      WHERE account_id=${accountId}::uuid AND id=${audienceId}::uuid`);
  } catch (error) {
    if (error instanceof MetaApiError && error.httpStatus >= 400 && error.httpStatus < 500) {
      const code = errorCode(error);
      console.error('[meta-ads] audience sync rejected', { code });
      if (isMetaThrottle(error) && !lastAttempt) throw error;
      if (isMetaTokenInvalid(error)) {
        await worker(accountId, (tx) => tx.$executeRaw`UPDATE meta_ad_connections SET status='token_invalid',
            last_error_code=${code}, updated_at=now()
          WHERE account_id=${accountId}::uuid AND id=${conn.id}::uuid AND status='active'`);
      }
      return settle(accountId, audienceId, 'failed', code);
    }
    if (lastAttempt) return settle(accountId, audienceId, row.meta_audience_id ? 'failed' : 'unknown', 'attempts_exhausted');
    throw error;
  }
}

/**
 * meta.audience_sync. With an audienceId: creates that audience if needed and
 * uploads it. Without one (the 6-hourly schedule): uploads every auto-sync
 * customer list of the workspace that Meta already has.
 */
export async function handleAudienceSyncJob(accountId: string, payload: Record<string, unknown>,
  attempt?: { attempts: number; maxAttempts: number }): Promise<void> {
  if (!metaAdsConfig()) return;
  const lastAttempt = !!attempt && attempt.maxAttempts > 1 && attempt.attempts >= attempt.maxAttempts;
  if (payload.audienceId !== undefined) {
    if (typeof payload.audienceId !== 'string' || !UUID.test(payload.audienceId)) throw new Error('Invalid audience sync job');
    return syncOne(accountId, payload.audienceId, lastAttempt);
  }
  if (!metaAdsManageEnabled()) return;
  const due = await worker(accountId, (tx) => tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM meta_audiences
    WHERE account_id=${accountId}::uuid AND kind='customer_list' AND auto_sync AND meta_audience_id IS NOT NULL
      AND status IN ('ready','failed') ORDER BY last_synced_at NULLS FIRST LIMIT ${MAX_AUDIENCES}`);
  for (const { id } of due) await syncOne(accountId, id, lastAttempt);
}

export function audienceAutoSyncDedupeKey(accountId: string, now: number): string {
  return `meta-audiences:${accountId}:${Math.floor(now / AUTO_SYNC_MS)}`;
}
