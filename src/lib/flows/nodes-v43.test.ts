import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeTables } from "./fake-db.test-helper";

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  dispatches: new Map<string, Promise<unknown>>(),
  keys: [] as string[],
  sendText: vi.fn<(args: { text: string }) => Promise<{ whatsapp_message_id: string }>>(async () => ({ whatsapp_message_id: "wamid.text" })),
  sendMedia: vi.fn<(args: { kind: string; link: string; caption?: string }) => Promise<{ whatsapp_message_id: string }>>(async () => ({ whatsapp_message_id: "wamid.media" })),
  sendButtons: vi.fn(async () => ({ whatsapp_message_id: "wamid.buttons" })),
}));

vi.mock("@/lib/whatsapp/bot-pause", () => ({ botRepliesPaused: async () => false }));
vi.mock("@/lib/jobs/dispatch", () => ({
  dispatchOnce: async (_a: string, key: string, send: () => Promise<unknown>) => {
    h.keys.push(key);
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
  engineSendMedia: h.sendMedia,
  engineSendInteractiveButtons: h.sendButtons,
  engineSendInteractiveList: vi.fn(),
}));

import { dispatchInboundToFlows } from "./engine";
import type { ParsedInbound } from "./types";

const BASE = { account_id: "acct-1", user_id: "u-1", fallback_policy: {}, entry_node_id: "start", test_numbers: [] as string[] };
const flow = (id: string, patch: Record<string, unknown>) => ({ id, status: "active", created_at: "2026-01-01T00:00:00Z", ...BASE, ...patch });
const say = (flowId: string, text: string) => [
  { flow_id: flowId, node_key: "start", node_type: "start", config: { next_node_key: "say" } },
  { flow_id: flowId, node_key: "say", node_type: "send_message", config: { text, next_node_key: "done" } },
  { flow_id: flowId, node_key: "done", node_type: "end", config: {} },
];

function setup(flows: Record<string, unknown>[], nodes: Record<string, unknown>[], phone = "919876543210") {
  h.tables = {
    flows, flow_nodes: nodes, flow_runs: [], flow_run_events: [], messages: [],
    contacts: [{ id: "ct-1", account_id: "acct-1", phone }],
  };
}
const dispatch = (message: ParsedInbound) => dispatchInboundToFlows({
  accountId: "acct-1", userId: "u-1", contactId: "ct-1", conversationId: "cv-1", message, isFirstInboundMessage: true,
});
const texts = () => h.sendText.mock.calls.map(([a]) => a.text);

beforeEach(() => {
  h.dispatches.clear();
  h.keys = [];
  h.sendText.mockClear();
  h.sendMedia.mockClear();
});

describe("trigger precedence", () => {
  it("prefers a template-reply flow over a keyword or first-message flow, and records the button", async () => {
    setup([
      flow("first", { trigger_type: "first_inbound_message", trigger_config: {}, created_at: "2025-01-01T00:00:00Z" }),
      flow("kw", { trigger_type: "keyword", trigger_config: { keywords: ["track"] }, created_at: "2025-06-01T00:00:00Z" }),
      flow("tpl", { trigger_type: "template_reply", trigger_config: { template_name: "order_update" } }),
    ], [...say("first", "first"), ...say("kw", "keyword"), ...say("tpl", "Button {{vars.trigger_button}}")]);
    await dispatch({ kind: "interactive_reply", reply_id: "Track", reply_title: "Track", meta_message_id: "m1", context_template: "order_update" });
    expect(texts()).toEqual(["Button Track"]);
  });

  it("starts a regex flow ahead of first-message", async () => {
    setup([
      flow("first", { trigger_type: "first_inbound_message", trigger_config: {} }),
      flow("rx", { trigger_type: "keyword", trigger_config: { keywords: [], match_type: "regex", pattern: "order\\s*\\d+" }, created_at: "2026-02-01T00:00:00Z" }),
    ], [...say("first", "first"), ...say("rx", "regex")]);
    await dispatch({ kind: "text", text: "Where is ORDER 42?", meta_message_id: "m2" });
    expect(texts()).toEqual(["regex"]);
  });
});

describe("testing-only drafts", () => {
  const draft = flow("draft", { status: "draft", trigger_type: "keyword", trigger_config: { keywords: ["hi"] }, test_numbers: ["919876543210"] });

  it("runs a draft for a test number only", async () => {
    setup([draft], say("draft", "testing"));
    expect((await dispatch({ kind: "text", text: "hi", meta_message_id: "m3" })).outcome).toBe("completed");
    expect(texts()).toEqual(["testing"]);
    setup([draft], say("draft", "testing"), "14155550100");
    expect((await dispatch({ kind: "text", text: "hi", meta_message_id: "m4" })).outcome).toBe("no_match");
  });

  it("keeps a tester's run going on a draft but ends anyone else's", async () => {
    const nodes = [
      { flow_id: "draft", node_key: "start", node_type: "start", config: { next_node_key: "ask" } },
      { flow_id: "draft", node_key: "ask", node_type: "collect_input", config: { prompt_text: "Name?", var_key: "n", next_node_key: "thanks" } },
      { flow_id: "draft", node_key: "thanks", node_type: "send_message", config: { text: "Thanks {{vars.n}}", next_node_key: "done" } },
      { flow_id: "draft", node_key: "done", node_type: "end", config: {} },
    ];
    const run = { id: "run-1", flow_id: "draft", account_id: "acct-1", user_id: "u-1", contact_id: "ct-1", conversation_id: "cv-1", status: "active",
      current_node_key: "ask", transition_seq: 0, reprompt_count: 0, vars: {}, started_at: new Date().toISOString(), last_advanced_at: new Date().toISOString() };
    setup([draft], nodes);
    h.tables.flow_runs.push({ ...run });
    await dispatch({ kind: "text", text: "Asha", meta_message_id: "m5" });
    expect(texts()).toEqual(["Thanks Asha"]);
    setup([{ ...draft, test_numbers: [] }], nodes);
    h.tables.flow_runs.push({ ...run });
    await dispatch({ kind: "text", text: "Asha", meta_message_id: "m6" });
    expect(h.tables.flow_runs[0]).toMatchObject({ status: "cancelled", end_reason: "flow_not_active" });
  });
});

describe("default fallback message", () => {
  const menu = (fallback_message: Record<string, unknown>) => {
    setup([flow("menu", { trigger_type: "manual", trigger_config: {}, fallback_policy: { max_reprompts: 2, fallback_message } })], [
      { flow_id: "menu", node_key: "menu", node_type: "send_buttons", config: { text: "Pick", buttons: [{ reply_id: "a", title: "A", next_node_key: "done" }] } },
      { flow_id: "menu", node_key: "done", node_type: "end", config: {} },
    ]);
    h.tables.flow_runs.push({ id: "run-m", flow_id: "menu", account_id: "acct-1", user_id: "u-1", contact_id: "ct-1", conversation_id: "cv-1",
      status: "active", current_node_key: "menu", transition_seq: 0, reprompt_count: 0, vars: { name: "Ann" },
      started_at: new Date().toISOString(), last_advanced_at: new Date().toISOString() });
  };

  it("sends the text before each reprompt, as its own intent per inbound message", async () => {
    menu({ text: "Sorry {{vars.name}}, tap a button." });
    await dispatch({ kind: "text", text: "what?", meta_message_id: "m7" });
    await dispatch({ kind: "text", text: "eh?", meta_message_id: "m8" });
    expect(texts()).toEqual(["Sorry Ann, tap a button.", "Sorry Ann, tap a button."]);
    expect(h.keys.filter((k) => k.startsWith("flow-fallback:"))).toEqual(["flow-fallback:run-m:m7", "flow-fallback:run-m:m8"]);
    expect(h.sendButtons).toHaveBeenCalled();
  });

  it("does not send it twice when the same inbound is replayed", async () => {
    menu({ text: "Tap a button." });
    await dispatch({ kind: "text", text: "what?", meta_message_id: "m7" });
    await dispatch({ kind: "text", text: "what?", meta_message_id: "m7" });
    expect(texts()).toEqual(["Tap a button."]);
  });

  it("sends an image with the text as caption", async () => {
    menu({ text: "Like this", media_type: "image", media_url: "https://cdn.example/help.png" });
    await dispatch({ kind: "text", text: "what?", meta_message_id: "m9" });
    expect(h.sendMedia.mock.calls[0][0]).toMatchObject({ kind: "image", link: "https://cdn.example/help.png", caption: "Like this" });
    expect(texts()).toEqual([]);
  });
});
