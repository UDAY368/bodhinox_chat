/**
 * Atomic booking and lifecycle (design section 4).
 *
 * Every function runs inside the caller's withTenant transaction (READ
 * COMMITTED). Staff calls use the app client (role >= agent); public, inbound,
 * flow and job calls use the worker client with role 'owner'.
 *
 * No overbooking: transaction advisory locks, taken in one sorted order
 * (lockOrder), then a recount of the busy rows after the lock. Each statement
 * after the lock sees every row the previous holder committed, so two
 * bookings for the same practitioner, pool or contact are serialised. No code
 * path takes a row lock before an advisory lock, so nothing deadlocks.
 *
 * Refusals are code-only AppointmentErrors. Customer messages and side
 * effects are durable jobs inserted in the same transaction (schedule-jobs).
 */
import { randomInt, randomUUID } from 'node:crypto';
import { getEntitlements, requireFeature } from '@/lib/billing/entitlements';
import { requireSendingAllowed } from '@/lib/billing/suspension';
import type { TenantTransaction } from '@/lib/db/tenant';
import {
  computeSlots, loadAvailabilityConfig, loadBusy, loadSettings, MAX_CANDIDATE_STAFF,
  type AvailabilityConfig, type BusyRow,
} from './availability';
import { lockKeys, lockOrder } from './keys';
import { enqueueEvent, enqueueFollowup, enqueueHoldExpiry, enqueueNotice, scheduleReminders } from './schedule-jobs';
import { enqueueMeetingSync } from '@/lib/meetings/sync';
import { localParts } from './time';
import { deriveManageToken, manageTokenHash } from './tokens';
import {
  APPOINTMENT_PAYMENT_LINK_JOB, AppointmentError, type AppointmentActor, type AppointmentEventKind, type AppointmentRow,
  type AppointmentSource, type BookingIntake, type CancelReason,
} from './types';

const MINUTE = 60_000;
/** Upcoming confirmed appointments one contact may hold for one service (staff and flow). */
export const MAX_UPCOMING_PER_CONTACT_SERVICE = 3;
/** Unconfirmed public holds one client (hashed IP) may keep on one page at a time. */
export const MAX_ACTIVE_HOLDS_PER_CLIENT = 3;
const HOLD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CLIENT_HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const APPOINTMENT_COLUMNS = `id, contact_id, service_id, staff_id, location_id, start_at, end_at, timezone, local_date::text AS local_date,
  status, version, source, source_ref, booking_page_id, hold_expires_at, hold_code, confirmed_at, price_minor, currency,
  meeting_url, service_name, token_epoch, cancel_reason, outcome_note, feedback_score, payment_status, created_by, created_at, updated_at`;

export async function getAppointment(tx: TenantTransaction, accountId: string, id: string, forUpdate = false): Promise<AppointmentRow | null> {
  if (!UUID.test(id)) return null;
  const [row] = await tx.$queryRawUnsafe<AppointmentRow[]>(
    `SELECT ${APPOINTMENT_COLUMNS} FROM appointments WHERE account_id=$1::uuid AND id=$2::uuid${forUpdate ? ' FOR UPDATE' : ''}`,
    accountId, id);
  return row ?? null;
}

async function bySourceRef(tx: TenantTransaction, accountId: string, sourceRef: string): Promise<AppointmentRow | null> {
  const [row] = await tx.$queryRawUnsafe<AppointmentRow[]>(
    `SELECT ${APPOINTMENT_COLUMNS} FROM appointments WHERE account_id=$1::uuid AND source_ref=$2`, accountId, sourceRef);
  return row ?? null;
}

/** Take the advisory locks in the one global order. */
export async function takeLocks(tx: TenantTransaction, keys: Iterable<string>): Promise<void> {
  for (const key of lockOrder(keys)) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

function slotKeys(accountId: string, config: AvailabilityConfig, staffIds: string[]): string[] {
  return config.pooled
    ? [lockKeys.pool(accountId, config.service.id, config.location.id)]
    : staffIds.map((id) => lockKeys.staff(accountId, id));
}

/**
 * Serialises public holds on one booking page, so the per-page and per-client
 * hold caps are counted and inserted as one step (holds for different
 * practitioners or pools otherwise run in parallel under different slot locks).
 */
export const pageLockKey = (accountId: string, pageId: string) => `appt:${accountId}:page:${pageId}`;

/**
 * Take `keys` plus the (service, location) configuration lock in the one
 * sorted order, then re-read the configuration. setOfferings changes the
 * pooled/staffed shape under that lock; a shape read before it would pick slot
 * locks that do not serialise against bookings made under the new shape, so a
 * change in between refuses with slot_unavailable. Returns the fresh
 * configuration and those of `staffIds` still offered.
 */
async function lockWithConfig(
  tx: TenantTransaction, accountId: string, config: AvailabilityConfig, keys: string[], staffIds: string[],
): Promise<{ config: AvailabilityConfig; staffIds: string[] }> {
  await takeLocks(tx, [...keys, lockKeys.config(accountId, config.service.id, config.location.id)]);
  const fresh = await loadAvailabilityConfig(tx, accountId, config.service.id, config.location.id);
  if (fresh.pooled !== config.pooled) throw new AppointmentError('slot_unavailable');
  const still = staffIds.filter((id) => fresh.staff.some((s) => s.id === id));
  if (!fresh.pooled && !still.length) throw new AppointmentError('slot_unavailable');
  return { config: fresh, staffIds: still };
}

async function insertEvent(
  tx: TenantTransaction,
  e: { appointmentId: string; version: number; kind: AppointmentEventKind; actor: AppointmentActor; actorUserId?: string | null;
    oldStartAt?: Date | null; newStartAt?: Date | null; detail?: string | null },
) {
  await tx.$executeRaw`INSERT INTO appointment_events(appointment_id,version,kind,old_start_at,new_start_at,actor,actor_user_id,detail)
    VALUES(${e.appointmentId}::uuid,${e.version},${e.kind},${e.oldStartAt ?? null},${e.newStartAt ?? null},${e.actor},
      ${e.actorUserId ?? null}::uuid,${e.detail ?? null})`;
}

/** Active appointments of a contact overlapping [start, end), other than `excludeId`. */
async function contactConflict(tx: TenantTransaction, accountId: string, contactId: string, start: Date, end: Date, now: Date, excludeId?: string) {
  const [row] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM appointments
    WHERE account_id=${accountId}::uuid AND contact_id=${contactId}::uuid AND id <> ${excludeId ?? '00000000-0000-0000-0000-000000000000'}::uuid
      AND (status='confirmed' OR (status='held' AND hold_expires_at > ${now}))
      AND start_at < ${end} AND end_at > ${start}`;
  return (row?.n ?? 0) > 0;
}

/**
 * Re-run availability for the requested start's local day, after the locks.
 * Returns the practitioners free at that start (empty for a pool) or throws
 * day_not_allowed / slot_unavailable.
 */
async function recheckSlot(
  tx: TenantTransaction,
  accountId: string,
  config: AvailabilityConfig,
  input: { startAt: Date; staffIds: string[]; now: Date; excludeAppointmentId?: string; ignoreNotice?: boolean },
): Promise<{ freeStaff: string[]; busy: BusyRow[]; localDate: string }> {
  const localDate = localParts(input.startAt, config.location.timezone).date;
  const allowed = config.service.allowed_weekdays;
  if (allowed?.length) {
    const { isoWeekday } = localParts(input.startAt, config.location.timezone);
    if (!allowed.includes(isoWeekday)) throw new AppointmentError('day_not_allowed');
  }
  const window = { fromDay: localDate, days: 1 };
  const busy = await loadBusy(tx, accountId, config.pooled
    ? { pool: { serviceId: config.service.id, locationId: config.location.id } }
    : { staffIds: input.staffIds }, window, input.now);
  const offerings = config.pooled ? config.offerings : config.offerings.filter((o) => o.staff_id && input.staffIds.includes(o.staff_id));
  const slots = computeSlots({
    timezone: config.location.timezone, locationId: config.location.id, service: config.service, offerings, hoursByKey: config.hoursByKey,
    exceptions: config.exceptions, busy, settings: config.settings, fromDay: localDate, days: 1, now: input.now,
    excludeAppointmentId: input.excludeAppointmentId, ignoreNotice: input.ignoreNotice,
  });
  const slot = slots.find((s) => Date.parse(s.startAt) === input.startAt.getTime());
  if (!slot) throw new AppointmentError('slot_unavailable');
  return { freeStaff: slot.staffIds, busy, localDate };
}

/** "Any practitioner": the least-loaded on that local day, ties by id. */
function leastLoaded(freeStaff: string[], busy: BusyRow[], localDate: string, timezone: string): string {
  const load = (id: string) => busy.filter((b) => b.staff_id === id && localParts(b.start_at, timezone).date === localDate).length;
  return [...freeStaff].sort((a, b) => load(a) - load(b) || a.localeCompare(b))[0];
}

async function newHoldCode(tx: TenantTransaction, accountId: string): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = Array.from({ length: 6 }, () => HOLD_ALPHABET[randomInt(HOLD_ALPHABET.length)]).join('');
    // Avoid codes still held, or expired within the last day (a late BOOK message may still name them).
    const [row] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM appointments
      WHERE account_id=${accountId}::uuid AND hold_code=${code}
        AND (status='held' OR (status='expired' AND updated_at > now() - interval '1 day'))`;
    if (!row?.n) return code;
  }
  throw new AppointmentError('too_many');
}

// ------------------------------------------------------------ paid holds (Phase 8, design E15)

/** A paid hold stays at least this long after its BOOK code, so the link (Razorpay minimum 15 minutes) fits. */
export const PAID_HOLD_MIN_MINUTES = 20;

/** appointments.payment_link job dedupe key: one link per hold version. */
export const paymentLinkJobKey = (appointmentId: string, version: number) => `appt-link:${appointmentId}:${version}`;

/**
 * Whether this workspace can take payment for a booking online: the
 * storefront feature is on and Razorpay is connected. Paid services are
 * offered publicly (and may be configured) only then.
 */
export async function paidBookingReady(tx: TenantTransaction, accountId: string): Promise<boolean> {
  const { features } = await getEntitlements(tx, accountId);
  if (!features.storefront) return false;
  const [row] = await tx.$queryRaw<{ ok: boolean }[]>`SELECT EXISTS(SELECT 1 FROM payment_providers
    WHERE account_id=${accountId}::uuid AND provider='razorpay') AS ok`;
  return Boolean(row?.ok);
}

/** How long a paid hold lasts after BOOK: the store's reservation time, at least PAID_HOLD_MIN_MINUTES. */
async function paidHoldMinutes(tx: TenantTransaction, accountId: string): Promise<number> {
  const [row] = await tx.$queryRaw<{ minutes: number }[]>`SELECT reservation_minutes AS minutes FROM commerce_settings
    WHERE account_id=${accountId}::uuid`;
  return Math.max(row?.minutes ?? 15, PAID_HOLD_MIN_MINUTES);
}

/** Queue the payment-link job for this hold version (worker-run after commit). */
async function enqueuePaymentLink(tx: TenantTransaction, accountId: string, appointmentId: string, version: number): Promise<void> {
  await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key)
    VALUES(${APPOINTMENT_PAYMENT_LINK_JOB},${accountId}::uuid,${JSON.stringify({ appointmentId, version })}::jsonb,
      ${paymentLinkJobKey(appointmentId, version)})
    ON CONFLICT(dedupe_key) DO NOTHING`;
}

/** Cancel this appointment's unpaid links at Razorpay (the existing payments.cancel_link job). */
async function enqueueLinkCancels(tx: TenantTransaction, accountId: string, appointmentId: string): Promise<void> {
  await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key)
    SELECT 'payments.cancel_link', l.account_id, jsonb_build_object('linkId', l.id::text), 'payment-link-cancel:' || l.id::text
    FROM payment_links l WHERE l.account_id=${accountId}::uuid AND l.appointment_id=${appointmentId}::uuid AND l.status='created'
    ON CONFLICT(dedupe_key) DO NOTHING`;
}

// ------------------------------------------------------------ book

export interface BookInput {
  accountId: string;
  source: AppointmentSource;
  serviceId: string;
  locationId: string;
  /** A specific practitioner; omitted = any (or the pool). */
  staffId?: string | null;
  startAt: Date;
  /** Required for staff and flow bookings; never set for public holds (design D7). */
  contactId?: string | null;
  /** Idempotency: keys.sourceRefs.flow / .public. */
  sourceRef?: string | null;
  /** Public holds only. */
  bookingPageId?: string | null;
  /** Public holds only: keyed hash of the client IP (public.ts holdClientHash), for the per-client hold cap. */
  clientHash?: string | null;
  intake?: BookingIntake | null;
  /** Staff member who booked (audit identity). */
  actorUserId?: string | null;
  now?: Date;
}

export interface BookResult {
  appointment: AppointmentRow;
  /** True when sourceRef matched an existing booking and nothing changed. */
  replayed: boolean;
}

function cleanIntake(intake: BookingIntake | null | undefined): BookingIntake | null {
  if (!intake) return null;
  const out: BookingIntake = {};
  for (const key of ['name', 'city', 'state'] as const) {
    const value = intake[key];
    if (typeof value === 'string' && value.trim()) out[key] = value.trim().slice(0, key === 'name' ? 120 : 80);
  }
  return Object.keys(out).length ? out : null;
}

export async function bookAppointment(tx: TenantTransaction, input: BookInput): Promise<BookResult> {
  const { accountId, source } = input;
  const now = input.now ?? new Date();
  if (!UUID.test(input.serviceId) || !UUID.test(input.locationId) || (input.staffId && !UUID.test(input.staffId))
    || Number.isNaN(input.startAt.getTime())) throw new AppointmentError('invalid');
  if (source === 'public' ? (input.contactId || !input.bookingPageId || !input.sourceRef) : (!input.contactId || input.clientHash))
    throw new AppointmentError('invalid');
  if (input.clientHash && !CLIENT_HASH.test(input.clientHash)) throw new AppointmentError('invalid');

  // 1. Validate what does not need the locks.
  await requireFeature(tx, accountId, 'appointments');
  if (source !== 'staff') await requireSendingAllowed(tx, accountId);
  if (input.sourceRef) {
    const existing = await bySourceRef(tx, accountId, input.sourceRef);
    if (existing) return { appointment: existing, replayed: true };
  }
  const configBefore = await loadAvailabilityConfig(tx, accountId, input.serviceId, input.locationId);
  // Paid services (E15): staff bookings are allowed (nothing collected online);
  // public holds wait for a verified payment; flow bookings still refuse.
  const assertPayable = async (paid: boolean) => {
    if (!paid) return;
    if (source === 'flow') throw new AppointmentError('not_yet_supported');
    if (source === 'public' && !(await paidBookingReady(tx, accountId))) throw new AppointmentError('not_yet_supported');
  };
  await assertPayable(configBefore.service.payment_required);
  if (!configBefore.offerings.length) throw new AppointmentError('slot_unavailable');
  if (source === 'public') {
    const [page] = await tx.$queryRaw<{ location_id: string | null; has_service: boolean }[]>`
      SELECT p.location_id, EXISTS(SELECT 1 FROM booking_page_services s WHERE s.account_id=p.account_id AND s.page_id=p.id
        AND s.service_id=${input.serviceId}::uuid) AS has_service
      FROM booking_pages p WHERE p.account_id=${accountId}::uuid AND p.id=${input.bookingPageId}::uuid AND p.active`;
    if (!page || !page.has_service || (page.location_id && page.location_id !== input.locationId)) throw new AppointmentError('not_found');
  }
  let candidates: string[] = [];
  if (!configBefore.pooled) {
    candidates = configBefore.staff.map((s) => s.id);
    if (input.staffId) {
      if (!candidates.includes(input.staffId)) throw new AppointmentError('slot_unavailable');
      candidates = [input.staffId];
    }
    if (!candidates.length) throw new AppointmentError('slot_unavailable');
    if (candidates.length > MAX_CANDIDATE_STAFF) candidates = candidates.slice(0, MAX_CANDIDATE_STAFF);
  } else if (input.staffId) throw new AppointmentError('slot_unavailable');

  // 2. Locks, sorted: practitioners (or the pool), the contact, the page (public)
  //    and the offering configuration, which is re-read under its lock.
  const keys = slotKeys(accountId, configBefore, candidates);
  if (input.contactId) keys.push(lockKeys.contact(accountId, input.contactId));
  if (source === 'public') keys.push(pageLockKey(accountId, input.bookingPageId as string));
  const locked = await lockWithConfig(tx, accountId, configBefore, keys, candidates);
  const config = locked.config;
  candidates = locked.staffIds;
  if (config.service.payment_required !== configBefore.service.payment_required) await assertPayable(config.service.payment_required);
  const paidHold = source === 'public' && config.service.payment_required;

  // 3. Idempotency again: a concurrent replay may have committed while we waited.
  if (input.sourceRef) {
    const existing = await bySourceRef(tx, accountId, input.sourceRef);
    if (existing) return { appointment: existing, replayed: true };
  }

  // 4. Recount after the locks.
  const { freeStaff, busy, localDate } = await recheckSlot(tx, accountId, config, { startAt: input.startAt, staffIds: candidates, now });
  const staffId = config.pooled ? null : leastLoaded(freeStaff, busy, localDate, config.location.timezone);
  const startAt = input.startAt;
  const endAt = new Date(startAt.getTime() + config.service.duration_minutes * MINUTE);

  // 5. Customer conflict (APT-01).
  if (input.contactId && await contactConflict(tx, accountId, input.contactId, startAt, endAt, now))
    throw new AppointmentError('customer_conflict');

  // 6. Domain caps (public: counted under the page lock). One client may keep
  //    only a few holds, so nobody fills the page; the page cap is the ceiling.
  if (source === 'public') {
    const [row] = await tx.$queryRaw<{ n: number; mine: number }[]>`SELECT count(*)::int AS n,
        count(*) FILTER (WHERE hold_client_hash = ${input.clientHash ?? null})::int AS mine FROM appointments
      WHERE account_id=${accountId}::uuid AND booking_page_id=${input.bookingPageId}::uuid AND status='held' AND hold_expires_at > ${now}`;
    if (input.clientHash && (row?.mine ?? 0) >= MAX_ACTIVE_HOLDS_PER_CLIENT) throw new AppointmentError('too_many');
    if ((row?.n ?? 0) >= config.settings.max_active_holds_per_page) {
      // Ids only: an operator signal that a page is full of unconfirmed holds.
      console.warn('[booking] page hold cap reached', { accountId, pageId: input.bookingPageId });
      throw new AppointmentError('too_many');
    }
  } else {
    const [row] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM appointments
      WHERE account_id=${accountId}::uuid AND contact_id=${input.contactId}::uuid AND service_id=${input.serviceId}::uuid
        AND status='confirmed' AND start_at > ${now}`;
    if ((row?.n ?? 0) >= MAX_UPCOMING_PER_CONTACT_SERVICE) throw new AppointmentError('too_many');
  }

  // 7. Insert.
  const id = randomUUID();
  const held = source === 'public';
  const holdExpiresAt = held ? new Date(now.getTime() + config.settings.hold_minutes * MINUTE) : null;
  const holdCode = held ? await newHoldCode(tx, accountId) : null;
  const tokenHash = held ? null : manageTokenHash(deriveManageToken(id, 1));
  const intake = held ? cleanIntake(input.intake) : null;
  const s = config.service;
  const [appointment] = await tx.$queryRawUnsafe<AppointmentRow[]>(
    `INSERT INTO appointments(id,contact_id,service_id,staff_id,location_id,start_at,end_at,timezone,status,source,source_ref,
       booking_page_id,hold_expires_at,hold_code,intake,confirmed_at,price_minor,currency,meeting_url,service_name,manage_token_hash,created_by,
       hold_client_hash,payment_status)
     VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8,$9,$10,$11,$12::uuid,$13,$14,$15::jsonb,$16,$17,$18,$19,$20,$21,$22::uuid,$23,$24)
     RETURNING ${APPOINTMENT_COLUMNS}`,
    id, input.contactId ?? null, s.id, staffId, config.location.id, startAt, endAt, config.location.timezone,
    held ? 'held' : 'confirmed', source, input.sourceRef ?? null, input.bookingPageId ?? null, holdExpiresAt, holdCode,
    intake ? JSON.stringify(intake) : null, held ? null : now, s.price_minor ?? null, s.currency ?? null,
    s.mode === 'online' ? s.meeting_url : null, s.name, tokenHash, input.actorUserId ?? null, held ? input.clientHash ?? null : null,
    paidHold ? 'pending' : 'none');

  // 8. History and durable jobs in the same transaction.
  const actor: AppointmentActor = source === 'staff' ? 'staff' : 'customer';
  await insertEvent(tx, { appointmentId: id, version: 1, kind: held ? 'held' : 'confirmed', actor,
    actorUserId: input.actorUserId, newStartAt: startAt, detail: source });
  await enqueueEvent(tx, accountId, id, 1, held ? 'held' : 'confirmed');
  if (held) await enqueueHoldExpiry(tx, accountId, id, 1, holdExpiresAt as Date);
  else {
    await enqueueNotice(tx, accountId, id, 1, 'confirmation', startAt);
    await scheduleReminders(tx, accountId, { id, version: 1, start_at: startAt }, now);
    // Phase 9: a Zoom meeting for an online service (no job unless Zoom is connected and configured).
    await enqueueMeetingSync(tx, accountId, appointment, 1);
  }
  return { appointment, replayed: false };
}

// ------------------------------------------------------------ confirm a public hold

export interface ConfirmHoldInput {
  accountId: string;
  /** Upper-cased six-character code. */
  code: string;
  /** The WhatsApp sender's contact, which becomes the appointment's contact. */
  contactId: string;
  /** When the BOOK message reached us (messages.created_at), so queue delay never costs the customer the hold. */
  messageAt: Date;
  /** whatsapp_config.id the code arrived on (null = legacy single-number payloads). */
  whatsappConfigId: string | null;
  now?: Date;
}

export type ConfirmHoldResult =
  | { status: 'confirmed'; appointment: AppointmentRow }
  /** The same sender already confirmed this code (a retried job). */
  | { status: 'already_confirmed'; appointment: AppointmentRow }
  /**
   * A paid service (E15): the sender is bound, the hold extended and the
   * payment link queued; confirmation waits for a verified payment. Also
   * returned when the same sender repeats the code.
   */
  | { status: 'payment_pending'; appointment: AppointmentRow };

/**
 * Confirm a public hold from an inbound "BOOK <CODE>" (design section 4).
 * Throws not_found (unknown code, or the code arrived on another number),
 * hold_expired (message after the hold ended), slot_unavailable (an expired
 * hold whose slot was taken) or customer_conflict.
 */
export async function confirmHold(tx: TenantTransaction, input: ConfirmHoldInput): Promise<ConfirmHoldResult> {
  const { accountId } = input;
  const now = input.now ?? new Date();
  if (!/^[A-HJ-NP-Z2-9]{6}$/.test(input.code) || !UUID.test(input.contactId)) throw new AppointmentError('not_found');
  const [hit] = await tx.$queryRaw<{ id: string; page_number: string | null; default_number: string | null }[]>`
    SELECT a.id, p.whatsapp_config_id AS page_number,
      (SELECT w.id FROM whatsapp_config w WHERE w.account_id=a.account_id ORDER BY w.is_default DESC, w.created_at, w.id LIMIT 1) AS default_number
    FROM appointments a LEFT JOIN booking_pages p ON p.account_id=a.account_id AND p.id=a.booking_page_id
    WHERE a.account_id=${accountId}::uuid AND a.hold_code=${input.code} AND a.source='public'
      AND (a.status IN ('held','expired') OR (a.status='confirmed' AND a.contact_id=${input.contactId}::uuid))
    ORDER BY (a.status='held') DESC, (a.status='confirmed') DESC, a.created_at DESC LIMIT 1`;
  const candidate = hit ? await getAppointment(tx, accountId, hit.id) : null;
  if (!hit || !candidate) throw new AppointmentError('not_found');
  const expectedNumber = hit.page_number ?? hit.default_number;
  if (input.whatsappConfigId && expectedNumber && input.whatsappConfigId !== expectedNumber) throw new AppointmentError('not_found');
  if (candidate.status === 'confirmed') return { status: 'already_confirmed', appointment: candidate };
  // A paid hold already bound by BOOK: the same sender repeating it is a replay; anyone else is a miss.
  if (candidate.payment_status === 'pending' && candidate.contact_id) {
    if (candidate.contact_id !== input.contactId) throw new AppointmentError('not_found');
    if (candidate.status === 'held') return { status: 'payment_pending', appointment: candidate };
  }
  if (!candidate.hold_expires_at || input.messageAt.getTime() > candidate.hold_expires_at.getTime()) throw new AppointmentError('hold_expired');

  // An archived service or location (not_found) means the slot is gone; a
  // database error stays an error so the job retries.
  const unavailable = (error: unknown): never => {
    throw error instanceof AppointmentError && error.code === 'not_found' ? new AppointmentError('slot_unavailable') : error;
  };
  const configBefore = await loadAvailabilityConfig(tx, accountId, candidate.service_id, candidate.location_id).catch(unavailable);
  const staffIds = candidate.staff_id ? [candidate.staff_id] : [];
  if (!configBefore.pooled && (!candidate.staff_id || !configBefore.staff.some((s) => s.id === candidate.staff_id)))
    throw new AppointmentError('slot_unavailable');
  const { config } = await lockWithConfig(tx, accountId, configBefore,
    [...slotKeys(accountId, configBefore, staffIds), lockKeys.contact(accountId, input.contactId)], staffIds).catch(unavailable);
  const row = await getAppointment(tx, accountId, candidate.id, true);
  if (!row) throw new AppointmentError('not_found');
  if (row.status === 'confirmed' && row.contact_id === input.contactId) return { status: 'already_confirmed', appointment: row };
  if (row.payment_status === 'pending' && row.contact_id) {
    if (row.contact_id !== input.contactId) throw new AppointmentError('not_found');
    if (row.status === 'held') return { status: 'payment_pending', appointment: row };
  }
  if ((row.status !== 'held' && row.status !== 'expired') || row.version !== candidate.version) throw new AppointmentError('conflict');
  if (row.start_at.getTime() <= now.getTime()) throw new AppointmentError('slot_unavailable');

  // The hold already reserved the slot; re-check (excluding itself) in case it expired and was taken.
  await recheckSlot(tx, accountId, config, { startAt: row.start_at, staffIds, now, excludeAppointmentId: row.id, ignoreNotice: true });
  if (await contactConflict(tx, accountId, input.contactId, row.start_at, row.end_at, now, row.id))
    throw new AppointmentError('customer_conflict');

  if (row.payment_status === 'pending') {
    // Paid service: bind the sender, extend the hold so the link can be paid,
    // and queue the link. A workspace that can no longer take payment cannot hold it.
    if (!(await paidBookingReady(tx, accountId))) throw new AppointmentError('slot_unavailable');
    const version = row.version + 1;
    const holdExpiresAt = new Date(now.getTime() + (await paidHoldMinutes(tx, accountId)) * MINUTE);
    const [pending] = await tx.$queryRawUnsafe<AppointmentRow[]>(
      `UPDATE appointments SET contact_id=$3::uuid, status='held', version=$4, hold_expires_at=$5, hold_client_hash=NULL, updated_at=now()
       WHERE account_id=$1::uuid AND id=$2::uuid RETURNING ${APPOINTMENT_COLUMNS}`,
      accountId, row.id, input.contactId, version, holdExpiresAt);
    await insertEvent(tx, { appointmentId: row.id, version, kind: 'payment_pending', actor: 'customer', newStartAt: row.start_at,
      detail: 'whatsapp_code' });
    await enqueueHoldExpiry(tx, accountId, row.id, version, holdExpiresAt);
    await enqueuePaymentLink(tx, accountId, row.id, version);
    return { status: 'payment_pending', appointment: pending };
  }

  const [intake] = await tx.$queryRaw<{ intake: BookingIntake | null }[]>`SELECT intake FROM appointments WHERE id=${row.id}::uuid`;
  const version = row.version + 1;
  const tokenHash = manageTokenHash(deriveManageToken(row.id, row.token_epoch));
  const [updated] = await tx.$queryRawUnsafe<AppointmentRow[]>(
    `UPDATE appointments SET contact_id=$3::uuid, status='confirmed', confirmed_at=$4, version=$5, manage_token_hash=$6,
       intake=NULL, hold_client_hash=NULL, hold_expires_at=NULL, updated_at=now()
     WHERE account_id=$1::uuid AND id=$2::uuid RETURNING ${APPOINTMENT_COLUMNS}`,
    accountId, row.id, input.contactId, now, version, tokenHash);
  // Registration details fill only empty contact fields; never overwrite.
  const name = intake?.intake?.name;
  if (name) await tx.$executeRaw`UPDATE contacts SET name=${name}, updated_at=now()
    WHERE account_id=${accountId}::uuid AND id=${input.contactId}::uuid AND (name IS NULL OR btrim(name)='')`;
  await insertEvent(tx, { appointmentId: row.id, version, kind: 'confirmed', actor: 'customer', newStartAt: row.start_at, detail: 'whatsapp_code' });
  await enqueueEvent(tx, accountId, row.id, version, 'confirmed');
  await enqueueNotice(tx, accountId, row.id, version, 'confirmation', row.start_at);
  await scheduleReminders(tx, accountId, { id: row.id, version, start_at: row.start_at }, now);
  await enqueueMeetingSync(tx, accountId, updated, version);
  return { status: 'confirmed', appointment: updated };
}

// ------------------------------------------------------------ confirm a paid hold (settlement)

export type ConfirmPaidHoldOutcome =
  /** The hold is now confirmed and payment_status 'paid'. */
  | { kind: 'confirmed' }
  /** Already confirmed by this payment (a replay). */
  | { kind: 'already_confirmed' }
  /** The slot was taken after the hold expired (or its time passed): the caller opens late_payment_slot_lost. */
  | { kind: 'slot_lost' }
  /**
   * Not a paid hold this payment can confirm. Reasons (codes): not_found,
   * not_pending (nothing collected online for it), closed (cancelled or
   * finished), duplicate_payment (already paid by another payment),
   * amount_mismatch, currency_mismatch, contact_missing.
   */
  | { kind: 'not_payable'; reason: string };

export interface ConfirmPaidHoldInput {
  accountId: string;
  appointmentId: string;
  /** customer_payments.id of the verified payment. */
  paymentId: string;
  amountMinor: number;
  currency: string;
  now?: Date;
}

/**
 * Confirm a paid public hold after settlement verified its payment (E15).
 * Runs in the settlement transaction (worker), which already holds the
 * payment and appointment row locks. A hold still inside its time keeps its
 * slot, so it is confirmed at once. A hold whose time ran out (or that the
 * expiry job already expired) is re-checked under the slot advisory locks,
 * excluding itself; when the slot was taken, the time passed or the customer
 * now has a clash, the hold stays (or becomes) expired with a late_payment
 * event and the caller opens late_payment_slot_lost. Never sends anything
 * itself: the confirmation notice and reminders are queued jobs.
 */
export async function confirmPaidHold(tx: TenantTransaction, input: ConfirmPaidHoldInput): Promise<ConfirmPaidHoldOutcome> {
  const { accountId } = input;
  const now = input.now ?? new Date();
  const row = await getAppointment(tx, accountId, input.appointmentId, true);
  if (!row) return { kind: 'not_payable', reason: 'not_found' };
  if (row.payment_status === 'paid') {
    const [mine] = await tx.$queryRaw<{ found: number }[]>`SELECT 1 AS found FROM customer_payments
      WHERE account_id=${accountId}::uuid AND id=${input.paymentId}::uuid AND appointment_id=${row.id}::uuid AND settlement='settled'`;
    return mine ? { kind: 'already_confirmed' } : { kind: 'not_payable', reason: 'duplicate_payment' };
  }
  if (row.payment_status !== 'pending') return { kind: 'not_payable', reason: 'not_pending' };
  if (row.status !== 'held' && row.status !== 'expired') return { kind: 'not_payable', reason: 'closed' };
  const price = row.price_minor === null ? null : Number(row.price_minor);
  if (price === null || !Number.isSafeInteger(input.amountMinor) || input.amountMinor !== price) return { kind: 'not_payable', reason: 'amount_mismatch' };
  if (row.currency !== input.currency) return { kind: 'not_payable', reason: 'currency_mismatch' };
  if (!row.contact_id) return { kind: 'not_payable', reason: 'contact_missing' };
  const contactId = row.contact_id;

  const live = row.status === 'held' && row.hold_expires_at !== null && row.hold_expires_at.getTime() > now.getTime();
  if (!live) {
    const lost = async (): Promise<ConfirmPaidHoldOutcome> => {
      let version = row.version;
      if (row.status === 'held') {
        version += 1;
        await tx.$executeRaw`UPDATE appointments SET status='expired', version=${version}, intake=NULL, hold_client_hash=NULL, updated_at=now()
          WHERE account_id=${accountId}::uuid AND id=${row.id}::uuid`;
        await insertEvent(tx, { appointmentId: row.id, version, kind: 'expired', actor: 'system' });
      }
      await insertEvent(tx, { appointmentId: row.id, version, kind: 'late_payment', actor: 'system', detail: 'slot_lost' });
      return { kind: 'slot_lost' };
    };
    if (row.start_at.getTime() <= now.getTime()) return lost();
    try {
      const configBefore = await loadAvailabilityConfig(tx, accountId, row.service_id, row.location_id);
      const staffIds = row.staff_id ? [row.staff_id] : [];
      if (!configBefore.pooled && (!row.staff_id || !configBefore.staff.some((s) => s.id === row.staff_id)))
        throw new AppointmentError('slot_unavailable');
      // Advisory locks after the caller's row locks: the only other paths that take
      // these locks and then this row (confirmHold, reschedule) refuse a bound
      // paid hold or a non-confirmed row before locking.
      const { config } = await lockWithConfig(tx, accountId, configBefore,
        [...slotKeys(accountId, configBefore, staffIds), lockKeys.contact(accountId, contactId)], staffIds);
      await recheckSlot(tx, accountId, config, { startAt: row.start_at, staffIds, now, excludeAppointmentId: row.id, ignoreNotice: true });
      if (await contactConflict(tx, accountId, contactId, row.start_at, row.end_at, now, row.id)) return lost();
    } catch (error) {
      if (error instanceof AppointmentError
        && ['slot_unavailable', 'day_not_allowed', 'not_found', 'customer_conflict'].includes(error.code)) return lost();
      throw error;
    }
  }

  const [intake] = await tx.$queryRaw<{ intake: BookingIntake | null }[]>`SELECT intake FROM appointments WHERE id=${row.id}::uuid`;
  const version = row.version + 1;
  const tokenHash = manageTokenHash(deriveManageToken(row.id, row.token_epoch));
  await tx.$executeRaw`UPDATE appointments SET status='confirmed', payment_status='paid', confirmed_at=${now}, version=${version},
      manage_token_hash=${tokenHash}, intake=NULL, hold_client_hash=NULL, hold_expires_at=NULL, updated_at=now()
    WHERE account_id=${accountId}::uuid AND id=${row.id}::uuid`;
  const name = intake?.intake?.name;
  if (name) await tx.$executeRaw`UPDATE contacts SET name=${name}, updated_at=now()
    WHERE account_id=${accountId}::uuid AND id=${contactId}::uuid AND (name IS NULL OR btrim(name)='')`;
  await insertEvent(tx, { appointmentId: row.id, version, kind: 'payment_captured', actor: 'customer', detail: live ? 'online' : 'late' });
  await insertEvent(tx, { appointmentId: row.id, version, kind: 'confirmed', actor: 'customer', newStartAt: row.start_at, detail: 'payment' });
  await enqueueEvent(tx, accountId, row.id, version, 'confirmed');
  await enqueueNotice(tx, accountId, row.id, version, 'confirmation', row.start_at);
  await scheduleReminders(tx, accountId, { id: row.id, version, start_at: row.start_at }, now);
  await enqueueMeetingSync(tx, accountId, { ...row, status: 'confirmed' }, version);
  return { kind: 'confirmed' };
}

// ------------------------------------------------------------ reschedule, reassign, cancel, outcome

export interface ChangeActor {
  actor: Exclude<AppointmentActor, 'system'>;
  actorUserId?: string | null;
}

function assertVersion(row: AppointmentRow, expectedVersion: number) {
  if (row.version !== expectedVersion) throw new AppointmentError('conflict');
}

function assertCustomerCutoff(row: AppointmentRow, cutoffMinutes: number, now: Date) {
  if (now.getTime() > row.start_at.getTime() - cutoffMinutes * MINUTE) throw new AppointmentError('conflict');
}

export interface RescheduleInput extends ChangeActor {
  accountId: string;
  appointmentId: string;
  startAt: Date;
  /** A new practitioner; omitted keeps the current one (pooled services have none). */
  staffId?: string | null;
  expectedVersion: number;
  now?: Date;
}

/**
 * Move a confirmed appointment (and/or reassign its practitioner) in place:
 * version + 1, an event with the old and new times, a customer notice when
 * the time changed, and new versioned reminders. The old version's jobs turn
 * into no-ops at dispatch.
 */
export async function rescheduleAppointment(tx: TenantTransaction, input: RescheduleInput): Promise<AppointmentRow> {
  const { accountId } = input;
  const now = input.now ?? new Date();
  if (Number.isNaN(input.startAt.getTime()) || (input.staffId && !UUID.test(input.staffId))) throw new AppointmentError('invalid');
  const before = await getAppointment(tx, accountId, input.appointmentId);
  if (!before) throw new AppointmentError('not_found');
  if (before.status !== 'confirmed') throw new AppointmentError('conflict');
  assertVersion(before, input.expectedVersion);
  await requireFeature(tx, accountId, 'appointments');
  const settings = await loadSettings(tx, accountId);
  if (input.actor === 'customer') assertCustomerCutoff(before, settings.customer_cancel_cutoff_minutes, now);
  const configBefore = await loadAvailabilityConfig(tx, accountId, before.service_id, before.location_id);
  let staffId: string | null = null;
  if (!configBefore.pooled) {
    staffId = input.staffId ?? before.staff_id;
    if (!staffId || !configBefore.staff.some((s) => s.id === staffId)) throw new AppointmentError('slot_unavailable');
  } else if (input.staffId) throw new AppointmentError('slot_unavailable');

  const keys = slotKeys(accountId, configBefore, staffId ? [staffId] : []);
  if (before.staff_id) keys.push(lockKeys.staff(accountId, before.staff_id));
  if (before.contact_id) keys.push(lockKeys.contact(accountId, before.contact_id));
  const { config } = await lockWithConfig(tx, accountId, configBefore, keys, staffId ? [staffId] : []);
  const row = await getAppointment(tx, accountId, input.appointmentId, true);
  if (!row || row.status !== 'confirmed' || row.version !== before.version || row.staff_id !== before.staff_id)
    throw new AppointmentError('conflict');

  const startAt = input.startAt;
  const endAt = new Date(startAt.getTime() + config.service.duration_minutes * MINUTE);
  const timeChanged = startAt.getTime() !== row.start_at.getTime();
  if (!timeChanged && staffId === row.staff_id) return row;
  // Staff may move or reassign inside the notice window and past the horizon
  // (a practitioner off sick an hour before), never into the past.
  await recheckSlot(tx, accountId, config, { startAt, staffIds: staffId ? [staffId] : [], now, excludeAppointmentId: row.id,
    ignoreNotice: input.actor === 'staff' });
  if (row.contact_id && await contactConflict(tx, accountId, row.contact_id, startAt, endAt, now, row.id))
    throw new AppointmentError('customer_conflict');

  const version = row.version + 1;
  const [updated] = await tx.$queryRawUnsafe<AppointmentRow[]>(
    `UPDATE appointments SET start_at=$3, end_at=$4, staff_id=$5::uuid, timezone=$6, version=$7, updated_at=now()
     WHERE account_id=$1::uuid AND id=$2::uuid RETURNING ${APPOINTMENT_COLUMNS}`,
    accountId, row.id, startAt, endAt, staffId, config.location.timezone, version);
  const kind: AppointmentEventKind = timeChanged ? 'rescheduled' : 'reassigned';
  await insertEvent(tx, { appointmentId: row.id, version, kind, actor: input.actor, actorUserId: input.actorUserId,
    oldStartAt: row.start_at, newStartAt: startAt });
  await enqueueEvent(tx, accountId, row.id, version, kind);
  if (timeChanged) await enqueueNotice(tx, accountId, row.id, version, 'rescheduled', startAt);
  await scheduleReminders(tx, accountId, { id: row.id, version, start_at: startAt }, now);
  // A new time or practitioner moves (or re-hosts) the Zoom meeting.
  await enqueueMeetingSync(tx, accountId, updated, version);
  return updated;
}

export interface CancelInput extends ChangeActor {
  accountId: string;
  appointmentId: string;
  reason: CancelReason;
  expectedVersion: number;
  now?: Date;
}

/** Cancel a confirmed appointment or an unconfirmed hold; a confirmed customer is told. */
export async function cancelAppointment(tx: TenantTransaction, input: CancelInput): Promise<AppointmentRow> {
  const { accountId } = input;
  const now = input.now ?? new Date();
  const row = await getAppointment(tx, accountId, input.appointmentId, true);
  if (!row) throw new AppointmentError('not_found');
  if (row.status !== 'confirmed' && row.status !== 'held') throw new AppointmentError('conflict');
  assertVersion(row, input.expectedVersion);
  if (input.actor === 'customer') {
    if (row.status !== 'confirmed') throw new AppointmentError('conflict');
    assertCustomerCutoff(row, (await loadSettings(tx, accountId)).customer_cancel_cutoff_minutes, now);
  }
  const version = row.version + 1;
  const [updated] = await tx.$queryRawUnsafe<AppointmentRow[]>(
    `UPDATE appointments SET status='cancelled', cancel_reason=$3, version=$4, hold_client_hash=NULL, updated_at=now()
     WHERE account_id=$1::uuid AND id=$2::uuid RETURNING ${APPOINTMENT_COLUMNS}`,
    accountId, row.id, input.reason, version);
  await insertEvent(tx, { appointmentId: row.id, version, kind: 'cancelled', actor: input.actor, actorUserId: input.actorUserId,
    oldStartAt: row.start_at, detail: input.reason });
  await enqueueEvent(tx, accountId, row.id, version, 'cancelled');
  if (row.status === 'confirmed' && row.contact_id) await enqueueNotice(tx, accountId, row.id, version, 'cancelled');
  // A cancelled paid hold must not stay payable (as expireHold); a capture that still
  // lands takes confirmPaidHold's closed path and is surfaced for a manual refund.
  if (row.payment_status === 'pending') await enqueueLinkCancels(tx, accountId, row.id);
  // A cancelled appointment's Zoom meeting is deleted (no job when it never had one).
  await enqueueMeetingSync(tx, accountId, updated, version);
  return updated;
}

export interface OutcomeInput {
  accountId: string;
  appointmentId: string;
  outcome: 'completed' | 'no_show';
  note?: string | null;
  expectedVersion: number;
  actorUserId?: string | null;
  now?: Date;
}

/**
 * Staff-recorded attendance, only after the start. completed queues the
 * feedback message (when a feedback template and delay are set) and a rebook
 * task (and optional rebook message); no_show creates a next-step task for
 * the practitioner's linked member.
 */
export async function markOutcome(tx: TenantTransaction, input: OutcomeInput): Promise<AppointmentRow> {
  const { accountId } = input;
  const now = input.now ?? new Date();
  if (input.note != null && (typeof input.note !== 'string' || input.note.length > 1000)) throw new AppointmentError('invalid');
  const row = await getAppointment(tx, accountId, input.appointmentId, true);
  if (!row) throw new AppointmentError('not_found');
  if (row.status !== 'confirmed') throw new AppointmentError('conflict');
  assertVersion(row, input.expectedVersion);
  if (now.getTime() < row.start_at.getTime()) throw new AppointmentError('conflict');
  const version = row.version + 1;
  const note = input.note === undefined ? row.outcome_note : (input.note?.trim() || null);
  const [updated] = await tx.$queryRawUnsafe<AppointmentRow[]>(
    `UPDATE appointments SET status=$3, outcome_note=$4, version=$5, updated_at=now()
     WHERE account_id=$1::uuid AND id=$2::uuid RETURNING ${APPOINTMENT_COLUMNS}`,
    accountId, row.id, input.outcome, note, version);
  await insertEvent(tx, { appointmentId: row.id, version, kind: input.outcome, actor: 'staff', actorUserId: input.actorUserId });
  await enqueueEvent(tx, accountId, row.id, version, input.outcome);

  const [service] = await tx.$queryRaw<{ feedback_delay_minutes: number | null; rebook_after_days: number | null }[]>`
    SELECT feedback_delay_minutes, rebook_after_days FROM appointment_services WHERE account_id=${accountId}::uuid AND id=${row.service_id}::uuid`;
  if (input.outcome === 'completed') {
    const settings = await loadSettings(tx, accountId);
    if (settings.feedback_template_name && service?.feedback_delay_minutes != null && row.contact_id)
      await enqueueFollowup(tx, accountId, row.id, version, 'feedback',
        new Date(Math.max(now.getTime(), row.end_at.getTime() + service.feedback_delay_minutes * MINUTE)));
    if (service?.rebook_after_days != null) {
      const due = new Date(row.end_at.getTime() + service.rebook_after_days * 86_400_000);
      await insertTask(tx, { kind: 'rebook', title: row.service_name, contactId: row.contact_id, appointmentId: row.id, dueAt: due,
        assignedTo: null, createdBy: input.actorUserId ?? null });
      if (settings.rebook_template_name && row.contact_id) await enqueueFollowup(tx, accountId, row.id, version, 'rebook', due);
    }
  } else {
    const [staff] = row.staff_id ? await tx.$queryRaw<{ user_id: string | null }[]>`
      SELECT user_id FROM appointment_staff WHERE account_id=${accountId}::uuid AND id=${row.staff_id}::uuid` : [];
    await insertTask(tx, { kind: 'next_step', title: row.service_name, contactId: row.contact_id, appointmentId: row.id,
      dueAt: now, assignedTo: staff?.user_id ?? null, createdBy: input.actorUserId ?? null });
  }
  return updated;
}

async function insertTask(tx: TenantTransaction, t: { kind: 'rebook' | 'next_step'; title: string; contactId: string | null;
  appointmentId: string; dueAt: Date; assignedTo: string | null; createdBy: string | null }) {
  await tx.$executeRaw`INSERT INTO tasks(contact_id,appointment_id,kind,title,due_at,assigned_to,created_by)
    VALUES(${t.contactId}::uuid,${t.appointmentId}::uuid,${t.kind},${t.title.slice(0, 200)},${t.dueAt},${t.assignedTo}::uuid,${t.createdBy}::uuid)`;
}

export interface DetailsInput {
  accountId: string;
  appointmentId: string;
  outcomeNote?: string | null;
  feedbackScore?: number | null;
  actorUserId?: string | null;
}

/**
 * Staff note and feedback score. Does not bump the version (that would
 * retire the reminders); a feedback score adds a 'feedback' history row.
 */
export async function updateAppointmentDetails(tx: TenantTransaction, input: DetailsInput): Promise<AppointmentRow> {
  const { accountId } = input;
  if (input.outcomeNote != null && (typeof input.outcomeNote !== 'string' || input.outcomeNote.length > 1000))
    throw new AppointmentError('invalid');
  if (input.feedbackScore != null && !(Number.isInteger(input.feedbackScore) && input.feedbackScore >= 1 && input.feedbackScore <= 5))
    throw new AppointmentError('invalid');
  const row = await getAppointment(tx, accountId, input.appointmentId, true);
  if (!row) throw new AppointmentError('not_found');
  if (input.feedbackScore != null && row.status !== 'completed') throw new AppointmentError('conflict');
  const note = input.outcomeNote === undefined ? row.outcome_note : (input.outcomeNote?.trim() || null);
  const score = input.feedbackScore === undefined ? row.feedback_score : input.feedbackScore;
  const [updated] = await tx.$queryRawUnsafe<AppointmentRow[]>(
    `UPDATE appointments SET outcome_note=$3, feedback_score=$4, updated_at=now()
     WHERE account_id=$1::uuid AND id=$2::uuid RETURNING ${APPOINTMENT_COLUMNS}`,
    accountId, row.id, note, score);
  if (input.feedbackScore != null && input.feedbackScore !== row.feedback_score)
    await insertEvent(tx, { appointmentId: row.id, version: row.version, kind: 'feedback', actor: 'staff', actorUserId: input.actorUserId });
  return updated;
}

// ------------------------------------------------------------ hold expiry (worker job)

/**
 * Expire an unconfirmed hold once its grace period has passed. Idempotent:
 * a confirmed, cancelled or newer-version row is left alone.
 */
export async function expireHold(
  tx: TenantTransaction,
  input: { accountId: string; appointmentId: string; version: number; now?: Date },
): Promise<'expired' | 'skipped'> {
  const now = input.now ?? new Date();
  const row = await getAppointment(tx, input.accountId, input.appointmentId, true);
  if (!row || row.status !== 'held' || row.version !== input.version || !row.hold_expires_at) return 'skipped';
  if (row.hold_expires_at.getTime() + 5 * MINUTE > now.getTime()) return 'skipped';
  if (row.payment_status === 'pending') {
    // Settlement confirms under this row's lock; a settled payment means it is (being) confirmed.
    const [settled] = await tx.$queryRaw<{ found: number }[]>`SELECT 1 AS found FROM customer_payments
      WHERE account_id=${input.accountId}::uuid AND appointment_id=${row.id}::uuid AND settlement='settled' LIMIT 1`;
    if (settled) return 'skipped';
  }
  const version = row.version + 1;
  await tx.$executeRaw`UPDATE appointments SET status='expired', version=${version}, intake=NULL, hold_client_hash=NULL, updated_at=now()
    WHERE account_id=${input.accountId}::uuid AND id=${row.id}::uuid`;
  await insertEvent(tx, { appointmentId: row.id, version, kind: 'expired', actor: 'system' });
  // An unpaid link is cancelled; a capture that still arrives takes the late-payment path (confirmPaidHold).
  if (row.payment_status === 'pending') await enqueueLinkCancels(tx, input.accountId, row.id);
  return 'expired';
}
