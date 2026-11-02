import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeTables } from "./fake-db.test-helper";

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  send: vi.fn<(args: Record<string, unknown>) => Promise<{ whatsappMessageId: string; messageId: string | null }>>(
    async () => ({ whatsappMessageId: "wamid.shop", messageId: "m-shop" })),
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
vi.mock("@/lib/commerce/catalog-send", async (original) => ({
  ...(await original<typeof import("@/lib/commerce/catalog-send")>()),
  sendCommerceMessage: h.send,
}));

import { CommerceSendError } from "@/lib/commerce/catalog-send";
import { dispatchInboundToFlows } from "./engine";

function setup(nodes: Record<string, unknown>[]) {
  h.tables = {
    flows: [{ id: "f1", status: "active", created_at: "2026-01-01T00:00:00Z", account_id: "acct-1", user_id: "u-1",
      fallback_policy: {}, entry_node_id: "start", test_numbers: [], trigger_type: "keyword", trigger_config: { keywords: ["shop"] } }],
    flow_nodes: [{ flow_id: "f1", node_key: "start", node_type: "start", config: { next_node_key: "list" } }, ...nodes.map((n) => ({ flow_id: "f1", ...n }))],
    flow_runs: [], flow_run_events: [], messages: [],
    contacts: [{ id: "ct-1", account_id: "acct-1", phone: "15551234567" }],
  };
}
const dispatch = () => dispatchInboundToFlows({
  accountId: "acct-1", userId: "u-1", contactId: "ct-1", conversationId: "cv-1",
  message: { kind: "text", text: "shop", meta_message_id: "wamid.in.1" }, isFirstInboundMessage: false,
});
const events = (type: string) => h.tables.flow_run_events.filter((e) => e.event_type === type);

beforeEach(() => h.send.mockClear());

describe("catalogue flow steps", () => {
  it("sends a product list then the catalogue, each once, as the bot, and moves on", async () => {
    setup([
      { node_key: "list", node_type: "send_product_list", config: { header_text: "New in", body_text: "Hi {{vars.missing}}",
        sections: [{ title: "", product_retailer_ids: ["a", "b"] }], next_node_key: "all" } },
      { node_key: "all", node_type: "send_catalog", config: { body_text: "Everything", next_node_key: "done" } },
      { node_key: "done", node_type: "end", config: {} },
    ]);
    await dispatch();
    expect(h.send).toHaveBeenCalledTimes(2);
    const [first, second] = h.send.mock.calls.map((c) => c[0]);
    expect(first).toMatchObject({ accountId: "acct-1", sender: "bot", role: "owner", conversationId: "cv-1",
      message: { kind: "product_list", header: "New in", sections: [{ title: "", products: [{ retailerId: "a" }, { retailerId: "b" }] }] } });
    expect(String(first.intentKey)).toMatch(/^flow:.+:list:\d+:0$/);
    expect(second).toMatchObject({ message: { kind: "catalog", body: "Everything" } });
    expect(events("message_sent")).toHaveLength(2);
    expect(h.tables.flow_runs[0].status).toBe("completed");
  });

  it("fails the run with a reason code when the send is refused", async () => {
    setup([
      { node_key: "list", node_type: "send_product", config: { product_retailer_id: "gone", next_node_key: "done" } },
      { node_key: "done", node_type: "end", config: {} },
    ]);
    h.send.mockRejectedValueOnce(new CommerceSendError("product_not_found"));
    await dispatch();
    expect(h.tables.flow_runs[0].status).toBe("failed");
    const error = events("error")[0] as { payload?: Record<string, unknown> } | undefined;
    expect(error?.payload).toMatchObject({ reason: "send_product_failed", detail: "product_not_found" });
  });
});
