// ============================================================
// The full-page contact profile (/contacts/[id]): field-by-field saves with
// an activity record, typed custom field values, and the overview the page
// shows beside the editable cards (conversations, orders, timeline).
//
// Every query runs in the caller's tenant transaction on the app role, so
// RLS scopes rows to the workspace and to the member's role (contacts are
// written by agents and above; orders are read by agents and above). The
// conversations listed honour the inbox visibility setting. contact_activity
// rows hold field names, ids and states only, never contact details.
// ============================================================

import { Prisma } from '@prisma/client';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { conversationVisibleSql } from '@/lib/inbox/inbox-scope';
import { loadPhoneMask, maskContactIdentifier, maskContactRow } from '@/lib/inbox/masking-apply';
import { parseInternationalPhone } from '@/lib/whatsapp/phone-utils';
import { MAX_CUSTOM_VALUE, normalizeFieldValue, type ValueProblem } from './custom-field-types';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The contact fields the profile saves one at a time. */
export const PROFILE_FIELDS = ['name', 'email', 'company', 'city', 'phone', 'owner_id', 'blocked'] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

const TEXT_LIMITS: Record<'name' | 'email' | 'company' | 'city', number> = { name: 200, email: 320, company: 200, city: 200 };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ProfileErrorCode =
  | 'invalid_field'
  | 'too_long'
  | 'invalid_email'
  | 'invalid_phone'
  | 'duplicate_phone'
  | 'phone_masked'
  | 'phone_required'
  | 'not_member'
  | 'field_not_found'
  | ValueProblem;

/** A refused change; the route answers 400 (409 for a duplicate number, 403 for a masked number). */
export class ProfileError extends Error {
  constructor(readonly code: ProfileErrorCode) {
    super(code);
  }
  get status(): number {
    return this.code === 'duplicate_phone' ? 409 : this.code === 'phone_masked' ? 403 : this.code === 'field_not_found' ? 404 : 400;
  }
}

export type ActivityKind =
  | 'field_changed'
  | 'owner_changed'
  | 'custom_field_changed'
  | 'consent_changed'
  | 'blocked'
  | 'unblocked'
  | 'tag_removed'
  | 'template_sent';

/** Appends one timeline row in the caller's transaction (ids and states only). */
export async function recordContactActivity(
  tx: TenantTransaction,
  ctx: TenantContext,
  contactId: string,
  kind: ActivityKind,
  detail: Record<string, string | boolean | null> = {},
): Promise<void> {
  await tx.$executeRaw`INSERT INTO contact_activity(account_id, contact_id, actor_id, kind, detail)
    VALUES(${ctx.accountId}::uuid, ${contactId}::uuid, ${ctx.userId || null}::uuid, ${kind}, ${JSON.stringify(detail)}::jsonb)`;
}

/** Records an activity in its own tenant transaction; for routes whose change ran elsewhere. */
export function logContactActivity(ctx: TenantContext, contactId: string, kind: ActivityKind,
  detail: Record<string, string | boolean | null> = {}): Promise<void> {
  return withTenant(ctx, (tx) => recordContactActivity(tx, ctx, contactId, kind, detail));
}

/** Whether userId is a member of the workspace (a contact owner must be). */
export async function isWorkspaceMember(tx: TenantTransaction, accountId: string, userId: string): Promise<boolean> {
  if (!UUID_RE.test(userId)) return false;
  const rows = await tx.$queryRaw<{ ok: number }[]>`
    SELECT 1 AS ok FROM account_memberships WHERE account_id=${accountId}::uuid AND user_id=${userId}::uuid LIMIT 1`;
  return rows.length > 0;
}

const PROFILE_COLUMNS = Prisma.sql`id::text, name, phone, email, company, city, owner_id::text, blocked_at, updated_at`;
type ProfileRow = { id: string; name: string | null; phone: string; email: string | null; company: string | null;
  city: string | null; owner_id: string | null; blocked_at: Date | null; updated_at: Date | null };

/**
 * Saves one contact field. value is a string (text fields, phone, owner id or
 * '' for none) or a boolean (blocked). Returns the saved row (numbers masked
 * for a masked member), or null when the contact is not in this workspace.
 */
export async function updateContactField(ctx: TenantContext, contactId: string, field: unknown, value: unknown) {
  if (!UUID_RE.test(contactId)) return null;
  if (typeof field !== 'string' || !(PROFILE_FIELDS as readonly string[]).includes(field)) throw new ProfileError('invalid_field');
  const key = field as ProfileField;
  if (key === 'blocked' ? typeof value !== 'boolean' : typeof value !== 'string') throw new ProfileError('invalid_field');

  return withTenant(ctx, async (tx) => {
    const masked = await loadPhoneMask(tx, ctx);
    const rows = await tx.$queryRaw<ProfileRow[]>`
      SELECT ${PROFILE_COLUMNS} FROM contacts WHERE account_id=${ctx.accountId}::uuid AND id=${contactId}::uuid FOR UPDATE`;
    const before = rows[0];
    if (!before) return null;

    let set: Prisma.Sql;
    let changed: boolean;
    let activity: { kind: ActivityKind; detail: Record<string, string | boolean | null> };
    if (key === 'blocked') {
      const on = value as boolean;
      changed = on !== (before.blocked_at !== null);
      set = on ? Prisma.sql`blocked_at=COALESCE(blocked_at, now())` : Prisma.sql`blocked_at=NULL`;
      activity = { kind: on ? 'blocked' : 'unblocked', detail: {} };
    } else if (key === 'owner_id') {
      const owner = (value as string).trim() || null;
      if (owner && !(await isWorkspaceMember(tx, ctx.accountId, owner))) throw new ProfileError('not_member');
      changed = owner !== before.owner_id;
      set = Prisma.sql`owner_id=${owner}::uuid`;
      activity = { kind: 'owner_changed', detail: { owner_id: owner } };
    } else if (key === 'phone') {
      if (masked) throw new ProfileError('phone_masked');
      const text = (value as string).trim();
      if (!text) throw new ProfileError('phone_required');
      if (text === before.phone) return maskContactRow(serialize(before), masked);
      const digits = parseInternationalPhone(text);
      if (!digits) throw new ProfileError('invalid_phone');
      const taken = await tx.$queryRaw<{ ok: number }[]>`
        SELECT 1 AS ok FROM contacts WHERE account_id=${ctx.accountId}::uuid AND phone_normalized=${digits} AND id<>${contactId}::uuid LIMIT 1`;
      if (taken.length) throw new ProfileError('duplicate_phone');
      changed = true;
      set = Prisma.sql`phone=${`+${digits}`}`;
      activity = { kind: 'field_changed', detail: { field: 'phone' } };
    } else {
      const text = (value as string).trim();
      if (text.length > TEXT_LIMITS[key]) throw new ProfileError('too_long');
      if (key === 'email' && text && !EMAIL.test(text)) throw new ProfileError('invalid_email');
      const next = text || null;
      changed = next !== before[key];
      set = Prisma.sql`${Prisma.raw(key)}=${next}`;
      activity = { kind: 'field_changed', detail: { field: key } };
    }
    if (!changed) return maskContactRow(serialize(before), masked);
    const saved = await tx.$queryRaw<ProfileRow[]>(Prisma.sql`
      UPDATE contacts SET ${set}, updated_at=now() WHERE account_id=${ctx.accountId}::uuid AND id=${contactId}::uuid
      RETURNING ${PROFILE_COLUMNS}`);
    await recordContactActivity(tx, ctx, contactId, activity.kind, activity.detail);
    return maskContactRow(serialize(saved[0]), masked);
  });
}

function serialize(row: ProfileRow) {
  return {
    ...row,
    blocked_at: row.blocked_at ? row.blocked_at.toISOString() : null,
    updated_at: row.updated_at ? row.updated_at.toISOString() : null,
  };
}

/**
 * Sets (or with '' clears) one custom field value, checked against the
 * field's type. Returns the stored value, or null when the contact is not in
 * this workspace.
 */
export async function setContactCustomValue(ctx: TenantContext, contactId: string, fieldId: unknown, raw: unknown) {
  if (!UUID_RE.test(contactId)) return null;
  if (typeof fieldId !== 'string' || !UUID_RE.test(fieldId) || typeof raw !== 'string') throw new ProfileError('invalid_field');
  if (raw.length > MAX_CUSTOM_VALUE * 2) throw new ProfileError('too_long');
  return withTenant(ctx, async (tx) => {
    const contact = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text FROM contacts WHERE account_id=${ctx.accountId}::uuid AND id=${contactId}::uuid FOR UPDATE`;
    if (!contact[0]) return null;
    const fields = await tx.$queryRaw<{ field_type: string; field_options: unknown }[]>`
      SELECT field_type, field_options FROM custom_fields WHERE account_id=${ctx.accountId}::uuid AND id=${fieldId}::uuid`;
    if (!fields[0]) throw new ProfileError('field_not_found');
    const normalized = normalizeFieldValue(fields[0], raw);
    if (!normalized.ok) throw new ProfileError(normalized.problem);
    const current = await tx.$queryRaw<{ value: string | null }[]>`
      SELECT value FROM contact_custom_values WHERE account_id=${ctx.accountId}::uuid AND contact_id=${contactId}::uuid AND custom_field_id=${fieldId}::uuid`;
    const before = current[0]?.value ?? '';
    if (before === normalized.value) return { value: normalized.value };
    if (normalized.value)
      await tx.$executeRaw`INSERT INTO contact_custom_values(account_id, contact_id, custom_field_id, value)
        VALUES(${ctx.accountId}::uuid, ${contactId}::uuid, ${fieldId}::uuid, ${normalized.value})
        ON CONFLICT (contact_id, custom_field_id) DO UPDATE SET value=EXCLUDED.value`;
    else
      await tx.$executeRaw`DELETE FROM contact_custom_values
        WHERE account_id=${ctx.accountId}::uuid AND contact_id=${contactId}::uuid AND custom_field_id=${fieldId}::uuid`;
    await recordContactActivity(tx, ctx, contactId, 'custom_field_changed', { field_id: fieldId, cleared: !normalized.value });
    return { value: normalized.value };
  });
}

export interface ProfileConversation {
  id: string;
  channel: string;
  status: string;
  last_message_text: string | null;
  last_message_at: string | null;
}

export interface ProfileOrder {
  id: string;
  external_id: string | null;
  status: string;
  currency: string;
  total_minor: number;
  created_at: string;
}

export type TimelineKind =
  | 'created'
  | 'conversation_started'
  | 'order_placed'
  | 'tag_added'
  | 'note_added'
  | ActivityKind;

export interface TimelineEvent {
  kind: TimelineKind;
  at: string;
  /** The member who made the change, when known. */
  actor_id: string | null;
  /** Ids, field names and states only (a tag's name for tag events). */
  detail: Record<string, unknown>;
}

export interface ContactOverview {
  has_instagram: boolean;
  instagram_usernames: string[];
  conversations: ProfileConversation[];
  orders: ProfileOrder[];
  timeline: TimelineEvent[];
}

const TIMELINE_LIMIT = 100;

/** The profile's read-only sections, or null when the contact is not in this workspace. */
export async function contactOverview(ctx: TenantContext, contactId: string): Promise<ContactOverview | null> {
  if (!UUID_RE.test(contactId)) return null;
  return withTenant(ctx, async (tx) => {
    const contact = await tx.$queryRaw<{ created_at: Date | null; user_id: string | null }[]>`
      SELECT created_at, user_id::text FROM contacts WHERE account_id=${ctx.accountId}::uuid AND id=${contactId}::uuid`;
    if (!contact[0]) return null;
    const masked = await loadPhoneMask(tx, ctx);
    const identities = await tx.$queryRaw<{ username: string | null }[]>`
      SELECT username FROM contact_channel_identities
      WHERE account_id=${ctx.accountId}::uuid AND contact_id=${contactId}::uuid AND channel='instagram' ORDER BY created_at`;
    const conversations = await tx.$queryRaw<(ProfileConversation & { created_at: Date; last_message_at: Date | null })[]>(Prisma.sql`
      SELECT v.id::text, v.channel, v.status, left(v.last_message_text, 140) AS last_message_text, v.last_message_at, v.created_at
      FROM conversations v
      WHERE v.account_id=${ctx.accountId}::uuid AND v.contact_id=${contactId}::uuid AND ${Prisma.raw(conversationVisibleSql('v'))}
      ORDER BY v.last_message_at DESC NULLS LAST, v.created_at DESC LIMIT 20`);
    const orders = await tx.$queryRaw<(Omit<ProfileOrder, 'created_at' | 'total_minor'> & { created_at: Date; total_minor: bigint | number })[]>`
      SELECT id::text, external_id, status, currency, total_minor, created_at FROM orders
      WHERE account_id=${ctx.accountId}::uuid AND contact_id=${contactId}::uuid ORDER BY created_at DESC LIMIT 10`;
    const activity = await tx.$queryRaw<{ kind: ActivityKind; actor_id: string | null; detail: Record<string, unknown>; created_at: Date }[]>`
      SELECT kind, actor_id::text, detail, created_at FROM contact_activity
      WHERE account_id=${ctx.accountId}::uuid AND contact_id=${contactId}::uuid ORDER BY created_at DESC LIMIT ${TIMELINE_LIMIT}`;
    const tags = await tx.$queryRaw<{ tag_id: string; name: string; created_at: Date | null }[]>`
      SELECT ct.tag_id::text, t.name, ct.created_at FROM contact_tags ct JOIN tags t ON t.account_id=ct.account_id AND t.id=ct.tag_id
      WHERE ct.account_id=${ctx.accountId}::uuid AND ct.contact_id=${contactId}::uuid`;
    const notes = await tx.$queryRaw<{ user_id: string | null; created_at: Date | null }[]>`
      SELECT user_id::text, created_at FROM contact_notes
      WHERE account_id=${ctx.accountId}::uuid AND contact_id=${contactId}::uuid ORDER BY created_at DESC LIMIT 50`;
    // Tag names for removed tags still in the workspace (a deleted tag shows without a name).
    const removedIds = [...new Set(activity.flatMap((a) => (a.kind === 'tag_removed' && typeof a.detail.tag_id === 'string' && UUID_RE.test(a.detail.tag_id) ? [a.detail.tag_id] : [])))];
    const removedNames = removedIds.length
      ? new Map((await tx.$queryRaw<{ id: string; name: string }[]>`
          SELECT id::text, name FROM tags WHERE account_id=${ctx.accountId}::uuid AND id = ANY(${removedIds}::uuid[])`).map((t) => [t.id, t.name]))
      : new Map<string, string>();

    const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
    const events: TimelineEvent[] = [];
    for (const a of activity) {
      const detail = { ...a.detail };
      if (a.kind === 'tag_removed' && typeof detail.tag_id === 'string') detail.tag_name = removedNames.get(detail.tag_id) ?? null;
      events.push({ kind: a.kind, at: a.created_at.toISOString(), actor_id: a.actor_id, detail });
    }
    for (const t of tags) if (t.created_at) events.push({ kind: 'tag_added', at: t.created_at.toISOString(), actor_id: null, detail: { tag_id: t.tag_id, tag_name: t.name } });
    for (const n of notes) if (n.created_at) events.push({ kind: 'note_added', at: n.created_at.toISOString(), actor_id: n.user_id, detail: {} });
    for (const v of conversations) events.push({ kind: 'conversation_started', at: v.created_at.toISOString(), actor_id: null, detail: { channel: v.channel } });
    for (const o of orders) events.push({ kind: 'order_placed', at: o.created_at.toISOString(), actor_id: null, detail: { order_id: o.id } });
    if (contact[0].created_at) events.push({ kind: 'created', at: contact[0].created_at.toISOString(), actor_id: null, detail: {} });
    events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

    return {
      has_instagram: identities.length > 0,
      instagram_usernames: identities.flatMap((i) => (i.username ? [String(masked ? maskContactIdentifier(i.username) : i.username)] : [])),
      conversations: conversations.map((v) => ({
        id: v.id, channel: v.channel, status: v.status, last_message_text: v.last_message_text, last_message_at: iso(v.last_message_at),
      })),
      orders: orders.map((o) => ({ ...o, total_minor: Number(o.total_minor), created_at: o.created_at.toISOString() })),
      timeline: events.slice(0, TIMELINE_LIMIT),
    };
  });
}
