/**
 * Pure helpers for the public booking flow (tested in booking-flow.test.ts):
 * service selection, direct-link preselection, prices and hold-status polling.
 */

export type FlowStep = 'service' | 'time' | 'confirm';
export const FLOW_STEPS: readonly FlowStep[] = ['service', 'time', 'confirm'];

interface StaffRef { id: string }
interface LocationRef { id: string; staff: StaffRef[] }
interface ServiceRef { id: string; locations: LocationRef[] }

type ServiceChoice = { id: string; locations: { id: string }[] };

/**
 * The service/location selection after a service card is clicked.
 * Re-clicking the chosen service changes nothing; a service with one location
 * gets that location at once, since no location chooser is shown for it.
 */
export function serviceSelection(currentServiceId: string | null, s: ServiceChoice): { serviceId: string; locationId: string | null } | null {
  if (s.id === currentServiceId) return null;
  return { serviceId: s.id, locationId: s.locations.length === 1 ? s.locations[0].id : null };
}

export interface Preselection {
  serviceId: string | null;
  locationId: string | null;
  /** '' = any practitioner. */
  staffId: string;
  /** A staff link: only services this practitioner offers are listed. */
  staffFilter: string | null;
  /** Where the flow opens. */
  step: FlowStep;
}

const offersStaff = (service: ServiceRef, staffId: string) => service.locations.some((l) => l.staff.some((s) => s.id === staffId));

/** The one location to use: the only one, or the only one where the practitioner works. */
function pickLocation(service: ServiceRef, staffId: string): string | null {
  const places = staffId ? service.locations.filter((l) => l.staff.some((s) => s.id === staffId)) : service.locations;
  return places.length === 1 ? places[0].id : null;
}

const asParam = (value: string | string[] | null | undefined): string | null =>
  (typeof value === 'string' && value.length <= 64 ? value.toLowerCase() : null);

/**
 * /book/<slug>?service=<id>&staff=<id>: what to preselect. Anything not on
 * the page is ignored, so a stale or edited link still opens the page.
 */
export function preselect(services: ServiceRef[], query: { service?: string | string[] | null; staff?: string | string[] | null }): Preselection {
  const wantService = asParam(query.service);
  const wantStaff = asParam(query.staff);
  const staffId = wantStaff && services.some((s) => offersStaff(s, wantStaff)) ? wantStaff : '';
  const candidates = staffId ? services.filter((s) => offersStaff(s, staffId)) : services;
  const service = candidates.find((s) => s.id === wantService) ?? (candidates.length === 1 ? candidates[0] : null);
  if (!service) return { serviceId: null, locationId: null, staffId, staffFilter: staffId || null, step: 'service' };
  const locationId = pickLocation(service, staffId);
  // Nothing left to choose on step 1: open on the times.
  return { serviceId: service.id, locationId, staffId, staffFilter: staffId || null, step: locationId ? 'time' : 'service' };
}

/** The location to use once a service is chosen while a practitioner is preselected. */
export function locationForStaff(service: ServiceRef, staffId: string): string | null {
  return pickLocation(service, staffId);
}

/** "Free" for a missing or zero price; otherwise the formatted amount (null when it cannot be formatted). */
export function priceText(minor: number | null, currency: string | null, locale: string, free: string): string | null {
  if (minor === null || minor === 0) return free;
  if (!currency) return null;
  try {
    const format = new Intl.NumberFormat(locale, { style: 'currency', currency });
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
    return format.format(minor / 10 ** digits);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ waiting for the WhatsApp code

export type HoldState = 'held' | 'payment_pending' | 'confirmed' | 'expired' | 'cancelled';
export const FINAL_HOLD_STATES: readonly HoldState[] = ['confirmed', 'expired', 'cancelled'];

const MINUTE = 60_000;
/** Payment can take a while; stop asking after this and leave the page as it is. */
export const MAX_WAIT_MS = 45 * MINUTE;

/**
 * Milliseconds until the next status check, or null to stop: every 3 s for
 * the first two minutes, then 6 s, then 15 s; 30 s after a refusal (rate
 * limit or error); stop on a final state, after the hold expired (a short
 * grace for a code sent at the last second) or after MAX_WAIT_MS.
 */
export function nextPollDelay(input: {
  state: HoldState;
  elapsedMs: number;
  /** The hold's own expiry; it no longer applies once payment is awaited (the server extends it). */
  msToExpiry: number;
  failed?: boolean;
}): number | null {
  if (FINAL_HOLD_STATES.includes(input.state)) return null;
  if (input.elapsedMs >= MAX_WAIT_MS) return null;
  if (input.state === 'held' && input.msToExpiry < -MINUTE) return null;
  if (input.failed) return 30_000;
  if (input.elapsedMs < 2 * MINUTE) return 3_000;
  if (input.elapsedMs < 5 * MINUTE) return 6_000;
  return 15_000;
}

/** The manage token inside a /my-booking/<token> path, for the .ics link. */
export function tokenFromManagePath(path: string | undefined | null): string | null {
  const match = typeof path === 'string' ? /^\/my-booking\/([A-Za-z0-9_-]{43})$/.exec(path) : null;
  return match ? match[1] : null;
}

/** The calendar file of a booking, by its manage token. */
export const icsPath = (token: string) => `/api/public/booking/manage/${encodeURIComponent(token)}/ics`;
