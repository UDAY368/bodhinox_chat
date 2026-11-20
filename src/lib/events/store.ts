import type { TenantTransaction } from '@/lib/db/tenant';
import { isDomainEventType, type DomainEventData, type DomainEventType, type DomainSubjectKind } from './types';

/** Reads of the event feed. The only module that selects from domain_events. */

export interface DomainEventRow {
  id: string;
  account_id: string;
  type: DomainEventType;
  subject_kind: DomainSubjectKind;
  subject_id: string;
  contact_id: string | null;
  data: DomainEventData;
  occurred_at: Date;
}

export async function getDomainEvent(tx: TenantTransaction, accountId: string, id: string): Promise<DomainEventRow | null> {
  const [row] = await tx.$queryRaw<DomainEventRow[]>`
    SELECT id::text AS id, account_id::text AS account_id, type, subject_kind, subject_id::text AS subject_id,
      contact_id::text AS contact_id, data, occurred_at
    FROM domain_events WHERE account_id=${accountId}::uuid AND id=${id}::uuid`;
  return row && isDomainEventType(row.type) ? row : null;
}

export const TIMELINE_PAGE_SIZE = 30;

export interface TimelineCursor { at: string; id: string }

export function encodeTimelineCursor(row: Pick<DomainEventRow, 'occurred_at' | 'id'>): string {
  return Buffer.from(JSON.stringify({ at: row.occurred_at.toISOString(), id: row.id })).toString('base64url');
}

export function decodeTimelineCursor(value: string | null): TimelineCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<TimelineCursor>;
    if (typeof parsed.at !== 'string' || Number.isNaN(Date.parse(parsed.at))) return null;
    if (typeof parsed.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(parsed.id)) return null;
    return { at: parsed.at, id: parsed.id };
  } catch {
    return null;
  }
}

/**
 * One page of a contact's events, newest first (index domain_events_contact_idx). `excludeKinds`
 * leaves out subjects the member may not read (a viewer's orders and payments).
 */
export async function listContactEvents(
  tx: TenantTransaction, accountId: string, contactId: string, cursor: TimelineCursor | null, limit = TIMELINE_PAGE_SIZE,
  options: { excludeKinds?: readonly DomainSubjectKind[] } = {},
): Promise<{ events: DomainEventRow[]; nextCursor: string | null }> {
  const size = Math.min(Math.max(1, limit), 100);
  const exclude = [...(options.excludeKinds ?? [])];
  const rows = cursor
    ? await tx.$queryRaw<DomainEventRow[]>`
      SELECT id::text AS id, account_id::text AS account_id, type, subject_kind, subject_id::text AS subject_id,
        contact_id::text AS contact_id, data, occurred_at
      FROM domain_events
      WHERE account_id=${accountId}::uuid AND contact_id=${contactId}::uuid
        AND (occurred_at, id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)
        AND NOT (subject_kind = ANY(${exclude}::text[]))
      ORDER BY occurred_at DESC, id DESC LIMIT ${size + 1}`
    : await tx.$queryRaw<DomainEventRow[]>`
      SELECT id::text AS id, account_id::text AS account_id, type, subject_kind, subject_id::text AS subject_id,
        contact_id::text AS contact_id, data, occurred_at
      FROM domain_events
      WHERE account_id=${accountId}::uuid AND contact_id=${contactId}::uuid
        AND NOT (subject_kind = ANY(${exclude}::text[]))
      ORDER BY occurred_at DESC, id DESC LIMIT ${size + 1}`;
  const events = rows.slice(0, size).filter((row) => isDomainEventType(row.type));
  return { events, nextCursor: rows.length > size ? encodeTimelineCursor(rows[size - 1]) : null };
}
