import { checkRunTimeout, markRunTimedOut, type RunTimeoutCheck } from "./timeout";
import { botRepliesPaused } from '@/lib/whatsapp/bot-pause';
import { normalizeCollectedInput } from './input-validation';
import { dispatchOnce } from '@/lib/jobs/dispatch';
import { enqueueJob } from '@/lib/jobs/queue';
import { writeContactField } from '@/lib/contacts/field-write';
import { clockTimezone, conditionRules, predicateHolds, ruleHolds } from './conditions';
import { byPrecedence, isTestContact, keywordTriggerMatches, orderReceivedMatch, phoneDigits, templateReplyMatch } from './triggers';
import { runApiRequest } from './api-request';
import { engineSendTemplate } from '@/lib/automations/meta-send';
import { nextRoundRobinAgent } from '@/lib/automations/round-robin';
import { sendForm, templateFlowTokens } from '@/lib/whatsapp/forms/send';
import { CommerceSendError, commerceMessageFromNode, isCommerceNodeType, sendCommerceMessage } from '@/lib/commerce/catalog-send';
import { parseMoney } from '@/lib/commerce/money';
import { createPaymentLinkRecord, findLinkByReference, flowOutcomeFor, flowPaymentReference, paymentLinkMessageText, PaymentLinkError } from '@/lib/payments/links';
/**
 * Flow runner.
 *
 * The single entry point `dispatchInboundToFlows` is called by the
 * WhatsApp webhook on every inbound message *for an account that has
 * opted into the Flows beta*. It decides whether the message belongs
 * to an active conversation flow (advance it) or matches the entry
 * trigger of an active flow (start a new run) — and reports back to
 * the webhook so the webhook knows whether to also fire automations.
 *
 * Architecture in a sentence: the runner walks the customer through
 * a DB-stored node graph, suspending only at nodes that need
 * customer input. Each tap or text reply wakes it back up.
 *
 * What lives here vs elsewhere:
 *   - Pure decision logic (which button matched, where to advance to,
 *     when to fallback) — here.
 *   - DB shape (table reads/writes) — here.
 *   - Meta API calls — `meta-send.ts` (engineSendInteractive*).
 *   - Policy resolution (reprompt vs handoff vs end) — `fallback.ts`.
 *   - Type definitions — `types.ts`.
 *
 * Concurrency model:
 *   - Idempotency on `meta_message_id`: the runner refuses to advance
 *     an active run twice for the same Meta message — protects against
 *     Meta's retries.
 *   - Optimistic UPDATE with `current_node_key` precondition: two
 *     simultaneous taps for the same run collide at the DB layer; the
 *     second is a no-op.
 *   - Partial unique index `idx_one_active_run_per_conversation`: two
 *     simultaneous starts on the same conversation collide; the second
 *     INSERT raises 23505 and the runner catches & exits.
 *
 * Multi-number policy: a contact has one conversation per WhatsApp
 * number, and each conversation has at most one active run. An inbound
 * only ever answers the run on its own conversation. A run waiting on
 * another conversation of the same contact (another number) is left
 * alone — it is not answered, closed or re-routed — so replies always
 * go out from the number the customer wrote to.
 */

import { databaseAdmin } from "./admin-client";
import { dispatchWebhookEvent } from "@/lib/webhooks/deliver";
import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
  engineSendMedia,
  engineSendText,
} from "./meta-send";
import { decideFallback, resolveFallbackPolicy } from "./fallback";
import { addContactTagAndDispatch } from "@/lib/contacts/tag-events";
import { removeContactTag } from "@/lib/contacts/tag-write";
import { fillWorkspace, workspaceValuesFor } from "@/lib/workspace/attributes";
import { flowTemplateSendExtras } from "@/lib/whatsapp/template-send-params";
import {
  type ApiRequestNodeConfig,
  type AssignAgentNodeConfig,
  type ConnectFlowNodeConfig,
  type SendTemplateNodeConfig,
  type SendFormNodeConfig,
  type PaymentLinkNodeConfig,
  type AskMediaNodeConfig,
  type AskRetry,
  type CollectInputNodeConfig,
  type ConditionNodeConfig,
  type ConditionRule,
  type DispatchInboundInput,
  type NodeTiming,
  type SetAttributeNodeConfig,
  type DispatchInboundResult,
  type FlowNodeRow,
  type FlowRow,
  type FlowRunRow,
  type ParsedInbound,
  type SendButtonsNodeConfig,
  type SendListNodeConfig,
  type SendMediaNodeConfig,
  type SendMessageNodeConfig,
  type SetTagNodeConfig,
  type StartNodeConfig,
  type KeywordTriggerConfig,
  type TemplateReplyTriggerConfig,
} from "./types";

// ============================================================
// Pure helpers — extracted so engine.test.ts can exercise them
// without a Supabase / Meta mock.
// ============================================================

/**
 * Given a node + the customer's reply_id, return the next_node_key
 * to advance to, or `null` if no option matches.
 */
export function matchReplyId(
  node: { node_type: string; config: Record<string, unknown> },
  reply_id: string,
): string | null {
  if (node.node_type === "send_buttons") {
    const cfg = node.config as unknown as SendButtonsNodeConfig;
    const hit = cfg.buttons?.find((b) => b.reply_id === reply_id);
    return hit?.next_node_key ?? null;
  }
  if (node.node_type === "send_list") {
    const cfg = node.config as unknown as SendListNodeConfig;
    for (const section of cfg.sections ?? []) {
      const hit = section.rows?.find((r) => r.reply_id === reply_id);
      if (hit) return hit.next_node_key;
    }
    return null;
  }
  if (node.node_type === "send_template") {
    // We send each quick reply's reply_id as its payload; Meta echoes the
    // button text instead when a payload is missing, so match that too.
    const buttons = (node.config as unknown as SendTemplateNodeConfig).buttons ?? [];
    const hit = buttons.find((b) => b.reply_id === reply_id) ?? buttons.find((b) => b.title === reply_id);
    return hit?.next_node_key ?? null;
  }
  return null;
}

/**
 * The strings an inbound message offers to a flow's *entry* trigger.
 *
 * Typed text offers itself. A button / list tap offers two: the visible
 * title — what the customer would have typed had the button not been
 * there — and the stable reply_id, because the automation engine's
 * `interactive_reply` trigger routes on the id, so an author moving a
 * menu into a flow reaches for the same value.
 *
 * Matching the id does mean a keyword that happens to be a substring of
 * an id can fire (ids are author-controlled slugs, defaulting to
 * `btn_1`). That is the same substring semantic keyword triggers
 * already have for typed text, and the alternative — ignoring the id —
 * silently breaks the author who keyed on it.
 */
export function entryTriggerTexts(message: ParsedInbound): string[] {
  // A form submission answers a form, and a cart starts order_received
  // flows; neither starts a flow by keyword.
  if (message.kind === "form" || message.kind === "order") return [];
  if (message.kind !== "interactive_reply") {
    const text = messageText(message);
    return text.trim() ? [text] : [];
  }
  return [...new Set([message.reply_title, message.reply_id])].filter(
    (v): v is string => Boolean(v && v.trim()),
  );
}

/**
 * The text a message offered before photos, locations and address forms
 * had their own shapes: a caption, or the location / address joined up.
 * Keeps keyword triggers and text questions behaving as they did.
 */
export function messageText(message: ParsedInbound): string {
  switch (message.kind) {
    case "text": return message.text;
    case "interactive_reply": return message.reply_title;
    case "media": return message.caption;
    case "location": return [message.name, message.address, `${message.latitude},${message.longitude}`].filter(Boolean).join(" - ");
    case "address": return Object.values(message.values).join(", ");
    case "form": return message.summary;
    case "order": return message.summary;
  }
}

/** reply_id of the Skip button on question nodes. */
export const SKIP_REPLY_ID = "__skip";

/** Nodes that advance to a next_node_key without waiting for input. */
export function isAutoAdvancing(node_type: string): boolean {
  return (
    node_type === "start" ||
    node_type === "send_message" ||
    node_type === "send_media" ||
    isCommerceNodeType(node_type) ||
    node_type === "condition" ||
    node_type === "set_tag" ||
    node_type === "set_attribute" ||
    node_type === "api_request" ||
    node_type === "assign_agent"
  );
}

/** Nodes that ask a question and store the answer. */
export function isAskNode(node_type: string): boolean {
  return (
    node_type === "collect_input" ||
    node_type === "ask_media" ||
    node_type === "ask_location" ||
    node_type === "ask_address"
  );
}

/** A valid per-node delay in whole seconds (1 s – 24 h), else 0. */
export function nodeDelaySeconds(config: Record<string, unknown>): number {
  const d = (config as NodeTiming).delay_seconds;
  return typeof d === "number" && Number.isInteger(d) && d >= 1 && d <= 86_400 ? d : 0;
}

/** A valid wait-for-reply timeout in minutes (1 min – 7 days) with its port, else null. */
export function nodeTimeout(config: Record<string, unknown>): { minutes: number; next: string } | null {
  const { timeout_minutes: m, after_timeout: next } = config as NodeTiming;
  return typeof m === "number" && Number.isInteger(m) && m >= 1 && m <= 10_080 && typeof next === "string" && next
    ? { minutes: m, next }
    : null;
}

export type ActiveRunClosure =
  | { kind: "cancel"; reason: "flow_not_active" | "current_node_removed" }
  | { kind: "fail"; reason: "active_run_missing_current_node" }
  | { kind: "timeout"; check: RunTimeoutCheck };

/** A run waiting out a delay is not stale until the delay ends. */
export function staleSince(run: Pick<FlowRunRow, "last_advanced_at" | "delay_until">): string {
  return run.delay_until && Date.parse(run.delay_until) > Date.parse(run.last_advanced_at)
    ? run.delay_until
    : run.last_advanced_at;
}

export function closureForActiveRun(args: {
  run: Pick<FlowRunRow, "current_node_key" | "last_advanced_at" | "delay_until">;
  flow: Pick<FlowRow, "status" | "fallback_policy"> | null;
  nodeKeys: ReadonlySet<string> | { has(key: string): boolean };
  now: Date;
  /** The contact is one of the draft flow's test numbers, so its run may continue. */
  testContact?: boolean;
}): ActiveRunClosure | null {
  if (!args.flow || (args.flow.status !== "active" && !(args.flow.status === "draft" && args.testContact))) {
    return { kind: "cancel", reason: "flow_not_active" };
  }
  const check = checkRunTimeout(
    staleSince(args.run),
    args.flow.fallback_policy,
    args.now,
  );
  if (check.timedOut) return { kind: "timeout", check };
  if (!args.run.current_node_key) {
    return { kind: "fail", reason: "active_run_missing_current_node" };
  }
  if (!args.nodeKeys.has(args.run.current_node_key)) {
    return { kind: "cancel", reason: "current_node_removed" };
  }
  return null;
}

/** Nodes that send a prompt and suspend awaiting a customer reply. */
export function isSuspending(node_type: string): boolean {
  return (
    node_type === "send_buttons" ||
    node_type === "send_list" ||
    node_type === "send_form" ||
    isAskNode(node_type)
  );
}

/** A template waits for a tap only when it has quick-reply buttons; otherwise it advances. */
export function templateWaits(config: Record<string, unknown>): boolean {
  return ((config as unknown as SendTemplateNodeConfig).buttons ?? []).length > 0;
}

/** Nodes that end the run. */
export function isTerminal(node_type: string): boolean {
  return node_type === "handoff" || node_type === "end" || node_type === "connect_flow";
}

/**
 * Evaluate a `condition` node's predicate against the current run
 * state. Exported pure for unit testing — the engine wraps it with a
 * DB lookup for `tag` / `contact_field` subjects.
 */
export function evaluateConditionPredicate(args: {
  operator: ConditionRule["operator"];
  /**
   * Resolved value of the subject. `undefined` means the subject is
   * absent (no var with that key / no such tag / contact field is
   * null). Pure function: caller does the DB lookup.
   */
  subjectValue: string | undefined;
  /** The configured comparison value, when applicable. */
  configValue: string | undefined;
  /** Upper bound for `between`. */
  configValue2?: string;
}): boolean {
  return predicateHolds(args.operator, args.subjectValue, args.configValue, args.configValue2);
}

// ============================================================
// DB I/O — wrapped in tiny helpers so the dispatch flow stays
// readable. Errors surface as thrown — the entry point catches.
// ============================================================

type AdminClient = ReturnType<typeof databaseAdmin>;

async function loadActiveRunForConversation(
  db: AdminClient,
  accountId: string,
  contactId: string,
  conversationId: string,
): Promise<FlowRunRow | null> {
  // Only the run on this inbound's conversation may answer it (see the
  // multi-number policy in the header). The partial unique index
  // `idx_one_active_run_per_conversation` makes two active runs on one
  // conversation impossible, but .maybeSingle() would throw on >1 row
  // after manual SQL and kill dispatch for the conversation; .limit(1)
  // picks the newest and lets the cron sweep clean up the stale one.
  const { data, error } = await db
    .from("flow_runs")
    .select("*")
    .eq("account_id", accountId)
    .eq("contact_id", contactId)
    .eq("conversation_id", conversationId)
    .eq("status", "active")
    .order("started_at", { ascending: false })
    .limit(1);
  if (error) {
    console.error("[flows] loadActiveRunForConversation error:", error.message);
    return null;
  }
  const rows = (data as FlowRunRow[] | null) ?? [];
  return rows[0] ?? null;
}

async function loadFlow(
  db: AdminClient,
  flowId: string,
): Promise<FlowRow | null> {
  const { data, error } = await db
    .from("flows")
    .select("*")
    .eq("id", flowId)
    .maybeSingle();
  if (error) {
    console.error("[flows] loadFlow error:", error.message);
    return null;
  }
  return (data as FlowRow | null) ?? null;
}

/**
 * Load every node of a flow in one round trip and key them by
 * `node_key`. The advance loop is then in-memory — a 5-node
 * auto-advancing chain costs one SELECT, not five.
 *
 * Returns an empty map on error so the caller can still dispatch
 * cleanly (every subsequent .get() returns undefined → the run
 * fails with node_not_found, same as the old per-node lookup).
 */
async function loadAllNodes(
  db: AdminClient,
  flowId: string,
): Promise<Map<string, FlowNodeRow>> {
  const { data, error } = await db
    .from("flow_nodes")
    .select("*")
    .eq("flow_id", flowId);
  if (error) {
    console.error("[flows] loadAllNodes error:", error.message);
    return new Map();
  }
  const map = new Map<string, FlowNodeRow>();
  for (const row of (data ?? []) as FlowNodeRow[]) {
    map.set(row.node_key, row);
  }
  return map;
}

async function logEvent(
  db: AdminClient,
  flowRunId: string,
  event_type:
    | "started"
    | "node_entered"
    | "message_sent"
    | "reply_received"
    | "fallback_fired"
    | "handoff"
    | "timeout"
    | "error"
    | "completed"
    | "delay_scheduled"
    | "input_invalid"
    | "attribute_set"
    | "api_request"
    | "flow_connected"
    | "agent_assigned"
    | "form_sent"
    | "form_submitted"
    | "payment_link_sent"
    | "payment_received"
    | "payment_expired",
  node_key: string | null,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await db.from("flow_run_events").insert({
    flow_run_id: flowRunId,
    event_type,
    node_key,
    payload,
  });
  if (error) {
    // Logging failure is non-fatal — surface but don't throw.
    console.error("[flows] logEvent error:", error.message);
  }
}

/**
 * Idempotency check — has a `reply_received` event with this Meta
 * message_id already been recorded for any of the contact's flow
 * runs? If yes, the inbound is a duplicate (Meta retry) and we
 * exit without re-advancing.
 *
 * Implementation note: scoped to runs belonging to this user/contact
 * so the lookup is cheap (the index on flow_run_events(flow_run_id,
 * event_type) plus the small set of runs per contact).
 */
async function isDuplicateInbound(
  db: AdminClient,
  accountId: string,
  contactId: string,
  metaMessageId: string,
): Promise<boolean> {
  // Fetch ALL run ids for this contact in this account (active +
  // historical). Bounded by how many flows the customer has been
  // through — small.
  const { data: runs } = await db
    .from("flow_runs")
    .select("id")
    .eq("account_id", accountId)
    .eq("contact_id", contactId);
  if (!runs?.length) return false;
  const runIds = runs.map((r) => (r as { id: string }).id);

  const { count } = await db
    .from("flow_run_events")
    .select("id", { count: "exact", head: true })
    .in("flow_run_id", runIds)
    .eq("event_type", "reply_received")
    .filter("payload->>meta_message_id", "eq", metaMessageId);
  return (count ?? 0) > 0;
}

/**
 * Whether a flow listens on the number an inbound arrived on. A flow tied to a
 * number (flows.whatsapp_config_id) starts only for messages on it; an untied
 * flow (null, every flow before multi-number) starts on every number.
 */
export function flowListensOnNumber(
  flow: { whatsapp_config_id?: string | null },
  inboundNumberId: string | null,
): boolean {
  const tied = flow.whatsapp_config_id ?? null;
  return !tied || tied === inboundNumberId;
}

async function findEntryFlow(
  db: AdminClient,
  accountId: string,
  conversationId: string,
  message: ParsedInbound,
  isFirstInbound: boolean,
  contactDigits: () => Promise<string>,
): Promise<{ flow: FlowRow; vars: Record<string, string> } | null> {
  // A tap used to be rejected outright here, on the reasoning that
  // interactive replies are responses to existing prompts. That holds
  // only while a prompt is outstanding — and this function runs solely
  // when the conversation has NO active run, so there is nothing the tap
  // could be answering. What it actually blocked was issue #490: an
  // *automation* sends the buttons, the customer taps one, and the flow
  // whose keyword matches that button never starts. Retyping the label
  // by hand worked, which is the tell — same words, different envelope.
  const candidates = entryTriggerTexts(message);

  // Active flows, plus drafts being tested (only those with test numbers
  // are fetched); both sets are small.
  const [active, drafts] = await Promise.all([
    db.from("flows").select("*").eq("account_id", accountId).eq("status", "active").order("created_at", { ascending: true }),
    db.from("flows").select("*").eq("account_id", accountId).eq("status", "draft").neq("test_numbers", []).order("created_at", { ascending: true }),
  ]);
  if (active.error || drafts.error) return null;
  const testing = ((drafts.data ?? []) as FlowRow[]).filter((f) => f.status === "draft" && (f.test_numbers ?? []).length > 0);
  const digits = testing.length ? await contactDigits() : "";
  const candidatesByStatus = [
    ...((active.data ?? []) as FlowRow[]).filter((f) => f.status === "active"),
    ...testing.filter((f) => isTestContact(f, digits)),
  ];
  // The inbound's number is its conversation's (one conversation per contact
  // and number); read only when some flow is tied to a number.
  const tiedFlows = candidatesByStatus.some((f) => f.whatsapp_config_id);
  let inboundNumberId: string | null = null;
  if (tiedFlows) {
    const { data, error } = await db.from("conversations").select("whatsapp_config_id")
      .eq("account_id", accountId).eq("id", conversationId).maybeSingle();
    if (error) return null;
    inboundNumberId = (data as { whatsapp_config_id?: string | null } | null)?.whatsapp_config_id ?? null;
  }
  const typed = byPrecedence(candidatesByStatus.filter((f) =>
    flowListensOnNumber(f, inboundNumberId)));
  for (const flow of typed) {
    if (flow.trigger_type === "order_received") {
      const vars = orderReceivedMatch(message);
      if (vars) return { flow, vars };
    } else if (flow.trigger_type === "template_reply") {
      const vars = templateReplyMatch(message, flow.trigger_config as TemplateReplyTriggerConfig);
      if (vars) return { flow, vars };
    } else if (flow.trigger_type === "keyword") {
      const cfg = flow.trigger_config as KeywordTriggerConfig;
      for (const text of candidates) {
        if (await keywordTriggerMatches(text, cfg)) return { flow, vars: {} };
      }
    } else if (flow.trigger_type === "first_inbound_message" && isFirstInbound) {
      // Also reachable by a tap now: a broadcast template with a
      // quick-reply button can genuinely be what prompts a contact's
      // first-ever inbound. The automations dispatcher has always
      // treated a tap that way (the webhook pushes
      // `first_inbound_message` regardless of envelope) — flows were
      // the inconsistent half.
      return { flow, vars: {} };
    }
    // 'manual' triggers do not auto-start from inbound messages.
  }
  return null;
}

// ============================================================
// Node executors — each handles ONE node type. send_buttons and
// send_list also persist `last_prompt_message_id` so the inbox
// thread can quote the prompt the customer is replying to.
// ============================================================

async function sendButtonsAndSuspend(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<{ outcome: "advanced"; node_key: string }> {
  const cfg = node.config as unknown as SendButtonsNodeConfig;
  // Every customer-visible string is interpolated against run.vars —
  // same treatment send_message / collect_input already get (#553).
  // `reply_id` is deliberately NOT interpolated: it is the routing key
  // matchReplyId compares the tapped button against, so it must reach
  // Meta byte-for-byte as authored. Interpolation can push a title past
  // Meta's 20-char cap; meta-api's validator throws a descriptive error
  // and the caller logs it — we never truncate silently.
  const ws = await workspaceValuesFor(run.account_id, JSON.stringify(cfg));
  const { whatsapp_message_id } = await dispatchOnce(run.account_id, `flow:${run.id}:${node.node_key}:${run.transition_seq ?? 0}:${run.reprompt_count}`, () => engineSendInteractiveButtons({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText: interpolateVars(cfg.text, run.vars, ws),
    headerText: interpolateOptionalVars(cfg.header_text, run.vars, ws),
    footerText: interpolateOptionalVars(cfg.footer_text, run.vars, ws),
    buttons: cfg.buttons.map((b) => ({
      id: b.reply_id,
      title: interpolateVars(b.title, run.vars, ws),
    })),
  }));
  await logEvent(db, run.id, "message_sent", node.node_key, {
    node_type: "send_buttons",
    whatsapp_message_id,
  });
  // Look up our internal message id so we can stash it on the run.
  // Cheap — indexed on `messages.message_id`.
  const { data: msg } = await db
    .from("messages")
    .select("id")
    .eq("message_id", whatsapp_message_id)
    .maybeSingle();
  await db
    .from("flow_runs")
    .update({
      last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
    })
    .eq("id", run.id);
  return { outcome: "advanced", node_key: node.node_key };
}

async function sendListAndSuspend(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<{ outcome: "advanced"; node_key: string }> {
  const cfg = node.config as unknown as SendListNodeConfig;
  // See sendButtonsAndSuspend — interpolate every visible string,
  // never the row `reply_id`.
  const ws = await workspaceValuesFor(run.account_id, JSON.stringify(cfg));
  const { whatsapp_message_id } = await dispatchOnce(run.account_id, `flow:${run.id}:${node.node_key}:${run.transition_seq ?? 0}:${run.reprompt_count}`, () => engineSendInteractiveList({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText: interpolateVars(cfg.text, run.vars, ws),
    buttonLabel: interpolateVars(cfg.button_label, run.vars, ws),
    headerText: interpolateOptionalVars(cfg.header_text, run.vars, ws),
    footerText: interpolateOptionalVars(cfg.footer_text, run.vars, ws),
    sections: cfg.sections.map((s) => ({
      title: interpolateOptionalVars(s.title, run.vars, ws),
      rows: s.rows.map((r) => ({
        id: r.reply_id,
        title: interpolateVars(r.title, run.vars, ws),
        description: interpolateOptionalVars(r.description, run.vars, ws),
      })),
    })),
  }));
  await logEvent(db, run.id, "message_sent", node.node_key, {
    node_type: "send_list",
    whatsapp_message_id,
  });
  const { data: msg } = await db
    .from("messages")
    .select("id")
    .eq("message_id", whatsapp_message_id)
    .maybeSingle();
  await db
    .from("flow_runs")
    .update({
      last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
    })
    .eq("id", run.id);
  return { outcome: "advanced", node_key: node.node_key };
}

/**
 * Sends the node's template. Each quick reply carries its reply_id as
 * payload so the tap routes reliably. Meta rejects empty parameters, so
 * a value that interpolates to nothing is sent as "-".
 */
async function sendTemplateNode(db: AdminClient, run: FlowRunRow, node: FlowNodeRow): Promise<void> {
  const cfg = node.config as unknown as SendTemplateNodeConfig;
  const raw = cfg.body_params ?? [];
  const ws = await workspaceValuesFor(run.account_id, JSON.stringify([raw, cfg.card_params ?? [], cfg.coupon_code ?? ""]));
  const params = raw.map((p) => interpolateVars(p, run.vars, ws).trim() || "-");
  const buttonParams = Object.fromEntries((cfg.buttons ?? []).map((b) => [b.index, b.reply_id]));
  const { whatsapp_message_id } = await dispatchOnce(run.account_id, `flow:${run.id}:${node.node_key}:${run.transition_seq ?? 0}:${run.reprompt_count}`, async () => engineSendTemplate({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    templateName: cfg.template_name,
    language: cfg.language,
    params,
    messageParams: {
      body: params,
      buttonParams,
      ...flowTemplateSendExtras(cfg, (s) => interpolateVars(s, run.vars, ws)),
      flowTokens: await templateFormTokens(db, run, cfg),
    },
  }));
  await logEvent(db, run.id, "message_sent", node.node_key, { node_type: "send_template", whatsapp_message_id });
  if (!templateWaits(node.config)) return;
  const { data: msg } = await db.from("messages").select("id").eq("message_id", whatsapp_message_id).maybeSingle();
  await db
    .from("flow_runs")
    .update({ last_prompt_message_id: (msg as { id: string } | null)?.id ?? null })
    .eq("id", run.id);
}

/** Form sessions for the template's FLOW buttons, if it has any (see templateFlowTokens). */
async function templateFormTokens(db: AdminClient, run: FlowRunRow, cfg: SendTemplateNodeConfig): Promise<Record<number, string> | undefined> {
  let query = db.from("message_templates").select("buttons").eq("account_id", run.account_id).eq("name", cfg.template_name);
  if (cfg.language) query = query.eq("language", cfg.language);
  const { data } = await query.limit(1);
  const buttons = (data as Array<{ buttons: Array<{ type: string; flow_id?: string }> | null }> | null)?.[0]?.buttons;
  return templateFlowTokens({ accountId: run.account_id, buttons, contactId: run.contact_id, conversationId: run.conversation_id, flowRunId: run.id });
}

/**
 * Calls the configured API, stores mapped values in the run's variables
 * and returns the port to follow. Only the status, timing and mapped
 * variable names are logged: never the URL, headers, body or reply.
 */
async function executeApiRequest(db: AdminClient, run: FlowRunRow, node: FlowNodeRow): Promise<string> {
  const cfg = node.config as unknown as ApiRequestNodeConfig;
  try {
    const { data: contact } = await db
      .from("contacts")
      .select("name,email,phone,company")
      .eq("account_id", run.account_id)
      .eq("id", run.contact_id!)
      .maybeSingle();
    const contactValues = Object.fromEntries(
      Object.entries((contact ?? {}) as Record<string, unknown>).filter(([, v]) => typeof v === "string"),
    ) as Record<string, string>;
    // Secret workspace attributes (API keys) resolve only into headers and the body.
    const [workspace, publicWorkspace] = await Promise.all([
      workspaceValuesFor(run.account_id, JSON.stringify([cfg.headers, cfg.body]), { secrets: true }),
      workspaceValuesFor(run.account_id, JSON.stringify([cfg.url, cfg.params])),
    ]);
    // Recorded like a send, so a replayed step (worker restart) reuses this
    // outcome instead of repeating a POST; an unknown outcome is never retried.
    const outcome = await dispatchOnce(run.account_id, `flow-api:${run.id}:${node.node_key}:${run.transition_seq ?? 0}:${run.reprompt_count}`, async () => {
      const o = await runApiRequest(cfg, { vars: run.vars, contact: contactValues, workspace, publicWorkspace });
      return {
        status: o.result.ok ? o.result.status : null,
        error: o.result.ok ? null : o.result.error,
        mapped: o.mapped,
        next: o.next,
        durationMs: o.durationMs,
      };
    });
    if (Object.keys(outcome.mapped).length) {
      const vars = { ...run.vars, ...outcome.mapped };
      const { error } = await db.from("flow_runs").update({ vars }).eq("id", run.id).eq("status", "active");
      if (error) throw new Error("Run variable write failed");
      run.vars = vars;
    }
    await logEvent(db, run.id, "api_request", node.node_key, {
      status: outcome.status,
      error: outcome.error,
      duration_ms: outcome.durationMs,
      mapped: Object.keys(outcome.mapped),
      route: outcome.next === cfg.fallback_next ? "fallback" : "status",
    });
    return outcome.next;
  } catch (err) {
    await logEvent(db, run.id, "error", node.node_key, {
      reason: "api_request_failed",
      detail: err instanceof Error ? err.message : String(err),
    });
    return cfg.fallback_next;
  }
}

/** Assigns the conversation (a specific member or the next in the round-robin) and carries on. */
async function executeAssignAgent(db: AdminClient, run: FlowRunRow, node: FlowNodeRow): Promise<void> {
  const cfg = node.config as unknown as AssignAgentNodeConfig;
  try {
    // A replayed step (worker restart) keeps the agent it already picked
    // rather than moving the shared round-robin cursor again.
    const seq = String(run.transition_seq ?? 0);
    const { data: prior } = await db
      .from("flow_run_events")
      .select("payload")
      .eq("flow_run_id", run.id)
      .eq("event_type", "agent_assigned")
      .eq("node_key", node.node_key)
      .filter("payload->>seq", "eq", seq)
      .limit(1);
    const already = (prior as Array<{ payload: { agent_id?: string } }> | null)?.[0]?.payload.agent_id;
    const agentId = already ?? (cfg.mode === "round_robin" ? await nextRoundRobinAgent(run.account_id) : cfg.agent_id ?? null);
    if (!agentId || !run.conversation_id) throw new Error("no agent to assign");
    // The (account_id, assigned_agent_id) membership key rejects anyone outside the workspace.
    const { error } = await db
      .from("conversations")
      .update({ assigned_agent_id: agentId, updated_at: new Date().toISOString() })
      .eq("account_id", run.account_id)
      .eq("id", run.conversation_id);
    if (error) throw new Error("conversation assignment failed");
    if (!already) await logEvent(db, run.id, "agent_assigned", node.node_key, { agent_id: agentId, mode: cfg.mode, seq });
  } catch (err) {
    // Non-fatal, like set_tag: the conversation simply stays unassigned.
    await logEvent(db, run.id, "error", node.node_key, {
      reason: "assign_agent_failed",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Connect Flow hops in a row without a customer reply before a loop is assumed. */
export const MAX_CONNECT_HOPS = 5;
/** Run variable counting those hops; carried to the next flow, reset by any reply. */
export const CONNECT_HOPS_VAR = "_connect_hops";

/**
 * Ends this run and starts the target flow for the same contact with the
 * run's variables. The run must end first: a contact has one active run.
 */
async function executeConnectFlow(db: AdminClient, run: FlowRunRow, node: FlowNodeRow): Promise<void> {
  const cfg = node.config as unknown as ConnectFlowNodeConfig;
  const { data } = await db
    .from("flows")
    .select("*")
    .eq("account_id", run.account_id)
    .eq("id", cfg.flow_id)
    .maybeSingle();
  const target = data as FlowRow | null;
  // Counted in hops rather than time, so a loop slowed by delays still stops.
  const { count: replies } = await db
    .from("flow_run_events")
    .select("id", { count: "exact", head: true })
    .eq("flow_run_id", run.id)
    .eq("event_type", "reply_received");
  const hops = (replies ?? 0) > 0 ? 1 : (Number(run.vars[CONNECT_HOPS_VAR]) || 0) + 1;
  const reason = !target || target.status !== "active" || !target.entry_node_id
    ? "connect_flow_unavailable"
    : hops > MAX_CONNECT_HOPS ? "connect_flow_loop" : null;
  if (reason || !target || !run.contact_id || !run.conversation_id) {
    await logEvent(db, run.id, "error", node.node_key, { reason: reason ?? "connect_flow_unavailable" });
    await endRun(db, run.id, "failed", reason ?? "connect_flow_unavailable");
    return;
  }
  await logEvent(db, run.id, "flow_connected", node.node_key, { flow_id: target.id });
  await endRun(db, run.id, "completed", "connect_flow");
  await startNewRun(db, target, {
    accountId: run.account_id,
    userId: run.user_id,
    contactId: run.contact_id,
    conversationId: run.conversation_id,
    message: { kind: "text", text: "", meta_message_id: `connect:${run.id}` },
  }, await loadAllNodes(db, target.id), { ...run.vars, [CONNECT_HOPS_VAR]: hops });
}

async function executeHandoff(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<void> {
  const cfg = node.config as { assign_to?: string; note?: string };
  const convUpdate: Record<string, unknown> = {
    status: "pending",
    bot_paused: true,
    ai_autoreply_disabled: true,
    updated_at: new Date().toISOString(),
  };
  if (cfg.assign_to) convUpdate.assigned_agent_id = cfg.assign_to;
  if (run.conversation_id) {
    await db
      .from("conversations")
      .update(convUpdate)
      .eq("account_id", run.account_id)
      .eq("id", run.conversation_id);
  }
  await logEvent(db, run.id, "handoff", node.node_key, {
    note: cfg.note ?? null,
    assigned_to: cfg.assign_to ?? null,
  });
  await endRun(db, run.id, "handed_off", "handoff_node");
}

/**
 * Resolve a condition node's subject value from DB / run state, then
 * call the pure `evaluateConditionPredicate`. Splits out so the
 * predicate itself stays unit-testable without a Supabase mock.
 *
 * Subject sources:
 *   - `var` → `flow_runs.vars[subject_key]` (captured by collect_input
 *     or http_fetch in v2).
 *   - `tag` → present iff `contact_tags(contact_id, tag_id)` exists.
 *     `subject_key` IS the tag UUID; the SELECT returns 1 row or 0.
 *   - `contact_field` → one of name/email/phone/company on `contacts`.
 */
async function evaluateConditionNode(
  db: AdminClient,
  run: FlowRunRow,
  cfg: ConditionNodeConfig,
): Promise<boolean> {
  const clock = { now: new Date(), timezone: clockTimezone(cfg) };
  const rules = conditionRules(cfg);
  // Evaluated in order and stopped early, so a later rule's lookup is skipped once the answer is known.
  for (const rule of rules) {
    const holds = ruleHolds(rule, await conditionSubject(db, run, rule), clock);
    if (cfg.match === "any" ? holds : !holds) return holds;
  }
  return cfg.match !== "any";
}

async function conditionSubject(
  db: AdminClient,
  run: FlowRunRow,
  rule: ConditionRule,
): Promise<string | undefined> {
  if (rule.subject === "time" || rule.subject === "date") return undefined;
  if (rule.subject === "var") {
    const v = run.vars[rule.subject_key];
    return typeof v === "string" ? v : v === undefined || v === null ? undefined : String(v);
  }
  if (rule.subject === "tag") {
    const { count } = await db
      .from("contact_tags")
      .select("contact_id", { count: "exact", head: true })
      .eq("contact_id", run.contact_id!)
      .eq("tag_id", rule.subject_key);
    // For tags, "present" really is the only meaningful test — the
    // `present`/`absent` operators are the natural fit. equals/contains
    // against a tag UUID would still work mechanically (compare its
    // existence to the value).
    return (count ?? 0) > 0 ? rule.subject_key : undefined;
  }
  if (rule.subject === "custom_field") {
    const { data } = await db
      .from("contact_custom_values")
      .select("value")
      .eq("account_id", run.account_id)
      .eq("contact_id", run.contact_id!)
      .eq("custom_field_id", rule.subject_key)
      .maybeSingle();
    const raw = (data as { value?: unknown } | null)?.value;
    return typeof raw === "string" && raw.length > 0 ? raw : undefined;
  }
  const ALLOWED = ["name", "email", "phone", "company"] as const;
  type AllowedField = (typeof ALLOWED)[number];
  if (!ALLOWED.includes(rule.subject_key as AllowedField)) {
    throw new Error(`unsupported contact_field: ${rule.subject_key}`);
  }
  const { data } = await db
    .from("contacts")
    .select(rule.subject_key)
    .eq("id", run.contact_id!)
    .maybeSingle();
  const raw = (data as Record<string, unknown> | null)?.[rule.subject_key];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

/**
 * Sends a question node's prompt. `attempt` keeps each re-send a
 * distinct outbound intent; `text` replaces the prompt (error message).
 * A Skip button turns the prompt into a one-button message.
 */
async function sendAskPrompt(
  run: FlowRunRow,
  node: FlowNodeRow,
  attempt: number,
  text?: string,
): Promise<string> {
  const cfg = node.config as unknown as CollectInputNodeConfig & AskMediaNodeConfig;
  const body = text ?? cfg.prompt_text;
  const ws = await workspaceValuesFor(run.account_id, `${body} ${cfg.skip_label ?? ""}`);
  const base = {
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
  };
  const key = `flow:${run.id}:${node.node_key}:${run.transition_seq ?? 0}:${attempt}`;
  const skip = (node.node_type === "collect_input" || node.node_type === "ask_media") && cfg.skip_label && cfg.skip_next;
  const { whatsapp_message_id } = await dispatchOnce(run.account_id, key, () =>
    skip
      ? engineSendInteractiveButtons({
          ...base,
          bodyText: interpolateVars(body, run.vars, ws),
          buttons: [{ id: SKIP_REPLY_ID, title: interpolateVars(cfg.skip_label!, run.vars, ws) }],
        })
      : engineSendText({
          ...base,
          text: interpolateVars(body, run.vars, ws),
          // An error message is plain text; only the prompt itself carries the request.
          request: text === undefined && node.node_type === "ask_location" ? "location"
            : text === undefined && node.node_type === "ask_address" ? "address" : undefined,
        }),
  );
  return whatsapp_message_id;
}

/**
 * Sends a send_form node's form. `attempt` keeps a re-send (reprompt) a
 * distinct outbound intent; each send issues a new one-time session tied to
 * this run and node, so only a submission of a form this node sent resumes it.
 */
async function sendFormForNode(run: FlowRunRow, node: FlowNodeRow, attempt: number): Promise<string> {
  const cfg = node.config as unknown as SendFormNodeConfig;
  const ws = await workspaceValuesFor(run.account_id, `${cfg.body} ${cfg.header ?? ""} ${cfg.footer ?? ""} ${cfg.cta}`);
  const { whatsappMessageId } = await sendForm({
    accountId: run.account_id,
    userId: run.user_id,
    sender: "bot",
    role: "owner",
    conversationId: run.conversation_id!,
    formId: cfg.form_id,
    cta: interpolateVars(cfg.cta, run.vars, ws),
    body: interpolateVars(cfg.body, run.vars, ws),
    header: interpolateOptionalVars(cfg.header, run.vars, ws),
    footer: interpolateOptionalVars(cfg.footer, run.vars, ws),
    intentKey: `flow:${run.id}:${node.node_key}:${run.transition_seq ?? 0}:${attempt}`,
    flowRunId: run.id,
    nodeKey: node.node_key,
  });
  return whatsappMessageId;
}

/**
 * A submission as run variables: the answers object under `var_key`, and
 * each answer as `<var_key>_<field_id>` text so `{{vars.x}}` and
 * conditions can read it (choices keep their option ids).
 */
export function formAnswerVars(key: string, answers: Record<string, string | number | boolean | string[]>): Record<string, unknown> {
  return {
    [key]: answers,
    ...Object.fromEntries(Object.entries(answers).map(([field, value]) => [`${key}_${field}`, Array.isArray(value) ? value.join(", ") : String(value)])),
  };
}

// ============================================================
// Payment link step. The link's reference is derived from the run, node
// and transition, so a replayed step finds the link it already created
// (lib/payments/links) instead of creating a second one. A verified
// Razorpay webhook or fetch resumes the run (resumePaymentLinkRun).
// ============================================================

type PaymentOutcome = "paid" | "expired" | "failed";

/** The node a payment outcome continues at, or null when that port is unwired (the run ends). */
export function paymentPortFor(cfg: Partial<PaymentLinkNodeConfig>, outcome: PaymentOutcome): string | null {
  const key = outcome === "paid" ? cfg.paid_next : outcome === "expired" ? cfg.expired_next : cfg.failed_next;
  return typeof key === "string" && key ? key : null;
}

/** How a run ends when a payment outcome has no port. */
function paymentEnd(outcome: PaymentOutcome): { status: "completed" | "failed"; reason: string } {
  return outcome === "failed" ? { status: "failed", reason: "payment_link_failed" } : { status: "completed", reason: `payment_${outcome}` };
}

async function setRunVars(db: AdminClient, run: FlowRunRow, patch: Record<string, unknown>): Promise<void> {
  const vars = { ...run.vars, ...patch };
  const { error } = await db.from("flow_runs").update({ vars }).eq("id", run.id).eq("status", "active");
  if (error) throw new Error("Run variable write failed");
  run.vars = vars;
}

/** Sends the step's message with the link under it. `attempt` keeps a re-send a distinct outbound intent. */
async function sendPaymentLinkText(run: FlowRunRow, node: FlowNodeRow, url: string, attempt: number): Promise<string> {
  const cfg = node.config as unknown as PaymentLinkNodeConfig;
  const ws = await workspaceValuesFor(run.account_id, cfg.message ?? "");
  const text = paymentLinkMessageText(interpolateVars(cfg.message ?? "", run.vars, ws), url);
  const { whatsapp_message_id } = await dispatchOnce(run.account_id, `flow:${run.id}:${node.node_key}:${run.transition_seq ?? 0}:${attempt}`, () => engineSendText({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    text,
  }));
  return whatsapp_message_id;
}

/**
 * Creates (or, on a replay, finds) the step's link and sends it. Returns
 * "waiting" once the link is out, or the port to continue at. A create with
 * an unknown outcome goes to the failed port and stays 'unknown' on the
 * payments page for reconciliation; it is never created again here.
 */
async function startPaymentLinkNode(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<{ kind: "waiting" } | { kind: "next"; outcome: PaymentOutcome; key: string | null }> {
  const cfg = node.config as unknown as PaymentLinkNodeConfig;
  const fail = async (reason: string, status = "failed") => {
    await setRunVars(db, run, { payment_status: status }).catch(() => undefined);
    await logEvent(db, run.id, "error", node.node_key, { reason });
    return { kind: "next" as const, outcome: "failed" as const, key: paymentPortFor(cfg, "failed") };
  };
  if (!run.conversation_id || !run.contact_id) return fail("payment_link_no_conversation");
  const ws = await workspaceValuesFor(run.account_id, `${cfg.amount ?? ""} ${cfg.description ?? ""}`);
  let amountMinor: number;
  try {
    amountMinor = parseMoney(interpolateVars(String(cfg.amount ?? ""), run.vars, ws), cfg.currency);
  } catch {
    return fail("payment_link_invalid_amount");
  }
  const minutes = cfg.expire_minutes;
  const expireBy = typeof minutes === "number" && Number.isInteger(minutes) && minutes > 0 ? new Date(Date.now() + minutes * 60_000) : null;
  let link: Awaited<ReturnType<typeof createPaymentLinkRecord>>["link"];
  try {
    ({ link } = await createPaymentLinkRecord({
      accountId: run.account_id,
      actor: { kind: "bot" },
      amountMinor,
      currency: cfg.currency,
      description: interpolateOptionalVars(cfg.description, run.vars, ws) || null,
      conversationId: run.conversation_id,
      contactId: run.contact_id,
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
      return { kind: "waiting" };
    }
    return fail("payment_link_send_failed", "send_failed");
  }
  return { kind: "waiting" };
}

/**
 * Resumes a run waiting on a payment_link step once its link is paid,
 * expired/cancelled or failed. Called after a verified Razorpay webhook or
 * fetch (lib/payments/links). Idempotent: only a run still waiting on that
 * node, in the transition the link was created for, moves.
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
  if (!run || run.status !== "active" || run.current_node_key !== args.nodeKey || run.delay_until) return "stale";
  if (flowPaymentReference(run.id, args.nodeKey, run.transition_seq ?? 0) !== args.referenceId) return "stale";
  const [flow, nodes] = await Promise.all([loadFlow(db, run.flow_id), loadAllNodes(db, run.flow_id)]);
  const node = nodes.get(args.nodeKey);
  if (!node || node.node_type !== "payment_link") return "stale";
  const now = new Date();
  const { data: contact } = await db.from("contacts").select("blocked_at,phone").eq("account_id", run.account_id).eq("id", run.contact_id!).maybeSingle();
  const testContact = Boolean(flow) && isTestContact(flow!, phoneDigits((contact as { phone?: string | null } | null)?.phone));
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
  const cfg = node.config as unknown as PaymentLinkNodeConfig;
  const vars = { ...run.vars, payment_status: args.status };
  const event = args.outcome === "paid" ? "payment_received" : args.outcome === "expired" ? "payment_expired" : "error";
  const next = paymentPortFor(cfg, args.outcome);
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

/**
 * Tiny `{{vars.foo}}` (and `{{workspace.key}}`) interpolation. Used by send_message + collect_input
 * prompt text so a captured `name` can show up in the next prompt
 * ("Thanks {{vars.name}}, what's your email?"). Missing vars render as
 * empty string — the same behavior as the automations engine.
 */
function interpolateVars(template: string, vars: Record<string, unknown>, workspace: Record<string, string> = {}): string {
  if (!template) return "";
  // Workspace first: captured vars are customer input and must not expand placeholders.
  return fillWorkspace(template, workspace).replace(/\{\{vars\.([a-zA-Z0-9_]+)\}\}/g, (_, key) => {
    const v = vars[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

/**
 * `interpolateVars` for optional config fields (header_text, footer_text,
 * list section titles, row descriptions). An absent field stays absent
 * — `interpolateVars(undefined)` would return "" and meta-api treats
 * header/footer/description by truthiness, so "" is harmless there, but
 * keeping `undefined` means the payload we log and send matches what
 * the author configured rather than sprouting empty strings.
 */
function interpolateOptionalVars(
  template: string | undefined,
  vars: Record<string, unknown>,
  workspace: Record<string, string> = {},
): string | undefined {
  return template === undefined || template === null
    ? undefined
    : interpolateVars(template, vars, workspace);
}

async function endRun(
  db: AdminClient,
  runId: string,
  status: "completed" | "handed_off" | "timed_out" | "failed" | "cancelled",
  reason: string,
): Promise<void> {
  const { data } = await db
    .from("flow_runs")
    .update({
      status,
      ended_at: new Date().toISOString(),
      end_reason: reason,
    })
    .eq("id", runId)
    .select("id,account_id,flow_id,contact_id,conversation_id,vars");
  const row = (data as Record<string, unknown>[] | null)?.[0];
  if (status !== "completed" || !row) return;
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
}

// ============================================================
// Timers. A delay or a wait-for-reply timeout is a `flow.timer` job
// keyed by the run's transition_seq: any reply, timer or delay moves
// the seq on, so a timer that lost its race finds a different seq and
// does nothing.
// ============================================================

type TimerKind = "delay" | "timeout";

function timerKey(runId: string, seq: number, kind: TimerKind, nodeKey: string): string {
  return `flow-timer:${runId}:${seq}:${kind}:${nodeKey}`;
}

/**
 * Parks the run on `node` until its delay ends. The job is queued
 * before the run moves, so a crash in between leaves at worst a timer
 * that finds a stale seq.
 */
async function scheduleDelay(
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
      detail: err instanceof Error ? err.message : String(err),
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
      last_advanced_at: new Date().toISOString(),
    })
    .eq("id", run.id)
    .eq("status", "active")
    .eq("transition_seq", run.transition_seq ?? 0);
  q = run.current_node_key === null ? q.is("current_node_key", null) : q.eq("current_node_key", run.current_node_key);
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
async function scheduleReplyTimeout(db: AdminClient, run: FlowRunRow, node: FlowNodeRow): Promise<void> {
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
      detail: err instanceof Error ? err.message : String(err),
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
  const [flow, nodes] = await Promise.all([loadFlow(db, run.flow_id), loadAllNodes(db, run.flow_id)]);
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
  const testContact = Boolean(flow) && isTestContact(flow!, phoneDigits((contact as { phone?: string | null } | null)?.phone));
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
  if (payload.kind === "delay") {
    if (due) {
      const { data: claimed, error: claimError } = await db
        .from("flow_runs")
        .update({ delay_until: null, transition_seq: payload.seq + 1, last_advanced_at: now.toISOString() })
        .eq("id", run.id)
        .eq("status", "active")
        .eq("current_node_key", payload.nodeKey)
        .eq("transition_seq", payload.seq)
        .select("id");
      if (claimError) throw new Error("Flow delay claim failed");
      if (!Array.isArray(claimed) || claimed.length !== 1) return "stale";
      Object.assign(run, { delay_until: null, transition_seq: payload.seq + 1 });
    }
    await advanceFromNodeKey(db, run, payload.nodeKey, nodes, payload.nodeKey);
    return "fired";
  }
  if (!timeout) return "stale";
  if (due) {
    if (!(await claimReplyTransition(db, run, timeout.next))) return "stale";
    await logEvent(db, run.id, "timeout", payload.nodeKey, { reason: "node_timeout", minutes: timeout.minutes });
  }
  await advanceFromNodeKey(db, run, timeout.next, nodes);
  return "fired";
}

// ============================================================
// The synchronous advance loop. Walks through auto-advance nodes
// until it hits one that suspends (send_buttons/send_list) or
// terminates (handoff/end). Each suspending node persists the
// new current_node_key before returning.
// ============================================================

async function advanceFromNodeKey(
  db: AdminClient,
  run: FlowRunRow,
  startNodeKey: string,
  nodes: Map<string, FlowNodeRow>,
  /** The node whose delay just elapsed; it runs now. */
  delayDoneFor?: string,
): Promise<{ outcome: "advanced" | "completed" | "handed_off" }> {
  let currentKey: string | null = startNodeKey;
  // Defensive cap — if a flow has a cycle (which the validator
  // SHOULD catch but doesn't yet in v1), we bail rather than loop.
  for (let safety = 0; safety < 64; safety += 1) {
    if (!currentKey) {
      await logEvent(db, run.id, "error", null, {
        reason: "next_node_key was null mid-advance",
      });
      await endRun(db, run.id, "failed", "missing_next_node");
      return { outcome: "completed" };
    }
    const node: FlowNodeRow | null = nodes.get(currentKey) ?? null;
    if (!node) {
      await logEvent(db, run.id, "error", currentKey, {
        reason: "node_not_found",
      });
      await endRun(db, run.id, "failed", "node_not_found");
      return { outcome: "completed" };
    }
    const delay = node.node_type === "start" || node.node_key === delayDoneFor ? 0 : nodeDelaySeconds(node.config);
    delayDoneFor = undefined;
    if (delay) {
      const scheduled = await scheduleDelay(db, run, node, delay);
      return { outcome: scheduled === "failed" ? "completed" : "advanced" };
    }
    await logEvent(db, run.id, "node_entered", node.node_key, {
      node_type: node.node_type,
    });

    if (node.node_type === "start") {
      currentKey = (node.config as unknown as StartNodeConfig).next_node_key;
      continue;
    }
    if (node.node_type === "send_message") {
      const cfg = node.config as unknown as SendMessageNodeConfig;
      try {
        const ws = await workspaceValuesFor(run.account_id, cfg.text);
        const { whatsapp_message_id } = await dispatchOnce(run.account_id, `flow:${run.id}:${node.node_key}:${run.transition_seq ?? 0}:${run.reprompt_count}`, () => engineSendText({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.text, run.vars, ws),
        }));
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "send_message",
          whatsapp_message_id,
        });
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_text_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "send_text_failed");
        return { outcome: "completed" };
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "send_media") {
      const cfg = node.config as unknown as SendMediaNodeConfig;
      try {
        const ws = await workspaceValuesFor(run.account_id, cfg.caption ?? '');
        const { whatsapp_message_id } = await dispatchOnce(run.account_id, `flow:${run.id}:${node.node_key}:${run.transition_seq ?? 0}:${run.reprompt_count}`, () => engineSendMedia({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          kind: cfg.media_type,
          link: cfg.media_url,
          caption: cfg.caption
            ? interpolateVars(cfg.caption, run.vars, ws)
            : undefined,
          filename: cfg.filename,
        }));
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "send_media",
          media_type: cfg.media_type,
          whatsapp_message_id,
        });
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_media_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "send_media_failed");
        return { outcome: "completed" };
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (isCommerceNodeType(node.node_type)) {
      // Catalogue steps: one outbound intent per transition, like send_media.
      const cfg = node.config as unknown as Record<string, unknown>;
      try {
        const texts = ["header_text", "body_text", "footer_text"].map((k) => (typeof cfg[k] === "string" ? cfg[k] : "")).join("\n");
        const ws = await workspaceValuesFor(run.account_id, texts);
        const { whatsappMessageId } = await sendCommerceMessage({
          accountId: run.account_id, role: "owner", sender: "bot", conversationId: run.conversation_id!,
          message: commerceMessageFromNode(node.node_type, cfg, (text) => interpolateVars(text, run.vars, ws)),
          intentKey: `flow:${run.id}:${node.node_key}:${run.transition_seq ?? 0}:${run.reprompt_count}`,
        });
        await logEvent(db, run.id, "message_sent", node.node_key, { node_type: node.node_type, whatsapp_message_id: whatsappMessageId });
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: `${node.node_type}_failed`,
          detail: err instanceof CommerceSendError ? err.code : err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", `${node.node_type}_failed`);
        return { outcome: "completed" };
      }
      currentKey = typeof cfg.next_node_key === "string" ? cfg.next_node_key : "";
      continue;
    }
    if (isAskNode(node.node_type)) {
      // Send the prompt and suspend. The customer's next reply wakes us
      // up via handleReplyForActiveRun's question branch.
      try {
        const whatsapp_message_id = await sendAskPrompt(run, node, run.reprompt_count);
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: node.node_type,
          whatsapp_message_id,
        });
        const { data: msg } = await db
          .from("messages")
          .select("id")
          .eq("message_id", whatsapp_message_id)
          .maybeSingle();
        await db
          .from("flow_runs")
          .update({
            last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
          })
          .eq("id", run.id);
      } catch (err) {
        const reason = `${node.node_type}_prompt_failed`;
        await logEvent(db, run.id, "error", node.node_key, {
          reason,
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", reason);
        return { outcome: "completed" };
      }
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      } else {
        await scheduleReplyTimeout(db, run, node);
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "send_form") {
      // Send the form and suspend; the submission wakes the run up.
      try {
        const whatsapp_message_id = await sendFormForNode(run, node, run.reprompt_count);
        await logEvent(db, run.id, "form_sent", node.node_key, {
          form_id: (node.config as unknown as SendFormNodeConfig).form_id,
          whatsapp_message_id,
        });
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_form_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "send_form_failed");
        return { outcome: "completed" };
      }
      const advanced = await advanceCurrentNodeKey(db, run.id, run.current_node_key, node.node_key);
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, { reason: "lost_race_during_advance" });
      } else {
        await scheduleReplyTimeout(db, run, node);
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "payment_link") {
      const started = await startPaymentLinkNode(db, run, node);
      if (started.kind === "next") {
        if (started.key) {
          currentKey = started.key;
          continue;
        }
        const end = paymentEnd(started.outcome);
        await endRun(db, run.id, end.status, end.reason);
        return { outcome: "completed" };
      }
      const advanced = await advanceCurrentNodeKey(db, run.id, run.current_node_key, node.node_key);
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, { reason: "lost_race_during_advance" });
        return { outcome: "advanced" };
      }
      await scheduleReplyTimeout(db, run, node);
      // A payment that settled before the run started waiting found no waiting run: catch up now.
      const reference = flowPaymentReference(run.id, node.node_key, run.transition_seq ?? 0);
      const latest = await findLinkByReference(run.account_id, reference).catch(() => null);
      const outcome = latest ? flowOutcomeFor(latest.status) : null;
      if (latest && outcome) {
        await resumePaymentLinkRun({ accountId: run.account_id, runId: run.id, nodeKey: node.node_key, referenceId: reference, outcome, status: latest.status });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "send_template") {
      const cfg = node.config as unknown as SendTemplateNodeConfig;
      try {
        await sendTemplateNode(db, run, node);
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_template_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "send_template_failed");
        return { outcome: "completed" };
      }
      if (!templateWaits(node.config)) {
        currentKey = cfg.next_node_key ?? null;
        continue;
      }
      const advanced = await advanceCurrentNodeKey(db, run.id, run.current_node_key, node.node_key);
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, { reason: "lost_race_during_advance" });
      } else {
        await scheduleReplyTimeout(db, run, node);
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "api_request") {
      currentKey = await executeApiRequest(db, run, node);
      continue;
    }
    if (node.node_type === "assign_agent") {
      await executeAssignAgent(db, run, node);
      currentKey = (node.config as unknown as AssignAgentNodeConfig).next_node_key;
      continue;
    }
    if (node.node_type === "connect_flow") {
      await executeConnectFlow(db, run, node);
      return { outcome: "completed" };
    }
    if (node.node_type === "set_attribute") {
      const cfg = node.config as unknown as SetAttributeNodeConfig;
      try {
        const ws = await workspaceValuesFor(run.account_id, cfg.value ?? "");
        const value = interpolateVars(cfg.value ?? "", run.vars, ws);
        if (cfg.target === "var") {
          const vars = { ...run.vars, [cfg.key]: value };
          const { error } = await db
            .from("flow_runs")
            .update({ vars })
            .eq("id", run.id)
            .eq("status", "active");
          if (error) throw new Error("Run variable write failed");
          run.vars = vars;
        } else if (!(await writeContactField(db, run.account_id, run.contact_id!, cfg.target === "custom_field" ? `custom:${cfg.key}` : cfg.key, value))) {
          throw new Error(`field ${cfg.key} is not writable`);
        }
        // The value itself may be customer input, so only its size is logged.
        await logEvent(db, run.id, "attribute_set", node.node_key, { target: cfg.target, key: cfg.key, length: value.length });
      } catch (err) {
        // Non-fatal, like set_tag: a failed write should not strand the customer.
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "set_attribute_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "condition") {
      const cfg = node.config as unknown as ConditionNodeConfig;
      let branch: "true" | "false";
      try {
        branch = (await evaluateConditionNode(db, run, cfg))
          ? "true"
          : "false";
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "condition_evaluation_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "condition_evaluation_failed");
        return { outcome: "completed" };
      }
      currentKey =
        branch === "true" ? cfg.true_next : cfg.false_next;
      await logEvent(db, run.id, "node_entered", node.node_key, {
        condition_result: branch,
        advancing_to: currentKey,
      });
      continue;
    }
    if (node.node_type === "set_tag") {
      const cfg = node.config as unknown as SetTagNodeConfig;
      try {
        if (cfg.mode === "add") {
          await addContactTagAndDispatch({
            db,
            accountId: run.account_id,
            contactId: run.contact_id!,
            tagId: cfg.tag_id,
            context: {
              conversation_id: run.conversation_id ?? undefined,
              vars: run.vars,
            },
          });
        } else {
          await removeContactTag(db, {
            accountId: run.account_id,
            contactId: run.contact_id!,
            tagId: cfg.tag_id,
          });
        }
      } catch (err) {
        // Non-fatal — log + advance. A tag-write failure shouldn't
        // strand the customer mid-flow.
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "set_tag_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "send_buttons") {
      // Same failure contract as send_message / send_media /
      // collect_input above: log + fail the run. Previously an
      // exception here (Meta error, or meta-api's length validation —
      // now reachable via interpolation, see sendButtonsAndSuspend)
      // escaped to dispatchInboundToFlows' catch, which only
      // console.error'd and left the run active + stuck on the prior
      // node with nothing in flow_run_events.
      try {
        await sendButtonsAndSuspend(db, run, node);
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_buttons_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "send_buttons_failed");
        return { outcome: "completed" };
      }
      // Persist the new current_node_key via optimistic UPDATE.
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      } else {
        await scheduleReplyTimeout(db, run, node);
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "send_list") {
      try {
        await sendListAndSuspend(db, run, node);
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_list_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "send_list_failed");
        return { outcome: "completed" };
      }
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      } else {
        await scheduleReplyTimeout(db, run, node);
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "handoff") {
      await executeHandoff(db, run, node);
      return { outcome: "handed_off" };
    }
    if (node.node_type === "end") {
      await logEvent(db, run.id, "completed", node.node_key);
      await endRun(db, run.id, "completed", "end_node");
      return { outcome: "completed" };
    }
    // Unknown node type — shouldn't happen given the CHECK constraint.
    await logEvent(db, run.id, "error", node.node_key, {
      reason: `unknown_node_type:${node.node_type}`,
    });
    await endRun(db, run.id, "failed", "unknown_node_type");
    return { outcome: "completed" };
  }
  // Safety break — log + fail.
  await logEvent(db, run.id, "error", currentKey, {
    reason: "advance_loop_safety_break",
  });
  await endRun(db, run.id, "failed", "advance_loop_overflow");
  return { outcome: "completed" };
}

/**
 * Optimistic UPDATE — only advance current_node_key when it matches
 * the value we read at the top of dispatch. If another webhook beat
 * us, the row's pointer has already moved and our UPDATE returns
 * zero rows; we treat that as a no-op and let the other run continue.
 */
async function advanceCurrentNodeKey(
  db: AdminClient,
  runId: string,
  expectedOldKey: string | null,
  newKey: string,
): Promise<boolean> {
  // PostgREST: when expectedOldKey is null we can't `.eq` (would match
  // any row); use `.is('current_node_key', null)` instead.
  let q = db
    .from("flow_runs")
    .update({
      current_node_key: newKey,
      last_advanced_at: new Date().toISOString(),
    })
    .eq("id", runId)
    .eq("status", "active");
  if (expectedOldKey === null) {
    q = q.is("current_node_key", null);
  } else {
    q = q.eq("current_node_key", expectedOldKey);
  }
  const { data, error } = await q.select("id");
  if (error) {
    console.error("[flows] advanceCurrentNodeKey error:", error.message);
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

// ============================================================
async function claimReplyTransition(
  db: AdminClient,
  run: FlowRunRow,
  nextNodeKey: string,
  extra: Record<string, unknown> = {},
): Promise<boolean> {
  const fromKey = run.current_node_key;
  if (fromKey === null) return false;
  const nextSeq = (run.transition_seq ?? 0) + 1;
  const { data, error } = await db
    .from("flow_runs")
    .update({
      ...extra,
      current_node_key: nextNodeKey,
      transition_seq: nextSeq,
      reprompt_count: 0,
      last_advanced_at: new Date().toISOString(),
    })
    .eq("id", run.id)
    .eq("status", "active")
    .eq("current_node_key", fromKey)
    .eq("transition_seq", run.transition_seq ?? 0)
    .select("id");
  if (error) {
    console.error("[flows] claimReplyTransition error:", error.message);
    return false;
  }
  if (!Array.isArray(data) || data.length !== 1) return false;
  run.current_node_key = nextNodeKey;
  run.transition_seq = nextSeq;
  run.reprompt_count = 0;
  return true;
}

/**
 * Adds vars to a run that stays on its current node. Compare-and-set on the
 * run's position: if the run moved meanwhile the merge is skipped (the vars
 * are a convenience, never worth overwriting a concurrent transition).
 */
async function mergeWaitingRunVars(db: AdminClient, run: FlowRunRow, vars: Record<string, string>): Promise<void> {
  if (run.current_node_key === null || Object.keys(vars).length === 0) return;
  const merged = { ...run.vars, ...vars };
  const { data, error } = await db
    .from("flow_runs")
    .update({ vars: merged })
    .eq("id", run.id)
    .eq("status", "active")
    .eq("current_node_key", run.current_node_key)
    .eq("transition_seq", run.transition_seq ?? 0)
    .select("id");
  if (error) {
    console.error("[flows] mergeWaitingRunVars error:", error.message);
    return;
  }
  if (Array.isArray(data) && data.length === 1) run.vars = merged;
}

async function closeActiveRun(
  db: AdminClient,
  run: FlowRunRow,
  closure: ActiveRunClosure,
  now: Date,
): Promise<boolean> {
  if (closure.kind === "timeout") {
    return markRunTimedOut(db, run.id, closure.check, "timed_out_on_reply", now, run);
  }
  await endRun(
    db,
    run.id,
    closure.kind === "cancel" ? "cancelled" : "failed",
    closure.reason,
  );
  return true;
}

// Public entry point — the webhook calls this on every inbound.
// ============================================================

/** Start only the selected active flow; never hijack an existing contact run. */
export async function startFlowById(input: DispatchInboundInput & { flowId: string }): Promise<{ outcome: 'started' | 'unavailable' | 'conflict' }> {
  const db = databaseAdmin();
  const contact = await db.from('contacts').select('id').eq('account_id', input.accountId).eq('id', input.contactId).maybeSingle();
  const conversation = await db.from('conversations').select('id').eq('account_id', input.accountId)
    .eq('id', input.conversationId).eq('contact_id', input.contactId).maybeSingle();
  if (contact.error || conversation.error) throw new Error('Explicit flow ownership lookup failed');
  if (!contact.data || !conversation.data || await botRepliesPaused(input.accountId, input.conversationId)) return { outcome: 'unavailable' };
  const target = await db.from('flows').select('*').eq('account_id', input.accountId).eq('id', input.flowId).eq('status', 'active').maybeSingle();
  if (target.error) throw new Error('Explicit flow target lookup failed');
  const flow = target.data as FlowRow | null;
  if (!flow || flow.id !== input.flowId || flow.account_id !== input.accountId || flow.status !== 'active' || !flow.entry_node_id) return { outcome: 'unavailable' };
  // Same policy as inbound dispatch: only a run on this conversation conflicts.
  const existing = await db.from('flow_runs').select('id').eq('account_id', input.accountId).eq('contact_id', input.contactId)
    .eq('conversation_id', input.conversationId).eq('status', 'active').limit(1);
  if (existing.error) throw new Error('Explicit flow active run lookup failed');
  if (existing.data?.length) return { outcome: 'conflict' };
  const nodes = await loadAllNodes(db, flow.id);
  if (!nodes.has(flow.entry_node_id)) return { outcome: 'unavailable' };
  const result = await startNewRun(db, flow, input, nodes);
  if (result.outcome === 'duplicate_inbound_ignored') return { outcome: 'conflict' };
  if (result.flow_run_id) {
    const run = await db.from('flow_runs').select('status').eq('account_id', input.accountId).eq('id', result.flow_run_id).maybeSingle();
    if (run.error) throw new Error('Explicit flow run outcome lookup failed');
    if (!run.data || run.data.status === 'failed') return { outcome: 'unavailable' };
  }
  return { outcome: result.consumed && result.outcome !== 'no_match' ? 'started' : 'unavailable' };
}

export async function dispatchInboundToFlows(
  input: DispatchInboundInput & { isFirstInboundMessage: boolean },
): Promise<DispatchInboundResult> {
  const db = databaseAdmin();
  // The contact's number is needed only when a draft flow is being tested; read it at most once.
  let digits: Promise<string> | undefined;
  const contactDigits = () => (digits ??= (async () => {
    const { data } = await db.from("contacts").select("phone").eq("account_id", input.accountId).eq("id", input.contactId).maybeSingle();
    return phoneDigits((data as { phone?: string | null } | null)?.phone);
  })());
  try {
    if (await botRepliesPaused(input.accountId, input.conversationId)) return { consumed: true, outcome: 'no_match' };
    const activeRun = await loadActiveRunForConversation(
      db,
      input.accountId,
      input.contactId,
      input.conversationId,
    );

    // Idempotency — only matters if there's already a run on this
    // conversation. For new runs, the partial unique index catches duplicate
    // starts at INSERT time.
    if (activeRun) {
      const dupe = await isDuplicateInbound(
        db,
        input.accountId,
        input.contactId,
        input.message.meta_message_id,
      );
      if (dupe) {
        return {
          consumed: true,
          flow_run_id: activeRun.id,
          outcome: "duplicate_inbound_ignored",
        };
      }
      // One SELECT for the whole flow's nodes — advance loop is now
      // in-memory. See loadAllNodes.
      const [runFlow, nodes] = await Promise.all([loadFlow(db, activeRun.flow_id), loadAllNodes(db, activeRun.flow_id)]);
      const now = new Date();
      const testContact = runFlow?.status === "draft" && isTestContact(runFlow, await contactDigits());
      const closure = closureForActiveRun({ run: activeRun, flow: runFlow, nodeKeys: nodes, now, testContact });
      if (!closure) return handleReplyForActiveRun(db, activeRun, runFlow!, input.message, nodes);
      if (!(await closeActiveRun(db, activeRun, closure, now))) {
        return { consumed: true, flow_run_id: activeRun.id, outcome: "duplicate_inbound_ignored" };
      }
    }

    // No active run → look for a flow whose entry trigger matches.
    const entry = await findEntryFlow(
      db,
      input.accountId,
      input.conversationId,
      input.message,
      input.isFirstInboundMessage,
      contactDigits,
    );
    if (!entry || !entry.flow.entry_node_id) {
      return { consumed: false, outcome: "no_match" };
    }
    const nodes = await loadAllNodes(db, entry.flow.id);
    return startNewRun(db, entry.flow, input, nodes, entry.vars);
  } catch (err) {
    console.error(
      "[flows] dispatchInboundToFlows threw:",
      err instanceof Error ? err.message : err,
    );
    return { consumed: false, outcome: "no_match" };
  }
}

async function handleReplyForActiveRun(
  db: AdminClient,
  run: FlowRunRow,
  flow: FlowRow,
  message: ParsedInbound,
  nodes: Map<string, FlowNodeRow>,
): Promise<DispatchInboundResult> {
  // Note: we intentionally do NOT persist the raw customer text. A
  // `collect_input` prompt that asks "what's your card number?" would
  // otherwise leave the PAN sitting in flow_run_events.payload forever,
  // visible to anyone with access to the runs viewer or the events
  // table. Length is enough for "did they actually reply?" debugging;
  // for the captured value itself, the `node_entered` event already
  // records `captured_key` + `captured_length` after the var is stored.
  await logEvent(db, run.id, "reply_received", run.current_node_key, {
    meta_message_id: message.meta_message_id,
    reply_kind: message.kind,
    reply_id: message.kind === "interactive_reply" ? message.reply_id : null,
    text_length: message.kind === "text" ? message.text.length : null,
  });

  if (!run.current_node_key) {
    // Defensive — a run with status='active' but no current node is
    // malformed. Fail the run rather than spin.
    await endRun(db, run.id, "failed", "active_run_missing_current_node");
    return {
      consumed: true,
      flow_run_id: run.id,
      outcome: "no_match",
    };
  }

  const currentNode = nodes.get(run.current_node_key) ?? null;
  if (!currentNode) {
    await endRun(db, run.id, "failed", "current_node_not_found");
    return { consumed: true, flow_run_id: run.id, outcome: "no_match" };
  }

  // A reply during a delay is recorded but changes nothing: the run
  // carries on when the delay ends, and no automation answers instead.
  if (run.delay_until) {
    return { consumed: true, flow_run_id: run.id, outcome: "waiting" };
  }

  // Two ways a reply can advance:
  //   1. Interactive button/list tap on a send_buttons/send_list node.
  //   2. An answer on a question node — captured into vars.
  //
  // Everything else falls through to the fallback policy below.
  if (message.kind === "form") {
    // Only the submission of the form this run's current node sent (its
    // own trusted session) resumes the run. Any other submission is
    // stored with its message and changes nothing here.
    const cfg = currentNode.config as unknown as SendFormNodeConfig;
    const ours = currentNode.node_type === "send_form" && message.trusted &&
      message.flow_run_id === run.id && message.node_key === currentNode.node_key;
    if (!ours || !cfg.var_key || !cfg.next_node_key) return { consumed: true, flow_run_id: run.id, outcome: "waiting" };
    const newVars = { ...run.vars, ...formAnswerVars(cfg.var_key, message.answers) };
    if (!(await claimReplyTransition(db, run, cfg.next_node_key, { vars: newVars }))) {
      return lostReplyRace(db, run, currentNode.node_key);
    }
    run.vars = newVars;
    // Field ids only: the answers are customer content.
    await logEvent(db, run.id, "form_submitted", currentNode.node_key, {
      form_id: message.form_id,
      fields: Object.keys(message.answers).slice(0, 100),
    });
    const outcome = await advanceFromNodeKey(db, run, cfg.next_node_key, nodes);
    return { consumed: true, flow_run_id: run.id, outcome: outcome.outcome };
  }

  if (message.kind === "order") {
    // Policy: a WhatsApp cart is never an answer. While a run waits (on a
    // question, buttons, a form...), the cart leaves it waiting where it is:
    // no var is captured from the cart summary, no reprompt or fallback fires.
    // The order itself is still handled outside the run (stored with its
    // message, order confirmation, order.created webhook). Its order_* vars
    // are merged into the waiting run so a flow that sent the product list can
    // use them later. An order_received flow starts only when no run is active
    // on the conversation: one active run per conversation is a database
    // invariant, and silently ending a run the customer is in the middle of
    // would lose their place.
    await mergeWaitingRunVars(db, run, message.vars);
    return { consumed: true, flow_run_id: run.id, outcome: "waiting" };
  }

  let matched: string | null = null;
  if (
    message.kind === "interactive_reply" &&
    (currentNode.node_type === "send_buttons" ||
      currentNode.node_type === "send_list" ||
      currentNode.node_type === "send_template")
  ) {
    // A template is never re-sent as a reprompt (it costs money), so an
    // unknown reply below only counts towards the flow's exhaust policy.
    matched = matchReplyId(currentNode, message.reply_id);
  } else if (isAskNode(currentNode.node_type)) {
    const cfg = currentNode.config as unknown as AskRetry & { skip_label?: string; skip_next?: string; next_node_key: string; var_key?: string };
    if (message.kind === "interactive_reply" && message.reply_id === SKIP_REPLY_ID && cfg.skip_label && cfg.skip_next) {
      if (!(await claimReplyTransition(db, run, cfg.skip_next))) {
        return lostReplyRace(db, run, currentNode.node_key);
      }
      await logEvent(db, run.id, "node_entered", currentNode.node_key, { skipped: true });
      const outcome = await advanceFromNodeKey(db, run, cfg.skip_next, nodes);
      return { consumed: true, flow_run_id: run.id, outcome: outcome.outcome };
    }
    const captured = await captureAnswer(currentNode, message);
    if (captured && cfg.var_key) {
      const newVars = { ...run.vars, ...captured };
      if (!(await claimReplyTransition(db, run, cfg.next_node_key, { vars: newVars }))) {
        return lostReplyRace(db, run, currentNode.node_key);
      }
      run.vars = newVars;
      await logEvent(db, run.id, "node_entered", currentNode.node_key, {
        captured_key: cfg.var_key,
        captured_length: captured[cfg.var_key].length,
      });
      const outcome = await advanceFromNodeKey(db, run, cfg.next_node_key, nodes);
      return { consumed: true, flow_run_id: run.id, outcome: outcome.outcome };
    }
    if (typeof cfg.max_attempts === "number" && cfg.max_attempts >= 1) {
      return retryQuestion(db, run, flow, currentNode, nodes);
    }
  }

  if (matched) {
    if (!(await claimReplyTransition(db, run, matched))) {
      return lostReplyRace(db, run, currentNode.node_key);
    }
    const outcome = await advanceFromNodeKey(db, run, matched, nodes);
    return {
      consumed: true,
      flow_run_id: run.id,
      outcome: outcome.outcome,
    };
  }

  // No match → fallback. Apply the policy.
  const policy = resolveFallbackPolicy(
    flow.fallback_policy,
  );
  // An opted-in menu may answer a text question while keeping the exact
  // same menu active. Reserve the inbound so automations cannot take it.
  if (policy.on_unknown_reply === "ai" && message.kind === "text" && message.text.trim() &&
      (currentNode.node_type === "send_buttons" || currentNode.node_type === "send_list")) {
    return { consumed: true, flow_run_id: run.id, outcome: "ai_fallback" };
  }
  const newReprompts = run.reprompt_count + 1;
  await db
    .from("flow_runs")
    .update({ reprompt_count: newReprompts })
    .eq("id", run.id);

  const action = decideFallback({ policy, reprompt_count: newReprompts });
  await logEvent(db, run.id, "fallback_fired", run.current_node_key, {
    action: action.type,
    reprompt_count: newReprompts,
  });
  if (action.type === "ignore") {
    // Don't consume — let automations have a shot at it.
    return { consumed: false, flow_run_id: run.id, outcome: "no_match" };
  }
  await sendFallbackMessage(db, run, currentNode, policy, message.meta_message_id);
  if (action.type === "reprompt") {
    run.reprompt_count = newReprompts;
    // Re-send the same prompt. Same node, no current_node_key change.
    // The interactive helpers interpolate run.vars themselves, so a
    // reprompt renders the same text the original prompt did. A send
    // failure here is logged but does not end the run — the customer
    // still has the original prompt on screen and can retry.
    try {
      if (currentNode.node_type === "send_buttons") {
        await sendButtonsAndSuspend(db, run, currentNode);
      } else if (currentNode.node_type === "send_list") {
        await sendListAndSuspend(db, run, currentNode);
      } else if (isAskNode(currentNode.node_type)) {
        // The customer sent something we couldn't accept. Re-send the
        // prompt so they try again.
        await sendAskPrompt(run, currentNode, newReprompts);
      } else if (currentNode.node_type === "send_form") {
        // Each re-send issues its own session for this run and node; either submission resumes it.
        await sendFormForNode(run, currentNode, newReprompts);
      } else if (currentNode.node_type === "payment_link" && typeof run.vars.payment_link_url === "string" && run.vars.payment_link_url) {
        // The same link again; the step never creates a second one.
        await sendPaymentLinkText(run, currentNode, run.vars.payment_link_url, newReprompts);
      }
    } catch (err) {
      await logEvent(db, run.id, "error", currentNode.node_key, {
        reason: "reprompt_send_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    return { consumed: true, flow_run_id: run.id, outcome: "fallback_fired" };
  }
  if (action.type === "handoff") return fallbackHandoff(db, run);
  // action.type === 'end'
  await endRun(db, run.id, "completed", "fallback_exhausted_end");
  return { consumed: true, flow_run_id: run.id, outcome: "completed" };
}

/**
 * The flow's default reply to an off-script message, sent before the
 * reprompt / handoff / end it triggers. One outbound intent per inbound
 * message, so a replayed inbound never sends it twice; a failed send is
 * logged and the fallback action still runs.
 */
async function sendFallbackMessage(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
  policy: ReturnType<typeof resolveFallbackPolicy>,
  inboundMessageId: string,
): Promise<void> {
  const message = policy.fallback_message;
  if (!message) return;
  try {
    const ws = await workspaceValuesFor(run.account_id, message.text);
    const text = interpolateVars(message.text, run.vars, ws);
    const base = { accountId: run.account_id, userId: run.user_id, conversationId: run.conversation_id!, contactId: run.contact_id! };
    const { whatsapp_message_id } = await dispatchOnce(run.account_id, `flow-fallback:${run.id}:${inboundMessageId}`, () =>
      message.media_type && message.media_url
        ? engineSendMedia({ ...base, kind: message.media_type, link: message.media_url, caption: text || undefined })
        : engineSendText({ ...base, text }));
    await logEvent(db, run.id, "message_sent", node.node_key, { node_type: "fallback_message", whatsapp_message_id });
  } catch (err) {
    await logEvent(db, run.id, "error", node.node_key, {
      reason: "fallback_message_failed",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

async function fallbackHandoff(db: AdminClient, run: FlowRunRow): Promise<DispatchInboundResult> {
  if (run.conversation_id) {
    await db
      .from("conversations")
      .update({ status: "pending", bot_paused: true, updated_at: new Date().toISOString() })
      .eq("id", run.conversation_id);
  }
  await logEvent(db, run.id, "handoff", run.current_node_key, {
    reason: "fallback_exhausted",
  });
  await endRun(db, run.id, "handed_off", "fallback_exhausted");
  return { consumed: true, flow_run_id: run.id, outcome: "handed_off" };
}

/**
 * The answer a question node stores, as run variables, or null when the
 * reply does not fit. A text question still reads a photo's caption or a
 * shared location as text, as it always has.
 */
async function captureAnswer(node: FlowNodeRow, message: ParsedInbound): Promise<Record<string, string> | null> {
  const key = (node.config as { var_key?: unknown }).var_key;
  if (typeof key !== "string" || !key) return null;
  switch (node.node_type) {
    case "collect_input": {
      // A tap, a cart or a form submission is never a typed answer.
      if (message.kind === "interactive_reply" || message.kind === "order" || message.kind === "form") return null;
      const value = await normalizeCollectedInput(messageText(message), node.config as unknown as CollectInputNodeConfig);
      return value === null ? null : { [key]: value };
    }
    case "ask_media": {
      const types = (node.config as unknown as AskMediaNodeConfig).media_types ?? [];
      if (message.kind !== "media" || (types.length > 0 && !types.includes(message.media_type))) return null;
      return { [key]: message.url, [`${key}_type`]: message.media_type };
    }
    case "ask_location": {
      if (message.kind !== "location") return null;
      const { latitude, longitude, name, address } = message;
      return {
        [key]: `${latitude},${longitude}`,
        [`${key}_latitude`]: String(latitude),
        [`${key}_longitude`]: String(longitude),
        ...(name ? { [`${key}_name`]: name } : {}),
        ...(address ? { [`${key}_address`]: address } : {}),
      };
    }
    case "ask_address": {
      if (message.kind === "address") {
        return {
          [key]: Object.values(message.values).join(", "),
          ...Object.fromEntries(Object.entries(message.values).map(([field, value]) => [`${key}_${field}`, value])),
        };
      }
      // Outside India (or when the form is ignored) the address is typed.
      const typed = message.kind === "text" ? message.text.trim() : "";
      return typed ? { [key]: typed.slice(0, 1000) } : null;
    }
    default:
      return null;
  }
}

/**
 * Node-level retries for a question with `max_attempts`: an invalid reply
 * gets the error message until the attempts run out, then the run follows
 * `exhausted_next`, or the flow's `on_exhaust` when that port is unset.
 */
async function retryQuestion(
  db: AdminClient,
  run: FlowRunRow,
  flow: FlowRow,
  node: FlowNodeRow,
  nodes: Map<string, FlowNodeRow>,
): Promise<DispatchInboundResult> {
  const cfg = node.config as unknown as AskRetry;
  const attempt = run.reprompt_count + 1;
  await logEvent(db, run.id, "input_invalid", node.node_key, { attempt, max_attempts: cfg.max_attempts });
  if (attempt < cfg.max_attempts!) {
    const { data, error } = await db
      .from("flow_runs")
      .update({ reprompt_count: attempt })
      .eq("id", run.id)
      .eq("status", "active")
      .eq("current_node_key", node.node_key)
      .eq("transition_seq", run.transition_seq ?? 0)
      .eq("reprompt_count", run.reprompt_count)
      .select("id");
    if (error || !Array.isArray(data) || data.length !== 1) {
      return lostReplyRace(db, run, node.node_key);
    }
    run.reprompt_count = attempt;
    try {
      await sendAskPrompt(run, node, attempt, cfg.error_text?.trim() ? cfg.error_text : undefined);
    } catch (err) {
      await logEvent(db, run.id, "error", node.node_key, {
        reason: "reprompt_send_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    return { consumed: true, flow_run_id: run.id, outcome: "fallback_fired" };
  }
  if (cfg.exhausted_next) {
    if (!(await claimReplyTransition(db, run, cfg.exhausted_next))) {
      return lostReplyRace(db, run, node.node_key);
    }
    const outcome = await advanceFromNodeKey(db, run, cfg.exhausted_next, nodes);
    return { consumed: true, flow_run_id: run.id, outcome: outcome.outcome };
  }
  if (resolveFallbackPolicy(flow.fallback_policy).on_exhaust === "end") {
    await endRun(db, run.id, "completed", "fallback_exhausted_end");
    return { consumed: true, flow_run_id: run.id, outcome: "completed" };
  }
  return fallbackHandoff(db, run);
}

async function lostReplyRace(
  db: AdminClient,
  run: FlowRunRow,
  nodeKey: string,
): Promise<DispatchInboundResult> {
  await logEvent(db, run.id, "error", nodeKey, {
    reason: "lost_race_during_reply",
  });
  return {
    consumed: true,
    flow_run_id: run.id,
    outcome: "duplicate_inbound_ignored",
  };
}

async function startNewRun(
  db: AdminClient,
  flow: FlowRow,
  input: DispatchInboundInput,
  nodes: Map<string, FlowNodeRow>,
  /** Variables carried over by Connect Flow. */
  vars: Record<string, unknown> = {},
): Promise<DispatchInboundResult> {
  // INSERT — partial unique index `idx_one_active_run_per_conversation`
  // catches concurrent inserts with 23505. We catch and return as
  // consumed:true (the parallel webhook handles it).
  const { data: inserted, error: insErr } = await db
    .from("flow_runs")
    .insert({
      flow_id: flow.id,
      // Tenancy: NOT NULL post-017. The partial unique index
      // `idx_one_active_run_per_conversation` is over (account_id,
      // contact_id, conversation_id) WHERE status='active', so two
      // accounts sharing a phone number, and two numbers of one
      // account, each run their own flows independently.
      account_id: flow.account_id,
      // Audit: preserves the flow's author on the run row for log
      // attribution.
      user_id: flow.user_id,
      contact_id: input.contactId,
      conversation_id: input.conversationId,
      status: "active",
      current_node_key: flow.entry_node_id,
      vars,
    })
    .select("*")
    .maybeSingle();
  if (insErr) {
    // 23505 = unique_violation → another webhook is starting the run.
    const msg = insErr.message ?? "";
    if (msg.includes("23505") || msg.includes("duplicate key")) {
      return { consumed: true, outcome: "duplicate_inbound_ignored" };
    }
    console.error("[flows] startNewRun insert error:", insErr.message);
    return { consumed: false, outcome: "no_match" };
  }
  const run = inserted as FlowRunRow;
  await logEvent(db, run.id, "started", flow.entry_node_id, {
    flow_id: flow.id,
    trigger_type: flow.trigger_type,
    meta_message_id: input.message.meta_message_id,
  });
  // Bump the flow's execution counter — used by the builder UI to
  // surface "X runs since activation" on the flow card.
  //
  // Atomic RPC (migration 012) rather than read-modify-write: two
  // concurrent webhooks starting runs for different contacts on the
  // same flow would otherwise both read N and both write N+1, losing
  // a count. Mirrors the automations engine's use of
  // `increment_automation_execution_count` (migration 007).
  const { error: incErr } = await db.rpc("increment_flow_execution_count", {
    p_flow_id: flow.id,
  });
  if (incErr) {
    // Non-fatal — the run itself succeeded; only the counter is off.
    console.error("[flows] execution_count rpc error:", incErr.message);
  }

  // Run the advance loop starting from the entry node.
  const outcome = await advanceFromNodeKey(db, run, flow.entry_node_id!, nodes);
  return {
    consumed: true,
    flow_run_id: run.id,
    outcome: outcome.outcome === "advanced" ? "started" : outcome.outcome,
  };
}
