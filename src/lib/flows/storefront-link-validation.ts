/**
 * Authoring rules for the send_storefront_link flow step (runtime:
 * storefront-node.ts, dispatched by engine.ts). Continues on `next` once the
 * link is sent; on `failed_next` otherwise (an unwired failed port ends the run).
 * Pure (no server imports): the validator and the editor share it.
 */

import { getT } from "@/lib/i18n/translate";
import { STOREFRONT_LINK_LIMITS } from "./types";
import type { ValidationIssue } from "./validate";

const t = getT("Validation.flows");

/** Ports of the step, by config field. next_node_key is required. */
export const STOREFRONT_LINK_PORT_FIELDS = ["next_node_key", "failed_next"] as const;

interface NodeLike {
  node_key: string;
  config: Record<string, unknown>;
}

/** Problems with a send_storefront_link step's text, lifetime, purpose and ports. */
export function storefrontLinkIssues(node: NodeLike, knownKeys: ReadonlySet<string>): ValidationIssue[] {
  const cfg = node.config;
  const issues: ValidationIssue[] = [];
  const at = (field: string, message: string) =>
    issues.push({ severity: "error", scope: "node", node_key: node.node_key, field, message });

  if (typeof cfg.message !== "string" || !cfg.message.trim()) at("message", t("storefrontNeedsMessage"));
  else if (cfg.message.length > STOREFRONT_LINK_LIMITS.messageMax)
    at("message", t("storefrontMessageTooLong", { max: STOREFRONT_LINK_LIMITS.messageMax }));
  const ttl = cfg.ttl_hours;
  if (ttl !== undefined && ttl !== null && !(typeof ttl === "number" && Number.isInteger(ttl) &&
      ttl >= STOREFRONT_LINK_LIMITS.ttlMinHours && ttl <= STOREFRONT_LINK_LIMITS.ttlMaxHours)) {
    at("ttl_hours", t("storefrontInvalidTtl", { min: STOREFRONT_LINK_LIMITS.ttlMinHours, max: STOREFRONT_LINK_LIMITS.ttlMaxHours }));
  }
  if (cfg.purpose !== "shop" && cfg.purpose !== "status") at("purpose", t("storefrontInvalidPurpose"));
  for (const field of STOREFRONT_LINK_PORT_FIELDS) {
    const key = cfg[field];
    if (key === undefined || key === null || key === "") {
      if (field === "next_node_key") at(field, t("storefrontNeedsNext"));
    } else if (typeof key !== "string" || !knownKeys.has(key)) {
      at(field, t("nodeMissingNext", { key: String(key) }));
    }
  }
  return issues;
}

/** Outgoing node keys of a send_storefront_link step. */
export function storefrontLinkEdges(config: Record<string, unknown>): string[] {
  return STOREFRONT_LINK_PORT_FIELDS.map((field) => config[field]).filter((key): key is string => typeof key === "string" && key.length > 0);
}
