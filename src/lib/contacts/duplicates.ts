// Contact duplicate finder (batch 7). Pairs of contacts in the caller's
// workspace that are probably the same person, found in SQL and paged by a
// keyset cursor (no contact list is loaded into the browser):
//   phone      the same number with and without a trunk 0 after a 1-3 digit
//              country code (phoneVariants in src/lib/whatsapp/phone-utils.ts;
//              equal numbers cannot exist, phone_normalized is unique), found
//              through contacts_trunk_phone_idx and the unique phone index;
//   email      the same address, case and spaces ignored (contacts_email_key_idx);
//   name       the same name on an Instagram-only contact and a WhatsApp-only
//              contact (contacts_name_key_idx).
// A pair an admin marked "Not duplicates" is never offered again. Admins and
// owners only (they are never phone-masked; the mask is still applied).
import { Prisma } from '@prisma/client';
import { hasMinRole, type AccountRole } from '@/lib/auth/roles';
import { withTenant } from '@/lib/db/tenant';
import { loadPhoneMask, maskContactRow } from '@/lib/inbox/masking-apply';

export type DuplicateReason = 'phone' | 'email' | 'name';

export interface DuplicateContact {
  id: string;
  name: string | null;
  phone: string;
  email: string | null;
  created_at: string | null;
  instagram: boolean;
  conversations: number;
}

export interface DuplicatePair {
  reasons: DuplicateReason[];
  contacts: [DuplicateContact, DuplicateContact];
}

export interface DuplicateActor {
  accountId: string;
  userId: string;
  role: AccountRole;
}

export class DuplicatesError extends Error {
  constructor(readonly code: 'forbidden' | 'not_found' | 'invalid_request', readonly status: number) {
    super(`Contact duplicates: ${code}`);
    this.name = 'DuplicatesError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DUPLICATES_PAGE_MAX = 50;

const tenant = (actor: DuplicateActor) => ({ accountId: actor.accountId, userId: actor.userId, role: actor.role });

function requireAdmin(actor: DuplicateActor): void {
  if (!hasMinRole(actor.role, 'admin')) throw new DuplicatesError('forbidden', 403);
}

/** The cursor is the last pair of a page: "<low id>.<high id>". */
export function parseCursor(cursor: string | null | undefined): [string, string] | null {
  if (!cursor) return null;
  const [low, high, extra] = cursor.split('.');
  if (extra !== undefined || !UUID.test(low ?? '') || !UUID.test(high ?? '')) throw new DuplicatesError('invalid_request', 400);
  return [low.toLowerCase(), high.toLowerCase()];
}

/** One page of likely duplicate pairs, ordered by (lower id, higher id). */
export async function findDuplicates(actor: DuplicateActor, options: { cursor?: string | null; limit?: number } = {})
  : Promise<{ pairs: DuplicatePair[]; nextCursor: string | null }> {
  requireAdmin(actor);
  const after = parseCursor(options.cursor);
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 20), 1), DUPLICATES_PAGE_MAX);
  const acc = actor.accountId;
  return withTenant(tenant(actor), async (tx) => {
    const afterSql = after ? Prisma.sql`AND (p.low, p.high) > (${after[0]}::uuid, ${after[1]}::uuid)` : Prisma.empty;
    const rows = await tx.$queryRaw<{ low: string; high: string; reasons: DuplicateReason[] }[]>(Prisma.sql`
      WITH pairs AS (
        SELECT LEAST(x.id, y.id) AS low, GREATEST(x.id, y.id) AS high, 'phone'::text AS reason
        FROM contacts x
        CROSS JOIN generate_series(1, 3) cc
        JOIN contacts y ON y.account_id = x.account_id
          AND y.phone_normalized = left(x.phone_normalized, cc) || substr(x.phone_normalized, cc + 2)
        WHERE x.account_id = ${acc}::uuid AND x.phone_normalized ~ '^[0-9]{1,3}0[0-9]'
          AND substr(x.phone_normalized, cc + 1, 1) = '0' AND length(x.phone_normalized) >= 9
        UNION ALL
        SELECT x.id, y.id, 'email'
        FROM contacts x JOIN contacts y ON y.account_id = x.account_id AND lower(btrim(y.email)) = lower(btrim(x.email))
          AND btrim(COALESCE(y.email, '')) <> '' AND y.id > x.id
        WHERE x.account_id = ${acc}::uuid AND btrim(COALESCE(x.email, '')) <> ''
        UNION ALL
        SELECT LEAST(ig.id, wa.id), GREATEST(ig.id, wa.id), 'name'
        FROM contacts ig JOIN contacts wa ON wa.account_id = ig.account_id AND lower(btrim(wa.name)) = lower(btrim(ig.name))
          AND btrim(COALESCE(wa.name, '')) <> '' AND wa.id <> ig.id
          AND (wa.phone_normalized <> '' OR wa.wa_user_id IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM contact_channel_identities wi WHERE wi.account_id = wa.account_id AND wi.contact_id = wa.id)
        WHERE ig.account_id = ${acc}::uuid AND btrim(COALESCE(ig.name, '')) <> ''
          AND ig.phone_normalized = '' AND ig.wa_user_id IS NULL
          AND EXISTS (SELECT 1 FROM contact_channel_identities ii WHERE ii.account_id = ig.account_id AND ii.contact_id = ig.id)
      )
      SELECT p.low::text AS low, p.high::text AS high, array_agg(DISTINCT p.reason ORDER BY p.reason) AS reasons
      FROM pairs p
      WHERE NOT EXISTS (SELECT 1 FROM contact_duplicate_dismissals d WHERE d.account_id = ${acc}::uuid
        AND d.contact_low_id = p.low AND d.contact_high_id = p.high) ${afterSql}
      GROUP BY p.low, p.high
      ORDER BY p.low, p.high
      LIMIT ${limit + 1}`);
    const page = rows.slice(0, limit);
    const ids = [...new Set(page.flatMap((row) => [row.low, row.high]))];
    const mask = await loadPhoneMask(tx, actor);
    const contacts = ids.length ? await tx.$queryRaw<(Omit<DuplicateContact, 'created_at' | 'conversations'> & {
      created_at: Date | null; conversations: bigint })[]>(Prisma.sql`
      SELECT c.id::text AS id, c.name, c.phone, c.email, c.created_at,
        EXISTS (SELECT 1 FROM contact_channel_identities i WHERE i.account_id = c.account_id AND i.contact_id = c.id) AS instagram,
        (SELECT count(*) FROM conversations v WHERE v.account_id = c.account_id AND v.contact_id = c.id) AS conversations
      FROM contacts c WHERE c.account_id = ${acc}::uuid AND c.id = ANY (${ids}::uuid[])`) : [];
    const byId = new Map(contacts.map((c) => [c.id, maskContactRow({
      ...c, created_at: c.created_at ? new Date(c.created_at).toISOString() : null, conversations: Number(c.conversations),
    }, mask)]));
    const pairs = page.flatMap((row) => {
      const a = byId.get(row.low), b = byId.get(row.high);
      return a && b ? [{ reasons: row.reasons, contacts: [a, b] as [DuplicateContact, DuplicateContact] }] : [];
    });
    const last = page[page.length - 1];
    return { pairs, nextCursor: rows.length > limit && last ? `${last.low}.${last.high}` : null };
  });
}

/** "Not duplicates": stores the pair so it is never offered again (idempotent). */
export async function dismissDuplicate(actor: DuplicateActor, firstId: string, secondId: string): Promise<void> {
  requireAdmin(actor);
  if (![firstId, secondId].every((id) => typeof id === 'string' && UUID.test(id))) throw new DuplicatesError('not_found', 404);
  const [low, high] = [firstId.toLowerCase(), secondId.toLowerCase()].sort();
  if (low === high) throw new DuplicatesError('invalid_request', 400);
  await withTenant(tenant(actor), async (tx) => {
    const found = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT id::text AS id FROM contacts WHERE account_id = ${actor.accountId}::uuid AND id IN (${low}::uuid, ${high}::uuid)`);
    if (found.length !== 2) throw new DuplicatesError('not_found', 404);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO contact_duplicate_dismissals (account_id, contact_low_id, contact_high_id, dismissed_by_user_id)
      VALUES (${actor.accountId}::uuid, ${low}::uuid, ${high}::uuid, ${actor.userId}::uuid)
      ON CONFLICT DO NOTHING`);
  });
}
