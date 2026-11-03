import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeTables } from "./fake-db.test-helper";
import type { FlowAiOutcome, RunFlowAiReplyArgs } from "@/lib/ai/flow-reply";

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  ai: vi.fn<(args: RunFlowAiReplyArgs) => Promise<FlowAiOutcome>>(),
  started: vi.fn<(accountId: string, intentKey: string) => Promise<boolean>>(),
  jobs: [] as Array<{ kind: string; payload: Record<string, unknown>; opts: Record<string, unknown> }>,
}));

vi.mock("@/lib/whatsapp/bot-pause", () => ({ botRepliesPaused: async () => false }));
vi.mock("@/lib/jobs/dispatch", () => ({
  dispatchOnce: async (_a: string, _key: string, send: () => Promise<unknown>) => send(),
  UncertainDispatchError: class extends Error {},
}));
vi.mock("@/lib/jobs/queue", () => ({
  enqueueJob: async (kind: string, payload: Record<string, unknown>, opts: Record<string, unknown>) => { h.jobs.push({ kind, payload, opts }); return "job"; },
}));
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
vi.mock("@/lib/ai/flow-reply", () => ({ runFlowAiReply: h.ai, flowAiTurnStarted: h.started }));

import { dispatchInboundToFlows } from "./engine";
import { validateFlowForActivation } from "./validate";
import { applyEdgeConnection, deriveCanvasEdges, outgoingSlots, unlinkNodeReferences } from "./edges";
import { choose, startPreview } from "./preview";
import { aiReplyIssues, aiReplyMaxTurns } from "./ai-reply-node";
import type { BuilderNode } from "@/components/flows/shared";

const answered = (text = "We open at 10.", over: Partial<Extract<FlowAiOutcome, { kind: "answered" }>> = {}): FlowAiOutcome =>
  ({ kind: "answered", text, whatsappMessageId: "wamid.ai", score: 0.9, citations: [{ document_id: "doc-1", title: "Hours", url: null }], ...over });

function setup(aiConfig: Record<string, unknown>) {
  h.jobs = [];
  h.tables = {
    flows: [{ id: "f1", status: "active", created_at: "2026-01-01T00:00:00Z", account_id: "acct-1", user_id: "u-1",
      fallback_policy: {}, entry_node_id: "start", test_numbers: [], trigger_type: "keyword", trigger_config: { keywords: ["help"] } }],
    flow_nodes: [
      { flow_id: "f1", node_key: "start", node_type: "start", config: { next_node_key: "ask_ai" } },
      { flow_id: "f1", node_key: "ask_ai", node_type: "ai_reply", config: { use_knowledge: true, next_node_key: "done", handoff_next: "human", ...aiConfig } },
      { flow_id: "f1", node_key: "done", node_type: "end", config: {} },
      { flow_id: "f1", node_key: "human", node_type: "handoff", config: {} },
    ],
    flow_runs: [], flow_run_events: [], messages: [],
    contacts: [{ id: "ct-1", account_id: "acct-1", phone: "15551234567" }],
    conversations: [{ id: "cv-1", account_id: "acct-1", contact_id: "ct-1", bot_paused: false }],
  };
}
const send = (text: string, id: string) => dispatchInboundToFlows({
  accountId: "acct-1", userId: "u-1", contactId: "ct-1", conversationId: "cv-1",
  message: { kind: "text", text, meta_message_id: id }, isFirstInboundMessage: false,
});
const events = (type: string) => h.tables.flow_run_events.filter((e) => e.event_type === type) as Array<{ node_key: string; payload: Record<string, unknown> }>;
const run = () => h.tables.flow_runs[0] as Record<string, unknown>;

beforeEach(() => {
  h.ai.mockReset();
  h.started.mockReset();
  h.started.mockResolvedValue(false);
});

describe("ai_reply step in the engine", () => {
  it("answers once, stores the answer, records citations without content and follows the answered port", async () => {
    setup({ var_key: "ai_answer" });
    h.ai.mockResolvedValue(answered());
    await send("help", "wamid.in.1");

    expect(h.ai).toHaveBeenCalledTimes(1);
    expect(h.ai.mock.calls[0][0]).toMatchObject({ accountId: "acct-1", userId: "u-1", conversationId: "cv-1", contactId: "ct-1",
      config: { use_knowledge: true, var_key: "ai_answer" } });
    expect(h.ai.mock.calls[0][0].intentKey).toMatch(/^flow:gen-\d+:ask_ai:0:0$/);
    const [ev] = events("ai_replied");
    expect(ev.payload).toEqual({ whatsapp_message_id: "wamid.ai", score: 0.9, turn: 1, citations: [{ document_id: "doc-1", title: "Hours", url: null }] });
    expect(JSON.stringify(h.tables.flow_run_events)).not.toContain("We open at 10.");
    expect(run().vars).toMatchObject({ ai_answer: "We open at 10." });
    expect(run().status).toBe("completed");
  });

  it("takes the handoff port with a reason code when the AI cannot answer", async () => {
    setup({});
    h.ai.mockResolvedValue({ kind: "handoff", reason: "no_answer", score: 0, citations: [] });
    await send("help", "wamid.in.1");
    expect(events("ai_handoff")[0].payload).toMatchObject({ reason: "no_answer", turn: 1 });
    expect(events("ai_replied")).toHaveLength(0);
    expect(run().status).toBe("handed_off");
  });

  it("takes the handoff port when AI is unavailable", async () => {
    setup({});
    h.ai.mockResolvedValue({ kind: "unavailable", reason: "session_closed" });
    await send("help", "wamid.in.1");
    expect(events("ai_handoff")[0].payload).toEqual({ reason: "session_closed", turn: 1 });
    expect(run().status).toBe("handed_off");
  });

  it("answers follow-ups inside the step until max_turns, each under its own intent, then moves on", async () => {
    setup({ max_turns: 3, var_key: "ai_answer", timeout_minutes: 30, after_timeout: "done" });
    h.ai.mockResolvedValueOnce(answered("one")).mockResolvedValueOnce(answered("two")).mockResolvedValueOnce(answered("three"));

    await send("help", "wamid.in.1");
    expect(run()).toMatchObject({ status: "active", current_node_key: "ask_ai" });
    expect(h.jobs.filter((j) => j.payload.kind === "timeout")).toHaveLength(1);

    const second = await send("and on Sunday?", "wamid.in.2");
    expect(second).toMatchObject({ consumed: true, outcome: "waiting" });
    expect(h.ai.mock.calls[1][0].intentKey).toBe(`flow-ai:${run().id}:wamid.in.2`);
    expect(run()).toMatchObject({ status: "active", current_node_key: "ask_ai", reprompt_count: 1, transition_seq: 1 });
    expect(run().vars).toMatchObject({ ai_answer: "two" });
    // The old timeout is now stale (its seq moved on); a fresh one counts from this answer.
    expect(h.jobs.filter((j) => j.payload.kind === "timeout").map((j) => j.payload.seq)).toEqual([0, 1]);

    await send("thanks", "wamid.in.3");
    expect(h.ai).toHaveBeenCalledTimes(3);
    expect(events("ai_replied").map((e) => e.payload.turn)).toEqual([1, 2, 3]);
    expect(run().vars).toMatchObject({ ai_answer: "three" });
    expect(run().status).toBe("completed");
  });

  it("leaves the step through handoff on a follow-up the AI cannot answer", async () => {
    setup({ max_turns: 5 });
    h.ai.mockResolvedValueOnce(answered()).mockResolvedValueOnce({ kind: "handoff", reason: "keyword", score: 0, citations: [] });
    await send("help", "wamid.in.1");
    await send("I want a person", "wamid.in.2");
    expect(events("ai_handoff")[0].payload).toMatchObject({ reason: "keyword", turn: 2 });
    expect(run().status).toBe("handed_off");
  });

  it("ignores a replayed follow-up", async () => {
    setup({ max_turns: 3 });
    h.ai.mockResolvedValue(answered());
    await send("help", "wamid.in.1");
    await send("more", "wamid.in.2");
    await send("more", "wamid.in.2");
    expect(h.ai).toHaveBeenCalledTimes(2);
  });

  it.each(["send_uncertain", "turn_uncertain"] as const)("ends the run for reconciliation on %s instead of following the handoff port", async (reason) => {
    setup({ max_turns: 3 });
    h.ai.mockResolvedValue({ kind: "unavailable", reason });
    await send("help", "wamid.in.1");
    expect(events("ai_handoff")).toHaveLength(0);
    expect(events("error").map((e) => e.payload)).toEqual([{ reason: `ai_reply_${reason}`, turn: 1 }]);
    expect(run()).toMatchObject({ status: "failed" });
    expect(h.jobs.filter((j) => j.payload.kind === "timeout")).toHaveLength(0);
  });

  it("ends the run on an uncertain follow-up send without counting on to the next node", async () => {
    setup({ max_turns: 3 });
    h.ai.mockResolvedValueOnce(answered()).mockResolvedValueOnce({ kind: "unavailable", reason: "send_uncertain" });
    await send("help", "wamid.in.1");
    const result = await send("and Sunday?", "wamid.in.2");
    expect(result).toMatchObject({ consumed: true, outcome: "completed" });
    expect(events("ai_handoff")).toHaveLength(0);
    expect(run().status).toBe("failed");
  });

  it("does not let a photo or sticker use up an AI turn or fire the fallback", async () => {
    setup({ max_turns: 3 });
    h.tables.flows[0].fallback_policy = { on_unknown_reply: "reprompt", fallback_message: "Sorry, I did not get that." };
    h.ai.mockResolvedValue(answered());
    await send("help", "wamid.in.1");
    const photo = await dispatchInboundToFlows({
      accountId: "acct-1", userId: "u-1", contactId: "ct-1", conversationId: "cv-1",
      message: { kind: "media", media_type: "image", url: "https://media.example/p.jpg", caption: "", meta_message_id: "wamid.in.photo" },
      isFirstInboundMessage: false,
    });
    expect(photo).toMatchObject({ consumed: true, outcome: "waiting" });
    expect(run()).toMatchObject({ status: "active", current_node_key: "ask_ai", reprompt_count: 0 });
    expect(events("fallback_fired")).toHaveLength(0);
    await send("and Sunday?", "wamid.in.2");
    expect(run()).toMatchObject({ status: "active", current_node_key: "ask_ai" });
    await send("and Monday?", "wamid.in.3");
    expect(events("ai_replied").map((e) => e.payload.turn)).toEqual([1, 2, 3]);
    expect(run().status).toBe("completed");
  });

  it("replays a retried follow-up without claiming or counting the turn again", async () => {
    setup({ max_turns: 3 });
    h.ai.mockResolvedValue(answered());
    await send("help", "wamid.in.1");
    await send("and Sunday?", "wamid.in.2");
    expect(run()).toMatchObject({ reprompt_count: 1, transition_seq: 1 });
    // The worker stopped after the turn began, and its reply_received mark was lost: the job retries the same inbound.
    h.tables.flow_run_events = h.tables.flow_run_events.filter((e) => !(e.event_type === "reply_received" && (e.payload as Record<string, unknown>).meta_message_id === "wamid.in.2"));
    h.started.mockResolvedValueOnce(true);
    await send("and Sunday?", "wamid.in.2");
    expect(h.started).toHaveBeenLastCalledWith("acct-1", `flow-ai:${run().id}:wamid.in.2`);
    expect(run()).toMatchObject({ status: "active", reprompt_count: 1, transition_seq: 1 });
    expect(events("ai_replied").map((e) => e.payload.turn)).toEqual([1, 2, 2]);
    expect(h.ai.mock.calls.at(-1)![0].intentKey).toBe(`flow-ai:${run().id}:wamid.in.2`);
    await send("thanks", "wamid.in.3");
    expect(run().status).toBe("completed");
  });
});

const nodes = (cfg: Record<string, unknown>) => [
  { node_key: "start", node_type: "start", config: { next_node_key: "ask_ai" } },
  { node_key: "ask_ai", node_type: "ai_reply", config: { next_node_key: "done", handoff_next: "human", ...cfg } },
  { node_key: "done", node_type: "end", config: {} },
  { node_key: "human", node_type: "handoff", config: {} },
];
const flow = { name: "AI", trigger_type: "keyword" as const, trigger_config: { keywords: ["help"] }, entry_node_id: "start" };
const keys = new Set(["start", "ask_ai", "done", "human"]);

describe("ai_reply authoring", () => {
  it("accepts a complete step and warns at activation when AI is not set up", () => {
    expect(validateFlowForActivation(flow, nodes({ use_knowledge: true, max_turns: 2, var_key: "answer" }))).toEqual([]);
    const issues = validateFlowForActivation(flow, nodes({}), { aiConfigured: false });
    expect(issues).toEqual([expect.objectContaining({ severity: "warning", node_key: "ask_ai" })]);
    expect(validateFlowForActivation(flow, nodes({}), { aiConfigured: true })).toEqual([]);
  });

  it("requires both ports and checks limits", () => {
    const fields = aiReplyIssues({ node_key: "ask_ai", config: { next_node_key: "", handoff_next: "gone", instructions: "x".repeat(2001),
      max_turns: 11, confidence_threshold: 1.5, var_key: "1bad", use_knowledge: "yes" } }, keys).map((i) => i.field);
    expect(fields.sort()).toEqual(["confidence_threshold", "handoff_next", "instructions", "max_turns", "next_node_key", "use_knowledge", "var_key"]);
  });

  it("allows a reply timeout only when the step waits for follow-ups", () => {
    const once = validateFlowForActivation(flow, nodes({ timeout_minutes: 10, after_timeout: "done" }));
    expect(once.map((i) => i.field)).toContain("timeout_minutes");
    expect(validateFlowForActivation(flow, nodes({ max_turns: 3, timeout_minutes: 10, after_timeout: "done" }))).toEqual([]);
  });

  it("flags a loop of one-turn AI steps that would message forever", () => {
    const loop = [
      { node_key: "start", node_type: "start", config: { next_node_key: "a" } },
      { node_key: "a", node_type: "ai_reply", config: { next_node_key: "b", handoff_next: "b" } },
      { node_key: "b", node_type: "ai_reply", config: { next_node_key: "a", handoff_next: "a" } },
    ];
    expect(validateFlowForActivation(flow, loop).some((i) => i.node_key === "a" && i.severity === "error")).toBe(true);
  });

  it("counts the stored answer as a collected variable", () => {
    const withUse = [...nodes({ var_key: "ai_answer" }).slice(0, 2),
      { node_key: "done", node_type: "send_message", config: { text: "You asked: {{vars.ai_answer}}", next_node_key: "end" } },
      { node_key: "human", node_type: "handoff", config: {} }, { node_key: "end", node_type: "end", config: {} }];
    expect(validateFlowForActivation(flow, withUse).filter((i) => i.severity === "warning")).toEqual([]);
  });

  it("draws Answered and Handoff ports, and a Timeout port only with follow-ups", () => {
    const node = (cfg: Record<string, unknown>): BuilderNode => ({ node_key: "ask_ai", node_type: "ai_reply", config: { next_node_key: "done", handoff_next: "human", ...cfg } });
    const all = (cfg: Record<string, unknown>): BuilderNode[] => [node(cfg), { node_key: "done", node_type: "end", config: {} }, { node_key: "human", node_type: "handoff", config: {} }];
    expect(outgoingSlots(node({})).map((s) => s.id)).toEqual(["answered", "handoff"]);
    expect(outgoingSlots(node({ max_turns: 2, timeout_minutes: 5 })).map((s) => s.id)).toEqual(["answered", "handoff", "timeout"]);
    expect(deriveCanvasEdges(all({})).map((e) => `${e.sourceHandle}->${e.target}`).sort()).toEqual(["answered->done", "handoff->human"]);
    expect(applyEdgeConnection(node({}), "answered", "x")).toEqual({ next_node_key: "x" });
    expect(applyEdgeConnection(node({}), "handoff", "x")).toEqual({ handoff_next: "x" });
    const unlinked = unlinkNodeReferences(all({}), "human")[0].config;
    expect(unlinked).toMatchObject({ next_node_key: "done", handoff_next: "" });
    expect(unlinkNodeReferences(all({}), "done")[0].config).toMatchObject({ next_node_key: "", handoff_next: "human" });
  });

  it("previews a simulated answer and lets the author pick the outcome", () => {
    const builder = nodes({ var_key: "ai_answer" }) as BuilderNode[];
    const state = startPreview(builder, "start");
    expect(state.messages.at(-1)).toMatchObject({ from: "system", note: "ai_reply", detail: "ai_answer" });
    expect(state.waiting?.options.map((o) => o.id)).toEqual(["answered", "handoff"]);
    expect(choose(state, "answered").messages.at(-1)).toMatchObject({ note: "end" });
    expect(choose(state, "handoff").messages.at(-1)).toMatchObject({ note: "handoff" });
  });

  it("reads max_turns defensively", () => {
    expect([undefined, 0, 1, 2.5, 11, "3"].map((m) => aiReplyMaxTurns({ max_turns: m }))).toEqual([1, 1, 1, 1, 1, 1]);
    expect(aiReplyMaxTurns({ max_turns: 10 })).toBe(10);
  });
});
