/**
 * Save-time validation for flows.
 *
 * Run before activation (not on every draft save) — drafts are
 * intentionally allowed to be incomplete so users can save progress
 * mid-build. The builder calls these from BOTH client (so the user
 * sees issues live) and server (so a broken POST/PUT can't slip in
 * via direct API call).
 *
 * Three rule categories:
 *   1. Trigger sanity — keyword flows need keywords, etc.
 *   2. Graph integrity — entry node exists, all next_node_key
 *      references resolve, no unreachable nodes, non-terminal nodes
 *      have an outgoing edge.
 *   3. Meta API limits — button title ≤20 chars, ≤3 buttons per
 *      send_buttons, ≤10 list rows total, ≤24 chars per list row
 *      title. Mirrors the runtime checks inside
 *      `src/lib/whatsapp/meta-api.ts` so save-time and send-time
 *      can never disagree.
 *
 * Issues carry enough field info that the builder can highlight the
 * exact input that triggered them. Node-scoped issues include
 * `node_key`; trigger-scoped use `scope: 'trigger'`.
 */

import { INTERACTIVE_LIMITS } from "@/lib/whatsapp/interactive-limits";
import { getT } from "@/lib/i18n/translate";
import { flowTemplateExtrasIssues, type FlowTemplateExtras } from "@/lib/whatsapp/template-send-params";
import { isValidTimeZone } from "@/lib/automations/time-of-day";
import { WRITABLE_CONTACT_FIELDS } from "@/lib/contacts/writable-fields";
import { commerceNodeIssues, isCommerceNodeType } from "./commerce-nodes";
import { FALLBACK_MESSAGE_MAX, resolveFallbackMessage, resolveFallbackPolicy } from "./fallback";
import { PAYMENT_LINK_VARS, paymentLinkEdges, paymentLinkIssues } from "./payment-node";
import { BOOK_APPOINTMENT_VARS, bookAppointmentEdges, bookAppointmentIssues, bookAppointmentPaidIssues } from "./appointment-node";
import { aiReplyEdges, aiReplyIssues, aiReplyMaxTurns, aiReplyWaits } from "./ai-reply-node";
import { conversionEdges, conversionIssues } from "./conversion-node";
import { storefrontLinkEdges, storefrontLinkIssues } from "./storefront-link-validation";
import { parseDateInput } from "./input-formats";
import { nodeAvailableOn, scopeChannels, triggerAvailableOn } from "@/lib/channels/capabilities";
import { FLOW_CHANNEL_SCOPES, FLOW_TRIGGER_LIMITS, FLOW_TRIGGER_TYPES, STAGE5_CONDITION_SUBJECTS, isCombinableTrigger, type ConditionRule, type FlowChannelScope, type FlowNodeType, type FlowTriggerType, type NodeTiming } from "./types";
import { buyButtonIssues, stage5NodeIssues, stage5SubjectProblem } from "./stage5-validation";
import { nodeCapabilityBlock, type WorkspaceCapabilities } from "./node-registry";
import { cardRouteTargets, igFlowIssues, igNodeIssues, igTriggerIssues, privateReplyWaits } from "./instagram-validation";

const t = getT("Validation.flows");
const tMulti = getT("Flows.multiTrigger");
const tIntent = getT("Flows.triggers.intent");
const tChannel = getT("Flows.channel");
const tSection = getT("Flows.channelSection");
const tNames = getT("Channels.names");

export interface ValidationIssue {
  severity: "error" | "warning";
  scope: "flow" | "trigger" | "node";
  /** Stable node_key the issue is attached to, when scope === 'node'. */
  node_key?: string;
  /** Dotted path to the bad field, e.g. 'buttons.0.title'. */
  field?: string;
  message: string;
  /** A machine-readable reason for the Phase 12 publish checks. */
  code?: "capabilityUnavailable" | "crossFlowLoop";
  /** With code 'capabilityUnavailable': the workspace capability the node needs. */
  capability?: string;
}

interface FlowInput {
  name: string;
  trigger_type: FlowTriggerType;
  trigger_config: Record<string, unknown>;
  entry_node_id: string | null;
  /** When given, a Connect Flow step back to this flow is checked for loops. */
  id?: string;
  /** When given, reply timeouts are checked against its inactivity limit. */
  fallback_policy?: unknown;
  /** Channels the flow runs on (Phase 11); absent is WhatsApp only. */
  channel_scope?: FlowChannelScope | null;
  /** Stage 5: further triggers (flows.extra_triggers). */
  extra_triggers?: unknown;
}

interface NodeInput {
  node_key: string;
  node_type: string;
  config: Record<string, unknown>;
}

/** The account's WhatsApp forms a send_form step may use, by id. */
export type FlowFormLookup = ReadonlyMap<string, { status: string; fields: string[] }>;

export interface FlowValidationContext {
  /**
   * When given (the server, at activation), every send_form step must use
   * a form that exists and is published, and its field ids count as
   * collected variables. The builder omits it and checks shape only.
   */
  forms?: FlowFormLookup;
  /**
   * When given (the server, at activation), an ai_reply step warns if the
   * workspace's AI is not set up, since every run would take its handoff port.
   */
  aiConfigured?: boolean;
  /**
   * When given (the server, at publish), the ids of the account's paid
   * appointment services: a book_appointment step that picks one is an error.
   */
  paidServices?: ReadonlySet<string>;
  /**
   * When given (the server, at publish and in a dry run), a node that needs a
   * provider the workspace has not configured is an error (AUT-05 capability
   * block), so it cannot go live and fail at run time.
   */
  caps?: Partial<WorkspaceCapabilities>;
  /**
   * When given (the server, at publish and resume, under the account's
   * publish lock), the published snapshots of the workspace's other active
   * or paused flows: a Connect Flow chain that loops back to this flow
   * without customer input is an error.
   */
  otherFlows?: ReadonlyArray<CrossFlowSnapshot>;
}

/** A flow as the cross-flow loop check sees it: its published (or, for this flow, publishing) graph. */
export interface CrossFlowSnapshot {
  id: string;
  name: string;
  entry_node_id: string | null;
  nodes: ReadonlyArray<NodeInput>;
}

export function validateFlowForActivation(
  flow: FlowInput,
  nodes: NodeInput[],
  context: FlowValidationContext = {},
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // ---- name ----
  if (!flow.name || !flow.name.trim()) {
    issues.push({
      severity: "error",
      scope: "flow",
      field: "name",
      message: t("nameRequired"),
    });
  }

  // ---- trigger ----
  issues.push(...validateTrigger(flow.trigger_type, flow.trigger_config, context.aiConfigured), ...igTriggerIssues(flow.trigger_type, flow.trigger_config ?? {}));
  issues.push(...extraTriggerIssues(flow, context.aiConfigured));

  // ---- graph integrity ----
  if (!flow.entry_node_id) {
    issues.push({
      severity: "error",
      scope: "flow",
      field: "entry_node_id",
      message: t("entryRequired"),
    });
  }

  const keys = new Set(nodes.map((n) => n.node_key));
  if (nodes.length === 0) {
    issues.push({
      severity: "error",
      scope: "flow",
      message: t("needsNode"),
    });
  }

  if (flow.entry_node_id && !keys.has(flow.entry_node_id)) {
    issues.push({
      severity: "error",
      scope: "flow",
      field: "entry_node_id",
      message: t("entryMissing", { id: flow.entry_node_id }),
    });
  }

  // Duplicate node_key (the DB UNIQUE constraint catches this on save
  // too, but surfacing it client-side gives a friendlier error path).
  const seen = new Set<string>();
  for (const n of nodes) {
    if (seen.has(n.node_key)) {
      issues.push({
        severity: "error",
        scope: "node",
        node_key: n.node_key,
        message: t("duplicateNodeKey", { key: n.node_key }),
      });
    }
    seen.add(n.node_key);
  }

  // A malformed fallback message is dropped at run time, so say so here.
  const rawFallback = (flow.fallback_policy as { fallback_message?: unknown } | undefined)?.fallback_message;
  if (rawFallback !== undefined && rawFallback !== null && !resolveFallbackMessage(rawFallback)) {
    issues.push({ severity: "error", scope: "flow", field: "fallback_policy.fallback_message", message: t("fallbackMessageInvalid", { max: FALLBACK_MESSAGE_MAX }) });
  }

  // Per-node rules (Meta limits + dead-end + edge resolution).
  const runTimeoutHours = flow.fallback_policy === undefined ? undefined : resolveFallbackPolicy(flow.fallback_policy).on_timeout_hours;
  for (const n of nodes) {
    issues.push(...validateNode(n, keys), ...timingIssues(n, keys, runTimeoutHours), ...igNodeIssues(n, keys));
    // Stage 5 steps and settings (stage5-validation.ts).
    issues.push(...stage5NodeIssues(n, keys, { flowId: flow.id, channelScope: flow.channel_scope }),
      ...buyButtonIssues(n, context.caps ? context.caps.payments === true : undefined));
    if (n.node_type === "send_form") issues.push(...sendFormIssues(n, keys, context.forms));
    if (n.node_type === "ai_reply") issues.push(...aiReplyIssues(n, keys, context.aiConfigured));
    if (n.node_type === "book_appointment") issues.push(...bookAppointmentPaidIssues(n, context.paidServices));
  }
  issues.push(...channelScopeIssues(flow.channel_scope, flow.trigger_type, nodes));
  issues.push(...igFlowIssues(flow, nodes, outgoingEdges));

  // Warn rather than block: explicit starts may supply variables externally.
  if (flow.entry_node_id && keys.has(flow.entry_node_id)) {
    const byKey = new Map(nodes.map(node => [node.node_key, node]));
    const predecessors = new Map<string, string[]>();
    for (const earlier of nodes) for (const next of outgoingEdges(earlier)) {
      predecessors.set(next, [...(predecessors.get(next) ?? []), earlier.node_key]);
    }
    for (const node of nodes) {
      const ancestors = new Set<string>();
      const backwards = [...(predecessors.get(node.node_key) ?? [])];
      while (backwards.length) {
        const key = backwards.pop()!;
        if (ancestors.has(key) || key === node.node_key) continue;
        ancestors.add(key);
        backwards.push(...(predecessors.get(key) ?? []));
      }
      const available = new Set<string>();
      const visited = new Set<string>();
      const pending = [flow.entry_node_id];
      while (pending.length) {
        const key = pending.pop()!;
        if (key === node.node_key || visited.has(key)) continue;
        visited.add(key);
        const earlier = byKey.get(key);
        if (!earlier) continue;
        if (ancestors.has(key)) for (const name of producedVars(earlier, context.forms)) available.add(name);
        pending.push(...outgoingEdges(earlier));
      }
      const references: Array<{ field: string; key: string }> = [];
      if (node.node_type === 'condition') {
        const rules = Array.isArray(node.config.rules) ? node.config.rules as Array<Record<string, unknown>> : null;
        (rules ?? [node.config]).forEach((rule, i) => {
          if (rule?.subject === 'var' && typeof rule.subject_key === 'string') references.push({ field: rules ? `rules.${i}.subject_key` : 'subject_key', key: rule.subject_key });
        });
      }
      const scan = (value: unknown, field: string) => {
        if (typeof value === 'string') {
          for (const match of value.matchAll(/\{\{vars\.([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g)) references.push({ field, key: match[1] });
        } else if (Array.isArray(value)) value.forEach((item, i) => scan(item, `${field}.${i}`));
        else if (value && typeof value === 'object') {
          for (const [key, item] of Object.entries(value)) {
            if (!NOT_TEXT_FIELDS.includes(key)) scan(item, field ? `${field}.${key}` : key);
          }
        }
      };
      scan(node.config, '');
      for (const { field, key } of references) {
        if (!available.has(key)) issues.push({ severity: 'warning', scope: 'node', node_key: node.node_key, field, message: t('variableNotCollected', { key }) });
      }
    }
  }

  // Reachability — every non-orphan node must be reachable from the
  // entry. Done after per-node validation so we don't double-report
  // when a node has bad config AND is unreachable.
  if (flow.entry_node_id && keys.has(flow.entry_node_id)) {
    const reached = reachableFromEntry(flow.entry_node_id, nodes);
    for (const n of nodes) {
      if (!reached.has(n.node_key)) {
        issues.push({
          severity: "warning",
          scope: "node",
          node_key: n.node_key,
          message: t("unreachable", { key: n.node_key }),
        });
      }
    }
  }

  const self = flow.id && flow.entry_node_id ? { flowId: flow.id, entry: flow.entry_node_id } : undefined;
  for (const cycle of findAutoAdvancingCycles(nodes, self)) {
    issues.push({
      severity: "error",
      scope: "node",
      node_key: cycle[0],
      message: t("autoAdvanceCycle", { keys: cycle.join(", ") }),
    });
  }

  // Provider-gated steps (Phase 12): unpublishable until the workspace has the provider.
  if (context.caps) {
    for (const n of nodes) {
      const capability = nodeCapabilityBlock(n.node_type, context.caps);
      if (capability) {
        issues.push({ severity: "error", scope: "node", node_key: n.node_key, field: "node_type", code: "capabilityUnavailable", capability,
          message: t("capabilityUnavailable", { key: n.node_key, capability }) });
      }
    }
  }

  // A Connect Flow chain through other live flows back to this one, with no customer input on the way.
  if (context.otherFlows && flow.id && flow.entry_node_id) {
    const chain = findCrossFlowLoop({ id: flow.id, name: flow.name, entry_node_id: flow.entry_node_id, nodes }, context.otherFlows);
    if (chain) {
      issues.push({ severity: "error", scope: "flow", code: "crossFlowLoop", message: t("crossFlowLoop", { flows: chain.join(" > ") }) });
    }
  }

  return issues;
}

/**
 * Nodes that move on without the customer: what both loop checks follow.
 * A delay does not exempt a node: a loop of delayed sends would message the
 * customer forever. A waiting node with a reply timeout also moves on by
 * itself, through its timeout port. A template without buttons, an API call
 * and an assignment all move on by themselves.
 */
function isAutoNode(n: NodeInput): boolean {
  const autoTemplate = n.node_type === "send_template" && !(Array.isArray(n.config.buttons) && n.config.buttons.length);
  // A one-turn AI reply answers and moves on without waiting for the customer.
  const autoAiReply = n.node_type === "ai_reply" && aiReplyMaxTurns(n.config) === 1;
  const timesOut = waitsForReply(n) && Boolean(n.config.timeout_minutes) && typeof n.config.after_timeout === "string";
  // Instagram: the comment reply always moves on; a private reply or card does unless it waits for a tap.
  const autoIg = n.node_type === "ig_comment_reply" ||
    (["ig_private_reply", "send_card", "send_gallery"].includes(n.node_type) && !waitsForReply(n));
  return timesOut || autoTemplate || autoAiReply || autoIg ||
    ["start", "send_message", "send_media", "condition", "set_tag", "set_attribute", "api_request", "assign_agent", "conversion_event", "send_storefront_link",
      // Stage 5 logic steps move on by themselves (a smart delay too: a loop of waits would message forever).
      "actions", "randomizer", "smart_delay", "google_sheets"].includes(n.node_type) ||
    isCommerceNodeType(n.node_type);
}

/** The next nodes an auto node can move to without customer input. */
function autoSuccessors(node: NodeInput): string[] {
  // Only the timeout port of a waiting node needs no customer input.
  return waitsForReply(node) ? [node.config.after_timeout as string] : outgoingEdges(node);
}

/**
 * The flows a run of this graph can connect to straight from its entry with
 * no customer input on the way (Connect Flow counted as automatic).
 */
export function autoConnectTargets(nodes: ReadonlyArray<NodeInput>, entry: string | null): string[] {
  if (!entry) return [];
  const byKey = new Map<string, NodeInput>();
  for (const n of nodes) if (!byKey.has(n.node_key)) byKey.set(n.node_key, n);
  const targets = new Set<string>();
  const seen = new Set<string>();
  const pending = [entry];
  while (pending.length) {
    const key = pending.pop()!;
    if (seen.has(key)) continue;
    seen.add(key);
    const node = byKey.get(key);
    if (!node) continue;
    if (node.node_type === "connect_flow") {
      if (typeof node.config.flow_id === "string" && node.config.flow_id) targets.add(node.config.flow_id);
      continue;
    }
    // Stage 5: an Actions step's start_flow starts that flow when this run ends, with no customer input.
    if (node.node_type === "actions" && Array.isArray(node.config.actions)) {
      for (const a of node.config.actions as Array<Record<string, unknown>>) {
        if (a?.type === "start_flow" && typeof a.flow_id === "string" && a.flow_id) targets.add(a.flow_id);
      }
    }
    if (!isAutoNode(node)) continue;
    pending.push(...autoSuccessors(node));
  }
  return [...targets];
}

/**
 * A chain of flow names that leads from `candidate` back to itself through
 * Connect Flow steps reachable without customer input, or null. A flow that
 * restarts itself is left to findAutoAdvancingCycles.
 */
export function findCrossFlowLoop(candidate: CrossFlowSnapshot, others: ReadonlyArray<CrossFlowSnapshot>): string[] | null {
  const flows = new Map<string, CrossFlowSnapshot>();
  for (const f of others) if (f.id !== candidate.id) flows.set(f.id, f);
  flows.set(candidate.id, candidate);
  const edges = new Map<string, string[]>();
  for (const f of flows.values()) {
    edges.set(f.id, autoConnectTargets(f.nodes, f.entry_node_id).filter((id) => id !== f.id && flows.has(id)));
  }
  // Depth-first from the candidate, looking for an edge back to it.
  const path: string[] = [candidate.id];
  const visited = new Set<string>([candidate.id]);
  const walk = (id: string): boolean => {
    for (const next of edges.get(id) ?? []) {
      if (next === candidate.id) return true;
      if (visited.has(next)) continue;
      visited.add(next);
      path.push(next);
      if (walk(next)) return true;
      path.pop();
    }
    return false;
  };
  if (!walk(candidate.id)) return null;
  return [...path, candidate.id].map((id) => flows.get(id)!.name);
}

/** `self` lets a Connect Flow step that restarts this same flow count as an edge back to its entry. */
export function findAutoAdvancingCycles(nodes: NodeInput[], self?: { flowId: string; entry: string }): string[][] {
  const autoNodes = new Map<string, NodeInput>();
  for (const n of nodes) {
    const restartsSelf = Boolean(self) && n.node_type === "connect_flow" && n.config.flow_id === self?.flowId;
    if ((restartsSelf || isAutoNode(n)) && !autoNodes.has(n.node_key)) {
      autoNodes.set(n.node_key, n);
    }
  }
  const successors = (key: string): string[] => {
    const node = autoNodes.get(key)!;
    const next = node.node_type === "connect_flow" ? [self!.entry] : autoSuccessors(node);
    return next.filter((k) => autoNodes.has(k));
  };

  const index = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  let counter = 0;

  const visit = (key: string): void => {
    index.set(key, counter);
    lowLink.set(key, counter);
    counter += 1;
    stack.push(key);
    onStack.add(key);
    for (const next of successors(key)) {
      if (!index.has(next)) {
        visit(next);
        lowLink.set(key, Math.min(lowLink.get(key)!, lowLink.get(next)!));
      } else if (onStack.has(next)) {
        lowLink.set(key, Math.min(lowLink.get(key)!, index.get(next)!));
      }
    }
    if (lowLink.get(key) !== index.get(key)) return;
    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (member !== key);
    if (component.length > 1 || successors(key).includes(key)) {
      const inNodeOrder = [...autoNodes.keys()].filter((k) => component.includes(k));
      cycles.push(inNodeOrder);
    }
  };

  for (const key of autoNodes.keys()) {
    if (!index.has(key)) visit(key);
  }
  return cycles;
}

// ============================================================
// Channel scope (Phase 11)
// ============================================================

/**
 * A request body's channel_scope: undefined when absent, null when the route
 * must answer 400. Since Stage 1 every new flow belongs to one channel, so
 * 'any' is accepted only for a legacy flow that already has it (`existing`):
 * those keep running on both channels until the user splits them.
 */
export function parseChannelScope(value: unknown, existing?: FlowChannelScope | null): FlowChannelScope | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !(FLOW_CHANNEL_SCOPES as readonly string[]).includes(value)) return null;
  if (value === "any" && existing !== "any") return null;
  return value as FlowChannelScope;
}

/**
 * A flow may use only the triggers and steps of every channel it runs on
 * (src/lib/channels/capabilities.ts): anything else blocks publishing, shown
 * on the trigger or the step. Both directions are checked: an Instagram flow
 * refuses WhatsApp-only steps and a WhatsApp flow refuses Instagram-only ones.
 * Every step and trigger that existed before Stage 1 runs on WhatsApp, so
 * existing WhatsApp flows get no new issue.
 */
export function channelScopeIssues(
  scope: FlowChannelScope | null | undefined,
  triggerType: FlowInput["trigger_type"],
  nodes: NodeInput[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const channel of scopeChannels(scope)) {
    const instagram = channel === "instagram";
    if (!triggerAvailableOn(triggerType, channel)) {
      issues.push({ severity: "error", scope: "trigger", field: "trigger_type",
        message: instagram ? tChannel("triggerUnavailable") : tSection("triggerUnavailable", { channel: tNames(channel) }) });
    }
    for (const node of nodes) {
      const availability = nodeAvailableOn(node.node_type as FlowNodeType, channel, node.config ?? {});
      if (!availability.ok) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "node_type",
          message: instagram
            ? tChannel("unavailableOnChannel", { node: node.node_type })
            : tSection("nodeUnavailable", { node: node.node_type, channel: tNames(channel) }),
        });
      } else if (availability.warning === "text_over_limit") {
        issues.push({ severity: "warning", scope: "node", node_key: node.node_key, message: tChannel("textOverLimit") });
      }
    }
  }
  return issues;
}

// ============================================================
// Trigger
// ============================================================

/**
 * Stage 5 multi-trigger rules: only an Instagram flow may add triggers, only
 * COMBINABLE_TRIGGERS combine (the primary included), at most
 * FLOW_TRIGGER_LIMITS.extraTriggers more, and each extra trigger passes the
 * same checks as a primary one. A flow without extra triggers gets none.
 */
export function extraTriggerIssues(flow: Pick<FlowInput, "trigger_type" | "extra_triggers" | "channel_scope">, aiConfigured?: boolean): ValidationIssue[] {
  const raw = flow.extra_triggers;
  if (raw === undefined || raw === null || (Array.isArray(raw) && raw.length === 0)) return [];
  const issues: ValidationIssue[] = [];
  const at = (field: string, message: string) => issues.push({ severity: "error", scope: "trigger", field, message });
  if (!Array.isArray(raw)) {
    at("extra_triggers", tMulti("notCombinable"));
    return issues;
  }
  if (flow.channel_scope !== "instagram") at("extra_triggers", tMulti("onlyInstagram"));
  if (!isCombinableTrigger(flow.trigger_type)) at("trigger_type", tMulti("notCombinable"));
  if (raw.length > FLOW_TRIGGER_LIMITS.extraTriggers) at("extra_triggers", tMulti("limitReached", { max: FLOW_TRIGGER_LIMITS.extraTriggers + 1 }));
  raw.slice(0, FLOW_TRIGGER_LIMITS.extraTriggers).forEach((entry, i) => {
    const item = (entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {}) as Record<string, unknown>;
    const type = item.trigger_type;
    const config = item.config && typeof item.config === "object" && !Array.isArray(item.config) ? item.config as Record<string, unknown> : null;
    if (!(FLOW_TRIGGER_TYPES as readonly unknown[]).includes(type) || !isCombinableTrigger(type) || !config
      || !triggerAvailableOn(type as FlowTriggerType, "instagram")) {
      at(`extra_triggers.${i}.trigger_type`, tMulti("notCombinable"));
      return;
    }
    const base = `extra_triggers.${i}.config`;
    issues.push(...validateTrigger(type as FlowTriggerType, config, aiConfigured, base));
    issues.push(...igTriggerIssues(type as FlowTriggerType, config).map((issue) => ({
      ...issue, field: issue.field?.replace(/^trigger_config/, base),
    })));
  });
  return issues;
}

function validateTrigger(
  trigger_type: FlowInput["trigger_type"],
  rawConfig: Record<string, unknown> | null | undefined,
  aiConfigured?: boolean,
  /** Where the trigger is stored: "trigger_config" (the primary) or "extra_triggers.<i>.config". */
  base = "trigger_config",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const trigger_config = rawConfig ?? {};
  const at = (field: string, key: string, severity: "error" | "warning" = "error") =>
    issues.push({ severity, scope: "trigger", field: field.replace(/^trigger_config/, base), message: t(key) });

  if (trigger_type === "keyword" && trigger_config.match_type === "intent") {
    // Stage 5: matched by meaning (lib/ai/intent-match.ts) after every exact trigger, before default_reply.
    const intent = typeof trigger_config.intent === "string" ? trigger_config.intent.trim() : "";
    if (!intent) issues.push({ severity: "error", scope: "trigger", field: `${base}.intent`, message: tIntent("required") });
    else if (intent.length > FLOW_TRIGGER_LIMITS.intentChars) issues.push({ severity: "error", scope: "trigger", field: `${base}.intent`, message: tIntent("tooLong") });
    // Without AI nothing matches (the default reply still applies): say so, but do not block.
    if (aiConfigured === false) issues.push({ severity: "warning", scope: "trigger", field: `${base}.match_type`, message: tIntent("needsAi") });
  } else if (trigger_type === "keyword" && trigger_config.match_type === "regex") {
    const pattern = trigger_config.pattern;
    let valid = typeof pattern === "string" && pattern.length > 0 && pattern.length <= 256;
    if (valid) { try { new RegExp(pattern as string, "u"); } catch { valid = false; } }
    if (!valid) at("trigger_config.pattern", "triggerBadPattern");
  } else if (trigger_type === "keyword" && trigger_config.match_type === "not_contains") {
    // Fires on almost every message, ahead of the default reply and first-message flows.
    at("trigger_config.match_type", "triggerNotContainsBroad", "warning");
  } else if (trigger_type === "tag_added") {
    // Which tag starts it: a tag id of this workspace (the editor lists only those).
    if (typeof trigger_config.tag_id !== "string" || !UUID.test(trigger_config.tag_id)) at("trigger_config.tag_id", "triggerTagRequired");
  } else if (trigger_type === "outside_hours") {
    if (trigger_config.frequency !== "every_time" && trigger_config.frequency !== "once_per_24h") at("trigger_config.frequency", "triggerBadFrequency");
  } else if (trigger_type === "ad_click") {
    // Optional Meta ad ids (empty or absent = any ad); digits only, at most 50.
    const ids = trigger_config.ad_ids;
    if (ids !== undefined && (!Array.isArray(ids) || ids.length > 50
      || ids.some((id) => typeof id !== "string" || !/^\d{1,32}$/.test(id)))) {
      issues.push({ severity: "error", scope: "trigger", field: `${base}.ad_ids`, message: t("adClickIds", { max: 50 }) });
    }
  } else if (trigger_type === "template_reply") {
    if (typeof trigger_config.template_name !== "string" || !trigger_config.template_name.trim()) {
      at("trigger_config.template_name", "triggerNeedsTemplate");
    }
    const buttons = trigger_config.buttons;
    if (buttons !== undefined && (!Array.isArray(buttons) || buttons.some((b) => typeof b !== "string"))) {
      at("trigger_config.buttons", "triggerBadButtons");
    }
  } else if (trigger_type === "keyword") {
    const keywords = Array.isArray(trigger_config.keywords)
      ? (trigger_config.keywords as unknown[])
      : null;
    if (!keywords || keywords.length === 0) {
      issues.push({
        severity: "error",
        scope: "trigger",
        field: `${base}.keywords`,
        message: t("keywordsRequired"),
      });
    } else {
      // Empty / whitespace-only keywords are silent no-ops at match
      // time — call them out so the user doesn't think they configured
      // a keyword that never fires.
      const blanks = keywords.filter(
        (k) => typeof k !== "string" || !k.trim(),
      ).length;
      if (blanks > 0) {
        issues.push({
          severity: "warning",
          scope: "trigger",
          field: `${base}.keywords`,
          message: t("blankKeywords", { count: blanks }),
        });
      }
    }
  }
  // first_inbound_message / manual / order_received have no config; nothing to validate.

  return issues;
}

// ============================================================
// Per-node
// ============================================================

function validateNode(
  node: NodeInput,
  knownKeys: Set<string>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  switch (node.node_type) {
    case "start": {
      const cfg = node.config as { next_node_key?: string };
      if (!cfg.next_node_key) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: t("startNeedsNext"),
        });
      } else if (!knownKeys.has(cfg.next_node_key)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: t("startMissingNext", { key: cfg.next_node_key }),
        });
      }
      break;
    }

    case "send_message": {
      const cfg = node.config as { text?: string; next_node_key?: string };
      if (!cfg.text?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "text",
          message: t("sendMessageNeedsText"),
        });
      }
      if (!cfg.next_node_key) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: t("sendMessageNeedsNext"),
        });
      } else if (!knownKeys.has(cfg.next_node_key)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: t("sendMessageMissingNext", { key: cfg.next_node_key }),
        });
      }
      break;
    }

    case "send_media": {
      const cfg = node.config as {
        media_type?: "image" | "video" | "document";
        media_url?: string;
        caption?: string;
        next_node_key?: string;
      };
      if (
        !cfg.media_type ||
        !["image", "video", "document"].includes(cfg.media_type)
      ) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "media_type",
          message: t("sendMediaNeedsType"),
        });
      }
      if (!cfg.media_url?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "media_url",
          message: t("sendMediaNeedsFile"),
        });
      }
      // Caption cap mirrors Meta's interactive body cap; documented as a
      // hard limit in the WhatsApp Cloud API media-message reference.
      if (cfg.caption && cfg.caption.length > INTERACTIVE_LIMITS.bodyMaxLength) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "caption",
          message: t("captionTooLong", { max: INTERACTIVE_LIMITS.bodyMaxLength }),
        });
      }
      if (!cfg.next_node_key) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: t("sendMediaNeedsNext"),
        });
      } else if (!knownKeys.has(cfg.next_node_key)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: t("sendMediaMissingNext", { key: cfg.next_node_key }),
        });
      }
      break;
    }

    case "send_buttons": {
      const cfg = node.config as {
        text?: string;
        buttons?: Array<{
          reply_id?: string;
          title?: string;
          next_node_key?: string;
        }>;
      };
      if (!cfg.text?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "text",
          message: t("sendButtonsNeedsText"),
        });
      }
      const btns = cfg.buttons ?? [];
      if (btns.length < 1) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "buttons",
          message: t("sendButtonsNeedsButton"),
        });
      }
      if (btns.length > INTERACTIVE_LIMITS.maxButtons) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "buttons",
          message: t("tooManyButtons", { max: INTERACTIVE_LIMITS.maxButtons }),
        });
      }
      const seenIds = new Set<string>();
      btns.forEach((b, i) => {
        const field = `buttons.${i}`;
        if (!b.reply_id?.trim()) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: `${field}.reply_id`,
            message: t("buttonNeedsReplyId", { n: i + 1 }),
          });
        } else if (seenIds.has(b.reply_id)) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: `${field}.reply_id`,
            message: t("duplicateButtonReplyId", { id: b.reply_id }),
          });
        }
        if (b.reply_id) seenIds.add(b.reply_id);

        if (!b.title?.trim()) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: `${field}.title`,
            message: t("buttonNeedsTitle", { n: i + 1 }),
          });
        } else if (b.title.length > INTERACTIVE_LIMITS.buttonTitleMaxLength) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: `${field}.title`,
            message: t("buttonTitleTooLong", {
              n: i + 1,
              max: INTERACTIVE_LIMITS.buttonTitleMaxLength,
            }),
          });
        }

        if (!b.next_node_key) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: `${field}.next_node_key`,
            message: t("buttonNeedsNext", { n: i + 1 }),
          });
        } else if (!knownKeys.has(b.next_node_key)) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: `${field}.next_node_key`,
            message: t("buttonMissingNext", { n: i + 1, key: b.next_node_key }),
          });
        }
      });
      break;
    }

    case "send_list": {
      const cfg = node.config as {
        text?: string;
        button_label?: string;
        sections?: Array<{
          title?: string;
          rows?: Array<{
            reply_id?: string;
            title?: string;
            description?: string;
            next_node_key?: string;
          }>;
        }>;
      };
      if (!cfg.text?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "text",
          message: t("sendListNeedsText"),
        });
      }
      if (!cfg.button_label?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "button_label",
          message: t("sendListNeedsLabel"),
        });
      }
      const sections = cfg.sections ?? [];
      const totalRows = sections.reduce(
        (sum, s) => sum + (s.rows?.length ?? 0),
        0,
      );
      if (totalRows < 1) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "sections",
          message: t("sendListNeedsRow"),
        });
      }
      if (totalRows > INTERACTIVE_LIMITS.maxListRowsTotal) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "sections",
          message: t("tooManyRows", { max: INTERACTIVE_LIMITS.maxListRowsTotal }),
        });
      }
      const seenIds = new Set<string>();
      sections.forEach((section, si) => {
        const rows = section.rows ?? [];
        rows.forEach((row, ri) => {
          const field = `sections.${si}.rows.${ri}`;
          if (!row.reply_id?.trim()) {
            issues.push({
              severity: "error",
              scope: "node",
              node_key: node.node_key,
              field: `${field}.reply_id`,
              message: t("rowNeedsReplyId", { row: ri + 1, section: si + 1 }),
            });
          } else if (seenIds.has(row.reply_id)) {
            issues.push({
              severity: "error",
              scope: "node",
              node_key: node.node_key,
              field: `${field}.reply_id`,
              message: t("duplicateRowId", { id: row.reply_id }),
            });
          }
          if (row.reply_id) seenIds.add(row.reply_id);

          if (!row.title?.trim()) {
            issues.push({
              severity: "error",
              scope: "node",
              node_key: node.node_key,
              field: `${field}.title`,
              message: t("rowNeedsTitle", { n: ri + 1 }),
            });
          } else if (
            row.title.length > INTERACTIVE_LIMITS.listRowTitleMaxLength
          ) {
            issues.push({
              severity: "error",
              scope: "node",
              node_key: node.node_key,
              field: `${field}.title`,
              message: t("rowTitleTooLong", {
                n: ri + 1,
                max: INTERACTIVE_LIMITS.listRowTitleMaxLength,
              }),
            });
          }
          if (
            row.description &&
            row.description.length >
              INTERACTIVE_LIMITS.listRowDescriptionMaxLength
          ) {
            issues.push({
              severity: "error",
              scope: "node",
              node_key: node.node_key,
              field: `${field}.description`,
              message: t("rowDescriptionTooLong", {
                n: ri + 1,
                max: INTERACTIVE_LIMITS.listRowDescriptionMaxLength,
              }),
            });
          }
          if (!row.next_node_key) {
            issues.push({
              severity: "error",
              scope: "node",
              node_key: node.node_key,
              field: `${field}.next_node_key`,
              message: t("rowNeedsNext", { n: ri + 1 }),
            });
          } else if (!knownKeys.has(row.next_node_key)) {
            issues.push({
              severity: "error",
              scope: "node",
              node_key: node.node_key,
              field: `${field}.next_node_key`,
              message: t("rowMissingNext", { n: ri + 1, key: row.next_node_key }),
            });
          }
        });
      });
      break;
    }

    case "collect_input":
    case "ask_media":
    case "ask_location":
    case "ask_address": {
      const cfg = node.config as {
        prompt_text?: string;
        var_key?: string;
        next_node_key?: string;
        validation?: string;
        regex?: string;
        min?: unknown;
        max?: unknown;
        media_types?: unknown;
        skip_label?: string;
        skip_next?: string;
        max_attempts?: unknown;
        exhausted_next?: string;
      };
      const legacy = node.node_type === "collect_input";
      if (legacy && cfg.validation !== undefined && !INPUT_FORMATS.includes(cfg.validation)) {
        issues.push({ severity: 'error', scope: 'node', node_key: node.node_key, field: 'validation', message: t('invalidInputValidation') });
      }
      if (legacy && cfg.validation === 'regex') {
        let valid = typeof cfg.regex === 'string' && cfg.regex.length > 0 && cfg.regex.length <= 256;
        if (valid) { try { new RegExp(`^(?:${cfg.regex})$`, 'u'); } catch { valid = false; } }
        if (!valid) issues.push({ severity: 'error', scope: 'node', node_key: node.node_key, field: 'regex', message: t('invalidInputRegex') });
      }
      if (legacy && cfg.validation === 'number') {
        const bound = (v: unknown) => v === undefined || v === null || (typeof v === 'number' && Number.isFinite(v));
        if (!bound(cfg.min) || !bound(cfg.max) || (typeof cfg.min === 'number' && typeof cfg.max === 'number' && cfg.min > cfg.max)) {
          issues.push({ severity: 'error', scope: 'node', node_key: node.node_key, field: 'min', message: t('invalidNumberRange') });
        }
      }
      if (node.node_type === "ask_media" && cfg.media_types !== undefined &&
          (!Array.isArray(cfg.media_types) || cfg.media_types.some((m) => !MEDIA_REPLY_TYPES.includes(m)))) {
        issues.push({ severity: 'error', scope: 'node', node_key: node.node_key, field: 'media_types', message: t('invalidMediaTypes') });
      }
      if (!cfg.prompt_text?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "prompt_text",
          message: t(legacy ? "collectNeedsPrompt" : "questionNeedsPrompt"),
        });
      }
      // These prompts go out as interactive messages, which have a shorter body limit.
      const interactivePrompt = Boolean(cfg.skip_label) || node.node_type === "ask_location" || node.node_type === "ask_address";
      if (interactivePrompt && (cfg.prompt_text?.length ?? 0) > INTERACTIVE_LIMITS.bodyMaxLength) {
        issues.push({ severity: 'error', scope: 'node', node_key: node.node_key, field: 'prompt_text', message: t('promptTooLongForInteractive', { max: INTERACTIVE_LIMITS.bodyMaxLength }) });
      }
      // With a Skip button the error message is sent as the body of a button message too.
      const errorText = (node.config as { error_text?: unknown }).error_text;
      if (cfg.skip_label && typeof errorText === 'string' && errorText.length > INTERACTIVE_LIMITS.bodyMaxLength) {
        issues.push({ severity: 'error', scope: 'node', node_key: node.node_key, field: 'error_text', message: t('promptTooLongForInteractive', { max: INTERACTIVE_LIMITS.bodyMaxLength }) });
      }
      if (!cfg.var_key?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "var_key",
          message: t(legacy ? "collectNeedsVarKey" : "questionNeedsVarKey"),
        });
      } else if (!VAR_KEY.test(cfg.var_key)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "var_key",
          message: t("invalidVarKey", { key: cfg.var_key }),
        });
      }
      if (!cfg.next_node_key) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: t(legacy ? "collectNeedsNext" : "nodeNeedsNext"),
        });
      } else if (!knownKeys.has(cfg.next_node_key)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: t(legacy ? "collectMissingNext" : "nodeMissingNext", { key: cfg.next_node_key }),
        });
      }
      if (cfg.skip_label !== undefined && cfg.skip_label !== "") {
        if (node.node_type !== "collect_input" && node.node_type !== "ask_media") {
          issues.push({ severity: 'error', scope: 'node', node_key: node.node_key, field: 'skip_label', message: t('skipNotAllowed') });
        } else if (cfg.skip_label.trim().length === 0 || cfg.skip_label.length > INTERACTIVE_LIMITS.buttonTitleMaxLength) {
          issues.push({ severity: 'error', scope: 'node', node_key: node.node_key, field: 'skip_label', message: t('skipLabelInvalid', { max: INTERACTIVE_LIMITS.buttonTitleMaxLength }) });
        }
        issues.push(...portIssues(node, knownKeys, "skip_next", "skipNeedsNext", "skipMissingNext"));
      }
      if (cfg.max_attempts !== undefined && cfg.max_attempts !== null &&
          !(typeof cfg.max_attempts === 'number' && Number.isInteger(cfg.max_attempts) && cfg.max_attempts >= 1 && cfg.max_attempts <= 10)) {
        issues.push({ severity: 'error', scope: 'node', node_key: node.node_key, field: 'max_attempts', message: t('invalidMaxAttempts') });
      }
      if (cfg.exhausted_next) {
        if (!knownKeys.has(cfg.exhausted_next)) {
          issues.push({ severity: 'error', scope: 'node', node_key: node.node_key, field: 'exhausted_next', message: t('exhaustedMissingNext', { key: cfg.exhausted_next }) });
        }
        if (cfg.max_attempts === undefined || cfg.max_attempts === null) {
          issues.push({ severity: 'warning', scope: 'node', node_key: node.node_key, field: 'exhausted_next', message: t('exhaustedNeedsAttempts') });
        }
      }
      break;
    }

    case "set_attribute": {
      const cfg = node.config as { target?: string; key?: string; value?: unknown; next_node_key?: string };
      if (!cfg.target || !["var", "contact_field", "custom_field"].includes(cfg.target)) {
        issues.push({ severity: 'error', scope: 'node', node_key: node.node_key, field: 'target', message: t('setAttributeNeedsTarget') });
      } else {
        const key = typeof cfg.key === 'string' ? cfg.key : '';
        const valid = cfg.target === 'var' ? VAR_KEY.test(key)
          : cfg.target === 'contact_field' ? (WRITABLE_CONTACT_FIELDS as readonly string[]).includes(key)
          : UUID.test(key);
        if (!valid) issues.push({ severity: 'error', scope: 'node', node_key: node.node_key, field: 'key', message: t('setAttributeBadKey') });
      }
      if (typeof cfg.value !== 'string' || cfg.value.length > SET_ATTRIBUTE_MAX) {
        issues.push({ severity: 'error', scope: 'node', node_key: node.node_key, field: 'value', message: t('setAttributeValueTooLong', { max: SET_ATTRIBUTE_MAX }) });
      }
      issues.push(...portIssues(node, knownKeys, "next_node_key", "nodeNeedsNext", "nodeMissingNext"));
      break;
    }

    case "condition": {
      const cfg = node.config as {
        match?: unknown;
        rules?: unknown;
        timezone?: unknown;
        true_next?: string;
        false_next?: string;
      } & Partial<Record<keyof ConditionRule, unknown>>;
      if (cfg.match !== undefined && cfg.match !== "all" && cfg.match !== "any") {
        issues.push({ severity: 'error', scope: 'node', node_key: node.node_key, field: 'match', message: t('conditionBadMatch') });
      }
      const grouped = cfg.rules !== undefined;
      if (grouped && (!Array.isArray(cfg.rules) || cfg.rules.length < 1 || cfg.rules.length > MAX_CONDITION_RULES)) {
        issues.push({ severity: 'error', scope: 'node', node_key: node.node_key, field: 'rules', message: t('conditionRuleCount', { max: MAX_CONDITION_RULES }) });
      }
      const rules: Array<[Record<string, unknown>, string]> = grouped
        ? (Array.isArray(cfg.rules) ? cfg.rules : []).map((rule, i) => [rule && typeof rule === 'object' ? rule as Record<string, unknown> : {}, `rules.${i}.`])
        : [[cfg, ""]];
      for (const [rule, prefix] of rules) issues.push(...ruleIssues(node.node_key, rule, prefix, knownKeys));
      if (rules.some(([rule]) => rule.subject === "time" || rule.subject === "date") &&
          cfg.timezone !== undefined && !isValidTimeZone(cfg.timezone)) {
        issues.push({ severity: 'error', scope: 'node', node_key: node.node_key, field: 'timezone', message: t('conditionBadTimezone') });
      }
      for (const branch of ["true_next", "false_next"] as const) {
        const key = cfg[branch];
        if (!key) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: branch,
            message: t("conditionNeedsBranch", {
              branch: branch === "true_next" ? "true" : "false",
            }),
          });
        } else if (!knownKeys.has(key)) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: branch,
            message: t("conditionMissingBranch", { branch, key }),
          });
        }
      }
      break;
    }

    case "send_template": {
      const cfg = node.config as { template_name?: unknown; body_params?: unknown; buttons?: unknown; next_node_key?: string };
      if (typeof cfg.template_name !== "string" || !cfg.template_name.trim()) {
        issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "template_name", message: t("templateNeedsName") });
      }
      const params = Array.isArray(cfg.body_params) ? cfg.body_params : [];
      params.forEach((p, i) => {
        if (typeof p !== "string" || !p.trim()) {
          issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: `body_params.${i}`, message: t("templateParamEmpty", { n: i + 1 }) });
        }
      });
      const buttons = Array.isArray(cfg.buttons) ? (cfg.buttons as Array<Record<string, unknown>>) : [];
      const seen = new Set<string>();
      buttons.forEach((b, i) => {
        const replyId = typeof b.reply_id === "string" ? b.reply_id : "";
        // qr_<uuid> payloads belong to quick-reply actions, which run before flows.
        if (!replyId || seen.has(replyId) || /^qr_/i.test(replyId)) {
          issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: `buttons.${i}.reply_id`, message: t("templateBadReplyId") });
        }
        seen.add(replyId);
        const next = b.next_node_key;
        if (!next) {
          issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: `buttons.${i}.next_node_key`, message: t("buttonNeedsNext", { n: i + 1 }) });
        } else if (typeof next !== "string" || !knownKeys.has(next)) {
          issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: `buttons.${i}.next_node_key`, message: t("nodeMissingNext", { key: String(next) }) });
        }
      });
      if (!buttons.length) issues.push(...portIssues(node, knownKeys, "next_node_key", "nodeNeedsNext", "nodeMissingNext"));
      // Location, offer window, coupon and carousel card values (lib/whatsapp/template-send-params).
      for (const issue of flowTemplateExtrasIssues(cfg as FlowTemplateExtras)) {
        issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: issue.field, message: issue.message });
      }
      break;
    }

    case "api_request": {
      const cfg = node.config as {
        method?: unknown; url?: unknown; params?: unknown; headers?: unknown; body?: unknown;
        mappings?: unknown; routes?: unknown;
      };
      const at = (field: string, key: string, values?: Record<string, string | number>) =>
        issues.push({ severity: "error", scope: "node", node_key: node.node_key, field, message: t(key, values) });
      if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(cfg.method as string)) at("method", "apiBadMethod");
      // Placeholders become a harmless stand-in so the shape itself can be checked.
      const sample = (v: string) => v.replace(/\{\{[^}]*\}\}/g, "0");
      let urlOk = false;
      if (typeof cfg.url === "string") {
        try {
          const u = new URL(sample(cfg.url.trim()));
          urlOk = (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password;
        } catch { /* reported below */ }
      }
      if (!urlOk) at("url", "apiBadUrl");
      const pairs = (list: unknown, field: string) => {
        if (list === undefined) return;
        if (!Array.isArray(list) || list.length > 20) return at(field, "apiTooMany", { max: 20 });
        list.forEach((p: { key?: unknown; value?: unknown }, i) => {
          if (typeof p?.key !== "string" || typeof p.value !== "string" || (field === "headers" && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(p.key))) {
            at(`${field}.${i}`, "apiBadPair");
          }
        });
      };
      pairs(cfg.params, "params");
      pairs(cfg.headers, "headers");
      // A GET or DELETE never sends its body, so a leftover one is not checked.
      if (cfg.method !== "GET" && cfg.method !== "DELETE" && cfg.body !== undefined && cfg.body !== "") {
        let bodyOk = typeof cfg.body === "string" && cfg.body.length <= 20_000;
        // Values are inserted as escaped string content, so each placeholder must sit
        // inside quotes; unknown placeholders are left in and fail the parse.
        const bodySample = (v: string) => v.replace(/\{\{\s*(vars|contact|workspace)\.[a-zA-Z0-9_]+\s*\}\}/g, "x");
        if (bodyOk) { try { JSON.parse(bodySample(cfg.body as string)); } catch { bodyOk = false; } }
        if (!bodyOk) at("body", "apiBadBody");
      }
      if (cfg.mappings !== undefined) {
        if (!Array.isArray(cfg.mappings) || cfg.mappings.length > 20) at("mappings", "apiTooMany", { max: 20 });
        else cfg.mappings.forEach((m: { path?: unknown; var_key?: unknown }, i) => {
          if (typeof m?.path !== "string" || !m.path.trim() || typeof m.var_key !== "string" || !VAR_KEY.test(m.var_key)) at(`mappings.${i}`, "apiBadMapping");
        });
      }
      const routes = Array.isArray(cfg.routes) ? (cfg.routes as Array<{ status?: unknown; next_node_key?: unknown }>) : [];
      if (cfg.routes !== undefined && (!Array.isArray(cfg.routes) || routes.length > MAX_API_ROUTES)) at("routes", "apiTooMany", { max: MAX_API_ROUTES });
      routes.slice(0, MAX_API_ROUTES).forEach((r, i) => {
        if (typeof r?.status !== "string" || !/^([1-5]\d\d|[1-5]xx)$/i.test(r.status.trim())) at(`routes.${i}.status`, "apiBadStatus");
        if (!r?.next_node_key) at(`routes.${i}.next_node_key`, "apiRouteNeedsNext", { status: String(r?.status ?? "") });
        else if (typeof r.next_node_key !== "string" || !knownKeys.has(r.next_node_key)) at(`routes.${i}.next_node_key`, "nodeMissingNext", { key: String(r.next_node_key) });
      });
      issues.push(...portIssues(node, knownKeys, "fallback_next", "apiNeedsFallback", "nodeMissingNext"));
      break;
    }

    case "connect_flow": {
      const flowId = node.config.flow_id;
      if (typeof flowId !== "string" || !UUID.test(flowId)) {
        issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "flow_id", message: t("connectNeedsFlow") });
      }
      break;
    }

    case "assign_agent": {
      const cfg = node.config as { mode?: unknown; agent_id?: unknown };
      if (cfg.mode !== "specific" && cfg.mode !== "round_robin") {
        issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "mode", message: t("assignNeedsMode") });
      } else if (cfg.mode === "specific" && (typeof cfg.agent_id !== "string" || !UUID.test(cfg.agent_id))) {
        issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "agent_id", message: t("assignNeedsAgent") });
      }
      issues.push(...portIssues(node, knownKeys, "next_node_key", "nodeNeedsNext", "nodeMissingNext"));
      break;
    }

    case "set_tag": {
      const cfg = node.config as {
        mode?: "add" | "remove";
        tag_id?: string;
        next_node_key?: string;
      };
      if (!cfg.mode || !["add", "remove"].includes(cfg.mode)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "mode",
          message: t("setTagNeedsMode"),
        });
      }
      if (!cfg.tag_id) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "tag_id",
          message: t("setTagNeedsTag"),
        });
      }
      if (!cfg.next_node_key) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: t("setTagNeedsNext"),
        });
      } else if (!knownKeys.has(cfg.next_node_key)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: t("setTagMissingNext", { key: cfg.next_node_key }),
        });
      }
      break;
    }

    case "send_product":
    case "send_product_list":
    case "send_catalog":
      issues.push(...commerceNodeIssues(node, knownKeys));
      break;

    case "send_form":
      // Checked by sendFormIssues, which also knows the account's forms.
      break;

    case "payment_link":
      issues.push(...paymentLinkIssues(node, knownKeys));
      break;

    case "book_appointment":
      issues.push(...bookAppointmentIssues(node, knownKeys));
      break;

    case "ai_reply":
      // Checked by aiReplyIssues, which also knows whether AI is set up.
      break;

    case "conversion_event":
      issues.push(...conversionIssues(node, knownKeys));
      break;

    case "send_storefront_link":
      issues.push(...storefrontLinkIssues(node, knownKeys));
      break;

    case "ig_comment_reply":
    case "ig_private_reply":
    case "send_card":
    case "send_gallery":
      // Instagram-only steps: checked by igNodeIssues (instagram-validation.ts).
      break;

    case "handoff":
    case "end":
      // Terminal nodes have no outgoing edges; nothing to validate
      // beyond their existence.
      break;

    case "actions":
    case "randomizer":
    case "smart_delay":
    case "google_sheets":
      // Stage 5 steps: checked by stage5NodeIssues (stage5-validation.ts).
      break;

    default:
      issues.push({
        severity: "error",
        scope: "node",
        node_key: node.node_key,
        message: t("unknownNodeType", { type: node.node_type }),
      });
  }

  return issues;
}

// ============================================================
// Reachability — BFS from the entry, follow outgoing edges per node
// ============================================================

export function reachableFromEntry(
  entryKey: string,
  nodes: NodeInput[],
): Set<string> {
  const byKey = new Map<string, NodeInput>();
  for (const n of nodes) byKey.set(n.node_key, n);

  const visited = new Set<string>();
  const queue: string[] = [entryKey];
  while (queue.length > 0) {
    const key = queue.shift() as string;
    if (visited.has(key)) continue;
    visited.add(key);
    const node = byKey.get(key);
    if (!node) continue;
    for (const next of outgoingEdges(node)) {
      if (!visited.has(next)) queue.push(next);
    }
  }
  return visited;
}

const VAR_KEY = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const INPUT_FORMATS: string[] = ["any", "email", "phone", "regex", "number", "date", "boolean"];
const MEDIA_REPLY_TYPES: unknown[] = ["image", "video", "document", "audio"];
const CONDITION_SUBJECTS: unknown[] = ["var", "tag", "contact_field", "custom_field", "time", "date", "ig_profile", ...STAGE5_CONDITION_SUBJECTS];
/** Stage 5 subjects that hold or not ("true"/"false"), so only these operators make sense. */
const YES_NO_SUBJECTS: unknown[] = ["segment", "link_click", "sequence"];
const CONDITION_OPERATORS: unknown[] = ["equals", "not_equals", "contains", "present", "absent", "gt", "gte", "lt", "lte", "between"];
const MAX_CONDITION_RULES = 10;
const SET_ATTRIBUTE_MAX = 1000;
const MAX_API_ROUTES = 5;
/** Nodes that wait for the customer, so a reply timeout means something. */
const WAITING_TYPES = ["send_buttons", "send_list", "send_template", "collect_input", "ask_media", "ask_location", "ask_address", "send_form", "payment_link", "book_appointment"];
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Meta's limits on the flow message around a form. */
export const SEND_FORM_LIMITS = { cta: 30, body: 1024, header: 60, footer: 60 } as const;

/** A send_form step: the form, the message around it, the variable and the next step. */
export function sendFormIssues(node: NodeInput, knownKeys: ReadonlySet<string>, forms?: FlowFormLookup): ValidationIssue[] {
  const cfg = node.config as { form_id?: unknown; cta?: unknown; body?: unknown; header?: unknown; footer?: unknown; var_key?: unknown; next_node_key?: unknown };
  const issues: ValidationIssue[] = [];
  const at = (field: string, message: string) => issues.push({ severity: "error", scope: "node", node_key: node.node_key, field, message });
  const formId = typeof cfg.form_id === "string" ? cfg.form_id : "";
  if (!UUID_SHAPE.test(formId)) at("form_id", t("formNeedsForm"));
  else if (forms && !forms.has(formId)) at("form_id", t("formMissing"));
  else if (forms && forms.get(formId)!.status !== "published") at("form_id", t("formNotPublished"));
  const text = (field: "cta" | "body" | "header" | "footer", required: boolean) => {
    const value = cfg[field];
    if (value === undefined || value === null || value === "") {
      if (required) at(field, t(field === "cta" ? "formNeedsCta" : "formNeedsBody"));
    } else if (typeof value !== "string" || (required && !value.trim()) || value.length > SEND_FORM_LIMITS[field]) {
      at(field, t("formTextTooLong", { max: SEND_FORM_LIMITS[field] }));
    }
  };
  text("cta", true);
  text("body", true);
  text("header", false);
  text("footer", false);
  if (typeof cfg.var_key !== "string" || !cfg.var_key.trim()) at("var_key", t("questionNeedsVarKey"));
  else if (!VAR_KEY.test(cfg.var_key)) at("var_key", t("invalidVarKey", { key: cfg.var_key }));
  if (!cfg.next_node_key) at("next_node_key", t("nodeNeedsNext"));
  else if (typeof cfg.next_node_key !== "string" || !knownKeys.has(cfg.next_node_key)) at("next_node_key", t("nodeMissingNext", { key: String(cfg.next_node_key) }));
  return issues;
}

/** Whether the node stops for the customer: a template only when it has quick-reply buttons. */
function waitsForReply(node: NodeInput): boolean {
  if (node.node_type === "send_template") return Array.isArray(node.config.buttons) && node.config.buttons.length > 0;
  if (node.node_type === "ai_reply") return aiReplyWaits(node.config);
  // A private reply waits for its opening button; a card for a tap on a "go to a step" button.
  if (node.node_type === "ig_private_reply") return privateReplyWaits(node.config);
  if (node.node_type === "send_card" || node.node_type === "send_gallery") return cardRouteTargets(node).length > 0;
  return WAITING_TYPES.includes(node.node_type);
}
/** Config keys that hold routing or patterns rather than customer-visible text. */
const NOT_TEXT_FIELDS = ["regex", "media_url", "reply_id", "next_node_key", "true_next", "false_next", "after_timeout", "exhausted_next", "skip_next", "key", "target", "paid_next", "expired_next", "failed_next", "success_next", "unavailable_next", "cancelled_next", "service_ids", "location_id", "currency", "handoff_next", "instructions", "finish_next", "failure_next", "flow_id", "tag_id", "sequence_id", "event_type_id", "spreadsheet_id", "date"];

/** Variables a node stores for the nodes after it. */
function producedVars(node: NodeInput, forms?: FlowFormLookup): string[] {
  const cfg = node.config;
  if (node.node_type === "set_attribute") return cfg.target === "var" && typeof cfg.key === "string" ? [cfg.key] : [];
  if (node.node_type === "api_request") {
    return Array.isArray(cfg.mappings) ? (cfg.mappings as Array<{ var_key?: unknown }>).map((m) => m?.var_key).filter((k): k is string => typeof k === "string") : [];
  }
  if (node.node_type === "payment_link") return [...PAYMENT_LINK_VARS];
  if (node.node_type === "book_appointment") return [...BOOK_APPOINTMENT_VARS];
  if (node.node_type === "google_sheets") {
    return Array.isArray(cfg.var_map) ? (cfg.var_map as Array<{ var_key?: unknown }>).map((m) => m?.var_key).filter((k): k is string => typeof k === "string") : [];
  }
  if (node.node_type === "ai_reply") return typeof cfg.var_key === "string" && cfg.var_key ? [cfg.var_key] : [];
  const key = typeof cfg.var_key === "string" ? cfg.var_key : null;
  if (!key) return [];
  switch (node.node_type) {
    case "collect_input": return [key];
    case "ask_media": return [key, `${key}_type`];
    case "ask_location": return [key, `${key}_latitude`, `${key}_longitude`, `${key}_name`, `${key}_address`];
    case "ask_address": return [key, ...["name", "phone_number", "in_pin_code", "house_number", "floor_number", "tower_number",
      "building_name", "address", "landmark_area", "city", "state"].map((field) => `${key}_${field}`)];
    case "send_form": {
      const fields = typeof cfg.form_id === "string" ? forms?.get(cfg.form_id)?.fields ?? [] : [];
      return [key, ...fields.map((field) => `${key}_${field}`)];
    }
    default: return [];
  }
}

function portIssues(node: NodeInput, knownKeys: Set<string>, field: string, needs: string, missing: string): ValidationIssue[] {
  const key = node.config[field];
  if (!key) return [{ severity: "error", scope: "node", node_key: node.node_key, field, message: t(needs) }];
  if (typeof key !== "string" || !knownKeys.has(key)) {
    return [{ severity: "error", scope: "node", node_key: node.node_key, field, message: t(missing, { key: String(key) }) }];
  }
  return [];
}

/** Delay and reply-timeout settings, which any node may carry. */
function timingIssues(node: NodeInput, knownKeys: Set<string>, runTimeoutHours?: number): ValidationIssue[] {
  const cfg = node.config as NodeTiming;
  const issues: ValidationIssue[] = [];
  const at = (field: string, message: string, severity: "error" | "warning" = "error") =>
    issues.push({ severity, scope: "node", node_key: node.node_key, field, message });
  if (cfg.delay_seconds !== undefined && cfg.delay_seconds !== null) {
    if (node.node_type === "start") at("delay_seconds", t("delayNotAllowed"));
    else if (!(Number.isInteger(cfg.delay_seconds) && cfg.delay_seconds >= 1 && cfg.delay_seconds <= 86_400)) at("delay_seconds", t("invalidDelay"));
  }
  if (cfg.timeout_minutes !== undefined && cfg.timeout_minutes !== null) {
    const minutes = cfg.timeout_minutes;
    if (!waitsForReply(node)) {
      at("timeout_minutes", t("timeoutNotAllowed"));
    } else {
      if (!(Number.isInteger(minutes) && minutes >= 1 && minutes <= 10_080)) at("timeout_minutes", t("invalidTimeout"));
      else if (runTimeoutHours !== undefined && minutes > runTimeoutHours * 60) {
        at("timeout_minutes", t("timeoutAfterRunTimeout", { hours: runTimeoutHours }), "warning");
      }
      issues.push(...portIssues(node, knownKeys, "after_timeout", "timeoutNeedsNext", "timeoutMissingNext"));
    }
  }
  return issues;
}

/** One condition rule; `prefix` locates it ("" for a single-test node, "rules.N." in a group). */
function ruleIssues(nodeKey: string, rule: Record<string, unknown>, prefix: string, knownKeys: ReadonlySet<string> = new Set()): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const at = (field: string, message: string, severity: "error" | "warning" = "error") =>
    issues.push({ severity, scope: "node", node_key: nodeKey, field: prefix + field, message });
  const { subject, operator } = rule;
  const clock = subject === "time" || subject === "date";
  if (!CONDITION_SUBJECTS.includes(subject)) at("subject", t("conditionNeedsSubject"));
  if (!clock && !(typeof rule.subject_key === "string" && rule.subject_key.trim())) at("subject_key", t("conditionNeedsSubjectKey"));
  else {
    const problem = stage5SubjectProblem(rule, knownKeys);
    if (problem) at("subject_key", problem);
  }
  if (YES_NO_SUBJECTS.includes(subject) && operator !== "equals" && operator !== "not_equals") {
    at("operator", t("conditionNeedsOperator"));
    return issues;
  }
  if (!CONDITION_OPERATORS.includes(operator) || (clock && (operator === "present" || operator === "absent"))) {
    at("operator", t("conditionNeedsOperator"));
    return issues;
  }
  if (operator === "present" || operator === "absent") return issues;
  const value = typeof rule.value === "string" ? rule.value : "";
  const value2 = typeof rule.value2 === "string" ? rule.value2 : "";
  if (operator === "equals" || operator === "contains") {
    // Kept a warning: an empty value deliberately matches empty subjects.
    if (!value) at("value", t("operatorNeedsValue", { operator: String(operator) }), "warning");
  } else if (!value) {
    at("value", t("operatorRequiresValue", { operator: String(operator) }));
  }
  if (operator === "between" && !value2) at("value2", t("conditionNeedsBound"));
  const bounds = [value, operator === "between" ? value2 : ""].filter(Boolean);
  if (subject === "time" && bounds.some((v) => !CLOCK.test(v))) at("value", t("conditionBadTime"));
  if (subject === "date" && bounds.some((v) => !parseDateInput(v))) at("value", t("conditionBadDate"));
  return issues;
}

function outgoingEdges(node: NodeInput): string[] {
  const cfg = node.config;
  const out: string[] = [];
  const add = (key: unknown) => {
    if (typeof key === "string" && key) out.push(key);
  };
  switch (node.node_type) {
    case "start":
    case "send_message":
    case "send_media":
    case "set_tag":
    case "set_attribute":
    case "assign_agent":
    case "send_product":
    case "send_product_list":
    case "send_catalog":
    case "actions":
    case "smart_delay":
      add(cfg.next_node_key);
      break;
    case "google_sheets":
      add(cfg.next_node_key);
      add(cfg.failure_next);
      break;
    case "randomizer":
      for (const p of (Array.isArray(cfg.paths) ? cfg.paths : []) as Array<{ next_node_key?: unknown }>) add(p?.next_node_key);
      break;
    case "send_template": {
      const buttons = Array.isArray(cfg.buttons) ? (cfg.buttons as Array<{ next_node_key?: unknown }>) : [];
      if (buttons.length) buttons.forEach((b) => add(b.next_node_key));
      else add(cfg.next_node_key);
      break;
    }
    case "api_request":
      for (const r of (Array.isArray(cfg.routes) ? cfg.routes : []) as Array<{ next_node_key?: unknown }>) add(r?.next_node_key);
      add(cfg.fallback_next);
      break;
    case "send_form":
      add(cfg.next_node_key);
      break;
    case "payment_link":
      paymentLinkEdges(cfg).forEach(add);
      break;
    case "book_appointment":
      bookAppointmentEdges(cfg).forEach(add);
      break;
    case "ai_reply":
      aiReplyEdges(cfg).forEach(add);
      // Stage 5: a step with goals leaves through "Goals finished" too.
      if (Array.isArray(cfg.goals) && cfg.goals.length) add(cfg.finish_next);
      break;
    case "conversion_event":
      conversionEdges(cfg).forEach(add);
      break;
    case "send_storefront_link":
      storefrontLinkEdges(cfg).forEach(add);
      break;
    case "collect_input":
    case "ask_media":
    case "ask_location":
    case "ask_address":
      add(cfg.next_node_key);
      if (cfg.skip_label) add(cfg.skip_next);
      add(cfg.exhausted_next);
      break;
    case "condition":
      add(cfg.true_next);
      add(cfg.false_next);
      break;
    case "send_buttons":
      for (const b of (cfg.buttons as Array<{ next_node_key?: string }> | undefined) ?? []) add(b.next_node_key);
      break;
    case "send_list":
      for (const s of (cfg.sections as Array<{ rows?: Array<{ next_node_key?: string }> }> | undefined) ?? []) {
        for (const r of s.rows ?? []) add(r.next_node_key);
      }
      break;
    case "ig_comment_reply":
    case "ig_private_reply":
      add(cfg.next_node_key);
      break;
    case "send_card":
    case "send_gallery": {
      const routes = cardRouteTargets(node);
      if (routes.length) routes.forEach(add);
      else add(cfg.next_node_key);
      break;
    }
    default:
      return [];
  }
  if (waitsForReply(node) && cfg.timeout_minutes) add(cfg.after_timeout);
  return out;
}
