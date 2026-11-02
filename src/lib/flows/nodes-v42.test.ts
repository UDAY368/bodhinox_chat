import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeTables } from "./fake-db.test-helper";

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  dispatches: new Map<string, Promise<unknown>>(),
  sendText: vi.fn<(args: { text: string }) => Promise<{ whatsapp_message_id: string }>>(async () => ({ whatsapp_message_id: "wamid.text" })),
  sendTemplate: vi.fn<(args: Record<string, unknown>) => Promise<{ whatsapp_message_id: string }>>(async () => ({ whatsapp_message_id: "wamid.tpl" })),
  fetch: vi.fn(),
  roundRobin: vi.fn(async () => "agent-rr"),
}));

vi.mock("@/lib/whatsapp/bot-pause", () => ({ botRepliesPaused: async () => false }));
vi.mock("@/lib/jobs/dispatch", () => ({
  dispatchOnce: async (_a: string, key: string, send: () => Promise<unknown>) => {
    if (!h.dispatches.has(key)) h.dispatches.set(key, send());
    return h.dispatches.get(key);
  },
}));
vi.mock("@/lib/jobs/queue", () => ({ enqueueJob: async () => "job" }));
vi.mock("@/lib/webhooks/safe-fetch", () => ({ safeFetch: h.fetch }));
vi.mock("@/lib/automations/meta-send", () => ({ engineSendTemplate: h.sendTemplate }));
vi.mock("@/lib/automations/round-robin", () => ({ nextRoundRobinAgent: h.roundRobin }));
vi.mock("./admin-client", async () => {
  const { createFakeDb } = await import("./fake-db.test-helper");
  return { databaseAdmin: () => createFakeDb(h.tables as FakeTables) };
});
vi.mock("./meta-send", () => ({
  engineSendText: h.sendText,
  engineSendMedia: vi.fn(),
  engineSendInteractiveButtons: vi.fn(async () => ({ whatsapp_message_id: "wamid.buttons" })),
  engineSendInteractiveList: vi.fn(),
}));

import { CONNECT_HOPS_VAR, dispatchInboundToFlows, MAX_CONNECT_HOPS } from "./engine";
import type { ParsedInbound } from "./types";

type Node = { node_key: string; node_type: string; config: Record<string, unknown> };
const FLOW = { account_id: "acct-1", user_id: "u-1", status: "active", trigger_type: "keyword", fallback_policy: {}, created_at: "2026-01-01T00:00:00Z" };

function setup(nodes: Node[], extra: { flows?: Record<string, unknown>[]; nodes?: Record<string, unknown>[]; runs?: Record<string, unknown>[] } = {}) {
  h.tables = {
    flows: [{ id: "flow-1", ...FLOW, trigger_config: { keywords: ["hi"] }, entry_node_id: "start" }, ...(extra.flows ?? [])],
    flow_nodes: [...nodes.map((n) => ({ flow_id: "flow-1", ...n })), ...(extra.nodes ?? [])],
    flow_runs: extra.runs ?? [],
    flow_run_events: [],
    messages: [],
    conversations: [{ id: "cv-1", account_id: "acct-1", assigned_agent_id: null }],
    contacts: [{ id: "ct-1", account_id: "acct-1", name: "Ann", email: null, phone: "14155550100", company: null }],
  };
}
const dispatch = (message: ParsedInbound) => dispatchInboundToFlows({
  accountId: "acct-1", userId: "u-1", contactId: "ct-1", conversationId: "cv-1", message, isFirstInboundMessage: false,
});
const hi: ParsedInbound = { kind: "text", text: "hi", meta_message_id: "m-hi" };
const events = (type: string) => h.tables.flow_run_events.filter((e) => e.event_type === type);
const runOf = (flowId: string) => h.tables.flow_runs.find((r) => r.flow_id === flowId)!;
const start = (next: string): Node => ({ node_key: "start", node_type: "start", config: { next_node_key: next } });
const say = (key: string, text: string, next = "done"): Node => ({ node_key: key, node_type: "send_message", config: { text, next_node_key: next } });
const done: Node = { node_key: "done", node_type: "end", config: {} };

beforeEach(() => {
  h.dispatches.clear();
  h.sendText.mockClear();
  h.sendTemplate.mockClear();
  h.fetch.mockReset();
  h.roundRobin.mockClear();
});

describe("Send template", () => {
  const template: Node = { node_key: "tpl", node_type: "send_template", config: {
    template_name: "order_update", language: "en", body_params: ["{{vars.missing}}", "Order 7"],
    buttons: [{ index: 0, reply_id: "tpl_1", title: "Track", next_node_key: "track" }, { index: 2, reply_id: "tpl_3", title: "Help", next_node_key: "help" }],
  } };

  it("sends quick-reply payloads, waits, and routes on the payload or the echoed title", async () => {
    setup([start("tpl"), template, say("track", "Tracking"), say("help", "Helping"), done]);
    expect((await dispatch(hi)).outcome).toBe("started");
    expect(h.sendTemplate.mock.calls[0][0]).toMatchObject({
      templateName: "order_update", language: "en", params: ["-", "Order 7"],
      messageParams: { body: ["-", "Order 7"], buttonParams: { 0: "tpl_1", 2: "tpl_3" } },
    });
    expect(runOf("flow-1")).toMatchObject({ status: "active", current_node_key: "tpl" });
    await dispatch({ kind: "interactive_reply", reply_id: "Help", reply_title: "Help", meta_message_id: "m-tap" });
    expect(h.sendText.mock.calls.map(([a]) => a.text)).toEqual(["Helping"]);
  });

  it("never re-sends the template for an unrelated reply", async () => {
    setup([start("tpl"), template, say("track", "Tracking"), say("help", "Helping"), done]);
    await dispatch(hi);
    await dispatch({ kind: "text", text: "what?", meta_message_id: "m-what" });
    expect(h.sendTemplate).toHaveBeenCalledTimes(1);
  });

  it("advances straight on when the template has no quick replies", async () => {
    setup([start("tpl"), { node_key: "tpl", node_type: "send_template", config: { template_name: "hello", next_node_key: "after" } }, say("after", "Next"), done]);
    expect((await dispatch(hi)).outcome).toBe("completed");
    expect(h.sendText).toHaveBeenCalledTimes(1);
  });
});

describe("API request", () => {
  const api = (patch: Record<string, unknown> = {}): Node => ({ node_key: "api", node_type: "api_request", config: {
    method: "GET", url: "https://api.example.com/c/{{contact.phone}}",
    mappings: [{ path: "data.tier", var_key: "tier" }],
    routes: [{ status: "2xx", next_node_key: "ok" }], fallback_next: "fb", ...patch,
  } });

  it("maps the reply into variables and follows the status route", async () => {
    h.fetch.mockResolvedValue({ ok: true, status: 200, contentType: "application/json", body: '{"data":{"tier":"gold"}}' });
    setup([start("api"), api(), say("ok", "Tier {{vars.tier}}"), say("fb", "Sorry"), done]);
    await dispatch(hi);
    expect(h.fetch.mock.calls[0][0]).toBe("https://api.example.com/c/14155550100");
    expect(h.sendText.mock.calls.map(([a]) => a.text)).toEqual(["Tier gold"]);
    // The log keeps the outcome, never the URL or the reply.
    expect(events("api_request")[0].payload).toEqual({ status: 200, error: null, duration_ms: expect.any(Number), mapped: ["tier"], route: "status" });
  });

  it("takes the fallback on a timeout or an unmatched status, mapping nothing", async () => {
    h.fetch.mockResolvedValue({ ok: false, error: "timeout" });
    setup([start("api"), api(), say("ok", "ok"), say("fb", "Sorry"), done]);
    await dispatch(hi);
    expect(h.sendText.mock.calls.map(([a]) => a.text)).toEqual(["Sorry"]);
    expect(runOf("flow-1").vars).toEqual({});
  });
});

describe("Assign agent", () => {
  it("assigns the next agent in the round robin and carries on", async () => {
    setup([start("assign"), { node_key: "assign", node_type: "assign_agent", config: { mode: "round_robin", next_node_key: "after" } }, say("after", "Done"), done]);
    await dispatch(hi);
    expect(h.tables.conversations[0].assigned_agent_id).toBe("agent-rr");
    expect(events("agent_assigned")[0].payload).toEqual({ agent_id: "agent-rr", mode: "round_robin", seq: "0" });
    expect(runOf("flow-1").status).toBe("completed");
  });
});

describe("Connect flow", () => {
  const target = { id: "flow-2", ...FLOW, trigger_config: {}, entry_node_id: "t_start" };
  const targetNodes = [
    { flow_id: "flow-2", node_key: "t_start", node_type: "start", config: { next_node_key: "t_say" } },
    { flow_id: "flow-2", node_key: "t_say", node_type: "send_message", config: { text: "Hello {{vars.name}}", next_node_key: "t_end" } },
    { flow_id: "flow-2", node_key: "t_end", node_type: "end", config: {} },
  ];
  const nodes = [start("set"), { node_key: "set", node_type: "set_attribute", config: { target: "var", key: "name", value: "Ann", next_node_key: "go" } },
    { node_key: "go", node_type: "connect_flow", config: { flow_id: "flow-2" } }];

  it("ends this run and starts the target with the same variables", async () => {
    setup(nodes, { flows: [target], nodes: targetNodes });
    await dispatch(hi);
    expect(runOf("flow-1")).toMatchObject({ status: "completed", end_reason: "connect_flow" });
    expect(runOf("flow-2")).toMatchObject({ status: "completed", vars: { name: "Ann", [CONNECT_HOPS_VAR]: 1 } });
    expect(h.sendText.mock.calls.map(([a]) => a.text)).toEqual(["Hello Ann"]);
  });

  it("stops a chain of connects that never waits for the customer, however slow", async () => {
    // flow-3 restarts itself; delays would slip past a per-minute limit, a hop count does not.
    setup([], {
      flows: [{ id: "flow-3", ...FLOW, trigger_config: { keywords: ["loop"] }, entry_node_id: "l_start" }],
      nodes: [
        { flow_id: "flow-3", node_key: "l_start", node_type: "start", config: { next_node_key: "l_say" } },
        { flow_id: "flow-3", node_key: "l_say", node_type: "send_message", config: { text: "again", next_node_key: "l_go" } },
        { flow_id: "flow-3", node_key: "l_go", node_type: "connect_flow", config: { flow_id: "flow-3" } },
      ],
    });
    await dispatch({ kind: "text", text: "loop", meta_message_id: "m-loop" });
    expect(h.sendText).toHaveBeenCalledTimes(MAX_CONNECT_HOPS + 1);
    const runs = h.tables.flow_runs.filter((r) => r.flow_id === "flow-3");
    expect(runs).toHaveLength(MAX_CONNECT_HOPS + 1);
    expect(runs.at(-1)).toMatchObject({ status: "failed", end_reason: "connect_flow_loop" });
  });

  it("resets the hop count once the customer replies", async () => {
    setup([start("ask"), { node_key: "ask", node_type: "collect_input", config: { prompt_text: "Name?", var_key: "name", next_node_key: "go" } },
      { node_key: "go", node_type: "connect_flow", config: { flow_id: "flow-2" } }], { flows: [target], nodes: targetNodes });
    h.tables.flow_runs.push({ id: "run-hops", flow_id: "flow-1", account_id: "acct-1", user_id: "u-1", contact_id: "ct-1", conversation_id: "cv-1",
      status: "active", current_node_key: "ask", transition_seq: 0, reprompt_count: 0, vars: { [CONNECT_HOPS_VAR]: MAX_CONNECT_HOPS },
      started_at: new Date().toISOString(), last_advanced_at: new Date().toISOString() });
    await dispatch({ kind: "text", text: "Ann", meta_message_id: "m-ann" });
    expect(runOf("flow-2")).toMatchObject({ status: "completed", vars: { name: "Ann", [CONNECT_HOPS_VAR]: 1 } });
  });

  it("fails when the target flow is not active", async () => {
    setup(nodes, { flows: [{ ...target, status: "draft" }], nodes: targetNodes });
    await dispatch(hi);
    expect(runOf("flow-1")).toMatchObject({ status: "failed", end_reason: "connect_flow_unavailable" });
  });
});
