import { Prisma } from '@prisma/client';
import type { AccountRole } from '@/lib/auth/roles';
import { withTenant } from '@/lib/db/tenant';
import { MASK_CHAR, maskPhone, maskPhonesInText, shouldMask } from './masking';

/**
 * Server-side enforcement of per-member phone masking
 * (account_memberships.mask_phone_numbers). Everything that can hand a
 * contact's number to a masked member's browser goes through these helpers:
 * the generic CRM resource API, the contacts-by-tags RPC, realtime events,
 * audience pages and the fixed routes that embed a contact. Sends never use
 * these values: they resolve the number server-side from the contact id.
 *
 * Search is limited for masked members so a number cannot be confirmed by
 * probing: a phone search may use at most the last four digits, and is always
 * compiled as a suffix match on the number's digits.
 */

/** Contact columns that carry a number (or a number-derived WhatsApp id). */
export const MASKED_CONTACT_FIELDS = ['phone', 'phone_normalized', 'wa_user_id', 'wa_parent_user_id'] as const;
export type MaskedContactField = (typeof MASKED_CONTACT_FIELDS)[number];
const MASKED = new Set<string>(MASKED_CONTACT_FIELDS);

export function isMaskedContactField(field: string): field is MaskedContactField {
  return MASKED.has(field);
}

/** Most digits a masked member may search a number by (its last four). */
export const MAX_MASKED_SEARCH_DIGITS = 4;

/**
 * Wraps a masked column in SQL projections (src/lib/repositories/query.ts) so
 * the formatted mask from masking.ts is applied after the row is read. A
 * PostgreSQL json key cannot be produced by a column name, and maskMarkers
 * replaces only single-key objects carrying it.
 */
export const PHONE_MASK_MARKER = '$bodhinox_masked_phone';

const PHONE_LIKE = /^\+?[\d\s().-]+$/;

/**
 * A contact number or WhatsApp user id as a masked member sees it. Numbers use
 * maskPhone; other ids (business-scoped user ids) keep only a short country
 * prefix and their last three characters.
 */
export function maskContactIdentifier(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  if (PHONE_LIKE.test(trimmed)) return maskPhone(trimmed);
  const prefix = /^[A-Za-z]{2}\./.exec(trimmed)?.[0] ?? '';
  const rest = trimmed.slice(prefix.length);
  const keep = rest.length > 4 ? 3 : Math.min(1, rest.length);
  return prefix + MASK_CHAR.repeat(Math.max(rest.length - keep, 1)) + rest.slice(rest.length - keep);
}

/** A copy of a contact-shaped object with its number fields masked (or the object itself when mask is false). */
export function maskContactRow<T>(row: T, mask: boolean): T {
  if (!mask || !row || typeof row !== 'object' || Array.isArray(row)) return row;
  const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const field of MASKED_CONTACT_FIELDS)
    if (Object.hasOwn(out, field)) out[field] = maskContactIdentifier(out[field]);
  return out as T;
}

/** maskContactRow for an object's nested `contact` (as fixed routes embed it). */
export function maskEmbeddedContact<T>(row: T, mask: boolean): T {
  if (!mask || !row || typeof row !== 'object' || Array.isArray(row)) return row;
  const record = row as Record<string, unknown>;
  if (!record.contact || typeof record.contact !== 'object') return row;
  return { ...record, contact: maskContactRow(record.contact, true) } as T;
}

/** Replaces every PHONE_MASK_MARKER object in a JSON value with the masked value. */
export function maskMarkers<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => maskMarkers(item)) as T;
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 1 && keys[0] === PHONE_MASK_MARKER) {
    const raw = record[PHONE_MASK_MARKER];
    return (raw == null ? null : maskContactIdentifier(raw)) as T;
  }
  return Object.fromEntries(keys.map((key) => [key, maskMarkers(record[key])])) as T;
}

/** Free-text notification fields that may quote a number (e.g. a title naming a contact). */
const NOTIFICATION_TEXT_FIELDS = ['title', 'body'] as const;

/**
 * A copy of a notification row with phone-number-looking runs in its title and
 * body masked (or the row itself when mask is false). Stored text is unchanged:
 * masking is applied when a masked member reads it.
 */
export function maskNotificationRow<T>(row: T, mask: boolean): T {
  if (!mask || !row || typeof row !== 'object' || Array.isArray(row)) return row;
  const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const field of NOTIFICATION_TEXT_FIELDS)
    if (typeof out[field] === 'string') out[field] = maskPhonesInText(out[field] as string);
  return out as T;
}

/** Every string in a JSON value with phone-number-looking runs masked. */
function maskTextDeep(value: unknown): unknown {
  if (typeof value === 'string') return maskPhonesInText(value);
  if (Array.isArray(value)) return value.map(maskTextDeep);
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskTextDeep(item)]));
}

/**
 * broadcast_recipients.template_params holds each recipient's resolved
 * template variables, which can include the contact's own number (a campaign
 * may map a variable to the contact's phone). Masks numbers in every
 * `template_params` value at any depth of a result, so an embedded
 * broadcast_recipients(...) projection is covered too. Stored values (used by
 * the sender) are unchanged.
 */
export function maskTemplateParams<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => maskTemplateParams(item)) as T;
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, key === 'template_params' ? maskTextDeep(item) : maskTemplateParams(item)]),
  ) as T;
}

/**
 * Realtime outbox payloads carry whole rows in `new`/`old`. Mask any number
 * field in them (only contacts rows have these columns), numbers quoted in
 * notification titles and bodies, and numbers in broadcast recipients'
 * template variables.
 */
export function maskRealtimePayload(payload: unknown, mask: boolean): unknown {
  if (!mask || !payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const event = payload as Record<string, unknown>;
  const maskRow = (row: unknown) =>
    event.table === 'notifications'
      ? maskNotificationRow(row, true)
      : event.table === 'broadcast_recipients'
        ? maskTemplateParams(row)
        : maskContactRow(row, true);
  return { ...event, new: maskRow(event.new), old: maskRow(event.old) };
}


export type MaskedPhoneSearch =
  /** No digits: the term cannot match a number's digits; search as usual. */
  | { kind: 'text' }
  /** 1..4 digits: match numbers ending in these digits. */
  | { kind: 'suffix'; digits: string }
  /** More digits than a masked member may search by: match nothing. */
  | { kind: 'deny' };

/** How a masked member's phone search term may be applied. Wildcards (% * _) and spacing are ignored. */
export function classifyMaskedPhoneSearch(term: string): MaskedPhoneSearch {
  const digits = term.replace(/\D/g, '');
  if (!digits) return { kind: 'text' };
  if (digits.length > MAX_MASKED_SEARCH_DIGITS) return { kind: 'deny' };
  return { kind: 'suffix', digits };
}

/** SQL suffix match on a number column's digits (a `LIKE` pattern needs no escaping: digits only). */
export function phoneSuffixPattern(digits: string): string {
  return `%${digits}`;
}

/**
 * The phone part of a free-text search for a masked member, over a number
 * column expression: suffix-of-digits when the term has 1..4 digits, FALSE when
 * it has more, and an ordinary contains match otherwise.
 */
export function maskedPhoneSearchSql(column: Prisma.Sql, term: string): Prisma.Sql {
  const search = classifyMaskedPhoneSearch(term);
  if (search.kind === 'deny') return Prisma.sql`FALSE`;
  if (search.kind === 'suffix')
    return Prisma.sql`regexp_replace(COALESCE(${column},''),'[^0-9]','','g') LIKE ${phoneSuffixPattern(search.digits)}`;
  return Prisma.sql`${column} ILIKE ${`%${term}%`}`;
}

/** Whether an audience filter (src/lib/audience/filter.ts) would let a masked member probe numbers. */
export function audienceFilterProbesPhone(filter: { conditions: { field: string; value?: unknown }[] }): boolean {
  return filter.conditions.some(
    (c) => c.field === 'phone' && typeof c.value === 'string' && /\d/.test(c.value),
  );
}

export interface PhoneMaskTransaction {
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
}
export interface PhoneMaskContext {
  accountId: string;
  userId?: string;
  role?: AccountRole | null;
}

/**
 * Whether this member's numbers must be masked, from the live membership row
 * inside the caller's tenant transaction. Owners/admins are never masked; a
 * context with no user (worker, internal server calls) is never masked; a
 * user with no membership row fails closed to masked.
 */
export async function loadPhoneMask(tx: PhoneMaskTransaction, context: PhoneMaskContext): Promise<boolean> {
  if (!context.userId) return false;
  if (context.role === 'owner' || context.role === 'admin') return false;
  const rows = await tx.$queryRawUnsafe<{ role: AccountRole; mask_phone_numbers: boolean }[]>(
    'SELECT role::text AS role, mask_phone_numbers FROM account_memberships WHERE account_id=$1::uuid AND user_id=$2::uuid LIMIT 1',
    context.accountId,
    context.userId,
  );
  if (!rows[0]) return true;
  return shouldMask(rows[0].role, rows[0]);
}

/** loadPhoneMask in its own tenant transaction, for routes that read through other helpers. */
export function resolvePhoneMask(context: PhoneMaskContext): Promise<boolean> {
  if (!context.userId || context.role === 'owner' || context.role === 'admin') return Promise.resolve(false);
  return withTenant({ accountId: context.accountId, userId: context.userId, role: context.role ?? undefined }, (tx) =>
    loadPhoneMask(tx, context));
}

/** Message for refusals that would reveal a masked number. */
export const PHONE_MASKED_MESSAGE = 'Phone numbers are masked for your account';
