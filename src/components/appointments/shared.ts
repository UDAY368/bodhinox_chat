'use client';

/**
 * Client plumbing for the staff appointments UI: one JSON request helper for
 * /api/appointments/**, error-code translation, the shared configuration
 * loader (services, practitioners, locations, offerings) and small pure
 * formatting helpers. The server enforces every rule; this only shapes calls
 * and messages.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { authFetch } from '@/lib/auth/client';
import { hasMinRole, type AccountRole } from '@/lib/auth/roles';
import { addDays, zonedWallToUtc } from '@/lib/appointments/time';
import type {
  AppointmentErrorCode, AppointmentStatus, LocationRow, OfferingRow, ServiceRow, StaffRow,
} from '@/lib/appointments/types';
import { APPOINTMENT_ERROR_CODES } from '@/lib/appointments/types';
import { APPOINTMENT_TEMPLATE_REFUSALS } from '@/lib/appointments/template-check';

export const selectClass = 'h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground disabled:opacity-60';

// ------------------------------------------------------------ JSON over the wire

/** Rows as the browser receives them (dates are ISO strings). */
export type Wire<T> = { [K in keyof T]: T[K] extends Date ? string : T[K] extends Date | null ? string | null : T[K] };
export type ServiceDto = Omit<Wire<ServiceRow>, 'price_minor'> & { price_minor: number | null };
export type StaffDto = Wire<StaffRow>;
export type LocationDto = Wire<LocationRow>;
export type OfferingDto = OfferingRow;

export interface ApiFailure {
  ok: false;
  status: number;
  code?: string;
  field?: string;
  detail?: string;
}
export type ApiResult<T> = { ok: true; data: T } | ApiFailure;

/** JSON request to a staff appointment API; never throws. Mutations carry CSRF via authFetch. */
export async function apiRequest<T>(url: string, init?: { method?: string; body?: unknown }): Promise<ApiResult<T>> {
  try {
    const res = await authFetch(url, {
      method: init?.method ?? 'GET',
      cache: 'no-store',
      ...(init?.body !== undefined
        ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) }
        : {}),
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok) return { ok: true, data: (body ?? {}) as T };
    return {
      ok: false,
      status: res.status,
      code: typeof body?.code === 'string' ? body.code : undefined,
      field: typeof body?.field === 'string' ? body.field : undefined,
      detail: typeof body?.detail === 'string' ? body.detail : undefined,
    };
  } catch {
    return { ok: false, status: 0 };
  }
}

const TEMPLATE_DETAILS = new Set<string>([...APPOINTMENT_TEMPLATE_REFUSALS, 'not_found', 'not_approved']);
const FIELD_DETAILS = new Set(['invalid', 'taken', 'pooled_or_staffed', 'mode_in_use', 'price_required', 'payments_not_ready']);

/** The message key (relative to the root namespace) for a failed call. Pure, so it is unit-tested. */
export function failureKey(failure: ApiFailure): string {
  if (failure.status === 402) return 'Appointments.errors.feature_unavailable';
  if (failure.field && failure.detail && /_template_name$/.test(failure.field) && TEMPLATE_DETAILS.has(failure.detail))
    return `AppointmentSettings.templateErrors.${failure.detail}`;
  if (failure.field === 'timezone' && failure.detail === 'invalid') return 'Appointments.fieldErrors.timezone';
  if (failure.field && failure.detail && FIELD_DETAILS.has(failure.detail)) return `Appointments.fieldErrors.${failure.detail}`;
  if (failure.code && (APPOINTMENT_ERROR_CODES as readonly string[]).includes(failure.code))
    return `Appointments.errors.${failure.code as AppointmentErrorCode}`;
  if (failure.status === 403) return 'Appointments.readOnly';
  if (failure.status === 429) return 'Appointments.errors.too_many';
  return 'Appointments.errors.invalid';
}

/** Translate a failed call into one sentence. */
export function useFailureText(): (failure: ApiFailure) => string {
  const t = useTranslations();
  return useCallback((failure: ApiFailure) => t(failureKey(failure) as never), [t]);
}

// ------------------------------------------------------------ permissions (role ceilings; the server also checks restrictions)

export interface Abilities {
  /** Book, reschedule, cancel, outcomes, tasks. */
  manage: boolean;
  /** Configuration (services, practitioners, hours, pages, settings). */
  settings: boolean;
  /** Mark customer messages resolved. */
  resolve: boolean;
}

export function abilitiesFor(role: AccountRole | null | undefined): Abilities {
  if (!role) return { manage: false, settings: false, resolve: false };
  // Role ceilings as in FEATURE_PERMISSIONS (that module is server-only); a workspace restriction still
  // makes the server refuse, and the UI then shows the refusal.
  const manage = hasMinRole(role, 'agent');
  const settings = hasMinRole(role, 'admin');
  // The resolve route needs an admin who also holds appointments.manage.
  return { manage, settings, resolve: manage && hasMinRole(role, 'admin') };
}

// ------------------------------------------------------------ shared configuration

export interface AppointmentConfig {
  services: ServiceDto[];
  staff: StaffDto[];
  locations: LocationDto[];
  offerings: OfferingDto[];
}

export type ConfigState =
  | { state: 'loading' }
  | { state: 'unavailable' }
  | { state: 'failed' }
  | { state: 'ready'; config: AppointmentConfig };

/** Services, practitioners, locations and offerings; `unavailable` when the plan lacks appointments. */
export function useAppointmentConfig(): { config: ConfigState; reload: () => Promise<void> } {
  const [config, setConfig] = useState<ConfigState>({ state: 'loading' });
  const reload = useCallback(async () => {
    const [services, staff, locations, offerings] = await Promise.all([
      apiRequest<{ services: ServiceDto[] }>('/api/appointments/services'),
      apiRequest<{ staff: StaffDto[] }>('/api/appointments/staff'),
      apiRequest<{ locations: LocationDto[] }>('/api/appointments/locations'),
      apiRequest<{ offerings: OfferingDto[] }>('/api/appointments/offerings'),
    ]);
    const all = [services, staff, locations, offerings];
    if (all.some((r) => !r.ok && r.status === 402)) return setConfig({ state: 'unavailable' });
    if (!services.ok || !staff.ok || !locations.ok || !offerings.ok) return setConfig({ state: 'failed' });
    setConfig({
      state: 'ready',
      config: {
        services: services.data.services ?? [],
        staff: staff.data.staff ?? [],
        locations: locations.data.locations ?? [],
        offerings: offerings.data.offerings ?? [],
      },
    });
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);
  return { config, reload };
}

/** Workspace members for "linked member" and assignee pickers (names only). */
export interface MemberOption { user_id: string; full_name: string | null; email: string | null }

export function useMembers(): MemberOption[] {
  const [members, setMembers] = useState<MemberOption[]>([]);
  useEffect(() => {
    let live = true;
    void apiRequest<{ members?: MemberOption[] }>('/api/account/members').then((r) => {
      if (live && r.ok) setMembers(r.data.members ?? []);
    });
    return () => {
      live = false;
    };
  }, []);
  return members;
}

export const memberLabel = (m: MemberOption) => m.full_name || m.email || m.user_id.slice(0, 8);

// ------------------------------------------------------------ pure helpers

/** YYYY-MM-DD from a date column that may arrive as a date or an ISO timestamp. */
export const dayOf = (value: string | Date): string => (typeof value === 'string' ? value : value.toISOString()).slice(0, 10);

/** The browser's zone, used only when no location exists yet. */
export function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Midnight of a local day in `tz` as an instant (a DST gap at midnight falls back to 01:00). */
export function localMidnight(day: string, tz: string): Date {
  return zonedWallToUtc(day, '00:00', tz) ?? zonedWallToUtc(day, '01:00', tz) ?? new Date(`${day}T00:00:00Z`);
}

/** The [from, to) instants and the local days of a day or week view starting at `anchor`. */
export function scheduleWindow(view: 'day' | 'week', anchor: string, tz: string): { from: Date; to: Date; days: string[] } {
  const count = view === 'day' ? 1 : 7;
  const days = Array.from({ length: count }, (_, i) => addDays(anchor, i));
  return { from: localMidnight(anchor, tz), to: localMidnight(addDays(anchor, count), tz), days };
}

/** Group schedule rows by their local date (each row's own zone), in time order. */
export function groupByLocalDate<T extends { local_date: string | Date; start_at: string }>(rows: T[]): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const row of [...rows].sort((a, b) => a.start_at.localeCompare(b.start_at))) {
    const day = dayOf(row.local_date);
    groups.set(day, [...(groups.get(day) ?? []), row]);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** Decimal places of a currency (2 when unknown). */
export function currencyDigits(currency: string | null | undefined): number {
  if (!currency) return 2;
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** "499.50" -> 49950 minor units; '' -> null; NaN -> undefined (invalid). */
export function toMinor(value: string, currency: string | null): number | null | undefined {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return undefined;
  const digits = currencyDigits(currency);
  const minor = Math.round(Number(trimmed) * 10 ** digits);
  return Number.isSafeInteger(minor) ? minor : undefined;
}

export function fromMinor(minor: number | null | undefined, currency: string | null): string {
  if (minor == null) return '';
  const digits = currencyDigits(currency);
  return (minor / 10 ** digits).toFixed(digits);
}

export function formatPrice(minor: number | null | undefined, currency: string | null, locale: string): string | null {
  if (minor == null || !currency) return null;
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(minor / 10 ** currencyDigits(currency));
  } catch {
    return null;
  }
}

/** Time of an instant in the appointment's zone (never the viewer's). */
export function formatTime(iso: string, tz: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone: tz }).format(new Date(iso));
}

export function formatDateTime(iso: string, tz: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: tz }).format(new Date(iso));
}

/** A local calendar day label (zone-independent: read at UTC noon). */
export function formatDay(day: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })
    .format(new Date(`${day}T12:00:00Z`));
}

/**
 * A task due date is a calendar day: a picked YYYY-MM-DD is stored as UTC
 * midnight and always read back in UTC, so every viewer sees the day that was
 * picked (a viewer west of UTC would otherwise see the day before).
 */
export function dueAtFromDay(day: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day}T00:00:00.000Z` : null;
}

export function formatDueDate(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(iso));
}

/** Statuses a staff member may filter by. */
export const FILTER_STATUSES: AppointmentStatus[] = ['confirmed', 'held', 'completed', 'no_show', 'cancelled', 'expired'];

/** Unique local dates of a slot list, in order. */
export const slotDates = (slots: { localDate: string }[]) => [...new Set(slots.map((s) => s.localDate))];
