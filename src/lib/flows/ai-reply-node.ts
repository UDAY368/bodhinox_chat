/**
 * Authoring rules for the ai_reply flow step (runtime: lib/ai/flow-reply.ts,
 * wired in engine.ts). Shared by the validator, the canvas edges, the
 * preview and the step's form, so they always agree on the ports and on
 * when the step waits for the customer.
 */

import { getT } from "@/lib/i18n/translate";
import { goalsProblem, taskLeadFields } from "@/lib/ai/goal-rules";
import { AI_GOAL_LIMITS } from "./types";
import type { ValidationIssue } from "./validate";

const t = getT("Validation.flows");
const tg = getT("Flows.aiGoals");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const AI_REPLY_LIMITS = {
  instructions: 2000,
  maxTurns: 10,
  /** Longest answer stored in vars[var_key]. */
  varValue: 4096,
} as const;

/** Ports of the step, by config field. Both are required. */
export const AI_REPLY_PORT_FIELDS = ["next_node_key", "handoff_next"] as const;

const VAR_KEY = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

interface NodeLike {
  node_key: string;
  node_type?: string;
  config: Record<string, unknown>;
}

/** Answers the step sends before moving on: 1-10, 1 when unset or invalid. */
export function aiReplyMaxTurns(config: Record<string, unknown>): number {
  const m = config.max_turns;
  return typeof m === "number" && Number.isInteger(m) && m >= 1 && m <= AI_REPLY_LIMITS.maxTurns ? m : 1;
}

/** The step waits for follow-up messages (and may time out) only with more than one turn. */
export function aiReplyWaits(config: Record<string, unknown>): boolean {
  return aiReplyMaxTurns(config) > 1;
}

/** Outgoing node keys of an ai_reply step (the timeout port is added by the caller). */
export function aiReplyEdges(config: Record<string, unknown>): string[] {
  // Stage 5 (5G): the "Goals finished" port joins the graph when it is set.
  return [...AI_REPLY_PORT_FIELDS, "finish_next" as const].map((field) => config[field])
    .filter((key): key is string => typeof key === "string" && key.length > 0);
}

/**
 * Problems with an ai_reply step. `aiConfigured` is known only on the
 * server at activation; false adds a warning (the step would always take
 * its handoff port), undefined skips the check.
 */
export function aiReplyIssues(node: NodeLike, knownKeys: ReadonlySet<string>, aiConfigured?: boolean): ValidationIssue[] {
  const cfg = node.config;
  const issues: ValidationIssue[] = [];
  const at = (field: string, message: string, severity: "error" | "warning" = "error") =>
    issues.push({ severity, scope: "node", node_key: node.node_key, field, message });

  if (cfg.instructions !== undefined && cfg.instructions !== null &&
      (typeof cfg.instructions !== "string" || cfg.instructions.length > AI_REPLY_LIMITS.instructions)) {
    at("instructions", t("aiReplyInstructionsTooLong", { max: AI_REPLY_LIMITS.instructions }));
  }
  if (cfg.use_knowledge !== undefined && cfg.use_knowledge !== null && typeof cfg.use_knowledge !== "boolean") {
    at("use_knowledge", t("aiReplyInvalidUseKnowledge"));
  }
  const turns = cfg.max_turns;
  if (turns !== undefined && turns !== null &&
      !(typeof turns === "number" && Number.isInteger(turns) && turns >= 1 && turns <= AI_REPLY_LIMITS.maxTurns)) {
    at("max_turns", t("aiReplyInvalidMaxTurns", { max: AI_REPLY_LIMITS.maxTurns }));
  }
  const threshold = cfg.confidence_threshold;
  if (threshold !== undefined && threshold !== null &&
      !(typeof threshold === "number" && Number.isFinite(threshold) && threshold >= 0 && threshold <= 1)) {
    at("confidence_threshold", t("aiReplyInvalidThreshold"));
  }
  if (cfg.var_key !== undefined && cfg.var_key !== null && cfg.var_key !== "" &&
      (typeof cfg.var_key !== "string" || !VAR_KEY.test(cfg.var_key))) {
    at("var_key", t("invalidVarKey", { key: String(cfg.var_key) }));
  }
  const port = (field: "next_node_key" | "handoff_next", needs: string) => {
    const key = cfg[field];
    if (key === undefined || key === null || key === "") at(field, t(needs));
    else if (typeof key !== "string" || !knownKeys.has(key)) at(field, t("nodeMissingNext", { key: String(key) }));
  };
  port("next_node_key", "nodeNeedsNext");
  port("handoff_next", "aiReplyNeedsHandoffNext");
  issues.push(...aiGoalIssues(node, knownKeys));
  if (aiConfigured === false) issues.push({ severity: "warning", scope: "node", node_key: node.node_key, message: t("aiReplyNotConfigured") });
  return issues;
}

/**
 * Stage 5 (5G): the AI step's goals, "Goals finished" port and editor fields
 * (goal sentence, task list with "save the reply as", context).
 */
export function aiGoalIssues(node: NodeLike, knownKeys: ReadonlySet<string>): ValidationIssue[] {
  const cfg = node.config;
  const issues: ValidationIssue[] = [];
  const at = (field: string, message: string) => issues.push({ severity: "error", scope: "node", node_key: node.node_key, field, message });
  // Tasks that save replies to fields work like a lead goal, so they need the finish port too.
  const hasGoals = (Array.isArray(cfg.goals) && cfg.goals.length > 0) || taskLeadFields(cfg.tasks).length > 0;
  if (cfg.goals !== undefined && cfg.goals !== null) {
    const problem = goalsProblem(cfg.goals);
    if (problem) at("goals", tg(`errors.${problem}`, { max: AI_GOAL_LIMITS.goals, fields: AI_GOAL_LIMITS.leadFields }));
  }
  const finish = cfg.finish_next;
  if (hasGoals) {
    if (finish === undefined || finish === null || finish === "") at("finish_next", tg("errors.needsFinish"));
    else if (typeof finish !== "string" || !knownKeys.has(finish)) at("finish_next", t("nodeMissingNext", { key: String(finish) }));
  }
  const text = (field: string, max: number) => {
    const v = cfg[field];
    if (v !== undefined && v !== null && (typeof v !== "string" || v.length > max)) at(field, tg("errors.tooLong", { max }));
  };
  text("goal_text", AI_GOAL_LIMITS.goalTextChars);
  text("context", AI_GOAL_LIMITS.contextChars);
  const tasks = cfg.tasks;
  if (tasks !== undefined && tasks !== null) {
    if (!Array.isArray(tasks) || tasks.length > AI_GOAL_LIMITS.tasks) {
      at("tasks", tg("errors.tasks", { max: AI_GOAL_LIMITS.tasks }));
    } else {
      tasks.forEach((task, i) => {
        const item = task as { text?: unknown; save_to?: { target?: unknown; key?: unknown } } | null;
        if (!item || typeof item.text !== "string" || !item.text.trim() || item.text.length > AI_GOAL_LIMITS.taskChars) {
          at(`tasks.${i}.text`, tg("errors.taskText", { max: AI_GOAL_LIMITS.taskChars }));
        }
        const save = item?.save_to;
        if (save !== undefined && save !== null && !(
          (save.target === "contact_field" && typeof save.key === "string" && ["name", "email", "phone", "company"].includes(save.key)) ||
          (save.target === "custom_field" && typeof save.key === "string" && UUID.test(save.key)))) {
          at(`tasks.${i}.save_to`, tg("errors.saveTo"));
        }
      });
    }
  }
  return issues;
}
