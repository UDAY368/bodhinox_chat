import { describe, expect, it } from "vitest";
import { entryTriggerTexts, messageText } from "./engine";
import { byPrecedence, orderReceivedMatch } from "./triggers";
import { validateFlowForActivation } from "./validate";
import type { FlowRow, ParsedInbound } from "./types";

const vars = { order_id: "o-1", order_total: "₹10.00", order_currency: "INR", order_items_count: "2", order_items: "2 × Cap" };
const order: ParsedInbound = { kind: "order", summary: "[Order] 2 × Cap — ₹10.00", vars, meta_message_id: "wamid.o" };

describe("order_received trigger", () => {
  it("starts with the order variables and only for a cart", () => {
    expect(orderReceivedMatch(order)).toEqual(vars);
    expect(orderReceivedMatch({ kind: "text", text: "order", meta_message_id: "m" })).toBeNull();
  });

  it("outranks every other trigger", () => {
    const flow = (id: string, trigger_type: FlowRow["trigger_type"]) =>
      ({ id, trigger_type, status: "active", created_at: "2026-01-01T00:00:00Z" }) as FlowRow;
    const sorted = byPrecedence([flow("kw", "keyword"), flow("tpl", "template_reply"), flow("first", "first_inbound_message"), flow("ord", "order_received")]);
    expect(sorted.map((f) => f.id)).toEqual(["ord", "tpl", "kw", "first"]);
  });

  it("never matches keywords, while questions still read the cart summary", () => {
    expect(entryTriggerTexts(order)).toEqual([]);
    expect(messageText(order)).toBe(order.summary);
  });

  it("needs no trigger config", () => {
    const issues = validateFlowForActivation({ name: "Orders", trigger_type: "order_received", trigger_config: {}, entry_node_id: null }, []);
    expect(issues.filter((i) => i.scope === "trigger")).toEqual([]);
  });
});
