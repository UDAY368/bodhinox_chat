import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeTables } from "./fake-db.test-helper";
import type { ParsedInbound } from "./types";

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  queue: vi.fn<(accountId: string, input: Record<string, unknown>) => Promise<boolean>>(async () => true),
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
vi.mock("@/lib/meta-ads/capi", () => ({ queueConversionEvent: h.queue }));

import { dispatchInboundToFlows } from "./engine";

const flow = (id: string, trigger_type: string, trigger_config: Record<string, unknown>, created_at: string) => ({
  id, status: "active", created_at, account_id: "acct-1", user_id: "u-1", fallback_policy: {},
  entry_node_id: "start", test_numbers: [], trigger_type, trigger_config,
});

function setup(nodes: Record<string, unknown>[], adConfig: Record<string, unknown> = {}) {
  h.tables = {
    flows: [
      flow("kw", "keyword", { keywords: ["hi"] }, "2026-01-01T00:00:00Z"),
      flow("ad", "ad_click", adConfig, "2026-06-01T00:00:00Z"),
    ],
    flow_nodes: [
      { flow_id: "kw", node_key: "start", node_type: "start", config: { next_node_key: "done" } },
      { flow_id: "kw", node_key: "done", node_type: "end", config: {} },
      { flow_id: "ad", node_key: "start", node_type: "start", config: { next_node_key: nodes[0]?.node_key ?? "done" } },
      ...nodes.map((n) => ({ flow_id: "ad", ...n })),
      { flow_id: "ad", node_key: "done", node_type: "end", config: {} },
    ],
    flow_runs: [], flow_run_events: [], messages: [],
    contacts: [{ id: "ct-1", account_id: "acct-1", phone: "15551234567" }],
  };
}
const referral = { source_id: "120211234567890", source_type: "ad" as const, headline: "Summer sale", source_url: "https://fb.me/x" };
const dispatch = (message: Partial<ParsedInbound> = {}) => dispatchInboundToFlows({
  accountId: "acct-1", userId: "u-1", contactId: "ct-1", conversationId: "cv-1",
  message: { kind: "text", text: "hi", meta_message_id: "wamid.in.1", referral, ...message } as ParsedInbound,
  isFirstInboundMessage: false,
});
const events = (type: string) => h.tables.flow_run_events.filter((e) => e.event_type === type);

beforeEach(() => { h.queue.mockReset(); h.queue.mockResolvedValue(true); });

describe("ad_click flows", () => {
  it("starts ahead of a keyword flow with the ad variables, and logs the ad id only", async () => {
    setup([]);
    await dispatch();
    expect(h.tables.flow_runs).toHaveLength(1);
    expect(h.tables.flow_runs[0]).toMatchObject({ flow_id: "ad",
      vars: { ad_id: "120211234567890", ad_headline: "Summer sale", ad_source_url: "https://fb.me/x" } });
    expect(events("ad_click").map((e) => e.payload)).toEqual([{ ad_id: "120211234567890" }]);
  });

  it("leaves a message without an ad referral, or from another ad, to the other flows", async () => {
    setup([]);
    await dispatch({ referral: undefined });
    expect(h.tables.flow_runs[0]?.flow_id).toBe("kw");
    setup([], { ad_ids: ["999"] });
    await dispatch();
    expect(h.tables.flow_runs[0]?.flow_id).toBe("kw");
    setup([]);
    await dispatch({ referral: { ...referral, source_type: "post" } });
    expect(h.tables.flow_runs[0]?.flow_id).toBe("kw");
  });
});

describe("conversion_event step", () => {
  const conv = (config: Record<string, unknown>) =>
    ({ node_key: "conv", node_type: "conversion_event", config: { next_node_key: "done", ...config } });

  it("queues one event keyed by run and step, with a value only when it has a currency, and continues", async () => {
    setup([conv({ event_name: "InitiateCheckout", value_var: "ad_id", currency: "INR" })]);
    await dispatch({ referral: { ...referral, source_id: "499" } });
    const run = h.tables.flow_runs[0];
    expect(h.queue).toHaveBeenCalledTimes(1);
    expect(h.queue).toHaveBeenCalledWith("acct-1", { eventName: "InitiateCheckout", source: "flow", sourceId: `${run.id}:conv`,
      contactId: "ct-1", value: 499, currency: "INR" });
    expect(events("conversion_queued").map((e) => e.payload)).toEqual([{ event_name: "InitiateCheckout" }]);
    expect(run.status).toBe("completed");

    setup([conv({ event_name: "LeadSubmitted", value_var: "ad_id" })]);
    await dispatch({ referral: { ...referral, source_id: "499" } });
    expect(h.queue.mock.calls[1][1]).not.toHaveProperty("value");
  });

  it("continues without a queued event while CAPI is off, and after a queue failure", async () => {
    setup([conv({ event_name: "AddToCart" })]);
    h.queue.mockResolvedValueOnce(false);
    await dispatch();
    expect(events("conversion_queued")).toHaveLength(0);
    expect(h.tables.flow_runs[0].status).toBe("completed");

    setup([conv({ event_name: "AddToCart" })]);
    h.queue.mockRejectedValueOnce(new TypeError("boom 15551234567"));
    await dispatch();
    expect(events("error").map((e) => e.payload)).toEqual([{ reason: "conversion_queue_failed", detail: "TypeError" }]);
    expect(h.tables.flow_runs[0].status).toBe("completed");
  });

  it("never queues a Purchase from a flow (payments and orders report it, keyed by the order), and continues", async () => {
    setup([conv({ event_name: "Purchase", value_var: "ad_id", currency: "INR" })]);
    await dispatch({ referral: { ...referral, source_id: "499" } });
    expect(h.queue).not.toHaveBeenCalled();
    expect(events("error").map((e) => e.payload)).toEqual([{ reason: "conversion_invalid_event" }]);
    expect(h.tables.flow_runs[0].status).toBe("completed");
  });
});
