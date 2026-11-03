/**
 * Data access for the book_appointment flow step (server only). Every call
 * runs in its own worker transaction scoped to the run's workspace
 * (withTenant, role 'owner', as in lib/broadcasts/clicks.ts) and returns ids,
 * names and times only. Availability and booking reuse lib/appointments, so
 * the Monday rule, hours, exceptions, notice, horizon, capacity and the
 * no-overbooking locks are exactly the staff and public ones.
 */

import { getWorkerPrisma } from "@/lib/db/prisma";
import { withTenant, type TenantTransaction } from "@/lib/db/tenant";
import { getEntitlements, PlanLimitError } from "@/lib/billing/entitlements";
import { loadAvailabilityConfig, listSlots } from "@/lib/appointments/availability";
import { bookAppointment } from "@/lib/appointments/booking";
import { sourceRefs } from "@/lib/appointments/keys";
import { localParts } from "@/lib/appointments/time";
import { isAppointmentError, type Slot } from "@/lib/appointments/types";
import { appointmentServiceIds, BOOK_APPOINTMENT_LIMITS } from "./appointment-node";

export interface AppointmentChoice {
  id: string;
  name: string;
}

export type AppointmentBookResult =
  | { ok: true; appointmentId: string; localTime: string; replayed: boolean }
  /** A code-only refusal (Appointments.errors codes, or `plan` for a plan/suspension refusal). */
  | { ok: false; code: string };

function inTenant<T>(accountId: string, operation: (tx: TenantTransaction) => Promise<T>): Promise<T> {
  return withTenant({ accountId, role: "owner" }, operation, getWorkerPrisma());
}

/** Bookable offerings only: a live location and, when staffed, a live practitioner. */
const LIVE_OFFERING = `FROM appointment_offerings o
  JOIN appointment_locations l ON l.account_id=o.account_id AND l.id=o.location_id AND l.archived_at IS NULL
  LEFT JOIN appointment_staff st ON st.account_id=o.account_id AND st.id=o.staff_id
  WHERE o.account_id=$1::uuid AND (o.staff_id IS NULL OR st.archived_at IS NULL)`;

/**
 * Services the step offers: the configured ones (or every service), of the
 * configured mode, not archived, not payment-gated (design D16) and offered
 * at a live location. Empty when the plan has no appointments.
 */
export async function appointmentServices(accountId: string, config: Record<string, unknown>): Promise<AppointmentChoice[]> {
  return inTenant(accountId, async (tx) => {
    if (!(await getEntitlements(tx, accountId)).features.appointments) return [];
    const ids = appointmentServiceIds(config);
    const mode = config.service_mode === "online" || config.service_mode === "offline" ? config.service_mode : null;
    const location = typeof config.location_id === "string" && config.location_id ? config.location_id : null;
    return tx.$queryRawUnsafe<AppointmentChoice[]>(
      `SELECT s.id::text AS id, s.name FROM appointment_services s
       WHERE s.account_id=$1::uuid AND s.archived_at IS NULL AND NOT s.payment_required
         AND (cardinality($2::uuid[]) = 0 OR s.id = ANY($2::uuid[]))
         AND ($3::text IS NULL OR s.mode = $3::text)
         AND EXISTS (SELECT 1 ${LIVE_OFFERING} AND o.service_id=s.id AND ($4::uuid IS NULL OR o.location_id=$4::uuid))
       ORDER BY s.name, s.id LIMIT ${BOOK_APPOINTMENT_LIMITS.maxServices}`,
      accountId, ids, mode, location);
  });
}

/** The configured location when it offers the service, else the first live one (by name), else null. */
export async function appointmentLocation(accountId: string, serviceId: string, configured?: string | null): Promise<string | null> {
  return inTenant(accountId, async (tx) => {
    const [row] = await tx.$queryRawUnsafe<{ id: string }[]>(
      `SELECT o.location_id::text AS id ${LIVE_OFFERING} AND o.service_id=$2::uuid AND ($3::uuid IS NULL OR o.location_id=$3::uuid)
       ORDER BY l.name, l.id LIMIT 1`,
      accountId, serviceId, configured || null);
    return row?.id ?? null;
  });
}

/** Practitioners the customer may choose from (by name); empty for a location pool or an unknown pair. */
export async function appointmentStaff(accountId: string, serviceId: string, locationId: string): Promise<AppointmentChoice[]> {
  return inTenant(accountId, async (tx) => {
    try {
      const config = await loadAvailabilityConfig(tx, accountId, serviceId, locationId);
      if (config.pooled) return [];
      return config.staff.filter((s) => !s.archived_at)
        .map((s) => ({ id: s.id, name: s.display_name }))
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    } catch (err) {
      if (isAppointmentError(err)) return [];
      throw err;
    }
  });
}

/** Free slots (read-only; booking re-checks under its locks). Empty when the pair is not bookable. */
export async function appointmentSlots(accountId: string, input: {
  serviceId: string;
  locationId: string;
  staffId?: string | null;
  fromDay?: string;
  days: number;
}): Promise<Slot[]> {
  return inTenant(accountId, async (tx) => {
    try {
      const { slots } = await listSlots(tx, accountId, {
        serviceId: input.serviceId,
        locationId: input.locationId,
        staffId: input.staffId ?? undefined,
        fromDay: input.fromDay,
        days: input.days,
      });
      return slots;
    } catch (err) {
      if (isAppointmentError(err)) return [];
      throw err;
    }
  });
}

/**
 * Books the tapped time for the run's contact. Idempotent per run, node and
 * transition (source_ref), so a replayed reply returns the same appointment
 * instead of a customer_conflict.
 */
export async function bookFlowAppointment(accountId: string, input: {
  runId: string;
  nodeKey: string;
  transitionSeq: number;
  contactId: string;
  serviceId: string;
  locationId: string;
  staffId?: string | null;
  startAt: Date;
}): Promise<AppointmentBookResult> {
  try {
    return await inTenant(accountId, async (tx) => {
      const { appointment, replayed } = await bookAppointment(tx, {
        accountId,
        source: "flow",
        serviceId: input.serviceId,
        locationId: input.locationId,
        staffId: input.staffId ?? null,
        startAt: input.startAt,
        contactId: input.contactId,
        sourceRef: sourceRefs.flow(input.runId, input.nodeKey, input.transitionSeq),
      });
      const local = localParts(new Date(appointment.start_at), appointment.timezone);
      return { ok: true as const, appointmentId: appointment.id, localTime: `${local.date} ${local.hhmm}`, replayed };
    });
  } catch (err) {
    if (isAppointmentError(err)) return { ok: false, code: err.code };
    // Plan without appointments, or a suspended workspace (WorkspaceSuspendedError extends PlanLimitError).
    if (err instanceof PlanLimitError) return { ok: false, code: "plan" };
    throw err;
  }
}
