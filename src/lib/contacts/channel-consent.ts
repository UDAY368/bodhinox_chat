// Stage 5 (5D): per-channel Instagram subscription and the workspace's own
// opt-in / opt-out keywords.
//
//   contacts.instagram_opted_out_at  set by STOP on Instagram (or an Actions
//                                    step); while set, no flow, automation,
//                                    default reply or AI reply on Instagram.
//                                    Agents can still answer by hand.
//   contacts.instagram_opted_in_at   set by START; clears the opt-out.
//   The contact-wide contacts.opted_out_at (WhatsApp STOP) is not touched here
//   and still blocks marketing on every channel.
//
//   instagram_consent_settings: up to 20 extra keywords each way (trimmed and
//   lowercased), one confirmation reply each way, one flow each way (an
//   Instagram or any-channel flow of the same workspace). Admins write it.
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { validInstagramText } from '@/lib/instagram/graph-limits';
import { STAGE5_LIMITS } from '@/types';
import { normalizeConsentKeyword, type CustomConsentKeywords } from './consent';

export type ConsentChannel = 'instagram';
export type ConsentState = 'opted_in' | 'opted_out';

/** The contact fields consent is read from. */
export interface ConsentContact {
  opted_out_at?: string | Date | null;
  instagram_opted_out_at?: string | Date | null;
  instagram_opted_in_at?: string | Date | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Records the contact's state on the channel inside the caller's tenant
 * transaction. Opting out keeps the first opt-out time; opting in clears the
 * opt-out and stamps the opt-in time. Returns whether the state changed (a
 * repeated STOP or START changes nothing).
 */
export async function setChannelConsent(tx: TenantTransaction, accountId: string, contactId: string,
  channel: ConsentChannel, state: ConsentState): Promise<boolean> {
  if (channel !== 'instagram' || !UUID.test(contactId)) throw new Error('Invalid channel consent change');
  const changed = state === 'opted_out'
    ? await tx.$executeRaw`UPDATE contacts SET instagram_opted_out_at=now(), updated_at=now()
        WHERE account_id=${accountId}::uuid AND id=${contactId}::uuid AND instagram_opted_out_at IS NULL`
    : await tx.$executeRaw`UPDATE contacts SET instagram_opted_out_at=NULL, instagram_opted_in_at=now(), updated_at=now()
        WHERE account_id=${accountId}::uuid AND id=${contactId}::uuid AND instagram_opted_out_at IS NOT NULL`;
  return changed > 0;
}

/**
 * An Instagram STOP or START from the inbound worker, in one transaction:
 * records the state, and on opt-out ends the contact's active Instagram flow
 * runs and expires its parked Instagram automation runs (their log says why),
 * so no timer or resume sends more. WhatsApp runs are untouched. Idempotent.
 * Returns whether the state changed.
 */
export async function applyInstagramConsent(accountId: string, contactId: string, state: ConsentState): Promise<boolean> {
  return withTenant({ accountId, role: 'owner' }, async (tx) => {
    const changed = await setChannelConsent(tx, accountId, contactId, 'instagram', state);
    if (state === 'opted_out') {
      await tx.$executeRaw`UPDATE flow_runs r SET status='cancelled', ended_at=now(), end_reason='contact_opted_out', wait_until=NULL
        WHERE r.account_id=${accountId}::uuid AND r.contact_id=${contactId}::uuid AND r.status='active'
          AND (EXISTS (SELECT 1 FROM conversations v WHERE v.account_id=r.account_id AND v.id=r.conversation_id AND v.channel='instagram')
            OR (r.conversation_id IS NULL AND EXISTS (SELECT 1 FROM flows f WHERE f.account_id=r.account_id AND f.id=r.flow_id
              AND f.channel_scope='instagram')))`;
      await tx.$executeRaw`WITH expired AS (
          UPDATE automation_pending_executions p SET status='expired'
          WHERE p.account_id=${accountId}::uuid AND p.contact_id=${contactId}::uuid AND p.status IN ('pending','awaiting_reply')
            AND EXISTS (SELECT 1 FROM automations a WHERE a.account_id=p.account_id AND a.id=p.automation_id AND a.channel='instagram')
          RETURNING log_id)
        UPDATE automation_logs l SET error_message=${INSTAGRAM_OPT_OUT_WHILE_WAITING}
        FROM expired e WHERE l.account_id=${accountId}::uuid AND l.id=e.log_id`;
    }
    return changed;
  }, getWorkerPrisma());
}

/** The run log note for a parked Instagram automation run ended by an Instagram STOP (fixed text, no contact data). */
export const INSTAGRAM_OPT_OUT_WHILE_WAITING =
  'The contact unsubscribed on Instagram while this run was waiting, so nothing more was sent';

/**
 * Whether flows, automations, default replies and AI may message the contact
 * on Instagram: false while the contact is unsubscribed on Instagram, and
 * false for a contact that is not this workspace's.
 */
export async function instagramAutomationAllowed(accountId: string, contactId: string): Promise<boolean> {
  if (!UUID.test(contactId)) return false;
  const rows = await withTenant({ accountId, role: 'owner' }, (tx) => tx.$queryRaw<{ instagram_opted_out_at: Date | null }[]>`
    SELECT instagram_opted_out_at FROM contacts WHERE account_id=${accountId}::uuid AND id=${contactId}::uuid`, getWorkerPrisma());
  return Boolean(rows[0]) && rows[0].instagram_opted_out_at === null;
}

/**
 * The contact's state on a channel from fields already loaded: `opted_out`
 * while instagram_opted_out_at is set, `opted_in` when only
 * instagram_opted_in_at is set, otherwise null (never chose). Pure.
 */
export function channelConsent(contact: ConsentContact | null | undefined, channel: ConsentChannel): ConsentState | null {
  if (!contact || channel !== 'instagram') return null;
  if (contact.instagram_opted_out_at) return 'opted_out';
  if (contact.instagram_opted_in_at) return 'opted_in';
  return null;
}

// ------------------------------------------------------------ workspace settings

export interface InstagramConsentSettings {
  opt_out_keywords: string[];
  opt_in_keywords: string[];
  opt_out_reply: string | null;
  opt_in_reply: string | null;
  opt_out_flow_id: string | null;
  opt_in_flow_id: string | null;
}

export const DEFAULT_CONSENT_SETTINGS: InstagramConsentSettings = {
  opt_out_keywords: [], opt_in_keywords: [], opt_out_reply: null, opt_in_reply: null,
  opt_out_flow_id: null, opt_in_flow_id: null,
};

export type ConsentSettingsErrorCode = 'invalid_keywords' | 'invalid_reply' | 'invalid_flow';

export class ConsentSettingsError extends Error {
  constructor(readonly code: ConsentSettingsErrorCode) {
    super(code);
    this.name = 'ConsentSettingsError';
  }
}

/** The workspace's own keywords as consentKeyword takes them. Pure. */
export function customKeywords(settings: Pick<InstagramConsentSettings, 'opt_out_keywords' | 'opt_in_keywords'>): CustomConsentKeywords {
  return { optOut: settings.opt_out_keywords, optIn: settings.opt_in_keywords };
}

function keywordList(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ConsentSettingsError('invalid_keywords');
  const words: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') throw new ConsentSettingsError('invalid_keywords');
    const word = normalizeConsentKeyword(item);
    if (!word) continue;
    if (word.length > STAGE5_LIMITS.consentKeywordChars) throw new ConsentSettingsError('invalid_keywords');
    if (!words.includes(word)) words.push(word);
  }
  if (words.length > STAGE5_LIMITS.consentKeywords) throw new ConsentSettingsError('invalid_keywords');
  return words;
}

function reply(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ConsentSettingsError('invalid_reply');
  const text = value.trim();
  if (!text) return null;
  // One Instagram message: the table's 1,000-character cap and Instagram's byte limit.
  if (text.length > STAGE5_LIMITS.consentReplyChars || !validInstagramText(text)) throw new ConsentSettingsError('invalid_reply');
  return text;
}

function flowId(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !UUID.test(value)) throw new ConsentSettingsError('invalid_flow');
  return value.toLowerCase();
}

/** Validates a PUT /api/instagram/consent-settings body. Pure. */
export function parseConsentSettingsInput(body: unknown): InstagramConsentSettings {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ConsentSettingsError('invalid_keywords');
  const input = body as Record<string, unknown>;
  const optOut = keywordList(input.opt_out_keywords);
  const optIn = keywordList(input.opt_in_keywords);
  // One word cannot both unsubscribe and subscribe.
  if (optOut.some((word) => optIn.includes(word))) throw new ConsentSettingsError('invalid_keywords');
  return {
    opt_out_keywords: optOut,
    opt_in_keywords: optIn,
    opt_out_reply: reply(input.opt_out_reply),
    opt_in_reply: reply(input.opt_in_reply),
    opt_out_flow_id: flowId(input.opt_out_flow_id),
    opt_in_flow_id: flowId(input.opt_in_flow_id),
  };
}

type SettingsRow = InstagramConsentSettings;

/** The workspace's consent settings inside an existing tenant transaction; defaults when never saved. */
export async function readConsentSettings(tx: TenantTransaction, accountId: string): Promise<InstagramConsentSettings> {
  const rows = await tx.$queryRaw<SettingsRow[]>`SELECT opt_out_keywords, opt_in_keywords, opt_out_reply, opt_in_reply,
      opt_out_flow_id::text AS opt_out_flow_id, opt_in_flow_id::text AS opt_in_flow_id
    FROM instagram_consent_settings WHERE account_id=${accountId}::uuid`;
  const row = rows[0];
  if (!row) return { ...DEFAULT_CONSENT_SETTINGS };
  return {
    opt_out_keywords: row.opt_out_keywords ?? [], opt_in_keywords: row.opt_in_keywords ?? [],
    opt_out_reply: row.opt_out_reply, opt_in_reply: row.opt_in_reply,
    opt_out_flow_id: row.opt_out_flow_id, opt_in_flow_id: row.opt_in_flow_id,
  };
}

/** Members read the settings as themselves. */
export function loadConsentSettings(tenant: TenantContext): Promise<InstagramConsentSettings> {
  return withTenant(tenant, (tx) => readConsentSettings(tx, tenant.accountId));
}

/** The worker's read for inbound processing. */
export function workerConsentSettings(accountId: string): Promise<InstagramConsentSettings> {
  return withTenant({ accountId, role: 'owner' }, (tx) => readConsentSettings(tx, accountId), getWorkerPrisma());
}

/**
 * Saves the settings as the admin (RLS admin write). Each attached flow must be
 * a flow of this workspace that can run on Instagram (scope instagram or any)
 * and is not archived; anything else is invalid_flow, so another workspace's
 * flow id is refused without saying whether it exists.
 */
export async function saveConsentSettings(tenant: TenantContext, settings: InstagramConsentSettings): Promise<InstagramConsentSettings> {
  return withTenant(tenant, async (tx) => {
    const ids = [settings.opt_out_flow_id, settings.opt_in_flow_id].filter((id): id is string => id !== null);
    if (ids.length) {
      const found = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM flows
        WHERE account_id=${tenant.accountId}::uuid AND id = ANY(${ids}::uuid[])
          AND channel_scope IN ('instagram','any') AND archived_at IS NULL`;
      const known = new Set(found.map((row) => row.id));
      if (ids.some((id) => !known.has(id))) throw new ConsentSettingsError('invalid_flow');
    }
    await tx.$executeRaw`INSERT INTO instagram_consent_settings(account_id, opt_out_keywords, opt_in_keywords, opt_out_reply,
        opt_in_reply, opt_out_flow_id, opt_in_flow_id, updated_by)
      VALUES(${tenant.accountId}::uuid, ${settings.opt_out_keywords}::text[], ${settings.opt_in_keywords}::text[],
        ${settings.opt_out_reply}, ${settings.opt_in_reply}, ${settings.opt_out_flow_id}::uuid, ${settings.opt_in_flow_id}::uuid,
        ${tenant.userId ?? null}::uuid)
      ON CONFLICT(account_id) DO UPDATE SET opt_out_keywords=EXCLUDED.opt_out_keywords, opt_in_keywords=EXCLUDED.opt_in_keywords,
        opt_out_reply=EXCLUDED.opt_out_reply, opt_in_reply=EXCLUDED.opt_in_reply, opt_out_flow_id=EXCLUDED.opt_out_flow_id,
        opt_in_flow_id=EXCLUDED.opt_in_flow_id, updated_by=EXCLUDED.updated_by`;
    return readConsentSettings(tx, tenant.accountId);
  });
}
