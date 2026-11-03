/**
 * Browser helpers for the anonymous booking APIs. Plain same-origin fetch:
 * no session, no CSRF header (the routes check Origin, which the browser
 * sets on POST). Errors are code-only.
 */
import { addDays, localParts } from '@/lib/appointments/time';
import type { AppointmentStatus, LocationKind, ServiceMode } from '@/lib/appointments/types';

export class PublicApiError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
    this.name = 'PublicApiError';
  }
}

/** Codes with their own customer-facing message (BookingPublic.errors.*). */
export const PUBLIC_ERROR_CODES = [
  'slot_unavailable', 'day_not_allowed', 'customer_conflict', 'too_many', 'hold_expired', 'conflict', 'invalid',
  'not_yet_supported', 'forbidden', 'error',
] as const;
export type PublicErrorCode = (typeof PUBLIC_ERROR_CODES)[number];

export function errorCode(error: unknown): PublicErrorCode | 'not_found' {
  const code = error instanceof PublicApiError ? error.code : 'error';
  if (code === 'not_found') return 'not_found';
  return (PUBLIC_ERROR_CODES as readonly string[]).includes(code) ? code as PublicErrorCode : 'error';
}

export async function publicFetch<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, body === undefined
    ? { cache: 'no-store' }
    : { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => null) as (T & { code?: string }) | null;
  if (!response.ok || !data) throw new PublicApiError(typeof data?.code === 'string' ? data.code : 'error', response.status);
  return data;
}

export interface PublicSlot { startAt: string; endAt: string; localDate: string; hhmm: string; remaining: number }
export interface SlotsResponse { timezone: string; slots: PublicSlot[] }

export interface PublicLocation {
  id: string; name: string; address: string | null; timezone: string; kind: LocationKind;
  staff: { id: string; displayName: string }[];
}
export interface PublicService {
  id: string; name: string; mode: ServiceMode; durationMinutes: number; priceMinor: number | null; currency: string | null;
  group: boolean;
  /** Paid in advance: a payment link follows the WhatsApp code; the booking is confirmed once paid. */
  paymentRequired: boolean;
  locations: PublicLocation[];
}
export interface PublicPage { title: string; businessName: string; services: PublicService[] }

export interface HoldResponse {
  holdCode: string; holdExpiresAt: string; startAt: string; endAt: string; timezone: string; whatsappUrl: string | null;
}

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
  meetingUrl: string | null;
  meetingLinkLater: boolean;
  canChange: boolean;
}

export const bookingApi = {
  page: (slug: string) => publicFetch<PublicPage>(`/api/public/booking/${encodeURIComponent(slug)}`),
  slots: (slug: string, q: { serviceId: string; locationId: string; staffId?: string; from: string; days: number }) => {
    const params = new URLSearchParams({ service: q.serviceId, location: q.locationId, from: q.from, days: String(q.days) });
    if (q.staffId) params.set('staff', q.staffId);
    return publicFetch<SlotsResponse>(`/api/public/booking/${encodeURIComponent(slug)}/slots?${params}`);
  },
  hold: (slug: string, body: { serviceId: string; locationId: string; staffId?: string; startAt: string; requestId: string;
    intake?: { name?: string; city?: string; state?: string } }) =>
    publicFetch<HoldResponse>(`/api/public/booking/${encodeURIComponent(slug)}`, body),
  manage: (token: string) => publicFetch<ManageView>(`/api/public/booking/manage/${encodeURIComponent(token)}`),
  manageSlots: (token: string, q: { from: string; days: number }) =>
    publicFetch<SlotsResponse>(`/api/public/booking/manage/${encodeURIComponent(token)}/slots?${new URLSearchParams({ from: q.from, days: String(q.days) })}`),
  change: (token: string, body: { action: 'cancel' | 'reschedule'; startAt?: string; expectedVersion: number }) =>
    publicFetch<ManageView>(`/api/public/booking/manage/${encodeURIComponent(token)}`, body),
};

/** Days per slot request (the public maximum). */
export const WINDOW_DAYS = 7;

/** Today in a zone, and window paging, as local date strings. */
export const todayIn = (timeZone: string) => localParts(new Date(), timeZone).date;
export const shiftWindow = (from: string, by: number) => addDays(from, by);

/** Distinct local dates that have slots, in order. */
export function slotDates(slots: PublicSlot[]): string[] {
  return [...new Set(slots.map((s) => s.localDate))];
}

/** A price in minor units, in its currency; null when there is none. */
export function formatPrice(minor: number | null, currency: string | null, locale: string): string | null {
  if (minor === null || !currency) return null;
  try {
    const format = new Intl.NumberFormat(locale, { style: 'currency', currency });
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
    return format.format(minor / 10 ** digits);
  } catch {
    return null;
  }
}

/** A date and time in the appointment's zone (never the viewer's). */
export function formatWhen(iso: string, timeZone: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'short', timeZone }).format(new Date(iso));
}

export function newRequestId(): string {
  return crypto.randomUUID();
}
