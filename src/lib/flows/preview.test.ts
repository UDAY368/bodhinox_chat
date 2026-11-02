import { describe, expect, it } from "vitest";

import type { BuilderNode } from "@/components/flows/shared";
import { choose, PREVIEW_STEP_LIMIT, previewAcceptsText, startPreview } from "./preview";

const n = (node_key: string, node_type: BuilderNode["node_type"], config: Record<string, unknown>): BuilderNode => ({ node_key, node_type, config });

describe("flow preview", () => {
  it("plays a linear message chain to the end, leaving placeholders literal", () => {
    const state = startPreview([
      n("start", "start", { next_node_key: "hi" }),
      n("hi", "send_message", { text: "Hi {{vars.name}}", next_node_key: "pic" }),
      n("pic", "send_media", { media_type: "document", caption: "Menu", filename: "menu.pdf", next_node_key: "bye" }),
      n("bye", "end", {}),
    ], "start");
    expect(state.ended).toBe(true);
    expect(state.waiting).toBeNull();
    expect(state.messages.map((m) => [m.from, m.text ?? m.note])).toEqual([
      ["bot", "Hi {{vars.name}}"],
      ["bot", "Menu"],
      ["system", "end"],
    ]);
    expect(state.messages[1].media).toEqual({ type: "document", filename: "menu.pdf" });
  });

  it("waits on buttons and follows the chosen reply", () => {
    const nodes = [
      n("ask", "send_buttons", { text: "Pick", buttons: [
        { reply_id: "yes", title: "Yes", next_node_key: "y" },
        { reply_id: "no", title: "No", next_node_key: "x" },
      ] }),
      n("y", "send_message", { text: "Great", next_node_key: "" }),
      n("x", "send_message", { text: "Sad", next_node_key: "" }),
    ];
    const first = startPreview(nodes, "ask");
    expect(first.waiting).toEqual({ kind: "buttons", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }], simulate: [] });
    expect(first.messages[0].buttons).toEqual(["Yes", "No"]);

    const after = choose(first, "no");
    expect(after.messages.slice(1).map((m) => [m.from, m.text ?? m.note])).toEqual([
      ["customer", "No"],
      ["bot", "Sad"],
      ["system", "dead_end"],
    ]);
    expect(after.ended).toBe(true);
    // An unknown choice changes nothing.
    expect(choose(first, "maybe")).toBe(first);
  });

  it("follows list rows", () => {
    const state = startPreview([
      n("menu", "send_list", { text: "Menu", button_label: "Open", sections: [{ rows: [{ reply_id: "a", title: "Apples", next_node_key: "done" }] }] }),
      n("done", "end", {}),
    ], "menu");
    expect(state.waiting?.kind).toBe("list");
    expect(state.messages[0].list).toEqual({ button: "Open", rows: [{ id: "a", title: "Apples", description: undefined }] });
    expect(choose(state, "a").messages.map((m) => m.text ?? m.note)).toEqual(["Menu", "Apples", "end"]);
  });

  it("accepts a typed answer to a question, or its skip button", () => {
    const nodes = [
      n("q", "collect_input", { prompt_text: "Your name?", var_key: "name", skip_label: "Skip", skip_next: "skipped", next_node_key: "thanks" }),
      n("thanks", "send_message", { text: "Thanks {{vars.name}}", next_node_key: "" }),
      n("skipped", "handoff", {}),
    ];
    const first = startPreview(nodes, "q");
    expect(first.waiting).toEqual({ kind: "text", options: [{ id: "skip", label: "Skip" }], simulate: [] });
    expect(choose(first, "text", "   ")).toBe(first);

    const typed = choose(first, "text", "Ana");
    expect(typed.messages.slice(1).map((m) => [m.from, m.text ?? m.note])).toEqual([
      ["customer", "Ana"],
      ["bot", "Thanks {{vars.name}}"],
      ["system", "dead_end"],
    ]);
    expect(choose(first, "skip").messages.slice(1).map((m) => m.text ?? m.note)).toEqual(["Skip", "handoff"]);
  });

  it("lets the author pick a condition branch without a customer bubble", () => {
    const nodes = [
      n("c", "condition", { subject: "var", subject_key: "vip", true_next: "t", false_next: "f" }),
      n("t", "send_message", { text: "VIP", next_node_key: "" }),
      n("f", "send_message", { text: "Regular", next_node_key: "" }),
    ];
    const first = startPreview(nodes, "c");
    expect(first.waiting).toEqual({ kind: "branch", options: [{ id: "true", label: "true" }, { id: "false", label: "false" }], simulate: [] });
    const after = choose(first, "false");
    expect(after.messages.map((m) => [m.from, m.text ?? m.note])).toEqual([
      ["system", "condition"],
      ["bot", "Regular"],
      ["system", "dead_end"],
    ]);
  });

  it("notes silent steps and delays and ends at a handoff", () => {
    const state = startPreview([
      n("tag", "set_tag", { tag_id: "t1", next_node_key: "wait", delay_seconds: 30 }),
      n("wait", "send_message", { text: "Connecting you", next_node_key: "agent", delay_seconds: 5 }),
      n("agent", "handoff", { note: "internal" }),
      n("never", "send_message", { text: "unreachable", next_node_key: "" }),
    ], "tag");
    expect(state.ended).toBe(true);
    expect(state.messages.map((m) => m.note ?? m.text)).toEqual(["delay", "set_tag", "delay", "Connecting you", "handoff"]);
    expect(state.messages[0].detail).toBe("30");
  });

  it("stops a cycle after the step limit", () => {
    const state = startPreview([
      n("a", "send_message", { text: "ping", next_node_key: "b" }),
      n("b", "send_message", { text: "pong", next_node_key: "a" }),
    ], "a");
    expect(state.ended).toBe(true);
    expect(state.messages).toHaveLength(PREVIEW_STEP_LIMIT + 1);
    expect(state.messages.at(-1)?.note).toBe("loop");
  });

  it("gives an empty, ended preview without a valid entry", () => {
    const nodes = [n("a", "send_message", { text: "hi", next_node_key: "" })];
    for (const entry of [null, "missing"]) {
      const state = startPreview(nodes, entry);
      expect(state).toMatchObject({ messages: [], waiting: null, ended: true });
    }
  });

  it("offers Skip only when the skip port is wired, as the engine does", () => {
    const unwired = startPreview([n("q", "collect_input", { prompt_text: "Name?", var_key: "name", skip_label: "Skip", next_node_key: "" })], "q");
    expect(unwired.waiting?.options).toEqual([]);
    expect(unwired.messages[0].buttons).toBeUndefined();
    expect(choose(unwired, "skip")).toBe(unwired);
  });

  it("rejects a typed reply that fails the input format, then reprompts until attempts run out", () => {
    const nodes = [
      n("q", "collect_input", { prompt_text: "Age?", var_key: "age", validation: "number", min: 18, max_attempts: 2, error_text: "A number please", exhausted_next: "gave_up", next_node_key: "ok" }),
      n("ok", "end", {}),
      n("gave_up", "handoff", {}),
    ];
    const first = startPreview(nodes, "q");
    expect(first.waiting?.simulate).toEqual([{ id: "exhausted", label: "Attempts used up" }]);

    const retry = choose(first, "text", "abc");
    expect(retry.ended).toBe(false);
    expect(retry.messages.slice(1).map((m) => [m.from, m.text ?? m.note])).toEqual([
      ["customer", "abc"],
      ["system", "invalid_answer"],
      ["bot", "A number please"],
    ]);
    // Below the minimum still counts as invalid; the second miss uses the attempts up.
    expect(choose(retry, "text", "12").messages.slice(4).map((m) => m.text ?? m.note)).toEqual(["12", "exhausted", "handoff"]);
    expect(choose(retry, "text", "21").messages.slice(4).map((m) => m.text ?? m.note)).toEqual(["21", "end"]);
  });

  it("hands an invalid reply to the flow's fallback when no retries are set", () => {
    const state = startPreview([n("q", "collect_input", { prompt_text: "Email?", var_key: "email", validation: "email", next_node_key: "" })], "q");
    const after = choose(state, "text", "not-an-email");
    expect(after.ended).toBe(true);
    expect(after.messages.slice(1).map((m) => m.text ?? m.note)).toEqual(["not-an-email", "fallback"]);
  });

  it("walks the attempts-used-up port as a simulated choice, with the fallback when it is unwired", () => {
    const wired = startPreview([
      n("q", "ask_address", { prompt_text: "Address?", var_key: "addr", max_attempts: 3, exhausted_next: "help", next_node_key: "" }),
      n("help", "handoff", {}),
    ], "q");
    const after = choose(wired, "exhausted");
    expect(after.messages.slice(1).map((m) => [m.from, m.note])).toEqual([["system", "exhausted"], ["system", "handoff"]]);

    const unwired = startPreview([n("q", "ask_address", { prompt_text: "Address?", var_key: "addr", max_attempts: 3, next_node_key: "" })], "q");
    expect(choose(unwired, "exhausted").messages.slice(1).map((m) => m.note)).toEqual(["exhausted", "fallback"]);
  });

  it("walks a wired reply-timeout port on questions, buttons and templates with quick replies", () => {
    const nodes = [
      n("b", "send_buttons", { text: "Pick", timeout_minutes: 30, after_timeout: "remind", buttons: [{ reply_id: "y", title: "Yes", next_node_key: "" }] }),
      n("remind", "send_message", { text: "Still there?", next_node_key: "" }),
      n("t", "send_template", { template_name: "promo", timeout_minutes: 5, after_timeout: "remind", buttons: [{ reply_id: "go", title: "Go", next_node_key: "" }] }),
      n("plain", "send_template", { template_name: "promo", timeout_minutes: 5, after_timeout: "remind", next_node_key: "" }),
      n("unwired", "collect_input", { prompt_text: "Name?", var_key: "name", timeout_minutes: 5, next_node_key: "" }),
    ];
    const buttons = startPreview(nodes, "b");
    expect(buttons.waiting?.simulate).toEqual([{ id: "timeout", label: "Timeout" }]);
    const after = choose(buttons, "timeout");
    expect(after.messages.slice(1).map((m) => [m.from, m.text ?? m.note, m.detail])).toEqual([
      ["system", "timeout", "30"],
      ["bot", "Still there?", undefined],
      ["system", "dead_end", undefined],
    ]);
    expect(startPreview(nodes, "t").waiting?.simulate.map((o) => o.id)).toEqual(["timeout"]);
    // A template without quick replies never waits, so it has no timeout to walk.
    expect(startPreview(nodes, "plain").messages.map((m) => m.text ?? m.note ?? m.template)).toEqual(["promo", "dead_end"]);
    // The engine ignores a timeout with no after_timeout port.
    expect(startPreview(nodes, "unwired").waiting?.simulate).toEqual([]);
  });

  it("does not take typed text on ask_location / ask_media; the share choice answers them", () => {
    const nodes = [
      n("loc", "ask_location", { prompt_text: "Where are you?", var_key: "where", next_node_key: "thanks" }),
      n("pic", "ask_media", { prompt_text: "Send a photo", var_key: "photo", next_node_key: "thanks" }),
      n("thanks", "end", {}),
    ];
    const loc = startPreview(nodes, "loc");
    expect(loc.waiting?.simulate).toEqual([{ id: "share", label: "share" }]);
    expect(choose(loc, "text", "hello").messages.slice(1).map((m) => m.text ?? m.note)).toEqual(["hello", "fallback"]);

    const shared = choose(loc, "share");
    expect(shared.messages.slice(1).map((m) => [m.from, m.shared ?? m.note])).toEqual([["customer", "location"], ["system", "end"]]);
    expect(choose(startPreview(nodes, "pic"), "share").messages[1]).toMatchObject({ from: "customer", shared: "media" });
  });
});

describe("previewAcceptsText", () => {
  it("matches the engine's input formats", async () => {
    const { normalizeCollectedInput } = await import("./input-validation");
    const formats = [{}, { validation: "email" }, { validation: "phone" }, { validation: "number", min: 1, max: 10 }, { validation: "date" }, { validation: "boolean" }] as const;
    const replies = ["", "  ", "abc", "5", "11", "5,5", "a@b.co", "a@b", "+14155550123", "123", "2026-02-30", "31/12/2025", "Yes!", "nahi", "maybe"];
    for (const rules of formats) {
      for (const reply of replies) {
        const node = n("q", "collect_input", { var_key: "v", ...rules });
        expect(previewAcceptsText(node, reply), `${JSON.stringify(rules)} ${reply}`).toBe((await normalizeCollectedInput(reply, rules)) !== null);
      }
    }
  });

  it("needs a var_key, as captureAnswer does", () => {
    expect(previewAcceptsText(n("q", "collect_input", {}), "hello")).toBe(false);
    expect(previewAcceptsText(n("q", "ask_address", { var_key: "a" }), "1 Main St")).toBe(true);
  });
});
