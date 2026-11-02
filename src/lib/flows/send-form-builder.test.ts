import { describe, expect, it } from "vitest";
import type { BuilderNode } from "@/components/flows/shared";
import { applyEdgeConnection, deriveCanvasEdges, outgoingSlots, unlinkNodeReferences } from "./edges";
import { choose, startPreview } from "./preview";
import { sendFormIssues, validateFlowForActivation, type FlowFormLookup } from "./validate";

const FORM = "4f9c2a1e-8b7d-4c3a-9e2f-1a2b3c4d5e6f";
const formNode = (config: Record<string, unknown> = {}): BuilderNode => ({
  node_key: "ask",
  node_type: "send_form",
  config: { form_id: FORM, cta: "Open form", body: "Please fill this in", var_key: "lead", next_node_key: "thanks", ...config },
});
const flowNodes = (config: Record<string, unknown> = {}): BuilderNode[] => [
  { node_key: "start", node_type: "start", config: { next_node_key: "ask" } },
  formNode(config),
  { node_key: "thanks", node_type: "send_message", config: { text: "Thanks {{vars.lead_email}}", next_node_key: "done" } },
  { node_key: "late", node_type: "send_message", config: { text: "Too late", next_node_key: "done" } },
  { node_key: "done", node_type: "end", config: {} },
];
const flow = { name: "Leads", trigger_type: "keyword" as const, trigger_config: { keywords: ["hi"] }, entry_node_id: "start" };
const keys = new Set(["start", "ask", "thanks", "late", "done"]);
const errors = (issues: Array<{ severity: string; field?: string }>) => issues.filter((i) => i.severity === "error").map((i) => i.field);

describe("send_form validation", () => {
  it("accepts a complete step", () => {
    expect(sendFormIssues(formNode(), keys)).toEqual([]);
  });

  it("flags each missing or oversize setting", () => {
    expect(errors(sendFormIssues(formNode({ form_id: "", cta: "", body: "", var_key: "bad key", next_node_key: "" }), keys)))
      .toEqual(["form_id", "cta", "body", "var_key", "next_node_key"]);
    expect(errors(sendFormIssues(formNode({ cta: "x".repeat(31), body: "x".repeat(1025), header: "x".repeat(61), footer: "x".repeat(61) }), keys)))
      .toEqual(["cta", "body", "header", "footer"]);
    expect(errors(sendFormIssues(formNode({ next_node_key: "nowhere" }), keys))).toEqual(["next_node_key"]);
  });

  it("requires the form to exist and be published when the server knows the forms", () => {
    const published: FlowFormLookup = new Map([[FORM, { status: "published", fields: ["email"] }]]);
    const draft: FlowFormLookup = new Map([[FORM, { status: "draft", fields: [] }]]);
    expect(errors(sendFormIssues(formNode(), keys, published))).toEqual([]);
    expect(errors(sendFormIssues(formNode(), keys, draft))).toEqual(["form_id"]);
    expect(errors(sendFormIssues(formNode(), keys, new Map()))).toEqual(["form_id"]);
  });

  it("blocks activation for an unpublished form and counts its fields as variables", () => {
    const draft = validateFlowForActivation(flow, flowNodes(), { forms: new Map([[FORM, { status: "draft", fields: ["email"] }]]) });
    expect(draft.some((i) => i.severity === "error" && i.node_key === "ask" && i.field === "form_id")).toBe(true);
    const ok = validateFlowForActivation(flow, flowNodes(), { forms: new Map([[FORM, { status: "published", fields: ["email"] }]]) });
    expect(ok.filter((i) => i.severity === "error")).toEqual([]);
    const varWarning = (issues: typeof ok) => issues.some((i) => i.severity === "warning" && i.node_key === "thanks" && i.field === "text");
    expect(varWarning(ok)).toBe(false);
    // Without the form, the builder cannot know lead_email is collected.
    expect(varWarning(validateFlowForActivation(flow, flowNodes()))).toBe(true);
  });

  it("allows a reply timeout with its port", () => {
    const issues = validateFlowForActivation(flow, flowNodes({ timeout_minutes: 30, after_timeout: "late" }));
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
  });
});

describe("send_form on the canvas", () => {
  it("has a next port, plus a timeout port once set", () => {
    expect(outgoingSlots(formNode()).map((s) => s.id)).toEqual(["next"]);
    expect(outgoingSlots(formNode({ timeout_minutes: 10, after_timeout: "late" })).map((s) => s.id)).toEqual(["next", "timeout"]);
  });

  it("draws, connects and unlinks its edges", () => {
    const nodes = flowNodes({ timeout_minutes: 10, after_timeout: "late" });
    const fromAsk = deriveCanvasEdges(nodes).filter((e) => e.source === "ask").map((e) => [e.sourceHandle, e.target]);
    expect(fromAsk).toEqual([["timeout", "late"], ["next", "thanks"]]);
    expect(applyEdgeConnection(formNode(), "next", "late")).toEqual({ next_node_key: "late" });
    const unlinked = unlinkNodeReferences(nodes, "thanks").find((n) => n.node_key === "ask")!;
    expect(unlinked.config.next_node_key).toBe("");
  });
});

describe("send_form in the preview", () => {
  it("shows the form bubble and continues on a simulated submit", () => {
    const state = startPreview(flowNodes(), "start");
    const bubble = state.messages.at(-1)!;
    expect(bubble).toMatchObject({ from: "bot", text: "Please fill this in", buttons: ["Open form"] });
    expect(state.waiting?.simulate.map((o) => o.id)).toEqual(["submit"]);
    const after = choose(state, "submit");
    expect(after.messages.some((m) => m.from === "customer" && m.shared === "form")).toBe(true);
    expect(after.messages.some((m) => m.text === "Thanks {{vars.lead_email}}")).toBe(true);
  });

  it("offers the timeout port and treats typed text as off-script", () => {
    const state = startPreview(flowNodes({ timeout_minutes: 5, after_timeout: "late" }), "start");
    expect(state.waiting?.simulate.map((o) => o.id)).toEqual(["submit", "timeout"]);
    const typed = choose(state, "text", "hello");
    expect(typed.messages.some((m) => m.note === "fallback")).toBe(true);
  });
});
