/**
 * Booking facts for the AI reply context (WP-D2), about one contact only:
 * their own next confirmed booking (service, local time, manage link), up to
 * three free times for their most recent service (else the first bookable
 * one), and the link of the first active booking page. Never another
 * customer's data, phone numbers, notes or intake. null when the plan has no
 * appointments or there is nothing to say. At most 600 characters.
 * Server-only (the manage link reads ENCRYPTION_KEY). b5 calls it from
 * src/lib/ai/customer-context.ts inside the caller's tenant transaction.
 */
import { appOrigin } from '@/lib/auth/csrf';
import { getEntitlements } from '@/lib/billing/entitlements';
import type { TenantTransaction } from '@/lib/db/tenant';
import { listSlots } from './availability';
import { formatAppointmentTime } from './customer-send';
import { deriveManageToken, manageUrl } from './tokens';

export const AI_CONTEXT_MAX_CHARS = 600;
const FREE_SLOTS = 3;
const SLOT_DAYS = 14;

/** Joins the lines and cuts to the limit on a line, then a character, boundary. */
export function clampContext(lines: string[], max = AI_CONTEXT_MAX_CHARS): string | null {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const extra = (kept.length ? 1 : 0) + line.length;
    if (used + extra > max) {
      if (!kept.length) kept.push(`${line.slice(0, max - 1)}…`);
      break;
    }
    kept.push(line);
    used += extra;
  }
  return kept.length ? kept.join('\n') : null;
}

export async function customerBookingContext(
  tx: TenantTransaction, accountId: string, contactId: string, now = new Date(),
): Promise<string | null> {
  if (!(await getEntitlements(tx, accountId)).features.appointments) return null;
  const lines: string[] = [];

  const [next] = await tx.$queryRaw<{ id: string; service_name: string; start_at: Date; timezone: string; token_epoch: number }[]>`
    SELECT id::text AS id, service_name, start_at, timezone, token_epoch FROM appointments
    WHERE account_id=${accountId}::uuid AND contact_id=${contactId}::uuid AND status='confirmed' AND start_at >= ${now}
    ORDER BY start_at, id LIMIT 1`;
  if (next) {
    let manage = '';
    try {
      manage = ` Manage it here: ${manageUrl(deriveManageToken(next.id, next.token_epoch))}`;
    } catch {
      // No link key configured: say when, without a link.
    }
    lines.push(`Their next booking: ${next.service_name} on ${formatAppointmentTime(next.start_at, next.timezone)}.${manage}`);
  }

  // Their most recent service if it is still bookable, else the first bookable one.
  const [offer] = await tx.$queryRaw<{ service_id: string; service_name: string; location_id: string }[]>`
    SELECT s.id::text AS service_id, s.name AS service_name, o.location_id::text AS location_id
    FROM appointment_services s
    JOIN appointment_offerings o ON o.account_id=s.account_id AND o.service_id=s.id
    JOIN appointment_locations l ON l.account_id=o.account_id AND l.id=o.location_id AND l.archived_at IS NULL
    LEFT JOIN LATERAL (
      SELECT max(a.start_at) AS last_at FROM appointments a
      WHERE a.account_id=s.account_id AND a.contact_id=${contactId}::uuid AND a.service_id=s.id AND a.status <> 'expired'
    ) mine ON true
    WHERE s.account_id=${accountId}::uuid AND s.archived_at IS NULL
    ORDER BY mine.last_at DESC NULLS LAST, s.created_at, s.id, o.location_id
    LIMIT 1`;
  if (offer) {
    try {
      const { timezone, slots } = await listSlots(tx, accountId, {
        serviceId: offer.service_id, locationId: offer.location_id, days: SLOT_DAYS, now,
      });
      const free = slots.slice(0, FREE_SLOTS).map((s) => formatAppointmentTime(new Date(s.startAt), timezone));
      if (free.length) lines.push(`Free times for ${offer.service_name}: ${free.join('; ')}.`);
    } catch {
      // A service or location that cannot be booked right now simply has no free times to offer.
    }
  }

  const [page] = await tx.$queryRaw<{ slug: string }[]>`
    SELECT slug FROM booking_pages WHERE account_id=${accountId}::uuid AND active
    ORDER BY created_at, id LIMIT 1`;
  if (page) lines.push(`Book online: ${appOrigin().replace(/\/+$/, '')}/book/${page.slug}`);

  return clampContext(lines);
}
