// The ad accounts a workspace reports on and manages (ads module, part D).
//
// One Facebook login (meta_ad_connections) can see several ad accounts. The
// one chosen when connecting is the primary; admins add more from the ones the
// same login can see, up to MAX_AD_ACCOUNTS. The worker syncs every linked ad
// account; reports and the campaign tree filter by one or show them all.
//
// Writes run as the worker after the route's session, CSRF and admin checks
// (members only read). Meta is called outside any transaction, and only to
// re-check that an added ad account is one this login can see.
import { Prisma } from '@prisma/client';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { hasMinRole } from '@/lib/auth/roles';
import { decrypt } from '@/lib/whatsapp/encryption';
import { metaAdsConfig } from './config';
import { MetaAdsError, type MetaAdsActor } from './connection';
import { isMetaThrottle, isMetaTokenInvalid, listAdAccounts as graphAdAccounts, metaErrorCode } from './graph';

export const MAX_AD_ACCOUNTS = 10;
const META_ID = /^\d{1,32}$/;

export interface LinkedAdAccount {
  adAccountId: string;
  name: string | null;
  currency: string | null;
  isPrimary: boolean;
  insightsSyncedAt: string | null;
  lastErrorCode: string | null;
}

export interface AvailableAdAccount { adAccountId: string; name: string | null; currency: string | null }

const worker = <T>(actor: MetaAdsActor, work: (tx: TenantTransaction) => Promise<T>) =>
  withTenant({ accountId: actor.accountId, userId: actor.userId, role: 'owner' }, work, getWorkerPrisma());

/**
 * The ad account ids a connection syncs: its linked ones, primary first; the
 * connection's own ad account when none is linked yet (a row written before
 * the accounts table existed is backfilled by the migration, so this is a
 * safety net).
 */
export async function syncedAdAccountsTx(tx: TenantTransaction, accountId: string,
  connection: { id: string; adAccountId: string | null }): Promise<string[]> {
  const rows = await tx.$queryRaw<{ ad_account_id: string }[]>`SELECT ad_account_id FROM meta_ad_accounts
    WHERE account_id=${accountId}::uuid AND connection_id=${connection.id}::uuid
    ORDER BY is_primary DESC, added_at, ad_account_id`;
  const ids = rows.map((r) => r.ad_account_id).filter((id) => META_ID.test(id));
  if (ids.length) return ids;
  return connection.adAccountId && META_ID.test(connection.adAccountId) ? [connection.adAccountId] : [];
}

/**
 * Inside finishConnection's transaction: the chosen ad account becomes the
 * only primary; rows of an earlier connection go (a reconnect starts clean).
 */
export async function setPrimaryAdAccountTx(tx: TenantTransaction, accountId: string, input: {
  connectionId: string; adAccountId: string; name: string | null; currency: string | null; businessId: string | null; userId: string;
}): Promise<void> {
  await tx.$executeRaw`DELETE FROM meta_ad_accounts WHERE account_id=${accountId}::uuid AND connection_id <> ${input.connectionId}::uuid`;
  await tx.$executeRaw`UPDATE meta_ad_accounts SET is_primary=false
    WHERE account_id=${accountId}::uuid AND is_primary AND ad_account_id <> ${input.adAccountId}`;
  await tx.$executeRaw`INSERT INTO meta_ad_accounts(account_id, connection_id, ad_account_id, name, currency, business_id, is_primary, added_by)
    VALUES(${accountId}::uuid, ${input.connectionId}::uuid, ${input.adAccountId}, ${input.name}, ${input.currency},
      ${input.businessId}, true, ${input.userId}::uuid)
    ON CONFLICT (account_id, ad_account_id) DO UPDATE SET connection_id=EXCLUDED.connection_id, name=EXCLUDED.name,
      currency=EXCLUDED.currency, business_id=EXCLUDED.business_id, is_primary=true`;
}

const dto = (r: {
  ad_account_id: string; name: string | null; currency: string | null; is_primary: boolean;
  insights_synced_at: Date | null; last_error_code: string | null;
}): LinkedAdAccount => ({
  adAccountId: r.ad_account_id, name: r.name, currency: r.currency, isPrimary: r.is_primary,
  insightsSyncedAt: r.insights_synced_at?.toISOString() ?? null, lastErrorCode: r.last_error_code,
});

/** The live connection's linked ad accounts, primary first. Any member; app-role read. */
export async function listLinkedAdAccounts(actor: MetaAdsActor): Promise<LinkedAdAccount[]> {
  return withTenant({ accountId: actor.accountId, userId: actor.userId, role: actor.role }, async (tx) => {
    const rows = await tx.$queryRaw<Parameters<typeof dto>[0][]>`
      SELECT a.ad_account_id, a.name, a.currency, a.is_primary, a.insights_synced_at, a.last_error_code
      FROM meta_ad_accounts a JOIN meta_ad_connections c ON c.account_id = a.account_id AND c.id = a.connection_id
      WHERE a.account_id=${actor.accountId}::uuid AND c.status IN ('active','token_invalid')
      ORDER BY a.is_primary DESC, a.added_at, a.ad_account_id`;
    return rows.map(dto);
  });
}

function requireAdmin(actor: MetaAdsActor): void {
  if (!metaAdsConfig()) throw new MetaAdsError('meta_ads_not_enabled');
  if (!hasMinRole(actor.role, 'admin')) throw new MetaAdsError('forbidden');
}

async function activeToken(actor: MetaAdsActor): Promise<{ id: string; token: string }> {
  const row = await worker(actor, async (tx) => (await tx.$queryRaw<{ id: string; status: string; user_token_enc: string }[]>`
    SELECT id::text AS id, status, user_token_enc FROM meta_ad_connections
    WHERE account_id=${actor.accountId}::uuid AND status<>'disconnected' LIMIT 1`)[0] ?? null);
  if (!row) throw new MetaAdsError('not_connected');
  if (row.status === 'token_invalid') throw new MetaAdsError('token_invalid');
  if (row.status !== 'active' || !row.user_token_enc) throw new MetaAdsError('not_connected');
  return { id: row.id, token: decrypt(row.user_token_enc) };
}

async function seeAdAccounts(token: string) {
  try {
    return await graphAdAccounts(token);
  } catch (error) {
    console.error('[meta-ads] ad account list failed', metaErrorCode(error) ?? (error instanceof Error ? error.name : 'unknown'));
    if (isMetaTokenInvalid(error)) throw new MetaAdsError('token_invalid');
    if (isMetaThrottle(error)) throw new MetaAdsError('rate_limited');
    throw new MetaAdsError('meta_error');
  }
}

/** Ad accounts this login can see that are not linked yet (admin). */
export async function listAvailableAdAccounts(actor: MetaAdsActor): Promise<AvailableAdAccount[]> {
  requireAdmin(actor);
  const { token } = await activeToken(actor);
  const [seen, linked] = await Promise.all([seeAdAccounts(token), listLinkedAdAccounts(actor)]);
  const have = new Set(linked.map((a) => a.adAccountId));
  return seen.filter((a) => !have.has(a.id)).map((a) => ({ adAccountId: a.id, name: a.name, currency: a.currency }));
}

const queueSyncsTx = (tx: TenantTransaction, accountId: string, key: string) => tx.$executeRaw`
  INSERT INTO jobs(type,tenant_id,payload,dedupe_key,max_attempts) VALUES
    ('meta.insights_sync',${accountId}::uuid,'{"full":true}'::jsonb,${`meta-insights-account:${key}`},3),
    ('meta.ad_objects_sync',${accountId}::uuid,'{}'::jsonb,${`meta-ad-objects-account:${key}`},3)
  ON CONFLICT(dedupe_key) DO NOTHING`;

/** Links another ad account the login can see, then syncs it (admin). */
export async function addAdAccount(actor: MetaAdsActor, adAccountId: string): Promise<LinkedAdAccount[]> {
  requireAdmin(actor);
  if (!META_ID.test(adAccountId)) throw new MetaAdsError('invalid_choice');
  const connection = await activeToken(actor);
  const account = (await seeAdAccounts(connection.token)).find((a) => a.id === adAccountId);
  if (!account) throw new MetaAdsError('invalid_choice');
  await worker(actor, async (tx) => {
    // Locks the connection row: concurrent adds count the same rows.
    const live = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM meta_ad_connections
      WHERE account_id=${actor.accountId}::uuid AND id=${connection.id}::uuid AND status='active' FOR UPDATE`;
    if (!live[0]) throw new MetaAdsError('not_connected');
    const [{ n }] = await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM meta_ad_accounts
      WHERE account_id=${actor.accountId}::uuid AND connection_id=${connection.id}::uuid AND ad_account_id <> ${adAccountId}`;
    if (Number(n) >= MAX_AD_ACCOUNTS) throw new MetaAdsError('invalid_choice');
    await tx.$executeRaw`INSERT INTO meta_ad_accounts(account_id, connection_id, ad_account_id, name, currency, business_id, added_by)
      VALUES(${actor.accountId}::uuid, ${connection.id}::uuid, ${adAccountId}, ${account.name}, ${account.currency},
        ${account.businessId}, ${actor.userId}::uuid)
      ON CONFLICT (account_id, ad_account_id) DO UPDATE SET name=EXCLUDED.name, currency=EXCLUDED.currency`;
    await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
      VALUES(${actor.accountId}::uuid,${actor.userId}::uuid,'meta_ads.ad_account_add',${connection.id},
        ${JSON.stringify({ adAccountId })}::jsonb)`;
    await queueSyncsTx(tx, actor.accountId, `${actor.accountId}:${adAccountId}:${Date.now()}`);
  });
  return listLinkedAdAccounts(actor);
}

/**
 * Unlinks a secondary ad account and drops what was synced for it (admin).
 * The primary stays: changing it means reconnecting. Changes already sent to
 * Meta stay in the history.
 */
export async function removeAdAccount(actor: MetaAdsActor, adAccountId: string): Promise<LinkedAdAccount[]> {
  requireAdmin(actor);
  if (!META_ID.test(adAccountId)) throw new MetaAdsError('invalid_choice');
  await worker(actor, async (tx) => {
    const [row] = await tx.$queryRaw<{ is_primary: boolean; connection_id: string }[]>`
      SELECT is_primary, connection_id::text AS connection_id FROM meta_ad_accounts
      WHERE account_id=${actor.accountId}::uuid AND ad_account_id=${adAccountId} FOR UPDATE`;
    if (!row) throw new MetaAdsError('not_found');
    if (row.is_primary) throw new MetaAdsError('invalid_choice');
    const scope = Prisma.sql`account_id=${actor.accountId}::uuid AND ad_account_id=${adAccountId}`;
    await tx.$executeRaw`DELETE FROM meta_ad_insights WHERE ${scope}`;
    await tx.$executeRaw`DELETE FROM meta_ad_insight_platforms WHERE ${scope}`;
    await tx.$executeRaw`DELETE FROM meta_ad_reach WHERE ${scope}`;
    await tx.$executeRaw`DELETE FROM meta_ad_objects WHERE ${scope}`;
    await tx.$executeRaw`DELETE FROM meta_ad_accounts WHERE ${scope}`;
    await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
      VALUES(${actor.accountId}::uuid,${actor.userId}::uuid,'meta_ads.ad_account_remove',${row.connection_id},
        ${JSON.stringify({ adAccountId })}::jsonb)`;
  });
  return listLinkedAdAccounts(actor);
}

/** A query's ad account filter: a linked id, or null for all. Throws for a malformed id. */
export function parseAdAccountFilter(value: string | null): string | null {
  if (value === null || value === '' || value === 'all') return null;
  if (!META_ID.test(value)) throw new MetaAdsError('invalid_request');
  return value;
}
