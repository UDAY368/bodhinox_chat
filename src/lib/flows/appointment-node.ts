/**
 * Authoring rules and pure helpers for the book_appointment flow step
 * (engine: engine.ts runAppointmentStep / handleAppointmentReply; data:
 * appointment-runtime.ts, server only). Shared by the validator, the step's
 * form and the engine, so it imports nothing server-side.
 *
 * The step is one node that asks up to four questions in turn (service,
 * practitioner, day, time). Where it is in that conversation lives in the
 * run variable `_appointment` (ids, a local date and a page number only; no
 * customer content). Each question is sent after a transition on the same
 * node, so every prompt has its own `flow:<run>:<node>:<seq>:<attempt>`
 * outbound intent.
 */

import { getT } from "@/lib/i18n/translate";
import { INTERACTIVE_LIMITS } from "@/lib/whatsapp/interactive-limits";
import type { BookAppointmentNodeConfig } from "./types";
import type { ValidationIssue } from "./validate";

const t = getT("Validation.flows");

export const BOOK_APPOINTMENT_LIMITS = {
  /** Services the step may list: one list of 9 plus the Cancel row. */
  maxServices: 9,
  daysMin: 1,
  daysMax: 14,
  defaultDays: 7,
  /** Choices per list page: 8 plus "More" and "Cancel" fill WhatsApp's 10 rows. */
  pageSize: 8,
  /** Off-script replies re-prompt this many times, then the step takes its unavailable port. */
  maxInvalid: 2,
} as const;

/** Variables the step stores for the steps after it (never the manage link: flow.completed webhooks carry vars). */
export const BOOK_APPOINTMENT_VARS = ["appointment_id", "appointment_local_time"] as const;

/** Ports of the step, by config field. success_next is required; an unwired unavailable/cancelled port ends the run. */
export const BOOK_APPOINTMENT_PORT_FIELDS = ["success_next", "unavailable_next", "cancelled_next"] as const;

export type AppointmentOutcome = "success" | "unavailable" | "cancelled";

/** Run variable holding the step's progress (removed when the step ends). */
export const APPOINTMENT_STATE_VAR = "_appointment";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

interface NodeLike {
  node_key: string;
  config: Record<string, unknown>;
}

/** The configured service ids (valid UUIDs, de-duplicated, capped). */
export function appointmentServiceIds(config: Record<string, unknown>): string[] {
  const raw = Array.isArray(config.service_ids) ? config.service_ids : [];
  return [...new Set(raw.filter((id): id is string => typeof id === "string" && UUID.test(id)))].slice(0, BOOK_APPOINTMENT_LIMITS.maxServices);
}

/** Days ahead to offer, clamped to 1–14 (default 7). */
export function appointmentDaysAhead(config: Record<string, unknown>): number {
  const days = config.days_ahead;
  return typeof days === "number" && Number.isInteger(days)
    ? Math.min(BOOK_APPOINTMENT_LIMITS.daysMax, Math.max(BOOK_APPOINTMENT_LIMITS.daysMin, days))
    : BOOK_APPOINTMENT_LIMITS.defaultDays;
}

/** The node an outcome continues at, or null when that port is unwired. */
export function appointmentPortFor(config: Partial<BookAppointmentNodeConfig>, outcome: AppointmentOutcome): string | null {
  const key = config[`${outcome}_next`];
  return typeof key === "string" && key ? key : null;
}

/** Problems with a book_appointment step's services, location, practitioner mode, days and ports. */
export function bookAppointmentIssues(node: NodeLike, knownKeys: ReadonlySet<string>): ValidationIssue[] {
  const cfg = node.config;
  const issues: ValidationIssue[] = [];
  const at = (field: string, message: string) => issues.push({ severity: "error", scope: "node", node_key: node.node_key, field, message });

  const ids = cfg.service_ids;
  if (ids !== undefined && ids !== null && (!Array.isArray(ids) || ids.length > BOOK_APPOINTMENT_LIMITS.maxServices ||
      ids.some((id) => typeof id !== "string" || !UUID.test(id)) || new Set(ids).size !== ids.length)) {
    at("service_ids", t("appointmentServices", { max: BOOK_APPOINTMENT_LIMITS.maxServices }));
  }
  if (cfg.service_mode !== undefined && cfg.service_mode !== null && cfg.service_mode !== "online" && cfg.service_mode !== "offline") {
    at("service_mode", t("appointmentMode"));
  }
  if (cfg.location_id !== undefined && cfg.location_id !== null && cfg.location_id !== "" &&
      !(typeof cfg.location_id === "string" && UUID.test(cfg.location_id))) {
    at("location_id", t("appointmentLocation"));
  }
  if (cfg.staff_mode !== undefined && cfg.staff_mode !== null && cfg.staff_mode !== "any" && cfg.staff_mode !== "choose") {
    at("staff_mode", t("appointmentStaffMode"));
  }
  const days = cfg.days_ahead;
  if (days !== undefined && days !== null && !(typeof days === "number" && Number.isInteger(days) &&
      days >= BOOK_APPOINTMENT_LIMITS.daysMin && days <= BOOK_APPOINTMENT_LIMITS.daysMax)) {
    at("days_ahead", t("appointmentDays", { min: BOOK_APPOINTMENT_LIMITS.daysMin, max: BOOK_APPOINTMENT_LIMITS.daysMax }));
  }
  for (const field of BOOK_APPOINTMENT_PORT_FIELDS) {
    const key = cfg[field];
    if (key === undefined || key === null || key === "") {
      if (field === "success_next") at(field, t("nodeNeedsNext"));
    } else if (typeof key !== "string" || !knownKeys.has(key)) {
      at(field, t("nodeMissingNext", { key: String(key) }));
    }
  }
  return issues;
}

/** Outgoing node keys of a book_appointment step (the timeout port is added by the caller). */
export function bookAppointmentEdges(config: Record<string, unknown>): string[] {
  return BOOK_APPOINTMENT_PORT_FIELDS.map((field) => config[field]).filter((key): key is string => typeof key === "string" && key.length > 0);
}

// ------------------------------------------------------------ list replies

/**
 * List row ids. They carry only ids, a local date or a start minute, never
 * customer text, and every reply is re-checked against fresh data.
 */
export const appointmentReplyIds = {
  service: (id: string) => `appt:svc:${id}`,
  staff: (id: string) => `appt:staff:${id}`,
  anyStaff: "appt:staff:any",
  day: (localDate: string) => `appt:day:${localDate}`,
  /** Minutes since the epoch of the slot's start. */
  slot: (startAt: string | Date) => `appt:slot:${Math.round(new Date(startAt).getTime() / 60_000)}`,
  more: "appt:more",
  cancel: "appt:cancel",
} as const;

export type AppointmentReply =
  | { kind: "service"; id: string }
  | { kind: "staff"; id: string | null }
  | { kind: "day"; day: string }
  | { kind: "slot"; startAt: Date }
  | { kind: "more" }
  | { kind: "cancel" };

/** The step's choice a tapped row stands for, or null for anything else. */
export function parseAppointmentReply(replyId: unknown): AppointmentReply | null {
  if (typeof replyId !== "string" || replyId.length > 80 || !replyId.startsWith("appt:")) return null;
  if (replyId === appointmentReplyIds.more) return { kind: "more" };
  if (replyId === appointmentReplyIds.cancel) return { kind: "cancel" };
  if (replyId === appointmentReplyIds.anyStaff) return { kind: "staff", id: null };
  const [, kind, value] = replyId.split(":");
  if (kind === "svc" && UUID.test(value ?? "")) return { kind: "service", id: value };
  if (kind === "staff" && UUID.test(value ?? "")) return { kind: "staff", id: value };
  if (kind === "day" && DATE.test(value ?? "")) return { kind: "day", day: value };
  if (kind === "slot" && /^\d{1,10}$/.test(value ?? "")) return { kind: "slot", startAt: new Date(Number(value) * 60_000) };
  return null;
}

// ------------------------------------------------------------ progress state

export type AppointmentStage = "service" | "staff" | "day" | "slot";

export interface AppointmentStepState {
  /** The question the customer was last asked. */
  stage: AppointmentStage;
  service_id?: string;
  location_id?: string;
  /** undefined = not decided yet; null = any free practitioner. */
  staff_id?: string | null;
  /** Local date (YYYY-MM-DD) chosen at the day question. */
  day?: string;
  /** Zero-based page of the current list. */
  page: number;
  /** A taken slot was already re-offered once. */
  retried?: boolean;
}

const STAGES: unknown[] = ["service", "staff", "day", "slot"];

/** The step's progress from run vars, or null when absent or malformed. */
export function readAppointmentState(vars: Record<string, unknown> | null | undefined): AppointmentStepState | null {
  const raw = vars?.[APPOINTMENT_STATE_VAR];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  if (!STAGES.includes(s.stage)) return null;
  const id = (value: unknown) => (typeof value === "string" && UUID.test(value) ? value : undefined);
  const state: AppointmentStepState = {
    stage: s.stage as AppointmentStage,
    page: typeof s.page === "number" && Number.isInteger(s.page) && s.page >= 0 && s.page < 100 ? s.page : 0,
  };
  if (id(s.service_id)) state.service_id = s.service_id as string;
  if (id(s.location_id)) state.location_id = s.location_id as string;
  if (s.staff_id === null) state.staff_id = null;
  else if (id(s.staff_id)) state.staff_id = s.staff_id as string;
  if (typeof s.day === "string" && DATE.test(s.day)) state.day = s.day;
  if (s.retried === true) state.retried = true;
  return state;
}

// ------------------------------------------------------------ list rows

export interface AppointmentListRow {
  id: string;
  title: string;
  description?: string;
}

/** Meta's 24-character row title cap, cut on a character boundary. */
export function rowTitle(text: string): string {
  const chars = [...text.trim()];
  const max = INTERACTIVE_LIMITS.listRowTitleMaxLength;
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("")}…`;
}

/**
 * One page of choices: up to `pageSize` rows, "More" when further choices
 * exist, and always "Cancel". Never more than WhatsApp's 10 rows.
 */
export function pagedRows<T>(
  items: readonly T[],
  page: number,
  toRow: (item: T) => AppointmentListRow,
  labels: { more: string; cancel: string },
  pageSize: number = BOOK_APPOINTMENT_LIMITS.pageSize,
): AppointmentListRow[] {
  const size = Math.max(1, Math.min(pageSize, INTERACTIVE_LIMITS.maxListRowsTotal - 2));
  const start = Math.max(0, page) * size;
  const rows = items.slice(start, start + size).map(toRow);
  if (items.length > start + size) rows.push({ id: appointmentReplyIds.more, title: rowTitle(labels.more) });
  rows.push({ id: appointmentReplyIds.cancel, title: rowTitle(labels.cancel) });
  return rows;
}

/**
 * One list with no paging: up to nine choices and "Cancel" (WhatsApp's 10
 * rows). For the service question, whose list is capped at
 * BOOK_APPOINTMENT_LIMITS.maxServices, so there is never a "More" row to answer.
 */
export function singleListRows<T>(
  items: readonly T[],
  toRow: (item: T) => AppointmentListRow,
  cancel: string,
): AppointmentListRow[] {
  return [
    ...items.slice(0, INTERACTIVE_LIMITS.maxListRowsTotal - 1).map(toRow),
    { id: appointmentReplyIds.cancel, title: rowTitle(cancel) },
  ];
}

/** Distinct local days that have at least one free slot, in order. */
export function slotDays(slots: ReadonlyArray<{ localDate: string }>): string[] {
  return [...new Set(slots.map((s) => s.localDate))].sort();
}

/** "Mon, 3 Nov" for a local date, in the given locale. */
export function dayLabel(localDate: string, locale = "en"): string {
  const date = new Date(`${localDate}T12:00:00Z`);
  try {
    return new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(date);
  } catch {
    return localDate;
  }
}
