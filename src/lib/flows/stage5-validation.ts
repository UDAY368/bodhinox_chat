// Publish checks for the Stage 5 steps and settings (validate.ts calls
// these). Pure and client-safe, like validate.ts, so the builder shows the
// same issues the server refuses on publish. The engine (engine.ts,
// nodes/*.ts) reads the same configs and skips anything malformed at run
// time; these checks keep such a flow from going live in the first place.
import { getT } from "@/lib/i18n/translate";
import { isValidTimeZone } from "@/lib/automations/time-of-day";
import { scopeIncludes } from "@/lib/channels/capabilities";
import { randomizerPaths } from "./nodes/randomizer";
import { INSTAGRAM_LONG_WAIT_MS, dateInstant, durationMs, isSmartDelayUnit, maxWaitMs, sendWindowOf, SMART_DELAY_MAX_OFFSET_MINUTES } from "./nodes/smart-delay";
import {
  AI_GOAL_LIMITS,
  AI_GOAL_TYPES,
  AI_LEAD_FIELDS,
  FLOW_ACTION_TYPES,
  FLOW_STEP_LIMITS,
  PAUSE_MINUTES_CHOICES,
  SYSTEM_FACTS,
  type FlowChannelScope,
} from "./types";

const tFlows = getT("Validation.flows");
const tActions = getT("Flows.nodes.actions");
const tRandomizer = getT("Flows.nodes.randomizer");
const tDelay = getT("Flows.nodes.smartDelay");
const tSheets = getT("Flows.nodes.googleSheets");
const tGoals = getT("Flows.aiGoals");
const tSaveTo = getT("Flows.saveTo");

export interface Stage5Issue {
  severity: "error" | "warning";
  scope: "flow" | "trigger" | "node";
  node_key?: string;
  field?: string;
  message: string;
}

interface NodeInput {
  node_key: string;
  node_type: string;
  config: Record<string, unknown>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** workspace_attributes.key (lib/workspace/attributes.ts ATTRIBUTE_KEY, which is server-only). */
export const WORKSPACE_FIELD_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const VAR_KEY = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const NODE_KEY = /^[A-Za-z0-9_-]{1,100}$/;
const SET_VALUE_MAX = 1000;
/** Contact fields a flow may write (set_field, "save answer to"). Phone only fills a contact without one. */
export const FLOW_WRITABLE_CONTACT_FIELDS = ["name", "email", "phone", "company"] as const;

const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Where a set_field action or "save answer to" writes: a contact field or a custom field of this workspace. */
export function validSaveTarget(target: unknown, key: unknown): boolean {
  if (target === "contact_field") return (FLOW_WRITABLE_CONTACT_FIELDS as readonly unknown[]).includes(key);
  if (target === "custom_field") return isUuid(key);
  return false;
}

/** The rule an action breaks, as a message, or null when it is well formed. `flowId`: this flow (never started or stopped by itself). */
export function actionProblem(raw: unknown, flowId?: string): string | null {
  if (!raw || typeof raw !== "object") return tActions("invalid");
  const a = raw as Record<string, unknown>;
  if (!(FLOW_ACTION_TYPES as readonly unknown[]).includes(a.type)) return tActions("invalid");
  switch (a.type) {
    case "add_tag":
    case "remove_tag":
      return isUuid(a.tag_id) ? null : tFlows("setTagNeedsTag");
    case "set_field":
      if (!validSaveTarget(a.target, a.key)) return tFlows("setAttributeBadKey");
      return typeof a.value === "string" && a.value.length <= SET_VALUE_MAX ? null : tFlows("setAttributeValueTooLong", { max: SET_VALUE_MAX });
    case "set_workspace_field": {
      if (typeof a.key !== "string" || !WORKSPACE_FIELD_KEY.test(a.key)) return tFlows("setAttributeBadKey");
      if (typeof a.value !== "string" || a.value.length > SET_VALUE_MAX) return tFlows("setAttributeValueTooLong", { max: SET_VALUE_MAX });
      if (a.mode === "set") return a.value.trim() ? null : tActions("invalid");
      // An increment adds a plain decimal number (a placeholder is not allowed: it would be customer input).
      return a.mode === "increment" && /^-?\d{1,12}(\.\d{1,6})?$/.test(a.value.trim()) ? null : tActions("invalid");
    }
    case "set_channel_consent":
      return a.channel === "instagram" && (a.state === "opted_in" || a.state === "opted_out") ? null : tActions("invalid");
    case "subscribe_sequence":
    case "unsubscribe_sequence":
      return isUuid(a.sequence_id) ? null : tActions("invalid");
    case "start_flow":
    case "stop_flow":
      if (!isUuid(a.flow_id)) return tFlows("connectNeedsFlow");
      return flowId && a.flow_id.toLowerCase() === flowId.toLowerCase() ? tActions("selfFlow") : null;
    case "pause_automations":
      return (PAUSE_MINUTES_CHOICES as readonly unknown[]).includes(a.minutes) ? null : tActions("invalid");
    case "resume_automations":
      return null;
    case "log_conversion":
      return isUuid(a.event_type_id) ? null : tFlows("conversionInvalidEvent");
    case "set_conversation_status":
      return a.status === "open" || a.status === "closed" ? null : tActions("invalid");
    case "notify_team":
      if (a.target !== "assignee" && a.target !== "admins") return tActions("invalid");
      return a.note === undefined || (typeof a.note === "string" && a.note.length <= FLOW_STEP_LIMITS.notifyNoteChars) ? null : tActions("invalid");
    default:
      return tActions("invalid");
  }
}

/** A list of actions (the Actions step, or a question's actions on a valid answer). */
export function actionListIssues(nodeKey: string, field: string, raw: unknown, required: boolean, flowId?: string): Stage5Issue[] {
  const issues: Stage5Issue[] = [];
  const at = (f: string, message: string) => issues.push({ severity: "error", scope: "node", node_key: nodeKey, field: f, message });
  if (raw === undefined || raw === null) {
    if (required) at(field, tActions("empty"));
    return issues;
  }
  if (!Array.isArray(raw)) {
    at(field, tActions("invalid"));
    return issues;
  }
  if (raw.length < FLOW_STEP_LIMITS.actionsMin) {
    if (required) at(field, tActions("empty"));
    return issues;
  }
  if (raw.length > FLOW_STEP_LIMITS.actionsMax) at(field, tActions("limit", { max: FLOW_STEP_LIMITS.actionsMax }));
  raw.slice(0, FLOW_STEP_LIMITS.actionsMax).forEach((action, i) => {
    const problem = actionProblem(action, flowId);
    if (problem) at(`${field}.${i}`, problem);
  });
  return issues;
}

function nextIssue(node: NodeInput, knownKeys: ReadonlySet<string>, field: string, required: boolean): Stage5Issue[] {
  const key = node.config[field];
  if (!key) return required ? [{ severity: "error", scope: "node", node_key: node.node_key, field, message: tFlows("nodeNeedsNext") }] : [];
  if (typeof key !== "string" || !knownKeys.has(key))
    return [{ severity: "error", scope: "node", node_key: node.node_key, field, message: tFlows("nodeMissingNext", { key: String(key) }) }];
  return [];
}

export interface Stage5NodeContext {
  flowId?: string;
  channelScope?: FlowChannelScope | null;
}

/** Checks for one Stage 5 step, or for the Stage 5 settings on an older step. */
export function stage5NodeIssues(node: NodeInput, knownKeys: ReadonlySet<string>, ctx: Stage5NodeContext = {}): Stage5Issue[] {
  const cfg = node.config ?? {};
  const issues: Stage5Issue[] = [];
  const at = (field: string, message: string, severity: "error" | "warning" = "error") =>
    issues.push({ severity, scope: "node", node_key: node.node_key, field, message });
  switch (node.node_type) {
    case "actions":
      issues.push(...actionListIssues(node.node_key, "actions", cfg.actions, true, ctx.flowId));
      // The last step of a flow may be an Actions step: the run ends after it.
      issues.push(...nextIssue(node, knownKeys, "next_node_key", false));
      break;

    case "randomizer": {
      const raw = Array.isArray(cfg.paths) ? cfg.paths : [];
      const paths = randomizerPaths(cfg);
      if (paths.length !== raw.length) at("paths", tRandomizer("limit"));
      if (paths.length < FLOW_STEP_LIMITS.randomizerPathsMin || paths.length > FLOW_STEP_LIMITS.randomizerPathsMax) at("paths", tRandomizer("limit"));
      else if (paths.reduce((sum, p) => sum + p.weight, 0) !== 100) at("paths", tRandomizer("totalInvalid"));
      if (cfg.sticky !== undefined && typeof cfg.sticky !== "boolean") at("sticky", tRandomizer("limit"));
      paths.forEach((p, i) => {
        if (!p.next_node_key) at(`paths.${i}.next_node_key`, tFlows("nodeNeedsNext"));
        else if (!knownKeys.has(p.next_node_key)) at(`paths.${i}.next_node_key`, tFlows("nodeMissingNext", { key: p.next_node_key }));
      });
      break;
    }

    case "smart_delay":
      issues.push(...smartDelayIssues(node, ctx.channelScope));
      issues.push(...nextIssue(node, knownKeys, "next_node_key", true));
      break;

    case "google_sheets": {
      const op = cfg.op;
      if (op !== "insert_row" && op !== "get_row" && op !== "update_row") at("op", tSheets("invalid"));
      if (!str(cfg.spreadsheet_id).trim() || str(cfg.spreadsheet_id).length > 200 || !/^[A-Za-z0-9_-]+$/.test(str(cfg.spreadsheet_id))) at("spreadsheet_id", tSheets("invalid"));
      if (!str(cfg.sheet).trim() || str(cfg.sheet).length > 100) at("sheet", tSheets("invalid"));
      const pair = (v: unknown) => Boolean(v) && typeof v === "object" && str((v as Record<string, unknown>).column).trim() !== ""
        && str((v as Record<string, unknown>).column).length <= 100 && typeof (v as Record<string, unknown>).value === "string"
        && ((v as Record<string, unknown>).value as string).length <= SET_VALUE_MAX;
      const columns = cfg.columns;
      if (!Array.isArray(columns) || columns.length > FLOW_STEP_LIMITS.sheetColumns || !columns.every(pair)) at("columns", tSheets("invalid"));
      else if (op !== "get_row" && columns.length === 0) at("columns", tSheets("invalid"));
      if ((op === "get_row" || op === "update_row") && !pair(cfg.match)) at("match", tSheets("invalid"));
      const map = cfg.var_map;
      if (map !== undefined && (!Array.isArray(map) || map.length > FLOW_STEP_LIMITS.sheetColumns
        || !map.every((m) => m && typeof m === "object" && str((m as Record<string, unknown>).column).trim()
          && VAR_KEY.test(str((m as Record<string, unknown>).var_key))))) at("var_map", tSheets("invalid"));
      issues.push(...nextIssue(node, knownKeys, "next_node_key", true));
      issues.push(...nextIssue(node, knownKeys, "failure_next", false));
      break;
    }

    case "collect_input": {
      const saveTo = cfg.save_to;
      if (saveTo !== undefined && saveTo !== null) {
        const s = saveTo as Record<string, unknown>;
        if (typeof saveTo !== "object" || !validSaveTarget(s.target, s.key)) at("save_to", tSaveTo("label"));
      }
      issues.push(...actionListIssues(node.node_key, "on_success_actions", cfg.on_success_actions, false, ctx.flowId));
      break;
    }

    case "ai_reply":
      issues.push(...aiGoalIssues(node, knownKeys));
      break;
  }
  if (cfg.save_to !== undefined && cfg.save_to !== null && node.node_type !== "collect_input" && node.node_type !== "ai_reply") at("save_to", tSaveTo("label"));
  return issues;
}

/** The delay itself: mode, amount or date, send hours, time zone, and the Instagram 24-hour warning. */
function smartDelayIssues(node: NodeInput, scope?: FlowChannelScope | null): Stage5Issue[] {
  const cfg = node.config;
  const issues: Stage5Issue[] = [];
  const at = (field: string, message: string, severity: "error" | "warning" = "error") =>
    issues.push({ severity, scope: "node", node_key: node.node_key, field, message });
  if (cfg.mode === "duration") {
    if (cfg.amount_field_id !== undefined && cfg.amount_field_id !== "") {
      if (!isUuid(cfg.amount_field_id)) at("amount_field_id", tDelay("invalid"));
      if (!isSmartDelayUnit(cfg.unit)) at("unit", tDelay("invalid"));
    } else {
      const ms = durationMs(cfg.amount, cfg.unit);
      if (typeof cfg.amount !== "number" || !isSmartDelayUnit(cfg.unit) || cfg.amount <= 0) at("amount", tDelay("invalid"));
      else if (ms === null) at("amount", tDelay("max"));
    }
  } else if (cfg.mode === "until_date") {
    if (cfg.date_field_id !== undefined && cfg.date_field_id !== "") {
      if (!isUuid(cfg.date_field_id)) at("date_field_id", tDelay("invalid"));
    } else if (dateInstant(cfg.date, "UTC") === null) {
      at("date", tDelay("invalid"));
    }
    const offset = cfg.offset_minutes;
    if (offset !== undefined && (typeof offset !== "number" || !Number.isInteger(offset) || Math.abs(offset) > SMART_DELAY_MAX_OFFSET_MINUTES)) at("offset_minutes", tDelay("invalid"));
  } else {
    at("mode", tDelay("invalid"));
  }
  if (cfg.send_window !== undefined && cfg.send_window !== null && !sendWindowOf(cfg.send_window)) at("send_window", tDelay("invalid"));
  if (cfg.timezone !== undefined && cfg.timezone !== "" && !isValidTimeZone(cfg.timezone)) at("timezone", tFlows("conditionBadTimezone"));
  // Instagram: a long wait usually ends with the 24-hour window closed (a warning, not a block).
  if (scopeIncludes(scope, "instagram")) {
    const longest = maxWaitMs(cfg);
    if (longest === null || longest > INSTAGRAM_LONG_WAIT_MS) at("mode", tDelay("instagramWarning"), "warning");
  }
  return issues;
}

/** Goal-driven AI (Stage 5): up to three goals, a finish port, and the task list's limits. */
function aiGoalIssues(node: NodeInput, knownKeys: ReadonlySet<string>): Stage5Issue[] {
  const cfg = node.config;
  const issues: Stage5Issue[] = [];
  const at = (field: string, message: string) => issues.push({ severity: "error", scope: "node", node_key: node.node_key, field, message });
  const goals = cfg.goals;
  if (goals !== undefined && goals !== null) {
    if (!Array.isArray(goals) || goals.length > AI_GOAL_LIMITS.goals) at("goals", tGoals("limit"));
    else {
      goals.forEach((raw, i) => {
        const g = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
        if (!(AI_GOAL_TYPES as readonly unknown[]).includes(g.type)) return at(`goals.${i}`, tGoals("invalid"));
        if (g.type === "share_link" && !/^https?:\/\/[^\s]{1,2000}$/i.test(str(g.url))) at(`goals.${i}.url`, tGoals("invalid"));
        if (g.type === "capture_lead") {
          const fields = Array.isArray(g.fields) ? g.fields : [];
          const known = (f: unknown) => (AI_LEAD_FIELDS as readonly unknown[]).includes(f)
            || (typeof f === "string" && f.startsWith("custom:") && isUuid(f.slice("custom:".length)));
          if (!fields.length || fields.length > AI_GOAL_LIMITS.leadFields || !fields.every(known)) at(`goals.${i}.fields`, tGoals("invalid"));
          if (g.on_refusal !== "handoff" && g.on_refusal !== "continue") at(`goals.${i}.on_refusal`, tGoals("invalid"));
        }
      });
      if (goals.length) issues.push(...nextIssue(node, knownKeys, "finish_next", true));
    }
  }
  if (cfg.goal_text !== undefined && (typeof cfg.goal_text !== "string" || cfg.goal_text.length > AI_GOAL_LIMITS.goalTextChars)) at("goal_text", tGoals("invalid"));
  if (cfg.context !== undefined && (typeof cfg.context !== "string" || cfg.context.length > AI_GOAL_LIMITS.contextChars)) at("context", tGoals("invalid"));
  const tasks = cfg.tasks;
  if (tasks !== undefined && (!Array.isArray(tasks) || tasks.length > AI_GOAL_LIMITS.tasks || !tasks.every((task) => {
    const k = (task && typeof task === "object" ? task : {}) as Record<string, unknown>;
    const saveOk = k.save_to === undefined || (Boolean(k.save_to) && typeof k.save_to === "object"
      && validSaveTarget((k.save_to as Record<string, unknown>).target, (k.save_to as Record<string, unknown>).key));
    return typeof k.text === "string" && k.text.trim() !== "" && k.text.length <= AI_GOAL_LIMITS.taskChars && saveOk;
  }))) at("tasks", tGoals("invalid"));
  return issues;
}

/**
 * A condition rule's Stage 5 subject key: a system fact, a segment or
 * sequence id, a step of this flow, or a workspace field key. Null when fine
 * (or the subject is not a Stage 5 one).
 */
export function stage5SubjectProblem(rule: Record<string, unknown>, knownKeys: ReadonlySet<string>): string | null {
  const key = rule.subject_key;
  switch (rule.subject) {
    case "system":
      return (SYSTEM_FACTS as readonly unknown[]).includes(key) ? null : tFlows("conditionNeedsSubjectKey");
    case "segment":
    case "sequence":
      return isUuid(key) ? null : tFlows("conditionNeedsSubjectKey");
    case "link_click":
      return typeof key === "string" && NODE_KEY.test(key) && knownKeys.has(key) ? null : tFlows("conditionNeedsSubjectKey");
    case "workspace_field":
      return typeof key === "string" && WORKSPACE_FIELD_KEY.test(key) ? null : tFlows("conditionNeedsSubjectKey");
    default:
      return null;
  }
}

/** Buy buttons need the payments capability (known on the server at publish). */
export function buyButtonIssues(node: NodeInput, paymentsAvailable: boolean | undefined): Stage5Issue[] {
  if (paymentsAvailable !== false) return [];
  const cards = node.node_type === "send_card" ? [node.config.card] : node.node_type === "send_gallery" && Array.isArray(node.config.cards) ? node.config.cards : [];
  const buy = cards.some((card) => Array.isArray((card as { buttons?: unknown } | null)?.buttons)
    && (card as { buttons: Array<{ type?: unknown }> }).buttons.some((b) => b?.type === "buy"));
  return buy ? [{ severity: "error", scope: "node", node_key: node.node_key, field: node.node_type === "send_card" ? "card.buttons" : "cards",
    message: getT("Flows.buyButton")("needsPayments") }] : [];
}
