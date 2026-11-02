/**
 * Flow catalogue steps (send_product, send_product_list, send_catalog):
 * their limits and save-time checks. Client-safe (the builder validates live),
 * so it imports nothing server-side; the send itself is lib/commerce/catalog-send.
 */

import { getT } from "@/lib/i18n/translate";

const t = getT("Validation.flows");

export const COMMERCE_NODE_TYPES = ["send_product", "send_product_list", "send_catalog"] as const;
export type CommerceNodeType = (typeof COMMERCE_NODE_TYPES)[number];

export function isCommerceNodeType(type: string): type is CommerceNodeType {
  return (COMMERCE_NODE_TYPES as readonly string[]).includes(type);
}

/** Meta's limits on catalogue messages (mirrors PRODUCT_MESSAGE_LIMITS and the interactive text caps). */
export const COMMERCE_NODE_LIMITS = {
  body: 1024,
  header: 60,
  footer: 60,
  maxProducts: 30,
  maxSections: 10,
  sectionTitle: 24,
  retailerId: 200,
} as const;

interface Issue {
  severity: "error";
  scope: "node";
  node_key: string;
  field: string;
  message: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Save-time issues for one catalogue step; the next step is checked like every single-next node. */
export function commerceNodeIssues(node: { node_key: string; node_type: string; config: Record<string, unknown> },
  knownKeys: ReadonlySet<string>): Issue[] {
  const issues: Issue[] = [];
  const at = (field: string, message: string) => issues.push({ severity: "error", scope: "node", node_key: node.node_key, field, message });
  const cfg = node.config;
  const retailerOk = (v: unknown) => str(v).trim().length > 0 && str(v).length <= COMMERCE_NODE_LIMITS.retailerId;
  const L = COMMERCE_NODE_LIMITS;

  if (str(cfg.footer_text).length > L.footer) at("footer_text", t("commerceFooterTooLong", { max: L.footer }));
  if (str(cfg.body_text).length > L.body) at("body_text", t("commerceBodyTooLong", { max: L.body }));

  if (node.node_type === "send_product") {
    if (!retailerOk(cfg.product_retailer_id)) at("product_retailer_id", t("commerceNeedsProduct"));
  } else if (node.node_type === "send_catalog") {
    if (!str(cfg.body_text).trim()) at("body_text", t("commerceNeedsBody"));
    if (cfg.thumbnail_product_retailer_id !== undefined && cfg.thumbnail_product_retailer_id !== ""
      && !retailerOk(cfg.thumbnail_product_retailer_id)) at("thumbnail_product_retailer_id", t("commerceNeedsProduct"));
  } else if (node.node_type === "send_product_list") {
    if (!str(cfg.header_text).trim()) at("header_text", t("commerceNeedsHeader"));
    else if (str(cfg.header_text).length > L.header) at("header_text", t("commerceHeaderTooLong", { max: L.header }));
    if (!str(cfg.body_text).trim()) at("body_text", t("commerceNeedsBody"));
    const sections = Array.isArray(cfg.sections) ? (cfg.sections as Array<Record<string, unknown>>) : [];
    if (sections.length < 1 || sections.length > L.maxSections) at("sections", t("commerceSectionCount", { max: L.maxSections }));
    let total = 0;
    const seen = new Set<string>();
    sections.forEach((section, i) => {
      const title = str(section?.title).trim();
      if (sections.length > 1 && !title) at(`sections.${i}.title`, t("commerceSectionNeedsTitle"));
      if (title.length > L.sectionTitle) at(`sections.${i}.title`, t("commerceSectionTitleTooLong", { max: L.sectionTitle }));
      const ids = Array.isArray(section?.product_retailer_ids) ? section.product_retailer_ids : [];
      if (!ids.length || !ids.every(retailerOk)) at(`sections.${i}.product_retailer_ids`, t("commerceNeedsProduct"));
      for (const id of ids) {
        const key = str(id).trim();
        if (key && seen.has(key)) at(`sections.${i}.product_retailer_ids`, t("commerceDuplicateProduct", { id: key }));
        seen.add(key);
      }
      total += ids.length;
    });
    if (total > L.maxProducts) at("sections", t("commerceTooManyProducts", { max: L.maxProducts }));
  }

  const next = cfg.next_node_key;
  if (!next) at("next_node_key", t("sendMessageNeedsNext"));
  else if (typeof next !== "string" || !knownKeys.has(next)) at("next_node_key", t("sendMessageMissingNext", { key: String(next) }));
  return issues;
}
