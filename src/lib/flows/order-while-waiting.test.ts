import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeTables } from "./fake-db.test-helper";

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  dispatches: new Map<string, Promise<unknown>>(),
  sendText: vi.fn<(args: { text: string }) => Promise<{ whatsapp_message_id: string }>>(async () => ({ whatsapp_message_id: "wamid.text" })),
}));

vi.mock("@/lib/whatsapp/bot-pause", () => ({ botRepliesPaused: async () => false }));
vi.mock("@/lib/jobs/dispatch", () => ({
  dispatchOnce: async (_a: string, key: string, send: () => Promise<unknown>) => {
    if (!h.dispatches.has(key)) h.dispatches.set(key, send());
    return h.dispatches.get(key);
  },
}));
vi.mock("@/lib/jobs/queue", () => ({ enqueueJob: async () => "job" }));
vi.mock("./admin-client", async () => {
  const { createFakeDb } = await import("./fake-db.test-helper");
  return { databaseAdmin: () => createFakeDb(h.tables as FakeTables) };
});
vi.mock("./meta-send", () => ({
  engineSendText: h.sendText,
  engineSendMedia: vi.fn(),
  engineSendInteractiveButtons: vi.fn(),
  engineSendInteractiveList: vi.fn(),
}));

import { dispatchInboundToFlows } from "./engine";
import type { ParsedInbound } from "./types";

const orderVars = { order_id: "o-1", order_total: "₹998.00", order_currency: "INR", order_items_count: "2", order_items: "2 × Shirt" };
const cart: ParsedInbound = { kind: "order", summary: "[Order] 2 × Shirt — ₹998.00", vars: orderVars, meta_message_id: "wamid.cart" };

function setup() {
  const flow = (id: string, trigger_type: string, trigger_config: Record<string, unknown>, created_at: string) => ({
    id, status: "active", created_at, account_id: "acct-1", user_id: "u-1", fallback_policy: {},
    entry_node_id: "start", test_numbers: [], trigger_type, trigger_config });
  h.tables = {
    flows: [flow("f-ask", "keyword", { keywords: ["shop"] }, "2026-01-01T00:00:00Z"), flow("f-order", "order_received", {}, "2026-01-02T00:00:00Z")],
    flow_nodes: [
      { flow_id: "f-ask", node_key: "start", node_type: "start", config: { next_node_key: "ask_name" } },
      { flow_id: "f-ask", node_key: "ask_name", node_type: "collect_input", config: { prompt_text: "What's your name?", var_key: "name", next_node_key: "bye" } },
      { flow_id: "f-ask", node_key: "bye", node_type: "send_message", config: { text: "Thanks {{vars.name}}, order {{vars.order_id}}", next_node_key: "done" } },
      { flow_id: "f-ask", node_key: "done", node_type: "end", config: {} },
      { flow_id: "f-order", node_key: "start", node_type: "start", config: { next_node_key: "ack" } },
      { flow_id: "f-order", node_key: "ack", node_type: "send_message", config: { text: "Got order {{vars.order_id}}", next_node_key: "done" } },
      { flow_id: "f-order", node_key: "done", node_type: "end", config: {} },
    ],
    flow_runs: [], flow_run_events: [], messages: [],
    contacts: [{ id: "ct-1", account_id: "acct-1", phone: "15551234567" }],
  };
}
const dispatch = (message: ParsedInbound) => dispatchInboundToFlows({
  accountId: "acct-1", userId: "u-1", contactId: "ct-1", conversationId: "cv-1", message, isFirstInboundMessage: false,
});

beforeEach(() => {
  h.dispatches.clear();
  h.sendText.mockClear();
  setup();
});

describe("a WhatsApp cart while a run waits on a question", () => {
  it("is never captured as the answer; the run keeps waiting with the order vars", async () => {
    await dispatch({ kind: "text", text: "shop", meta_message_id: "wamid.1" });
    expect(h.tables.flow_runs).toHaveLength(1);
    h.sendText.mockClear();

    const result = await dispatch(cart);
    expect(result).toMatchObject({ consumed: true, outcome: "waiting" });
    const run = h.tables.flow_runs[0];
    expect(run).toMatchObject({ flow_id: "f-ask", status: "active", current_node_key: "ask_name" });
    const vars = run.vars as Record<string, unknown>;
    expect(vars.name).toBeUndefined();
    expect(vars).toMatchObject(orderVars);
    // No reprompt, no fallback, and no second (order_received) run beside it.
    expect(h.sendText).not.toHaveBeenCalled();
    expect(h.tables.flow_runs).toHaveLength(1);

    // The next typed answer is captured as usual, and the order vars are still there.
    await dispatch({ kind: "text", text: "Ana", meta_message_id: "wamid.2" });
    expect(h.sendText.mock.calls.map(([a]) => a.text)).toEqual(["Thanks Ana, order o-1"]);
  });

  it("starts the order_received flow when no run is waiting", async () => {
    const result = await dispatch(cart);
    expect(result.outcome).toBe("completed");
    expect(h.tables.flow_runs[0]).toMatchObject({ flow_id: "f-order" });
    expect(h.sendText.mock.calls.map(([a]) => a.text)).toEqual(["Got order o-1"]);
  });
});
