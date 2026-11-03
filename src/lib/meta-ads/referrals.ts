// Click-to-WhatsApp ad referrals (part b: always on, no Meta call).
//
// The Cloud API webhook puts a `referral` object on the first message a
// customer sends after tapping an ad or a boosted post. parseReferral turns it
// into a bounded value that always satisfies the ad_referrals CHECKs (see
// prisma/migrations/20261104101000_ad_referrals): the insert runs inside the
// inbound-message transaction, so a CHECK failure would drop the message.
// recordReferralTx also runs the insert under a savepoint, so even an
// unexpected database error leaves the message transaction intact.
//
// The click id (ctwa_clid) is never logged, never put in a job payload or flow
// variable, and is readable by the worker role only.
import type { TenantTransaction } from '@/lib/db/tenant';

/** The raw `messages[].referral` object as Meta sends it (every field optional and untrusted). */
export interface WhatsAppReferral {
  source_url?: unknown;
  source_id?: unknown;
  source_type?: unknown;
  headline?: unknown;
  body?: unknown;
  media_type?: unknown;
  image_url?: unknown;
  video_url?: unknown;
  thumbnail_url?: unknown;
  ctwa_clid?: unknown;
  [key: string]: unknown;
}

export type AdReferralSourceType = 'ad' | 'post' | 'unknown';

export interface AdReferral {
  sourceId: string | null;
  sourceType: AdReferralSourceType;
  sourceUrl: string | null;
  headline: string | null;
  body: string | null;
  mediaType: 'image' | 'video' | null;
  ctwaClid: string | null;
}

/** The summary carried in the inbound-actions job payload (never the click id). */
export interface AdReferralSummary {
  id: string;
  sourceId: string | null;
  sourceType: AdReferralSourceType;
  headline: string | null;
  sourceUrl: string | null;
}

export const REFERRAL_LIMITS = {
  sourceUrl: 2048,
  headline: 1024,
  body: 4096,
  ctwaClid: 512,
  waMessageId: 256,
  summaryHeadline: 256,
} as const;

const SOURCE_ID = /^[0-9_]{1,64}$/;
const AD_ID = /^\d{1,32}$/;
// Postgres text rejects NUL; other C0/C1 controls are dropped too (newlines and tabs kept for body text).
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

// A surrogate pair, or an unpaired surrogate. jsonb rejects an unpaired one, and the job
// payload insert runs in the message transaction, so one would drop the inbound message.
const SURROGATE = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g;

/** Drops controls and unpaired surrogates, then trims. */
function cleanString(value: string): string {
  return value.replace(CONTROL, '').replace(SURROGATE, (unit) => (unit.length === 2 ? unit : '')).trim();
}

/** The first `max` UTF-16 units, never ending in half of a surrogate pair. */
function cutText(value: string, max: number): string {
  const cut = value.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** A trimmed, control-free, well-formed string cut to `max` UTF-16 units (so at most `max` characters), or null. */
function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const clean = cleanString(value);
  if (!clean) return null;
  return clean.length > max ? cutText(clean, max).trimEnd() || null : clean;
}

/** An exact token: kept whole or dropped (a truncated id or URL is wrong, not shorter). */
function exact(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const clean = cleanString(value);
  return clean && clean.length <= max && !/\s/.test(clean) ? clean : null;
}

function httpUrl(value: unknown): string | null {
  const candidate = exact(value, REFERRAL_LIMITS.sourceUrl);
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * Strict, bounded parse of a webhook referral. Never throws. Returns null when
 * the input is not an object or carries nothing usable. Unknown fields are
 * dropped; an id failing its pattern becomes null; an unknown source_type
 * becomes 'unknown'.
 */
export function parseReferral(raw: unknown): AdReferral | null {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const r = raw as WhatsAppReferral;
    const type = typeof r.source_type === 'string' ? r.source_type.trim().toLowerCase() : '';
    const sourceType: AdReferralSourceType = type === 'ad' || type === 'post' ? type : 'unknown';
    const id = typeof r.source_id === 'string' ? r.source_id.trim() : typeof r.source_id === 'number' && Number.isSafeInteger(r.source_id) && r.source_id >= 0 ? String(r.source_id) : '';
    const sourceId = SOURCE_ID.test(id) && (sourceType !== 'ad' || AD_ID.test(id)) ? id : null;
    const media = typeof r.media_type === 'string' ? r.media_type.trim().toLowerCase() : '';
    const referral: AdReferral = {
      sourceId,
      sourceType,
      sourceUrl: httpUrl(r.source_url),
      headline: text(r.headline, REFERRAL_LIMITS.headline),
      body: text(r.body, REFERRAL_LIMITS.body),
      mediaType: media === 'image' || media === 'video' ? media : null,
      ctwaClid: exact(r.ctwa_clid, REFERRAL_LIMITS.ctwaClid),
    };
    if (!referral.sourceId && !referral.ctwaClid && !referral.sourceUrl && !referral.headline && !referral.body) return null;
    return referral;
  } catch {
    return null;
  }
}

/** The job-payload summary: headline cut to 256 UTF-16 units without splitting a surrogate pair, no click id. */
export function toAdReferralSummary(id: string, referral: AdReferral): AdReferralSummary {
  return {
    id,
    sourceId: referral.sourceId,
    sourceType: referral.sourceType,
    headline: referral.headline ? cutText(referral.headline, REFERRAL_LIMITS.summaryHeadline).trimEnd() || null : null,
    sourceUrl: referral.sourceUrl,
  };
}

export interface RecordReferralInput {
  accountId: string;
  contactId: string;
  conversationId: string | null;
  messageId: string | null;
  /** Meta's message id (wamid); the redelivery key. */
  waMessageId: string;
  whatsappConfigId: string | null;
  referral: AdReferral;
}

/**
 * Stores the referral in the caller's (worker) transaction. Idempotent on
 * (account_id, wa_message_id). Returns the new row id, or null when the row
 * already existed or could not be stored; it never throws, so the inbound
 * message is kept whatever happens here.
 */
export async function recordReferralTx(tx: TenantTransaction, input: RecordReferralInput): Promise<string | null> {
  const wamid = input.waMessageId;
  if (typeof wamid !== 'string' || wamid.length < 1 || wamid.length > REFERRAL_LIMITS.waMessageId) return null;
  const r = input.referral;
  await tx.$executeRaw`SAVEPOINT ad_referral`;
  try {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO ad_referrals(account_id, contact_id, conversation_id, message_id, wa_message_id, whatsapp_config_id,
        source_id, source_type, source_url, headline, body, media_type, ctwa_clid)
      VALUES (${input.accountId}::uuid, ${input.contactId}::uuid, ${input.conversationId}::uuid, ${input.messageId}::uuid,
        ${wamid}, ${input.whatsappConfigId}::uuid, ${r.sourceId}, ${r.sourceType}, ${r.sourceUrl}, ${r.headline},
        ${r.body}, ${r.mediaType}, ${r.ctwaClid})
      ON CONFLICT (account_id, wa_message_id) DO NOTHING
      RETURNING id::text AS id`;
    await tx.$executeRaw`RELEASE SAVEPOINT ad_referral`;
    return rows[0]?.id ?? null;
  } catch {
    await tx.$executeRaw`ROLLBACK TO SAVEPOINT ad_referral`;
    console.error('[meta-ads] ad referral not stored');
    return null;
  }
}

export interface AttributableReferral {
  id: string;
  whatsapp_config_id: string | null;
}

/**
 * The contact's newest referral with a click id from the last `withinDays`
 * days, optionally only on the given numbers. Reads app-visible columns only
 * (has_click_id, never ctwa_clid), so it works in app-role and worker
 * transactions alike.
 */
export async function latestAttributableReferralTx(tx: TenantTransaction, accountId: string, contactId: string,
  withinDays = 7, whatsappConfigIds?: string[]): Promise<AttributableReferral | null> {
  const days = Number.isInteger(withinDays) && withinDays > 0 && withinDays <= 90 ? withinDays : 7;
  const numbers = whatsappConfigIds ? JSON.stringify(whatsappConfigIds) : null;
  if (whatsappConfigIds && whatsappConfigIds.length === 0) return null;
  const rows = await tx.$queryRaw<AttributableReferral[]>`
    SELECT id::text AS id, whatsapp_config_id::text AS whatsapp_config_id FROM ad_referrals
    WHERE account_id = ${accountId}::uuid AND contact_id = ${contactId}::uuid AND has_click_id
      AND created_at >= now() - make_interval(days => ${days}::int)
      AND (${numbers}::jsonb IS NULL OR whatsapp_config_id IN (SELECT value::uuid FROM jsonb_array_elements_text(${numbers}::jsonb)))
    ORDER BY created_at DESC
    LIMIT 1`;
  return rows[0] ?? null;
}
