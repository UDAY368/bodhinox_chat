import { describe, expect, it } from "vitest";
import { commerceNodeIssues } from "./commerce-nodes";
import { validateFlowForActivation } from "./validate";
import { deriveCanvasEdges } from "./edges";
import { startPreview } from "./preview";
import type { BuilderNode } from "@/components/flows/shared";

const keys = new Set(["next"]);
const issuesFor = (node_type: string, config: Record<string, unknown>) =>
  commerceNodeIssues({ node_key: "n", node_type, config: { next_node_key: "next", ...config } }, keys).map((i) => i.field);

describe("commerceNodeIssues", () => {
  it("accepts complete steps", () => {
    expect(issuesFor("send_product", { product_retailer_id: "SKU-1" })).toEqual([]);
    expect(issuesFor("send_catalog", { body_text: "Browse our shop" })).toEqual([]);
    expect(issuesFor("send_product_list", { header_text: "New", body_text: "Pick",
      sections: [{ title: "A", product_retailer_ids: ["a"] }, { title: "B", product_retailer_ids: ["b"] }] })).toEqual([]);
  });

  it("points at the field that breaks a Meta limit", () => {
    expect(issuesFor("send_product", {})).toEqual(["product_retailer_id"]);
    expect(issuesFor("send_catalog", { body_text: "" })).toEqual(["body_text"]);
    expect(issuesFor("send_product", { product_retailer_id: "x", footer_text: "f".repeat(61) })).toEqual(["footer_text"]);
    expect(issuesFor("send_product_list", { header_text: "", body_text: "B", sections: [] })).toEqual(["header_text", "sections"]);
    expect(issuesFor("send_product_list", { header_text: "H", body_text: "B",
      sections: [{ title: "", product_retailer_ids: ["a"] }, { title: "B", product_retailer_ids: ["a"] }] }))
      .toEqual(["sections.0.title", "sections.1.product_retailer_ids"]);
    expect(issuesFor("send_product_list", { header_text: "H", body_text: "B",
      sections: [{ title: "", product_retailer_ids: Array.from({ length: 31 }, (_, i) => `r${i}`) }] })).toEqual(["sections"]);
  });

  it("needs a next step that exists", () => {
    const missing = commerceNodeIssues({ node_key: "n", node_type: "send_catalog", config: { body_text: "x", next_node_key: "gone" } }, keys);
    expect(missing.map((i) => i.field)).toEqual(["next_node_key"]);
  });
});

const nodes: BuilderNode[] = [
  { node_key: "start", node_type: "start", config: { next_node_key: "p" } },
  { node_key: "p", node_type: "send_product", config: { product_retailer_id: "SKU", body_text: "Look", next_node_key: "l" } },
  { node_key: "l", node_type: "send_product_list", config: { header_text: "H", body_text: "B", sections: [{ title: "", product_retailer_ids: ["a", "b"] }], next_node_key: "c" } },
  { node_key: "c", node_type: "send_catalog", config: { body_text: "All", next_node_key: "end" } },
  { node_key: "end", node_type: "end", config: {} },
];

it("activates a flow that chains the three steps", () => {
  const issues = validateFlowForActivation(
    { name: "Shop", trigger_type: "keyword", trigger_config: { keywords: ["shop"] }, entry_node_id: "start" },
    nodes,
  ).filter((i) => i.severity === "error");
  expect(issues).toEqual([]);
});

it("draws one next edge per step", () => {
  const edges = deriveCanvasEdges(nodes).map((e) => `${e.source}>${e.target}`);
  expect(edges).toEqual(expect.arrayContaining(["p>l", "l>c", "c>end"]));
});

it("previews the steps as bot messages without waiting", () => {
  const state = startPreview(nodes, "start");
  const bot = state.messages.filter((m) => m.from === "bot");
  expect(bot.map((m) => m.nodeKey)).toEqual(["p", "l", "c"]);
  expect(bot[1].list?.rows.map((r) => r.id)).toEqual(["a", "b"]);
  expect(state.waiting).toBeNull();
});
