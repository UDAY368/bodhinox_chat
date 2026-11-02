import { describe, expect, it } from "vitest";
import { validateFlowForActivation } from "./validate";

const flow = { name: "F", trigger_type: "keyword" as const, trigger_config: { keywords: ["hi"] }, entry_node_id: "start" };
type N = { node_key: string; node_type: string; config: Record<string, unknown> };
const nodes = (config: Record<string, unknown>): N[] => [
  { node_key: "start", node_type: "start", config: { next_node_key: "tpl" } },
  { node_key: "tpl", node_type: "send_template", config: { template_name: "offer", next_node_key: "done", ...config } },
  { node_key: "done", node_type: "end", config: {} },
];
const fields = (config: Record<string, unknown>) =>
  validateFlowForActivation(flow, nodes(config))
    .filter((i) => i.severity === "error" && i.node_key === "tpl")
    .map((i) => i.field);

describe("send_template values for the new template kinds", () => {
  it("accepts a location, an offer window, a coupon and card values", () => {
    expect(fields({
      location: { latitude: "12.97", longitude: 77.59, name: "Store" },
      offer_expires_in_minutes: 120,
      coupon_code: "{{vars.code}}",
      card_params: [["{{contact.name}}"], []],
    })).toEqual([]);
  });

  it("rejects an invalid location, offer window and empty card value", () => {
    expect(fields({
      location: { latitude: "", longitude: "" },
      offer_expires_in_minutes: 0,
      card_params: [[" "]],
    })).toEqual(["location", "offer_expires_in_minutes", "card_params.0.0"]);
  });
});
