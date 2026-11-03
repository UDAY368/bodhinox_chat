/**
 * Authoring rules for the conversion_event flow step (runtime: engine.ts
 * runConversionEvent). The step reports a Conversions API event for the
 * contact's latest attributable ad click and always continues on its single
 * `next` port. It never calls Meta: the engine only queues the event
 * (lib/meta-ads/capi.ts), which is a no-op while Meta ads or CAPI are off.
 * Purchase is not a flow event: payment links and orders already report it
 * keyed by the order (order:<id>:Purchase), and a flow's own run-keyed id
 * would make Meta count the same sale twice.
 * Pure (no server imports): the validator and the editor share it.
 */

import { getT } from "@/lib/i18n/translate";
import { isCurrencyCode } from "@/lib/commerce/money";
import { CONVERSION_EVENT_NAMES, type ConversionEventName } from "./types";
import type { ValidationIssue } from "./validate";

const t = getT("Validation.flows");

const VAR_KEY = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
/** A non-negative decimal with at most 6 fraction digits. */
const DECIMAL = /^\d{1,13}(?:\.\d{1,6})?$/;
export const CONVERSION_MAX_VALUE = 1e12;

interface NodeLike {
  node_key: string;
  config: Record<string, unknown>;
}

/** The events a flow step may report: every CAPI event except Purchase (reported by payments and orders). */
export const FLOW_CONVERSION_EVENT_NAMES: readonly ConversionEventName[] =
  CONVERSION_EVENT_NAMES.filter((name) => name !== "Purchase");

export function isConversionEventName(value: unknown): value is ConversionEventName {
  return typeof value === "string" && (FLOW_CONVERSION_EVENT_NAMES as readonly string[]).includes(value);
}

const isBlank = (v: unknown) => v === undefined || v === null || v === "";

/** Problems with a conversion_event step's event, value variable, currency and port. */
export function conversionIssues(node: NodeLike, knownKeys: ReadonlySet<string>): ValidationIssue[] {
  const cfg = node.config;
  const issues: ValidationIssue[] = [];
  const at = (field: string, message: string) =>
    issues.push({ severity: "error", scope: "node", node_key: node.node_key, field, message });

  if (cfg.event_name === "Purchase") at("event_name", t("conversionPurchaseAutomatic"));
  else if (!isConversionEventName(cfg.event_name)) at("event_name", t("conversionInvalidEvent"));
  // A value is only sent with its currency, so one without the other would be dropped silently.
  if (!isBlank(cfg.value_var) && (typeof cfg.value_var !== "string" || !VAR_KEY.test(cfg.value_var))) {
    at("value_var", t("conversionInvalidValueVar"));
  } else if (isBlank(cfg.value_var) && !isBlank(cfg.currency)) {
    at("value_var", t("conversionValueNeedsBoth"));
  }
  if (!isBlank(cfg.currency) && !isCurrencyCode(cfg.currency)) {
    at("currency", t("conversionInvalidCurrency"));
  } else if (isBlank(cfg.currency) && !isBlank(cfg.value_var)) {
    at("currency", t("conversionValueNeedsBoth"));
  }
  const next = cfg.next_node_key;
  if (next === undefined || next === null || next === "") at("next_node_key", t("conversionNeedsNext"));
  else if (typeof next !== "string" || !knownKeys.has(next)) at("next_node_key", t("conversionMissingNext"));
  return issues;
}

/** Outgoing node keys of a conversion_event step. */
export function conversionEdges(config: Record<string, unknown>): string[] {
  const next = config.next_node_key;
  return typeof next === "string" && next ? [next] : [];
}

/** The event value from a run variable: a non-negative decimal up to 1e12, else undefined. */
export function conversionValue(vars: Record<string, unknown>, valueVar: unknown): number | undefined {
  if (typeof valueVar !== "string" || !valueVar) return undefined;
  const raw = vars[valueVar];
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  if (!DECIMAL.test(text)) return undefined;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 && value <= CONVERSION_MAX_VALUE ? value : undefined;
}
