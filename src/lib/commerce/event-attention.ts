import type { TenantContext, TenantTransaction } from '@/lib/db/tenant';
import { withTenant } from '@/lib/db/tenant';
import type { CommerceEventName, CommerceEventStatus, CommerceSource } from './event-rules';

/**
 * Store events that need an admin: a failed template send, or one whose
 * outcome is unknown (the provider may or may not have delivered it). The
 * admin checks the chat and records what happened; recording never sends.
 * Runs as the caller (app role), so RLS keeps it inside the workspace and the
 * admin_resolve policy limits who may resolve what.
 */

export const ATTENTION_LIMIT = 100;
export const RESOLUTIONS = ['sent', 'not_sent'] as const;
export type CommerceEventResolution = (typeof RESOLUTIONS)[number];

/** Fixed projection: never the event payload beyond the order number. */
export interface AttentionEvent {
  id: string;
  source: CommerceSource;
  event: CommerceEventName;
  status: CommerceEventStatus;
  reason: string | null;
  order_number: string | null;
  contact_id: string | null;
  contact_name: string | null;
  conversation_id: string | null;
  template_name: string | null;
  created_at: string;
  scheduled_for: string | null;
}

export class AttentionError extends Error {
  constructor(readonly code: 'not_found' | 'not_open', readonly status: 404 | 409) {
    super(code);
    this.name = 'AttentionError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = Omit<AttentionEvent, 'created_at' | 'scheduled_for'> & { created_at: Date; scheduled_for: Date | null };

const toEvent = (row: Row): AttentionEvent => ({
  ...row,
  created_at: row.created_at.toISOString(),
  scheduled_for: row.scheduled_for ? row.scheduled_for.toISOString() : null,
});

/** The open rule: matches commerce_events_attention_idx and the admin_resolve policy. */
async function selectEvents(tx: TenantTransaction, accountId: string, id: string | null, limit: number): Promise<Row[]> {
  return tx.$queryRaw<Row[]>`
    SELECT e.id, e.source, e.event, e.status, e.reason,
      left(e.payload->>'order_number', 100) AS order_number,
      e.contact_id, c.name AS contact_name,
      (SELECT v.id FROM conversations v WHERE v.account_id = e.account_id AND v.contact_id = e.contact_id
        ORDER BY v.last_message_at DESC NULLS LAST LIMIT 1) AS conversation_id,
      r.template_name, e.created_at, e.scheduled_for
    FROM commerce_events e
    LEFT JOIN contacts c ON c.account_id = e.account_id AND c.id = e.contact_id
    LEFT JOIN commerce_event_rules r ON r.account_id = e.account_id AND r.source = e.source AND r.event = e.event
    WHERE e.account_id = ${accountId}::uuid AND e.resolved_at IS NULL
      AND (e.status = 'failed' OR (e.status = 'scheduled' AND e.reason = 'outcome_unknown'))
      AND (${id}::uuid IS NULL OR e.id = ${id}::uuid)
    ORDER BY e.created_at DESC
    LIMIT ${limit}`;
}

export async function listAttentionEvents(tenant: TenantContext): Promise<{ events: AttentionEvent[] }> {
  const rows = await withTenant(tenant, (tx) => selectEvents(tx, tenant.accountId, null, ATTENTION_LIMIT));
  return { events: rows.map(toEvent) };
}

export function parseResolution(body: unknown): CommerceEventResolution | null {
  const value = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>).resolution : null;
  return (RESOLUTIONS as readonly unknown[]).includes(value) ? (value as CommerceEventResolution) : null;
}

/**
 * Records the admin's finding: 'sent' (the customer got it) or 'not_sent'.
 * Only an open attention event can be resolved, once. The outbound intent is
 * left as it is, so the job can never send this event again.
 */
export async function resolveCommerceEvent(tenant: TenantContext, eventId: string, resolution: CommerceEventResolution): Promise<AttentionEvent> {
  if (!UUID.test(eventId)) throw new AttentionError('not_found', 404);
  if (!tenant.userId) throw new Error('Resolution needs the acting user');
  return withTenant(tenant, async (tx) => {
    const [open] = await selectEvents(tx, tenant.accountId, eventId, 1);
    if (!open) {
      const seen = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM commerce_events WHERE id = ${eventId}::uuid AND account_id = ${tenant.accountId}::uuid`;
      throw seen.length ? new AttentionError('not_open', 409) : new AttentionError('not_found', 404);
    }
    const status: CommerceEventStatus = resolution === 'sent' ? 'sent' : 'failed';
    const updated = await tx.$executeRaw`
      UPDATE commerce_events SET status = ${status}, resolution = ${resolution}, resolved_at = now(), resolved_by = ${tenant.userId}::uuid
      WHERE id = ${eventId}::uuid AND account_id = ${tenant.accountId}::uuid AND resolved_at IS NULL
        AND (status = 'failed' OR (status = 'scheduled' AND reason = 'outcome_unknown'))`;
    if (updated !== 1) throw new AttentionError('not_open', 409);
    return toEvent({ ...open, status });
  });
}
