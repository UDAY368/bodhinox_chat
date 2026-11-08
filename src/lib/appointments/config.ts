/**
 * Appointment configuration: settings, locations, services, practitioners,
 * offerings, weekly hours, exceptions and booking pages (design sections 1
 * and 8). Admin-written (RLS: app_write_allowed('admin')); every change is
 * audit-logged with ids only. Inputs are parsed with fixed schemas here so
 * routes stay thin.
 */
import { appOrigin } from '@/lib/auth/csrf';
import { gateLimit } from '@/lib/billing/limits';
import type { TenantTransaction } from '@/lib/db/tenant';
import { parseWorkingHours, type TimeRange, type WorkingHours } from '@/lib/inbox/working-hours';
import { loadSettings } from './availability';
import { CURRENT_ZONE_NAMES } from './time-zone-names';
import { paidBookingReady } from './booking';
import { lockKeys } from './keys';
import { appointmentTemplateRefusal, type AppointmentCheckedTemplate, type AppointmentTemplateRefusal } from './template-check';
import { isCalendarDate, isValidTimeZone } from './time';
import {
  APPOINTMENT_TEMPLATE_SLOTS, AppointmentError, LOCATION_KINDS, SERVICE_MODES,
  type AppointmentSettingsRow, type AppointmentTemplateSlot, type ExceptionRow, type LocationRow, type OfferingRow, type ServiceRow, type StaffRow,
} from './types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const SLUG = /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/;

/** An invalid field (code 'invalid'); `detail` is a stable code for the UI, never input text. */
export class AppointmentFieldError extends AppointmentError {
  constructor(readonly field: string, readonly detail: string = 'invalid') {
    super('invalid');
    this.name = 'AppointmentFieldError';
  }
}

type Body = Record<string, unknown>;
const has = (b: Body, k: string) => Object.hasOwn(b, k) && b[k] !== undefined;

function asBody(value: unknown): Body {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppointmentError('invalid');
  return value as Body;
}
function text(b: Body, k: string, min: number, max: number): string {
  const v = b[k];
  if (typeof v !== 'string' || v.trim().length < min || v.trim().length > max) throw new AppointmentFieldError(k);
  return v.trim();
}
function optText(b: Body, k: string, max: number): string | null {
  const v = b[k];
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || v.length > max) throw new AppointmentFieldError(k);
  return v.trim() || null;
}
function int(b: Body, k: string, min: number, max: number): number {
  const v = b[k];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new AppointmentFieldError(k);
  return v;
}
function optInt(b: Body, k: string, min: number, max: number): number | null {
  return b[k] === null ? null : int(b, k, min, max);
}
function bool(b: Body, k: string): boolean {
  if (typeof b[k] !== 'boolean') throw new AppointmentFieldError(k);
  return b[k] as boolean;
}
function uuid(b: Body, k: string): string {
  const v = b[k];
  if (typeof v !== 'string' || !UUID.test(v)) throw new AppointmentFieldError(k);
  return v;
}
function optUuid(b: Body, k: string): string | null {
  return b[k] === null || b[k] === '' ? null : uuid(b, k);
}
function oneOf<T extends string>(b: Body, k: string, values: readonly T[]): T {
  if (!(values as readonly unknown[]).includes(b[k])) throw new AppointmentFieldError(k);
  return b[k] as T;
}
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

async function audit(tx: TenantTransaction, accountId: string, userId: string | null, action: string, resourceId: string, metadata: object = {}) {
  await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
    VALUES(${accountId}::uuid,${userId}::uuid,${action},${resourceId},${JSON.stringify(metadata)}::jsonb)`;
}

/** A foreign-key, unique or check violation from Postgres, as a field error. */
function mapDbError(error: unknown, field: string, uniqueDetail = 'taken'): never {
  const code = (error as { code?: string; meta?: { code?: string } })?.meta?.code ?? (error as { code?: string })?.code;
  const message = error instanceof Error ? error.message : '';
  if (code === '23505' || /23505|unique constraint/i.test(message)) throw new AppointmentFieldError(field, uniqueDetail);
  if (code === '23503' || code === '23514' || /2350[34]|23514|foreign key|check constraint/i.test(message)) throw new AppointmentFieldError(field);
  throw error;
}

// ------------------------------------------------------------ settings

export interface TemplateCheckResult {
  slot: AppointmentTemplateSlot;
  error: AppointmentTemplateRefusal | 'not_found' | 'not_approved';
}

/** Look up a settings template and say why it cannot carry appointment messages (null = fine). */
export async function settingsTemplateRefusal(
  tx: TenantTransaction, accountId: string, name: string, language: string,
): Promise<TemplateCheckResult['error'] | null> {
  const rows = await tx.$queryRaw<(AppointmentCheckedTemplate & { status: string | null })[]>`
    SELECT category, body_text, header_type, header_content, header_media_url, buttons, template_kind, cards, lto, status
    FROM message_templates WHERE account_id=${accountId}::uuid AND name=${name} AND lower(language)=lower(${language})
    ORDER BY (upper(coalesce(status,''))='APPROVED') DESC LIMIT 1`;
  const row = rows[0];
  if (!row) return 'not_found';
  if (String(row.status ?? '').toUpperCase() !== 'APPROVED') return 'not_approved';
  return appointmentTemplateRefusal(row, appOrigin());
}

export { loadSettings as getSettings };

/** Partial update of the workspace settings; every set template is validated (design D15). */
export async function saveSettings(tx: TenantTransaction, accountId: string, userId: string | null, raw: unknown): Promise<AppointmentSettingsRow> {
  const b = asBody(raw);
  const next: AppointmentSettingsRow = { ...(await loadSettings(tx, accountId)) };
  if (has(b, 'hold_minutes')) next.hold_minutes = int(b, 'hold_minutes', 5, 60);
  if (has(b, 'max_active_holds_per_page')) next.max_active_holds_per_page = int(b, 'max_active_holds_per_page', 1, 200);
  if (has(b, 'min_notice_minutes')) next.min_notice_minutes = int(b, 'min_notice_minutes', 0, 10080);
  if (has(b, 'horizon_days')) next.horizon_days = int(b, 'horizon_days', 1, 365);
  if (has(b, 'customer_cancel_cutoff_minutes')) next.customer_cancel_cutoff_minutes = int(b, 'customer_cancel_cutoff_minutes', 0, 10080);
  for (const k of ['reminder_24h', 'reminder_2h', 'staff_notify'] as const) if (has(b, k)) next[k] = bool(b, k);
  for (const slot of APPOINTMENT_TEMPLATE_SLOTS) {
    const nameKey = `${slot}_template_name` as const, langKey = `${slot}_template_language` as const;
    if (!has(b, nameKey) && !has(b, langKey)) continue;
    const name = optText(b, nameKey, 512);
    const language = name ? text(b, langKey, 2, 15) : null;
    if (name && language) {
      const error = await settingsTemplateRefusal(tx, accountId, name, language);
      if (error) throw new AppointmentFieldError(nameKey, error);
    }
    next[nameKey] = name;
    next[langKey] = language;
  }
  const cols = Object.keys(next) as (keyof AppointmentSettingsRow)[];
  const values = cols.map((c) => next[c]);
  await tx.$executeRawUnsafe(
    `INSERT INTO appointment_settings(account_id, ${cols.join(', ')}) VALUES($1::uuid, ${cols.map((_, i) => `$${i + 2}`).join(', ')})
     ON CONFLICT (account_id) DO UPDATE SET ${cols.map((c) => `${c}=EXCLUDED.${c}`).join(', ')}, updated_at=now()`,
    accountId, ...values);
  await audit(tx, accountId, userId, 'appointments.settings.updated', accountId, { fields: Object.keys(b).filter((k) => (cols as string[]).includes(k)) });
  return next;
}

// ------------------------------------------------------------ locations

export async function listLocations(tx: TenantTransaction, accountId: string): Promise<LocationRow[]> {
  return tx.$queryRaw<LocationRow[]>`SELECT id, name, address, timezone, kind, archived_at FROM appointment_locations
    WHERE account_id=${accountId}::uuid ORDER BY archived_at NULLS FIRST, name, id`;
}

/** Offset forms ('+05:30', '-0300'): Intl reads them east-positive, Postgres AT TIME ZONE as POSIX (west-positive). */
const OFFSET_ZONE = /^[+-]|^\d/;

/**
 * Names to try for a location zone, as given and in Intl's canonical form
 * ('america/new_york' -> 'America/New_York', 'US/Pacific-New' ->
 * 'America/Los_Angeles'). Offset forms are refused: the app and Postgres
 * would put the same instant on different local dates.
 */
export function timeZoneCandidates(value: unknown): string[] {
  if (!isValidTimeZone(value) || OFFSET_ZONE.test(value)) throw new AppointmentFieldError('timezone');
  const canonical = new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  if (OFFSET_ZONE.test(canonical)) throw new AppointmentFieldError('timezone');
  // Current names first: browsers still report old aliases (Chrome on Windows sends Asia/Calcutta),
  // and Postgres images built on newer Debian tzdata no longer list those aliases.
  const current = [CURRENT_ZONE_NAMES[value], CURRENT_ZONE_NAMES[canonical]].filter((z): z is string => !!z);
  return [...new Set([...current, value, canonical])];
}


/**
 * The zone name to store: the first candidate Postgres also knows
 * (appointments.local_date and the stats buckets use AT TIME ZONE), so an
 * ICU-only alias is a field error here, not a 500 on the first booking.
 */
export async function resolveLocationTimeZone(tx: TenantTransaction, value: unknown): Promise<string> {
  const candidates = timeZoneCandidates(value);
  const known = await tx.$queryRaw<{ name: string }[]>`SELECT name FROM pg_timezone_names WHERE name = ANY(${candidates}::text[])`;
  const hit = candidates.find((c) => known.some((k) => k.name === c));
  if (!hit) throw new AppointmentFieldError('timezone');
  return hit;
}

function locationFields(b: Body, partial: boolean) {
  const out: Partial<Pick<LocationRow, 'name' | 'address' | 'timezone' | 'kind'>> = {};
  if (!partial || has(b, 'name')) out.name = text(b, 'name', 1, 120);
  if (has(b, 'address')) out.address = optText(b, 'address', 500);
  if (!partial || has(b, 'timezone')) {
    timeZoneCandidates(b.timezone);
    out.timezone = b.timezone as string;
  }
  if (has(b, 'kind')) out.kind = oneOf(b, 'kind', LOCATION_KINDS);
  return out;
}

export async function createLocation(tx: TenantTransaction, accountId: string, userId: string | null, raw: unknown): Promise<LocationRow> {
  const f = locationFields(asBody(raw), false);
  f.timezone = await resolveLocationTimeZone(tx, f.timezone);
  const [row] = await tx.$queryRaw<LocationRow[]>`INSERT INTO appointment_locations(name,address,timezone,kind)
    VALUES(${f.name},${f.address ?? null},${f.timezone},${f.kind ?? 'physical'})
    RETURNING id, name, address, timezone, kind, archived_at`;
  await audit(tx, accountId, userId, 'appointments.location.created', row.id);
  return row;
}

export async function updateLocation(tx: TenantTransaction, accountId: string, userId: string | null, id: string, raw: unknown): Promise<LocationRow> {
  const b = asBody(raw);
  const f = locationFields(b, true);
  if (f.timezone !== undefined) f.timezone = await resolveLocationTimeZone(tx, f.timezone);
  const archive = has(b, 'archived') ? bool(b, 'archived') : undefined;
  const [row] = await tx.$queryRaw<LocationRow[]>`UPDATE appointment_locations SET
      name=COALESCE(${f.name ?? null},name),
      address=CASE WHEN ${has(b, 'address')} THEN ${f.address ?? null} ELSE address END,
      timezone=COALESCE(${f.timezone ?? null},timezone), kind=COALESCE(${f.kind ?? null},kind),
      archived_at=CASE WHEN ${archive === undefined} THEN archived_at WHEN ${archive === true} THEN COALESCE(archived_at, now()) ELSE NULL END,
      updated_at=now()
    WHERE account_id=${accountId}::uuid AND id=${id}::uuid RETURNING id, name, address, timezone, kind, archived_at`;
  if (!row) throw new AppointmentError('not_found');
  await audit(tx, accountId, userId, 'appointments.location.updated', id, { fields: Object.keys(b) });
  return row;
}

// ------------------------------------------------------------ services

const SERVICE_RETURNING = `id, name, mode, duration_minutes, buffer_minutes, slot_step_minutes, capacity, price_minor, currency,
  payment_required, allowed_weekdays, meeting_url, feedback_delay_minutes, rebook_after_days, archived_at`;

type ServiceFields = Omit<ServiceRow, 'id' | 'archived_at'>;

function weekdays(b: Body): number[] | null {
  const v = b.allowed_weekdays;
  if (v === null) return null;
  if (!Array.isArray(v) || v.length < 1 || v.length > 7 || !v.every((d) => Number.isInteger(d) && d >= 1 && d <= 7))
    throw new AppointmentFieldError('allowed_weekdays');
  return [...new Set(v as number[])].sort();
}

const SERVICE_PARSERS: { [K in keyof ServiceFields]: (b: Body) => ServiceFields[K] } = {
  name: (b) => text(b, 'name', 1, 120),
  mode: (b) => oneOf(b, 'mode', SERVICE_MODES),
  duration_minutes: (b) => int(b, 'duration_minutes', 5, 480),
  buffer_minutes: (b) => int(b, 'buffer_minutes', 0, 240),
  slot_step_minutes: (b) => optInt(b, 'slot_step_minutes', 5, 480),
  capacity: (b) => int(b, 'capacity', 1, 200),
  price_minor: (b) => {
    const v = b.price_minor;
    if (v === null) return null;
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new AppointmentFieldError('price_minor');
    return v;
  },
  currency: (b) => {
    const v = b.currency;
    if (v === null || v === '') return null;
    if (typeof v !== 'string' || !/^[A-Z]{3}$/.test(v)) throw new AppointmentFieldError('currency');
    return v;
  },
  payment_required: (b) => bool(b, 'payment_required'),
  allowed_weekdays: weekdays,
  meeting_url: (b) => {
    const v = optText(b, 'meeting_url', 2048);
    if (v && !/^https:\/\/\S+$/.test(v)) throw new AppointmentFieldError('meeting_url');
    return v;
  },
  feedback_delay_minutes: (b) => optInt(b, 'feedback_delay_minutes', 0, 10080),
  rebook_after_days: (b) => optInt(b, 'rebook_after_days', 1, 365),
};

const SERVICE_DEFAULTS: Omit<ServiceFields, 'name' | 'mode' | 'duration_minutes'> = {
  buffer_minutes: 0, slot_step_minutes: null, capacity: 1, price_minor: null, currency: null, payment_required: false,
  allowed_weekdays: null, meeting_url: null, feedback_delay_minutes: null, rebook_after_days: null,
};

/** Parse a service; on update `current` supplies unchanged fields so the cross-field rules see the result. */
export function parseService(raw: unknown, current?: ServiceFields): ServiceFields {
  const b = asBody(raw);
  const out = { ...SERVICE_DEFAULTS, ...current } as ServiceFields;
  for (const key of Object.keys(SERVICE_PARSERS) as (keyof ServiceFields)[]) {
    if (has(b, key)) (out as Record<string, unknown>)[key] = SERVICE_PARSERS[key](b);
    else if (!current && (key === 'name' || key === 'mode' || key === 'duration_minutes')) throw new AppointmentFieldError(key);
  }
  if ((out.price_minor === null) !== (out.currency === null)) throw new AppointmentFieldError(out.price_minor === null ? 'price_minor' : 'currency');
  // Payment before confirmation (Phase 8, E15) needs a price to charge (the database enforces it too).
  if (out.payment_required && !(out.price_minor !== null && out.price_minor > 0 && out.currency))
    throw new AppointmentFieldError('payment_required', 'price_required');
  if (out.mode !== 'online' && out.meeting_url) throw new AppointmentFieldError('meeting_url');
  return out;
}

export async function listServices(tx: TenantTransaction, accountId: string): Promise<ServiceRow[]> {
  return tx.$queryRawUnsafe<ServiceRow[]>(`SELECT ${SERVICE_RETURNING} FROM appointment_services WHERE account_id=$1::uuid
    ORDER BY archived_at NULLS FIRST, name, id`, accountId);
}

async function writeService(tx: TenantTransaction, accountId: string, f: ServiceFields, id?: string): Promise<ServiceRow> {
  const args = [f.name, f.mode, f.duration_minutes, f.buffer_minutes, f.slot_step_minutes, f.capacity,
    f.price_minor === null ? null : BigInt(f.price_minor), f.currency, f.payment_required, f.allowed_weekdays, f.meeting_url,
    f.feedback_delay_minutes, f.rebook_after_days];
  const rows = id
    ? await tx.$queryRawUnsafe<ServiceRow[]>(`UPDATE appointment_services SET name=$3, mode=$4, duration_minutes=$5, buffer_minutes=$6,
        slot_step_minutes=$7, capacity=$8, price_minor=$9, currency=$10, payment_required=$11, allowed_weekdays=$12::smallint[],
        meeting_url=$13, feedback_delay_minutes=$14, rebook_after_days=$15, updated_at=now()
        WHERE account_id=$1::uuid AND id=$2::uuid RETURNING ${SERVICE_RETURNING}`, accountId, id, ...args)
    : await tx.$queryRawUnsafe<ServiceRow[]>(`INSERT INTO appointment_services(name, mode, duration_minutes, buffer_minutes,
        slot_step_minutes, capacity, price_minor, currency, payment_required, allowed_weekdays, meeting_url, feedback_delay_minutes,
        rebook_after_days) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::smallint[],$11,$12,$13) RETURNING ${SERVICE_RETURNING}`, ...args);
  return rows[0];
}

/**
 * Turning on payment_required needs the storefront feature and a connected
 * Razorpay account (E15), checked when it is switched on; a service already
 * requiring payment keeps saving even if payments are later disconnected (its
 * public page then stops offering it).
 */
async function assertPaymentsReady(tx: TenantTransaction, accountId: string, fields: ServiceFields, before?: { payment_required: boolean }) {
  if (!fields.payment_required || before?.payment_required) return;
  if (!(await paidBookingReady(tx, accountId))) throw new AppointmentFieldError('payment_required', 'payments_not_ready');
}

export async function createService(tx: TenantTransaction, accountId: string, userId: string | null, raw: unknown): Promise<ServiceRow> {
  const fields = parseService(raw);
  await assertPaymentsReady(tx, accountId, fields);
  const row = await writeService(tx, accountId, fields);
  await audit(tx, accountId, userId, 'appointments.service.created', row.id);
  return row;
}

export async function updateService(tx: TenantTransaction, accountId: string, userId: string | null, id: string, raw: unknown): Promise<ServiceRow> {
  const b = asBody(raw);
  const [current] = await tx.$queryRawUnsafe<ServiceRow[]>(`SELECT ${SERVICE_RETURNING} FROM appointment_services
    WHERE account_id=$1::uuid AND id=$2::uuid FOR UPDATE`, accountId, id);
  if (!current) throw new AppointmentError('not_found');
  const rest = Object.fromEntries(Object.entries(b).filter(([k]) => k !== 'archived'));
  let row = current;
  if (Object.keys(rest).length) {
    const fields = parseService(rest, { ...current, price_minor: current.price_minor === null ? null : Number(current.price_minor) });
    await assertPaymentsReady(tx, accountId, fields, current);
    row = await writeService(tx, accountId, fields, id);
  }
  if (has(b, 'archived')) {
    const archive = bool(b, 'archived');
    [row] = await tx.$queryRawUnsafe<ServiceRow[]>(`UPDATE appointment_services SET archived_at=${archive ? 'COALESCE(archived_at, now())' : 'NULL'},
      updated_at=now() WHERE account_id=$1::uuid AND id=$2::uuid RETURNING ${SERVICE_RETURNING}`, accountId, id);
  }
  await audit(tx, accountId, userId, 'appointments.service.updated', id, { fields: Object.keys(b) });
  return row;
}

// ------------------------------------------------------------ practitioners

/** A practitioner with the Zoom host email (Phase 9; NULL: the Zoom user who authorized the connection hosts). */
export type StaffWithHost = StaffRow & { meeting_host_email: string | null };
const STAFF_RETURNING = 'id, display_name, user_id, archived_at, meeting_host_email';
const HOST_EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]+$/;

/** The Zoom host email: blank or null clears it; otherwise one address, at most 254 characters. */
function hostEmail(b: Body): string | null {
  const v = b.meeting_host_email;
  if (v === null || v === '') return null;
  if (typeof v !== 'string') throw new AppointmentFieldError('meeting_host_email');
  const email = v.trim().toLowerCase();
  if (!email) return null;
  if (email.length > 254 || !HOST_EMAIL.test(email)) throw new AppointmentFieldError('meeting_host_email');
  return email;
}

/**
 * Practitioners, archived last. The Zoom host email (a staff member's Zoom login)
 * is only selected for agents and above: pass withHost=false for viewers, who
 * read nothing new in Phase 9. The column is not even read in that case.
 */
export async function listStaff(tx: TenantTransaction, accountId: string, opts: { withHost?: boolean } = {}): Promise<(StaffRow | StaffWithHost)[]> {
  const cols = opts.withHost === false ? 'id, display_name, user_id, archived_at' : STAFF_RETURNING;
  return tx.$queryRawUnsafe<StaffWithHost[]>(`SELECT ${cols} FROM appointment_staff
    WHERE account_id=$1::uuid ORDER BY archived_at NULLS FIRST, display_name, id`, accountId);
}

const countActiveStaff = (tx: TenantTransaction, accountId: string) => async () => {
  const [row] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM appointment_staff
    WHERE account_id=${accountId}::uuid AND archived_at IS NULL`;
  return row?.n ?? 0;
};

export async function createStaff(tx: TenantTransaction, accountId: string, userId: string | null, raw: unknown): Promise<StaffWithHost> {
  const b = asBody(raw);
  const displayName = text(b, 'display_name', 1, 80);
  const linked = has(b, 'user_id') ? optUuid(b, 'user_id') : null;
  const host = has(b, 'meeting_host_email') ? hostEmail(b) : null;
  await gateLimit(tx, accountId, 'appointment_staff', countActiveStaff(tx, accountId));
  const [row] = await tx.$queryRawUnsafe<StaffWithHost[]>(`INSERT INTO appointment_staff(display_name,user_id,meeting_host_email)
    VALUES($1,$2::uuid,$3) RETURNING ${STAFF_RETURNING}`, displayName, linked, host).catch((e) => mapDbError(e, 'user_id'));
  await audit(tx, accountId, userId, 'appointments.staff.created', row.id);
  return row;
}

export async function updateStaff(tx: TenantTransaction, accountId: string, userId: string | null, id: string, raw: unknown): Promise<StaffWithHost> {
  const b = asBody(raw);
  const displayName = has(b, 'display_name') ? text(b, 'display_name', 1, 80) : null;
  const linked = has(b, 'user_id') ? optUuid(b, 'user_id') : undefined;
  const host = has(b, 'meeting_host_email') ? hostEmail(b) : undefined;
  const archive = has(b, 'archived') ? bool(b, 'archived') : undefined;
  const [current] = await tx.$queryRaw<StaffRow[]>`SELECT id, display_name, user_id, archived_at FROM appointment_staff
    WHERE account_id=${accountId}::uuid AND id=${id}::uuid FOR UPDATE`;
  if (!current) throw new AppointmentError('not_found');
  // Restoring a practitioner takes a seat again.
  if (archive === false && current.archived_at) await gateLimit(tx, accountId, 'appointment_staff', countActiveStaff(tx, accountId));
  const [row] = await tx.$queryRaw<StaffWithHost[]>`UPDATE appointment_staff SET
      display_name=COALESCE(${displayName},display_name),
      user_id=CASE WHEN ${linked === undefined} THEN user_id ELSE ${linked ?? null}::uuid END,
      archived_at=CASE WHEN ${archive === undefined} THEN archived_at WHEN ${archive === true} THEN COALESCE(archived_at, now()) ELSE NULL END,
      meeting_host_email=CASE WHEN ${host === undefined} THEN meeting_host_email ELSE ${host ?? null}::text END,
      updated_at=now()
    WHERE account_id=${accountId}::uuid AND id=${id}::uuid
    RETURNING id, display_name, user_id, archived_at, meeting_host_email`.catch((e) => mapDbError(e, 'user_id'));
  await audit(tx, accountId, userId, 'appointments.staff.updated', id, { fields: Object.keys(b) });
  return row;
}

// ------------------------------------------------------------ offerings

export async function listOfferings(tx: TenantTransaction, accountId: string): Promise<OfferingRow[]> {
  return tx.$queryRaw<OfferingRow[]>`SELECT id, service_id, staff_id, location_id FROM appointment_offerings
    WHERE account_id=${accountId}::uuid ORDER BY service_id, location_id, staff_id NULLS FIRST`;
}

/**
 * Replace who offers a service at a location: a shared pool (pooled=true) or
 * the listed practitioners. Pooled xor staffed is guaranteed because the
 * whole set is replaced under the (service, location) configuration lock.
 */
export async function setOfferings(tx: TenantTransaction, accountId: string, userId: string | null, raw: unknown): Promise<OfferingRow[]> {
  const b = asBody(raw);
  const serviceId = uuid(b, 'service_id'), locationId = uuid(b, 'location_id');
  const pooled = bool(b, 'pooled');
  const staffIds = pooled ? [] : (() => {
    const v = b.staff_ids;
    if (!Array.isArray(v) || v.length > 50 || !v.every(isUuid)) throw new AppointmentFieldError('staff_ids');
    return [...new Set(v as string[])];
  })();
  if (pooled && Array.isArray(b.staff_ids) && b.staff_ids.length) throw new AppointmentFieldError('staff_ids', 'pooled_or_staffed');
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKeys.config(accountId, serviceId, locationId)}, 0))`;
  const [svc] = await tx.$queryRaw<{ ok: boolean }[]>`SELECT
    EXISTS(SELECT 1 FROM appointment_services WHERE account_id=${accountId}::uuid AND id=${serviceId}::uuid) AND
    EXISTS(SELECT 1 FROM appointment_locations WHERE account_id=${accountId}::uuid AND id=${locationId}::uuid) AS ok`;
  if (!svc?.ok) throw new AppointmentError('not_found');
  // Pool bookings (staff_id NULL) and staffed bookings never see each other's
  // busy rows, so the shape may only switch once the other shape's active
  // future bookings are gone. Checked by bookings, not by the old offering
  // rows, so clearing the offerings first does not get around it.
  const [inUse] = await tx.$queryRaw<{ busy: boolean }[]>`SELECT EXISTS(SELECT 1 FROM appointments
      WHERE account_id=${accountId}::uuid AND service_id=${serviceId}::uuid AND location_id=${locationId}::uuid
        AND (CASE WHEN ${pooled}::boolean THEN staff_id IS NOT NULL ELSE staff_id IS NULL END)
        AND end_at > now() AND (status='confirmed' OR (status='held' AND hold_expires_at > now()))) AS busy`;
  if (inUse?.busy) throw new AppointmentFieldError('pooled', 'mode_in_use');
  if (staffIds.length) {
    const [found] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM appointment_staff
      WHERE account_id=${accountId}::uuid AND id = ANY(${staffIds}::uuid[]) AND archived_at IS NULL`;
    if ((found?.n ?? 0) !== staffIds.length) throw new AppointmentFieldError('staff_ids');
  }
  await tx.$executeRaw`DELETE FROM appointment_offerings WHERE account_id=${accountId}::uuid
    AND service_id=${serviceId}::uuid AND location_id=${locationId}::uuid`;
  if (pooled) await tx.$executeRaw`INSERT INTO appointment_offerings(service_id,staff_id,location_id) VALUES(${serviceId}::uuid,NULL,${locationId}::uuid)`;
  for (const staffId of staffIds)
    await tx.$executeRaw`INSERT INTO appointment_offerings(service_id,staff_id,location_id) VALUES(${serviceId}::uuid,${staffId}::uuid,${locationId}::uuid)`;
  await audit(tx, accountId, userId, 'appointments.offerings.updated', serviceId, { location_id: locationId, pooled, staff: staffIds.length });
  return tx.$queryRaw<OfferingRow[]>`SELECT id, service_id, staff_id, location_id FROM appointment_offerings
    WHERE account_id=${accountId}::uuid AND service_id=${serviceId}::uuid AND location_id=${locationId}::uuid ORDER BY staff_id NULLS FIRST`;
}

// ------------------------------------------------------------ weekly hours

export interface HoursRow { id: string; staff_id: string | null; location_id: string; hours: WorkingHours }

export async function listHours(tx: TenantTransaction, accountId: string): Promise<HoursRow[]> {
  return tx.$queryRaw<HoursRow[]>`SELECT id, staff_id, location_id, hours FROM appointment_hours
    WHERE account_id=${accountId}::uuid ORDER BY location_id, staff_id NULLS FIRST`;
}

/** Set (or with hours=null, clear) the weekly hours of a practitioner, or the pool, at a location. */
export async function setHours(tx: TenantTransaction, accountId: string, userId: string | null, raw: unknown): Promise<HoursRow | null> {
  const b = asBody(raw);
  const staffId = has(b, 'staff_id') ? optUuid(b, 'staff_id') : null;
  const locationId = uuid(b, 'location_id');
  const hours = b.hours === null ? null : parseWorkingHours(b.hours);
  if (b.hours !== null && !hours) throw new AppointmentFieldError('hours');
  await tx.$executeRaw`DELETE FROM appointment_hours WHERE account_id=${accountId}::uuid AND location_id=${locationId}::uuid
    AND staff_id IS NOT DISTINCT FROM ${staffId}::uuid`;
  let row: HoursRow | null = null;
  if (hours) {
    [row] = await tx.$queryRaw<HoursRow[]>`INSERT INTO appointment_hours(staff_id,location_id,hours)
      VALUES(${staffId}::uuid,${locationId}::uuid,${JSON.stringify(hours)}::jsonb) RETURNING id, staff_id, location_id, hours`
      .catch((e) => mapDbError(e, 'location_id'));
  }
  await audit(tx, accountId, userId, 'appointments.hours.updated', locationId, { staff_id: staffId, cleared: !hours });
  return row;
}

// ------------------------------------------------------------ exceptions

export function parseRanges(value: unknown): TimeRange[] | null {
  if (value === null) return null;
  const parsed = parseWorkingHours({ mon: value });
  if (!parsed || !parsed.mon?.length) throw new AppointmentFieldError('ranges');
  return parsed.mon;
}

export async function listExceptions(
  tx: TenantTransaction, accountId: string, filter: { locationId?: string; from?: string; to?: string } = {},
): Promise<ExceptionRow[]> {
  const from = isCalendarDate(filter.from) ? filter.from : '0001-01-01';
  const to = isCalendarDate(filter.to) ? filter.to : '9999-12-31';
  const location = filter.locationId && UUID.test(filter.locationId) ? filter.locationId : null;
  return tx.$queryRaw<ExceptionRow[]>`SELECT id, staff_id, location_id, starts_on::text AS starts_on, ends_on::text AS ends_on, ranges, reason
    FROM appointment_exceptions WHERE account_id=${accountId}::uuid
      AND (${location}::uuid IS NULL OR location_id=${location}::uuid) AND starts_on <= ${to}::date AND ends_on >= ${from}::date
    ORDER BY starts_on, location_id, staff_id NULLS FIRST`;
}

export async function createException(tx: TenantTransaction, accountId: string, userId: string | null, raw: unknown): Promise<ExceptionRow> {
  const b = asBody(raw);
  const locationId = uuid(b, 'location_id');
  const staffId = has(b, 'staff_id') ? optUuid(b, 'staff_id') : null;
  const startsOn = b.starts_on, endsOn = b.ends_on;
  if (!isCalendarDate(startsOn)) throw new AppointmentFieldError('starts_on');
  if (!isCalendarDate(endsOn) || endsOn < startsOn
    || Date.parse(endsOn) - Date.parse(startsOn) > 366 * 86_400_000) throw new AppointmentFieldError('ends_on');
  const ranges = has(b, 'ranges') ? parseRanges(b.ranges) : null;
  const reason = has(b, 'reason') ? optText(b, 'reason', 120) : null;
  const [row] = await tx.$queryRaw<ExceptionRow[]>`INSERT INTO appointment_exceptions(staff_id,location_id,starts_on,ends_on,ranges,reason)
    VALUES(${staffId}::uuid,${locationId}::uuid,${startsOn}::date,${endsOn}::date,${ranges ? JSON.stringify(ranges) : null}::jsonb,${reason})
    RETURNING id, staff_id, location_id, starts_on::text AS starts_on, ends_on::text AS ends_on, ranges, reason`
    .catch((e) => mapDbError(e, 'location_id'));
  await audit(tx, accountId, userId, 'appointments.exception.created', row.id);
  return row;
}

export async function deleteException(tx: TenantTransaction, accountId: string, userId: string | null, id: string): Promise<void> {
  const removed = await tx.$executeRaw`DELETE FROM appointment_exceptions WHERE account_id=${accountId}::uuid AND id=${id}::uuid`;
  if (!removed) throw new AppointmentError('not_found');
  await audit(tx, accountId, userId, 'appointments.exception.deleted', id);
}

// ------------------------------------------------------------ booking pages

export interface BookingPageRow {
  id: string;
  slug: string;
  title: string;
  active: boolean;
  location_id: string | null;
  whatsapp_config_id: string | null;
  service_ids: string[];
}

// Path segments under /api/public/booking/ that a page slug must not shadow.
const RESERVED_SLUGS = new Set(['manage']);

const PAGE_SELECT = `SELECT p.id, p.slug, p.title, p.active, p.location_id, p.whatsapp_config_id,
  COALESCE((SELECT array_agg(s.service_id::text ORDER BY s.service_id) FROM booking_page_services s
    WHERE s.account_id=p.account_id AND s.page_id=p.id), '{}') AS service_ids
  FROM booking_pages p`;

export async function listBookingPages(tx: TenantTransaction, accountId: string): Promise<BookingPageRow[]> {
  return tx.$queryRawUnsafe<BookingPageRow[]>(`${PAGE_SELECT} WHERE p.account_id=$1::uuid ORDER BY p.created_at, p.id`, accountId);
}

async function getPage(tx: TenantTransaction, accountId: string, id: string): Promise<BookingPageRow | null> {
  const [row] = await tx.$queryRawUnsafe<BookingPageRow[]>(`${PAGE_SELECT} WHERE p.account_id=$1::uuid AND p.id=$2::uuid`, accountId, id);
  return row ?? null;
}

function pageServices(b: Body): string[] {
  const v = b.service_ids;
  if (!Array.isArray(v) || v.length < 1 || v.length > 50 || !v.every(isUuid)) throw new AppointmentFieldError('service_ids');
  return [...new Set(v as string[])];
}

async function replacePageServices(tx: TenantTransaction, accountId: string, pageId: string, serviceIds: string[]) {
  await tx.$executeRaw`DELETE FROM booking_page_services WHERE account_id=${accountId}::uuid AND page_id=${pageId}::uuid`;
  for (const serviceId of serviceIds)
    await tx.$executeRaw`INSERT INTO booking_page_services(page_id,service_id) VALUES(${pageId}::uuid,${serviceId}::uuid)`
      .catch((e) => mapDbError(e, 'service_ids'));
}

export async function createBookingPage(tx: TenantTransaction, accountId: string, userId: string | null, raw: unknown): Promise<BookingPageRow> {
  const b = asBody(raw);
  const slug = typeof b.slug === 'string' ? b.slug.trim().toLowerCase() : '';
  if (!SLUG.test(slug) || RESERVED_SLUGS.has(slug)) throw new AppointmentFieldError('slug');
  const title = text(b, 'title', 1, 120);
  const locationId = has(b, 'location_id') ? optUuid(b, 'location_id') : null;
  const numberId = has(b, 'whatsapp_config_id') ? optUuid(b, 'whatsapp_config_id') : null;
  const active = has(b, 'active') ? bool(b, 'active') : true;
  const serviceIds = pageServices(b);
  const [row] = await tx.$queryRaw<{ id: string }[]>`INSERT INTO booking_pages(slug,title,active,location_id,whatsapp_config_id)
    VALUES(${slug},${title},${active},${locationId}::uuid,${numberId}::uuid) RETURNING id`
    .catch((e) => mapDbError(e, /slug/i.test(String((e as Error)?.message)) ? 'slug' : 'whatsapp_config_id'));
  await replacePageServices(tx, accountId, row.id, serviceIds);
  await audit(tx, accountId, userId, 'appointments.booking_page.created', row.id);
  return (await getPage(tx, accountId, row.id)) as BookingPageRow;
}

export async function updateBookingPage(tx: TenantTransaction, accountId: string, userId: string | null, id: string, raw: unknown): Promise<BookingPageRow> {
  const b = asBody(raw);
  const current = await getPage(tx, accountId, id);
  if (!current) throw new AppointmentError('not_found');
  const slug = has(b, 'slug') ? (typeof b.slug === 'string' ? b.slug.trim().toLowerCase() : '') : current.slug;
  if (!SLUG.test(slug) || RESERVED_SLUGS.has(slug)) throw new AppointmentFieldError('slug');
  const title = has(b, 'title') ? text(b, 'title', 1, 120) : current.title;
  const locationId = has(b, 'location_id') ? optUuid(b, 'location_id') : current.location_id;
  const numberId = has(b, 'whatsapp_config_id') ? optUuid(b, 'whatsapp_config_id') : current.whatsapp_config_id;
  const active = has(b, 'active') ? bool(b, 'active') : current.active;
  await tx.$executeRaw`UPDATE booking_pages SET slug=${slug}, title=${title}, active=${active}, location_id=${locationId}::uuid,
      whatsapp_config_id=${numberId}::uuid, updated_at=now()
    WHERE account_id=${accountId}::uuid AND id=${id}::uuid`
    .catch((e) => mapDbError(e, /slug/i.test(String((e as Error)?.message)) ? 'slug' : 'whatsapp_config_id'));
  if (has(b, 'service_ids')) await replacePageServices(tx, accountId, id, pageServices(b));
  await audit(tx, accountId, userId, 'appointments.booking_page.updated', id, { fields: Object.keys(b) });
  return (await getPage(tx, accountId, id)) as BookingPageRow;
}

export async function deleteBookingPage(tx: TenantTransaction, accountId: string, userId: string | null, id: string): Promise<void> {
  const removed = await tx.$executeRaw`DELETE FROM booking_pages WHERE account_id=${accountId}::uuid AND id=${id}::uuid`;
  if (!removed) throw new AppointmentError('not_found');
  await audit(tx, accountId, userId, 'appointments.booking_page.deleted', id);
}
