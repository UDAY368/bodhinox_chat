import { describe, expect, it } from "vitest";
import { validateFlowForActivation } from "./validate";
import { applyEdgeConnection, deriveCanvasEdges, outgoingSlots, unlinkNodeReferences } from "./edges";
import type { BuilderNode } from "@/components/flows/shared";

const flow = { name: "F", trigger_type: "keyword" as const, trigger_config: { keywords: ["hi"] }, entry_node_id: "start" };
type N = { node_key: string; node_type: string; config: Record<string, unknown> };
const start = (next: string): N => ({ node_key: "start", node_type: "start", config: { next_node_key: next } });
const end: N = { node_key: "done", node_type: "end", config: {} };
const errors = (nodes: N[], f: Record<string, unknown> = {}) =>
  validateFlowForActivation({ ...flow, ...f }, nodes).filter((i) => i.severity === "error");

describe("validation of the new nodes", () => {
  it("accepts a flow that uses every new node and setting", () => {
    const nodes: N[] = [
      start("ask"),
      { node_key: "ask", node_type: "collect_input", config: {
        prompt_text: "Age?", var_key: "age", validation: "number", min: 1, max: 120, next_node_key: "where",
        max_attempts: 3, error_text: "A number please", exhausted_next: "done", skip_label: "Skip", skip_next: "where",
        timeout_minutes: 60, after_timeout: "done", delay_seconds: 5 } },
      { node_key: "where", node_type: "ask_location", config: { prompt_text: "Where?", var_key: "loc", next_node_key: "pic" } },
      { node_key: "pic", node_type: "ask_media", config: { prompt_text: "Photo?", var_key: "pic", media_types: ["image"], next_node_key: "addr" } },
      { node_key: "addr", node_type: "ask_address", config: { prompt_text: "Address?", var_key: "addr", next_node_key: "set" } },
      { node_key: "set", node_type: "set_attribute", config: { target: "contact_field", key: "company", value: "{{vars.addr_city}}", next_node_key: "check" } },
      { node_key: "check", node_type: "condition", config: {
        match: "all", timezone: "Asia/Kolkata",
        rules: [
          { subject: "var", subject_key: "age", operator: "between", value: "18", value2: "60" },
          { subject: "time", subject_key: "", operator: "between", value: "09:00", value2: "18:00" },
          { subject: "var", subject_key: "loc_latitude", operator: "present" },
        ],
        true_next: "done", false_next: "done" } },
      end,
    ];
    expect(validateFlowForActivation(flow, nodes)).toEqual([]);
  });

  it("rejects bad timing settings", () => {
    const nodes: N[] = [
      { node_key: "start", node_type: "start", config: { next_node_key: "say", delay_seconds: 5 } },
      { node_key: "say", node_type: "send_message", config: { text: "x", next_node_key: "ask", delay_seconds: 90_000, timeout_minutes: 5 } },
      { node_key: "ask", node_type: "collect_input", config: { prompt_text: "q", var_key: "a", next_node_key: "done", timeout_minutes: 5 } },
      end,
    ];
    expect(errors(nodes).map((i) => `${i.node_key}.${i.field}`).sort())
      .toEqual(["ask.after_timeout", "say.delay_seconds", "say.timeout_minutes", "start.delay_seconds"]);
  });

  it("warns when a reply timeout outlives the run's inactivity limit", () => {
    const nodes: N[] = [start("ask"), { node_key: "ask", node_type: "collect_input", config: {
      prompt_text: "q", var_key: "a", next_node_key: "done", timeout_minutes: 120, after_timeout: "done" } }, end];
    const issues = validateFlowForActivation({ ...flow, fallback_policy: { on_timeout_hours: 1 } }, nodes);
    expect(issues).toEqual([expect.objectContaining({ severity: "warning", field: "timeout_minutes" })]);
  });

  it("checks question, attribute and rule fields", () => {
    const nodes: N[] = [
      start("ask"),
      { node_key: "ask", node_type: "collect_input", config: { prompt_text: "q", var_key: "a", next_node_key: "loc", validation: "number", min: 5, max: 1, max_attempts: 11, skip_label: "x".repeat(21) } },
      { node_key: "loc", node_type: "ask_location", config: { prompt_text: "q", var_key: "l", next_node_key: "set", skip_label: "Skip" } },
      { node_key: "set", node_type: "set_attribute", config: { target: "contact_field", key: "phone", value: "x", next_node_key: "check" } },
      { node_key: "check", node_type: "condition", config: { rules: [
        { subject: "time", subject_key: "", operator: "between", value: "9am", value2: "" },
        { subject: "var", subject_key: "a", operator: "gt" },
      ], true_next: "done", false_next: "done" } },
      end,
    ];
    expect(errors(nodes).map((i) => `${i.node_key}.${i.field}`).sort()).toEqual([
      "ask.max_attempts", "ask.min", "ask.skip_label", "ask.skip_next",
      "check.rules.0.value", "check.rules.0.value2", "check.rules.1.value",
      "loc.skip_label", "loc.skip_next", "set.key",
    ]);
  });

  it("counts the new ports for reachability and new producers for variables", () => {
    const nodes: N[] = [
      start("ask"),
      { node_key: "ask", node_type: "ask_location", config: { prompt_text: "q", var_key: "loc", next_node_key: "done", timeout_minutes: 5, after_timeout: "late" } },
      { node_key: "late", node_type: "send_message", config: { text: "{{vars.loc_latitude}}", next_node_key: "done" } },
      end,
    ];
    expect(validateFlowForActivation(flow, nodes)).toEqual([]);
  });

  it("treats set_attribute as auto-advancing in cycle detection, delays included", () => {
    const nodes: N[] = [
      start("a"),
      { node_key: "a", node_type: "set_attribute", config: { target: "var", key: "x", value: "1", next_node_key: "b" } },
      { node_key: "b", node_type: "send_message", config: { text: "spam", next_node_key: "a", delay_seconds: 60 } },
    ];
    expect(errors(nodes)).toEqual([expect.objectContaining({ node_key: expect.any(String), message: expect.stringContaining("a") })]);
  });
});

describe("canvas ports for the new settings", () => {
  const ask: BuilderNode = {
    node_key: "ask", node_type: "collect_input",
    config: { prompt_text: "q", var_key: "a", next_node_key: "done", skip_label: "Skip", skip_next: "done", max_attempts: 2, exhausted_next: "done", timeout_minutes: 5, after_timeout: "done" },
  };
  const done: BuilderNode = { node_key: "done", node_type: "end", config: {} };

  it("shows a port per enabled setting and draws its edge", () => {
    expect(outgoingSlots(ask).map((s) => s.id)).toEqual(["next", "skip", "exhausted", "timeout"]);
    expect(deriveCanvasEdges([ask, done]).map((e) => e.sourceHandle).sort()).toEqual(["exhausted", "next", "skip", "timeout"]);
    expect(outgoingSlots({ ...ask, config: { next_node_key: "done" } }).map((s) => s.id)).toEqual(["next"]);
  });

  it("connects and unlinks the optional ports", () => {
    expect(applyEdgeConnection(ask, "timeout", "other")).toEqual({ after_timeout: "other" });
    const [cleared] = unlinkNodeReferences([ask], "done");
    expect(cleared.config).toMatchObject({ next_node_key: "", skip_next: "", exhausted_next: "", after_timeout: "" });
  });
});

describe("review fixes", () => {
  it("rejects a loop that repeats through a reply timeout alone", () => {
    const nodes: N[] = [
      start("ask"),
      { node_key: "ask", node_type: "collect_input", config: { prompt_text: "q", var_key: "a", next_node_key: "done", timeout_minutes: 1, after_timeout: "nudge" } },
      { node_key: "nudge", node_type: "send_message", config: { text: "hello?", next_node_key: "ask" } },
      end,
    ];
    expect(errors(nodes).some((i) => i.message.includes("ask") && i.message.includes("nudge"))).toBe(true);
  });

  it("limits the error message when a Skip button makes it a button message", () => {
    const nodes: N[] = [start("ask"), { node_key: "ask", node_type: "collect_input", config: {
      prompt_text: "q", var_key: "a", next_node_key: "done", skip_label: "Skip", skip_next: "done", max_attempts: 2, error_text: "x".repeat(1025) } }, end];
    expect(errors(nodes)).toEqual([expect.objectContaining({ field: "error_text" })]);
  });
});
