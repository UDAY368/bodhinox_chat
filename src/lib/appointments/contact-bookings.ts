/**
 * One contact's bookings for the contact card (WP-D2): upcoming (live
 * bookings from now, soonest first) and past (everything else: earlier
 * bookings, and cancelled or expired ones, latest first), keyset-paged on
 * (start_at, id). Runs in the caller's tenant transaction; the account and
 * contact filters plus RLS keep it to the workspace. No note, intake or
 * hold code is read.
 */
import type { TenantTransaction } from '@/lib/db/tenant';
import { AppointmentError, type AppointmentPaymentStatus, type AppointmentStatus } from './types';

export const CONTACT_BOOKINGS_DEFAULT = 3;
export const CONTACT_BOOKINGS_MAX = 20;

export type ContactBookingsKind = 'upcoming' | 'past';

export interface ContactBooking {
  id: string;
  service_name: string;
  start_at: string;
  end_at: string;
  timezone: string;
  status: AppointmentStatus;
  payment_status: AppointmentPaymentStatus;
}

export interface ContactBookingsPage {
  items: ContactBooking[];
  /** Pass back as `cursor` for the next page; null at the end. */
  next: string | null;
}

/** Opaque keyset cursor: "<start_at ISO>_<id>". */
export function encodeCursor(row: { start_at: string; id: string }): string {
  return `${row.start_at}_${row.id}`;
}

const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function decodeCursor(cursor: string | null | undefined): { startAt: string; id: string } | null {
  if (!cursor) return null;
  const m = CURSOR.exec(cursor);
  if (!m || Number.isNaN(Date.parse(m[1]))) throw new AppointmentError('invalid');
  return { startAt: m[1], id: m[2].toLowerCase() };
}

export function clampLimit(raw: unknown): number {
  if (raw == null || raw === '') return CONTACT_BOOKINGS_DEFAULT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new AppointmentError('invalid');
  return Math.min(n, CONTACT_BOOKINGS_MAX);
}

interface Row {
  id: string; service_name: string; start_at: Date; end_at: Date; timezone: string;
  status: AppointmentStatus; payment_status: AppointmentPaymentStatus;
}

/** One page of a contact's upcoming or past bookings. not_found when the contact is not in this workspace. */
export async function contactBookings(
  tx: TenantTransaction,
  accountId: string,
  contactId: string,
  options: { kind: ContactBookingsKind; limit?: number; cursor?: string | null; now?: Date },
): Promise<ContactBookingsPage> {
  const limit = Math.min(options.limit ?? CONTACT_BOOKINGS_DEFAULT, CONTACT_BOOKINGS_MAX);
  const after = decodeCursor(options.cursor);
  const now = (options.now ?? new Date()).toISOString();
  const [contact] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM contacts WHERE account_id=${accountId}::uuid AND id=${contactId}::uuid`;
  if (!contact) throw new AppointmentError('not_found');
  const upcoming = options.kind === 'upcoming';
  const cursorAt = after?.startAt ?? null;
  const cursorId = after?.id ?? null;
  // A live booking: confirmed, or a hold that has not expired, starting from now.
  const rows = upcoming
    ? await tx.$queryRaw<Row[]>`
      SELECT id::text AS id, service_name, start_at, end_at, timezone, status, payment_status
      FROM appointments
      WHERE account_id=${accountId}::uuid AND contact_id=${contactId}::uuid AND start_at >= ${now}::timestamptz
        AND (status='confirmed' OR (status='held' AND hold_expires_at > ${now}::timestamptz))
        AND (${cursorAt}::timestamptz IS NULL OR (start_at, id) > (${cursorAt}::timestamptz, ${cursorId}::uuid))
      ORDER BY start_at, id LIMIT ${limit + 1}`
    : await tx.$queryRaw<Row[]>`
      SELECT id::text AS id, service_name, start_at, end_at, timezone, status, payment_status
      FROM appointments
      WHERE account_id=${accountId}::uuid AND contact_id=${contactId}::uuid
        AND NOT (start_at >= ${now}::timestamptz
          AND (status='confirmed' OR (status='held' AND hold_expires_at > ${now}::timestamptz)))
        AND (${cursorAt}::timestamptz IS NULL OR (start_at, id) < (${cursorAt}::timestamptz, ${cursorId}::uuid))
      ORDER BY start_at DESC, id DESC LIMIT ${limit + 1}`;
  const items = rows.slice(0, limit).map((r) => ({
    id: r.id, service_name: r.service_name, start_at: r.start_at.toISOString(), end_at: r.end_at.toISOString(),
    timezone: r.timezone, status: r.status, payment_status: r.payment_status,
  }));
  return { items, next: rows.length > limit ? encodeCursor(items[items.length - 1]) : null };
}

// ------------------------------------------------------------ contact timeline

/** Lifecycle events shown on the contact timeline, by appointment_events.kind. */
export const BOOKING_TIMELINE_EVENTS = {
  confirmed: 'booked', rescheduled: 'rescheduled', cancelled: 'cancelled', completed: 'completed', no_show: 'no_show',
} as const;
export type BookingTimelineEvent = (typeof BOOKING_TIMELINE_EVENTS)[keyof typeof BOOKING_TIMELINE_EVENTS];
export const BOOKING_TIMELINE_LIMIT = 50;

/** A timeline row's detail.event, 'booked' for anything unexpected (for describeEvent). */
export function bookingTimelineEvent(detail: Record<string, unknown>): BookingTimelineEvent {
  const event = detail.event;
  return (Object.values(BOOKING_TIMELINE_EVENTS) as string[]).includes(event as string) ? event as BookingTimelineEvent : 'booked';
}

export interface BookingTimelineRow {
  kind: 'booking';
  at: string;
  actor_id: string | null;
  detail: { appointment_id: string; event: BookingTimelineEvent; service_name: string };
}

/**
 * The contact's booking events for the profile timeline (kind 'booking'),
 * newest first, at most 50. A cancelled hold that was never confirmed is not
 * shown (nobody was told about it). Ids, the service name and the event only.
 */
export async function contactBookingTimeline(tx: TenantTransaction, accountId: string, contactId: string): Promise<BookingTimelineRow[]> {
  const rows = await tx.$queryRaw<{ kind: keyof typeof BOOKING_TIMELINE_EVENTS; created_at: Date; actor_id: string | null; id: string; service_name: string }[]>`
    SELECT e.kind, e.created_at, e.actor_user_id::text AS actor_id, a.id::text AS id, a.service_name
    FROM appointments a
    JOIN appointment_events e ON e.account_id=a.account_id AND e.appointment_id=a.id
    WHERE a.account_id=${accountId}::uuid AND a.contact_id=${contactId}::uuid
      AND e.kind IN ('confirmed','rescheduled','cancelled','completed','no_show')
      AND (e.kind <> 'cancelled' OR a.confirmed_at IS NOT NULL)
    ORDER BY e.created_at DESC LIMIT ${BOOKING_TIMELINE_LIMIT}`;
  return rows.map((r) => ({
    kind: 'booking', at: r.created_at.toISOString(), actor_id: r.actor_id,
    detail: { appointment_id: r.id, event: BOOKING_TIMELINE_EVENTS[r.kind], service_name: r.service_name },
  }));
}
