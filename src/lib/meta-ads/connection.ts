// Meta ad account + Page connection (part a).
//
// Flow: startConnection checks the Login for Business popup's user token belongs
// to this app, makes it long-lived and stores it encrypted on the workspace's
// pending row; listChoices offers the
// ad accounts and Pages that token can see; finishConnection activates the
// chosen pair (after the cross-workspace Page check) and subscribes the Page to
// leadgen; disconnect unsubscribes the Page and clears both tokens. Every write
// goes through the worker inside withTenant after the caller's admin check
// (the app role cannot read or write the token columns). Meta is never called
// inside an open transaction. Tokens never leave this module except to
// graph.ts calls; the DTO is built from an explicit column list that holds no
// token and no click id.
// shortcut: one live connection per workspace (partial unique index); multiple
// ad accounts or Pages per workspace are not supported yet.
import { requireIntegrationRoom } from '@/lib/billing/limits';
import { Prisma } from '@prisma/client';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { hasMinRole, type AccountRole } from '@/lib/auth/roles';
import { decrypt, encrypt } from '@/lib/whatsapp/encryption';
import { metaAdsConfig, missingScopes, type MetaAdsConfig } from './config';
import {
  exchangeLoginToken, getGrantedScopes, getOrCreateDataset, isMetaThrottle, isMetaTokenInvalid, listAdAccounts, listPages,
  metaErrorCode, subscribePageLeadgen, unsubscribePage,
} from './graph';
import { setPrimaryAdAccountTx } from './accounts';

export interface MetaAdsActor {
  accountId: string;
  userId: string;
  role: AccountRole;
}

export type MetaAdConnectionStatus = 'pending' | 'active' | 'token_invalid' | 'disconnected';

/** Every column the app role may read (never user_token_enc or page_token_enc). */
export const CONNECTION_PUBLIC_COLUMNS = [
  'id', 'status', 'business_id', 'ad_account_id', 'ad_account_name', 'ad_account_currency', 'page_id', 'page_name',
  'token_expires_at', 'scopes', 'page_subscribed_at', 'capi_enabled', 'capi_dataset_id', 'capi_whatsapp_config_id',
  'capi_waba_id', 'capi_auto_purchase', 'capi_auto_lead', 'insights_synced_at', 'leads_synced_at', 'last_error_code',
  'connected_at', 'disconnected_at',
] as const;

export interface MetaAdConnectionRow {
  id: string;
  status: MetaAdConnectionStatus;
  business_id: string | null;
  ad_account_id: string | null;
  ad_account_name: string | null;
  ad_account_currency: string | null;
  page_id: string | null;
  page_name: string | null;
  token_expires_at: Date | null;
  scopes: string[];
  page_subscribed_at: Date | null;
  capi_enabled: boolean;
  capi_dataset_id: string | null;
  capi_whatsapp_config_id: string | null;
  capi_waba_id: string | null;
  capi_auto_purchase: boolean;
  capi_auto_lead: boolean;
  insights_synced_at: Date | null;
  leads_synced_at: Date | null;
  last_error_code: string | null;
  connected_at: Date | null;
  disconnected_at: Date | null;
}

export interface MetaAdConnectionDto {
  id: string;
  status: MetaAdConnectionStatus;
  businessId: string | null;
  adAccountId: string | null;
  adAccountName: string | null;
  adAccountCurrency: string | null;
  pageId: string | null;
  pageName: string | null;
  tokenExpiresAt: string | null;
  scopes: string[];
  pageSubscribedAt: string | null;
  capiEnabled: boolean;
  capiDatasetId: string | null;
  capiWhatsappConfigId: string | null;
  capiAutoPurchase: boolean;
  capiAutoLead: boolean;
  insightsSyncedAt: string | null;
  leadsSyncedAt: string | null;
  lastErrorCode: string | null;
  connectedAt: string | null;
}

const iso = (value: Date | null) => (value ? value.toISOString() : null);

/** The browser view of a connection: an explicit field list, never a token. */
export function toDto(row: MetaAdConnectionRow): MetaAdConnectionDto {
  return {
    id: row.id,
    status: row.status,
    businessId: row.business_id,
    adAccountId: row.ad_account_id,
    adAccountName: row.ad_account_name,
    adAccountCurrency: row.ad_account_currency,
    pageId: row.page_id,
    pageName: row.page_name,
    tokenExpiresAt: iso(row.token_expires_at),
    scopes: [...row.scopes],
    pageSubscribedAt: iso(row.page_subscribed_at),
    capiEnabled: row.capi_enabled,
    capiDatasetId: row.capi_dataset_id,
    capiWhatsappConfigId: row.capi_whatsapp_config_id,
    capiAutoPurchase: row.capi_auto_purchase,
    capiAutoLead: row.capi_auto_lead,
    insightsSyncedAt: iso(row.insights_synced_at),
    leadsSyncedAt: iso(row.leads_synced_at),
    lastErrorCode: row.last_error_code,
    connectedAt: iso(row.connected_at),
  };
}

export interface ActiveConnectionSecrets {
  id: string;
  adAccountId: string | null;
  pageId: string | null;
  scopes: string[];
  capiEnabled: boolean;
  capiDatasetId: string | null;
  capiWhatsappConfigId: string | null;
  capiWabaId: string | null;
  insightsSyncedAt: Date | null;
  leadsSyncedAt: Date | null;
  /** Decrypted; null when cleared. Server-side Graph calls only. */
  userToken: string | null;
  pageToken: string | null;
}

/**
 * The workspace's `active` connection with decrypted tokens, or null. WORKER
 * transactions only (the app role cannot read the token columns). Callers must
 * close the transaction before calling Meta.
 */
export async function loadActiveConnectionTx(tx: TenantTransaction, accountId: string): Promise<ActiveConnectionSecrets | null> {
  const rows = await tx.$queryRaw<{
    id: string; ad_account_id: string | null; page_id: string | null; scopes: string[]; capi_enabled: boolean;
    capi_dataset_id: string | null; capi_whatsapp_config_id: string | null; capi_waba_id: string | null;
    insights_synced_at: Date | null; leads_synced_at: Date | null; user_token_enc: string; page_token_enc: string;
  }[]>`SELECT id::text AS id, ad_account_id, page_id, scopes, capi_enabled, capi_dataset_id,
      capi_whatsapp_config_id::text AS capi_whatsapp_config_id, capi_waba_id, insights_synced_at, leads_synced_at,
      user_token_enc, page_token_enc
    FROM meta_ad_connections WHERE account_id=${accountId}::uuid AND status='active' LIMIT 1`;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    adAccountId: row.ad_account_id,
    pageId: row.page_id,
    scopes: row.scopes,
    capiEnabled: row.capi_enabled,
    capiDatasetId: row.capi_dataset_id,
    capiWhatsappConfigId: row.capi_whatsapp_config_id,
    capiWabaId: row.capi_waba_id,
    insightsSyncedAt: row.insights_synced_at,
    leadsSyncedAt: row.leads_synced_at,
    userToken: row.user_token_enc ? decrypt(row.user_token_enc) : null,
    pageToken: row.page_token_enc ? decrypt(row.page_token_enc) : null,
  };
}


export interface ConnectionChoices {
  adAccounts: { id: string; name: string | null; currency: string | null }[];
  pages: { id: string; name: string | null }[];
}

export type MetaAdsErrorCode =
  | 'meta_ads_not_enabled' | 'forbidden' | 'invalid_request' | 'not_connected' | 'already_connected' | 'page_in_use'
  | 'token_invalid' | 'invalid_choice' | 'invalid_number' | 'missing_scope' | 'revoke_failed' | 'meta_error' | 'rate_limited'
  | 'manage_not_enabled' | 'change_pending' | 'over_budget_cap' | 'not_found';

const STATUS: Record<MetaAdsErrorCode, number> = {
  meta_ads_not_enabled: 503, forbidden: 403, invalid_request: 400, not_connected: 404, already_connected: 409,
  page_in_use: 409, token_invalid: 409, invalid_choice: 400, invalid_number: 400, missing_scope: 409,
  revoke_failed: 502, meta_error: 502, rate_limited: 429,
  manage_not_enabled: 503, change_pending: 409, over_budget_cap: 422, not_found: 404,
};

/** An expected failure with a fixed code (never Meta's message). */
export class MetaAdsError extends Error {
  readonly status: number;
  constructor(readonly code: MetaAdsErrorCode) {
    super(`Meta ads: ${code}`);
    this.name = 'MetaAdsError';
    this.status = STATUS[code];
  }
}

const META_ID = /^\d{1,32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PUBLIC_SELECT = Prisma.raw(CONNECTION_PUBLIC_COLUMNS.map((c) =>
  c === 'id' || c === 'capi_whatsapp_config_id' ? `${c}::text AS ${c}` : c).join(', '));

function requireConfig(): MetaAdsConfig {
  const config = metaAdsConfig();
  if (!config) throw new MetaAdsError('meta_ads_not_enabled');
  return config;
}

function requireAdmin(actor: MetaAdsActor): void {
  if (!hasMinRole(actor.role, 'admin')) throw new MetaAdsError('forbidden');
}

/** Writes and token reads run as the worker, scoped to the actor's workspace. */
const asWorker = <T>(actor: MetaAdsActor, work: (tx: TenantTransaction) => Promise<T>) =>
  withTenant({ accountId: actor.accountId, userId: actor.userId, role: 'owner' }, work, getWorkerPrisma());

/** Maps a failed Graph call to a fixed code; only Meta's code[:subcode] is ever logged. */
async function meta<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    console.error('[meta-ads] Graph call failed', metaErrorCode(error) ?? (error instanceof Error ? error.name : 'unknown'));
    if (isMetaTokenInvalid(error)) throw new MetaAdsError('token_invalid');
    if (isMetaThrottle(error)) throw new MetaAdsError('rate_limited');
    throw new MetaAdsError('meta_error');
  }
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: unknown; meta?: { code?: unknown }; message?: unknown };
  return e.code === '23505' || e.meta?.code === '23505' || (typeof e.message === 'string' && e.message.includes('23505'));
}

const audit = (tx: TenantTransaction, actor: MetaAdsActor, action: string, resourceId: string, metadata: Record<string, unknown>) =>
  tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
    VALUES(${actor.accountId}::uuid,${actor.userId}::uuid,${action},${resourceId},${JSON.stringify(metadata)}::jsonb)`;

async function liveRowTx(tx: TenantTransaction, accountId: string): Promise<MetaAdConnectionRow | null> {
  const rows = await tx.$queryRaw<MetaAdConnectionRow[]>`SELECT ${PUBLIC_SELECT} FROM meta_ad_connections
    WHERE account_id=${accountId}::uuid AND status<>'disconnected' ORDER BY created_at DESC LIMIT 1`;
  return rows[0] ?? null;
}

/** The workspace's live connection (pending, active or token_invalid), read as the member's app role. */
export async function getConnection(actor: MetaAdsActor): Promise<MetaAdConnectionDto | null> {
  const row = await withTenant({ accountId: actor.accountId, userId: actor.userId, role: actor.role },
    (tx) => liveRowTx(tx, actor.accountId));
  return row ? toDto(row) : null;
}

async function pendingTx(tx: TenantTransaction, accountId: string): Promise<{ id: string; token: string; scopes: string[] } | null> {
  const rows = await tx.$queryRaw<{ id: string; user_token_enc: string; scopes: string[] }[]>`
    SELECT id::text AS id, user_token_enc, scopes FROM meta_ad_connections
    WHERE account_id=${accountId}::uuid AND status='pending' LIMIT 1`;
  const row = rows[0];
  return row?.user_token_enc ? { id: row.id, token: decrypt(row.user_token_enc), scopes: row.scopes } : null;
}

/** Exchanges a Login for Business code and stores (or refreshes) the workspace's pending connection. */
export async function startConnection(actor: MetaAdsActor, loginToken: string): Promise<MetaAdConnectionDto> {
  const config = requireConfig();
  requireAdmin(actor);
  if (typeof loginToken !== 'string' || !loginToken.trim() || loginToken.length > 4096) throw new MetaAdsError('invalid_request');
  const existing = await asWorker(actor, (tx) => liveRowTx(tx, actor.accountId));
  if (existing && existing.status !== 'pending') throw new MetaAdsError('already_connected');
  const { accessToken } = await meta(() => exchangeLoginToken(config, loginToken.trim()));
  const scopes = (await meta(() => getGrantedScopes(accessToken))).slice(0, 100);
  const tokenEnc = encrypt(accessToken);
  // The one-live index includes 'pending': an existing pending row is refreshed,
  // an active or token_invalid one is left alone (no row comes back).
  const rows = await asWorker(actor, async (tx) => {
    // A new connection takes a slot of the plan's integrations; refreshing the pending one does not.
    // Re-read here: the row read before the Meta calls may have changed meanwhile.
    const live = await liveRowTx(tx, actor.accountId);
    if (live && live.status !== 'pending') return [];
    if (!live) await requireIntegrationRoom(tx, actor.accountId);
    return tx.$queryRaw<MetaAdConnectionRow[]>`
    INSERT INTO meta_ad_connections(account_id, connected_by, status, user_token_enc, scopes)
    VALUES(${actor.accountId}::uuid, ${actor.userId}::uuid, 'pending', ${tokenEnc}, ${scopes}::text[])
    ON CONFLICT (account_id) WHERE status <> 'disconnected' DO UPDATE SET
      connected_by=EXCLUDED.connected_by, user_token_enc=EXCLUDED.user_token_enc, scopes=EXCLUDED.scopes,
      page_token_enc='', business_id=NULL, ad_account_id=NULL, ad_account_name=NULL, ad_account_currency=NULL,
      page_id=NULL, page_name=NULL, last_error_code=NULL, updated_at=now()
    WHERE meta_ad_connections.status='pending'
    RETURNING ${PUBLIC_SELECT}`;
  });
  if (!rows[0]) throw new MetaAdsError('already_connected');
  return toDto(rows[0]);
}

/** Ad accounts and Pages the pending connection's user can choose from. */
export async function listChoices(actor: MetaAdsActor): Promise<ConnectionChoices> {
  requireConfig();
  requireAdmin(actor);
  const pending = await asWorker(actor, (tx) => pendingTx(tx, actor.accountId));
  if (!pending) throw new MetaAdsError('not_connected');
  const [adAccounts, pages] = await meta(() => Promise.all([listAdAccounts(pending.token), listPages(pending.token)]));
  return {
    adAccounts: adAccounts.map((a) => ({ id: a.id, name: a.name, currency: a.currency })),
    pages: pages.map((p) => ({ id: p.id, name: p.name })),
  };
}

/** Completes the pending connection with the chosen ad account and Page. */
export async function finishConnection(actor: MetaAdsActor, input: { adAccountId: string; pageId: string }): Promise<MetaAdConnectionDto> {
  requireConfig();
  requireAdmin(actor);
  if (!META_ID.test(input.adAccountId) || !META_ID.test(input.pageId)) throw new MetaAdsError('invalid_choice');
  const pending = await asWorker(actor, (tx) => pendingTx(tx, actor.accountId));
  if (!pending) throw new MetaAdsError('not_connected');
  // Re-check the choice server side against what this token can actually see.
  const [adAccounts, pages] = await meta(() => Promise.all([listAdAccounts(pending.token), listPages(pending.token)]));
  const account = adAccounts.find((a) => a.id === input.adAccountId);
  const page = pages.find((p) => p.id === input.pageId);
  if (!account || !page) throw new MetaAdsError('invalid_choice');

  const owner = await getWorkerPrisma().$queryRaw<{ owner: string | null }[]>`
    SELECT crm_page_owner_account(${page.id})::text AS owner`;
  if (owner[0]?.owner && owner[0].owner !== actor.accountId) throw new MetaAdsError('page_in_use');

  let row: MetaAdConnectionRow | null;
  try {
    row = await asWorker(actor, async (tx) => {
      const rows = await tx.$queryRaw<MetaAdConnectionRow[]>`UPDATE meta_ad_connections SET
          status='active', business_id=${account.businessId}, ad_account_id=${account.id}, ad_account_name=${account.name},
          ad_account_currency=${account.currency}, page_id=${page.id}, page_name=${page.name},
          page_token_enc=${encrypt(page.accessToken)}, connected_at=now(), last_error_code=NULL, updated_at=now()
        WHERE account_id=${actor.accountId}::uuid AND id=${pending.id}::uuid AND status='pending'
        RETURNING ${PUBLIC_SELECT}`;
      if (!rows[0]) return null;
      // The chosen ad account is the primary one; more can be added from Settings > Ads.
      await setPrimaryAdAccountTx(tx, actor.accountId, {
        connectionId: rows[0].id, adAccountId: account.id, name: account.name, currency: account.currency,
        businessId: account.businessId, userId: actor.userId,
      });
      await audit(tx, actor, 'meta_ads.connect', rows[0].id, { adAccountId: account.id, pageId: page.id });
      return rows[0];
    });
  } catch (error) {
    // The partial unique index is the race backstop for the Page check above.
    if (isUniqueViolation(error)) throw new MetaAdsError('page_in_use');
    throw error;
  }
  if (!row) throw new MetaAdsError('not_connected');

  // Subscribing after the commit means a refused Page never gets a subscription.
  // A failed subscribe keeps the connection (the lead backfill still runs) and
  // records Meta's code for the admin.
  if (missingScopes(pending.scopes, 'leads').length === 0) {
    let subscribed = false;
    let errorCode: string | null = null;
    try {
      await subscribePageLeadgen(page.id, page.accessToken);
      subscribed = true;
    } catch (error) {
      errorCode = metaErrorCode(error);
      console.error('[meta-ads] Page leadgen subscribe failed', errorCode ?? 'unknown');
    }
    const id = row.id;
    const updated = await asWorker(actor, (tx) => tx.$queryRaw<MetaAdConnectionRow[]>`UPDATE meta_ad_connections SET
        page_subscribed_at=CASE WHEN ${subscribed} THEN now() ELSE page_subscribed_at END,
        last_error_code=${errorCode}, updated_at=now()
      WHERE account_id=${actor.accountId}::uuid AND id=${id}::uuid AND status='active'
      RETURNING ${PUBLIC_SELECT}`);
    if (updated[0]) row = updated[0];
  }
  return toDto(row);
}

/**
 * Unsubscribes the Page, clears the tokens and marks the connection
 * disconnected. If Meta cannot be reached the connection is kept and the admin
 * retries (502 revoke_failed). A pending or token_invalid connection is
 * disconnected without a Meta call (that token cannot revoke anything).
 * Works while the feature is off or unconfigured, so an admin can always clear
 * the stored tokens: the Page unsubscribe is then skipped (the page webhook
 * ignores deliveries while disabled) and the audit records unsubscribeSkipped.
 * Returns null when there is nothing to disconnect.
 */
export async function disconnect(actor: MetaAdsActor): Promise<MetaAdConnectionDto | null> {
  requireAdmin(actor);
  const current = await asWorker(actor, async (tx) => (await tx.$queryRaw<{
    id: string; status: MetaAdConnectionStatus; page_id: string | null; page_token_enc: string; page_subscribed_at: Date | null;
  }[]>`SELECT id::text AS id, status, page_id, page_token_enc, page_subscribed_at FROM meta_ad_connections
    WHERE account_id=${actor.accountId}::uuid AND status<>'disconnected' LIMIT 1`)[0] ?? null);
  if (!current) return null;
  let unsubscribeSkipped = false;
  if (current.status === 'active' && current.page_subscribed_at && current.page_id && current.page_token_enc) {
    if (!metaAdsConfig()) {
      unsubscribeSkipped = true;
    } else {
      try {
        await unsubscribePage(current.page_id, decrypt(current.page_token_enc));
      } catch (error) {
        console.error('[meta-ads] Page unsubscribe failed', metaErrorCode(error) ?? 'unknown');
        if (!isMetaTokenInvalid(error)) throw new MetaAdsError('revoke_failed');
      }
    }
  }
  const row = await asWorker(actor, async (tx) => {
    const rows = await tx.$queryRaw<MetaAdConnectionRow[]>`UPDATE meta_ad_connections SET
        status='disconnected', user_token_enc='', page_token_enc='', page_subscribed_at=NULL, capi_enabled=false,
        disconnected_at=now(), updated_at=now()
      WHERE account_id=${actor.accountId}::uuid AND id=${current.id}::uuid AND status<>'disconnected'
      RETURNING ${PUBLIC_SELECT}`;
    if (rows[0]) {
      await audit(tx, actor, 'meta_ads.disconnect', rows[0].id,
        unsubscribeSkipped ? { previousStatus: current.status, unsubscribeSkipped: true } : { previousStatus: current.status });
    }
    return rows[0] ?? null;
  });
  return row ? toDto(row) : null;
}

export interface CapiSettingsInput {
  capiEnabled?: boolean;
  capiAutoPurchase?: boolean;
  capiAutoLead?: boolean;
  capiWhatsappConfigId?: string | null;
}

/**
 * Updates the Conversions API settings of the active connection. Enabling CAPI
 * needs a WhatsApp number of this workspace (its WABA owns the dataset) and the
 * whatsapp_business_manage_events grant. The dataset is looked up or created on
 * Meta outside any transaction, then stored with the settings in one write.
 */
export async function updateCapiSettings(actor: MetaAdsActor, input: CapiSettingsInput): Promise<MetaAdConnectionDto> {
  requireConfig();
  requireAdmin(actor);
  const configId = input.capiWhatsappConfigId;
  if (configId !== undefined && configId !== null && !UUID.test(configId)) throw new MetaAdsError('invalid_number');

  const current = await asWorker(actor, async (tx) => {
    const [row] = await tx.$queryRaw<{
      id: string; status: MetaAdConnectionStatus; scopes: string[]; capi_enabled: boolean; capi_whatsapp_config_id: string | null;
      capi_dataset_id: string | null; capi_waba_id: string | null; user_token_enc: string;
    }[]>`SELECT id::text AS id, status, scopes, capi_enabled, capi_whatsapp_config_id::text AS capi_whatsapp_config_id,
        capi_dataset_id, capi_waba_id, user_token_enc
      FROM meta_ad_connections WHERE account_id=${actor.accountId}::uuid AND status<>'disconnected' LIMIT 1`;
    if (!row) return null;
    const numberId = configId !== undefined ? configId : row.capi_whatsapp_config_id;
    const [number] = numberId ? await tx.$queryRaw<{ waba_id: string | null }[]>`
      SELECT waba_id FROM whatsapp_config WHERE account_id=${actor.accountId}::uuid AND id=${numberId}::uuid` : [];
    return { row, numberId, number: number ?? null };
  });
  if (!current) throw new MetaAdsError('not_connected');
  const { row, numberId, number } = current;
  if (row.status === 'token_invalid') throw new MetaAdsError('token_invalid');
  if (row.status !== 'active') throw new MetaAdsError('not_connected');
  if (numberId && !number) throw new MetaAdsError('invalid_number');

  const enabled = input.capiEnabled ?? row.capi_enabled;
  const numberWaba = number?.waba_id && META_ID.test(number.waba_id) ? number.waba_id : null;
  // A dataset belongs to one WABA: keep it only while the number stays on that WABA.
  let datasetId = numberWaba && numberWaba === row.capi_waba_id ? row.capi_dataset_id : null;
  let wabaId = datasetId ? row.capi_waba_id : null;
  if (enabled) {
    if (!numberId || !numberWaba) throw new MetaAdsError('invalid_number');
    if (missingScopes(row.scopes, 'capi').length) throw new MetaAdsError('missing_scope');
    if (!datasetId) {
      const token = row.user_token_enc ? decrypt(row.user_token_enc) : null;
      if (!token) throw new MetaAdsError('token_invalid');
      datasetId = await meta(() => getOrCreateDataset(numberWaba, token));
      wabaId = numberWaba;
    }
  }

  const updated = await asWorker(actor, async (tx) => {
    const rows = await tx.$queryRaw<MetaAdConnectionRow[]>`UPDATE meta_ad_connections SET
        capi_enabled=${enabled}, capi_auto_purchase=COALESCE(${input.capiAutoPurchase ?? null}::boolean, capi_auto_purchase),
        capi_auto_lead=COALESCE(${input.capiAutoLead ?? null}::boolean, capi_auto_lead),
        capi_whatsapp_config_id=${numberId ?? null}::uuid, capi_dataset_id=${datasetId}, capi_waba_id=${wabaId}, updated_at=now()
      WHERE account_id=${actor.accountId}::uuid AND id=${row.id}::uuid AND status='active'
      RETURNING ${PUBLIC_SELECT}`;
    if (rows[0]) {
      await audit(tx, actor, 'meta_ads.capi_update', rows[0].id, {
        capiEnabled: rows[0].capi_enabled, capiAutoPurchase: rows[0].capi_auto_purchase, capiAutoLead: rows[0].capi_auto_lead,
        numberChanged: (numberId ?? null) !== row.capi_whatsapp_config_id,
      });
    }
    return rows[0] ?? null;
  });
  if (!updated) throw new MetaAdsError('not_connected');
  return toDto(updated);
}
