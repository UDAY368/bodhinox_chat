// Contact search for pickers and the global search: name (case-insensitive
// contains), phone (digits-only contains, so "98765 43210", "+91 98765" and
// "9876543210" all match) or Instagram username, newest first, keyset paged.
// A member whose numbers are masked gets masked numbers back and may search a
// number only by its last four digits (src/lib/inbox/masking-apply.ts).
import { Prisma } from '@prisma/client';

import { compileAudienceFilter } from '@/lib/audience/filter';
import { channelFilter } from '@/lib/contacts/bulk';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { classifyMaskedPhoneSearch, loadPhoneMask, maskContactIdentifier, phoneSuffixPattern } from '@/lib/inbox/masking-apply';
import { containsPattern, decodeCursor, encodeCursor, isPhoneTerm, searchDigits } from './normalise';

export type SearchChannel = 'whatsapp' | 'instagram';

export interface ContactSearchHit {
  id: string;
  name: string | null;
  phone: string | null;
  avatarUrl: string | null;
  /** The channel the contact is reachable on: WhatsApp when it has a number, else Instagram, else null. */
  channel: SearchChannel | null;
}

export interface ContactSearchInput {
  q?: string;
  cursor?: string | null;
  limit?: number;
  channel?: SearchChannel;
}

export const CONTACT_SEARCH_DEFAULT_LIMIT = 20;
export const CONTACT_SEARCH_MAX_LIMIT = 50;

/**
 * The search condition over `contacts c` (Prisma.empty for an empty term). A
 * phone-only term matches the number's digits; any other term matches the
 * name and, unless masked, the Instagram username.
 */
export function contactMatchSql(term: string, maskPhones: boolean): Prisma.Sql {
  const q = term.trim();
  if (!q) return Prisma.empty;
  const like = containsPattern(q);
  const name = Prisma.sql`c.name ILIKE ${like}`;
  if (isPhoneTerm(q)) {
    const digits = searchDigits(q);
    if (!maskPhones) return Prisma.sql`AND (${name} OR c.phone_normalized LIKE ${`%${digits}%`})`;
    const masked = classifyMaskedPhoneSearch(q);
    return masked.kind === 'suffix'
      ? Prisma.sql`AND (${name} OR c.phone_normalized LIKE ${phoneSuffixPattern(masked.digits)})`
      : Prisma.sql`AND ${name}`;
  }
  if (maskPhones) return Prisma.sql`AND ${name}`;
  const handle = containsPattern(q.replace(/^@/, ''));
  return Prisma.sql`AND (${name} OR EXISTS (SELECT 1 FROM contact_channel_identities i
    WHERE i.account_id=c.account_id AND i.contact_id=c.id AND i.channel='instagram' AND i.username ILIKE ${handle}))`;
}

type ContactRow = { id: string; name: string | null; phone: string | null; avatar_url: string | null; at: string | null; has_ig: boolean };

/** Microsecond creation time as text, so a cursor never loses precision. */
export const CREATED_AT_TEXT = Prisma.sql`to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Contact rows of the caller's account matching `term`, newest first (created_at DESC NULLS FIRST, id DESC). */
export async function contactRows(tx: Prisma.TransactionClient, accountId: string, input: {
  term: string; maskPhones: boolean; limit: number; channel?: SearchChannel; cursor?: string | null;
}): Promise<ContactRow[]> {
  const scope = compileAudienceFilter(accountId, channelFilter({ channel: input.channel, subscribedOnly: false }));
  const cursor = input.cursor ? decodeCursor(input.cursor) : null;
  // DESC puts NULL created_at first, so rows after a NULL position are the
  // NULL rows with a smaller id and every dated row.
  const after = !cursor ? Prisma.empty
    : cursor.at === null
      ? Prisma.sql`AND ((c.created_at IS NULL AND c.id < ${cursor.id}::uuid) OR c.created_at IS NOT NULL)`
      : Prisma.sql`AND (c.created_at, c.id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`;
  return tx.$queryRaw<ContactRow[]>(Prisma.sql`
    SELECT c.id::text AS id, c.name, NULLIF(c.phone, '') AS phone, c.avatar_url, ${CREATED_AT_TEXT} AS at,
      EXISTS (SELECT 1 FROM contact_channel_identities i
        WHERE i.account_id=c.account_id AND i.contact_id=c.id AND i.channel='instagram') AS has_ig
    FROM contacts c
    WHERE ${scope} ${contactMatchSql(input.term, input.maskPhones)} ${after}
    ORDER BY c.created_at DESC, c.id DESC
    LIMIT ${input.limit}`);
}

export function contactHit(row: ContactRow, maskPhones: boolean): ContactSearchHit {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone && maskPhones ? (maskContactIdentifier(row.phone) as string) : row.phone,
    avatarUrl: row.avatar_url,
    channel: row.phone ? 'whatsapp' : row.has_ig ? 'instagram' : null,
  };
}

/** One page of the caller's contacts matching `q` (the newest contacts when q is empty). */
export async function searchContacts(ctx: TenantContext, input: ContactSearchInput):
  Promise<{ contacts: ContactSearchHit[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? CONTACT_SEARCH_DEFAULT_LIMIT), 1), CONTACT_SEARCH_MAX_LIMIT);
  return withTenant(ctx, async (tx) => {
    const maskPhones = await loadPhoneMask(tx, ctx);
    const rows = await contactRows(tx, ctx.accountId, { term: input.q ?? '', maskPhones, limit: limit + 1, channel: input.channel, cursor: input.cursor });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      contacts: page.map((row) => contactHit(row, maskPhones)),
      nextCursor: rows.length > limit && last ? encodeCursor({ at: last.at, id: last.id }) : null,
    };
  });
}
