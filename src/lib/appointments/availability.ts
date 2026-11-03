/**
 * Bookable slots (design section 3).
 *
 * computeSlots is pure: the same function lists slots for staff and the public
 * pages and re-checks a requested start inside the booking transaction, after
 * the advisory locks, so the Monday rule, hours, exceptions, notice, horizon
 * and capacity are applied identically everywhere.
 *
 * The loaders read only rows of the caller's tenant (RLS plus explicit
 * account_id filters) and never return customer data: busy rows carry ids,
 * times and statuses only.
 */
import type { TenantTransaction } from '@/lib/db/tenant';
import { parseWorkingHours, type TimeRange, type WorkingHours } from '@/lib/inbox/working-hours';
import { addDays, isCalendarDate, isoWeekday, isValidTimeZone, localParts, minutesOf, weekdayKey, zonedWallToUtc, hhmmOf } from './time';
import {
  AppointmentError, DEFAULT_APPOINTMENT_SETTINGS,
  type AppointmentSettingsRow, type ExceptionRow, type LocationRow, type OfferingRow, type ServiceRow, type Slot, type StaffRow,
} from './types';

const MINUTE = 60_000;
const DAY = 86_400_000;
/** "Any practitioner" locks every candidate; more than this is refused. */
export const MAX_CANDIDATE_STAFF = 50;
/** Hard cap on days per availability call (staff endpoints; public is lower). */
export const MAX_SLOT_DAYS = 14;

/** An active appointment that occupies time (ids and times only). */
export interface BusyRow {
  id: string;
  staff_id: string | null;
  service_id: string;
  location_id: string;
  start_at: Date;
  end_at: Date;
  /** The booked service's buffer, appended after end_at. */
  buffer_minutes: number;
}

/** POOL_KEY marks pool hours (appointment_hours with staff_id NULL). */
export const POOL_KEY = 'pool';

export interface SlotInputs {
  timezone: string;
  /** The location being booked: a group seat must be at the same place. */
  locationId: string;
  service: Pick<ServiceRow, 'id' | 'duration_minutes' | 'buffer_minutes' | 'slot_step_minutes' | 'capacity' | 'allowed_weekdays'>;
  /** Offerings of this service at this location: one with staff_id null (pool) or one per practitioner. */
  offerings: Pick<OfferingRow, 'staff_id'>[];
  /** Weekly hours by staff id, or POOL_KEY for the pool. */
  hoursByKey: Map<string, WorkingHours>;
  /** Exceptions at the location (staff_id null) and for its practitioners there. */
  exceptions: Pick<ExceptionRow, 'staff_id' | 'starts_on' | 'ends_on' | 'ranges'>[];
  /** Active appointments of those practitioners (any location) or of the pool. */
  busy: BusyRow[];
  settings: Pick<AppointmentSettingsRow, 'min_notice_minutes' | 'horizon_days'>;
  fromDay: string;
  days: number;
  now: Date;
  /** Booking re-checks of an existing appointment ignore its own row. */
  excludeAppointmentId?: string;
  /** Confirming a hold: the slot was already offered, so notice and horizon are not re-applied. */
  ignoreNotice?: boolean;
}

/** Minute ranges [start, end) within one local day. */
type MinuteRange = [number, number];

function toMinuteRanges(ranges: TimeRange[] | undefined | null): MinuteRange[] {
  return (ranges ?? []).map((r) => [minutesOf(r.start), minutesOf(r.end)] as MinuteRange);
}

function intersect(a: MinuteRange[], b: MinuteRange[]): MinuteRange[] {
  const out: MinuteRange[] = [];
  for (const [s1, e1] of a) for (const [s2, e2] of b) {
    const s = Math.max(s1, s2), e = Math.min(e1, e2);
    if (s < e) out.push([s, e]);
  }
  return out.sort((x, y) => x[0] - y[0]);
}

const covers = (ex: Pick<ExceptionRow, 'starts_on' | 'ends_on'>, day: string) => ex.starts_on <= day && day <= ex.ends_on;

/**
 * Effective ranges on a local day for one practitioner (or the pool, staffId
 * null): a location holiday closes everything; else a staff exception replaces
 * the weekly hours; then a location exception's custom ranges intersect.
 */
export function effectiveRanges(
  day: string,
  staffId: string | null,
  hoursByKey: Map<string, WorkingHours>,
  exceptions: SlotInputs['exceptions'],
): MinuteRange[] {
  const locationEx = exceptions.filter((e) => e.staff_id === null && covers(e, day));
  if (locationEx.some((e) => e.ranges === null)) return [];
  let ranges: MinuteRange[];
  const staffEx = staffId ? exceptions.filter((e) => e.staff_id === staffId && covers(e, day)) : [];
  if (staffEx.length) {
    if (staffEx.some((e) => e.ranges === null)) return [];
    ranges = staffEx.flatMap((e) => toMinuteRanges(e.ranges)).sort((x, y) => x[0] - y[0]);
  } else {
    ranges = toMinuteRanges(hoursByKey.get(staffId ?? POOL_KEY)?.[weekdayKey(day)]);
  }
  for (const ex of locationEx) ranges = intersect(ranges, toMinuteRanges(ex.ranges));
  return ranges;
}

/** Whether a service may be booked on a local date (Monday-only and similar rules). */
export function dayAllowed(service: Pick<ServiceRow, 'allowed_weekdays'>, localDate: string): boolean {
  const allowed = service.allowed_weekdays;
  return !allowed || allowed.length === 0 || allowed.includes(isoWeekday(localDate));
}

/**
 * Remaining places for a candidate [start, end + buffer) against one
 * practitioner's (or the pool's) busy rows: any overlap must be the same
 * service at the same location starting at the same instant (a group
 * session) and number fewer than the capacity; anything else is a conflict
 * (0). A practitioner's rows come from every location, so the location check
 * keeps one person from running the "same" group session in two places.
 */
export function remainingFor(
  candidate: { serviceId: string; locationId: string; start: number; end: number; bufferMs: number; capacity: number },
  busy: BusyRow[],
): number {
  let overlapping = 0;
  for (const b of busy) {
    const bStart = b.start_at.getTime();
    const bEnd = b.end_at.getTime() + b.buffer_minutes * MINUTE;
    if (!(candidate.start < bEnd && bStart < candidate.end + candidate.bufferMs)) continue;
    if (b.service_id !== candidate.serviceId || b.location_id !== candidate.locationId || bStart !== candidate.start) return 0;
    overlapping++;
  }
  return Math.max(0, candidate.capacity - overlapping);
}

/**
 * The UTC instant a working range closes ("24:00" = next-day 00:00). A close
 * inside a DST gap does not exist, so the first wall minute after the gap
 * stands in; null only when nothing valid follows that day.
 */
export function rangeEndInstant(day: string, rangeEnd: number, timezone: string): number | null {
  for (let m = rangeEnd; m <= 1440; m++) {
    const at = zonedWallToUtc(day, hhmmOf(m), timezone);
    if (at) return at.getTime();
  }
  return null;
}

/** Every bookable start in the window, ascending. */
export function computeSlots(input: SlotInputs): Slot[] {
  const { service, timezone, now } = input;
  const days = Math.min(Math.max(1, Math.floor(input.days)), MAX_SLOT_DAYS);
  if (!isCalendarDate(input.fromDay) || !isValidTimeZone(timezone) || input.offerings.length === 0) return [];
  const pooled = input.offerings.some((o) => o.staff_id === null);
  const owners: (string | null)[] = pooled ? [null] : [...new Set(input.offerings.map((o) => o.staff_id as string))].sort();
  const busy = input.busy.filter((b) => b.id !== input.excludeAppointmentId);
  const busyBy = new Map<string | null, BusyRow[]>(owners.map((o) => [o, busy.filter((b) => (o === null
    ? b.staff_id === null && b.service_id === service.id
    : b.staff_id === o))]));
  const step = service.slot_step_minutes ?? service.duration_minutes;
  const durationMs = service.duration_minutes * MINUTE;
  const bufferMs = service.buffer_minutes * MINUTE;
  const earliest = input.ignoreNotice ? now.getTime() : now.getTime() + input.settings.min_notice_minutes * MINUTE;
  const latest = input.ignoreNotice ? Number.POSITIVE_INFINITY : now.getTime() + input.settings.horizon_days * DAY;

  const slots = new Map<number, Slot>();
  for (let i = 0; i < days; i++) {
    const day = addDays(input.fromDay, i);
    if (!dayAllowed(service, day)) continue;
    for (const owner of owners) {
      for (const [rangeStart, rangeEnd] of effectiveRanges(day, owner, input.hoursByKey, input.exceptions)) {
        // The range's real closing instant: on a spring-forward day a slot that
        // fits in wall minutes can still run past it in absolute time.
        const closesAt = rangeEndInstant(day, rangeEnd, timezone);
        if (closesAt === null) continue;
        for (let m = rangeStart; m + service.duration_minutes <= rangeEnd; m += step) {
          const startAt = zonedWallToUtc(day, hhmmOf(m), timezone);
          if (!startAt) continue; // DST gap
          const start = startAt.getTime();
          if (start < earliest || start > latest || start + durationMs > closesAt) continue;
          const remaining = remainingFor({ serviceId: service.id, locationId: input.locationId, start, end: start + durationMs, bufferMs,
            capacity: service.capacity }, busyBy.get(owner) ?? []);
          if (remaining <= 0) continue;
          const slot = slots.get(start) ?? {
            startAt: startAt.toISOString(), endAt: new Date(start + durationMs).toISOString(),
            localDate: day, hhmm: hhmmOf(m), staffIds: [], remaining: 0,
          };
          if (owner) slot.staffIds.push(owner);
          slot.remaining += remaining;
          slots.set(start, slot);
        }
      }
    }
  }
  return [...slots.entries()].sort((a, b) => a[0] - b[0]).map(([, s]) => ({ ...s, staffIds: [...s.staffIds].sort() }));
}

// ------------------------------------------------------------ loaders

export interface AvailabilityConfig {
  service: ServiceRow;
  location: LocationRow;
  offerings: OfferingRow[];
  /** Non-archived practitioners offering the service here (empty for a pool). */
  staff: StaffRow[];
  pooled: boolean;
  hoursByKey: Map<string, WorkingHours>;
  exceptions: ExceptionRow[];
  settings: AppointmentSettingsRow;
}

const SERVICE_COLUMNS = `id, name, mode, duration_minutes, buffer_minutes, slot_step_minutes, capacity, price_minor, currency,
  payment_required, allowed_weekdays, meeting_url, feedback_delay_minutes, rebook_after_days, archived_at`;

export async function loadSettings(tx: TenantTransaction, accountId: string): Promise<AppointmentSettingsRow> {
  const [row] = await tx.$queryRawUnsafe<AppointmentSettingsRow[]>(
    `SELECT ${Object.keys(DEFAULT_APPOINTMENT_SETTINGS).join(', ')} FROM appointment_settings WHERE account_id=$1::uuid`, accountId);
  return row ?? { ...DEFAULT_APPOINTMENT_SETTINGS };
}

export async function loadService(tx: TenantTransaction, accountId: string, serviceId: string): Promise<ServiceRow | null> {
  const [row] = await tx.$queryRawUnsafe<ServiceRow[]>(
    `SELECT ${SERVICE_COLUMNS} FROM appointment_services WHERE account_id=$1::uuid AND id=$2::uuid`, accountId, serviceId);
  return row ?? null;
}

export async function loadLocation(tx: TenantTransaction, accountId: string, locationId: string): Promise<LocationRow | null> {
  const [row] = await tx.$queryRaw<LocationRow[]>`SELECT id, name, address, timezone, kind, archived_at
    FROM appointment_locations WHERE account_id=${accountId}::uuid AND id=${locationId}::uuid`;
  return row ?? null;
}

/**
 * Service, location, offerings, practitioners, hours, exceptions and
 * settings for one (service, location). Refuses archived or unknown rows with
 * not_found and a service/location pair with no offering with slot_unavailable.
 */
export async function loadAvailabilityConfig(
  tx: TenantTransaction,
  accountId: string,
  serviceId: string,
  locationId: string,
  window?: { fromDay: string; days: number },
): Promise<AvailabilityConfig> {
  const [service, location] = await Promise.all([loadService(tx, accountId, serviceId), loadLocation(tx, accountId, locationId)]);
  if (!service || service.archived_at || !location || location.archived_at) throw new AppointmentError('not_found');
  const offerings = await tx.$queryRaw<(OfferingRow & { staff_archived: boolean })[]>`
    SELECT o.id, o.service_id, o.staff_id, o.location_id, (s.archived_at IS NOT NULL) AS staff_archived
    FROM appointment_offerings o LEFT JOIN appointment_staff s ON s.account_id=o.account_id AND s.id=o.staff_id
    WHERE o.account_id=${accountId}::uuid AND o.service_id=${serviceId}::uuid AND o.location_id=${locationId}::uuid
    ORDER BY o.staff_id NULLS FIRST`;
  const live: OfferingRow[] = offerings.filter((o) => !o.staff_archived)
    .map((o) => ({ id: o.id, service_id: o.service_id, staff_id: o.staff_id, location_id: o.location_id }));
  const pooled = live.some((o) => o.staff_id === null);
  const staffIds = pooled ? [] : live.map((o) => o.staff_id as string);
  const staff = staffIds.length
    ? await tx.$queryRaw<StaffRow[]>`SELECT id, display_name, user_id, archived_at FROM appointment_staff
        WHERE account_id=${accountId}::uuid AND id = ANY(${staffIds}::uuid[]) ORDER BY id`
    : [];
  const hourRows = await tx.$queryRaw<{ staff_id: string | null; hours: unknown }[]>`
    SELECT staff_id, hours FROM appointment_hours WHERE account_id=${accountId}::uuid AND location_id=${locationId}::uuid
      AND (staff_id IS NULL OR staff_id = ANY(${staffIds}::uuid[]))`;
  const hoursByKey = new Map<string, WorkingHours>();
  for (const row of hourRows) {
    const parsed = parseWorkingHours(row.hours);
    if (parsed) hoursByKey.set(row.staff_id ?? POOL_KEY, parsed);
  }
  if (window && !isCalendarDate(window.fromDay)) throw new AppointmentError('invalid');
  const from = window?.fromDay ?? '0001-01-01';
  const to = window ? addDays(window.fromDay, window.days) : '9999-12-31';
  const exceptions = await tx.$queryRaw<ExceptionRow[]>`
    SELECT id, staff_id, location_id, starts_on::text AS starts_on, ends_on::text AS ends_on, ranges, reason
    FROM appointment_exceptions WHERE account_id=${accountId}::uuid AND location_id=${locationId}::uuid
      AND (staff_id IS NULL OR staff_id = ANY(${staffIds}::uuid[]))
      AND starts_on <= ${to}::date AND ends_on >= ${from}::date`;
  return { service, location, offerings: live, staff, pooled, hoursByKey, exceptions, settings: await loadSettings(tx, accountId) };
}

/**
 * Active appointments (confirmed, or held and not yet expired) of the given
 * practitioners at any location, or of the pool, overlapping the window
 * around [fromDay, fromDay + days). Call it after the advisory locks when
 * booking, so the count includes every row committed by the previous holder.
 */
export async function loadBusy(
  tx: TenantTransaction,
  accountId: string,
  scope: { staffIds: string[] } | { pool: { serviceId: string; locationId: string } },
  window: { fromDay: string; days: number },
  now: Date,
): Promise<BusyRow[]> {
  // A generous window: two days either side covers every zone offset, the
  // 8-hour maximum duration and the 4-hour maximum buffer.
  const [y, m, d] = window.fromDay.split('-').map(Number);
  const from = new Date(Date.UTC(y, m - 1, d) - 2 * DAY);
  const to = new Date(Date.UTC(y, m - 1, d) + (window.days + 2) * DAY);
  if ('staffIds' in scope) {
    if (!scope.staffIds.length) return [];
    return tx.$queryRaw<BusyRow[]>`SELECT a.id, a.staff_id, a.service_id, a.location_id, a.start_at, a.end_at, s.buffer_minutes
      FROM appointments a JOIN appointment_services s ON s.account_id=a.account_id AND s.id=a.service_id
      WHERE a.account_id=${accountId}::uuid AND a.staff_id = ANY(${scope.staffIds}::uuid[])
        AND (a.status='confirmed' OR (a.status='held' AND a.hold_expires_at > ${now}))
        AND a.start_at < ${to} AND a.end_at > ${from}`;
  }
  return tx.$queryRaw<BusyRow[]>`SELECT a.id, a.staff_id, a.service_id, a.location_id, a.start_at, a.end_at, s.buffer_minutes
    FROM appointments a JOIN appointment_services s ON s.account_id=a.account_id AND s.id=a.service_id
    WHERE a.account_id=${accountId}::uuid AND a.staff_id IS NULL AND a.service_id=${scope.pool.serviceId}::uuid
      AND a.location_id=${scope.pool.locationId}::uuid
      AND (a.status='confirmed' OR (a.status='held' AND a.hold_expires_at > ${now}))
      AND a.start_at < ${to} AND a.end_at > ${from}`;
}

export interface ListSlotsInput {
  serviceId: string;
  locationId: string;
  /** YYYY-MM-DD in the location's zone; default today there. */
  fromDay?: string;
  days: number;
  /** Only this practitioner's free slots. */
  staffId?: string;
  now?: Date;
  excludeAppointmentId?: string;
}

/** Slots for staff and public endpoints (read-only; booking re-checks under locks). */
export async function listSlots(tx: TenantTransaction, accountId: string, input: ListSlotsInput): Promise<{ timezone: string; slots: Slot[] }> {
  const now = input.now ?? new Date();
  const days = Math.min(Math.max(1, Math.floor(input.days)), MAX_SLOT_DAYS);
  const location = await loadLocation(tx, accountId, input.locationId);
  if (!location || location.archived_at) throw new AppointmentError('not_found');
  const fromDay = input.fromDay ?? localParts(now, location.timezone).date;
  if (!isCalendarDate(fromDay)) throw new AppointmentError('invalid');
  const config = await loadAvailabilityConfig(tx, accountId, input.serviceId, input.locationId, { fromDay, days });
  const scope = config.pooled
    ? { pool: { serviceId: config.service.id, locationId: config.location.id } }
    : { staffIds: config.staff.map((s) => s.id) };
  const busy = await loadBusy(tx, accountId, scope, { fromDay, days }, now);
  const offerings = input.staffId ? config.offerings.filter((o) => o.staff_id === input.staffId) : config.offerings;
  const slots = computeSlots({
    timezone: config.location.timezone, locationId: config.location.id, service: config.service, offerings, hoursByKey: config.hoursByKey,
    exceptions: config.exceptions, busy, settings: config.settings, fromDay, days, now, excludeAppointmentId: input.excludeAppointmentId,
  });
  return { timezone: config.location.timezone, slots };
}
