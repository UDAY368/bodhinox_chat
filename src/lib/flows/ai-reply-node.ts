/**
 * Authoring rules for the ai_reply flow step (runtime: lib/ai/flow-reply.ts,
 * wired in engine.ts). Shared by the validator, the canvas edges, the
 * preview and the step's form, so they always agree on the ports and on
 * when the step waits for the customer.
 */

import { getT } from "@/lib/i18n/translate";
import type { ValidationIssue } from "./validate";

const t = getT("Validation.flows");

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
  return AI_REPLY_PORT_FIELDS.map((field) => config[field]).filter((key): key is string => typeof key === "string" && key.length > 0);
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
  if (aiConfigured === false) issues.push({ severity: "warning", scope: "node", node_key: node.node_key, message: t("aiReplyNotConfigured") });
  return issues;
}
