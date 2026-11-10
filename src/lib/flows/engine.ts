import { checkRunTimeout, markRunTimedOut, type RunTimeoutCheck } from "./timeout";
import { botRepliesPaused } from '@/lib/whatsapp/bot-pause';
import { normalizeCollectedInput } from './input-validation';
import { dispatchOnce } from '@/lib/jobs/dispatch';
import { NoNumberError } from '@/lib/whatsapp/numbers';
import { enqueueJob } from '@/lib/jobs/queue';
import { writeContactField } from '@/lib/contacts/field-write';
import { clockTimezone, conditionRules, predicateHolds, ruleHolds } from './conditions';
import { adClickMatch, byPrecedence, isTestContact, keywordTriggerMatches, orderReceivedMatch, phoneDigits, templateReplyMatch } from './triggers';
import { conversionValue, isConversionEventName } from './conversion-node';
import { queueConversionEvent } from '@/lib/meta-ads/capi';
import { runApiRequest } from './api-request';
import { engineSendTemplate } from '@/lib/automations/meta-send';
import { canOwnConversations, nextRoundRobinAgent } from '@/lib/automations/round-robin';
import { sendForm, templateFlowTokens } from '@/lib/whatsapp/forms/send';
import { CommerceSendError, commerceMessageFromNode, isCommerceNodeType, sendCommerceMessage } from '@/lib/commerce/catalog-send';
import { isCurrencyCode, minorFromDb, parseMoney } from '@/lib/commerce/money';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { runStorefrontLinkNode, type StorefrontNodeResult } from './storefront-node';
import { createPaymentLinkRecord, findLinkByReference, flowOutcomeFor, flowPaymentReference, paymentLinkMessageText, PaymentLinkError } from '@/lib/payments/links';
import { flowAiTurnStarted, runFlowAiReply } from '@/lib/ai/flow-reply';
import { AI_REPLY_LIMITS, aiReplyMaxTurns } from './ai-reply-node';
import { PAYMENT_LINK_LIMITS } from './payment-node';
import { getT } from '@/lib/i18n/translate';
import { effectiveFlow, loadPublishedVersions, loadVersion, versionNodeMap, type EffectiveFlow, type FlowVersionRow } from './versions';
import * as appointmentRuntime from './appointment-runtime';
import {
  APPOINTMENT_STATE_VAR, BOOK_APPOINTMENT_LIMITS, appointmentDaysAhead, appointmentPortFor, appointmentReplyIds, dayLabel,
  pagedRows, parseAppointmentReply, readAppointmentState, rowTitle, singleListRows, slotDays,
  type AppointmentListRow, type AppointmentOutcome, type AppointmentStepState,
} from './appointment-node';
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
import { engineSendInteractiveList } from "./meta-send";
import { flowSend, runChannel } from "./channel-send";
import { nodeAvailableOn, scopeIncludes, triggerAvailableOn, type Channel } from "@/lib/channels/capabilities";
import { decideFallback, resolveFallbackPolicy } from "./fallback";
import { addContactTagAndDispatch } from "@/lib/contacts/tag-events";
import { removeContactTag } from "@/lib/contacts/tag-write";
import { marketingSuppression } from "@/lib/contacts/consent";
import { fillWorkspace, workspaceValuesFor } from "@/lib/workspace/attributes";
import { flowTemplateSendExtras } from "@/lib/whatsapp/template-send-params";
import {
  type ApiRequestNodeConfig,
  type AssignAgentNodeConfig,
  type ConnectFlowNodeConfig,
  type SendTemplateNodeConfig,
  type SendFormNodeConfig,
  type PaymentLinkNodeConfig,
  type SendStorefrontLinkNodeConfig,
  type AiReplyNodeConfig,
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
  type AdClickTriggerConfig,
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
    node_type === "assign_agent" ||
    node_type === "conversion_event"
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
  | { kind: "cancel"; reason: "flow_not_active" | "flow_archived" | "current_node_removed" }
  | { kind: "fail"; reason: "active_run_missing_current_node" }
  | { kind: "timeout"; check: RunTimeoutCheck };

/** The run fields its age is counted from. wait_until is a payment link's expiry (absent on older rows). */
export type RunStaleFields = Pick<FlowRunRow, "last_advanced_at" | "delay_until"> & { wait_until?: string | null };

/**
 * A run waiting out a delay, or waiting on a payment link that can still
 * be paid, is not stale until that delay or link ends.
 */
export function staleSince(run: RunStaleFields): string {
  let since = run.last_advanced_at;
  for (const until of [run.delay_until, run.wait_until]) {
    if (until && Date.parse(until) > Date.parse(since)) since = until;
  }
  return since;
}

export function closureForActiveRun(args: {
  /** flow_version_id: the run is pinned to a published version (Phase 12). */
  run: Pick<FlowRunRow, "current_node_key"> & RunStaleFields & { flow_version_id?: string | null };
  /** For a pinned run, the flow overlaid with its version (fallback policy from the version). */
  flow: Pick<FlowRow, "status" | "fallback_policy"> | null;
  nodeKeys: ReadonlySet<string> | { has(key: string): boolean };
  now: Date;
  /** The contact is one of the draft flow's test numbers, so its run may continue. */
  testContact?: boolean;
}): ActiveRunClosure | null {
  if (!args.flow) return { kind: "cancel", reason: "flow_not_active" };
  if (args.run.flow_version_id) {
    // A pinned run finishes on its version while the flow is live or paused;
    // only archiving ends it.
    if (args.flow.status === "archived") return { kind: "cancel", reason: "flow_archived" };
  } else if (args.flow.status !== "active" && !(args.flow.status === "draft" && args.testContact)) {
    // An unpinned run (draft test number, or started before versioning) runs
    // on the live draft, under the rule that applied before Phase 12.
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
    node_type === "book_appointment" ||
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

/**
 * The graph a run executes (Phase 12). A run pinned to a version runs on that
 * version's snapshot, with the flow's trigger, entry, fallback policy and
 * scope taken from the version; the flow's status and number stay live. An
 * unpinned run (a draft's test-number run, or one started before the flow
 * was versioned) runs on the live draft as before. A pinned version that
 * cannot be found gives an empty graph, which ends the run cleanly.
 */
export async function loadRunGraph(
  db: AdminClient,
  run: Pick<FlowRunRow, "account_id" | "flow_id"> & { flow_version_id?: string | null },
): Promise<{ flow: EffectiveFlow | null; nodes: Map<string, FlowNodeRow> }> {
  if (!run.flow_version_id) {
    const [flow, nodes] = await Promise.all([loadFlow(db, run.flow_id), loadAllNodes(db, run.flow_id)]);
    return { flow, nodes };
  }
  const [flow, version] = await Promise.all([loadFlow(db, run.flow_id), loadVersion(run.account_id, run.flow_version_id)]);
  if (!flow || !version || version.flow_id !== run.flow_id) return { flow, nodes: new Map() };
  return { flow: effectiveFlow(flow, version), nodes: versionNodeMap(version) };
}

/**
 * The graph a new run of `flow` starts on: its published version, or the live
 * draft for a draft being tested and for an active flow not yet versioned (a
 * deploy-window straggler, logged). Null when the published version is gone.
 */
async function startGraph(
  db: AdminClient,
  flow: FlowRow,
): Promise<{ flow: EffectiveFlow; nodes: Map<string, FlowNodeRow> } | null> {
  if (flow.published_version_id && flow.status !== "draft") {
    const version = await loadVersion(flow.account_id, flow.published_version_id);
    if (!version || version.flow_id !== flow.id) return null;
    return { flow: effectiveFlow(flow, version), nodes: versionNodeMap(version) };
  }
  if (flow.status === "active") console.warn("[flows] unversioned active flow", { flowId: flow.id });
  return { flow, nodes: await loadAllNodes(db, flow.id) };
}

/** The fallback policy a run follows: its version's, or the live flow's when unpinned. */
async function runFallbackPolicy(db: AdminClient, run: FlowRunRow): Promise<FlowRow["fallback_policy"] | undefined> {
  if (run.flow_version_id) {
    const version = await loadVersion(run.account_id, run.flow_version_id);
    return version?.fallback_policy as FlowRow["fallback_policy"] | undefined;
  }
  return (await loadFlow(db, run.flow_id))?.fallback_policy;
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
    | "payment_expired"
    | "ai_replied"
    | "ai_handoff"
    | "conversion_queued"
    | "ad_click",
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

/**
 * Whether a flow may start on a conversation (Phase 11). The flow's
 * channel_scope must include the conversation's channel. On WhatsApp the
 * number tie applies as before; on Instagram the number tie is ignored and
 * only the triggers Instagram supports can start a run.
 */
export function flowListensOnConversation(
  flow: Pick<FlowRow, "channel_scope" | "whatsapp_config_id" | "trigger_type">,
  conversation: { channel: Channel; whatsappConfigId: string | null },
): boolean {
  if (!scopeIncludes(flow.channel_scope, conversation.channel)) return false;
  if (conversation.channel === "instagram") return triggerAvailableOn(flow.trigger_type, "instagram");
  return flowListensOnNumber(flow, conversation.whatsappConfigId);
}

async function findEntryFlow(
  db: AdminClient,
  accountId: string,
  conversationId: string,
  message: ParsedInbound,
  isFirstInbound: boolean,
  contactDigits: () => Promise<string>,
): Promise<{ flow: EffectiveFlow; vars: Record<string, string>; version?: FlowVersionRow } | null> {
  // A tap used to be rejected outright here, on the reasoning that
  // interactive replies are responses to existing prompts. That holds
  // only while a prompt is outstanding — and this function runs solely
  // when the conversation has NO active run, so there is nothing the tap
  // could be answering. What it actually blocked was issue #490: an
  // *automation* sends the buttons, the customer taps one, and the flow
  // whose keyword matches that button never starts. Retyping the label
  // by hand worked, which is the tell — same words, different envelope.
  const candidates = entryTriggerTexts(message);

  // The inbound's channel and number are its conversation's (one conversation
  // per contact and number, or per contact and Instagram account). Always read:
  // an Instagram conversation must never start a WhatsApp-only flow.
  const { data, error } = await db.from("conversations").select("channel, whatsapp_config_id")
    .eq("account_id", accountId).eq("id", conversationId).maybeSingle();
  if (error) return null;
  const row = data as { channel?: string | null; whatsapp_config_id?: string | null } | null;
  const conversation = {
    channel: (row?.channel === "instagram" ? "instagram" : "whatsapp") as Channel,
    whatsappConfigId: row?.whatsapp_config_id ?? null,
  };

  // Active flows, plus drafts being tested (only those with test numbers
  // are fetched); both sets are small. A testing draft runs its own row, so
  // only the conversation channel's drafts and legacy 'any' ones are read
  // (Stage 1). An active flow runs its published version, whose scope can
  // differ from the row's (a draft moved before Stage 1 locked published
  // scopes), so the active query is not narrowed by the row's scope:
  // flowListensOnConversation below decides on the scope each flow runs on.
  const scopes = [conversation.channel, "any"];
  const [active, drafts] = await Promise.all([
    db.from("flows").select("*").eq("account_id", accountId).eq("status", "active").order("created_at", { ascending: true }),
    db.from("flows").select("*").eq("account_id", accountId).eq("status", "draft").neq("test_numbers", []).in("channel_scope", scopes).order("created_at", { ascending: true }),
  ]);
  if (active.error || drafts.error) return null;
  const testing = ((drafts.data ?? []) as FlowRow[]).filter((f) => f.status === "draft" && (f.test_numbers ?? []).length > 0);
  const digits = testing.length ? await contactDigits() : "";
  // An active flow matches on its published version (Phase 12); one not yet
  // versioned (deploy-window straggler) matches on its draft, as before.
  const live = ((active.data ?? []) as FlowRow[]).filter((f) => f.status === "active");
  const versionIds = live.map((f) => f.published_version_id).filter((id): id is string => Boolean(id));
  const versions = versionIds.length ? await loadPublishedVersions(accountId, versionIds) : new Map<string, FlowVersionRow>();
  const versionOf = new Map<string, FlowVersionRow>();
  const liveFlows: EffectiveFlow[] = [];
  for (const f of live) {
    if (!f.published_version_id) {
      console.warn("[flows] unversioned active flow", { flowId: f.id });
      liveFlows.push(f);
      continue;
    }
    const version = versions.get(f.published_version_id);
    if (!version || version.flow_id !== f.id) continue;
    versionOf.set(f.id, version);
    liveFlows.push(effectiveFlow(f, version));
  }
  const candidatesByStatus: EffectiveFlow[] = [
    ...liveFlows,
    ...testing.filter((f) => isTestContact(f, digits)),
  ];
  if (!candidatesByStatus.length) return null;
  const typed = byPrecedence(candidatesByStatus.filter((f) =>
    flowListensOnConversation(f, conversation)));
  const found = (flow: EffectiveFlow, vars: Record<string, string>) => ({ flow, vars, version: versionOf.get(flow.id) });
  for (const flow of typed) {
    if (flow.trigger_type === "order_received") {
      const vars = orderReceivedMatch(message);
      if (vars) return found(flow, vars);
    } else if (flow.trigger_type === "ad_click") {
      // Only a click-to-WhatsApp ad (not a boosted post); an active run
      // already took the message before this point (no preemption).
      const vars = adClickMatch(message, flow.trigger_config as AdClickTriggerConfig);
      if (vars) return found(flow, vars);
    } else if (flow.trigger_type === "template_reply") {
      const vars = templateReplyMatch(message, flow.trigger_config as TemplateReplyTriggerConfig);
      if (vars) return found(flow, vars);
    } else if (flow.trigger_type === "keyword") {
      const cfg = flow.trigger_config as KeywordTriggerConfig;
      for (const text of candidates) {
        if (await keywordTriggerMatches(text, cfg)) return found(flow, {});
      }
    } else if (flow.trigger_type === "first_inbound_message" && isFirstInbound) {
      // Also reachable by a tap now: a broadcast template with a
      // quick-reply button can genuinely be what prompts a contact's
      // first-ever inbound. The automations dispatcher has always
      // treated a tap that way (the webhook pushes
      // `first_inbound_message` regardless of envelope) — flows were
      // the inconsistent half.
      return found(flow, {});
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
  const { whatsapp_message_id } = await flowSend(run, `flow:${run.id}:${node.node_key}:${run.transition_seq ?? 0}:${run.reprompt_count}`, { kind: "buttons", args: {
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
  } });
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
  const { whatsapp_message_id } = await flowSend(run, `flow:${run.id}:${node.node_key}:${run.transition_seq ?? 0}:${run.reprompt_count}`, { kind: "list", args: {
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
  } });
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
/**
 * WhatsApp-only sends (templates, appointment lists) refuse an Instagram run
 * BEFORE dispatchOnce, so no outbound intent is ever claimed for them. The main
 * loop already routes these node types away on Instagram; this also covers the
 * resume paths (a waiting appointment step answered later) that skip it.
 */
async function assertWhatsAppRun(run: FlowRunRow): Promise<void> {
  if ((await runChannel(run)) === "instagram") throw new NoNumberError("other_channel");
}

async function sendTemplateNode(db: AdminClient, run: FlowRunRow, node: FlowNodeRow): Promise<void> {
  await assertWhatsAppRun(run);
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

/**
 * Why the run's contact must not get a template (opted out or blocked), or
 * null. Read fresh each time: a STOP can arrive while the run waits.
 */
async function templateSuppression(db: AdminClient, run: FlowRunRow): Promise<string | null> {
  if (!run.contact_id) return null;
  const { data, error } = await db.from("contacts").select("opted_out_at,blocked_at")
    .eq("account_id", run.account_id).eq("id", run.contact_id).maybeSingle();
  if (error) throw new Error("Contact consent lookup failed");
  return marketingSuppression(data as { opted_out_at?: string | null; blocked_at?: string | null } | null);
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
      detail: errorDetail(err),
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
    // A pinned member removed or demoted to viewer since the flow was built is skipped.
    if (cfg.mode !== "round_robin" && !(await canOwnConversations(run.account_id, agentId))) {
      throw new Error("pinned member can no longer own conversations");
    }
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
      detail: errorDetail(err),
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
  const targetRow = data as FlowRow | null;
  // The target starts on its published version (or its draft, if not yet versioned).
  const graph = targetRow && targetRow.status === "active" ? await startGraph(db, targetRow) : null;
  const target = graph?.flow ?? null;
  // Counted in hops rather than time, so a loop slowed by delays still stops.
  const { count: replies } = await db
    .from("flow_run_events")
    .select("id", { count: "exact", head: true })
    .eq("flow_run_id", run.id)
    .eq("event_type", "reply_received");
  const hops = (replies ?? 0) > 0 ? 1 : (Number(run.vars[CONNECT_HOPS_VAR]) || 0) + 1;
  const reason = !target || target.status !== "active" || !target.entry_node_id
    ? "connect_flow_unavailable"
    : !scopeIncludes(target.channel_scope, await runChannel(run)) ? "unavailable_on_channel"
    : hops > MAX_CONNECT_HOPS ? "connect_flow_loop" : null;
  if (reason || !target || !run.contact_id || !run.conversation_id) {
    await logEvent(db, run.id, "error", node.node_key, { reason: reason ?? "connect_flow_unavailable" });
    await endRun(db, run.id, "failed", reason ?? "connect_flow_unavailable");
    return;
  }
  await logEvent(db, run.id, "flow_connected", node.node_key, { flow_id: target.id });
  // Paused by an agent (or timed out) meanwhile: the contact gets no new flow.
  if (!(await endRun(db, run.id, "completed", "connect_flow"))) return;
  await startNewRun(db, target, {
    accountId: run.account_id,
    userId: run.user_id,
    contactId: run.contact_id,
    conversationId: run.conversation_id,
    message: { kind: "text", text: "", meta_message_id: `connect:${run.id}` },
  }, graph!.nodes, { ...run.vars, [CONNECT_HOPS_VAR]: hops });
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
  // A pinned member removed or demoted to viewer is not assigned: the handoff
  // still pauses the bot and the conversation goes to normal routing (audit #51).
  let assignee = cfg.assign_to && (await canOwnConversations(run.account_id, cfg.assign_to)) ? cfg.assign_to : null;
  if (cfg.assign_to && !assignee) {
    await logEvent(db, run.id, "error", node.node_key, { reason: "handoff_assignee_unavailable" });
    console.warn("[flows] handoff assignee unavailable; left to routing", { runId: run.id });
  }
  if (run.conversation_id) {
    const update = (row: Record<string, unknown>) => db
      .from("conversations")
      .update(row)
      .eq("account_id", run.account_id)
      .eq("id", run.conversation_id!);
    let { error } = await update(assignee ? { ...convUpdate, assigned_agent_id: assignee } : convUpdate);
    // Removed between the check and the write (the membership key refuses it): hand off unassigned.
    if (error && assignee) {
      await logEvent(db, run.id, "error", node.node_key, { reason: "handoff_assignee_unavailable" });
      assignee = null;
      ({ error } = await update(convUpdate));
    }
    if (error) throw new Error("Handoff conversation update failed");
  }
  await logEvent(db, run.id, "handoff", node.node_key, {
    note: cfg.note ?? null,
    assigned_to: assignee,
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
  const { whatsapp_message_id } = await flowSend(run, key,
    skip
      ? { kind: "buttons", args: {
          ...base,
          bodyText: interpolateVars(body, run.vars, ws),
          buttons: [{ id: SKIP_REPLY_ID, title: interpolateVars(cfg.skip_label!, run.vars, ws) }],
        } }
      : { kind: "text", args: {
          ...base,
          text: interpolateVars(body, run.vars, ws),
          // An error message is plain text; only the prompt itself carries the request.
          request: text === undefined && node.node_type === "ask_location" ? "location"
            : text === undefined && node.node_type === "ask_address" ? "address" : undefined,
        } },
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
  const { whatsapp_message_id } = await flowSend(run, `flow:${run.id}:${node.node_key}:${run.transition_seq ?? 0}:${attempt}`, { kind: "text", args: {
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    text,
  } });
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
): Promise<{ kind: "waiting"; expiresAt: string | null } | { kind: "next"; outcome: PaymentOutcome; key: string | null }> {
  const cfg = node.config as unknown as PaymentLinkNodeConfig;
  const fail = async (reason: string, status = "failed") => {
    await setRunVars(db, run, { payment_status: status }).catch(() => undefined);
    await logEvent(db, run.id, "error", node.node_key, { reason });
    return { kind: "next" as const, outcome: "failed" as const, key: paymentPortFor(cfg, "failed") };
  };
  if (!run.conversation_id || !run.contact_id) return fail("payment_link_no_conversation");
  const ws = await workspaceValuesFor(run.account_id, `${cfg.amount ?? ""} ${cfg.description ?? ""}`);
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
async function flowOrderDue(accountId: string, contactId: string, orderVar: unknown): Promise<
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
async function paymentLinkExpiryMinutes(db: AdminClient, run: FlowRunRow, cfg: PaymentLinkNodeConfig): Promise<number> {
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

interface AppointmentPrompt {
  state: AppointmentStepState;
  text: string;
  rows: AppointmentListRow[];
}

type AppointmentProgress = Omit<AppointmentStepState, "stage">;

const appointmentT = () => getT("Flows.builder.appointment");
const appointmentLocale = () => process.env.NEXT_PUBLIC_APP_LOCALE || "en";

function withoutAppointmentState(vars: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...vars };
  delete rest[APPOINTMENT_STATE_VAR];
  return rest;
}

/**
 * The next question to ask from `from`, resolving every question that has
 * one possible answer (a single service, one location, no practitioner
 * choice). Null when nothing can be booked.
 */
async function planAppointmentPrompt(run: FlowRunRow, node: FlowNodeRow, from: AppointmentProgress, notice?: string): Promise<AppointmentPrompt | null> {
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

/** Sends one question as a list. `attempt` keeps a re-prompt a distinct outbound intent. */
async function sendAppointmentPrompt(db: AdminClient, run: FlowRunRow, node: FlowNodeRow, prompt: AppointmentPrompt, attempt: number): Promise<void> {
  await assertWhatsAppRun(run);
  const { whatsapp_message_id } = await dispatchOnce(run.account_id, `flow:${run.id}:${node.node_key}:${run.transition_seq ?? 0}:${attempt}`, () => engineSendInteractiveList({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText: prompt.text,
    buttonLabel: appointmentT()("listButton"),
    sections: [{ rows: prompt.rows }],
  }));
  // The stage only: row titles can carry practitioner names, never logged.
  await logEvent(db, run.id, "message_sent", node.node_key, { node_type: "book_appointment", stage: prompt.state.stage, whatsapp_message_id });
  const { data: msg } = await db.from("messages").select("id").eq("message_id", whatsapp_message_id).maybeSingle();
  await db.from("flow_runs").update({ last_prompt_message_id: (msg as { id: string } | null)?.id ?? null }).eq("id", run.id);
}

/**
 * Entering the step: asks the first question that needs the customer, or
 * returns the port to continue at when nothing can be booked.
 */
async function startAppointmentStep(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<{ kind: "waiting" } | { kind: "next"; outcome: AppointmentOutcome; key: string | null } | { kind: "failed" }> {
  const unavailable = async (reason: string) => {
    await logEvent(db, run.id, "error", node.node_key, { reason });
    if (APPOINTMENT_STATE_VAR in run.vars) {
      const vars = withoutAppointmentState(run.vars);
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
    await setRunVars(db, run, { [APPOINTMENT_STATE_VAR]: prompt.state });
    await sendAppointmentPrompt(db, run, node, prompt, run.reprompt_count);
  } catch (err) {
    await logEvent(db, run.id, "error", node.node_key, { reason: "book_appointment_failed", detail: errorDetail(err) });
    await endRun(db, run.id, "failed", "book_appointment_failed");
    return { kind: "failed" };
  }
  return { kind: "waiting" };
}

/** Leaves the step through an outcome port (an unwired one ends the run), dropping its progress. */
async function finishAppointmentStep(
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
async function askNextAppointmentQuestion(
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
async function retryAppointmentQuestion(
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
async function handleAppointmentReply(
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
      await logEvent(db, run.id, "node_entered", node.node_key, { appointment_result: "booked", appointment_id: result.appointmentId, replayed: result.replayed });
      return finishAppointmentStep(db, run, node, nodes, "success", {
        appointment_id: result.appointmentId,
        appointment_local_time: result.localTime,
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
async function resumeInterruptedBooking(
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

/**
 * One AI turn of an ai_reply step (lib/ai/flow-reply.ts) and its event:
 * `ai_replied` with the score and citations (document ids, titles and
 * urls, never content) or `ai_handoff` with a reason code. Returns the
 * port to follow, or null to keep waiting for the next follow-up, plus
 * the run vars to store (the answer under var_key).
 */
async function aiReplyTurn(
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
async function continueAiReplyNode(
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
async function endRun(
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
    .select("id,account_id,flow_id,contact_id,conversation_id,vars");
  if (error) throw new Error("Flow run end failed");
  const row = (data as Record<string, unknown>[] | null)?.[0];
  if (!row) return false;
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
async function runConversionEvent(run: FlowRunRow, node: FlowNodeRow): Promise<{ queued: boolean; error?: string }> {
  const cfg = node.config;
  // Purchase is rejected here too (payments and orders report it, keyed by the order).
  if (!isConversionEventName(cfg.event_name)) return { queued: false, error: "invalid_event" };
  if (!run.contact_id) return { queued: false };
  const value = conversionValue(run.vars, cfg.value_var);
  const currency = isCurrencyCode(cfg.currency) ? cfg.currency : undefined;
  try {
    const queued = await queueConversionEvent(run.account_id, {
      eventName: cfg.event_name,
      source: "flow",
      sourceId: `${run.id}:${node.node_key}`,
      contactId: run.contact_id,
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

/** The failure-style port a step offers, taken when the step cannot run on the conversation's channel. */
function channelFailurePort(config: Record<string, unknown>): string | null {
  for (const key of ["failed_next", "unavailable_next", "handoff_next"]) {
    const next = config[key];
    if (typeof next === "string" && next) return next;
  }
  return null;
}

/** A step this channel cannot run and no failure port: the conversation goes to a person. */
async function handOffUnavailable(db: AdminClient, run: FlowRunRow, node: FlowNodeRow): Promise<{ outcome: "handed_off" }> {
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

    if (node.node_type !== "start" && (await runChannel(run)) === "instagram"
      && !nodeAvailableOn(node.node_type, "instagram", node.config).ok) {
      await logEvent(db, run.id, "error", node.node_key, { reason: "unavailable_on_channel", node_type: node.node_type });
      const failure = channelFailurePort(node.config);
      if (failure) {
        currentKey = failure;
        continue;
      }
      return handOffUnavailable(db, run, node);
    }

    if (node.node_type === "start") {
      currentKey = (node.config as unknown as StartNodeConfig).next_node_key;
      continue;
    }
    if (node.node_type === "send_message") {
      const cfg = node.config as unknown as SendMessageNodeConfig;
      try {
        const ws = await workspaceValuesFor(run.account_id, cfg.text);
        const { whatsapp_message_id } = await flowSend(run, `flow:${run.id}:${node.node_key}:${run.transition_seq ?? 0}:${run.reprompt_count}`, { kind: "text", args: {
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.text, run.vars, ws),
        } });
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "send_message",
          whatsapp_message_id,
        });
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_text_failed",
          detail: errorDetail(err),
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
        const { whatsapp_message_id } = await flowSend(run, `flow:${run.id}:${node.node_key}:${run.transition_seq ?? 0}:${run.reprompt_count}`, { kind: "media", args: {
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
        } });
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "send_media",
          media_type: cfg.media_type,
          whatsapp_message_id,
        });
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_media_failed",
          detail: errorDetail(err),
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
          detail: errorDetail(err),
        });
        await endRun(db, run.id, "failed", reason);
        return { outcome: "completed" };
      }
      const advanced = await advanceCurrentNodeKey(
        db,
        run,
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
    if (node.node_type === "ai_reply") {
      // The AI answers the customer's latest message. One answer moves on
      // through a port; with more turns the step waits for follow-ups.
      const turn = await aiReplyTurn(db, run, node, `flow:${run.id}:${node.node_key}:${run.transition_seq ?? 0}:${run.reprompt_count}`, 1);
      if (turn.ended) return { outcome: "completed" };
      if (turn.vars) {
        try {
          await setRunVars(db, run, turn.vars);
        } catch (err) {
          // Non-fatal, like set_attribute: the answer already went out.
          await logEvent(db, run.id, "error", node.node_key, { reason: "ai_reply_var_failed", detail: errorDetail(err) });
        }
      }
      if (turn.next !== null) {
        currentKey = turn.next;
        continue;
      }
      const advanced = await advanceCurrentNodeKey(db, run, run.current_node_key, node.node_key);
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, { reason: "lost_race_during_advance" });
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
          detail: errorDetail(err),
        });
        await endRun(db, run.id, "failed", "send_form_failed");
        return { outcome: "completed" };
      }
      const advanced = await advanceCurrentNodeKey(db, run, run.current_node_key, node.node_key);
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
      // The run is not stale while the link can still be paid (staleSince).
      const advanced = await advanceCurrentNodeKey(db, run, run.current_node_key, node.node_key, { wait_until: started.expiresAt });
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
    if (node.node_type === "book_appointment") {
      const started = await startAppointmentStep(db, run, node);
      if (started.kind === "failed") return { outcome: "completed" };
      if (started.kind === "next") {
        if (started.key) {
          currentKey = started.key;
          continue;
        }
        await endRun(db, run.id, "completed", `appointment_${started.outcome}`);
        return { outcome: "completed" };
      }
      const advanced = await advanceCurrentNodeKey(db, run, run.current_node_key, node.node_key);
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, { reason: "lost_race_during_advance" });
      } else {
        await scheduleReplyTimeout(db, run, node);
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "send_template") {
      const cfg = node.config as unknown as SendTemplateNodeConfig;
      // Templates are business-initiated: an opted-out or blocked contact is skipped (lib/contacts/consent).
      const suppressed = await templateSuppression(db, run);
      if (suppressed) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "template_suppressed",
          detail: suppressed.toLowerCase(),
        });
        if (!cfg.next_node_key) {
          await endRun(db, run.id, "cancelled", "contact_opted_out");
          return { outcome: "completed" };
        }
        currentKey = cfg.next_node_key;
        continue;
      }
      try {
        await sendTemplateNode(db, run, node);
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_template_failed",
          detail: errorDetail(err),
        });
        await endRun(db, run.id, "failed", "send_template_failed");
        return { outcome: "completed" };
      }
      if (!templateWaits(node.config)) {
        currentKey = cfg.next_node_key ?? null;
        continue;
      }
      const advanced = await advanceCurrentNodeKey(db, run, run.current_node_key, node.node_key);
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
    if (node.node_type === "conversion_event") {
      // Queued for the worker, never sent inline; a no-op while CAPI is off.
      const result = await runConversionEvent(run, node);
      if (result.queued) {
        await logEvent(db, run.id, "conversion_queued", node.node_key, { event_name: node.config.event_name });
      } else if (result.error) {
        await logEvent(db, run.id, "error", node.node_key, result.error === "invalid_event"
          ? { reason: "conversion_invalid_event" }
          : { reason: "conversion_queue_failed", detail: result.error });
      }
      currentKey = typeof node.config.next_node_key === "string" ? node.config.next_node_key : null;
      continue;
    }
    if (node.node_type === "send_storefront_link") {
      const cfg = node.config as unknown as SendStorefrontLinkNodeConfig;
      let result: StorefrontNodeResult;
      try {
        result = await runStorefrontLinkNode({
          accountId: run.account_id, runId: run.id, nodeKey: node.node_key, transitionSeq: run.transition_seq ?? 0,
          contactId: run.contact_id, conversationId: run.conversation_id, vars: run.vars, config: cfg,
        });
      } catch {
        // Never log the error itself: it could carry customer content or the link.
        result = { ok: false, reason: "failed" };
      }
      if (result.ok) {
        // The link itself is never logged or stored in run variables.
        await logEvent(db, run.id, "message_sent", node.node_key, { node_type: "send_storefront_link", whatsapp_message_id: result.whatsappMessageId });
        currentKey = cfg.next_node_key || null;
        continue;
      }
      await logEvent(db, run.id, "error", node.node_key, { reason: `storefront_link_${result.reason}` });
      // A send whose outcome is unknown may have reached the customer: carry on rather than offer a second link.
      if (result.uncertain) {
        currentKey = cfg.next_node_key || null;
        continue;
      }
      if (cfg.failed_next) {
        currentKey = cfg.failed_next;
        continue;
      }
      await endRun(db, run.id, "failed", "storefront_link_failed");
      return { outcome: "completed" };
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
          detail: errorDetail(err),
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
          detail: errorDetail(err),
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
          detail: errorDetail(err),
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
          detail: errorDetail(err),
        });
        await endRun(db, run.id, "failed", "send_buttons_failed");
        return { outcome: "completed" };
      }
      // Persist the new current_node_key via optimistic UPDATE.
      const advanced = await advanceCurrentNodeKey(
        db,
        run,
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
          detail: errorDetail(err),
        });
        await endRun(db, run.id, "failed", "send_list_failed");
        return { outcome: "completed" };
      }
      const advanced = await advanceCurrentNodeKey(
        db,
        run,
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
  run: Pick<FlowRunRow, "id" | "flow_version_id">,
  expectedOldKey: string | null,
  newKey: string,
  /** Only a payment_link step waits until a deadline; any other move clears it. */
  wait: { wait_until: string | null } = { wait_until: null },
): Promise<boolean> {
  // PostgREST: when expectedOldKey is null we can't `.eq` (would match
  // any row); use `.is('current_node_key', null)` instead.
  let q = db
    .from("flow_runs")
    .update({
      current_node_key: newKey,
      last_advanced_at: new Date().toISOString(),
      wait_until: wait.wait_until,
    })
    .eq("id", run.id)
    .eq("status", "active");
  // A run moved to another version meanwhile (Phase 12 migrate) loses the race.
  if (run.flow_version_id) q = q.eq("flow_version_id", run.flow_version_id);
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
  let q = db
    .from("flow_runs")
    .update({
      ...extra,
      current_node_key: nextNodeKey,
      transition_seq: nextSeq,
      reprompt_count: 0,
      wait_until: null,
      last_advanced_at: new Date().toISOString(),
    })
    .eq("id", run.id)
    .eq("status", "active")
    .eq("current_node_key", fromKey)
    .eq("transition_seq", run.transition_seq ?? 0);
  // The run's version is part of its position: a run migrated meanwhile loses the race.
  if (run.flow_version_id) q = q.eq("flow_version_id", run.flow_version_id);
  const { data, error } = await q.select("id");
  if (error) {
    console.error("[flows] claimReplyTransition error:", error.message);
    return false;
  }
  if (!Array.isArray(data) || data.length !== 1) return false;
  run.current_node_key = nextNodeKey;
  run.transition_seq = nextSeq;
  run.reprompt_count = 0;
  committedRuns.add(run);
  return true;
}

/**
 * Runs whose position this dispatch has committed (a reply transition or a new
 * run). An error after that point must not let automations or the AI answer
 * the same inbound, nor leave the run active on a step it never ran (audit
 * finding 48): dispatchInboundToFlows ends it as failed instead.
 */
const committedRuns = new WeakSet<FlowRunRow>();

class FlowAdvanceInterrupted extends Error {
  constructor(readonly run: FlowRunRow) {
    super("Flow advance interrupted after a committed transition");
    this.name = "FlowAdvanceInterrupted";
  }
}

async function guardCommitted<T>(run: FlowRunRow, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    // A Connect Flow target interrupted inside this advance is the run left
    // active; this run already ended (connect_flow), so keep the inner one.
    if (err instanceof FlowAdvanceInterrupted) throw err;
    if (committedRuns.has(run)) {
      console.error("[flows] advance interrupted:", err instanceof Error ? err.message : err);
      throw new FlowAdvanceInterrupted(run);
    }
    throw err;
  }
}

/**
 * Ends an interrupted run as failed (advance_interrupted) and reports the
 * inbound as consumed. If even that write fails, the error propagates: the
 * inbound's flow stage is then left for reconciliation, and still nothing else
 * answers the message.
 */
async function endInterruptedRun(db: AdminClient, run: FlowRunRow): Promise<DispatchInboundResult> {
  await logEvent(db, run.id, "error", run.current_node_key, { reason: "advance_interrupted" });
  await endRun(db, run.id, "failed", "advance_interrupted");
  return { consumed: true, flow_run_id: run.id, outcome: "completed" };
}

/**
 * Adds vars to a run that stays on its current node. Compare-and-set on the
 * run's position: if the run moved meanwhile the merge is skipped (the vars
 * are a convenience, never worth overwriting a concurrent transition).
 */
async function mergeWaitingRunVars(db: AdminClient, run: FlowRunRow, vars: Record<string, string>): Promise<void> {
  if (run.current_node_key === null || Object.keys(vars).length === 0) return;
  const merged = { ...run.vars, ...vars };
  let q = db
    .from("flow_runs")
    .update({ vars: merged })
    .eq("id", run.id)
    .eq("status", "active")
    .eq("current_node_key", run.current_node_key)
    .eq("transition_seq", run.transition_seq ?? 0);
  if (run.flow_version_id) q = q.eq("flow_version_id", run.flow_version_id);
  const { data, error } = await q.select("id");
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

/**
 * Continues a failed run that the replay route has re-opened (Phase 12,
 * design §3.3). The route checked eligibility (a transient send failure,
 * no ambiguous or accepted outbound intent for the failed step), set the run
 * active again and moved its transition_seq on, so every send here gets a
 * fresh dispatchOnce key. This re-checks that nothing moved since, then runs
 * the pinned version from `nodeKey` (the failed step; the run's current node
 * when absent). The bot-pause, blocked-contact and opt-out checks still apply.
 */
export async function replayRun(args: {
  accountId: string;
  runId: string;
  /** The transition_seq the route left the run at; a run that moved since is stale. */
  seq?: number;
  nodeKey?: string;
}): Promise<"replayed" | "stale"> {
  const db = databaseAdmin();
  const { data, error } = await db.from("flow_runs").select("*").eq("account_id", args.accountId).eq("id", args.runId).maybeSingle();
  if (error) throw new Error("Flow replay run lookup failed");
  const run = data as FlowRunRow | null;
  // Replay is for runs pinned to a version only: the graph cannot change under it.
  if (!run || run.status !== "active" || !run.flow_version_id || run.delay_until) return "stale";
  if (args.seq !== undefined && (run.transition_seq ?? 0) !== args.seq) return "stale";
  const startKey = args.nodeKey ?? run.current_node_key;
  if (!startKey) return "stale";
  const { flow, nodes } = await loadRunGraph(db, run);
  const now = new Date();
  const closure = closureForActiveRun({ run: { ...run, current_node_key: startKey }, flow, nodeKeys: nodes, now });
  if (closure) {
    await closeActiveRun(db, run, closure, now);
    return "replayed";
  }
  const { data: contact, error: contactError } = await db.from("contacts").select("blocked_at,opted_out_at")
    .eq("account_id", run.account_id).eq("id", run.contact_id!).maybeSingle();
  if (contactError) throw new Error("Flow replay contact lookup failed");
  // STOP since the failure: the replay sends nothing, like a STOP during an active run.
  if ((contact as { opted_out_at?: string | null } | null)?.opted_out_at) {
    await endRun(db, run.id, "cancelled", "contact_opted_out");
    return "replayed";
  }
  if (!run.conversation_id || !contact || (contact as { blocked_at?: string | null }).blocked_at ||
      (await botRepliesPaused(run.account_id, run.conversation_id))) {
    await endRun(db, run.id, "cancelled", "bot_paused_during_wait");
    return "replayed";
  }
  await advanceFromNodeKey(db, run, startKey, nodes);
  return "replayed";
}

/** The `flow.replay` job (queued by the replay route; registered in jobs/handlers). */
export async function handleFlowReplay(payload: { accountId: string; runId: string; seq?: number; nodeKey?: string }): Promise<"replayed" | "stale"> {
  return replayRun(payload);
}

/** Start only the selected active flow; never hijack an existing contact run. */
export async function startFlowById(input: DispatchInboundInput & { flowId: string }): Promise<{ outcome: 'started' | 'unavailable' | 'conflict' }> {
  const db = databaseAdmin();
  const contact = await db.from('contacts').select('id').eq('account_id', input.accountId).eq('id', input.contactId).maybeSingle();
  const conversation = await db.from('conversations').select('id, channel').eq('account_id', input.accountId)
    .eq('id', input.conversationId).eq('contact_id', input.contactId).maybeSingle();
  if (contact.error || conversation.error) throw new Error('Explicit flow ownership lookup failed');
  if (!contact.data || !conversation.data || await botRepliesPaused(input.accountId, input.conversationId)) return { outcome: 'unavailable' };
  const target = await db.from('flows').select('*').eq('account_id', input.accountId).eq('id', input.flowId).eq('status', 'active').maybeSingle();
  if (target.error) throw new Error('Explicit flow target lookup failed');
  const flow = target.data as FlowRow | null;
  // Entry and channel scope are checked on the graph the run will start on (its published version).
  if (!flow || flow.id !== input.flowId || flow.account_id !== input.accountId || flow.status !== 'active') return { outcome: 'unavailable' };
  const channel: Channel = (conversation.data as { channel?: string | null }).channel === 'instagram' ? 'instagram' : 'whatsapp';
  // Same policy as inbound dispatch: only a run on this conversation conflicts.
  const existing = await db.from('flow_runs').select('id').eq('account_id', input.accountId).eq('contact_id', input.contactId)
    .eq('conversation_id', input.conversationId).eq('status', 'active').limit(1);
  if (existing.error) throw new Error('Explicit flow active run lookup failed');
  if (existing.data?.length) return { outcome: 'conflict' };
  const graph = await startGraph(db, flow);
  if (!graph || !graph.flow.entry_node_id || !graph.nodes.has(graph.flow.entry_node_id)) return { outcome: 'unavailable' };
  if (!scopeIncludes(graph.flow.channel_scope, channel)) return { outcome: 'unavailable' };
  const result = await startNewRun(db, graph.flow, input, graph.nodes).catch((err: unknown) => {
    if (err instanceof FlowAdvanceInterrupted) return endInterruptedRun(db, err.run);
    throw err;
  });
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
        const resumed = await guardCommitted(activeRun, () => resumeInterruptedBooking(db, activeRun, input.message));
        if (resumed) return resumed;
        return {
          consumed: true,
          flow_run_id: activeRun.id,
          outcome: "duplicate_inbound_ignored",
        };
      }
      // One SELECT for the whole flow's nodes — advance loop is now
      // in-memory. See loadAllNodes.
      const { flow: runFlow, nodes } = await loadRunGraph(db, activeRun);
      const now = new Date();
      const testContact = runFlow?.status === "draft" && isTestContact(runFlow, await contactDigits());
      const closure = closureForActiveRun({ run: activeRun, flow: runFlow, nodeKeys: nodes, now, testContact });
      if (!closure) return await guardCommitted(activeRun, () => handleReplyForActiveRun(db, activeRun, runFlow!, input.message, nodes));
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
    const nodes = entry.version ? versionNodeMap(entry.version) : await loadAllNodes(db, entry.flow.id);
    return await startNewRun(db, entry.flow, input, nodes, entry.vars);
  } catch (err) {
    if (err instanceof FlowAdvanceInterrupted) return endInterruptedRun(db, err.run);
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
    // The transition the reply arrived at: resumeInterruptedBooking matches a retried job on it.
    transition_seq: run.transition_seq ?? 0,
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

  // A replayed run is active on its failed step before the flow.replay job
  // has re-sent that step's prompt. A message in that gap is recorded but
  // must not answer (or fall back on) a prompt the customer never saw; the
  // replay's node_entered event ends the gap.
  if (await awaitingReplay(db, run)) {
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

  // A typed follow-up on a waiting AI reply step is answered by the AI.
  if (currentNode.node_type === "ai_reply" && message.kind === "text" && message.text.trim()) {
    return continueAiReplyNode(db, run, currentNode, nodes, message.meta_message_id);
  }
  // Anything else on a waiting AI reply step (a photo, a sticker, an old
  // button tap, empty text) is not a question: it must not use up an AI
  // turn through reprompt_count or fire the flow's fallback.
  if (currentNode.node_type === "ai_reply") {
    return { consumed: true, flow_run_id: run.id, outcome: "waiting" };
  }

  // The booking step answers every reply itself: its next question, Cancel, or a re-prompt.
  if (currentNode.node_type === "book_appointment") {
    return handleAppointmentReply(db, run, currentNode, message, nodes);
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
  // Claimed like every other reply-path write: a run that advanced, was
  // re-prompted or was migrated to another version meanwhile loses the race
  // instead of getting this version's fallback prompt and count.
  let fallbackClaim = db
    .from("flow_runs")
    .update({ reprompt_count: newReprompts })
    .eq("id", run.id)
    .eq("status", "active")
    .eq("current_node_key", currentNode.node_key)
    .eq("transition_seq", run.transition_seq ?? 0)
    .eq("reprompt_count", run.reprompt_count);
  if (run.flow_version_id) fallbackClaim = fallbackClaim.eq("flow_version_id", run.flow_version_id);
  const claimed = await fallbackClaim.select("id");
  if (claimed.error || !Array.isArray(claimed.data) || claimed.data.length !== 1) {
    return lostReplyRace(db, run, currentNode.node_key);
  }

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
        detail: errorDetail(err),
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
    const { whatsapp_message_id } = await flowSend(run, `flow-fallback:${run.id}:${inboundMessageId}`,
      message.media_type && message.media_url
        ? { kind: "media", args: { ...base, kind: message.media_type, link: message.media_url, caption: text || undefined } }
        : { kind: "text", args: { ...base, text } });
    await logEvent(db, run.id, "message_sent", node.node_key, { node_type: "fallback_message", whatsapp_message_id });
  } catch (err) {
    await logEvent(db, run.id, "error", node.node_key, {
      reason: "fallback_message_failed",
      detail: errorDetail(err),
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
    let claim = db
      .from("flow_runs")
      .update({ reprompt_count: attempt })
      .eq("id", run.id)
      .eq("status", "active")
      .eq("current_node_key", node.node_key)
      .eq("transition_seq", run.transition_seq ?? 0)
      .eq("reprompt_count", run.reprompt_count);
    // A run migrated to another version meanwhile must not get this version's error text.
    if (run.flow_version_id) claim = claim.eq("flow_version_id", run.flow_version_id);
    const { data, error } = await claim.select("id");
    if (error || !Array.isArray(data) || data.length !== 1) {
      return lostReplyRace(db, run, node.node_key);
    }
    run.reprompt_count = attempt;
    try {
      await sendAskPrompt(run, node, attempt, cfg.error_text?.trim() ? cfg.error_text : undefined);
    } catch (err) {
      await logEvent(db, run.id, "error", node.node_key, {
        reason: "reprompt_send_failed",
        detail: errorDetail(err),
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

/**
 * Whether the run was replayed onto its current step and the replay job has
 * not run that step yet: its newest event other than reply_received (logged
 * for this very inbound) is the 'replayed' event for the current node.
 */
async function awaitingReplay(db: AdminClient, run: FlowRunRow): Promise<boolean> {
  const { data, error } = await db
    .from("flow_run_events")
    .select("event_type,node_key")
    .eq("flow_run_id", run.id)
    .neq("event_type", "reply_received")
    .order("created_at", { ascending: false })
    .limit(1);
  if (error || !Array.isArray(data) || !data.length) return false;
  const latest = data[0] as { event_type: string; node_key: string | null };
  return latest.event_type === "replayed" && latest.node_key === run.current_node_key;
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
  /** Overlaid with the version whose trigger matched; the run is pinned to it. */
  flow: EffectiveFlow,
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
      // Pinned to the version it starts on (Phase 12); a draft test run has none.
      ...(flow.version_id ? { flow_version_id: flow.version_id } : {}),
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
  committedRuns.add(run);
  return guardCommitted(run, () => continueNewRun(db, run, flow, input, nodes));
}

async function continueNewRun(
  db: AdminClient,
  run: FlowRunRow,
  flow: EffectiveFlow,
  input: DispatchInboundInput,
  nodes: Map<string, FlowNodeRow>,
): Promise<DispatchInboundResult> {
  await logEvent(db, run.id, "started", flow.entry_node_id, {
    flow_id: flow.id,
    ...(flow.version ? { version: flow.version } : {}),
    trigger_type: flow.trigger_type,
    meta_message_id: input.message.meta_message_id,
  });
  if (flow.trigger_type === "ad_click" && input.message.referral?.source_type === "ad") {
    // The ad id only: never the click id, and no customer content.
    await logEvent(db, run.id, "ad_click", flow.entry_node_id, { ad_id: input.message.referral.source_id });
  }
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
