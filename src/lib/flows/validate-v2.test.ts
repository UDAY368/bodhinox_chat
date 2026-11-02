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

describe("Phase 4.2 nodes", () => {
  const FLOW_ID = "00000000-0000-4000-8000-000000000001";
  it("accepts a well-formed template, API request, assignment and connect", () => {
    const nodes: N[] = [
      start("tpl"),
      { node_key: "tpl", node_type: "send_template", config: { template_name: "order", body_params: ["{{vars.x}}"],
        buttons: [{ index: 0, reply_id: "tpl_1", title: "Yes", next_node_key: "api" }], timeout_minutes: 60, after_timeout: "done" } },
      { node_key: "api", node_type: "api_request", config: { method: "POST", url: "https://api.example.com/{{vars.x}}",
        headers: [{ key: "Authorization", value: "Bearer {{workspace.token}}" }], body: '{"s": "{{vars.x}}", "c": "{{contact.name}}"}',
        mappings: [{ path: "data.id", var_key: "order_id" }], routes: [{ status: "2xx", next_node_key: "assign" }], fallback_next: "done" } },
      { node_key: "assign", node_type: "assign_agent", config: { mode: "round_robin", next_node_key: "say" } },
      { node_key: "say", node_type: "send_message", config: { text: "{{vars.order_id}}", next_node_key: "go" } },
      { node_key: "go", node_type: "connect_flow", config: { flow_id: FLOW_ID } },
      end,
    ];
    expect(errors(nodes)).toEqual([]);
  });

  it("rejects bad template, API, assignment and connect settings", () => {
    const nodes: N[] = [
      start("tpl"),
      { node_key: "tpl", node_type: "send_template", config: { template_name: "", body_params: [" "],
        buttons: [{ index: 0, reply_id: "qr_x", title: "Yes", next_node_key: "" }] } },
      { node_key: "api", node_type: "api_request", config: { method: "TRACE", url: "ftp://x", body: "{bad",
        headers: [{ key: "Bad Header", value: "x" }], routes: [{ status: "20", next_node_key: "done" }] } },
      { node_key: "assign", node_type: "assign_agent", config: { mode: "specific", next_node_key: "done" } },
      { node_key: "go", node_type: "connect_flow", config: { flow_id: "nope" } },
      end,
    ];
    expect(errors(nodes).map((i) => `${i.node_key}.${i.field}`).sort()).toEqual([
      "api.body", "api.fallback_next", "api.headers.0", "api.method", "api.routes.0.status", "api.url",
      "assign.agent_id", "go.flow_id",
      "tpl.body_params.0", "tpl.buttons.0.next_node_key", "tpl.buttons.0.reply_id", "tpl.template_name",
    ]);
  });

  it("rejects a reply timeout on a template with no buttons, and a loop of API calls", () => {
    const nodes: N[] = [
      start("tpl"),
      { node_key: "tpl", node_type: "send_template", config: { template_name: "x", next_node_key: "api", timeout_minutes: 5, after_timeout: "done" } },
      { node_key: "api", node_type: "api_request", config: { method: "GET", url: "https://x.example", fallback_next: "tpl" } },
      end,
    ];
    const found = errors(nodes);
    expect(found.some((i) => i.node_key === "tpl" && i.field === "timeout_minutes")).toBe(true);
    expect(found.some((i) => i.message.includes("tpl") && i.message.includes("api") && !i.field)).toBe(true);
  });

  it("gives the API request a port per route plus the fallback", () => {
    const node: BuilderNode = { node_key: "api", node_type: "api_request", config: {
      routes: [{ status: "200", next_node_key: "a" }, { status: "4xx", next_node_key: "b" }], fallback_next: "c" } };
    expect(outgoingSlots(node).map((s) => s.id)).toEqual(["route:0", "route:1", "fallback"]);
    expect(applyEdgeConnection(node, "route:1", "z")).toEqual({ routes: [{ status: "200", next_node_key: "a" }, { status: "4xx", next_node_key: "z" }] });
    const [cleared] = unlinkNodeReferences([node], "c");
    expect(cleared.config.fallback_next).toBe("");
    const tpl: BuilderNode = { node_key: "t", node_type: "send_template", config: { buttons: [{ index: 1, reply_id: "tpl_2", title: "No", next_node_key: "a" }] } };
    expect(outgoingSlots(tpl).map((s) => s.id)).toEqual(["button:tpl_2"]);
  });
});

it("requires body placeholders inside quotes, and ignores the body of a GET", () => {
  const api = (method: string, body: string): N[] => [start("api"),
    { node_key: "api", node_type: "api_request", config: { method, url: "https://x.example", body, fallback_next: "done" } }, end];
  expect(errors(api("POST", '{"n": {{vars.x}}}')).map((i) => i.field)).toEqual(["body"]);
  expect(errors(api("POST", '{"n": "{{other.x}}"}')).map((i) => i.field)).toEqual([]);
  expect(errors(api("POST", '{"n": {{other}}}')).map((i) => i.field)).toEqual(["body"]);
  expect(errors(api("GET", "{leftover"))).toEqual([]);
});

it("rejects a flow that restarts itself without waiting for the customer", () => {
  const self = { ...flow, id: "00000000-0000-4000-8000-000000000009" };
  const loop: N[] = [start("say"), { node_key: "say", node_type: "send_message", config: { text: "hi", next_node_key: "again" } },
    { node_key: "again", node_type: "connect_flow", config: { flow_id: self.id } }];
  expect(validateFlowForActivation(self, loop).some((i) => i.severity === "error" && i.message.includes("again"))).toBe(true);
  const menu: N[] = [start("ask"), { node_key: "ask", node_type: "collect_input", config: { prompt_text: "q", var_key: "a", next_node_key: "again" } },
    { node_key: "again", node_type: "connect_flow", config: { flow_id: self.id } }];
  expect(validateFlowForActivation(self, menu).filter((i) => i.severity === "error")).toEqual([]);
});

describe("Phase 4.3 triggers and fallback message", () => {
  const nodes: N[] = [start("done"), end];
  const triggerErrors = (trigger_type: string, trigger_config: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    validateFlowForActivation({ ...flow, trigger_type: trigger_type as never, trigger_config, ...extra }, nodes)
      .filter((i) => i.severity === "error").map((i) => i.field);

  it("checks regex patterns instead of keywords", () => {
    expect(triggerErrors("keyword", { keywords: [], match_type: "regex", pattern: "order\d+" })).toEqual([]);
    expect(triggerErrors("keyword", { keywords: [], match_type: "regex", pattern: "(" })).toEqual(["trigger_config.pattern"]);
    expect(triggerErrors("keyword", { keywords: [], match_type: "regex" })).toEqual(["trigger_config.pattern"]);
  });

  it("requires a template for a template-reply trigger", () => {
    expect(triggerErrors("template_reply", { template_name: "order_update", buttons: ["Track"] })).toEqual([]);
    expect(triggerErrors("template_reply", { template_name: "" })).toEqual(["trigger_config.template_name"]);
    expect(triggerErrors("template_reply", { template_name: "x", buttons: [1] })).toEqual(["trigger_config.buttons"]);
  });

  it("rejects a fallback message with nothing to send or too much text", () => {
    const withMessage = (fallback_message: unknown) => triggerErrors("keyword", { keywords: ["hi"] }, { fallback_policy: { fallback_message } });
    expect(withMessage({ text: "Sorry?" })).toEqual([]);
    expect(withMessage({ text: "", media_type: "image", media_url: "https://cdn.example/a.png" })).toEqual([]);
    expect(withMessage({ text: "" })).toEqual(["fallback_policy.fallback_message"]);
    expect(withMessage({ text: "x".repeat(1025) })).toEqual(["fallback_policy.fallback_message"]);
  });
});
