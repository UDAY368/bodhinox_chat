import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeTables } from "./fake-db.test-helper";

const h = vi.hoisted(() => ({
  dispatches: new Map<string, Promise<unknown>>(),
  jobs: new Map<string, { type: string; payload: Record<string, unknown>; runAt?: Date }>(),
  tables: {} as Record<string, Record<string, unknown>[]>,
  paused: false,
  sendText: vi.fn<(args: { text: string; request?: string }) => Promise<{ whatsapp_message_id: string }>>(async () => ({ whatsapp_message_id: "wamid.text" })),
  sendButtons: vi.fn<(args: { bodyText: string; buttons: Array<{ id: string; title: string }> }) => Promise<{ whatsapp_message_id: string }>>(async () => ({ whatsapp_message_id: "wamid.buttons" })),
  writeField: vi.fn(async () => true),
}));

vi.mock("@/lib/whatsapp/bot-pause", () => ({ botRepliesPaused: async () => h.paused }));
vi.mock("@/lib/jobs/dispatch", () => ({
  dispatchOnce: async (_a: string, key: string, send: () => Promise<unknown>) => {
    if (!h.dispatches.has(key)) h.dispatches.set(key, send());
    return h.dispatches.get(key);
  },
}));
// Like the real queue: a repeated dedupe key keeps the first job.
vi.mock("@/lib/jobs/queue", () => ({
  enqueueJob: async (type: string, payload: Record<string, unknown>, options: { dedupeKey: string; runAt?: Date }) => {
    if (!h.jobs.has(options.dedupeKey)) h.jobs.set(options.dedupeKey, { type, payload, runAt: options.runAt });
    return options.dedupeKey;
  },
}));
vi.mock("@/lib/contacts/field-write", () => ({ writeContactField: h.writeField }));
vi.mock("./admin-client", async () => {
  const { createFakeDb } = await import("./fake-db.test-helper");
  return { databaseAdmin: () => createFakeDb(h.tables as FakeTables) };
});
vi.mock("./meta-send", () => ({
  engineSendText: h.sendText,
  engineSendMedia: vi.fn(async () => ({ whatsapp_message_id: "wamid.media" })),
  engineSendInteractiveButtons: h.sendButtons,
  engineSendInteractiveList: vi.fn(async () => ({ whatsapp_message_id: "wamid.list" })),
}));

import { dispatchInboundToFlows, handleFlowTimer, SKIP_REPLY_ID } from "./engine";
import type { ParsedInbound } from "./types";

type Node = { node_key: string; node_type: string; config: Record<string, unknown> };

function setup(nodes: Node[], run: Record<string, unknown> | null = null) {
  h.tables = {
    flows: [{
      id: "flow-1", account_id: "acct-1", user_id: "u-1", status: "active", trigger_type: "keyword",
      trigger_config: { keywords: ["hi"] }, entry_node_id: "start", fallback_policy: { max_reprompts: 1, on_exhaust: "end" },
      created_at: "2026-01-01T00:00:00Z",
    }],
    flow_nodes: nodes.map((n) => ({ flow_id: "flow-1", ...n })),
    flow_runs: run ? [{
      id: "run-1", flow_id: "flow-1", account_id: "acct-1", user_id: "u-1", contact_id: "ct-1", conversation_id: "cv-1",
      status: "active", transition_seq: 0, vars: {}, reprompt_count: 0, started_at: new Date().toISOString(),
      last_advanced_at: new Date().toISOString(), delay_until: null, ...run,
    }] : [],
    flow_run_events: [],
    messages: [],
    contacts: [{ id: "ct-1", account_id: "acct-1", blocked_at: null }],
  };
}

const dispatch = (message: ParsedInbound) => dispatchInboundToFlows({
  accountId: "acct-1", userId: "u-1", contactId: "ct-1", conversationId: "cv-1", message, isFirstInboundMessage: false,
});
const text = (t: string, id = `m-${t}`): ParsedInbound => ({ kind: "text", text: t, meta_message_id: id });
const theRun = () => h.tables.flow_runs[0];
const events = (type: string) => h.tables.flow_run_events.filter((e) => e.event_type === type);
const sentTexts = () => h.sendText.mock.calls.map(([args]) => args.text);
const job = (kind: string) => [...h.jobs.values()].find((j) => j.payload.kind === kind)!;
const fire = (kind: "delay" | "timeout") => {
  const { payload } = job(kind);
  return handleFlowTimer({ accountId: "acct-1", ...(payload as { runId: string; nodeKey: string; seq: number; kind: typeof kind }) });
};

beforeEach(() => {
  h.dispatches.clear();
  h.jobs.clear();
  h.paused = false;
  h.sendText.mockClear();
  h.sendButtons.mockClear();
  h.writeField.mockClear();
});

describe("node delays", () => {
  const DELAYED: Node[] = [
    { node_key: "start", node_type: "start", config: { next_node_key: "hello" } },
    { node_key: "hello", node_type: "send_message", config: { text: "Hello", next_node_key: "later" } },
    { node_key: "later", node_type: "send_message", config: { text: "Later", delay_seconds: 600, next_node_key: "done" } },
    { node_key: "done", node_type: "end", config: {} },
  ];

  it("parks the run on a durable timer and sends only after it fires, once", async () => {
    setup(DELAYED);
    const before = Date.now();
    expect(await dispatch(text("hi"))).toMatchObject({ consumed: true, outcome: "started" });
    expect(sentTexts()).toEqual(["Hello"]);
    expect(theRun()).toMatchObject({ status: "active", current_node_key: "later", transition_seq: 1 });
    expect(theRun().delay_until).toBeTruthy();
    const timer = job("delay");
    expect(timer.type).toBe("flow.timer");
    expect(timer.payload).toMatchObject({ runId: theRun().id, nodeKey: "later", seq: 1 });
    expect(timer.runAt!.getTime()).toBeGreaterThanOrEqual(before + 600_000);
    expect(events("delay_scheduled")).toHaveLength(1);

    expect(await fire("delay")).toBe("fired");
    expect(sentTexts()).toEqual(["Hello", "Later"]);
    expect(theRun()).toMatchObject({ status: "completed", delay_until: null, transition_seq: 2 });
    // A redelivered job (worker restart after the send) finds a moved seq.
    expect(await fire("delay")).toBe("stale");
    expect(sentTexts()).toEqual(["Hello", "Later"]);
  });

  it("records a reply during the delay without acting on it", async () => {
    setup(DELAYED);
    await dispatch(text("hi"));
    expect(await dispatch(text("are you there?"))).toMatchObject({ consumed: true, outcome: "waiting" });
    expect(sentTexts()).toEqual(["Hello"]);
    expect(theRun()).toMatchObject({ status: "active", transition_seq: 1, reprompt_count: 0 });
  });

  it("cancels instead of sending when an agent took over during the wait", async () => {
    setup(DELAYED);
    await dispatch(text("hi"));
    h.paused = true;
    expect(await fire("delay")).toBe("fired");
    expect(theRun()).toMatchObject({ status: "cancelled", end_reason: "bot_paused_during_wait" });
    expect(sentTexts()).toEqual(["Hello"]);
  });

  it("cancels instead of sending when the contact was blocked during the wait", async () => {
    setup(DELAYED);
    await dispatch(text("hi"));
    h.tables.contacts[0].blocked_at = new Date().toISOString();
    await fire("delay");
    expect(theRun()).toMatchObject({ status: "cancelled" });
    expect(sentTexts()).toEqual(["Hello"]);
  });
});

describe("reply timeouts", () => {
  const ASK: Node[] = [
    { node_key: "ask", node_type: "collect_input", config: { prompt_text: "Your name?", var_key: "name", next_node_key: "thanks", timeout_minutes: 30, after_timeout: "nudge" } },
    { node_key: "thanks", node_type: "send_message", config: { text: "Thanks {{vars.name}}", next_node_key: "done" } },
    { node_key: "nudge", node_type: "send_message", config: { text: "Still there?", next_node_key: "done" } },
    { node_key: "done", node_type: "end", config: {} },
  ];

  it("follows the timeout port when no reply comes", async () => {
    setup([{ node_key: "start", node_type: "start", config: { next_node_key: "ask" } }, ...ASK]);
    await dispatch(text("hi"));
    expect(job("timeout").payload).toMatchObject({ nodeKey: "ask", seq: 0 });
    expect(await fire("timeout")).toBe("fired");
    expect(sentTexts()).toEqual(["Your name?", "Still there?"]);
    expect(events("timeout")[0]).toMatchObject({ node_key: "ask", payload: { reason: "node_timeout", minutes: 30 } });
    expect(theRun().status).toBe("completed");
  });

  it("does nothing once the customer has answered", async () => {
    setup([{ node_key: "start", node_type: "start", config: { next_node_key: "ask" } }, ...ASK]);
    await dispatch(text("hi"));
    await dispatch(text("Asha"));
    expect(await fire("timeout")).toBe("stale");
    expect(sentTexts()).toEqual(["Your name?", "Thanks Asha"]);
  });
});

describe("Ask question v2", () => {
  const question = (config: Record<string, unknown>): Node[] => [
    { node_key: "ask", node_type: "collect_input", config: { prompt_text: "How many?", var_key: "qty", next_node_key: "ok", ...config } },
    { node_key: "ok", node_type: "send_message", config: { text: "Got {{vars.qty}}", next_node_key: "done" } },
    { node_key: "out", node_type: "send_message", config: { text: "Let's talk", next_node_key: "done" } },
    { node_key: "skipped", node_type: "send_message", config: { text: "No problem", next_node_key: "done" } },
    { node_key: "done", node_type: "end", config: {} },
  ];

  it("stores a normalized number within bounds", async () => {
    setup(question({ validation: "number", min: 1, max: 10 }), { current_node_key: "ask" });
    expect((await dispatch(text("2,5"))).outcome).toBe("completed");
    expect(theRun().vars).toEqual({ qty: "2.5" });
    expect(sentTexts()).toEqual(["Got 2.5"]);
  });

  it("sends the error message on each wrong answer, then takes the exhausted port", async () => {
    setup(question({ validation: "number", max_attempts: 2, error_text: "Please send a number", exhausted_next: "out" }), { current_node_key: "ask" });
    expect((await dispatch(text("lots"))).outcome).toBe("fallback_fired");
    expect(sentTexts()).toEqual(["Please send a number"]);
    expect(theRun().reprompt_count).toBe(1);
    expect((await dispatch(text("many"))).outcome).toBe("completed");
    expect(sentTexts()).toEqual(["Please send a number", "Let's talk"]);
    expect(events("input_invalid")).toHaveLength(2);
  });

  it("uses the flow's exhaust policy when the exhausted port is unset", async () => {
    setup(question({ validation: "number", max_attempts: 1 }), { current_node_key: "ask" });
    expect((await dispatch(text("lots"))).outcome).toBe("completed");
    expect(theRun()).toMatchObject({ status: "completed", end_reason: "fallback_exhausted_end" });
  });

  it("offers a Skip button that routes to the skip port without capturing", async () => {
    setup([{ node_key: "start", node_type: "start", config: { next_node_key: "ask" } },
      ...question({ skip_label: "Skip", skip_next: "skipped" })]);
    await dispatch(text("hi"));
    expect(h.sendButtons.mock.calls[0][0]).toMatchObject({ bodyText: "How many?", buttons: [{ id: SKIP_REPLY_ID, title: "Skip" }] });
    const tap: ParsedInbound = { kind: "interactive_reply", reply_id: SKIP_REPLY_ID, reply_title: "Skip", meta_message_id: "m-skip" };
    expect((await dispatch(tap)).outcome).toBe("completed");
    expect(theRun().vars).toEqual({});
    expect(sentTexts()).toEqual(["No problem"]);
  });

  it("still reads a photo caption as the text answer, as before", async () => {
    setup(question({}), { current_node_key: "ask" });
    await dispatch({ kind: "media", media_type: "image", url: "https://x/y.jpg", caption: "three", meta_message_id: "m-img" });
    expect(theRun().vars).toEqual({ qty: "three" });
  });
});

describe("Set attribute", () => {
  it("writes a run variable that later steps can use", async () => {
    setup([
      { node_key: "start", node_type: "start", config: { next_node_key: "set" } },
      { node_key: "set", node_type: "set_attribute", config: { target: "var", key: "plan", value: "Gold", next_node_key: "say" } },
      { node_key: "say", node_type: "send_message", config: { text: "Plan: {{vars.plan}}", next_node_key: "done" } },
      { node_key: "done", node_type: "end", config: {} },
    ]);
    await dispatch(text("hi"));
    expect(sentTexts()).toEqual(["Plan: Gold"]);
    expect(theRun().vars).toEqual({ plan: "Gold" });
    expect(events("attribute_set")[0].payload).toEqual({ target: "var", key: "plan", length: 4 });
  });

  it("writes contact and custom fields through the shared writer", async () => {
    setup([
      { node_key: "start", node_type: "start", config: { next_node_key: "a" } },
      { node_key: "a", node_type: "set_attribute", config: { target: "contact_field", key: "company", value: "Acme", next_node_key: "b" } },
      { node_key: "b", node_type: "set_attribute", config: { target: "custom_field", key: "cf-1", value: "VIP", next_node_key: "done" } },
      { node_key: "done", node_type: "end", config: {} },
    ]);
    await dispatch(text("hi"));
    expect(h.writeField.mock.calls).toEqual([
      [expect.anything(), "acct-1", "ct-1", "company", "Acme"],
      [expect.anything(), "acct-1", "ct-1", "custom:cf-1", "VIP"],
    ]);
  });
});

describe("Ask media, location and address", () => {
  const ask = (node_type: string, config: Record<string, unknown> = {}): Node[] => [
    { node_key: "ask", node_type, config: { prompt_text: "Send it", var_key: "ans", next_node_key: "done", ...config } },
    { node_key: "done", node_type: "end", config: {} },
  ];

  it("sends a location request and stores the coordinates", async () => {
    setup([{ node_key: "start", node_type: "start", config: { next_node_key: "ask" } }, ...ask("ask_location")]);
    await dispatch(text("hi"));
    expect(h.sendText.mock.calls[0][0]).toMatchObject({ text: "Send it", request: "location" });
    await dispatch({ kind: "location", latitude: 12.97, longitude: 77.59, name: "Office", meta_message_id: "m-loc" });
    expect(theRun().vars).toEqual({ ans: "12.97,77.59", ans_latitude: "12.97", ans_longitude: "77.59", ans_name: "Office" });
  });

  it("rejects a text reply to a location question", async () => {
    setup(ask("ask_location"), { current_node_key: "ask" });
    expect((await dispatch(text("Bangalore"))).outcome).toBe("fallback_fired");
    expect(theRun().vars).toEqual({});
  });

  it("stores each address-form field, or a typed address", async () => {
    setup(ask("ask_address"), { current_node_key: "ask" });
    await dispatch({ kind: "address", values: { city: "Pune", in_pin_code: "411001" }, meta_message_id: "m-a" });
    expect(theRun().vars).toEqual({ ans: "Pune, 411001", ans_city: "Pune", ans_in_pin_code: "411001" });
    setup(ask("ask_address"), { current_node_key: "ask" });
    await dispatch(text("12 Main St, Leeds"));
    expect(theRun().vars).toEqual({ ans: "12 Main St, Leeds" });
  });

  it("accepts only the media kinds the node allows", async () => {
    setup(ask("ask_media", { media_types: ["document"] }), { current_node_key: "ask" });
    expect((await dispatch({ kind: "media", media_type: "image", url: "u1", caption: "", meta_message_id: "m-1" })).outcome).toBe("fallback_fired");
    await dispatch({ kind: "media", media_type: "document", url: "u2", caption: "", meta_message_id: "m-2" });
    expect(theRun().vars).toEqual({ ans: "u2", ans_type: "document" });
  });
});

describe("condition rules", () => {
  it("routes on a group of rules joined by any", async () => {
    setup([
      { node_key: "start", node_type: "start", config: { next_node_key: "set" } },
      { node_key: "set", node_type: "set_attribute", config: { target: "var", key: "age", value: "17", next_node_key: "check" } },
      { node_key: "check", node_type: "condition", config: {
        match: "any",
        rules: [
          { subject: "var", subject_key: "age", operator: "gte", value: "18" },
          { subject: "var", subject_key: "age", operator: "between", value: "13", value2: "17" },
        ],
        true_next: "yes", false_next: "no" } },
      { node_key: "yes", node_type: "send_message", config: { text: "yes", next_node_key: "done" } },
      { node_key: "no", node_type: "send_message", config: { text: "no", next_node_key: "done" } },
      { node_key: "done", node_type: "end", config: {} },
    ]);
    await dispatch(text("hi"));
    expect(sentTexts()).toEqual(["yes"]);
  });
});

describe("timer redelivery after a crash", () => {
  it("finishes a delay whose claim committed before the worker died", async () => {
    setup([
      { node_key: "start", node_type: "start", config: { next_node_key: "later" } },
      { node_key: "later", node_type: "send_message", config: { text: "Later", delay_seconds: 60, next_node_key: "done" } },
      { node_key: "done", node_type: "end", config: {} },
    ]);
    await dispatch(text("hi"));
    // The claim landed (seq 2, delay cleared) but nothing after it ran.
    Object.assign(theRun(), { transition_seq: 2, delay_until: null });
    expect(await fire("delay")).toBe("fired");
    expect(sentTexts()).toEqual(["Later"]);
    expect(theRun().status).toBe("completed");
  });

  it("does not resume a run the customer has since moved", async () => {
    setup([
      { node_key: "start", node_type: "start", config: { next_node_key: "later" } },
      { node_key: "later", node_type: "collect_input", config: { prompt_text: "Name?", var_key: "n", delay_seconds: 60, next_node_key: "done" } },
      { node_key: "done", node_type: "end", config: {} },
    ]);
    await dispatch(text("hi"));
    await fire("delay");
    theRun().reprompt_count = 1; // a wrong answer was already handled after the prompt went out
    h.jobs.clear();
    expect(await handleFlowTimer({ accountId: "acct-1", runId: String(theRun().id), nodeKey: "later", seq: 1, kind: "delay" })).toBe("stale");
    expect(sentTexts()).toEqual(["Name?"]);
  });
});
