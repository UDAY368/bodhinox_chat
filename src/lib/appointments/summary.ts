/**
 * Booking counts for Home and other summary cards. A booking counts on its own
 * local day (the location's zone), so "today" matches what staff see on the
 * schedule. Booked means confirmed, completed or no-show: holds that were
 * never confirmed, cancellations and expired holds are not bookings.
 */
import type { TenantTransaction } from '@/lib/db/tenant';

export const BOOKED_STATUSES = ['confirmed', 'completed', 'no_show'] as const;

export interface BookingsSummary {
  /** Bookings whose local day is today. */
  today: number;
  /** Of today's, those still to come (confirmed and not yet started). */
  upcomingToday: number;
  /** Bookings from today through the next six local days. */
  next7Days: number;
}

export async function bookingsSummary(tx: TenantTransaction, accountId: string, now = new Date()): Promise<BookingsSummary> {
  const [row] = await tx.$queryRaw<{ today: number; upcoming: number; week: number }[]>`
    SELECT
      count(*) FILTER (WHERE a.local_date = (${now}::timestamptz AT TIME ZONE a.timezone)::date)::int AS today,
      count(*) FILTER (WHERE a.local_date = (${now}::timestamptz AT TIME ZONE a.timezone)::date
        AND a.status = 'confirmed' AND a.start_at > ${now})::int AS upcoming,
      count(*)::int AS week
    FROM appointments a
    WHERE a.account_id = ${accountId}::uuid
      AND a.status IN ('confirmed','completed','no_show')
      -- Index-friendly outer bound (appointments_local_date_idx); the zone-exact day is checked above.
      AND a.local_date BETWEEN (${now}::timestamptz - interval '1 day')::date AND (${now}::timestamptz + interval '8 days')::date
      AND a.local_date >= (${now}::timestamptz AT TIME ZONE a.timezone)::date
      AND a.local_date < (${now}::timestamptz AT TIME ZONE a.timezone)::date + 7`;
  return { today: row?.today ?? 0, upcomingToday: row?.upcoming ?? 0, next7Days: row?.week ?? 0 };
}
