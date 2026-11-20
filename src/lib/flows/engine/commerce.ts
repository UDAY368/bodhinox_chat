// Flow engine, commerce group: moved out of engine.ts (batch 5) without changes; engine.ts re-exports the public names.
import { botRepliesPaused } from "@/lib/whatsapp/bot-pause";
import { isTestContact, isTestUsername, phoneDigits } from "../triggers";
import { minorFromDb, parseMoney } from "@/lib/commerce/money";
import { getWorkerPrisma } from "@/lib/db/prisma";
import { withTenant } from "@/lib/db/tenant";
import { createPaymentLinkRecord, flowOutcomeFor, flowPaymentReference, paymentLinkMessageText, PaymentLinkError } from "@/lib/payments/links";
import { PAYMENT_LINK_LIMITS } from "../payment-node";
import { getT } from "@/lib/i18n/translate";
import * as appointmentRuntime from "../appointment-runtime";
import { APPOINTMENT_STATE_VAR, APPOINTMENT_STATUS_VALUES, BOOK_APPOINTMENT_LIMITS, appointmentDaysAhead, appointmentPortFor, appointmentReplyIds, dayLabel, instagramRows, pagedRows, parseAppointmentReply, readAppointmentState, rowTitle, singleListRows, slotDays, type AppointmentListRow, type AppointmentOutcome, type AppointmentStepState } from "../appointment-node";
import { databaseAdmin } from "../admin-client";
import { flowSend, runChannel } from "../channel-send";
import { resolveFallbackPolicy } from "../fallback";
import { type PaymentLinkNodeConfig, type DispatchInboundResult, type FlowNodeRow, type FlowRunRow, type ParsedInbound } from "../types";
import { closureForActiveRun } from "./helpers";
import { type AdminClient, loadRunGraph, logEvent, runFallbackPolicy, storedInstagramUsername } from "./run";
import { endRun, interpolateOptionalVars, interpolateVars, scheduleReplyTimeout, textValues } from "./control";
import { advanceFromNodeKey, claimReplyTransition, closeActiveRun, lostReplyRace } from "../engine";

export type PaymentOutcome = "paid" | "expired" | "failed";

/** The node a payment outcome continues at, or null when that port is unwired (the run ends). */
export function paymentPortFor(cfg: Partial<PaymentLinkNodeConfig>, outcome: PaymentOutcome): string | null {
  const key = outcome === "paid" ? cfg.paid_next : outcome === "expired" ? cfg.expired_next : cfg.failed_next;
  return typeof key === "string" && key ? key : null;
}

/** How a run ends when a payment outcome has no port. */
/**
 * The text stored with an error event: the message plus, for a Meta refusal, its error_data.details, which names
 * the exact parameter Meta objected to ("Parameter value is not valid" alone does not). Kept in the run's own
 * events (workspace staff only), never in server logs.
 */
export function errorDetail(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const { details, fbtraceId } = err as { details?: unknown; fbtraceId?: unknown };
  const text = typeof details === "string" && details.trim() ? `${err.message} (${details.trim().slice(0, 300)})` : err.message;
  // Meta's trace id lets Meta support find the exact refused request.
  return typeof fbtraceId === "string" && /^[\w-]{1,64}$/.test(fbtraceId) ? `${text} [fbtrace_id ${fbtraceId}]` : text;
}

export function paymentEnd(outcome: PaymentOutcome): { status: "completed" | "failed"; reason: string } {
  return outcome === "failed" ? { status: "failed", reason: "payment_link_failed" } : { status: "completed", reason: `payment_${outcome}` };
}

export async function setRunVars(db: AdminClient, run: FlowRunRow, patch: Record<string, unknown>): Promise<void> {
  const vars = { ...run.vars, ...patch };
  const { error } = await db.from("flow_runs").update({ vars }).eq("id", run.id).eq("status", "active");
  if (error) throw new Error("Run variable write failed");
  run.vars = vars;
}

/** Sends the step's message with the link under it. `attempt` keeps a re-send a distinct outbound intent. */
export async function sendPaymentLinkText(run: FlowRunRow, node: FlowNodeRow, url: string, attempt: number): Promise<string> {
  const cfg = node.config as unknown as PaymentLinkNodeConfig;
  const ws = await textValues(run, cfg.message ?? "");
  const message = interpolateVars(cfg.message ?? "", run.vars, ws);
  const text = paymentLinkMessageText(message, url);
  // On Instagram this goes out as a card with a "Pay now" button (payment-card.ts); on WhatsApp it is the text.
  const { whatsapp_message_id } = await flowSend(run, `flow:${run.id}:${node.node_key}:${run.transition_seq ?? 0}:${attempt}`, { kind: "payment_link", args: {
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    text,
    message,
    url,
  } });
  return whatsapp_message_id;
}

/**
 * Creates (or, on a replay, finds) the step's link and sends it. Returns
 * "waiting" once the link is out, or the port to continue at. A create with
 * an unknown outcome goes to the failed port and stays 'unknown' on the
 * payments page for reconciliation; it is never created again here.
 */
export async function startPaymentLinkNode(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<{ kind: "waiting"; expiresAt: string | null } | { kind: "next"; outcome: PaymentOutcome; key: string | null }> {
  const cfg = node.config as unknown as PaymentLinkNodeConfig;
  const fail = async (reason: string, status = "failed") => {
    await setRunVars(db, run, { payment_status: status }).catch(() => undefined);
    await logEvent(db, run.id, "error", node.node_key, { reason });
    return { kind: "next" as const, outcome: "failed" as const, key: paymentPortFor(cfg, "failed") };
  };
  if (!run.conversation_id || !run.contact_id) return fail("payment_link_no_conversation");
  const ws = await textValues(run, `${cfg.amount ?? ""} ${cfg.description ?? ""}`);
  let amountMinor: number;
  let currency = cfg.currency;
  let orderId: string | null = null;
  if (cfg.link_order === true) {
    // Charge the run's order for what is still due (design E2): never a Meta price while checkout is on.
    const due = await flowOrderDue(run.account_id, run.contact_id, run.vars.order_id);
    if (due.kind === "refused") return fail(`payment_link_${due.reason}`);
    ({ amountMinor, currency, orderId } = due);
  } else {
    try {
      amountMinor = parseMoney(interpolateVars(String(cfg.amount ?? ""), run.vars, ws), cfg.currency);
    } catch {
      return fail("payment_link_invalid_amount");
    }
  }
  const expireBy = new Date(Date.now() + (await paymentLinkExpiryMinutes(db, run, cfg)) * 60_000);
  let link: Awaited<ReturnType<typeof createPaymentLinkRecord>>["link"];
  try {
    ({ link } = await createPaymentLinkRecord({
      accountId: run.account_id,
      actor: { kind: "bot" },
      amountMinor,
      currency,
      description: interpolateOptionalVars(cfg.description, run.vars, ws) || null,
      conversationId: run.conversation_id,
      contactId: run.contact_id,
      orderId,
      flowRunId: run.id,
      nodeKey: node.node_key,
      expireBy,
      referenceId: flowPaymentReference(run.id, node.node_key, run.transition_seq ?? 0),
    }));
  } catch (err) {
    return fail(err instanceof PaymentLinkError ? `payment_link_${err.code}` : "payment_link_failed");
  }
  await setRunVars(db, run, { payment_link_id: link.id, payment_status: link.status, ...(link.short_url ? { payment_link_url: link.short_url } : {}) });
  const settled = flowOutcomeFor(link.status);
  if (settled === "paid" || settled === "expired") {
    // A replay after the link already settled: continue as the webhook would have.
    await logEvent(db, run.id, settled === "paid" ? "payment_received" : "payment_expired", node.node_key, { payment_link_id: link.id, status: link.status });
    return { kind: "next", outcome: settled, key: paymentPortFor(cfg, settled) };
  }
  if (link.status === "failed") return fail("payment_link_rejected");
  if (!link.short_url || !(link.status === "created" || link.status === "partially_paid")) return fail("payment_link_unknown", link.status);
  try {
    const whatsapp_message_id = await sendPaymentLinkText(run, node, link.short_url, run.reprompt_count);
    await logEvent(db, run.id, "payment_link_sent", node.node_key, { payment_link_id: link.id, whatsapp_message_id });
  } catch (err) {
    if (err instanceof Error && err.name === "UncertainDispatchError") {
      // The message may have reached the customer, so wait for the payment rather than move on.
      await logEvent(db, run.id, "error", node.node_key, { reason: "payment_link_send_uncertain", payment_link_id: link.id });
      return { kind: "waiting", expiresAt: link.expires_at };
    }
    return fail("payment_link_send_failed", "send_failed");
  }
  return { kind: "waiting", expiresAt: link.expires_at };
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * What a payment_link step with link_order charges: the order's total minus
 * what was already paid, in the order's currency. A server-priced order uses
 * its frozen total. An unpriced WhatsApp cart (Meta's prices) is refused while
 * store checkout is enabled, so the checkout reprices it instead; with
 * checkout off it keeps the legacy behaviour (the cart total). Only orders
 * still waiting for payment can be charged, and only the run contact's own:
 * order_id is an ordinary variable a customer can type into, so another
 * customer's order reads as no order at all.
 */
export async function flowOrderDue(accountId: string, contactId: string, orderVar: unknown): Promise<
  { kind: "due"; amountMinor: number; currency: string; orderId: string } | { kind: "refused"; reason: string }> {
  if (typeof orderVar !== "string" || !UUID_RE.test(orderVar)) return { kind: "refused", reason: "no_order" };
  return withTenant({ accountId, role: "owner" }, async (tx) => {
    const [order] = await tx.$queryRaw<{ status: string; currency: string; subtotal_minor: bigint; total_minor: bigint | null;
      amount_paid_minor: bigint; priced_at: Date | null; payment_method: string }[]>`
      SELECT status,currency,subtotal_minor,total_minor,amount_paid_minor,priced_at,payment_method FROM orders
      WHERE account_id=${accountId}::uuid AND id=${orderVar}::uuid AND contact_id=${contactId}::uuid`;
    if (!order) return { kind: "refused" as const, reason: "no_order" };
    if (!["new", "confirmed", "awaiting_payment"].includes(order.status)) return { kind: "refused" as const, reason: "order_closed" };
    // A cash-on-delivery order takes no online link: the courier (or staff, as cash) collects it.
    if (order.payment_method === "cod") return { kind: "refused" as const, reason: "order_closed" };
    if (!order.priced_at) {
      const [settings] = await tx.$queryRaw<{ checkout_enabled: boolean }[]>`
        SELECT checkout_enabled FROM commerce_settings WHERE account_id=${accountId}::uuid`;
      if (settings?.checkout_enabled) return { kind: "refused" as const, reason: "order_unpriced" };
    }
    const total = minorFromDb(order.total_minor ?? order.subtotal_minor) ?? 0;
    const amountMinor = total - (minorFromDb(order.amount_paid_minor) ?? 0);
    if (amountMinor <= 0) return { kind: "refused" as const, reason: "order_nothing_due" };
    return { kind: "due" as const, amountMinor, currency: order.currency, orderId: orderVar };
  }, getWorkerPrisma());
}

/**
 * How long the step's link stays payable. Without expire_minutes the link
 * lasts as long as the run would wait (the flow's on_timeout_hours), so a
 * customer can never pay a link whose run has already timed out.
 */
export async function paymentLinkExpiryMinutes(db: AdminClient, run: FlowRunRow, cfg: PaymentLinkNodeConfig): Promise<number> {
  const minutes = cfg.expire_minutes;
  if (typeof minutes === "number" && Number.isInteger(minutes) && minutes > 0) return minutes;
  const hours = resolveFallbackPolicy(await runFallbackPolicy(db, run)).on_timeout_hours;
  return Math.min(PAYMENT_LINK_LIMITS.expireMaxMinutes, Math.max(PAYMENT_LINK_LIMITS.expireMinMinutes, Math.round(hours * 60)));
}

/**
 * Resumes a run waiting on a payment_link step once its link is paid,
 * expired/cancelled or failed. Called after a verified Razorpay webhook or
 * fetch (lib/payments/links). Idempotent: only a run still waiting on that
 * node, in the transition the link was created for, moves. A run a crashed
 * worker already claimed for this outcome (one transition on, sitting on the
 * outcome's port, untouched since) carries on from there; its sends repeat
 * their dispatchOnce keys, so nothing goes out twice.
 */
export async function resumePaymentLinkRun(args: {
  accountId: string;
  runId: string;
  nodeKey: string;
  referenceId: string;
  outcome: PaymentOutcome;
  /** The link's status, stored as vars.payment_status. */
  status: string;
}): Promise<"resumed" | "stale"> {
  const db = databaseAdmin();
  const { data, error } = await db.from("flow_runs").select("*").eq("account_id", args.accountId).eq("id", args.runId).maybeSingle();
  if (error) throw new Error("Payment resume run lookup failed");
  const run = data as FlowRunRow | null;
  if (!run || run.status !== "active" || run.delay_until) return "stale";
  const seq = run.transition_seq ?? 0;
  const due = run.current_node_key === args.nodeKey && flowPaymentReference(run.id, args.nodeKey, seq) === args.referenceId;
  const claimedEarlier = !due && seq > 0 && run.reprompt_count === 0 &&
    flowPaymentReference(run.id, args.nodeKey, seq - 1) === args.referenceId;
  if (!due && !claimedEarlier) return "stale";
  const { flow, nodes } = await loadRunGraph(db, run);
  const node = nodes.get(args.nodeKey);
  if (!node || node.node_type !== "payment_link") return "stale";
  const cfg = node.config as unknown as PaymentLinkNodeConfig;
  const next = paymentPortFor(cfg, args.outcome);
  if (claimedEarlier && (!next || run.current_node_key !== next)) return "stale";
  const now = new Date();
  const { data: contact } = await db.from("contacts").select("blocked_at,phone").eq("account_id", run.account_id).eq("id", run.contact_id!).maybeSingle();
  const testContact = Boolean(flow) && (isTestContact(flow!, phoneDigits((contact as { phone?: string | null } | null)?.phone))
    || ((flow!.test_usernames ?? []).length > 0 && Boolean(run.conversation_id)
      && isTestUsername(flow!, await storedInstagramUsername(run.account_id, run.contact_id!, run.conversation_id!))));
  const closure = closureForActiveRun({ run, flow, nodeKeys: nodes, now, testContact });
  if (closure) {
    await closeActiveRun(db, run, closure, now);
    return "resumed";
  }
  // An agent took over or the contact was blocked while the run waited: no more bot messages.
  if (!run.conversation_id || !contact || (contact as { blocked_at?: string | null }).blocked_at ||
      (await botRepliesPaused(run.account_id, run.conversation_id))) {
    await endRun(db, run.id, "cancelled", "bot_paused_during_wait");
    return "resumed";
  }
  if (claimedEarlier) {
    await advanceFromNodeKey(db, run, next!, nodes);
    return "resumed";
  }
  const vars = { ...run.vars, payment_status: args.status };
  const event = args.outcome === "paid" ? "payment_received" : args.outcome === "expired" ? "payment_expired" : "error";
  if (!next) {
    const { data: claimed } = await db.from("flow_runs").update({ vars }).eq("id", run.id).eq("status", "active")
      .eq("current_node_key", args.nodeKey).eq("transition_seq", run.transition_seq ?? 0).select("id");
    if (!Array.isArray(claimed) || claimed.length !== 1) return "stale";
    await logEvent(db, run.id, event, args.nodeKey, { status: args.status });
    const end = paymentEnd(args.outcome);
    await endRun(db, run.id, end.status, end.reason);
    return "resumed";
  }
  if (!(await claimReplyTransition(db, run, next, { vars }))) return "stale";
  run.vars = vars;
  await logEvent(db, run.id, event, args.nodeKey, { status: args.status });
  await advanceFromNodeKey(db, run, next, nodes);
  return "resumed";
}

// ============================================================
// Book appointment step. One node asks up to four questions (service,
// practitioner, day, time) as WhatsApp lists. Each question after the
// first is sent after a transition back onto the same node, so every
// prompt has its own outbound intent and its own reply timeout, and a
// stale tap on an earlier list cannot move the run. The tapped time is
// booked through lib/appointments with source_ref
// flow:<run>:<node>:<transition_seq> (appointment-runtime), so a replayed
// reply finds the booking it already made. Progress lives in
// vars._appointment (ids, a local date and a page; no customer content)
// and is removed when the step ends.
// ============================================================

export interface AppointmentPrompt {
  state: AppointmentStepState;
  text: string;
  rows: AppointmentListRow[];
}

export type AppointmentProgress = Omit<AppointmentStepState, "stage">;

export const appointmentT = () => getT("Flows.builder.appointment");
export const appointmentLocale = () => process.env.NEXT_PUBLIC_APP_LOCALE || "en";

export function withoutAppointmentState(vars: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...vars };
  delete rest[APPOINTMENT_STATE_VAR];
  return rest;
}

/**
 * The next question to ask from `from`, resolving every question that has
 * one possible answer (a single service, one location, no practitioner
 * choice). Null when nothing can be booked.
 */
export async function planAppointmentPrompt(run: FlowRunRow, node: FlowNodeRow, from: AppointmentProgress, notice?: string): Promise<AppointmentPrompt | null> {
  const cfg = node.config;
  const tx = appointmentT();
  const cancel = tx("cancelRow");
  const body = (prompt: string) => (notice ? `${notice}\n\n${prompt}` : prompt);
  const state: AppointmentProgress = { ...from };
  if (!state.service_id) {
    const services = await appointmentRuntime.appointmentServices(run.account_id, cfg);
    if (!services.length) return null;
    if (services.length > 1) {
      return {
        state: { ...state, stage: "service", page: 0 },
        text: body(tx("promptService")),
        // Every offered service (at most maxServices = 9) and Cancel: one list, no "More".
        rows: singleListRows(services, (s) => ({ id: appointmentReplyIds.service(s.id), title: rowTitle(s.name) }), cancel),
      };
    }
    state.service_id = services[0].id;
  }
  if (!state.location_id) {
    const configured = typeof cfg.location_id === "string" ? cfg.location_id : null;
    const location = await appointmentRuntime.appointmentLocation(run.account_id, state.service_id, configured);
    if (!location) return null;
    state.location_id = location;
  }
  if (state.staff_id === undefined) {
    const staff = cfg.staff_mode === "choose" ? await appointmentRuntime.appointmentStaff(run.account_id, state.service_id, state.location_id) : [];
    if (staff.length > 1) {
      // "Any practitioner", up to eight names and Cancel: WhatsApp's ten rows.
      return {
        state: { ...state, stage: "staff", page: 0 },
        text: body(tx("promptStaff")),
        rows: [
          { id: appointmentReplyIds.anyStaff, title: rowTitle(tx("staffAny")) },
          ...staff.slice(0, BOOK_APPOINTMENT_LIMITS.pageSize).map((s) => ({ id: appointmentReplyIds.staff(s.id), title: rowTitle(s.name) })),
          { id: appointmentReplyIds.cancel, title: rowTitle(cancel) },
        ],
      };
    }
    state.staff_id = staff.length === 1 ? staff[0].id : null;
  }
  const base = { serviceId: state.service_id, locationId: state.location_id, staffId: state.staff_id };
  if (!state.day) {
    const days = slotDays(await appointmentRuntime.appointmentSlots(run.account_id, { ...base, days: appointmentDaysAhead(cfg) }));
    if (!days.length) return null;
    const page = state.page * BOOK_APPOINTMENT_LIMITS.pageSize < days.length ? state.page : 0;
    const locale = appointmentLocale();
    return {
      state: { ...state, stage: "day", page },
      text: body(tx("promptDay")),
      rows: pagedRows(days, page, (d) => ({ id: appointmentReplyIds.day(d), title: rowTitle(dayLabel(d, locale)) }), { more: tx("moreDates"), cancel }),
    };
  }
  const slots = await appointmentRuntime.appointmentSlots(run.account_id, { ...base, fromDay: state.day, days: 1 });
  // That day filled up meanwhile: offer the days again.
  if (!slots.length) return planAppointmentPrompt(run, node, { ...state, day: undefined, page: 0 }, notice);
  const page = state.page * BOOK_APPOINTMENT_LIMITS.pageSize < slots.length ? state.page : 0;
  return {
    state: { ...state, stage: "slot", page },
    text: body(tx("promptSlot")),
    rows: pagedRows(slots, page, (s) => ({ id: appointmentReplyIds.slot(s.startAt), title: rowTitle(s.hhmm) }), { more: tx("later"), cancel }),
  };
}

/**
 * Sends one question: a WhatsApp list, or on Instagram (B8) the same rows as
 * quick replies (titles cut to 20 characters; flowSend refuses before the
 * intent when the 24-hour window has closed). `attempt` keeps a re-prompt a
 * distinct outbound intent.
 */
export async function sendAppointmentPrompt(db: AdminClient, run: FlowRunRow, node: FlowNodeRow, prompt: AppointmentPrompt, attempt: number): Promise<void> {
  const rows = (await runChannel(run)) === "instagram" ? instagramRows(prompt.rows) : prompt.rows;
  const { whatsapp_message_id } = await flowSend(run, `flow:${run.id}:${node.node_key}:${run.transition_seq ?? 0}:${attempt}`, { kind: "list", args: {
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText: prompt.text,
    buttonLabel: appointmentT()("listButton"),
    sections: [{ rows }],
  } });
  // The stage only: row titles can carry practitioner names, never logged.
  await logEvent(db, run.id, "message_sent", node.node_key, { node_type: "book_appointment", stage: prompt.state.stage, whatsapp_message_id });
  const { data: msg } = await db.from("messages").select("id").eq("message_id", whatsapp_message_id).maybeSingle();
  await db.from("flow_runs").update({ last_prompt_message_id: (msg as { id: string } | null)?.id ?? null }).eq("id", run.id);
}

/**
 * Entering the step: asks the first question that needs the customer, or
 * returns the port to continue at when nothing can be booked.
 */
export async function startAppointmentStep(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<{ kind: "waiting" } | { kind: "next"; outcome: AppointmentOutcome; key: string | null } | { kind: "failed" }> {
  // The public booking page, so an Unavailable path can send {{vars.booking_link}} (B10). Not customer data.
  const bookingLink = await appointmentRuntime.appointmentBookingLink(run.account_id).catch(() => null);
  const linkVars: Record<string, unknown> = bookingLink ? { booking_link: bookingLink } : {};
  const unavailable = async (reason: string) => {
    await logEvent(db, run.id, "error", node.node_key, { reason });
    if (APPOINTMENT_STATE_VAR in run.vars || bookingLink) {
      const vars = { ...withoutAppointmentState(run.vars), ...linkVars };
      const { error } = await db.from("flow_runs").update({ vars }).eq("id", run.id).eq("status", "active");
      if (!error) run.vars = vars;
    }
    return { kind: "next" as const, outcome: "unavailable" as const, key: appointmentPortFor(node.config, "unavailable") };
  };
  if (!run.conversation_id || !run.contact_id) return unavailable("appointment_no_conversation");
  let prompt: AppointmentPrompt | null;
  try {
    prompt = await planAppointmentPrompt(run, node, { page: 0 });
  } catch (err) {
    return unavailable(`appointment_lookup_failed:${err instanceof Error ? err.name : "error"}`);
  }
  if (!prompt) {
    const paidOnly = await appointmentRuntime.appointmentPaidOnly(run.account_id, node.config).catch(() => false);
    return unavailable(paidOnly ? "appointment_paid_only" : "appointment_no_slots");
  }
  try {
    await setRunVars(db, run, { [APPOINTMENT_STATE_VAR]: prompt.state, ...linkVars });
    await sendAppointmentPrompt(db, run, node, prompt, run.reprompt_count);
  } catch (err) {
    await logEvent(db, run.id, "error", node.node_key, { reason: "book_appointment_failed", detail: errorDetail(err) });
    await endRun(db, run.id, "failed", "book_appointment_failed");
    return { kind: "failed" };
  }
  return { kind: "waiting" };
}

/** Leaves the step through an outcome port (an unwired one ends the run), dropping its progress. */
export async function finishAppointmentStep(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
  nodes: Map<string, FlowNodeRow>,
  outcome: AppointmentOutcome,
  extraVars: Record<string, unknown> = {},
): Promise<DispatchInboundResult> {
  const vars = { ...withoutAppointmentState(run.vars), ...extraVars };
  const next = appointmentPortFor(node.config, outcome);
  if (!next) {
    const { data: claimed } = await db.from("flow_runs").update({ vars }).eq("id", run.id).eq("status", "active")
      .eq("current_node_key", node.node_key).eq("transition_seq", run.transition_seq ?? 0).select("id");
    if (!Array.isArray(claimed) || claimed.length !== 1) return lostReplyRace(db, run, node.node_key);
    await endRun(db, run.id, "completed", `appointment_${outcome}`);
    return { consumed: true, flow_run_id: run.id, outcome: "completed" };
  }
  if (!(await claimReplyTransition(db, run, next, { vars }))) return lostReplyRace(db, run, node.node_key);
  run.vars = vars;
  const advanced = await advanceFromNodeKey(db, run, next, nodes);
  return { consumed: true, flow_run_id: run.id, outcome: advanced.outcome };
}

/** Moves to the next question: a transition back onto this node, then the list and its timeout. */
export async function askNextAppointmentQuestion(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
  prompt: AppointmentPrompt,
): Promise<DispatchInboundResult> {
  const vars = { ...run.vars, [APPOINTMENT_STATE_VAR]: prompt.state };
  if (!(await claimReplyTransition(db, run, node.node_key, { vars }))) return lostReplyRace(db, run, node.node_key);
  run.vars = vars;
  try {
    await sendAppointmentPrompt(db, run, node, prompt, 0);
  } catch (err) {
    await logEvent(db, run.id, "error", node.node_key, { reason: "book_appointment_failed", detail: errorDetail(err) });
    await endRun(db, run.id, "failed", "book_appointment_failed");
    return { consumed: true, flow_run_id: run.id, outcome: "completed" };
  }
  await scheduleReplyTimeout(db, run, node);
  return { consumed: true, flow_run_id: run.id, outcome: "advanced" };
}

/** An off-script reply: the same question again with a hint, at most twice, then the unavailable port. */
export async function retryAppointmentQuestion(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
  nodes: Map<string, FlowNodeRow>,
  state: AppointmentStepState,
): Promise<DispatchInboundResult> {
  const attempt = run.reprompt_count + 1;
  await logEvent(db, run.id, "input_invalid", node.node_key, { attempt, max_attempts: BOOK_APPOINTMENT_LIMITS.maxInvalid + 1 });
  if (attempt > BOOK_APPOINTMENT_LIMITS.maxInvalid) {
    await logEvent(db, run.id, "error", node.node_key, { reason: "appointment_invalid_replies" });
    return finishAppointmentStep(db, run, node, nodes, "unavailable");
  }
  const progress: AppointmentProgress = { ...state };
  delete (progress as Partial<AppointmentStepState>).stage;
  const prompt = await planAppointmentPrompt(run, node, progress, appointmentT()("invalidChoice"));
  if (!prompt) {
    await logEvent(db, run.id, "error", node.node_key, { reason: "appointment_no_slots" });
    return finishAppointmentStep(db, run, node, nodes, "unavailable");
  }
  const vars = { ...run.vars, [APPOINTMENT_STATE_VAR]: prompt.state };
  const { data, error } = await db.from("flow_runs").update({ reprompt_count: attempt, vars }).eq("id", run.id).eq("status", "active")
    .eq("current_node_key", node.node_key).eq("transition_seq", run.transition_seq ?? 0).eq("reprompt_count", run.reprompt_count).select("id");
  if (error || !Array.isArray(data) || data.length !== 1) return lostReplyRace(db, run, node.node_key);
  run.reprompt_count = attempt;
  run.vars = vars;
  try {
    await sendAppointmentPrompt(db, run, node, prompt, attempt);
  } catch (err) {
    // The customer still has the earlier list and can tap it.
    await logEvent(db, run.id, "error", node.node_key, { reason: "reprompt_send_failed", detail: errorDetail(err) });
  }
  return { consumed: true, flow_run_id: run.id, outcome: "fallback_fired" };
}

/** A customer reply while the step waits: the next question, a booking, Cancel, or a re-prompt. */
export async function handleAppointmentReply(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
  message: ParsedInbound,
  nodes: Map<string, FlowNodeRow>,
): Promise<DispatchInboundResult> {
  const state = readAppointmentState(run.vars);
  if (!state) {
    await logEvent(db, run.id, "error", node.node_key, { reason: "appointment_state_missing" });
    return finishAppointmentStep(db, run, node, nodes, "unavailable");
  }
  const reply = message.kind === "interactive_reply" ? parseAppointmentReply(message.reply_id) : null;
  if (reply?.kind === "cancel") return finishAppointmentStep(db, run, node, nodes, "cancelled");
  const chosen = { service_id: state.service_id, location_id: state.location_id, staff_id: state.staff_id, retried: state.retried };
  let next: AppointmentProgress | null = null;
  let notice: string | undefined;
  const lookupFailed = async (err: unknown) => {
    await logEvent(db, run.id, "error", node.node_key, { reason: "appointment_lookup_failed", detail: err instanceof Error ? err.name : "error" });
    return finishAppointmentStep(db, run, node, nodes, "unavailable");
  };
  if (state.stage === "slot" && reply?.kind === "slot" && state.day && state.service_id && state.location_id && run.contact_id) {
    let result: appointmentRuntime.AppointmentBookResult;
    try {
      result = await appointmentRuntime.bookFlowAppointment(run.account_id, {
        runId: run.id,
        nodeKey: node.node_key,
        transitionSeq: run.transition_seq ?? 0,
        contactId: run.contact_id,
        serviceId: state.service_id,
        locationId: state.location_id,
        staffId: state.staff_id ?? null,
        startAt: reply.startAt,
        conversationId: run.conversation_id,
      });
    } catch (err) {
      // The booking transaction rolled back.
      return lookupFailed(err);
    }
    if (result.ok) {
      // Committed: from here on a failure must not fall into the unavailable
      // port. A crash before the success claim is finished by the retried
      // inbound (resumeInterruptedBooking), which replays this source_ref.
      // Ids only; the manage link never goes into vars (flow.completed webhooks carry them).
      // A paid service (A6) is held, not booked: its payment link goes out as a queued job and
      // settlement confirms it; the run continues now with appointment_status "waiting_for_payment".
      const paymentPending = result.status === "payment_pending";
      await logEvent(db, run.id, "node_entered", node.node_key, {
        appointment_result: paymentPending ? "payment_pending" : "booked", appointment_id: result.appointmentId, replayed: result.replayed,
      });
      return finishAppointmentStep(db, run, node, nodes, "success", {
        appointment_id: result.appointmentId,
        appointment_local_time: result.localTime,
        appointment_status: paymentPending ? APPOINTMENT_STATUS_VALUES.paymentPending : APPOINTMENT_STATUS_VALUES.confirmed,
      });
    }
    await logEvent(db, run.id, "error", node.node_key, { reason: `appointment_${result.code}` });
    if (result.code !== "slot_unavailable" || state.retried) return finishAppointmentStep(db, run, node, nodes, "unavailable");
    // Taken a moment ago: offer that day's remaining times once.
    next = { ...chosen, day: state.day, page: 0, retried: true };
    notice = appointmentT()("slotTaken");
  }
  try {
    if (next) {
      // The tapped time was just taken: re-offer that day below.
    } else if (state.stage === "service" && reply?.kind === "service") {
      const services = await appointmentRuntime.appointmentServices(run.account_id, node.config);
      if (services.some((s) => s.id === reply.id)) next = { service_id: reply.id, page: 0 };
    } else if (state.stage === "staff" && reply?.kind === "staff" && state.service_id && state.location_id) {
      const staff = reply.id === null ? [] : await appointmentRuntime.appointmentStaff(run.account_id, state.service_id, state.location_id);
      if (reply.id === null || staff.some((s) => s.id === reply.id)) next = { ...chosen, staff_id: reply.id, page: 0 };
    } else if (state.stage === "day" && reply?.kind === "day") {
      next = { ...chosen, day: reply.day, page: 0 };
    } else if (state.stage === "day" && reply?.kind === "more") {
      next = { ...chosen, page: state.page + 1 };
    } else if (state.stage === "slot" && reply?.kind === "more" && state.day) {
      next = { ...chosen, day: state.day, page: state.page + 1 };
    }
    if (!next) return retryAppointmentQuestion(db, run, node, nodes, state);
    const prompt = await planAppointmentPrompt(run, node, next, notice);
    if (!prompt) {
      await logEvent(db, run.id, "error", node.node_key, { reason: "appointment_no_slots" });
      return finishAppointmentStep(db, run, node, nodes, "unavailable");
    }
    return askNextAppointmentQuestion(db, run, node, prompt);
  } catch (err) {
    // A lookup that failed outright.
    return lookupFailed(err);
  }
}

/**
 * A retried inbound job whose reply was already recorded (isDuplicateInbound)
 * is normally ignored. A time tap is the exception: when the worker stopped
 * after recording it but before the step moved on, the run still waits at
 * the same transition with the same time question, and the booking may
 * already be committed. The tap is then handled again: bookFlowAppointment
 * replays source_ref flow:<run>:<node>:<seq> (or books it if the first try
 * rolled back) and the step leaves through its port. Every completed handling
 * of a time tap moves transition_seq (or ends the run), so a match on the
 * recorded transition proves the first handling did not finish, and nothing
 * already sent is sent again. Null for an ordinary duplicate.
 */
export async function resumeInterruptedBooking(
  db: AdminClient,
  run: FlowRunRow,
  message: ParsedInbound,
): Promise<DispatchInboundResult | null> {
  if (message.kind !== "interactive_reply" || parseAppointmentReply(message.reply_id)?.kind !== "slot") return null;
  if (readAppointmentState(run.vars)?.stage !== "slot" || !run.current_node_key) return null;
  const { data: recorded } = await db
    .from("flow_run_events")
    .select("node_key,payload")
    .eq("flow_run_id", run.id)
    .eq("event_type", "reply_received")
    .filter("payload->>meta_message_id", "eq", message.meta_message_id);
  const seq = run.transition_seq ?? 0;
  const rows = (recorded ?? []) as Array<{ node_key: string | null; payload: Record<string, unknown> | null }>;
  if (!rows.some((e) => e.node_key === run.current_node_key && e.payload?.transition_seq === seq)) return null;
  const { flow, nodes } = await loadRunGraph(db, run);
  const node = nodes.get(run.current_node_key);
  if (!flow || node?.node_type !== "book_appointment") return null;
  return handleAppointmentReply(db, run, node, message, nodes);
}
