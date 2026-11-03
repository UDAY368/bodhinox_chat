import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeTables } from "./fake-db.test-helper";

// A payment_link step with link_order charges the run's order. order_id is an
// ordinary variable a customer can type into, so the order must be the run
// contact's own: another customer's order is "no order" and goes to the failed port.

const OWN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FOREIGN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  orders: [] as Record<string, unknown>[],
  create: vi.fn(),
}));

vi.mock("@/lib/whatsapp/bot-pause", () => ({ botRepliesPaused: async () => false }));
vi.mock("@/lib/jobs/dispatch", () => ({
  dispatchOnce: async (_a: string, _key: string, send: () => Promise<unknown>) => send(),
  UncertainDispatchError: class extends Error {},
}));
vi.mock("@/lib/jobs/queue", () => ({ enqueueJob: async () => "job" }));
vi.mock("./admin-client", async () => {
  const { createFakeDb } = await import("./fake-db.test-helper");
  return { databaseAdmin: () => createFakeDb(h.tables as FakeTables) };
});
vi.mock("./meta-send", () => ({
  engineSendText: vi.fn(async () => ({ whatsapp_message_id: "wamid.text" })),
  engineSendMedia: vi.fn(),
  engineSendInteractiveButtons: vi.fn(),
  engineSendInteractiveList: vi.fn(),
}));
vi.mock("@/lib/db/prisma", () => ({ getWorkerPrisma: () => ({}) }));
// Answers the orders lookup like Postgres would: every equality the SQL names must hold.
vi.mock("@/lib/db/tenant", () => ({
  withTenant: (_ctx: unknown, work: (tx: unknown) => unknown) => work({
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join("?");
      if (!sql.includes("FROM orders")) return [];
      const [accountId, id, contactId] = values;
      return h.orders.filter((o) => o.account_id === accountId && o.id === id
        && (!sql.includes("contact_id=") || o.contact_id === contactId));
    },
  }),
}));
vi.mock("@/lib/payments/links", async (original) => ({
  ...(await original<typeof import("@/lib/payments/links")>()),
  createPaymentLinkRecord: h.create,
}));

import { dispatchInboundToFlows } from "./engine";

const order = (id: string, contactId: string, totalMinor: bigint) => ({
  id, account_id: "acct-1", contact_id: contactId, status: "awaiting_payment", currency: "INR",
  subtotal_minor: totalMinor, total_minor: totalMinor, amount_paid_minor: BigInt(0), priced_at: new Date("2026-11-01T00:00:00Z"),
});

function setup() {
  h.tables = {
    flows: [{ id: "f1", status: "active", created_at: "2026-01-01T00:00:00Z", account_id: "acct-1", user_id: "u-1",
      fallback_policy: {}, entry_node_id: "start", test_numbers: [], trigger_type: "keyword", trigger_config: { keywords: ["pay"] } }],
    flow_nodes: [
      { flow_id: "f1", node_key: "start", node_type: "start", config: { next_node_key: "ask" } },
      { flow_id: "f1", node_key: "ask", node_type: "collect_input", config: { prompt_text: "Order number?", var_key: "order_id", next_node_key: "pay" } },
      { flow_id: "f1", node_key: "pay", node_type: "payment_link", config: { link_order: true, message: "Pay here", expire_minutes: 60,
        paid_next: "done", failed_next: "sorry" } },
      { flow_id: "f1", node_key: "done", node_type: "end", config: {} },
      { flow_id: "f1", node_key: "sorry", node_type: "end", config: {} },
    ],
    flow_runs: [], flow_run_events: [], messages: [],
    contacts: [{ id: "ct-1", account_id: "acct-1", phone: "15551234567" }],
  };
  h.orders = [order(OWN, "ct-1", BigInt(49_950)), order(FOREIGN, "ct-2", BigInt(1_250_000))];
}

let seq = 0;
const say = (text: string) => dispatchInboundToFlows({
  accountId: "acct-1", userId: "u-1", contactId: "ct-1", conversationId: "cv-1",
  message: { kind: "text", text, meta_message_id: `wamid.in.${++seq}` }, isFirstInboundMessage: false,
});
const errors = () => h.tables.flow_run_events.filter((e) => e.event_type === "error")
  .map((e) => (e as { payload?: { reason?: string } }).payload?.reason);

beforeEach(() => {
  setup();
  h.create.mockReset().mockResolvedValue({ link: { id: "pl-1", status: "created", short_url: "https://rzp.io/l/x", expires_at: null } });
});

describe("payment_link with link_order", () => {
  it("refuses another contact's order: no link is created and the run takes the failed port", async () => {
    await say("pay");
    await say(FOREIGN);
    expect(h.create).not.toHaveBeenCalled();
    expect(errors()).toContain("payment_link_no_order");
    expect(h.tables.flow_run_events.filter((e) => e.event_type === "node_entered").map((e) => e.node_key)).toContain("sorry");
    expect(h.tables.flow_runs[0].status).toBe("completed");
  });

  it("charges the contact's own order for exactly what is due", async () => {
    await say("pay");
    await say(OWN);
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.create.mock.calls[0][0]).toMatchObject({ amountMinor: 49_950, currency: "INR", orderId: OWN, contactId: "ct-1", conversationId: "cv-1" });
    expect(errors()).toEqual([]);
  });
});
