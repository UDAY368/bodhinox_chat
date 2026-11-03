// Meta lead ads: Page webhook, lead fetch and backfill, leads hub (part c).
//
// Flow: the signed Page webhook is stored as a receipt plus an account-less
// meta.page_webhook job (persistPageWebhook). That job resolves each leadgen
// change's Page to its workspace, records a pending lead and queues
// meta.leadgen_fetch for it. The fetch job reads the answers with the Page
// token, then stores them and matches (or creates) the contact in one
// transaction. meta.leads_sync backfills missed webhooks per form.
//
// Rules: nothing runs while the feature is off (handlers return before any
// SQL or network call); Graph calls never run inside an open transaction;
// lead ids, Page ids and answers are never logged; a lead is never opted in
// to WhatsApp. Members read leads only through the dedicated routes.
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { requireFeature } from '@/lib/billing/entitlements';
import { csvCell, MAX_EXPORT_ROWS } from '@/lib/audience/export';
import { loadPhoneMask, maskContactIdentifier } from '@/lib/inbox/masking-apply';
import { maskPhonesInText } from '@/lib/inbox/masking';
import { normalizePhone, parseInternationalPhone, phoneVariants } from '@/lib/whatsapp/phone-utils';
import { pickBestPhoneMatch } from '@/lib/contacts/dedupe';
import { MetaApiError } from '@/lib/whatsapp/meta-api';
import { metaAdsConfig, missingScopes } from './config';
import { LEADS_SYNC_JOB } from './schedule';
import { loadActiveConnectionTx, type ActiveConnectionSecrets } from './connection';
import { getLead, isMetaThrottle, isMetaTokenInvalid, listFormLeads, listLeadForms, metaErrorCode, type MetaLead, type MetaLeadField } from './graph';

export const PAGE_WEBHOOK_JOB = 'meta.page_webhook';
export const LEADGEN_FETCH_JOB = 'meta.leadgen_fetch';
/** webhook_receipts.provider for Page webhooks; dedupe keys are `meta_page:<sha256(raw)>`. */
export const PAGE_WEBHOOK_PROVIDER = 'meta_page';

const MAX_WEBHOOK_BYTES = 2 * 1024 * 1024;
const META_ID = /^\d{1,32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Keeps field_data well under its 64 KB CHECK (jsonb is stored a little larger than its text). */
const MAX_FIELD_DATA_CHARS = 48_000;
const MAX_QUESTIONS_CHARS = 48_000;
/**
 * Backfill bounds per job: forms, pages of 100 leads per form, and the
 * first-run look-back. A run that reaches a bound queues a continuation job
 * (same `since`) instead of dropping the rest.
 */
const SYNC_MAX_FORMS = 50;
const SYNC_MAX_PAGES = 5;
const SYNC_FIRST_LOOKBACK_MS = 7 * 86_400_000;
/** Re-read a little before the last sync so a lead created during it is not missed. */
const SYNC_OVERLAP_MS = 60 * 60_000;
export const LEADS_PAGE_SIZE = 50;
/** Forms that can no longer receive leads are not backfilled. */
const CLOSED_FORM = new Set(['ARCHIVED', 'DELETED']);
const GRAPH_CURSOR = /^[\w=+/-]{1,2048}$/;
/** Statuses that are final for the fetch and backfill paths: an erased lead is a tombstone. */
const FINAL_STATUSES = ['fetched', 'erased'];

// ---------------------------------------------------------------- webhook intake

/** Stores the verified raw delivery and its job in one worker transaction; returns the receipt id. */
export async function persistPageWebhook(raw: string, payload: unknown): Promise<string> {
  if (Buffer.byteLength(raw) > MAX_WEBHOOK_BYTES) throw new Error('Webhook exceeds size limit');
  const dedupeKey = `${PAGE_WEBHOOK_PROVIDER}:${createHash('sha256').update(raw).digest('hex')}`;
  return getWorkerPrisma().$transaction(async (tx) => {
    const receipt = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO webhook_receipts(provider,dedupe_key,payload) VALUES(${PAGE_WEBHOOK_PROVIDER},${dedupeKey},${JSON.stringify(payload)}::jsonb)
      ON CONFLICT(dedupe_key) DO UPDATE SET dedupe_key=EXCLUDED.dedupe_key RETURNING id::text AS id`;
    const id = receipt[0].id;
    await tx.$executeRaw`INSERT INTO jobs(type,payload,dedupe_key)
      VALUES(${PAGE_WEBHOOK_JOB},${JSON.stringify({ receiptId: id })}::jsonb,${`pagewebhook:${id}`}) ON CONFLICT(dedupe_key) DO NOTHING`;
    return id;
  });
}

export interface LeadgenChange {
  pageId: string;
  leadgenId: string;
  formId: string | null;
  adId: string | null;
  createdAt: Date | null;
}

const metaId = (value: unknown): string | null => {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return typeof text === 'string' && META_ID.test(text) ? text : null;
};

function unixDate(value: unknown): Date | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,12}$/.test(value) ? Number(value) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  const date = new Date(n * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The well-formed leadgen changes of a Page webhook payload (anything else is ignored). */
export function parseLeadgenChanges(payload: unknown): LeadgenChange[] {
  if (!payload || typeof payload !== 'object' || (payload as { object?: unknown }).object !== 'page') return [];
  const entries = (payload as { entry?: unknown }).entry;
  if (!Array.isArray(entries)) return [];
  const out: LeadgenChange[] = [];
  for (const entry of entries.slice(0, 100)) {
    if (!entry || typeof entry !== 'object') continue;
    const changes = (entry as { changes?: unknown }).changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes.slice(0, 100)) {
      if (!change || typeof change !== 'object' || (change as { field?: unknown }).field !== 'leadgen') continue;
      const value = (change as { value?: unknown }).value;
      if (!value || typeof value !== 'object') continue;
      const v = value as Record<string, unknown>;
      const pageId = metaId(v.page_id) ?? metaId((entry as { id?: unknown }).id);
      const leadgenId = metaId(v.leadgen_id);
      if (!pageId || !leadgenId) continue;
      out.push({ pageId, leadgenId, formId: metaId(v.form_id), adId: metaId(v.ad_id), createdAt: unixDate(v.created_time) });
    }
  }
  return out;
}

/** meta.page_webhook (no tenant): fans leadgen changes out to their workspaces. */
export async function handlePageWebhookJob(payload: unknown): Promise<void> {
  if (!metaAdsConfig()) return;
  const prisma = getWorkerPrisma();
  let unknownPages = 0;
  for (const change of parseLeadgenChanges(payload)) {
    const owner = await prisma.$queryRaw<{ account_id: string; connection_id: string }[]>`
      SELECT account_id::text AS account_id, connection_id::text AS connection_id FROM crm_resolve_page_account(${change.pageId})`;
    if (!owner[0]) {
      // A Page no workspace holds (disconnected, or never connected): dropped, not retried.
      unknownPages++;
      continue;
    }
    const { account_id: accountId, connection_id: connectionId } = owner[0];
    await withTenant({ accountId, role: 'owner' }, (tx) => recordPendingLeadTx(tx, accountId, connectionId, change), prisma);
  }
  if (unknownPages) console.warn('[meta-ads] page webhook leads for unconnected Pages dropped', { count: unknownPages });
}

/** Inserts the pending lead and, when it is new, its fetch job (both commit together). */
export async function recordPendingLeadTx(tx: TenantTransaction, accountId: string, connectionId: string, change: LeadgenChange): Promise<boolean> {
  const inserted = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO meta_leads(account_id,connection_id,leadgen_id,form_id,ad_id,page_id,lead_created_at)
    VALUES(${accountId}::uuid,${connectionId}::uuid,${change.leadgenId},${change.formId},${change.adId},${change.pageId},${change.createdAt})
    ON CONFLICT(account_id,leadgen_id) DO NOTHING RETURNING id::text AS id`;
  if (!inserted[0]) return false;
  await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,max_attempts)
    VALUES(${LEADGEN_FETCH_JOB},${accountId}::uuid,${JSON.stringify({ accountId, leadgenId: change.leadgenId })}::jsonb,
      ${`meta-lead:${accountId}:${change.leadgenId}`},5)
    ON CONFLICT(dedupe_key) DO NOTHING`;
  return true;
}

// ---------------------------------------------------------------- answers and contacts

/** Bounded copy of a lead's answers that always fits the field_data CHECK. */
export function boundFieldData(fields: MetaLeadField[]): MetaLeadField[] {
  const out: MetaLeadField[] = [];
  let size = 2;
  for (const field of fields) {
    const length = JSON.stringify(field).length + 1;
    if (size + length > MAX_FIELD_DATA_CHARS) break;
    size += length;
    out.push(field);
  }
  return out;
}

const answer = (fields: MetaLeadField[], ...names: string[]): string | null => {
  for (const name of names) {
    const value = fields.find((f) => f.name.toLowerCase() === name)?.values[0]?.trim();
    if (value) return value;
  }
  return null;
};

/** Phone, name and email answers from Meta's standard lead form keys. */
export function leadIdentity(fields: MetaLeadField[]): { phone: string | null; name: string | null; email: string | null } {
  const phoneRaw = answer(fields, 'phone_number', 'phone', 'mobile_number', 'whatsapp_number')
    ?? fields.find((f) => /phone|mobile|whatsapp/i.test(f.name))?.values[0] ?? null;
  const phone = parseInternationalPhone(phoneRaw);
  const full = answer(fields, 'full_name', 'name');
  const parts = [answer(fields, 'first_name'), answer(fields, 'last_name')].filter(Boolean).join(' ').trim();
  const name = (full ?? (parts || null))?.slice(0, 200) ?? null;
  const emailRaw = answer(fields, 'email', 'work_email');
  const email = emailRaw && /^[^\s@]{1,64}@[^\s@]{1,255}$/.test(emailRaw) ? emailRaw : null;
  return { phone, name, email };
}

type ContactMatch = { id: string; phone: string };

/**
 * The workspace contact with this number, or a new one. A created contact is
 * not opted in to anything: broadcasts still use templates and opt-outs.
 */
export async function matchLeadContactTx(tx: TenantTransaction, accountId: string, identity: ReturnType<typeof leadIdentity>): Promise<string | null> {
  const sanitized = identity.phone;
  const normalized = sanitized ? normalizePhone(sanitized) : '';
  if (!sanitized || !normalized) return null;
  const find = async () => pickBestPhoneMatch(await tx.$queryRaw<ContactMatch[]>`
    SELECT id::text AS id, phone FROM contacts
    WHERE account_id=${accountId}::uuid AND phone_normalized IN (${Prisma.join(phoneVariants(normalized))})`, sanitized);
  const existing = await find();
  if (existing) return existing.id;
  // Audit user: the default number's owner, else the account owner (as commerce events do).
  const created = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO contacts(account_id,user_id,phone,name,email)
    SELECT ${accountId}::uuid,
      COALESCE((SELECT user_id FROM whatsapp_config WHERE account_id=${accountId}::uuid AND is_default LIMIT 1), a.owner_user_id),
      ${sanitized}, ${identity.name ?? sanitized}, ${identity.email}
    FROM accounts a WHERE a.id=${accountId}::uuid
    ON CONFLICT DO NOTHING RETURNING id::text AS id`;
  if (created[0]) return created[0].id;
  return (await find())?.id ?? null;
}

function leadTime(value: string | null): Date | null {
  if (!value) return null;
  // Meta sends "2026-11-03T10:00:00+0000"; Date accepts "+00:00".
  const date = new Date(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Stores fetched answers and the matched contact; creates the row when the
 * backfill found it first. A lead already fetched, or erased (a tombstone), is
 * left alone before any contact is matched or created, so a re-read never
 * re-imports erased answers or re-creates a deleted contact.
 */
export async function storeFetchedLeadTx(tx: TenantTransaction, accountId: string, connectionId: string, pageId: string | null, lead: MetaLead): Promise<void> {
  const current = await tx.$queryRaw<{ status: string }[]>`
    SELECT status FROM meta_leads WHERE account_id=${accountId}::uuid AND leadgen_id=${lead.id} FOR UPDATE`;
  if (current[0] && FINAL_STATUSES.includes(current[0].status)) return;
  const fields = boundFieldData(lead.fieldData);
  const contactId = await matchLeadContactTx(tx, accountId, leadIdentity(fields));
  await tx.$executeRaw`
    INSERT INTO meta_leads(account_id,connection_id,leadgen_id,form_id,ad_id,adset_id,campaign_id,page_id,ad_name,campaign_name,
      status,field_data,contact_id,lead_created_at,fetched_at,fetch_error_code)
    VALUES(${accountId}::uuid,${connectionId}::uuid,${lead.id},${lead.formId},${lead.adId},${lead.adsetId},${lead.campaignId},${pageId},
      ${lead.adName},${lead.campaignName},'fetched',${JSON.stringify(fields)}::jsonb,${contactId}::uuid,${leadTime(lead.createdTime)},now(),NULL)
    ON CONFLICT(account_id,leadgen_id) DO UPDATE SET
      form_id=COALESCE(EXCLUDED.form_id,meta_leads.form_id), ad_id=COALESCE(EXCLUDED.ad_id,meta_leads.ad_id),
      adset_id=EXCLUDED.adset_id, campaign_id=EXCLUDED.campaign_id, ad_name=EXCLUDED.ad_name, campaign_name=EXCLUDED.campaign_name,
      status='fetched', field_data=EXCLUDED.field_data, contact_id=COALESCE(EXCLUDED.contact_id,meta_leads.contact_id),
      lead_created_at=COALESCE(EXCLUDED.lead_created_at,meta_leads.lead_created_at), fetched_at=now(), fetch_error_code=NULL
    WHERE meta_leads.status NOT IN ('fetched','erased')`;
}

/** Records a revoked or expired token so the settings card asks for a reconnect. */
async function markTokenInvalid(accountId: string, connectionId: string, error: unknown): Promise<void> {
  await withTenant({ accountId, role: 'owner' }, (tx) => tx.$executeRaw`
    UPDATE meta_ad_connections SET status='token_invalid', last_error_code=${metaErrorCode(error)}, updated_at=now()
    WHERE account_id=${accountId}::uuid AND id=${connectionId}::uuid AND status='active'`, getWorkerPrisma());
}

const leadsReady = (connection: ActiveConnectionSecrets | null): connection is ActiveConnectionSecrets & { pageToken: string } =>
  !!connection && !!connection.pageToken && missingScopes(connection.scopes, 'leads').length === 0;

// ---------------------------------------------------------------- jobs

/** meta.leadgen_fetch: fetches one lead's answers and matches it to a contact. */
export async function handleLeadgenFetchJob(accountId: string, payload: Record<string, unknown>): Promise<void> {
  if (!metaAdsConfig()) return;
  const leadgenId = metaId(payload.leadgenId);
  if (!leadgenId) throw new Error('Invalid job identifier');
  const worker = getWorkerPrisma();
  const state = await withTenant({ accountId, role: 'owner' }, async (tx) => {
    const lead = await tx.$queryRaw<{ status: string; connection_id: string; page_id: string | null }[]>`
      SELECT status, connection_id::text AS connection_id, page_id FROM meta_leads
      WHERE account_id=${accountId}::uuid AND leadgen_id=${leadgenId}`;
    return { lead: lead[0] ?? null, connection: await loadActiveConnectionTx(tx, accountId) };
  }, worker);
  // Erased, already fetched, or the workspace disconnected: nothing to fetch.
  if (!state.lead || FINAL_STATUSES.includes(state.lead.status)) return;
  const connection = state.connection;
  if (!leadsReady(connection) || connection.id !== state.lead.connection_id) return;

  let lead: MetaLead;
  try {
    lead = await getLead(leadgenId, connection.pageToken);
  } catch (error) {
    if (isMetaThrottle(error)) throw error; // retried later
    if (!(error instanceof MetaApiError) || (error.httpStatus ?? 0) >= 500) throw error; // network or Meta outage: a GET, safe to retry
    if (isMetaTokenInvalid(error)) await markTokenInvalid(accountId, connection.id, error);
    const code = (metaErrorCode(error) ?? `http_${error.httpStatus ?? 'error'}`).slice(0, 64);
    await withTenant({ accountId, role: 'owner' }, (tx) => tx.$executeRaw`
      UPDATE meta_leads SET status='failed', fetch_error_code=${code}
      WHERE account_id=${accountId}::uuid AND leadgen_id=${leadgenId} AND status NOT IN ('fetched','erased')`, worker);
    return;
  }
  if (lead.id !== leadgenId) throw new Error('Meta returned a different lead');
  await withTenant({ accountId, role: 'owner' },
    (tx) => storeFetchedLeadTx(tx, accountId, connection.id, state.lead!.page_id ?? connection.pageId, lead), worker);
}

interface SyncResume { connectionId: string; since: number; formId: string; after: string | null }

/** A continuation payload, or null for a scheduled run ({}). Anything else is rejected. */
export function parseSyncResume(payload: Record<string, unknown>): SyncResume | null {
  if (!payload || Object.keys(payload).length === 0) return null;
  const { connectionId, since, formId, after } = payload;
  if (typeof connectionId !== 'string' || !UUID.test(connectionId)
    || typeof since !== 'number' || !Number.isSafeInteger(since) || since <= 0
    || typeof formId !== 'string' || !META_ID.test(formId)
    || !(after === null || (typeof after === 'string' && GRAPH_CURSOR.test(after)))) throw new Error('Invalid job payload');
  return { connectionId, since, formId, after };
}

/**
 * meta.leads_sync: backfills leads per open form since the last sync (missed
 * webhooks). A scheduled run ({} payload) starts at the first form and moves
 * leads_synced_at forward; when it stops at a bound it queues a continuation
 * (connection, the same since, the form and Graph cursor to resume at) in the
 * same transaction, and continuations chain until every form is read.
 */
export async function handleLeadsSyncJob(accountId: string, payload: Record<string, unknown>): Promise<void> {
  if (!metaAdsConfig()) return;
  const resume = parseSyncResume(payload);
  const worker = getWorkerPrisma();
  const connection = await withTenant({ accountId, role: 'owner' }, (tx) => loadActiveConnectionTx(tx, accountId), worker);
  if (!leadsReady(connection) || !connection.pageId) return;
  if (resume && resume.connectionId !== connection.id) return; // reconnected since: the new connection syncs itself
  const startedAt = new Date();
  const since = resume?.since ?? Math.floor((connection.leadsSyncedAt
    ? connection.leadsSyncedAt.getTime() - SYNC_OVERLAP_MS
    : startedAt.getTime() - SYNC_FIRST_LOOKBACK_MS) / 1000);

  let next: { formId: string; after: string | null } | null = null;
  try {
    const forms = await listLeadForms(connection.pageId, connection.pageToken);
    const open = forms.filter((form) => !CLOSED_FORM.has((form.status ?? '').toUpperCase()));
    const start = resume ? open.findIndex((form) => form.id === resume.formId) : 0;
    if (start < 0) return; // the form closed or went away since the previous run queued this one
    const batch = open.slice(start, start + SYNC_MAX_FORMS);
    if (!resume)
      await withTenant({ accountId, role: 'owner' }, async (tx) => {
        for (const form of forms.slice(0, SYNC_MAX_FORMS * 4)) {
          const questions = JSON.stringify(form.questions).length <= MAX_QUESTIONS_CHARS ? form.questions : [];
          await tx.$executeRaw`INSERT INTO meta_lead_forms(account_id,connection_id,form_id,name,status,questions,synced_at)
            VALUES(${accountId}::uuid,${connection.id}::uuid,${form.id},${form.name},${form.status},${JSON.stringify(questions)}::jsonb,now())
            ON CONFLICT(account_id,form_id) DO UPDATE SET connection_id=EXCLUDED.connection_id, name=EXCLUDED.name,
              status=EXCLUDED.status, questions=EXCLUDED.questions, synced_at=now()`;
        }
      }, worker);
    for (const [index, form] of batch.entries()) {
      let after: string | undefined = index === 0 && resume?.after ? resume.after : undefined;
      let more = false;
      for (let page = 0; page < SYNC_MAX_PAGES; page++) {
        const result = await listFormLeads(form.id, connection.pageToken, { since, after });
        if (result.leads.length)
          await withTenant({ accountId, role: 'owner' }, async (tx) => {
            for (const lead of result.leads) await storeFetchedLeadTx(tx, accountId, connection.id, connection.pageId, lead);
          }, worker);
        more = !!result.nextCursor && GRAPH_CURSOR.test(result.nextCursor);
        if (!more) break;
        after = result.nextCursor!;
      }
      if (more && after) {
        next = { formId: form.id, after };
        break;
      }
    }
    if (!next && open.length > start + batch.length) next = { formId: open[start + batch.length].id, after: null };
  } catch (error) {
    if (isMetaTokenInvalid(error)) {
      await markTokenInvalid(accountId, connection.id, error);
      return;
    }
    if (error instanceof MetaApiError && !isMetaThrottle(error) && (error.httpStatus ?? 0) < 500) {
      // A permanent rejection: record the code, keep the cursor, and wait for the next scheduled run.
      await withTenant({ accountId, role: 'owner' }, (tx) => tx.$executeRaw`
        UPDATE meta_ad_connections SET last_error_code=${metaErrorCode(error)}, updated_at=now()
        WHERE account_id=${accountId}::uuid AND id=${connection.id}::uuid`, worker);
      return;
    }
    throw error;
  }
  const continuation = next;
  await withTenant({ accountId, role: 'owner' }, async (tx) => {
    if (continuation) {
      const body = JSON.stringify({ connectionId: connection.id, since, formId: continuation.formId, after: continuation.after });
      const key = `meta-leads-more:${accountId}:${createHash('sha256').update(body).digest('hex').slice(0, 40)}`;
      await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,max_attempts)
        VALUES(${LEADS_SYNC_JOB},${accountId}::uuid,${body}::jsonb,${key},3) ON CONFLICT(dedupe_key) DO NOTHING`;
    }
    // Only a scheduled run moves the window; a queued continuation covers the rest of it.
    if (!resume)
      await tx.$executeRaw`
        UPDATE meta_ad_connections SET leads_synced_at=${startedAt}, updated_at=now()
        WHERE account_id=${accountId}::uuid AND id=${connection.id}::uuid AND status='active'`;
  }, worker);
}

// ---------------------------------------------------------------- leads hub (member reads)

export interface LeadsFilter {
  formId?: string | null;
  adId?: string | null;
  /** Inclusive YYYY-MM-DD bounds on received_at (UTC). */
  from?: string | null;
  to?: string | null;
  cursor?: string | null;
}

export class LeadsInputError extends Error {}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar day: Date rolls 2026-02-31 over to March, so the round trip must match. */
const isCalendarDay = (day: string): boolean => {
  if (!DAY.test(day)) return false;
  const ms = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === day;
};

/** Validates query-string input; throws LeadsInputError for anything malformed. */
export function parseLeadsFilter(query: URLSearchParams): LeadsFilter {
  const value = (key: string) => query.get(key)?.trim() || null;
  const filter: LeadsFilter = { formId: value('formId'), adId: value('adId'), from: value('from'), to: value('to'), cursor: value('cursor') };
  if (filter.formId && !META_ID.test(filter.formId)) throw new LeadsInputError('formId');
  if (filter.adId && !META_ID.test(filter.adId)) throw new LeadsInputError('adId');
  for (const day of [filter.from, filter.to])
    if (day && !isCalendarDay(day)) throw new LeadsInputError('date');
  if (filter.cursor && !decodeCursor(filter.cursor)) throw new LeadsInputError('cursor');
  return filter;
}

/** received_at at full (microsecond) precision; a JS Date would cut it to milliseconds and skip rows. */
const RECEIVED_KEY = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

function encodeCursor(receivedKey: string, id: string): string {
  return Buffer.from(`${receivedKey}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { receivedKey: string; id: string } | null {
  if (cursor.length > 200) return null;
  const [at, id, extra] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  return at && RECEIVED_KEY.test(at) && isCalendarDay(at.slice(0, 10)) && id && UUID.test(id) && extra === undefined
    ? { receivedKey: at, id } : null;
}

function whereFor(accountId: string, filter: LeadsFilter): Prisma.Sql {
  // Erased leads are tombstones kept only to stop re-imports.
  const parts = [Prisma.sql`l.account_id=${accountId}::uuid`, Prisma.sql`l.status<>'erased'`];
  if (filter.formId) parts.push(Prisma.sql`l.form_id=${filter.formId}`);
  if (filter.adId) parts.push(Prisma.sql`l.ad_id=${filter.adId}`);
  if (filter.from) parts.push(Prisma.sql`l.received_at >= ${filter.from}::date`);
  if (filter.to) parts.push(Prisma.sql`l.received_at < (${filter.to}::date + 1)`);
  return Prisma.join(parts, ' AND ');
}

type LeadRow = {
  id: string; leadgen_id: string; form_id: string | null; form_name: string | null; ad_id: string | null; ad_name: string | null;
  campaign_name: string | null; status: 'pending' | 'fetched' | 'failed'; field_data: unknown; contact_id: string | null;
  contact_name: string | null; lead_created_at: Date | null; received_at: Date; received_key: string;
};

export interface LeadDto {
  id: string;
  leadgenId: string;
  formId: string | null;
  formName: string | null;
  adId: string | null;
  adName: string | null;
  campaignName: string | null;
  status: 'pending' | 'fetched' | 'failed';
  answers: MetaLeadField[];
  contactId: string | null;
  contactName: string | null;
  leadCreatedAt: string | null;
  receivedAt: string;
}

/** Answer keys leadIdentity reads as a phone: their whole value is masked, whatever else it holds. */
const PHONE_FIELD = /phone|mobile|whatsapp/i;

function answersOf(value: unknown, mask: boolean): MetaLeadField[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((f) => {
    if (!f || typeof f !== 'object' || typeof (f as MetaLeadField).name !== 'string') return [];
    const name = (f as MetaLeadField).name;
    const values = Array.isArray((f as MetaLeadField).values) ? (f as MetaLeadField).values.filter((v) => typeof v === 'string') : [];
    if (!mask) return [{ name, values }];
    // A masked member sees phone answers the way it sees contact numbers, and
    // numbers inside any other answer the way it sees them in message text.
    const phoneField = PHONE_FIELD.test(name);
    return [{ name, values: values.map((v) => (phoneField ? String(maskContactIdentifier(v)) : maskPhonesInText(v))) }];
  });
}

const LEAD_SELECT = Prisma.sql`SELECT l.id::text AS id, l.leadgen_id, l.form_id, f.name AS form_name, l.ad_id, l.ad_name, l.campaign_name, l.status,
  l.field_data, l.contact_id::text AS contact_id, c.name AS contact_name, l.lead_created_at, l.received_at,
  to_char(l.received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS received_key
  FROM meta_leads l
  LEFT JOIN meta_lead_forms f ON f.account_id=l.account_id AND f.form_id=l.form_id
  LEFT JOIN contacts c ON c.account_id=l.account_id AND c.id=l.contact_id`;

function toLeadDto(row: LeadRow, mask: boolean): LeadDto {
  return {
    id: row.id,
    leadgenId: row.leadgen_id,
    formId: row.form_id,
    formName: row.form_name,
    adId: row.ad_id,
    adName: row.ad_name,
    campaignName: row.campaign_name,
    status: row.status,
    answers: answersOf(row.field_data, mask),
    contactId: row.contact_id,
    contactName: mask && row.contact_name ? maskPhonesInText(row.contact_name) : row.contact_name,
    leadCreatedAt: row.lead_created_at ? row.lead_created_at.toISOString() : null,
    receivedAt: row.received_at.toISOString(),
  };
}

/** One page of the workspace's leads, newest first (keyset paging). */
export async function listLeads(ctx: TenantContext, filter: LeadsFilter): Promise<{ leads: LeadDto[]; nextCursor: string | null }> {
  return withTenant(ctx, async (tx) => {
    const mask = await loadPhoneMask(tx, ctx);
    const cursor = filter.cursor ? decodeCursor(filter.cursor) : null;
    const after = cursor ? Prisma.sql` AND (l.received_at, l.id) < (${cursor.receivedKey}::timestamptz, ${cursor.id}::uuid)` : Prisma.empty;
    const rows = await tx.$queryRaw<LeadRow[]>(Prisma.sql`${LEAD_SELECT}
      WHERE ${whereFor(ctx.accountId, filter)}${after} ORDER BY l.received_at DESC, l.id DESC LIMIT ${LEADS_PAGE_SIZE + 1}`);
    const page = rows.slice(0, LEADS_PAGE_SIZE);
    const last = page[page.length - 1];
    return {
      leads: page.map((row) => toLeadDto(row, mask)),
      nextCursor: rows.length > LEADS_PAGE_SIZE && last ? encodeCursor(last.received_key, last.id) : null,
    };
  });
}

/** Lead forms for the filter: synced forms plus any form id seen on a lead. */
export async function listLeadFormOptions(ctx: TenantContext): Promise<{ id: string; name: string | null }[]> {
  return withTenant(ctx, (tx) => tx.$queryRaw<{ id: string; name: string | null }[]>`
    SELECT form_id AS id, name FROM meta_lead_forms WHERE account_id=${ctx.accountId}::uuid
    UNION
    SELECT DISTINCT l.form_id AS id, NULL::text AS name FROM meta_leads l
    WHERE l.account_id=${ctx.accountId}::uuid AND l.form_id IS NOT NULL AND l.status<>'erased'
      AND NOT EXISTS(SELECT 1 FROM meta_lead_forms f WHERE f.account_id=l.account_id AND f.form_id=l.form_id)
    ORDER BY name NULLS LAST, id LIMIT 500`);
}

/** Every matching lead as CSV (one column per answer key). Audit-logged with the row count only. */
export async function exportLeadsCsv(ctx: TenantContext & { userId: string }, filter: LeadsFilter): Promise<{ csv: string; rows: number }> {
  return withTenant(ctx, async (tx) => {
    await requireFeature(tx, ctx.accountId, 'contact_export');
    const where = whereFor(ctx.accountId, { ...filter, cursor: null });
    const [{ count }] = await tx.$queryRaw<{ count: number }[]>(Prisma.sql`SELECT count(*)::int AS count FROM meta_leads l WHERE ${where}`);
    if (count > MAX_EXPORT_ROWS) throw new LeadsInputError('too_many');
    const rows = await tx.$queryRaw<LeadRow[]>(Prisma.sql`${LEAD_SELECT} WHERE ${where} ORDER BY l.received_at DESC, l.id DESC`);
    const leads = rows.map((row) => toLeadDto(row, false));
    const keys = [...new Set(leads.flatMap((lead) => lead.answers.map((a) => a.name)))];
    await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
      VALUES(${ctx.accountId}::uuid,${ctx.userId}::uuid,'meta_leads.export',${filter.formId ?? null},${JSON.stringify({ rows: leads.length })}::jsonb)`;
    const header = ['Received at', 'Lead created at', 'Lead ID', 'Form', 'Form ID', 'Ad', 'Ad ID', 'Campaign', 'Status', 'Contact', ...keys];
    const lines = leads.map((lead) => [
      lead.receivedAt, lead.leadCreatedAt, lead.leadgenId, lead.formName, lead.formId, lead.adName, lead.adId, lead.campaignName,
      lead.status, lead.contactName, ...keys.map((key) => lead.answers.find((a) => a.name === key)?.values.join('; ') ?? ''),
    ].map(csvCell).join(','));
    return { csv: `﻿${[header.map(csvCell).join(','), ...lines].join('\r\n')}\r\n`, rows: leads.length };
  });
}

/**
 * Erasure: clears one lead's answers, contact link and ad names, and keeps
 * only a tombstone (account, Meta lead id, status 'erased') so the backfill,
 * a webhook redelivery or a reconnect never re-imports it. The route has
 * already checked the caller is an admin. Audited without content.
 */
export async function deleteLead(actor: { accountId: string; userId: string }, leadId: string): Promise<boolean> {
  if (!UUID.test(leadId)) return false;
  return withTenant({ accountId: actor.accountId, role: 'owner' }, async (tx) => {
    const deleted = await tx.$queryRaw<{ id: string }[]>`
      UPDATE meta_leads SET status='erased', field_data='[]'::jsonb, contact_id=NULL, ad_name=NULL, campaign_name=NULL,
        lead_created_at=NULL, fetched_at=NULL, fetch_error_code=NULL
      WHERE account_id=${actor.accountId}::uuid AND id=${leadId}::uuid AND status<>'erased' RETURNING id::text AS id`;
    if (!deleted[0]) return false;
    await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
      VALUES(${actor.accountId}::uuid,${actor.userId}::uuid,'meta_leads.delete',${leadId},'{}'::jsonb)`;
    return true;
  }, getWorkerPrisma());
}
