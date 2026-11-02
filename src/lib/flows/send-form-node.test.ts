import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeTables } from "./fake-db.test-helper";

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  dispatches: new Map<string, Promise<unknown>>(),
  sendText: vi.fn<(args: { text: string }) => Promise<{ whatsapp_message_id: string }>>(async () => ({ whatsapp_message_id: "wamid.text" })),
  sendForm: vi.fn<(args: Record<string, unknown>) => Promise<{ whatsappMessageId: string; messageId: string | null }>>(
    async () => ({ whatsappMessageId: "wamid.form", messageId: "m-form" })),
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
vi.mock("@/lib/whatsapp/forms/send", () => ({ sendForm: h.sendForm, templateFlowTokens: async () => undefined }));

import { dispatchInboundToFlows, entryTriggerTexts, formAnswerVars, messageText } from "./engine";
import type { ParsedInbound } from "./types";

const FORM_ID = "4f9c2a1e-8b7d-4c3a-9e2f-1a2b3c4d5e6f";

function setup() {
  h.tables = {
    flows: [{ id: "f1", status: "active", created_at: "2026-01-01T00:00:00Z", account_id: "acct-1", user_id: "u-1",
      fallback_policy: {}, entry_node_id: "start", test_numbers: [], trigger_type: "keyword", trigger_config: { keywords: ["apply"] } }],
    flow_nodes: [
      { flow_id: "f1", node_key: "start", node_type: "start", config: { next_node_key: "form" } },
      { flow_id: "f1", node_key: "form", node_type: "send_form", config: {
        form_id: FORM_ID, cta: "Apply", body: "Hi {{vars.who}}, fill this in", var_key: "lead", next_node_key: "thanks" } },
      { flow_id: "f1", node_key: "thanks", node_type: "send_message", config: { text: "Thanks {{vars.lead_name}} ({{vars.lead_topics}})", next_node_key: "done" } },
      { flow_id: "f1", node_key: "done", node_type: "end", config: {} },
    ],
    flow_runs: [], flow_run_events: [], messages: [],
    contacts: [{ id: "ct-1", account_id: "acct-1", phone: "15551234567" }],
  };
}
const dispatch = (message: ParsedInbound) => dispatchInboundToFlows({
  accountId: "acct-1", userId: "u-1", contactId: "ct-1", conversationId: "cv-1", message, isFirstInboundMessage: false,
});
const submission = (patch: Partial<Extract<ParsedInbound, { kind: "form" }>> = {}): ParsedInbound => ({
  kind: "form", form_id: FORM_ID, answers: { name: "Ana", topics: ["a", "b"] }, summary: "Form submitted: Lead",
  trusted: true, flow_run_id: String(h.tables.flow_runs[0]?.id), node_key: "form", meta_message_id: "wamid.in.2", ...patch,
});
const events = (type: string) => h.tables.flow_run_events.filter((e) => e.event_type === type);

beforeEach(() => {
  h.dispatches.clear();
  h.sendText.mockClear();
  h.sendForm.mockClear();
  setup();
});

describe("send_form node", () => {
  it("sends the form for the run and node, then waits", async () => {
    const result = await dispatch({ kind: "text", text: "apply", meta_message_id: "wamid.in.1" });
    expect(result.outcome).toBe("started");
    expect(h.sendForm).toHaveBeenCalledTimes(1);
    const args = h.sendForm.mock.calls[0][0];
    expect(args).toMatchObject({ formId: FORM_ID, cta: "Apply", sender: "bot", role: "owner", nodeKey: "form", flowRunId: h.tables.flow_runs[0].id });
    expect(String(args.intentKey)).toMatch(/^flow:.+:form:\d+:0$/);
    expect(h.tables.flow_runs[0].current_node_key).toBe("form");
    expect(events("form_sent")).toHaveLength(1);
    expect(h.sendText).not.toHaveBeenCalled();
  });

  it("resumes on its own submission, storing the answers as variables", async () => {
    await dispatch({ kind: "text", text: "apply", meta_message_id: "wamid.in.1" });
    const result = await dispatch(submission());
    expect(result.consumed).toBe(true);
    expect(h.sendText.mock.calls.map(([a]) => a.text)).toEqual(["Thanks Ana (a, b)"]);
    const vars = h.tables.flow_runs[0].vars as Record<string, unknown>;
    expect(vars.lead).toEqual({ name: "Ana", topics: ["a", "b"] });
    expect(vars.lead_name).toBe("Ana");
    // Only field ids are logged, never the answers.
    const logged = JSON.stringify(events("form_submitted"));
    expect(logged).toContain("name");
    expect(logged).not.toContain("Ana");
  });

  it("ignores an untrusted or foreign submission without falling back", async () => {
    await dispatch({ kind: "text", text: "apply", meta_message_id: "wamid.in.1" });
    for (const patch of [{ trusted: false }, { flow_run_id: "other-run" }, { node_key: "elsewhere" }]) {
      const result = await dispatch(submission({ ...patch, meta_message_id: `wamid.${JSON.stringify(patch)}` }));
      expect(result).toMatchObject({ consumed: true, outcome: "waiting" });
    }
    expect(h.sendText).not.toHaveBeenCalled();
    expect(h.sendForm).toHaveBeenCalledTimes(1);
    expect(h.tables.flow_runs[0].current_node_key).toBe("form");
  });

  it("re-sends the form as a distinct intent when the customer types instead", async () => {
    await dispatch({ kind: "text", text: "apply", meta_message_id: "wamid.in.1" });
    await dispatch({ kind: "text", text: "what is this?", meta_message_id: "wamid.in.3" });
    expect(h.sendForm).toHaveBeenCalledTimes(2);
    const keys = h.sendForm.mock.calls.map(([a]) => a.intentKey);
    expect(new Set(keys).size).toBe(2);
  });

  it("fails the run when the form cannot be sent", async () => {
    h.sendForm.mockRejectedValueOnce(new Error("Form not published"));
    await dispatch({ kind: "text", text: "apply", meta_message_id: "wamid.in.1" });
    expect(h.tables.flow_runs[0].status).toBe("failed");
    expect(h.tables.flow_runs[0].end_reason).toBe("send_form_failed");
  });
});

describe("form submissions as inbound messages", () => {
  it("never start a flow by keyword and read as their summary", () => {
    const message = { kind: "form", form_id: null, answers: {}, summary: "apply now", trusted: false, flow_run_id: null, node_key: null, meta_message_id: "x" } as const;
    expect(entryTriggerTexts(message)).toEqual([]);
    expect(messageText(message)).toBe("apply now");
  });

  it("flatten answers into var_key_field text", () => {
    expect(formAnswerVars("f", { a: "x", b: 3, c: true, d: ["p", "q"] })).toEqual({
      f: { a: "x", b: 3, c: true, d: ["p", "q"] }, f_a: "x", f_b: "3", f_c: "true", f_d: "p, q",
    });
  });
});
