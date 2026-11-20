/**
 * Appointment counts per service per local day (design section 11), from the
 * append-only appointment_events ledger. Days are bucketed in each
 * appointment's own zone (its snapshot), so a clinic in Kolkata counts by
 * Kolkata days whatever the viewer's zone. No customer data is read.
 */
import type { TenantTransaction } from '@/lib/db/tenant';
import { AppointmentError } from './types';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_STATS_DAYS = 366;

export interface StatsRow {
  service_id: string;
  service_name: string;
  /** YYYY-MM-DD in the appointment's zone. */
  day: string;
  booked: number;
  confirmed: number;
  cancelled: number;
  completed: number;
  no_show: number;
}

export interface StatsTotals {
  booked: number;
  confirmed: number;
  cancelled: number;
  completed: number;
  no_show: number;
  /** no_show / (completed + no_show); null when nothing was recorded (shown as N/A). */
  no_show_rate: number | null;
  /** completed / (completed + no_show); null when nothing was recorded. */
  show_rate: number | null;
}

export function noShowRate(completed: number, noShow: number): number | null {
  const attended = completed + noShow;
  return attended === 0 ? null : noShow / attended;
}

/** completed / (completed + no_show); null when nothing was recorded (shown as N/A). */
export function showRate(completed: number, noShow: number): number | null {
  const attended = completed + noShow;
  return attended === 0 ? null : completed / attended;
}

export function totals(rows: StatsRow[]): StatsTotals {
  const sum = (k: keyof Omit<StatsRow, 'service_id' | 'service_name' | 'day'>) => rows.reduce((n, r) => n + r[k], 0);
  const completed = sum('completed'), noShow = sum('no_show');
  return {
    booked: sum('booked'), confirmed: sum('confirmed'), cancelled: sum('cancelled'), completed, no_show: noShow,
    no_show_rate: noShowRate(completed, noShow), show_rate: showRate(completed, noShow),
  };
}

/**
 * Counts for local days in [from, to] (inclusive). booked = new bookings
 * (version 1 'held' or 'confirmed' events); confirmed = every confirmation,
 * including public holds confirmed by WhatsApp code.
 */
export async function appointmentStats(
  tx: TenantTransaction,
  accountId: string,
  range: { from: string; to: string; serviceId?: string | null },
): Promise<{ rows: StatsRow[]; totals: StatsTotals }> {
  if (!DATE.test(range.from) || !DATE.test(range.to) || range.to < range.from
    || Date.parse(range.to) - Date.parse(range.from) > MAX_STATS_DAYS * 86_400_000) throw new AppointmentError('invalid');
  const rows = await tx.$queryRaw<StatsRow[]>`
    SELECT a.service_id, max(a.service_name) AS service_name, (e.created_at AT TIME ZONE a.timezone)::date::text AS day,
      count(*) FILTER (WHERE e.version=1 AND e.kind IN ('held','confirmed'))::int AS booked,
      count(*) FILTER (WHERE e.kind='confirmed')::int AS confirmed,
      count(*) FILTER (WHERE e.kind='cancelled')::int AS cancelled,
      count(*) FILTER (WHERE e.kind='completed')::int AS completed,
      count(*) FILTER (WHERE e.kind='no_show')::int AS no_show
    FROM appointment_events e JOIN appointments a ON a.account_id=e.account_id AND a.id=e.appointment_id
    WHERE e.account_id=${accountId}::uuid
      AND e.kind IN ('held','confirmed','cancelled','completed','no_show')
      -- Coarse UTC prefilter (zones are within +-14h), then the exact local-day filter.
      AND e.created_at >= ${range.from}::date - interval '1 day' AND e.created_at < ${range.to}::date + interval '2 days'
      AND (e.created_at AT TIME ZONE a.timezone)::date BETWEEN ${range.from}::date AND ${range.to}::date
      AND (${range.serviceId ?? null}::uuid IS NULL OR a.service_id=${range.serviceId ?? null}::uuid)
    GROUP BY a.service_id, 3 ORDER BY 3, 2`;
  return { rows, totals: totals(rows) };
}

export interface RevenueRow {
  service_id: string;
  service_name: string;
  currency: string;
  paid_bookings: number;
  /** Minor units (paise, cents). */
  revenue_minor: bigint;
}

function checkRange(range: { from: string; to: string }) {
  if (!DATE.test(range.from) || !DATE.test(range.to) || range.to < range.from
    || Date.parse(range.to) - Date.parse(range.from) > MAX_STATS_DAYS * 86_400_000) throw new AppointmentError('invalid');
}

/**
 * Booking revenue per service and currency: bookings still paid (refunded ones
 * are payment_status 'refunded', so excluded) whose start falls on a local day
 * in [from, to] in the booking's own zone. Uses the (account_id, start_at, id) index.
 */
export async function bookingRevenue(
  tx: TenantTransaction,
  accountId: string,
  range: { from: string; to: string; serviceId?: string | null },
): Promise<RevenueRow[]> {
  checkRange(range);
  return tx.$queryRaw<RevenueRow[]>`
    SELECT a.service_id, max(a.service_name) AS service_name, a.currency,
      count(*)::int AS paid_bookings, sum(a.price_minor)::bigint AS revenue_minor
    FROM appointments a
    WHERE a.account_id=${accountId}::uuid AND a.payment_status='paid' AND a.price_minor IS NOT NULL
      AND a.start_at >= ${range.from}::date - interval '1 day' AND a.start_at < ${range.to}::date + interval '2 days'
      AND (a.start_at AT TIME ZONE a.timezone)::date BETWEEN ${range.from}::date AND ${range.to}::date
      AND (${range.serviceId ?? null}::uuid IS NULL OR a.service_id=${range.serviceId ?? null}::uuid)
    GROUP BY a.service_id, a.currency ORDER BY 2, 3`;
}
