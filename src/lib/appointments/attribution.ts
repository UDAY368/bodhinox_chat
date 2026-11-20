/**
 * Where a booking came from (batch 3, B11 and B12): the campaign whose
 * tracked link the contact clicked, the ad that opened their chat, and the
 * conversation the booking was made or confirmed in.
 *
 * Resolved inside the confirming transaction (booking.ts): a booking that is
 * confirmed at insert (staff, free flow booking) carries the values in its
 * INSERT, so the app role needs no UPDATE grant on these columns; the worker
 * paths that confirm an existing row (BOOK code, paid settlement) write them
 * with an UPDATE. Every query is scoped to the caller's account, so a click or
 * referral of another workspace is never picked.
 *
 * Windows: a campaign click counts for BROADCAST_ATTRIBUTION_DAYS before the
 * confirmation; an ad referral uses the ads revenue window (REVENUE_WINDOW_DAYS,
 * source_type 'ad' with an ad id, newest first), so booking revenue and ads
 * revenue credit the same ad.
 */
import type { TenantTransaction } from '@/lib/db/tenant';

/** A campaign link click counts for this many days before the booking is confirmed. */
export const BROADCAST_ATTRIBUTION_DAYS = 7;
/**
 * An ad click counts for the ads revenue window (meta-ads/insights.ts
 * REVENUE_WINDOW_DAYS; a unit test keeps them equal; not imported, so the
 * booking path does not load the ads module).
 */
export const AD_ATTRIBUTION_DAYS = 28;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface BookingAttribution {
  broadcastId: string | null;
  adReferralId: string | null;
}

/**
 * The contact's latest campaign click and ad referral before `at`, inside
 * their windows, in this workspace only. Both null without a contact.
 */
export async function resolveAttribution(
  tx: TenantTransaction, accountId: string, contactId: string | null, at: Date,
): Promise<BookingAttribution> {
  if (!contactId || !UUID.test(contactId)) return { broadcastId: null, adReferralId: null };
  const [row] = await tx.$queryRaw<{ broadcast_id: string | null; ad_referral_id: string | null }[]>`
    SELECT
      (SELECT c.broadcast_id::text FROM broadcast_recipients r
         JOIN broadcast_clicks c ON c.account_id=r.account_id AND c.recipient_id=r.id
       WHERE r.account_id=${accountId}::uuid AND r.contact_id=${contactId}::uuid
         AND c.clicked_at <= ${at} AND c.clicked_at > ${at}::timestamptz - make_interval(days => ${BROADCAST_ATTRIBUTION_DAYS}::int)
       ORDER BY c.clicked_at DESC, c.id DESC LIMIT 1) AS broadcast_id,
      (SELECT x.id::text FROM ad_referrals x
       WHERE x.account_id=${accountId}::uuid AND x.contact_id=${contactId}::uuid AND x.source_type='ad' AND x.source_id IS NOT NULL
         AND x.created_at <= ${at} AND x.created_at > ${at}::timestamptz - make_interval(days => ${AD_ATTRIBUTION_DAYS}::int)
       ORDER BY x.created_at DESC, x.id DESC LIMIT 1) AS ad_referral_id`;
  return { broadcastId: row?.broadcast_id ?? null, adReferralId: row?.ad_referral_id ?? null };
}

/**
 * The contact's WhatsApp conversation a BOOK code arrived on: on that number
 * when known, else the one the customer wrote in last. Null when none.
 */
export async function whatsappConversationFor(
  tx: TenantTransaction, accountId: string, contactId: string, whatsappConfigId: string | null,
): Promise<string | null> {
  const [row] = await tx.$queryRaw<{ id: string }[]>`
    SELECT c.id::text AS id FROM conversations c
    WHERE c.account_id=${accountId}::uuid AND c.contact_id=${contactId}::uuid AND c.channel='whatsapp'
    ORDER BY (c.whatsapp_config_id IS NOT NULL AND c.whatsapp_config_id=${whatsappConfigId}::uuid) DESC,
      c.last_message_at DESC NULLS LAST, c.created_at DESC
    LIMIT 1`;
  return row?.id ?? null;
}

/**
 * Write attribution on a row being confirmed (worker transactions only). The
 * conversation is kept when already set (the chat the booking was made in).
 */
export async function applyAttribution(
  tx: TenantTransaction, accountId: string, appointmentId: string,
  input: BookingAttribution & { conversationId?: string | null },
): Promise<void> {
  await tx.$executeRaw`UPDATE appointments SET broadcast_id=${input.broadcastId}::uuid, ad_referral_id=${input.adReferralId}::uuid,
      conversation_id=coalesce(conversation_id, ${input.conversationId ?? null}::uuid)
    WHERE account_id=${accountId}::uuid AND id=${appointmentId}::uuid`;
}

// ------------------------------------------------------------ report helpers (b5 calls these)

/** Money per currency, as a decimal-free minor-unit total. */
export interface CurrencyTotal {
  currency: string;
  minor: number;
}

export interface AttributedBookings {
  /** Bookings confirmed (or since attended / no-show) that the source produced, cancelled ones excluded. */
  bookings: number;
  /** Of those, bookings paid online. */
  paidBookings: number;
  /** Paid bookings' prices per currency (refunded bookings excluded). */
  revenue: CurrencyTotal[];
}

const LIVE_STATUSES = `('confirmed','completed','no_show')`;

function totals(rows: { currency: string | null; bookings: number; paid: number; minor: string | number | null }[]): AttributedBookings {
  let bookings = 0;
  let paidBookings = 0;
  const revenue: CurrencyTotal[] = [];
  for (const row of rows) {
    bookings += Number(row.bookings);
    paidBookings += Number(row.paid);
    if (row.currency && row.minor != null && Number(row.minor) > 0) revenue.push({ currency: row.currency, minor: Number(row.minor) });
  }
  revenue.sort((a, b) => a.currency.localeCompare(b.currency));
  return { bookings, paidBookings, revenue };
}

/** Bookings one campaign produced (any tenant transaction of the workspace). */
export async function bookingsForBroadcast(tx: TenantTransaction, accountId: string, broadcastId: string): Promise<AttributedBookings> {
  if (!UUID.test(broadcastId)) return { bookings: 0, paidBookings: 0, revenue: [] };
  const rows = await tx.$queryRawUnsafe<{ currency: string | null; bookings: number; paid: number; minor: string | null }[]>(
    `SELECT a.currency, count(*)::int AS bookings, count(*) FILTER (WHERE a.payment_status='paid')::int AS paid,
       sum(a.price_minor) FILTER (WHERE a.payment_status='paid')::text AS minor
     FROM appointments a
     WHERE a.account_id=$1::uuid AND a.broadcast_id=$2::uuid AND a.status IN ${LIVE_STATUSES}
     GROUP BY a.currency`,
    accountId, broadcastId);
  return totals(rows);
}

export interface AdsBookingsRange {
  /** Inclusive start of the confirmation time range. */
  from: Date;
  /** Exclusive end. */
  to: Date;
}

/** Ad-attributed bookings confirmed in the range, by ad id (meta ad object id), largest first (at most 200 ads). */
export async function bookingsForAds(tx: TenantTransaction, accountId: string, range: AdsBookingsRange): Promise<{
  total: AttributedBookings;
  byAd: Array<{ adId: string } & AttributedBookings>;
}> {
  const rows = await tx.$queryRawUnsafe<{ ad_id: string; currency: string | null; bookings: number; paid: number; minor: string | null }[]>(
    `SELECT x.source_id AS ad_id, a.currency, count(*)::int AS bookings, count(*) FILTER (WHERE a.payment_status='paid')::int AS paid,
       sum(a.price_minor) FILTER (WHERE a.payment_status='paid')::text AS minor
     FROM appointments a
     JOIN ad_referrals x ON x.account_id=a.account_id AND x.id=a.ad_referral_id
     WHERE a.account_id=$1::uuid AND a.ad_referral_id IS NOT NULL AND a.status IN ${LIVE_STATUSES}
       AND a.confirmed_at >= $2 AND a.confirmed_at < $3 AND x.source_id IS NOT NULL
     GROUP BY x.source_id, a.currency
     ORDER BY x.source_id
     LIMIT 1000`,
    accountId, range.from, range.to);
  const byAdMap = new Map<string, typeof rows>();
  for (const row of rows) byAdMap.set(row.ad_id, [...(byAdMap.get(row.ad_id) ?? []), row]);
  const byAd = [...byAdMap.entries()].map(([adId, list]) => ({ adId, ...totals(list) }))
    .sort((a, b) => b.bookings - a.bookings || a.adId.localeCompare(b.adId)).slice(0, 200);
  return { total: totals(rows), byAd };
}
