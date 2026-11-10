import { beforeEach, describe, expect, it, vi } from "vitest";

// Phase 11: flows on Instagram conversations. Drives the real
// dispatchInboundToFlows against a fake data client (same shape as
// dispatch.test.ts) to prove: the flow's channel_scope decides which
// conversations it starts on; an Instagram run sends through the Instagram
// sender, refuses before any outbound intent when it cannot send, and a step
// Instagram cannot run never reaches a WhatsApp sender.

const h = vi.hoisted(() => ({
  state: {
    activeRuns: [] as unknown[],
    flows: [] as unknown[],
    nodes: [] as unknown[],
    inserted: [] as { table: string; row: Record<string, unknown> }[],
    updates: [] as { table: string; row: Record<string, unknown> }[],
    insertedRun: null as Record<string, unknown> | null,
    conversation: { channel: "whatsapp" as string, whatsapp_config_id: null as string | null },
    /** The conversation channel lookup fails once a run is active (audit #48). */
    channelLookupFails: false,
    /** Only a newly inserted run's channel lookup fails (a Connect Flow target, audit #48). */
    newRunChannelLookupFails: false,
    /** Every .in() filter a query applied, by table (Stage 1: findEntryFlow reads one channel's flows). */
    inFilters: [] as { table: string; column: string; values: unknown[] }[],
    /** Every conversation lookup fails. */
    conversationLookupFails: false,
  },
  dispatch: vi.fn(async (_account: string, _key: string, send: () => Promise<unknown>) => send()),
  waText: vi.fn(async () => ({ whatsapp_message_id: "wamid.1" })),
  waTemplate: vi.fn(async () => ({ whatsapp_message_id: "wamid.t" })),
  igText: vi.fn(async () => ({ messageId: "mid.1", recipientId: "9001" })),
  igChoices: vi.fn(async () => ({ messageId: "mid.2", recipientId: "9001" })),
  igStore: vi.fn<(tx: unknown, row: Record<string, unknown>) => Promise<string | null>>(async () => "msg-1"),
  lastCustomerAt: new Date() as Date | null,
  executeRaw: vi.fn(async () => 1),
}));

vi.mock("@/lib/whatsapp/bot-pause", () => ({ botRepliesPaused: async () => false, assertBotRepliesEnabled: async () => {} }));
vi.mock("@/lib/jobs/dispatch", () => ({ dispatchOnce: h.dispatch, UncertainDispatchError: class extends Error {} }));
vi.mock("@/lib/workspace/attributes", async (original) => ({
  ...(await original<typeof import("@/lib/workspace/attributes")>()),
  workspaceValuesFor: async () => ({}),
}));
vi.mock("@/lib/webhooks/deliver", () => ({ dispatchWebhookEvent: async () => {} }));
vi.mock("@/lib/db/tenant", () => ({ withTenant: async (_c: unknown, work: (tx: unknown) => unknown) => work({ $executeRaw: h.executeRaw }) }));
vi.mock("@/lib/db/prisma", () => ({ getWorkerPrisma: () => ({}) }));
vi.mock("@/lib/automations/meta-send", () => ({ engineSendTemplate: h.waTemplate }));
vi.mock("./meta-send", () => ({
  engineSendText: h.waText,
  engineSendMedia: vi.fn(async () => ({ whatsapp_message_id: "wamid.2" })),
  engineSendInteractiveButtons: vi.fn(async () => ({ whatsapp_message_id: "wamid.3" })),
  engineSendInteractiveList: vi.fn(async () => ({ whatsapp_message_id: "wamid.4" })),
}));
vi.mock("@/lib/channels/sender", async (original) => ({
  ...(await original<typeof import("@/lib/channels/sender")>()),
  loadInstagramTarget: async (_tx: unknown, accountId: string, conversationId: string) => ({
    accountId, conversationId, contactId: "ct-1", instagramAccountId: "ig-acct", igUserId: "17841400000000001",
    igsid: "9001", accessTokenEnc: "enc", scopes: [], lastCustomerAt: h.lastCustomerAt,
  }),
  sendInstagramText: h.igText,
  sendInstagramChoices: h.igChoices,
  storeInstagramSentMessage: h.igStore,
}));

vi.mock("./admin-client", () => {
  function rows(table: string): unknown[] {
    if (table === "flow_runs") return h.state.activeRuns;
    if (table === "flows") return h.state.flows;
    if (table === "flow_nodes") return h.state.nodes;
    if (table === "conversations") return [{ id: "cv-1", account_id: "acct-1", contact_id: "ct-1", ...h.state.conversation }];
    if (table === "contacts") return [{ id: "ct-1", account_id: "acct-1" }];
    return [];
  }
  function builder(table: string) {
    const b: Record<string, unknown> = {
      select: () => b, eq: () => b, neq: () => b, is: () => b, filter: () => b, order: () => b, limit: () => b,
      in: (column: string, values: unknown[]) => { h.state.inFilters.push({ table, column, values }); return b; },
      update: (row: Record<string, unknown>) => { h.state.updates.push({ table, row }); return b; },
      insert: (row: Record<string, unknown>) => {
        h.state.inserted.push({ table, row });
        if (table === "flow_runs") h.state.insertedRun = { id: "run-1", vars: {}, reprompt_count: 0, transition_seq: 0, ...row };
        return b;
      },
      maybeSingle: async () => {
        if (table === "conversations" && h.state.conversationLookupFails) return { data: null, error: { message: "connection reset" } };
        if (table === "conversations" && h.state.channelLookupFails && (h.state.insertedRun || h.state.activeRuns.length))
          return { data: null, error: { message: "connection reset" } };
        if (table === "conversations" && h.state.newRunChannelLookupFails && h.state.insertedRun)
          return { data: null, error: { message: "connection reset" } };
        return { data: table === "flow_runs" ? h.state.insertedRun : (rows(table)[0] ?? null), error: null };
      },
      single: async () => ({ data: rows(table)[0] ?? null, error: null }),
      then: (resolve: (r: { data: unknown[]; error: null; count: number }) => unknown) => resolve({ data: rows(table), error: null, count: 0 }),
    };
    return b;
  }
  return { databaseAdmin: () => ({ from: (t: string) => builder(t), rpc: () => Promise.resolve({ error: null }) }) };
});

import { dispatchInboundToFlows, flowListensOnConversation, startFlowById } from "./engine";

const FLOW = {
  id: "flow-1", account_id: "acct-1", user_id: "u-1", status: "active", trigger_type: "keyword",
  trigger_config: { keywords: ["hi"] }, entry_node_id: "start", created_at: "2026-01-01T00:00:00Z",
};
const node = (node_key: string, node_type: string, config: Record<string, unknown>) =>
  ({ id: node_key, flow_id: "flow-1", node_key, node_type, config });
const SEND_NODES = [
  node("start", "start", { next_node_key: "greet" }),
  node("greet", "send_message", { text: "Hello", next_node_key: "done" }),
  node("done", "end", {}),
];

const dispatch = () => dispatchInboundToFlows({
  accountId: "acct-1", userId: "u-1", contactId: "ct-1", conversationId: "cv-1",
  message: { kind: "text", text: "hi", meta_message_id: "m1" }, isFirstInboundMessage: false,
});
const runs = () => h.state.inserted.filter((i) => i.table === "flow_runs");
const events = () => h.state.inserted.filter((i) => i.table === "flow_run_events").map((i) => i.row);
const ENV = {
  INSTAGRAM_ENABLED: "true", INSTAGRAM_APP_ID: "123456", INSTAGRAM_APP_SECRET: "s3cret",
  INSTAGRAM_WEBHOOK_VERIFY_TOKEN: "verify", APP_URL: "https://app.example.test",
};

beforeEach(() => {
  h.state.activeRuns = [];
  h.state.flows = [];
  h.state.nodes = SEND_NODES;
  h.state.inserted = [];
  h.state.updates = [];
  h.state.insertedRun = null;
  h.state.channelLookupFails = false;
  h.state.newRunChannelLookupFails = false;
  h.state.inFilters = [];
  h.state.conversationLookupFails = false;
  h.state.conversation = { channel: "whatsapp", whatsapp_config_id: null };
  h.lastCustomerAt = new Date();
  for (const fn of [h.dispatch, h.waText, h.waTemplate, h.igText, h.igChoices, h.igStore, h.executeRaw]) fn.mockClear();
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
});

describe("flowListensOnConversation", () => {
  const wa = { channel: "whatsapp" as const, whatsappConfigId: "num-1" };
  const ig = { channel: "instagram" as const, whatsappConfigId: null };
  it("matches the flow's channel scope; an absent scope is WhatsApp", () => {
    expect(flowListensOnConversation({ trigger_type: "keyword" }, wa)).toBe(true);
    expect(flowListensOnConversation({ trigger_type: "keyword" }, ig)).toBe(false);
    expect(flowListensOnConversation({ trigger_type: "keyword", channel_scope: "whatsapp" }, ig)).toBe(false);
    expect(flowListensOnConversation({ trigger_type: "keyword", channel_scope: "instagram" }, wa)).toBe(false);
    expect(flowListensOnConversation({ trigger_type: "keyword", channel_scope: "instagram" }, ig)).toBe(true);
    expect(flowListensOnConversation({ trigger_type: "keyword", channel_scope: "any" }, ig)).toBe(true);
    expect(flowListensOnConversation({ trigger_type: "keyword", channel_scope: "any" }, wa)).toBe(true);
  });
  it("keeps the number tie on WhatsApp and ignores it on Instagram", () => {
    expect(flowListensOnConversation({ trigger_type: "keyword", whatsapp_config_id: "num-2" }, wa)).toBe(false);
    expect(flowListensOnConversation({ trigger_type: "keyword", channel_scope: "any", whatsapp_config_id: "num-2" }, ig)).toBe(true);
  });
  it("never starts a WhatsApp-only trigger on Instagram", () => {
    for (const trigger_type of ["template_reply", "order_received", "ad_click"] as const)
      expect(flowListensOnConversation({ trigger_type, channel_scope: "any" }, ig)).toBe(false);
  });
});

describe("findEntryFlow reads only the conversation channel's flows (Stage 1)", () => {
  const flowFilters = () => h.state.inFilters.filter((f) => f.table === "flows");
  it("filters both the live and the testing query to the channel plus legacy 'any' flows", async () => {
    h.state.flows = [{ ...FLOW, channel_scope: "whatsapp" }];
    await dispatch();
    expect(flowFilters()).toEqual([
      { table: "flows", column: "channel_scope", values: ["whatsapp", "any"] },
      { table: "flows", column: "channel_scope", values: ["whatsapp", "any"] },
    ]);
    h.state.inFilters = [];
    h.state.conversation = { channel: "instagram", whatsapp_config_id: null };
    await dispatch();
    expect(flowFilters().map((f) => f.values)).toEqual([["instagram", "any"], ["instagram", "any"]]);
  });

  it("treats a conversation with no channel as WhatsApp", async () => {
    h.state.conversation = { channel: null as unknown as string, whatsapp_config_id: null };
    h.state.flows = [{ ...FLOW, channel_scope: "whatsapp" }];
    await dispatch();
    expect(flowFilters()[0].values).toEqual(["whatsapp", "any"]);
    expect(runs()).toHaveLength(1);
  });

  it("starts nothing and reads no flow when the conversation lookup fails", async () => {
    h.state.conversationLookupFails = true;
    h.state.flows = [{ ...FLOW, channel_scope: "whatsapp" }];
    expect((await dispatch()).outcome).toBe("no_match");
    expect(flowFilters()).toEqual([]);
    expect(runs()).toHaveLength(0);
  });
});

describe("dispatch by channel", () => {
  it("an Instagram conversation never starts a WhatsApp-scoped flow", async () => {
    h.state.conversation = { channel: "instagram", whatsapp_config_id: null };
    h.state.flows = [{ ...FLOW, channel_scope: "whatsapp" }];
    expect((await dispatch()).outcome).toBe("no_match");
    expect(runs()).toHaveLength(0);
  });

  it("a WhatsApp conversation never starts an Instagram-scoped flow, and still starts its own", async () => {
    h.state.flows = [{ ...FLOW, channel_scope: "instagram" }];
    expect((await dispatch()).outcome).toBe("no_match");
    h.state.flows = [{ ...FLOW, channel_scope: "whatsapp" }];
    await dispatch();
    expect(runs()).toHaveLength(1);
    expect(h.waText).toHaveBeenCalledTimes(1);
    expect(h.igText).not.toHaveBeenCalled();
  });

  it("an Instagram run sends through the Instagram sender under the step's intent key, untagged", async () => {
    h.state.conversation = { channel: "instagram", whatsapp_config_id: null };
    h.state.flows = [{ ...FLOW, channel_scope: "instagram" }];
    await dispatch();
    expect(runs()).toHaveLength(1);
    expect(h.waText).not.toHaveBeenCalled();
    expect(h.igText).toHaveBeenCalledTimes(1);
    expect((h.igText.mock.calls[0] as unknown[])[2]).toMatchObject({ sender: "automated" });
    expect(h.dispatch.mock.calls[0][1]).toBe("flow:run-1:greet:0:0");
    // Stored through the echo-safe insert (an echo stored first is replaced, never a unique-key failure).
    expect(h.igStore).toHaveBeenCalledTimes(1);
    expect(h.executeRaw).toHaveBeenCalledTimes(1); // the conversation preview, in the same transaction
    expect(h.igStore.mock.calls[0][1]).toMatchObject({ senderType: "bot", senderId: null, contentType: "text", contentText: "Hello", messageId: "mid.1" });
  });

  it("a closed window refuses before any outbound intent and fails the step visibly", async () => {
    h.state.conversation = { channel: "instagram", whatsapp_config_id: null };
    h.state.flows = [{ ...FLOW, channel_scope: "any" }];
    h.lastCustomerAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await dispatch();
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.igText).not.toHaveBeenCalled();
    expect(events()).toContainEqual(expect.objectContaining({
      event_type: "error", payload: expect.objectContaining({ reason: "send_text_failed", detail: expect.stringContaining("instagram_window_closed") }),
    }));
  });

  it("Instagram off: refuses before any intent and calls nothing", async () => {
    vi.stubEnv("INSTAGRAM_ENABLED", "false");
    h.state.conversation = { channel: "instagram", whatsapp_config_id: null };
    h.state.flows = [{ ...FLOW, channel_scope: "instagram" }];
    await dispatch();
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.igText).not.toHaveBeenCalled();
  });

  it("buttons go out as quick replies whose payload is the reply id", async () => {
    h.state.conversation = { channel: "instagram", whatsapp_config_id: null };
    h.state.flows = [{ ...FLOW, channel_scope: "instagram" }];
    h.state.nodes = [
      node("start", "start", { next_node_key: "ask" }),
      node("ask", "send_buttons", { text: "Pick", buttons: [{ reply_id: "yes", title: "Yes", next_node_key: "done" }] }),
      node("done", "end", {}),
    ];
    await dispatch();
    expect(h.igChoices).toHaveBeenCalledTimes(1);
    expect((h.igChoices.mock.calls[0] as unknown[])[2]).toEqual([{ title: "Yes", payload: "yes" }]);
  });

  it("a step Instagram cannot run takes its failure port, else hands off; WhatsApp is never called", async () => {
    h.state.conversation = { channel: "instagram", whatsapp_config_id: null };
    h.state.flows = [{ ...FLOW, channel_scope: "any" }];
    h.state.nodes = [
      node("start", "start", { next_node_key: "tpl" }),
      node("tpl", "send_template", { template_name: "promo", language: "en", next_node_key: "done" }),
      node("done", "end", {}),
    ];
    const result = await dispatch();
    expect(h.waTemplate).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(result.outcome).toBe("handed_off");
    expect(events()).toContainEqual(expect.objectContaining({ event_type: "error", payload: expect.objectContaining({ reason: "unavailable_on_channel" }) }));
    expect(h.state.updates).toContainEqual({ table: "flow_runs", row: expect.objectContaining({ status: "handed_off", end_reason: "unavailable_on_channel" }) });

    h.state.inserted = [];
    h.state.nodes = [
      node("start", "start", { next_node_key: "book" }),
      node("book", "book_appointment", { success_next: "done", unavailable_next: "sorry" }),
      node("sorry", "send_message", { text: "Book on our website", next_node_key: "done" }),
      node("done", "end", {}),
    ];
    await dispatch();
    expect(h.igText).toHaveBeenCalledTimes(1);
  });

  it("startFlowById refuses a flow whose scope excludes the conversation's channel", async () => {
    const input = { accountId: "acct-1", userId: "u-1", contactId: "ct-1", conversationId: "cv-1", flowId: "flow-1",
      message: { kind: "text" as const, text: "", meta_message_id: "explicit-1" } };
    h.state.conversation = { channel: "instagram", whatsapp_config_id: null };
    h.state.flows = [{ ...FLOW, channel_scope: "whatsapp" }];
    expect(await startFlowById(input)).toEqual({ outcome: "unavailable" });
    expect(runs()).toHaveLength(0);
  });
});

describe("an error after the run's position committed (audit #48)", () => {
  const ended = () => h.state.updates.filter((u) => u.table === "flow_runs" && u.row.status === "failed");

  it("a new run that fails mid-advance ends as failed and still consumes the inbound", async () => {
    h.state.flows = [FLOW];
    h.state.channelLookupFails = true;
    const result = await dispatch();
    expect(runs()).toHaveLength(1);
    expect(h.waText).not.toHaveBeenCalled();
    expect(result).toEqual({ consumed: true, flow_run_id: "run-1", outcome: "completed" });
    expect(ended()).toEqual([expect.objectContaining({ table: "flow_runs", row: expect.objectContaining({ end_reason: "advance_interrupted" }) })]);
    expect(events()).toContainEqual(expect.objectContaining({ event_type: "error", payload: { reason: "advance_interrupted" } }));
  });

  it("a claimed reply transition that fails mid-advance ends the run instead of letting automations answer", async () => {
    h.state.flows = [FLOW];
    h.state.nodes = [
      node("start", "start", { next_node_key: "ask" }),
      node("ask", "send_buttons", { body: "Pick", buttons: [{ reply_id: "b1", title: "One", next_node_key: "greet" }] }),
      node("greet", "send_message", { text: "Hello", next_node_key: "done" }),
      node("done", "end", {}),
    ];
    h.state.activeRuns = [{ id: "run-7", account_id: "acct-1", user_id: "u-1", flow_id: "flow-1", contact_id: "ct-1",
      conversation_id: "cv-1", status: "active", current_node_key: "ask", vars: {}, reprompt_count: 0, transition_seq: 2,
      started_at: new Date().toISOString(), last_advanced_at: new Date().toISOString() }];
    h.state.channelLookupFails = true;
    const result = await dispatchInboundToFlows({
      accountId: "acct-1", userId: "u-1", contactId: "ct-1", conversationId: "cv-1",
      message: { kind: "interactive_reply", reply_id: "b1", reply_title: "One", meta_message_id: "m2" }, isFirstInboundMessage: false,
    });
    expect(h.state.updates).toContainEqual({ table: "flow_runs", row: expect.objectContaining({ current_node_key: "greet", transition_seq: 3 }) });
    expect(h.waText).not.toHaveBeenCalled();
    expect(result).toEqual({ consumed: true, flow_run_id: "run-7", outcome: "completed" });
    expect(ended()).toEqual([expect.objectContaining({ row: expect.objectContaining({ end_reason: "advance_interrupted" }) })]);
  });

  it("a Connect Flow target that fails mid-advance is the run ended, not the already completed source run", async () => {
    h.state.flows = [FLOW];
    h.state.nodes = [
      node("start", "start", { next_node_key: "ask" }),
      node("ask", "send_buttons", { body: "Pick", buttons: [{ reply_id: "b1", title: "One", next_node_key: "conn" }] }),
      node("conn", "connect_flow", { flow_id: "flow-1" }),
    ];
    h.state.activeRuns = [{ id: "run-7", account_id: "acct-1", user_id: "u-1", flow_id: "flow-1", contact_id: "ct-1",
      conversation_id: "cv-1", status: "active", current_node_key: "ask", vars: {}, reprompt_count: 0, transition_seq: 2,
      started_at: new Date().toISOString(), last_advanced_at: new Date().toISOString() }];
    h.state.newRunChannelLookupFails = true;
    const result = await dispatchInboundToFlows({
      accountId: "acct-1", userId: "u-1", contactId: "ct-1", conversationId: "cv-1",
      message: { kind: "interactive_reply", reply_id: "b1", reply_title: "One", meta_message_id: "m3" }, isFirstInboundMessage: false,
    });
    expect(runs()).toHaveLength(1);
    expect(h.state.updates).toContainEqual({ table: "flow_runs", row: expect.objectContaining({ status: "completed", end_reason: "connect_flow" }) });
    // The target run (run-1) is the one left active on a step it never ran, so it is the one ended.
    expect(result).toEqual({ consumed: true, flow_run_id: "run-1", outcome: "completed" });
    expect(h.state.inserted).toContainEqual({ table: "flow_run_events",
      row: expect.objectContaining({ flow_run_id: "run-1", event_type: "error", payload: { reason: "advance_interrupted" } }) });
    expect(ended()).toEqual([expect.objectContaining({ row: expect.objectContaining({ end_reason: "advance_interrupted" }) })]);
  });

  it("an error before anything committed still leaves the inbound to automations", async () => {
    h.state.flows = [FLOW];
    h.state.activeRuns = [{ id: "run-8", account_id: "acct-1", user_id: "u-1", flow_id: "flow-1", contact_id: "ct-1",
      conversation_id: "cv-1", status: "active", current_node_key: "ask", vars: {}, reprompt_count: 0, transition_seq: 0,
      started_at: new Date().toISOString(), last_advanced_at: new Date().toISOString() }];
    h.state.nodes = [node("start", "start", { next_node_key: "ask" }), node("ask", "send_buttons", { body: "Pick", buttons: [] })];
    const original = h.state.updates.push.bind(h.state.updates);
    h.state.updates.push = () => { throw new Error("connection reset"); };
    try {
      expect(await dispatch()).toEqual({ consumed: false, outcome: "no_match" });
    } finally {
      h.state.updates.push = original;
    }
    expect(ended()).toEqual([]);
  });
});
