// Flow engine, control group: moved out of engine.ts (batch 5) without changes; engine.ts re-exports the public names.
import { botRepliesPaused } from "@/lib/whatsapp/bot-pause";
import { enqueueJob } from "@/lib/jobs/queue";
import { isTestContact, isTestUsername, phoneDigits } from "../triggers";
import { conversionValue, isConversionEventName } from "../conversion-node";
import { queueConversionEvent } from "@/lib/meta-ads/capi";
import { isCurrencyCode } from "@/lib/commerce/money";
import { getWorkerPrisma } from "@/lib/db/prisma";
import { withTenant } from "@/lib/db/tenant";
import { flowAiTurnStarted, runFlowAiReply } from "@/lib/ai/flow-reply";
import { AI_REPLY_LIMITS, aiReplyMaxTurns } from "../ai-reply-node";
import { customPlaceholderIds, fillPlaceholders, usesContactPlaceholders, type PlaceholderContact } from "../placeholders";
import { actionList, queuedFlowStarts, runActions, type ActionsResult } from "../nodes/actions";
import { planSmartDelay } from "../nodes/smart-delay";
import { runGoalTurn } from "@/lib/ai/goals";
import { instagramAutomationAllowed } from "@/lib/contacts/channel-consent";
import { workspaceTimezone } from "@/lib/analytics/range";
import { APPOINTMENT_STATE_VAR } from "../appointment-node";
import { databaseAdmin } from "../admin-client";
import { dispatchWebhookEvent } from "@/lib/webhooks/deliver";
import { runChannel } from "../channel-send";
import { scopeIncludes } from "@/lib/channels/capabilities";
import { workspaceValuesFor } from "@/lib/workspace/attributes";
import { type AiReplyNodeConfig, type DispatchInboundResult, type FlowNodeRow, type FlowRunRow, type ParsedInbound, type SmartDelayNodeConfig } from "../types";
import { closureForActiveRun, nodeTimeout } from "./helpers";
import { type AdminClient, loadFlow, loadRunGraph, logEvent, storedInstagramUsername } from "./run";
import { errorDetail, withoutAppointmentState } from "./commerce";
import { advanceFromNodeKey, claimReplyTransition, closeActiveRun, lostReplyRace, mergeWaitingRunVars } from "../engine";
import { startFlowById } from "./start";

/**
 * Tiny `{{vars.foo}}` (and `{{workspace.key}}`) interpolation. Used by send_message + collect_input
 * prompt text so a captured `name` can show up in the next prompt
 * ("Thanks {{vars.name}}, what's your email?"). Missing vars render as
 * empty string — the same behavior as the automations engine.
 */
export function interpolateVars(template: string, vars: Record<string, unknown>, workspace: Record<string, string> = {}): string {
  if (!template) return "";
  // Workspace first: captured vars are customer input and must not expand placeholders
  // (one pass in fillPlaceholders). Stage 5 adds {{contact.*}}, {{custom.<id>}} and fallbacks;
  // the contact's values ride on the workspace record (textValues), so callers are unchanged.
  return fillPlaceholders(template, vars, workspace, (workspace as WithContact)[CONTACT_VALUES] ?? {});
}

export const CONTACT_VALUES = Symbol("contactPlaceholders");
export type WithContact = Record<string, string> & { [CONTACT_VALUES]?: PlaceholderContact };

/**
 * The values a step's text may use: workspace values (only queried when the
 * text has a workspace placeholder) and, when it uses {{contact.*}} or
 * {{custom.<id>}}, the run's contact. Read fresh for each step.
 */
export async function textValues(run: Pick<FlowRunRow, "account_id" | "contact_id" | "conversation_id">, text: string): Promise<Record<string, string>> {
  const ws = await workspaceValuesFor(run.account_id, text);
  if (!run.contact_id || !usesContactPlaceholders(text)) return ws;
  const contact = await loadPlaceholderContact(run.account_id, run.contact_id, run.conversation_id, customPlaceholderIds(text));
  return Object.assign({ ...ws }, { [CONTACT_VALUES]: contact }) as WithContact;
}

/** The contact's own fields, Instagram username (this conversation's account) and the named custom fields. */
export async function loadPlaceholderContact(accountId: string, contactId: string, conversationId: string | null, customIds: string[]): Promise<PlaceholderContact> {
  return withTenant({ accountId, role: "owner" }, async (tx) => {
    const [row] = await tx.$queryRaw<{ name: string | null; email: string | null; phone: string | null; company: string | null; username: string | null }[]>`
      SELECT c.name, c.email, c.phone, c.company,
        (SELECT i.username FROM conversations v JOIN contact_channel_identities i ON i.account_id=v.account_id
            AND i.contact_id=v.contact_id AND i.instagram_account_id=v.instagram_account_id AND i.channel='instagram'
          WHERE v.account_id=c.account_id AND v.id=${conversationId}::uuid AND v.contact_id=c.id LIMIT 1) AS username
      FROM contacts c WHERE c.account_id=${accountId}::uuid AND c.id=${contactId}::uuid`;
    const ids = customIds.filter((id) => /^[0-9a-f-]{36}$/.test(id));
    const custom = ids.length ? await tx.$queryRaw<{ id: string; value: string | null }[]>`
      SELECT custom_field_id::text AS id, value FROM contact_custom_values
      WHERE account_id=${accountId}::uuid AND contact_id=${contactId}::uuid AND custom_field_id = ANY(${ids}::uuid[])` : [];
    return {
      fields: row ? { name: row.name, email: row.email, phone: row.phone, company: row.company, username: row.username } : {},
      custom: Object.fromEntries(custom.map((c) => [c.id, c.value])),
    };
  }, getWorkerPrisma());
}

/**
 * `interpolateVars` for optional config fields (header_text, footer_text,
 * list section titles, row descriptions). An absent field stays absent
 * — `interpolateVars(undefined)` would return "" and meta-api treats
 * header/footer/description by truthiness, so "" is harmless there, but
 * keeping `undefined` means the payload we log and send matches what
 * the author configured rather than sprouting empty strings.
 */
export function interpolateOptionalVars(
  template: string | undefined,
  vars: Record<string, unknown>,
  workspace: Record<string, string> = {},
): string | undefined {
  return template === undefined || template === null
    ? undefined
    : interpolateVars(template, vars, workspace);
}

/**
 * One AI turn of an ai_reply step (lib/ai/flow-reply.ts) and its event:
 * `ai_replied` with the score and citations (document ids, titles and
 * urls, never content) or `ai_handoff` with a reason code. Returns the
 * port to follow, or null to keep waiting for the next follow-up, plus
 * the run vars to store (the answer under var_key).
 */
export async function aiReplyTurn(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
  intentKey: string,
  answerNumber: number,
): Promise<{ next: string | null; vars?: Record<string, unknown>; ended?: true }> {
  const cfg = node.config as unknown as Partial<AiReplyNodeConfig>;
  const outcome = await runFlowAiReply({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    config: cfg,
    intentKey,
  });
  if (outcome.kind === "answered") {
    await logEvent(db, run.id, "ai_replied", node.node_key, {
      whatsapp_message_id: outcome.whatsappMessageId,
      score: outcome.score,
      turn: answerNumber,
      citations: outcome.citations,
    });
    const vars = cfg.var_key ? { ...run.vars, [cfg.var_key]: outcome.text.slice(0, AI_REPLY_LIMITS.varValue) } : undefined;
    return { next: answerNumber < aiReplyMaxTurns(node.config) ? null : cfg.next_node_key ?? "", vars };
  }
  if (outcome.kind === "unavailable" && (outcome.reason === "send_uncertain" || outcome.reason === "turn_uncertain")) {
    // The answer may have reached the customer (or the turn may already be
    // billed): never follow the handoff port or send more bot messages on
    // top of it. End the run, like send_message does, for reconciliation.
    const reason = `ai_reply_${outcome.reason}`;
    await logEvent(db, run.id, "error", node.node_key, { reason, turn: answerNumber });
    await endRun(db, run.id, "failed", reason);
    return { next: null, ended: true };
  }
  await logEvent(db, run.id, "ai_handoff", node.node_key, outcome.kind === "handoff"
    ? { reason: outcome.reason, score: outcome.score, turn: answerNumber, citations: outcome.citations }
    : { reason: outcome.reason, turn: answerNumber });
  return { next: cfg.handoff_next ?? "" };
}

/**
 * A follow-up message on an ai_reply step that is waiting. The turn is
 * claimed first (transition_seq moves on, so the old reply timeout goes
 * stale and two inbounds cannot both answer), then answered under an
 * outbound intent keyed by the inbound message. The step moves on after
 * its last allowed answer, or through its handoff port.
 */
export async function continueAiReplyNode(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
  nodes: Map<string, FlowNodeRow>,
  inboundMessageId: string,
): Promise<DispatchInboundResult> {
  const intentKey = `flow-ai:${run.id}:${inboundMessageId}`;
  // A retry of this inbound (the worker stopped after the turn began)
  // already claimed and counted it: replay that turn instead of claiming
  // another, so the turn counter does not skip and the AI is not re-run.
  let turns = run.reprompt_count;
  if (!(await flowAiTurnStarted(run.account_id, intentKey))) {
    const seq = (run.transition_seq ?? 0) + 1;
    turns = run.reprompt_count + 1;
    const { data, error } = await db
      .from("flow_runs")
      .update({ transition_seq: seq, reprompt_count: turns, last_advanced_at: new Date().toISOString() })
      .eq("id", run.id)
      .eq("status", "active")
      .eq("current_node_key", node.node_key)
      .eq("transition_seq", run.transition_seq ?? 0)
      .eq("reprompt_count", run.reprompt_count)
      .select("id");
    if (error || !Array.isArray(data) || data.length !== 1) return lostReplyRace(db, run, node.node_key);
    Object.assign(run, { transition_seq: seq, reprompt_count: turns });
  }
  // Answers sent so far on this step: the first one plus one per follow-up.
  const turn = await aiReplyTurn(db, run, node, intentKey, turns + 1);
  if (turn.ended) return { consumed: true, flow_run_id: run.id, outcome: "completed" };
  if (turn.next === null) {
    if (turn.vars) await mergeWaitingRunVars(db, run, turn.vars as Record<string, string>);
    await scheduleReplyTimeout(db, run, node);
    return { consumed: true, flow_run_id: run.id, outcome: "waiting" };
  }
  if (!(await claimReplyTransition(db, run, turn.next, turn.vars ? { vars: turn.vars } : {}))) {
    return lostReplyRace(db, run, node.node_key);
  }
  if (turn.vars) run.vars = turn.vars;
  const outcome = await advanceFromNodeKey(db, run, turn.next, nodes);
  return { consumed: true, flow_run_id: run.id, outcome: outcome.outcome };
}

/**
 * Ends a run that is still active. A run an agent paused or the sweep timed
 * out meanwhile keeps that ending (and emits no flow.completed). Returns
 * whether this call ended the run.
 */
export async function endRun(
  db: AdminClient,
  runId: string,
  status: "completed" | "handed_off" | "timed_out" | "failed" | "cancelled",
  reason: string,
): Promise<boolean> {
  const { data, error } = await db
    .from("flow_runs")
    .update({
      status,
      ended_at: new Date().toISOString(),
      end_reason: reason,
      wait_until: null,
    })
    .eq("id", runId)
    .eq("status", "active")
    .select("id,account_id,flow_id,contact_id,conversation_id,vars,user_id");
  if (error) throw new Error("Flow run end failed");
  const row = (data as Record<string, unknown>[] | null)?.[0];
  if (!row) return false;
  // Queued start_flow starts follow only a run that finished normally: never one
  // cancelled (opted out, window closed, stopped), failed, handed off, timed out
  // or ended because its own Actions step paused automations.
  if (status === "completed" && reason !== "automations_paused") await startQueuedFlows(row);
  if (status !== "completed") return true;
  // Best-effort: the run already ended and its messages went out, so a
  // failed enqueue must not mark the inbound stage uncertain.
  await dispatchWebhookEvent(db, row.account_id as string, "flow.completed", {
    flow_run_id: row.id,
    flow_id: row.flow_id,
    contact_id: row.contact_id,
    conversation_id: row.conversation_id,
    vars: row.vars,
    end_reason: reason,
  }).catch(() => console.error("[flows] flow.completed webhook enqueue failed", { runId }));
  return true;
}

/** How many start_flow hops led to a run (run variable), and the most a chain may take. */
export const START_DEPTH_VAR = "_start_depth";
export const START_FLOW_MAX_CHAIN = 5;
export function startChainDepth(vars: Readonly<Record<string, unknown>>): number {
  const raw = vars[START_DEPTH_VAR];
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : 0;
}

/**
 * The flows an Actions step queued with start_flow (Stage 5). A conversation
 * has one active run, so they start once this run has ended, in order, each
 * through startFlowById (live flow of this workspace, on this channel, bot not
 * paused). Ids only are logged; a failure never undoes the run's ending.
 */
export async function startQueuedFlows(row: Record<string, unknown>): Promise<void> {
  const vars = row.vars && typeof row.vars === "object" ? row.vars as Record<string, unknown> : {};
  const flowIds = queuedFlowStarts(vars).filter((id) => id !== row.flow_id);
  if (!flowIds.length || typeof row.contact_id !== "string" || typeof row.conversation_id !== "string") return;
  // Flows that start each other in a ring stop after START_FLOW_MAX_CHAIN hops (the validator flags such rings too).
  const depth = startChainDepth(vars) + 1;
  if (depth > START_FLOW_MAX_CHAIN) {
    console.warn("[flows] start_flow chain limit reached", { runId: row.id });
    return;
  }
  // Unsubscribed on Instagram (5D consent): no further automated flow starts there.
  const accountId = row.account_id as string;
  const { data: conv } = await databaseAdmin().from("conversations").select("channel")
    .eq("account_id", accountId).eq("id", row.conversation_id).maybeSingle();
  if ((conv as { channel?: string | null } | null)?.channel === "instagram"
    && !(await instagramAutomationAllowed(accountId, row.contact_id))) {
    console.warn("[flows] queued flow not started", { runId: row.id, outcome: "contact_opted_out" });
    return;
  }
  for (const flowId of flowIds) {
    try {
      const started = await startFlowById({
        accountId, userId: row.user_id as string, contactId: row.contact_id,
        conversationId: row.conversation_id, flowId, vars: { [START_DEPTH_VAR]: depth },
        message: { kind: "text", text: "", meta_message_id: `start-flow:${row.id as string}:${flowId}` },
      });
      if (started.outcome === "started") break;
      console.warn("[flows] queued flow not started", { runId: row.id, flowId, outcome: started.outcome });
    } catch {
      console.error("[flows] queued flow start failed", { runId: row.id, flowId });
    }
  }
}

// ============================================================
// Timers. A delay or a wait-for-reply timeout is a `flow.timer` job
// keyed by the run's transition_seq: any reply, timer or delay moves
// the seq on, so a timer that lost its race finds a different seq and
// does nothing.
// ============================================================

export type TimerKind = "delay" | "timeout";

export function timerKey(runId: string, seq: number, kind: TimerKind, nodeKey: string): string {
  return `flow-timer:${runId}:${seq}:${kind}:${nodeKey}`;
}

/**
 * Parks the run on `node` until its delay ends. The job is queued
 * before the run moves, so a crash in between leaves at worst a timer
 * that finds a stale seq.
 */
export async function scheduleDelay(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
  seconds: number,
): Promise<"scheduled" | "lost" | "failed"> {
  const seq = (run.transition_seq ?? 0) + 1;
  const until = new Date(Date.now() + seconds * 1000);
  try {
    await enqueueJob("flow.timer", { runId: run.id, nodeKey: node.node_key, seq, kind: "delay" }, {
      tenantId: run.account_id,
      runAt: until,
      dedupeKey: timerKey(run.id, seq, "delay", node.node_key),
    });
  } catch (err) {
    await logEvent(db, run.id, "error", node.node_key, {
      reason: "delay_schedule_failed",
      detail: errorDetail(err),
    });
    await endRun(db, run.id, "failed", "delay_schedule_failed");
    return "failed";
  }
  let q = db
    .from("flow_runs")
    .update({
      current_node_key: node.node_key,
      transition_seq: seq,
      reprompt_count: 0,
      delay_until: until.toISOString(),
      wait_until: null,
      last_advanced_at: new Date().toISOString(),
    })
    .eq("id", run.id)
    .eq("status", "active")
    .eq("transition_seq", run.transition_seq ?? 0);
  q = run.current_node_key === null ? q.is("current_node_key", null) : q.eq("current_node_key", run.current_node_key);
  if (run.flow_version_id) q = q.eq("flow_version_id", run.flow_version_id);
  const { data, error } = await q.select("id");
  if (error) {
    // The queued timer cannot match a run that never moved, so end the run rather than strand it.
    await logEvent(db, run.id, "error", node.node_key, { reason: "delay_schedule_failed" });
    await endRun(db, run.id, "failed", "delay_schedule_failed");
    return "failed";
  }
  if (!Array.isArray(data) || data.length !== 1) {
    await logEvent(db, run.id, "error", node.node_key, { reason: "lost_race_during_delay" });
    return "lost";
  }
  Object.assign(run, { current_node_key: node.node_key, transition_seq: seq, reprompt_count: 0, delay_until: until.toISOString() });
  await logEvent(db, run.id, "delay_scheduled", node.node_key, { seconds, until: until.toISOString() });
  return "scheduled";
}

/** After a node starts waiting for a reply, queues its timeout (if any). Best-effort: the stale sweep is the backstop. */
export async function scheduleReplyTimeout(db: AdminClient, run: FlowRunRow, node: FlowNodeRow): Promise<void> {
  const timeout = nodeTimeout(node.config);
  if (!timeout) return;
  const seq = run.transition_seq ?? 0;
  try {
    await enqueueJob("flow.timer", { runId: run.id, nodeKey: node.node_key, seq, kind: "timeout" }, {
      tenantId: run.account_id,
      runAt: new Date(Date.now() + timeout.minutes * 60_000),
      // A re-prompt reuses the key, so the timeout still counts from the first prompt.
      dedupeKey: timerKey(run.id, seq, "timeout", node.node_key),
    });
  } catch (err) {
    await logEvent(db, run.id, "error", node.node_key, {
      reason: "timeout_schedule_failed",
      detail: errorDetail(err),
    });
  }
}

/**
 * Runs a due `flow.timer` job. Every check repeats here because the
 * run may have moved, ended or been taken over while the job waited.
 */
export async function handleFlowTimer(payload: {
  accountId: string;
  runId: string;
  nodeKey: string;
  seq: number;
  kind: TimerKind;
}): Promise<"fired" | "stale"> {
  const db = databaseAdmin();
  const { data, error } = await db
    .from("flow_runs")
    .select("*")
    .eq("account_id", payload.accountId)
    .eq("id", payload.runId)
    .maybeSingle();
  if (error) throw new Error("Flow timer run lookup failed");
  const run = data as FlowRunRow | null;
  if (!run || run.status !== "active") return "stale";
  const seq = run.transition_seq ?? 0;
  const due = seq === payload.seq && run.current_node_key === payload.nodeKey && (payload.kind === "delay") === Boolean(run.delay_until);
  // A worker that died after claiming this timer but before the next step
  // finished left the run claimed and untouched since: carry on from there.
  // Re-running is safe because the sends' dispatchOnce keys repeat.
  const claimedEarlier = seq === payload.seq + 1 && run.reprompt_count === 0 && !run.delay_until;
  if (!due && !claimedEarlier) return "stale";
  const { flow, nodes } = await loadRunGraph(db, run);
  const timer = nodes.get(payload.nodeKey);
  const timeout = timer ? nodeTimeout(timer.config) : null;
  const resumeAt = payload.kind === "delay" ? payload.nodeKey : timeout?.next;
  if (!due && (!resumeAt || run.current_node_key !== resumeAt)) return "stale";
  const now = new Date();
  const { data: contact } = await db
    .from("contacts")
    .select("blocked_at,phone")
    .eq("account_id", run.account_id)
    .eq("id", run.contact_id!)
    .maybeSingle();
  const testContact = Boolean(flow) && (isTestContact(flow!, phoneDigits((contact as { phone?: string | null } | null)?.phone))
    || ((flow!.test_usernames ?? []).length > 0 && Boolean(run.conversation_id)
      && isTestUsername(flow!, await storedInstagramUsername(run.account_id, run.contact_id!, run.conversation_id!))));
  const closure = closureForActiveRun({ run, flow, nodeKeys: nodes, now, testContact });
  if (closure) {
    await closeActiveRun(db, run, closure, now);
    return "fired";
  }
  // An agent took over or the contact was blocked while the run waited: no more bot messages.
  if (!run.conversation_id || !contact || (contact as { blocked_at?: string | null }).blocked_at ||
      (await botRepliesPaused(run.account_id, run.conversation_id))) {
    await endRun(db, run.id, "cancelled", "bot_paused_during_wait");
    return "fired";
  }
  // Stage 5: unsubscribed on Instagram while the run waited (a smart delay, a reply delay): nothing more is sent.
  if (scopeIncludes(flow?.channel_scope, "instagram") && (await runChannel(run)) === "instagram" && run.contact_id
    && !(await instagramAutomationAllowed(run.account_id, run.contact_id))) {
    await endRun(db, run.id, "cancelled", "contact_opted_out");
    return "fired";
  }
  if (payload.kind === "delay") {
    if (due) {
      let claim = db
        .from("flow_runs")
        .update({ delay_until: null, transition_seq: payload.seq + 1, last_advanced_at: now.toISOString() })
        .eq("id", run.id)
        .eq("status", "active")
        .eq("current_node_key", payload.nodeKey)
        .eq("transition_seq", payload.seq);
      if (run.flow_version_id) claim = claim.eq("flow_version_id", run.flow_version_id);
      const { data: claimed, error: claimError } = await claim.select("id");
      if (claimError) throw new Error("Flow delay claim failed");
      if (!Array.isArray(claimed) || claimed.length !== 1) return "stale";
      Object.assign(run, { delay_until: null, transition_seq: payload.seq + 1 });
    }
    await advanceFromNodeKey(db, run, payload.nodeKey, nodes, payload.nodeKey);
    return "fired";
  }
  if (!timeout) return "stale";
  if (due) {
    // A book_appointment step that timed out drops its progress in the same claim.
    const vars = timer?.node_type === "book_appointment" && APPOINTMENT_STATE_VAR in run.vars ? withoutAppointmentState(run.vars) : null;
    if (!(await claimReplyTransition(db, run, timeout.next, vars ? { vars } : {}))) return "stale";
    if (vars) run.vars = vars;
    await logEvent(db, run.id, "timeout", payload.nodeKey, { reason: "node_timeout", minutes: timeout.minutes });
  }
  await advanceFromNodeKey(db, run, timeout.next, nodes);
  return "fired";
}

/**
 * A conversion_event step: queues the event in its own worker transaction
 * (this executor holds no transaction). The id is `flow:<run>:<node>:<event>`,
 * so a loop revisit or a re-run after a crash is a no-op. A value is sent only
 * with a currency. Purchase is never reported from a flow: its run-keyed id
 * would not dedupe with the order-keyed one from payment links and orders. Never throws: a failure must not strand the customer, and
 * only the error's name is kept (no customer content).
 */
export async function runConversionEvent(run: FlowRunRow, node: FlowNodeRow): Promise<{ queued: boolean; error?: string }> {
  const cfg = node.config;
  // Purchase is rejected here too (payments and orders report it, keyed by the order).
  if (!isConversionEventName(cfg.event_name)) return { queued: false, error: "invalid_event" };
  if (!run.contact_id) return { queued: false };
  const value = conversionValue(run.vars, cfg.value_var);
  const currency = isCurrencyCode(cfg.currency) ? cfg.currency : undefined;
  try {
    // Stage 4C: on an Instagram conversation the event is an Instagram one (attributed by its ad message).
    const instagram = (await runChannel(run)) === "instagram";
    const queued = await queueConversionEvent(run.account_id, {
      eventName: cfg.event_name,
      source: "flow",
      sourceId: `${run.id}:${node.node_key}`,
      contactId: run.contact_id,
      ...(instagram ? { channel: "instagram" as const, conversationId: run.conversation_id } : {}),
      ...(value !== undefined && currency ? { value, currency } : {}),
    });
    return { queued };
  } catch (err) {
    return { queued: false, error: err instanceof Error ? err.name : "error" };
  }
}

// ============================================================
// The synchronous advance loop. Walks through auto-advance nodes
// until it hits one that suspends (send_buttons/send_list) or
// terminates (handoff/end). Each suspending node persists the
// new current_node_key before returning.
// ============================================================

/**
 * Runs an Actions list of a step (Stage 5, nodes/actions.ts) from its cursor:
 * the Actions step itself (suffix '') or a question's actions on a valid
 * answer (':ok'). Skipped actions are logged with a reason code, the ones that
 * ran with their types only (never a value).
 */
export async function runActionsNode(db: AdminClient, run: FlowRunRow, node: FlowNodeRow, raw: unknown, suffix: "" | ":ok"): Promise<ActionsResult> {
  const actions = actionList(raw);
  const flowName = actions.some((a) => a.type === "notify_team") ? (await loadFlow(db, run.flow_id))?.name ?? "" : "";
  const result = await runActions({
    db, run, nodeKey: node.node_key, channel: await runChannel(run), flowName, cursorSuffix: suffix,
    interpolate: async (text) => interpolateVars(text, run.vars, await textValues(run, text)),
  }, actions);
  for (const s of result.skipped) {
    await logEvent(db, run.id, "error", node.node_key, { reason: `action_${s.reason}`, action: s.type, index: s.index });
  }
  if (result.ran.length) await logEvent(db, run.id, "attribute_set", node.node_key, { actions: result.ran, ...(suffix ? { on: "answer" } : {}) });
  return result;
}

/** A smart delay's plan for this run: the step's (or workspace's) time zone and, when it reads one, the custom field's value. */
export async function planSmartDelayFor(db: AdminClient, run: FlowRunRow, cfg: SmartDelayNodeConfig): Promise<ReturnType<typeof planSmartDelay>> {
  const fieldId = cfg.mode === "duration" ? cfg.amount_field_id : cfg.date_field_id;
  const [timezone, fieldValue] = await withTenant({ accountId: run.account_id, role: "owner" }, async (tx) => {
    const zone = await workspaceTimezone(tx, run.account_id);
    if (!fieldId || !run.contact_id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fieldId)) return [zone, null] as const;
    const [row] = await tx.$queryRaw<{ value: string | null }[]>`SELECT value FROM contact_custom_values
      WHERE account_id=${run.account_id}::uuid AND contact_id=${run.contact_id}::uuid AND custom_field_id=${fieldId}::uuid`;
    return [zone, row?.value ?? null] as const;
  }, getWorkerPrisma());
  return planSmartDelay(cfg, { now: new Date(), timezone, fieldValue });
}

/**
 * One turn of an ai_reply step with goals (Stage 5, lib/ai/goals.ts). Returns
 * the port to follow, or null to wait for the person's next message. The AI
 * sends through its own gate, budget, safety checks and outbound intent.
 */
export async function goalTurn(db: AdminClient, run: FlowRunRow, node: FlowNodeRow, message: ParsedInbound | null): Promise<{ next: string | null; vars?: Record<string, string> }> {
  const cfg = node.config as unknown as Partial<AiReplyNodeConfig>;
  let result: Awaited<ReturnType<typeof runGoalTurn>>;
  try {
    result = await runGoalTurn(run, node, message);
  } catch (err) {
    await logEvent(db, run.id, "error", node.node_key, { reason: "ai_goal_failed", detail: errorDetail(err) });
    return { next: cfg.handoff_next ?? "" };
  }
  switch (result.outcome) {
    case "continue":
      await logEvent(db, run.id, "ai_replied", node.node_key, { goals: true });
      return { next: null, vars: result.vars };
    case "finished":
      await logEvent(db, run.id, "ai_replied", node.node_key, { goals: true, finished: true });
      return { next: cfg.finish_next ?? "", vars: result.vars };
    case "handoff":
    case "unavailable":
      await logEvent(db, run.id, "ai_handoff", node.node_key, { goals: true, reason: result.outcome });
      return { next: cfg.handoff_next ?? "" };
  }
}

/** The failure-style port a step offers, taken when the step cannot run on the conversation's channel. */
export function channelFailurePort(config: Record<string, unknown>): string | null {
  for (const key of ["failed_next", "unavailable_next", "handoff_next"]) {
    const next = config[key];
    if (typeof next === "string" && next) return next;
  }
  return null;
}

/** A step this channel cannot run and no failure port: the conversation goes to a person. */
export async function handOffUnavailable(db: AdminClient, run: FlowRunRow, node: FlowNodeRow): Promise<{ outcome: "handed_off" }> {
  if (run.conversation_id) {
    await db
      .from("conversations")
      .update({ status: "pending", bot_paused: true, updated_at: new Date().toISOString() })
      .eq("account_id", run.account_id)
      .eq("id", run.conversation_id);
  }
  await logEvent(db, run.id, "handoff", node.node_key, { reason: "unavailable_on_channel" });
  await endRun(db, run.id, "handed_off", "unavailable_on_channel");
  return { outcome: "handed_off" };
}
