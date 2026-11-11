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
    /** The next flow_runs insert fails with this message (e.g. the one-active-run unique index). */
    runInsertError: null as string | null,
  },
  /** INSTAGRAM_SHARE_TO_STORY_ENABLED as instagramConfig() would report it. */
  shareFlag: false,
  dispatch: vi.fn(async (_account: string, _key: string, send: () => Promise<unknown>) => send()),
  waText: vi.fn(async () => ({ whatsapp_message_id: "wamid.1" })),
  waTemplate: vi.fn(async () => ({ whatsapp_message_id: "wamid.t" })),
  igText: vi.fn(async () => ({ messageId: "mid.1", recipientId: "9001" })),
  igChoices: vi.fn(async () => ({ messageId: "mid.2", recipientId: "9001" })),
  igStore: vi.fn<(tx: unknown, row: Record<string, unknown>) => Promise<string | null>>(async () => "msg-1"),
  lastCustomerAt: new Date() as Date | null,
  executeRaw: vi.fn(async () => 1),
  /** Published versions by id (Phase 12); empty unless a test publishes one. */
  versions: new Map<string, Record<string, unknown>>(),
  // Stage 2 (Instagram Phase 1).
  /** Stored messages (the story reply / mention facts are read from interactive_payload). */
  messages: [] as unknown[],
  /** The id the next inserted run gets. */
  runId: "run-1",
  /** One raw row answering every tenant query a test makes (window, starter listing, comment event). */
  rawRow: {} as Record<string, unknown>,
  igCards: vi.fn(async () => ({ messageId: "mid.3", recipientId: "9001" })),
  igButtonTemplate: vi.fn(async () => ({ messageId: "mid.4", recipientId: "9001" })),
  privateReply: vi.fn<(args: Record<string, unknown>) => Promise<string>>(async () => "sent"),
  publicReply: vi.fn<(accountId: string, eventId: string, text: string) => Promise<string>>(async () => "posted"),
  optIn: vi.fn(async () => {}),
  profile: vi.fn<() => Promise<Record<string, unknown> | null>>(async () => null),
  enqueue: vi.fn(async () => ({})),
}));

vi.mock("@/lib/instagram/private-reply", () => ({
  PRIVATE_REPLY_RETRY_MS: 600_000,
  sendCommentPrivateReply: h.privateReply,
  postCommentPublicReply: h.publicReply,
  recordCommentOptIn: h.optIn,
}));
vi.mock("@/lib/instagram/profile", () => ({ refreshProfileFacts: h.profile }));
vi.mock("@/lib/instagram/config", async (original) => {
  const real = await original<typeof import("@/lib/instagram/config")>();
  return {
    ...real,
    instagramConfig: (env?: Parameters<typeof real.instagramConfig>[0]) => (h.shareFlag ? { shareToStoryEnabled: true } as never : real.instagramConfig(env)),
  };
});
vi.mock("@/lib/jobs/queue", () => ({ enqueueJob: h.enqueue }));
vi.mock("@/lib/instagram/process-webhook", () => ({
  resolveCommentThread: async () => ({ contactId: "ct-1", conversationId: "cv-1", auditUserId: "u-1" }),
}));

vi.mock("@/lib/whatsapp/bot-pause", () => ({ botRepliesPaused: async () => false, assertBotRepliesEnabled: async () => {} }));
// Stage 5 consent gate reads the contact through its own query; these contacts never opted out.
vi.mock("@/lib/contacts/channel-consent", async (original) => ({
  ...(await original<typeof import("@/lib/contacts/channel-consent")>()),
  instagramAutomationAllowed: async () => true,
}));
vi.mock("@/lib/jobs/dispatch", () => ({ dispatchOnce: h.dispatch, UncertainDispatchError: class extends Error {} }));
vi.mock("@/lib/workspace/attributes", async (original) => ({
  ...(await original<typeof import("@/lib/workspace/attributes")>()),
  workspaceValuesFor: async () => ({}),
}));
vi.mock("@/lib/webhooks/deliver", () => ({ dispatchWebhookEvent: async () => {} }));
vi.mock("@/lib/db/tenant", () => ({ withTenant: async (_c: unknown, work: (tx: unknown) => unknown) => work({
  $executeRaw: h.executeRaw,
  // The 24-hour window check reads the last customer message (Stage 2).
  $queryRaw: async () => [{ last_customer_at: h.lastCustomerAt, ...h.rawRow }],
}) }));
vi.mock("@/lib/db/prisma", () => ({ getWorkerPrisma: () => ({}) }));
vi.mock("@/lib/automations/meta-send", () => ({ engineSendTemplate: h.waTemplate }));
vi.mock("./versions", async (original) => ({
  ...(await original<typeof import("./versions")>()),
  loadPublishedVersions: async (_account: string, ids: string[]) =>
    new Map(ids.filter((id) => h.versions.has(id)).map((id) => [id, h.versions.get(id)])),
  loadVersion: async (_account: string, id: string) => h.versions.get(id) ?? null,
}));
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
  sendInstagramCards: h.igCards,
  sendInstagramButtonTemplate: h.igButtonTemplate,
  storeInstagramSentMessage: h.igStore,
}));

vi.mock("./admin-client", () => {
  function rows(table: string): unknown[] {
    if (table === "flow_runs") return h.state.activeRuns;
    if (table === "flows") return h.state.flows;
    if (table === "flow_nodes") return h.state.nodes;
    if (table === "conversations") return [{ id: "cv-1", account_id: "acct-1", contact_id: "ct-1", ...h.state.conversation }];
    if (table === "contacts") return [{ id: "ct-1", account_id: "acct-1" }];
    if (table === "messages") return h.messages;
    return [];
  }
  function builder(table: string) {
    // .in() narrows flows rows as the database would (channel_scope is NOT NULL DEFAULT 'whatsapp').
    const narrow: ((row: Record<string, unknown>) => boolean)[] = [];
    const matching = () => table !== "flows" ? rows(table)
      : (rows(table) as Record<string, unknown>[]).filter((row) => narrow.every((keep) => keep(row)));
    let insertFailed: string | null = null;
    const b: Record<string, unknown> = {
      select: () => b, eq: () => b, neq: () => b, is: () => b, filter: () => b, order: () => b, limit: () => b, gte: () => b,
      in: (column: string, values: unknown[]) => {
        h.state.inFilters.push({ table, column, values });
        narrow.push((row) => values.includes(row[column] ?? (column === "channel_scope" ? "whatsapp" : undefined)));
        return b;
      },
      update: (row: Record<string, unknown>) => { h.state.updates.push({ table, row }); return b; },
      insert: (row: Record<string, unknown>) => {
        h.state.inserted.push({ table, row });
        if (table === "flow_runs" && h.state.runInsertError) {
          insertFailed = h.state.runInsertError;
          h.state.runInsertError = null;
          return b;
        }
        if (table === "flow_runs") h.state.insertedRun = { id: h.runId, vars: {}, reprompt_count: 0, transition_seq: 0, ...row };
        return b;
      },
      maybeSingle: async () => {
        if (insertFailed) return { data: null, error: { message: insertFailed } };
        if (table === "conversations" && h.state.conversationLookupFails) return { data: null, error: { message: "connection reset" } };
        if (table === "conversations" && h.state.channelLookupFails && (h.state.insertedRun || h.state.activeRuns.length))
          return { data: null, error: { message: "connection reset" } };
        if (table === "conversations" && h.state.newRunChannelLookupFails && h.state.insertedRun)
          return { data: null, error: { message: "connection reset" } };
        return { data: table === "flow_runs" ? h.state.insertedRun : (matching()[0] ?? null), error: null };
      },
      single: async () => ({ data: matching()[0] ?? null, error: null }),
      then: (resolve: (r: { data: unknown[]; error: null; count: number }) => unknown) => resolve({ data: matching(), error: null, count: 0 }),
    };
    return b;
  }
  return { databaseAdmin: () => ({ from: (t: string) => builder(t), rpc: () => Promise.resolve({ error: null }) }) };
});

import { dispatchInboundToFlows, flowListensOnConversation, igProfileValue, matchReplyId, startCommentFlow, startFlowById } from "./engine";

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
  h.shareFlag = false;
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
  h.state.runInsertError = null;
  h.versions.clear();
  h.state.conversation = { channel: "whatsapp", whatsapp_config_id: null };
  h.lastCustomerAt = new Date();
  for (const fn of [h.dispatch, h.waText, h.waTemplate, h.igText, h.igChoices, h.igStore, h.executeRaw, h.igCards, h.igButtonTemplate,
    h.privateReply, h.publicReply, h.optIn, h.profile, h.enqueue]) fn.mockClear();
  h.messages = [];
  h.runId = "run-1";
  h.rawRow = {};
  h.privateReply.mockResolvedValue("sent");
  h.profile.mockResolvedValue(null);
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
    for (const trigger_type of ["template_reply", "order_received"] as const)
      expect(flowListensOnConversation({ trigger_type, channel_scope: "any" }, ig)).toBe(false);
    // Stage 3: click-to-Direct ads start ad_click flows on Instagram too.
    expect(flowListensOnConversation({ trigger_type: "ad_click", channel_scope: "instagram" }, ig)).toBe(true);
  });
});

describe("findEntryFlow channel filter (Stage 1)", () => {
  const flowFilters = () => h.state.inFilters.filter((f) => f.table === "flows");
  it("filters the testing-draft query to the channel plus legacy 'any' flows", async () => {
    h.state.flows = [{ ...FLOW, channel_scope: "whatsapp" }];
    await dispatch();
    expect(flowFilters()).toEqual([{ table: "flows", column: "channel_scope", values: ["whatsapp", "any"] }]);
    h.state.inFilters = [];
    h.state.conversation = { channel: "instagram", whatsapp_config_id: null };
    await dispatch();
    // Stage 5: Instagram also reads the drafts tested by username, narrowed the same way.
    expect(flowFilters().map((f) => f.values)).toEqual([["instagram", "any"], ["instagram", "any"]]);
  });

  // A published flow runs its version's scope. Before Stage 1 locked published
  // scopes, the builder could move a live flow's draft row to another channel
  // without republishing: the live WhatsApp version must keep running.
  const VERSION = {
    id: "ver-1", account_id: "acct-1", flow_id: "flow-1", version: 1, trigger_type: "keyword",
    trigger_config: { keywords: ["hi"] }, entry_node_id: "start", fallback_policy: {},
    nodes: SEND_NODES.map(({ node_key, node_type, config }) => ({ node_key, node_type, config })),
    published_by: null, published_at: "2026-01-01T00:00:00Z",
  };
  it("keeps a live WhatsApp version running when its draft row was moved to Instagram", async () => {
    h.versions.set("ver-1", { ...VERSION, channel_scope: "whatsapp" });
    h.state.flows = [{ ...FLOW, channel_scope: "instagram", published_version_id: "ver-1" }];
    await dispatch();
    expect(runs()).toHaveLength(1);
    expect(runs()[0].row.flow_version_id).toBe("ver-1");
  });

  it("never starts a live Instagram version on WhatsApp, whatever its draft row says", async () => {
    h.versions.set("ver-1", { ...VERSION, channel_scope: "instagram" });
    h.state.flows = [{ ...FLOW, channel_scope: "whatsapp", published_version_id: "ver-1" }];
    expect((await dispatch()).outcome).toBe("no_match");
    expect(runs()).toHaveLength(0);
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

  it("a closed window ends the run with window_closed before any outbound intent (Stage 2)", async () => {
    h.state.conversation = { channel: "instagram", whatsapp_config_id: null };
    h.state.flows = [{ ...FLOW, channel_scope: "any" }];
    h.lastCustomerAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await dispatch();
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.igText).not.toHaveBeenCalled();
    expect(events()).toContainEqual(expect.objectContaining({
      event_type: "error", payload: expect.objectContaining({ reason: "window_closed", node_type: "send_message" }),
    }));
    expect(h.state.updates).toContainEqual({ table: "flow_runs", row: expect.objectContaining({ status: "cancelled", end_reason: "window_closed" }) });
  });

  it("a WhatsApp run never checks the Instagram window", async () => {
    h.state.flows = [FLOW];
    h.lastCustomerAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await dispatch();
    expect(h.waText).toHaveBeenCalledTimes(1);
    expect(events()).not.toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ reason: "window_closed" }) }));
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

describe("Instagram Phase 1 engine (Stage 2C)", () => {
  const RUN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const EVENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const STARTER_FLOW = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const igFlow = (over: Record<string, unknown>) => ({ ...FLOW, channel_scope: "instagram", ...over });
  const inbound = (message: Record<string, unknown>) => dispatchInboundToFlows({
    accountId: "acct-1", userId: "u-1", contactId: "ct-1", conversationId: "cv-1",
    message: { meta_message_id: "m-ig", ...message } as never, isFirstInboundMessage: false,
  });
  const COMMENT_NODES = [
    node("start", "start", { next_node_key: "reply" }),
    node("reply", "ig_comment_reply", { replies: ["Check your DMs!"], next_node_key: "pr" }),
    node("pr", "ig_private_reply", { text: "Want the link?", opt_in_label: "Send it", next_node_key: "link" }),
    node("link", "send_message", { text: "https://shop.example/x", next_node_key: "done" }),
    node("done", "end", {}),
  ];
  const activeAt = (current: string, vars: Record<string, unknown> = {}) => [{ id: RUN, account_id: "acct-1", user_id: "u-1",
    flow_id: "flow-1", contact_id: "ct-1", conversation_id: "cv-1", status: "active", current_node_key: current, vars,
    reprompt_count: 0, transition_seq: 1, started_at: new Date().toISOString(), last_advanced_at: new Date().toISOString() }];

  beforeEach(() => {
    h.state.conversation = { channel: "instagram", whatsapp_config_id: null };
  });

  it("a story reply starts the story flow (any story, any reply); plain text does not", async () => {
    h.state.flows = [igFlow({ trigger_type: "ig_story_reply", trigger_config: {} })];
    await inbound({ kind: "text", text: "love this" });
    expect(runs()).toHaveLength(0);
    h.messages = [{ interactive_payload: { ig: { story: true, story_id: "18011" } } }];
    await inbound({ kind: "text", text: "love this" });
    expect(runs()).toHaveLength(1);
    expect(h.igText).toHaveBeenCalledTimes(1);
  });

  it("an emoji reaction to a story starts the flow only when reactions are on; story ids narrow it", async () => {
    h.messages = [{ interactive_payload: { ig: { story: true, story_id: "18011", reaction: true } } }];
    h.state.flows = [igFlow({ trigger_type: "ig_story_reply", trigger_config: { keywords: ["price"] } })];
    await inbound({ kind: "text", text: "\u{1F525}" });
    expect(runs()).toHaveLength(0);
    h.state.flows = [igFlow({ trigger_type: "ig_story_reply", trigger_config: { reactions: true, story_ids: ["999"] } })];
    await inbound({ kind: "text", text: "\u{1F525}" });
    expect(runs()).toHaveLength(0);
    h.state.flows = [igFlow({ trigger_type: "ig_story_reply", trigger_config: { reactions: true, story_ids: ["18011"] } })];
    await inbound({ kind: "text", text: "\u{1F525}" });
    expect(runs()).toHaveLength(1);
  });

  it("a story mention starts the mention flow, and never the default reply", async () => {
    h.messages = [{ interactive_payload: { ig: { story_mention: true } } }];
    h.state.flows = [igFlow({ id: "flow-d", trigger_type: "default_reply", trigger_config: { frequency: "every_time" } })];
    await inbound({ kind: "text", text: "" });
    expect(runs()).toHaveLength(0);
    h.state.flows = [igFlow({ trigger_type: "ig_story_mention", trigger_config: { frequency: "every_time" } })];
    await inbound({ kind: "text", text: "" });
    expect(runs()).toHaveLength(1);
  });

  it("a share to story starts its flow only while the flag is on, never the default reply, and not for another account", async () => {
    h.messages = [{ interactive_payload: { ig: { share_to_story: true, url: "https://cdn.example/p" } } }];
    h.state.flows = [
      igFlow({ id: "flow-d", trigger_type: "default_reply", trigger_config: { frequency: "every_time" } }),
      igFlow({ id: "flow-s", trigger_type: "ig_share_to_story", trigger_config: { frequency: "every_time" } }),
    ];
    await inbound({ kind: "text", text: "" });
    // Flag off: the share flow stays dark and the default reply behaves as before Stage 4.
    expect(runs().map((r) => r.row.flow_id)).toEqual(["flow-d"]);
    h.state.activeRuns = [];
    h.state.inserted = [];
    h.shareFlag = true;
    h.state.flows = [igFlow({ id: "flow-s", trigger_type: "ig_share_to_story", trigger_config: { frequency: "every_time", instagram_account_id: "00000000-0000-4000-8000-0000000000ff" } })];
    await inbound({ kind: "text", text: "" });
    expect(runs()).toHaveLength(0);
    h.state.flows = [igFlow({ id: "flow-s", trigger_type: "ig_share_to_story", trigger_config: { frequency: "every_time" } })];
    await inbound({ kind: "text", text: "" });
    expect(runs()).toHaveLength(1);
    expect(runs()[0].row.flow_id).toBe("flow-s");
  });

  it("the default reply runs only when no other flow matched, on WhatsApp too", async () => {
    h.state.flows = [
      igFlow({ id: "flow-d", trigger_type: "default_reply", trigger_config: {}, created_at: "2025-01-01T00:00:00Z" }),
      igFlow({ id: "flow-k", trigger_type: "keyword", trigger_config: { keywords: ["price"] } }),
    ];
    await inbound({ kind: "text", text: "price?" });
    expect(runs()[0].row.flow_id).toBe("flow-k");
    h.state.inserted = [];
    h.state.insertedRun = null;
    await inbound({ kind: "text", text: "hello" });
    expect(runs()[0].row.flow_id).toBe("flow-d");
    h.state.inserted = [];
    h.state.insertedRun = null;
    h.state.conversation = { channel: "whatsapp", whatsapp_config_id: null };
    h.state.flows = [{ ...FLOW, id: "flow-w", trigger_type: "default_reply", trigger_config: {} }];
    await dispatch();
    expect(runs()[0].row.flow_id).toBe("flow-w");
    expect(h.waText).toHaveBeenCalledTimes(1);
  });

  it("a conversation starter tap starts its listed flow; an unlisted one starts nothing", async () => {
    h.state.flows = [igFlow({ id: STARTER_FLOW, trigger_type: "manual", trigger_config: {} })];
    h.rawRow = { listed: false };
    await inbound({ kind: "interactive_reply", reply_id: `ib:${STARTER_FLOW}`, reply_title: "Opening hours?" });
    expect(runs()).toHaveLength(0);
    h.rawRow = { listed: true };
    const result = await inbound({ kind: "interactive_reply", reply_id: `ib:${STARTER_FLOW}`, reply_title: "Opening hours?" });
    expect(result.consumed).toBe(true);
    expect(runs()).toHaveLength(1);
    expect(runs()[0].row.flow_id).toBe(STARTER_FLOW);
  });

  it("a comment starts its flow: public reply once, then the private reply with an opening button, then waits", async () => {
    h.runId = RUN;
    h.state.flows = [igFlow({ trigger_type: "ig_comment", trigger_config: { post_scope: "any", public_replies: ["Sent you a DM"] } })];
    h.state.nodes = COMMENT_NODES;
    h.rawRow = { comment_id: "18000000001", media_id: "1700", from_igsid: "9001", instagram_account_id: "ig-acct", status: "queued", flow_run_id: null };
    expect(await startCommentFlow({ accountId: "acct-1", eventId: EVENT, flowId: "flow-1" })).toBe("started");
    expect(runs()).toHaveLength(1);
    expect(runs()[0].row.vars).toEqual({ ig_comment_event_id: EVENT, ig_comment_id: "18000000001", ig_media_id: "1700" });
    // The event is linked to the run (compare-and-set) before anything is sent.
    expect((h.executeRaw.mock.calls as unknown as string[][][]).some((c) => c[0].join("?").includes("SET flow_run_id"))).toBe(true);
    // Trigger reply and the step reply share one per-comment key in private-reply.ts.
    expect(h.publicReply).toHaveBeenCalledWith("acct-1", EVENT, "Sent you a DM");
    expect(h.publicReply).toHaveBeenCalledWith("acct-1", EVENT, "Check your DMs!");
    expect(h.privateReply).toHaveBeenCalledTimes(1);
    expect(h.privateReply.mock.calls[0][0]).toMatchObject({ eventId: EVENT, runId: RUN, text: "Want the link?",
      quickReplies: [{ title: "Send it", payload: `optin:${RUN}:pr` }] });
    // Nothing else goes out until the tap.
    expect(h.igText).not.toHaveBeenCalled();
    expect(h.state.updates).toContainEqual({ table: "flow_runs", row: expect.objectContaining({ current_node_key: "pr" }) });
  });

  it("a comment already taken or a busy conversation starts nothing", async () => {
    h.state.flows = [igFlow({ trigger_type: "ig_comment", trigger_config: { post_scope: "any" } })];
    h.state.nodes = COMMENT_NODES;
    h.rawRow = { comment_id: "1", media_id: null, from_igsid: "9001", instagram_account_id: "ig-acct", status: "sent", flow_run_id: null };
    expect(await startCommentFlow({ accountId: "acct-1", eventId: EVENT, flowId: "flow-1" })).toBe("unavailable");
    h.rawRow = { comment_id: "1", media_id: null, from_igsid: "9001", instagram_account_id: "ig-acct", status: "queued", flow_run_id: null };
    h.state.flows = [igFlow({ trigger_type: "keyword", trigger_config: { keywords: ["x"] } })];
    expect(await startCommentFlow({ accountId: "acct-1", eventId: EVENT, flowId: "flow-1" })).toBe("unavailable");
    expect(runs()).toHaveLength(0);
    expect(h.privateReply).not.toHaveBeenCalled();
  });

  it("a busy conversation starts nothing; a crashed job's own unlinked run is linked and carried on once", async () => {
    const DUPLICATE = 'duplicate key value violates unique constraint "idx_one_active_run_per_conversation" (23505)';
    h.state.flows = [igFlow({ trigger_type: "ig_comment", trigger_config: { post_scope: "any" } })];
    h.state.nodes = COMMENT_NODES;
    h.rawRow = { comment_id: "18000000001", media_id: "1700", from_igsid: "9001", instagram_account_id: "ig-acct", status: "queued", flow_run_id: null };
    const linkCalls = () => (h.executeRaw.mock.calls as unknown as string[][][]).filter((c) => c[0].join("?").includes("SET flow_run_id"));

    // Another flow's run holds the conversation: nothing is linked or sent.
    h.state.activeRuns = activeAt("ask", {});
    h.state.runInsertError = DUPLICATE;
    expect(await startCommentFlow({ accountId: "acct-1", eventId: EVENT, flowId: "flow-1" })).toBe("busy");
    expect(linkCalls()).toHaveLength(0);
    expect(h.privateReply).not.toHaveBeenCalled();
    expect(h.publicReply).not.toHaveBeenCalled();

    // The run this comment's earlier attempt inserted (still at its entry, never linked): linked, then carried on.
    const orphan = { ...activeAt("start", { ig_comment_event_id: EVENT, ig_comment_id: "18000000001" })[0], transition_seq: 0 };
    h.state.activeRuns = [orphan];
    h.state.insertedRun = orphan;
    h.state.runInsertError = DUPLICATE;
    expect(await startCommentFlow({ accountId: "acct-1", eventId: EVENT, flowId: "flow-1" })).toBe("started");
    expect(linkCalls()).toHaveLength(1);
    expect((linkCalls()[0] as unknown[]).slice(1)).toContain(RUN);
    expect(h.privateReply).toHaveBeenCalledTimes(1);
    expect(h.privateReply.mock.calls[0][0]).toMatchObject({ eventId: EVENT, runId: RUN });
  });

  it("the opening-button tap resumes the run and opens the window; a tap for another run changes nothing", async () => {
    h.state.flows = [igFlow({ trigger_type: "ig_comment", trigger_config: { post_scope: "any" } })];
    h.state.nodes = COMMENT_NODES;
    h.state.activeRuns = activeAt("pr", { ig_comment_event_id: EVENT, ig_comment_id: "18000000001" });
    const stale = await inbound({ kind: "interactive_reply", reply_id: `optin:${STARTER_FLOW}:pr`, reply_title: "Send it" });
    expect(stale).toMatchObject({ consumed: true, outcome: "waiting" });
    expect(h.igText).not.toHaveBeenCalled();
    const tapped = await inbound({ kind: "interactive_reply", reply_id: `optin:${RUN}:pr`, reply_title: "Send it", meta_message_id: "m-tap" });
    expect(tapped.consumed).toBe(true);
    expect(h.optIn).toHaveBeenCalledWith("acct-1", EVENT, RUN);
    expect(h.igText).toHaveBeenCalledTimes(1);
    expect(h.state.updates).toContainEqual({ table: "flow_runs", row: expect.objectContaining({ current_node_key: "link" }) });
  });

  it("a run that resumes past the 24-hour window ends with window_closed instead of sending", async () => {
    h.state.flows = [igFlow({ trigger_type: "ig_comment", trigger_config: { post_scope: "any" } })];
    h.state.nodes = COMMENT_NODES;
    h.state.activeRuns = activeAt("pr", { ig_comment_event_id: EVENT, ig_comment_id: "1" });
    h.lastCustomerAt = new Date(Date.now() - 25 * 3_600_000);
    await inbound({ kind: "interactive_reply", reply_id: `optin:${RUN}:pr`, reply_title: "Send it" });
    expect(h.igText).not.toHaveBeenCalled();
    expect(h.state.updates).toContainEqual({ table: "flow_runs", row: expect.objectContaining({ status: "cancelled", end_reason: "window_closed" }) });
  });

  it("a private reply held by the hourly guard waits and retries; a refusal ends the run", async () => {
    h.runId = RUN;
    h.state.flows = [igFlow({ trigger_type: "ig_comment", trigger_config: { post_scope: "any" } })];
    h.state.nodes = COMMENT_NODES;
    h.rawRow = { comment_id: "1", media_id: null, from_igsid: "9001", instagram_account_id: "ig-acct", status: "queued", flow_run_id: null };
    h.privateReply.mockResolvedValue("rate_limited");
    await startCommentFlow({ accountId: "acct-1", eventId: EVENT, flowId: "flow-1" });
    expect(h.enqueue).toHaveBeenCalledWith("flow.timer", expect.objectContaining({ runId: RUN, nodeKey: "pr", kind: "delay" }), expect.anything());
    h.state.inserted = [];
    h.state.updates = [];
    h.state.insertedRun = null;
    h.privateReply.mockResolvedValue("expired");
    await startCommentFlow({ accountId: "acct-1", eventId: EVENT, flowId: "flow-1" });
    expect(h.state.updates).toContainEqual({ table: "flow_runs", row: expect.objectContaining({ status: "failed", end_reason: "private_reply_expired" }) });
  });

  it("a private reply step in a run no comment started goes out as an ordinary message (Stage 5)", async () => {
    h.runId = RUN;
    h.state.flows = [igFlow({})];
    h.state.nodes = [node("start", "start", { next_node_key: "pr" }), ...COMMENT_NODES.slice(2)];
    await inbound({ kind: "text", text: "hi" });
    // Never the comment private-reply API: the message goes through the Instagram sender, inside the window.
    expect(h.privateReply).not.toHaveBeenCalled();
    expect(h.igText.mock.calls.length + h.igChoices.mock.calls.length).toBe(1);
    expect(events()).toContainEqual(expect.objectContaining({ event_type: "message_sent", payload: expect.objectContaining({ as_message: true }) }));
  });

  it("a message-started private reply outside the 24-hour window ends with window_closed and sends nothing (Stage 5)", async () => {
    h.state.flows = [igFlow({})];
    h.state.nodes = [node("start", "start", { next_node_key: "pr" }), ...COMMENT_NODES.slice(2)];
    h.lastCustomerAt = new Date(Date.now() - 25 * 3_600_000);
    await inbound({ kind: "text", text: "hi" });
    expect(h.igText).not.toHaveBeenCalled();
    expect(h.igChoices).not.toHaveBeenCalled();
    expect(h.state.updates).toContainEqual({ table: "flow_runs", row: expect.objectContaining({ status: "cancelled", end_reason: "window_closed" }) });
  });

  it("cards go out as a generic template; a routed card waits and its postback routes", async () => {
    h.state.flows = [igFlow({})];
    h.state.nodes = [
      node("start", "start", { next_node_key: "card" }),
      node("card", "send_card", { card: { title: "Shoes", image_url: "https://cdn.example/a.png",
        buttons: [{ type: "web_url", title: "Shop", url: "https://shop.example" }, { type: "postback", title: "More", reply_id: "more", next_node_key: "greet" }] } }),
      node("greet", "send_message", { text: "Hello", next_node_key: "done" }),
      node("done", "end", {}),
    ];
    await inbound({ kind: "text", text: "hi" });
    expect(h.igCards).toHaveBeenCalledTimes(1);
    expect((h.igCards.mock.calls[0] as unknown[])[1]).toEqual([{ title: "Shoes", imageUrl: "https://cdn.example/a.png",
      buttons: [{ type: "web_url", title: "Shop", url: "https://shop.example" }, { type: "postback", title: "More", payload: "more" }] }]);
    expect(h.igText).not.toHaveBeenCalled();
    expect(matchReplyId(h.state.nodes[1] as never, "more")).toBe("greet");
  });

  it("buttons with link buttons go out as a button template on Instagram", async () => {
    h.state.flows = [igFlow({})];
    h.state.nodes = [
      node("start", "start", { next_node_key: "ask" }),
      node("ask", "send_buttons", { text: "Pick", buttons: [{ reply_id: "yes", title: "Yes", next_node_key: "done" }],
        link_buttons: [{ title: "Site", url: "https://shop.example" }] }),
      node("done", "end", {}),
    ];
    await inbound({ kind: "text", text: "hi" });
    expect(h.igChoices).not.toHaveBeenCalled();
    expect((h.igButtonTemplate.mock.calls[0] as unknown[]).slice(1, 3)).toEqual(["Pick",
      [{ type: "postback", title: "Yes", payload: "yes" }, { type: "web_url", title: "Site", url: "https://shop.example" }]]);
  });

  it("the follow gate reads the profile when the run reaches it", async () => {
    h.state.flows = [igFlow({})];
    h.state.nodes = [
      node("start", "start", { next_node_key: "gate" }),
      node("gate", "condition", { rules: [{ subject: "ig_profile", subject_key: "follows_business", operator: "equals", value: "true" }],
        true_next: "reward", false_next: "ask" }),
      node("reward", "send_message", { text: "Here you go", next_node_key: "done" }),
      node("ask", "send_message", { text: "Follow us first", next_node_key: "done" }),
      node("done", "end", {}),
    ];
    h.profile.mockResolvedValue({ followsBusiness: false, businessFollows: null, isVerified: null, followerCount: 12 });
    await inbound({ kind: "text", text: "hi" });
    expect(h.profile).toHaveBeenCalledWith("acct-1", "cv-1");
    expect((h.igText.mock.calls[0] as unknown[])[1]).toBe("Follow us first");
    expect(igProfileValue({ followsBusiness: true, businessFollows: null, isVerified: false, followerCount: 3 }, "follows_business")).toBe("true");
    expect(igProfileValue({ followsBusiness: true, businessFollows: null, isVerified: false, followerCount: 3 }, "business_follows")).toBeUndefined();
    expect(igProfileValue({ followsBusiness: true, businessFollows: null, isVerified: false, followerCount: 3 }, "follower_count")).toBe("3");
  });

  it("the Instagram-only steps never run on WhatsApp", async () => {
    h.state.conversation = { channel: "whatsapp", whatsapp_config_id: null };
    h.state.flows = [{ ...FLOW, channel_scope: "any" }];
    h.state.nodes = [node("start", "start", { next_node_key: "card" }), node("card", "send_card", { card: { title: "x" }, next_node_key: "done" }), node("done", "end", {})];
    const result = await dispatch();
    expect(h.igCards).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(result.outcome).toBe("handed_off");
  });
});
