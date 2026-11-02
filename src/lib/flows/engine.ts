import { checkRunTimeout, markRunTimedOut, type RunTimeoutCheck } from "./timeout";
import { botRepliesPaused } from '@/lib/whatsapp/bot-pause';
import { normalizeCollectedInput } from './input-validation';
import { dispatchOnce } from '@/lib/jobs/dispatch';
import { enqueueJob } from '@/lib/jobs/queue';
import { writeContactField } from '@/lib/contacts/field-write';
import { clockTimezone, conditionRules, predicateHolds, ruleHolds } from './conditions';
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
 *   - Partial unique index `idx_one_active_run_per_contact`: two
 *     simultaneous starts for the same contact collide; the second
 *     INSERT raises 23505 and the runner catches & exits.
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
import {
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
  return null;
}

/**
 * Case-insensitive contains/exact match against a list of keywords.
 * Used by the trigger evaluator. Stable enough that the v3 builder
 * UI can preview matches by passing canned strings.
 */
export function matchesKeywordTrigger(
  text: string,
  cfg: KeywordTriggerConfig,
): boolean {
  if (!text || !cfg.keywords?.length) return false;
  const matchType = cfg.match_type ?? "contains";
  const haystack = cfg.case_sensitive ? text : text.toLowerCase();
  for (const raw of cfg.keywords) {
    if (!raw) continue;
    const needle = cfg.case_sensitive ? raw : raw.toLowerCase();
    if (matchType === "exact" ? haystack === needle : haystack.includes(needle)) {
      return true;
    }
  }
  return false;
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
    node_type === "condition" ||
    node_type === "set_tag" ||
    node_type === "set_attribute"
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
}): ActiveRunClosure | null {
  if (!args.flow || args.flow.status !== "active") {
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
    isAskNode(node_type)
  );
}

/** Nodes that end the run. */
export function isTerminal(node_type: string): boolean {
  return node_type === "handoff" || node_type === "end";
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

async function loadActiveRunForContact(
  db: AdminClient,
  accountId: string,
  contactId: string,
): Promise<FlowRunRow | null> {
  // The partial unique index `idx_one_active_run_per_contact` was
  // rebuilt in migration 017 over `(account_id, contact_id)` — so
  // "two active runs for one contact in one account" is impossible
  // by design. But a future migration glitch or manual SQL could
  // create one, and .maybeSingle() throws on >1 row — which would
  // kill dispatch for that contact's webhook entirely. .limit(1) is
  // forgiving: pick the newest, let the cron sweep clean up the
  // stale one.
  const { data, error } = await db
    .from("flow_runs")
    .select("*")
    .eq("account_id", accountId)
    .eq("contact_id", contactId)
    .eq("status", "active")
    .order("started_at", { ascending: false })
    .limit(1);
  if (error) {
    console.error("[flows] loadActiveRunForContact error:", error.message);
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
    | "attribute_set",
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

async function findEntryFlow(
  db: AdminClient,
  accountId: string,
  message: ParsedInbound,
  isFirstInbound: boolean,
): Promise<FlowRow | null> {
  // A tap used to be rejected outright here, on the reasoning that
  // interactive replies are responses to existing prompts. That holds
  // only while a prompt is outstanding — and this function runs solely
  // when the contact has NO active run, so there is nothing the tap
  // could be answering. What it actually blocked was issue #490: an
  // *automation* sends the buttons, the customer taps one, and the flow
  // whose keyword matches that button never starts. Retyping the label
  // by hand worked, which is the tell — same words, different envelope.
  const candidates = entryTriggerTexts(message);

  // Pull all active flows for this account. Active set is bounded
  // (the builder discourages double-trigger overlap; partial index
  // makes the lookup index-supported).
  const { data: flows, error } = await db
    .from("flows")
    .select("*")
    .eq("account_id", accountId)
    .eq("status", "active")
    .order("created_at", { ascending: true });
  if (error || !flows) return null;

  const typed = flows as FlowRow[];
  for (const flow of typed) {
    if (flow.trigger_type === "keyword") {
      const cfg = flow.trigger_config as KeywordTriggerConfig;
      if (candidates.some((text) => matchesKeywordTrigger(text, cfg))) {
        return flow;
      }
    } else if (flow.trigger_type === "first_inbound_message" && isFirstInbound) {
      // Also reachable by a tap now: a broadcast template with a
      // quick-reply button can genuinely be what prompts a contact's
      // first-ever inbound. The automations dispatcher has always
      // treated a tap that way (the webhook pushes
      // `first_inbound_message` regardless of envelope) — flows were
      // the inconsistent half.
      return flow;
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
  const closure = closureForActiveRun({ run, flow, nodeKeys: nodes, now });
  if (closure) {
    await closeActiveRun(db, run, closure, now);
    return "fired";
  }
  // An agent took over or the contact was blocked while the run waited: no more bot messages.
  const { data: contact } = await db
    .from("contacts")
    .select("blocked_at")
    .eq("account_id", run.account_id)
    .eq("id", run.contact_id!)
    .maybeSingle();
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
  const existing = await db.from('flow_runs').select('id').eq('account_id', input.accountId).eq('contact_id', input.contactId).eq('status', 'active').limit(1);
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
  try {
    if (await botRepliesPaused(input.accountId, input.conversationId)) return { consumed: true, outcome: 'no_match' };
    const activeRun = await loadActiveRunForContact(
      db,
      input.accountId,
      input.contactId,
    );

    // Idempotency — only matters if there's already a run for this
    // contact. For new runs, the partial unique index catches duplicate
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
      const closure = closureForActiveRun({ run: activeRun, flow: runFlow, nodeKeys: nodes, now });
      if (!closure) return handleReplyForActiveRun(db, activeRun, runFlow!, input.message, nodes);
      if (!(await closeActiveRun(db, activeRun, closure, now))) {
        return { consumed: true, flow_run_id: activeRun.id, outcome: "duplicate_inbound_ignored" };
      }
    }

    // No active run → look for a flow whose entry trigger matches.
    const flow = await findEntryFlow(
      db,
      input.accountId,
      input.message,
      input.isFirstInboundMessage,
    );
    if (!flow || !flow.entry_node_id) {
      return { consumed: false, outcome: "no_match" };
    }
    const nodes = await loadAllNodes(db, flow.id);
    return startNewRun(db, flow, input, nodes);
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
  let matched: string | null = null;
  if (
    message.kind === "interactive_reply" &&
    (currentNode.node_type === "send_buttons" ||
      currentNode.node_type === "send_list")
  ) {
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
      if (message.kind === "interactive_reply") return null;
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
): Promise<DispatchInboundResult> {
  // INSERT — partial unique index `idx_one_active_run_per_contact`
  // catches concurrent inserts with 23505. We catch and return as
  // consumed:true (the parallel webhook handles it).
  const { data: inserted, error: insErr } = await db
    .from("flow_runs")
    .insert({
      flow_id: flow.id,
      // Tenancy: NOT NULL post-017. The partial unique index
      // `idx_one_active_run_per_contact` is over (account_id,
      // contact_id) WHERE status='active', so two accounts sharing
      // a contact phone number each run their own flows independently.
      account_id: flow.account_id,
      // Audit: preserves the flow's author on the run row for log
      // attribution.
      user_id: flow.user_id,
      contact_id: input.contactId,
      conversation_id: input.conversationId,
      status: "active",
      current_node_key: flow.entry_node_id,
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
