/**
 * Authoring rules for the payment_link flow step (engine: engine.ts
 * startPaymentLinkNode / resumePaymentLinkRun; links: lib/payments/links).
 * Shared by the validator and the step's form.
 */

import { getT } from "@/lib/i18n/translate";
import { isCurrencyCode, MoneyError, parseMoney } from "@/lib/commerce/money";
import type { ValidationIssue } from "./validate";

const t = getT("Validation.flows");

export const PAYMENT_LINK_LIMITS = {
  description: 2048,
  message: 900,
  /** Razorpay needs at least 15 minutes; we ask for 16 so a slow send still fits. */
  expireMinMinutes: 16,
  /** 180 days. */
  expireMaxMinutes: 259_200,
} as const;

/** Variables the step stores for the steps after it. */
export const PAYMENT_LINK_VARS = ["payment_link_url", "payment_status", "payment_link_id"] as const;

/** Ports of the step, by config field. paid_next is required; an unwired expired/failed port ends the run. */
export const PAYMENT_LINK_PORT_FIELDS = ["paid_next", "expired_next", "failed_next"] as const;

interface NodeLike {
  node_key: string;
  config: Record<string, unknown>;
}

/** Problems with a payment_link step's amount, currency, texts, expiry and ports. */
export function paymentLinkIssues(node: NodeLike, knownKeys: ReadonlySet<string>): ValidationIssue[] {
  const cfg = node.config;
  const issues: ValidationIssue[] = [];
  const at = (field: string, message: string, severity: "error" | "warning" = "error") =>
    issues.push({ severity, scope: "node", node_key: node.node_key, field, message });

  const currency = typeof cfg.currency === "string" ? cfg.currency : "";
  if (!isCurrencyCode(currency)) at("currency", t("paymentNeedsCurrency"));
  const amount = typeof cfg.amount === "string" ? cfg.amount.trim() : typeof cfg.amount === "number" ? String(cfg.amount) : "";
  if (!amount) {
    at("amount", t("paymentNeedsAmount"));
  } else if (!amount.includes("{{") && isCurrencyCode(currency)) {
    // A fixed amount is checked now; one built from variables is checked when the step runs.
    try {
      if (parseMoney(amount, currency) <= 0) at("amount", t("paymentInvalidAmount"));
    } catch (error) {
      if (!(error instanceof MoneyError)) throw error;
      at("amount", t("paymentInvalidAmount"));
    }
  }
  if (cfg.description !== undefined && cfg.description !== null && (typeof cfg.description !== "string" || cfg.description.length > PAYMENT_LINK_LIMITS.description)) {
    at("description", t("paymentTextTooLong", { max: PAYMENT_LINK_LIMITS.description }));
  }
  if (typeof cfg.message !== "string" || cfg.message.length > PAYMENT_LINK_LIMITS.message) {
    at("message", t("paymentTextTooLong", { max: PAYMENT_LINK_LIMITS.message }));
  }
  const minutes = cfg.expire_minutes;
  if (minutes !== undefined && minutes !== null &&
      !(typeof minutes === "number" && Number.isInteger(minutes) && minutes >= PAYMENT_LINK_LIMITS.expireMinMinutes && minutes <= PAYMENT_LINK_LIMITS.expireMaxMinutes)) {
    at("expire_minutes", t("paymentInvalidExpiry", { min: PAYMENT_LINK_LIMITS.expireMinMinutes, max: PAYMENT_LINK_LIMITS.expireMaxMinutes }));
  }
  for (const field of PAYMENT_LINK_PORT_FIELDS) {
    const key = cfg[field];
    if (key === undefined || key === null || key === "") {
      if (field === "paid_next") at(field, t("paymentNeedsPaidNext"));
    } else if (typeof key !== "string" || !knownKeys.has(key)) {
      at(field, t("nodeMissingNext", { key: String(key) }));
    }
  }
  return issues;
}

/** Outgoing node keys of a payment_link step (the timeout port is added by the caller). */
export function paymentLinkEdges(config: Record<string, unknown>): string[] {
  return PAYMENT_LINK_PORT_FIELDS.map((field) => config[field]).filter((key): key is string => typeof key === "string" && key.length > 0);
}
