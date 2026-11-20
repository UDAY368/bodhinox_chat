// Flow engine, helpers group: moved out of engine.ts (batch 5) without changes; engine.ts re-exports the public names.
import { checkRunTimeout, type RunTimeoutCheck } from "../timeout";
import { predicateHolds } from "../conditions";
import { isCommerceNodeType } from "@/lib/commerce/catalog-send";
import { type SendTemplateNodeConfig, type ConditionRule, type NodeTiming, type FlowRow, type FlowRunRow, type ParsedInbound, type SendButtonsNodeConfig, type SendListNodeConfig, type IgCard } from "../types";

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
  if (node.node_type === "send_card" || node.node_type === "send_gallery") {
    return cardPostbackRoutes(node).find((b) => b.reply_id === reply_id)?.next_node_key ?? null;
  }
  return null;
}

/** The cards of a send_card / send_gallery node. */
export function nodeCards(node: { node_type: string; config: Record<string, unknown> }): IgCard[] {
  const cfg = node.config;
  if (node.node_type === "send_card") return cfg.card && typeof cfg.card === "object" ? [cfg.card as IgCard] : [];
  if (node.node_type === "send_gallery") return Array.isArray(cfg.cards) ? (cfg.cards as IgCard[]).filter((c) => c && typeof c === "object") : [];
  return [];
}

/** A card node's postback buttons that lead somewhere (a link button has no route: its tap never reaches us). */
export function cardPostbackRoutes(node: { node_type: string; config: Record<string, unknown> }): Array<{ reply_id: string; next_node_key: string }> {
  return nodeCards(node).flatMap((card) => (Array.isArray(card.buttons) ? card.buttons : []))
    .filter((b): b is Extract<NonNullable<IgCard["buttons"]>[number], { type: "postback" }> =>
      Boolean(b) && b.type === "postback" && typeof b.reply_id === "string" && b.reply_id !== "" &&
      typeof b.next_node_key === "string" && b.next_node_key !== "")
    .map((b) => ({ reply_id: b.reply_id, next_node_key: b.next_node_key }));
}

/** A card or gallery with routed postback buttons waits for the tap; without them it moves on to `next_node_key`. */
export function cardWaits(node: { node_type: string; config: Record<string, unknown> }): boolean {
  return cardPostbackRoutes(node).length > 0;
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
    node_type === "conversion_event" ||
    // Stage 5 logic steps that never wait for the customer.
    node_type === "actions" ||
    node_type === "randomizer" ||
    node_type === "google_sheets"
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
