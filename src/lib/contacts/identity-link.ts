// Staff linking of channel identities (Phase 11, CRM-02). Identities are never
// linked automatically: not by phone, name, username, email or picture. A link
// is an audited admin decision that moves an Instagram identity, and its
// Instagram conversation, to another contact. Both conversation histories are
// kept, and the move can be undone (unlink). Runs on the app role inside the
// caller's tenant transaction, so RLS decides who may write: identities and
// link history are admin-only writes (20261109100500_contact_channel_identities).
import { Prisma } from '@prisma/client';
import type { AccountRole } from '@/lib/auth/roles';
import { hasMinRole } from '@/lib/auth/roles';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';

export type IdentityLinkErrorCode = 'identity_conflict' | 'identity_busy' | 'not_found' | 'forbidden' | 'invalid_request';

export class IdentityLinkError extends Error {
  constructor(readonly code: IdentityLinkErrorCode) {
    super(`Identity link: ${code}`);
    this.name = 'IdentityLinkError';
  }
}

export interface IdentityLinkActor {
  accountId: string;
  userId: string;
  role: AccountRole;
}

export interface ContactIdentityView {
  id: string;
  channel: 'instagram';
  instagramAccountId: string;
  username: string | null;
  displayName: string | null;
  createdAt: Date;
  /** The identity came to this contact by a staff link, so it can be moved back. */
  canUnlink: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const IDENTITY_NOTE_MAX = 200;

const tenant = (actor: IdentityLinkActor) => ({ accountId: actor.accountId, userId: actor.userId, role: actor.role });

function requireAdmin(actor: IdentityLinkActor): void {
  if (!hasMinRole(actor.role, 'admin')) throw new IdentityLinkError('forbidden');
}

function normaliseNote(note: string | null | undefined): string | null {
  if (note === null || note === undefined) return null;
  if (typeof note !== 'string') throw new IdentityLinkError('invalid_request');
  const value = note.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if ([...value].length > IDENTITY_NOTE_MAX) throw new IdentityLinkError('invalid_request');
  return value || null;
}

/** The Instagram identities of a contact (any member may read them). */
export async function listContactIdentities(actor: IdentityLinkActor, contactId: string): Promise<ContactIdentityView[]> {
  if (!UUID.test(contactId)) throw new IdentityLinkError('not_found');
  return withTenant(tenant(actor), async (tx) => {
    const rows = await tx.$queryRaw<{ id: string; instagram_account_id: string; username: string | null; display_name: string | null;
      created_at: Date; last_kind: string | null; last_to: string | null }[]>(Prisma.sql`
      SELECT i.id::text AS id, i.instagram_account_id::text AS instagram_account_id, i.username, i.display_name, i.created_at,
        l.kind AS last_kind, l.to_contact_id::text AS last_to
      FROM contact_channel_identities i
      LEFT JOIN LATERAL (SELECT kind, to_contact_id FROM contact_identity_links h
        WHERE h.account_id=i.account_id AND h.identity_id=i.id ORDER BY h.created_at DESC, h.id DESC LIMIT 1) l ON true
      WHERE i.account_id=${actor.accountId}::uuid AND i.contact_id=${contactId}::uuid
      ORDER BY i.created_at, i.id`);
    // No identities: answer an unknown or another workspace's contact as not found, not as an empty list.
    if (!rows.length) {
      const found = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT id::text AS id FROM contacts WHERE account_id=${actor.accountId}::uuid AND id=${contactId}::uuid`);
      if (!found.length) throw new IdentityLinkError('not_found');
    }
    return rows.map((row) => ({
      id: row.id,
      channel: 'instagram' as const,
      instagramAccountId: row.instagram_account_id,
      username: row.username,
      displayName: row.display_name,
      createdAt: new Date(row.created_at),
      canUnlink: row.last_kind === 'link' && row.last_to === contactId,
    }));
  });
}

interface LockedIdentity {
  id: string;
  contact_id: string;
  instagram_account_id: string;
  username: string | null;
  display_name: string | null;
}

/**
 * The transaction lock that serialises everything done to one Instagram sender
 * (instagram account, IGSID): webhook ingest (process-webhook resolveThread)
 * and staff link/unlink. Both take it before any row lock, so they cannot
 * deadlock, and ingest never resolves a thread from an identity a link is moving.
 */
export async function lockInstagramSender(tx: TenantTransaction, instagramAccountId: string, igsid: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`igsid:${instagramAccountId.toLowerCase()}:${igsid}`}))`;
}

/**
 * Takes the sender lock of an identity before any row lock. An identity's
 * (instagram account, IGSID) never changes, so the unlocked read is safe;
 * another workspace's id is not found.
 */
async function lockSenderOf(tx: TenantTransaction, accountId: string, identityId: string): Promise<void> {
  const [row] = await tx.$queryRaw<{ instagram_account_id: string; external_id: string }[]>(Prisma.sql`
    SELECT instagram_account_id::text AS instagram_account_id, external_id FROM contact_channel_identities
    WHERE account_id=${accountId}::uuid AND id=${identityId}::uuid`);
  if (!row) throw new IdentityLinkError('not_found');
  await lockInstagramSender(tx, row.instagram_account_id, row.external_id);
}

/** Locks the identity; another workspace's id, or one not on `contactId`, is not found. */
async function lockIdentity(tx: TenantTransaction, accountId: string, identityId: string, contactId: string): Promise<LockedIdentity> {
  const [identity] = await tx.$queryRaw<LockedIdentity[]>(Prisma.sql`
    SELECT id::text AS id, contact_id::text AS contact_id, instagram_account_id::text AS instagram_account_id, username, display_name
    FROM contact_channel_identities WHERE account_id=${accountId}::uuid AND id=${identityId}::uuid FOR UPDATE`);
  if (!identity || identity.contact_id !== contactId) throw new IdentityLinkError('not_found');
  return identity;
}

/** Locks both contacts in id order (no deadlock between opposite moves); returns the ids found. */
async function lockContacts(tx: TenantTransaction, accountId: string, ids: string[]): Promise<Set<string>> {
  const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT id::text AS id FROM contacts WHERE account_id=${accountId}::uuid
      AND id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY id FOR UPDATE`);
  return new Set(rows.map((row) => row.id));
}

/**
 * Moves the identity and its Instagram conversation from `fromContactId` to
 * `toContactId`, after the conflict and busy checks. The conversation keeps
 * every message; nothing is sent and no WhatsApp row is touched.
 */
async function moveIdentity(tx: TenantTransaction, actor: IdentityLinkActor, identity: LockedIdentity,
  fromContactId: string, toContactId: string): Promise<void> {
  const accountId = actor.accountId;
  // The target may not already hold this Instagram account: the conversation key
  // (contact, instagram account) is unique and a send picks the contact's identity on that account.
  const [conflict] = await tx.$queryRaw<{ found: boolean }[]>(Prisma.sql`
    SELECT (EXISTS(SELECT 1 FROM conversations WHERE account_id=${accountId}::uuid AND contact_id=${toContactId}::uuid
        AND channel='instagram' AND instagram_account_id=${identity.instagram_account_id}::uuid)
      OR EXISTS(SELECT 1 FROM contact_channel_identities WHERE account_id=${accountId}::uuid AND contact_id=${toContactId}::uuid
        AND instagram_account_id=${identity.instagram_account_id}::uuid)) AS found`);
  if (conflict?.found) throw new IdentityLinkError('identity_conflict');
  const conversations = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT id::text AS id FROM conversations WHERE account_id=${accountId}::uuid AND contact_id=${fromContactId}::uuid
      AND channel='instagram' AND instagram_account_id=${identity.instagram_account_id}::uuid FOR UPDATE`);
  const conversationIds = conversations.map((row) => row.id);
  if (conversationIds.length) {
    // An active run is keyed by (contact, conversation); moving the conversation would orphan it.
    // So would an inbound.actions job still pending or running with the old contact for this
    // conversation: it could start a run or write tags/consent under that contact after the move.
    // Ingest queues that job while holding the conversation row lock taken above, so a job that
    // committed first is seen here, and a later delivery already sees the new contact.
    const ids = Prisma.join(conversationIds.map((id) => Prisma.sql`${id}::uuid`));
    const [busy] = await tx.$queryRaw<{ found: boolean }[]>(Prisma.sql`
      SELECT (EXISTS(SELECT 1 FROM flow_runs WHERE account_id=${accountId}::uuid AND status='active' AND conversation_id IN (${ids}))
        OR EXISTS(SELECT 1 FROM jobs WHERE tenant_id=${accountId}::uuid AND type='inbound.actions'
          AND status IN ('pending','running') AND payload->>'conversationId' IN (${Prisma.join(conversationIds)}))) AS found`);
    if (busy?.found) throw new IdentityLinkError('identity_busy');
  }
  await tx.$executeRaw(Prisma.sql`UPDATE contact_channel_identities SET contact_id=${toContactId}::uuid, updated_at=now()
    WHERE account_id=${accountId}::uuid AND id=${identity.id}::uuid`);
  if (conversationIds.length)
    await tx.$executeRaw(Prisma.sql`UPDATE conversations SET contact_id=${toContactId}::uuid, updated_at=now()
      WHERE account_id=${accountId}::uuid AND id IN (${Prisma.join(conversationIds.map((id) => Prisma.sql`${id}::uuid`))})
        AND channel='instagram'`);
}

async function recordDecision(tx: TenantTransaction, actor: IdentityLinkActor, kind: 'link' | 'unlink', identityId: string,
  fromContactId: string, toContactId: string, note: string | null): Promise<string> {
  const [row] = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    INSERT INTO contact_identity_links(account_id,identity_id,from_contact_id,to_contact_id,kind,basis,note,decided_by_user_id)
    VALUES(${actor.accountId}::uuid,${identityId}::uuid,${fromContactId}::uuid,${toContactId}::uuid,${kind},'staff_decision',${note},
      ${actor.userId}::uuid)
    RETURNING id::text AS id`);
  // Ids only: no names, usernames or note text in the audit log.
  await tx.$executeRaw(Prisma.sql`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
    VALUES(${actor.accountId}::uuid,${actor.userId}::uuid,${kind === 'link' ? 'contact.identity_link' : 'contact.identity_unlink'},
      ${identityId},${JSON.stringify({ link_id: row.id, from_contact_id: fromContactId, to_contact_id: toContactId })}::jsonb)`);
  return row.id;
}

/** Admin: move an Instagram identity (and its conversation) from `contactId` to `targetContactId`. */
export async function linkIdentity(actor: IdentityLinkActor,
  input: { contactId: string; identityId: string; targetContactId: string; note?: string | null }): Promise<{ linkId: string }> {
  requireAdmin(actor);
  const note = normaliseNote(input.note);
  if (![input.contactId, input.identityId, input.targetContactId].every((id) => typeof id === 'string' && UUID.test(id)))
    throw new IdentityLinkError('not_found');
  if (input.contactId.toLowerCase() === input.targetContactId.toLowerCase()) throw new IdentityLinkError('invalid_request');
  return withTenant(tenant(actor), async (tx) => {
    await lockSenderOf(tx, actor.accountId, input.identityId);
    const found = await lockContacts(tx, actor.accountId, [input.contactId, input.targetContactId]);
    if (!found.has(input.contactId.toLowerCase()) || !found.has(input.targetContactId.toLowerCase())) throw new IdentityLinkError('not_found');
    const identity = await lockIdentity(tx, actor.accountId, input.identityId, input.contactId.toLowerCase());
    await moveIdentity(tx, actor, identity, identity.contact_id, input.targetContactId.toLowerCase());
    const linkId = await recordDecision(tx, actor, 'link', identity.id, identity.contact_id, input.targetContactId.toLowerCase(), note);
    return { linkId };
  });
}

/**
 * Admin: undo the latest link of an identity on `contactId`. It goes back to
 * the contact it came from, or to a new phone-less contact when that one was
 * deleted since.
 */
export async function unlinkIdentity(actor: IdentityLinkActor,
  input: { contactId: string; identityId: string; note?: string | null }): Promise<{ linkId: string; contactId: string }> {
  requireAdmin(actor);
  const note = normaliseNote(input.note);
  if (![input.contactId, input.identityId].every((id) => typeof id === 'string' && UUID.test(id))) throw new IdentityLinkError('not_found');
  const contactId = input.contactId.toLowerCase();
  return withTenant(tenant(actor), async (tx) => {
    await lockSenderOf(tx, actor.accountId, input.identityId);
    const found = await lockContacts(tx, actor.accountId, [contactId]);
    if (!found.has(contactId)) throw new IdentityLinkError('not_found');
    const identity = await lockIdentity(tx, actor.accountId, input.identityId, contactId);
    const [last] = await tx.$queryRaw<{ kind: string; from_contact_id: string; to_contact_id: string }[]>(Prisma.sql`
      SELECT kind, from_contact_id::text AS from_contact_id, to_contact_id::text AS to_contact_id FROM contact_identity_links
      WHERE account_id=${actor.accountId}::uuid AND identity_id=${identity.id}::uuid ORDER BY created_at DESC, id DESC LIMIT 1`);
    // Only an identity a staff member linked here can be unlinked; a first-seen identity has nowhere to go back to.
    if (!last || last.kind !== 'link' || last.to_contact_id !== contactId) throw new IdentityLinkError('invalid_request');
    let targetId = last.from_contact_id;
    const back = await lockContacts(tx, actor.accountId, [targetId]);
    if (!back.has(targetId)) {
      // Only the profile's display name may become the contact name. The username is an
      // identifier that masking hides, so it is never copied into contacts.name.
      const [created] = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        INSERT INTO contacts(account_id,user_id,phone,name)
        VALUES(${actor.accountId}::uuid,${actor.userId}::uuid,'',${identity.display_name})
        RETURNING id::text AS id`);
      targetId = created.id;
    }
    await moveIdentity(tx, actor, identity, contactId, targetId);
    const linkId = await recordDecision(tx, actor, 'unlink', identity.id, contactId, targetId, note);
    return { linkId, contactId: targetId };
  });
}
