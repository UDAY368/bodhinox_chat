import { hasMinRole } from '@/lib/auth/roles';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { decodeTimelineCursor, listContactEvents } from './store';
import type { DomainEventData, DomainEventType, DomainSubjectKind } from './types';

/**
 * A contact's timeline from the event feed (GET /api/contacts/[id]/timeline), a page at a time.
 * Contacts are visible to every member of the workspace (agent visibility limits conversations,
 * not contacts); a viewer, who may not read orders or payments, gets the other events only, the
 * same split as the chat panel's summary (src/lib/contacts/commerce-summary.ts).
 */

export interface TimelineItem {
  id: string;
  type: DomainEventType;
  occurred_at: string;
  subject: { kind: DomainSubjectKind; id: string };
  data: DomainEventData;
}

export interface TimelinePage {
  events: TimelineItem[];
  next_cursor: string | null;
}

/** Subjects a viewer may not read (orders, returns, payments and carts are agent-and-above). */
const COMMERCE_KINDS: readonly DomainSubjectKind[] = ['order', 'order_return', 'payment', 'cart', 'commerce_event'];

export class TimelineCursorError extends Error {
  constructor() { super('invalid_cursor'); this.name = 'TimelineCursorError'; }
}

/** The page, or null when the contact is not in this workspace. Throws TimelineCursorError for a malformed cursor. */
export async function contactTimeline(ctx: TenantContext, contactId: string, rawCursor: string | null): Promise<TimelinePage | null> {
  const cursor = decodeTimelineCursor(rawCursor);
  if (rawCursor && !cursor) throw new TimelineCursorError();
  const excludeKinds = ctx.role && hasMinRole(ctx.role, 'agent') ? [] : COMMERCE_KINDS;
  return withTenant(ctx, async (tx) => {
    const found = await tx.$queryRaw<{ ok: number }[]>`
      SELECT 1 AS ok FROM contacts WHERE account_id=${ctx.accountId}::uuid AND id=${contactId}::uuid`;
    if (!found.length) return null;
    const page = await listContactEvents(tx, ctx.accountId, contactId, cursor, undefined, { excludeKinds });
    return {
      events: page.events.map((row) => ({
        id: row.id,
        type: row.type,
        occurred_at: new Date(row.occurred_at).toISOString(),
        subject: { kind: row.subject_kind, id: row.subject_id },
        data: row.data,
      })),
      next_cursor: page.nextCursor,
    };
  });
}
