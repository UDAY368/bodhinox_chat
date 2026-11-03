/**
 * What the anonymous booking page and the customer status page may see
 * (design section 5.4): business, service, practitioner display name,
 * location, times with their zone, status and price. Never the customer's
 * name, phone, intake, notes or the hold code of someone else's booking.
 */
import type { TenantTransaction } from '@/lib/db/tenant';
import { loadSettings } from '@/lib/appointments/availability';
import { paidBookingReady } from '@/lib/appointments/booking';
import type { AppointmentStatus, LocationKind, ServiceMode } from '@/lib/appointments/types';
import { decrypt } from '@/lib/whatsapp/encryption';
import { verifyPhoneNumber } from '@/lib/whatsapp/meta-api';
import { getNumberConfig } from '@/lib/whatsapp/numbers';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const num = (value: bigint | number | null): number | null => (value === null || value === undefined ? null : Number(value));

// ------------------------------------------------------------ booking page

export interface PublicLocation { id: string; name: string; address: string | null; timezone: string; kind: LocationKind }
export interface PublicStaff { id: string; displayName: string }
export interface PublicService {
  id: string;
  name: string;
  mode: ServiceMode;
  durationMinutes: number;
  priceMinor: number | null;
  currency: string | null;
  /** More than one place per slot (a group session). */
  group: boolean;
  /** Paid in advance: a payment link follows the WhatsApp code and the booking is confirmed once paid (E15). */
  paymentRequired: boolean;
  locations: (PublicLocation & { staff: PublicStaff[] })[];
}
export interface PublicPage {
  title: string;
  businessName: string;
  services: PublicService[];
}

interface PageRow { id: string; title: string; location_id: string | null; whatsapp_config_id: string | null; business_name: string }

async function pageRow(tx: TenantTransaction, accountId: string, pageId: string): Promise<PageRow | null> {
  const [row] = await tx.$queryRaw<PageRow[]>`
    SELECT p.id::text, p.title, p.location_id::text, p.whatsapp_config_id::text, a.name AS business_name
    FROM booking_pages p JOIN accounts a ON a.id=p.account_id
    WHERE p.account_id=${accountId}::uuid AND p.id=${pageId}::uuid AND p.active`;
  return row ?? null;
}

/** The page's services, each with the live locations (and practitioners) that offer it. */
export async function loadPublicPage(tx: TenantTransaction, accountId: string, pageId: string): Promise<PublicPage | null> {
  const page = await pageRow(tx, accountId, pageId);
  if (!page) return null;
  // Paid services are offered only while the workspace can take the payment online.
  const payable = await paidBookingReady(tx, accountId);
  const services = await tx.$queryRaw<{ id: string; name: string; mode: ServiceMode; duration_minutes: number;
    price_minor: bigint | null; currency: string | null; capacity: number; payment_required: boolean }[]>`
    SELECT s.id::text, s.name, s.mode, s.duration_minutes, s.price_minor, s.currency, s.capacity, s.payment_required
    FROM booking_page_services ps JOIN appointment_services s ON s.account_id=ps.account_id AND s.id=ps.service_id
    WHERE ps.account_id=${accountId}::uuid AND ps.page_id=${pageId}::uuid AND s.archived_at IS NULL AND (${payable} OR NOT s.payment_required)
    ORDER BY s.name, s.id`;
  const offerings = services.length ? await tx.$queryRaw<{ service_id: string; staff_id: string | null; staff_name: string | null;
    location_id: string; name: string; address: string | null; timezone: string; kind: LocationKind }[]>`
    SELECT o.service_id::text, o.staff_id::text, st.display_name AS staff_name, l.id::text AS location_id, l.name, l.address, l.timezone, l.kind
    FROM appointment_offerings o
      JOIN appointment_locations l ON l.account_id=o.account_id AND l.id=o.location_id AND l.archived_at IS NULL
      LEFT JOIN appointment_staff st ON st.account_id=o.account_id AND st.id=o.staff_id
    WHERE o.account_id=${accountId}::uuid AND o.service_id = ANY(${services.map((s) => s.id)}::uuid[])
      AND (o.staff_id IS NULL OR st.archived_at IS NULL)
      AND (${page.location_id}::uuid IS NULL OR o.location_id=${page.location_id}::uuid)
    ORDER BY l.name, l.id, st.display_name, st.id` : [];
  const out: PublicService[] = [];
  for (const s of services) {
    const locations = new Map<string, PublicService['locations'][number]>();
    for (const o of offerings.filter((row) => row.service_id === s.id)) {
      const location = locations.get(o.location_id)
        ?? { id: o.location_id, name: o.name, address: o.address, timezone: o.timezone, kind: o.kind, staff: [] };
      if (o.staff_id && o.staff_name) location.staff.push({ id: o.staff_id, displayName: o.staff_name });
      locations.set(o.location_id, location);
    }
    if (!locations.size) continue;
    out.push({ id: s.id, name: s.name, mode: s.mode, durationMinutes: s.duration_minutes, priceMinor: num(s.price_minor),
      currency: s.currency, group: s.capacity > 1, paymentRequired: s.payment_required, locations: [...locations.values()] });
  }
  return { title: page.title, businessName: page.business_name, services: out };
}

/** Whether the page lists this service at this location (slot lookups refuse anything else). */
export async function pageOffers(tx: TenantTransaction, accountId: string, pageId: string, serviceId: string, locationId: string): Promise<boolean> {
  const [row] = await tx.$queryRaw<{ ok: boolean }[]>`
    SELECT EXISTS(
      SELECT 1 FROM booking_pages p JOIN booking_page_services ps ON ps.account_id=p.account_id AND ps.page_id=p.id
      WHERE p.account_id=${accountId}::uuid AND p.id=${pageId}::uuid AND p.active AND ps.service_id=${serviceId}::uuid
        AND (p.location_id IS NULL OR p.location_id=${locationId}::uuid)) AS ok`;
  return Boolean(row?.ok);
}

// ------------------------------------------------------------ the page's WhatsApp number

const NUMBER_TTL = 6 * 60 * MINUTE;
const NUMBER_CACHE_MAX = 500;
const numberCache = new Map<string, { digits: string | null; at: number }>();

/**
 * The connected WhatsApp number that must receive the code (the page's
 * number, else the workspace default), for a wa.me link; null when none is
 * connected or Meta cannot be asked. The display number is not stored, so it
 * is fetched from Meta once and cached per number.
 */
export async function pageNumber(tx: TenantTransaction, accountId: string, pageId: string): Promise<{ configId: string; token: string; phoneNumberId: string } | null> {
  const page = await pageRow(tx, accountId, pageId);
  if (!page) return null;
  const config = await getNumberConfig(tx, accountId, page.whatsapp_config_id).catch(() => null);
  if (!config || config.status !== 'connected' || !config.access_token || !config.phone_number_id) return null;
  return { configId: config.id, token: config.access_token, phoneNumberId: config.phone_number_id };
}

/** Run outside the transaction: one cached Meta lookup per number. */
export async function displayDigits(number: { configId: string; token: string; phoneNumberId: string } | null): Promise<string | null> {
  if (!number) return null;
  const cached = numberCache.get(number.configId);
  if (cached && Date.now() - cached.at < NUMBER_TTL) return cached.digits;
  let digits: string | null = null;
  try {
    const info = await verifyPhoneNumber({ phoneNumberId: number.phoneNumberId, accessToken: decrypt(number.token) });
    const clean = typeof info.display_phone_number === 'string' ? info.display_phone_number.replace(/\D/g, '') : '';
    digits = /^\d{6,15}$/.test(clean) ? clean : null;
  } catch {
    digits = null;
  }
  if (numberCache.size >= NUMBER_CACHE_MAX) numberCache.delete(numberCache.keys().next().value as string);
  // A failed lookup is retried sooner than a good one.
  numberCache.set(number.configId, { digits, at: digits ? Date.now() : Date.now() - NUMBER_TTL + 5 * MINUTE });
  return digits;
}

export function whatsAppLink(digits: string | null, code: string): string | null {
  return digits ? `https://wa.me/${digits}?text=${encodeURIComponent(`BOOK ${code}`)}` : null;
}

// ------------------------------------------------------------ customer status page

export interface ManageView {
  businessName: string;
  status: AppointmentStatus;
  version: number;
  serviceName: string;
  practitioner: string | null;
  location: { name: string; address: string | null; kind: LocationKind } | null;
  online: boolean;
  startAt: string;
  endAt: string;
  timezone: string;
  priceMinor: number | null;
  currency: string | null;
  /** Only when confirmed, online and starting within 24 hours (and not over). */
  meetingUrl: string | null;
  /** Online, confirmed, but the link is not shown yet. */
  meetingLinkLater: boolean;
  /** Confirmed and before the customer cutoff. */
  canChange: boolean;
}

export interface ManageRow {
  id: string;
  status: AppointmentStatus;
  version: number;
  service_id: string;
  location_id: string;
  staff_id: string | null;
  start_at: Date;
  end_at: Date;
}

/** The appointment fields the manage endpoints act on (no customer data). */
export async function manageRow(tx: TenantTransaction, accountId: string, id: string): Promise<ManageRow | null> {
  const [row] = await tx.$queryRaw<ManageRow[]>`
    SELECT id::text, status, version, service_id::text, location_id::text, staff_id::text, start_at, end_at
    FROM appointments WHERE account_id=${accountId}::uuid AND id=${id}::uuid AND status <> 'held'`;
  return row ?? null;
}

export async function loadManageView(tx: TenantTransaction, accountId: string, id: string, now = new Date()): Promise<ManageView | null> {
  const [row] = await tx.$queryRaw<{ status: AppointmentStatus; version: number; service_name: string; staff_name: string | null;
    location_name: string | null; location_address: string | null; location_kind: LocationKind | null; start_at: Date; end_at: Date;
    timezone: string; price_minor: bigint | null; currency: string | null; meeting_url: string | null; business_name: string }[]>`
    SELECT a.status, a.version, a.service_name, st.display_name AS staff_name, l.name AS location_name, l.address AS location_address,
      l.kind AS location_kind, a.start_at, a.end_at, a.timezone, a.price_minor, a.currency, a.meeting_url, acc.name AS business_name
    FROM appointments a JOIN accounts acc ON acc.id=a.account_id
      LEFT JOIN appointment_staff st ON st.account_id=a.account_id AND st.id=a.staff_id
      LEFT JOIN appointment_locations l ON l.account_id=a.account_id AND l.id=a.location_id
    WHERE a.account_id=${accountId}::uuid AND a.id=${id}::uuid AND a.status <> 'held'`;
  if (!row) return null;
  const settings = await loadSettings(tx, accountId);
  const start = row.start_at.getTime();
  const confirmed = row.status === 'confirmed';
  const online = row.meeting_url !== null;
  const linkWindow = confirmed && online && start - now.getTime() <= DAY && now.getTime() < row.end_at.getTime();
  return {
    businessName: row.business_name,
    status: row.status,
    version: row.version,
    serviceName: row.service_name,
    practitioner: row.staff_name,
    location: row.location_name ? { name: row.location_name, address: row.location_address, kind: row.location_kind ?? 'physical' } : null,
    online,
    startAt: row.start_at.toISOString(),
    endAt: row.end_at.toISOString(),
    timezone: row.timezone,
    priceMinor: num(row.price_minor),
    currency: row.currency,
    meetingUrl: linkWindow ? row.meeting_url : null,
    meetingLinkLater: confirmed && online && !linkWindow && now.getTime() < start,
    canChange: confirmed && now.getTime() <= start - settings.customer_cancel_cutoff_minutes * MINUTE,
  };
}
