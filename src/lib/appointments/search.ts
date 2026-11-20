/**
 * Booking search for the one search box (WP-D2): by the booked contact's name
 * or number (the same contact match and masking as contact search) or by the
 * service name. Upcoming bookings first (soonest first), then past ones
 * (latest first); expired holds never show. Runs in the caller's tenant
 * transaction; the account filter plus RLS keep it to the workspace.
 */
import { Prisma } from '@prisma/client';

import type { TenantTransaction } from '@/lib/db/tenant';
import { contactMatchSql } from '@/lib/search/contacts';
import { containsPattern } from '@/lib/search/normalise';

export const APPOINTMENT_SEARCH_MAX = 10;

export interface AppointmentSearchItem {
  id: string;
  /** The contact's name, else the service. */
  title: string;
  /** The service when the title is the contact, else ''. */
  subtitle: string;
  href: string;
  /** ISO start time. */
  at: string;
}

/**
 * At most `limit` (max 10) bookings matching `q`. With maskPhones (the default,
 * the safe choice) a number can only be searched by its last four digits.
 */
export async function searchAppointments(
  tx: TenantTransaction, accountId: string, q: string, limit = APPOINTMENT_SEARCH_MAX, maskPhones = true,
): Promise<AppointmentSearchItem[]> {
  const term = q.trim();
  if (!term) return [];
  const take = Math.min(Math.max(Math.trunc(limit) || 1, 1), APPOINTMENT_SEARCH_MAX);
  const match = contactMatchSql(term, maskPhones);
  const rows = await tx.$queryRaw<{ id: string; service_name: string; start_at: Date; contact_name: string | null }[]>(Prisma.sql`
    SELECT a.id::text AS id, a.service_name, a.start_at, c.name AS contact_name
    FROM appointments a LEFT JOIN contacts c ON c.account_id=a.account_id AND c.id=a.contact_id
    WHERE a.account_id=${accountId}::uuid AND a.status <> 'expired'
      AND (a.service_name ILIKE ${containsPattern(term)} OR (c.id IS NOT NULL ${match}))
    ORDER BY (a.start_at >= now()) DESC,
      CASE WHEN a.start_at >= now() THEN a.start_at END ASC,
      a.start_at DESC, a.id DESC
    LIMIT ${take}`);
  return rows.map((b) => ({
    id: b.id, title: b.contact_name || b.service_name, subtitle: b.contact_name ? b.service_name : '',
    href: `/appointments?id=${b.id}`, at: b.start_at.toISOString(),
  }));
}
