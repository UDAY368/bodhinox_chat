// Stage 5 trigger stack rules: only Instagram flows add triggers, only
// combinable types, at most 4 beside the primary one; removing the primary
// promotes the next; a comment trigger makes a private reply the first step.
import { describe, expect, it } from "vitest";

import { resolveFallbackPolicy } from "@/lib/flows/fallback";
import { COMBINABLE_TRIGGERS, FLOW_TRIGGER_LIMITS } from "@/lib/flows/types";
import type { BuilderState } from "../flow-editor-state";
import {
  addExtraTrigger,
  addTriggerBlock,
  MAX_TRIGGERS,
  readExtraTriggers,
  removeTrigger,
  setTriggerConfig,
  stackTriggers,
  triggerDetail,
  triggerPickerOptions,
} from "./trigger-stack";

const base = (patch: Partial<BuilderState> = {}): BuilderState => ({
  name: "f", description: "", trigger_type: "keyword", trigger_config: { keywords: ["price"] }, entry_node_id: "hello",
  fallback_policy: resolveFallbackPolicy(undefined), status: "draft", test_numbers: [],
  nodes: [{ node_key: "hello", node_type: "send_message", config: { text: "hi", next_node_key: "" } }],
  ...patch,
});

describe("addTriggerBlock", () => {
  it("allows more triggers only on Instagram flows, with a combinable primary, below the limit", () => {
    expect(addTriggerBlock("whatsapp", "keyword", 0)).toBe("onlyInstagram");
    expect(addTriggerBlock("any", "keyword", 0)).toBe("onlyInstagram");
    expect(addTriggerBlock("instagram", "default_reply", 0)).toBe("notCombinable");
    expect(addTriggerBlock("instagram", "manual", 0)).toBe("notCombinable");
    expect(addTriggerBlock("instagram", "keyword", FLOW_TRIGGER_LIMITS.extraTriggers - 1)).toBeNull();
    expect(addTriggerBlock("instagram", "keyword", FLOW_TRIGGER_LIMITS.extraTriggers)).toBe("limitReached");
    expect(MAX_TRIGGERS).toBe(5);
  });

  it("the picker offers every trigger and marks which can be combined", () => {
    const options = triggerPickerOptions(["keyword", "ig_comment", "default_reply", "manual"]);
    expect(options).toEqual([
      { type: "keyword", combinable: true },
      { type: "ig_comment", combinable: true },
      { type: "default_reply", combinable: false },
      { type: "manual", combinable: false },
    ]);
    for (const type of COMBINABLE_TRIGGERS) expect(triggerPickerOptions([type])[0].combinable).toBe(true);
  });
});

describe("editing the stack", () => {
  it("adds a combinable trigger with its starting settings, never a lone-only one", () => {
    const next = addExtraTrigger(base(), "ig_story_reply");
    expect(stackTriggers(next).map((t) => t.trigger_type)).toEqual(["keyword", "ig_story_reply"]);
    expect(addExtraTrigger(base(), "default_reply")).toEqual(base());
  });

  it("stops at the limit", () => {
    let s = base();
    for (let i = 0; i < FLOW_TRIGGER_LIMITS.extraTriggers + 2; i++) s = addExtraTrigger(s, "ig_ref");
    expect(readExtraTriggers(s.extra_triggers)).toHaveLength(FLOW_TRIGGER_LIMITS.extraTriggers);
  });

  it("a comment trigger beside a message trigger makes a private reply the first step", () => {
    const next = addExtraTrigger(base(), "ig_comment");
    const entry = next.nodes.find((n) => n.node_key === next.entry_node_id);
    expect(entry?.node_type).toBe("ig_private_reply");
    expect(entry?.config.next_node_key).toBe("hello");
  });

  it("removing the primary promotes the first extra; the only trigger stays", () => {
    const two = addExtraTrigger(base(), "ig_ref");
    const promoted = removeTrigger(two, 0);
    expect(promoted.trigger_type).toBe("ig_ref");
    expect(promoted.extra_triggers).toEqual([]);
    expect(removeTrigger(base(), 0)).toEqual(base());
    expect(removeTrigger(two, 1).extra_triggers).toEqual([]);
    expect(removeTrigger(two, 5)).toBe(two);
  });

  it("sets one trigger's settings", () => {
    const two = addExtraTrigger(base(), "ig_story_reply");
    expect(setTriggerConfig(two, 0, { keywords: ["new"] }).trigger_config).toEqual({ keywords: ["new"] });
    expect(readExtraTriggers(setTriggerConfig(two, 1, { keywords: ["x"] }).extra_triggers)[0].config).toEqual({ keywords: ["x"] });
  });

  it("drops malformed stored extras", () => {
    expect(readExtraTriggers([null, { trigger_type: "ig_ref" }, { trigger_type: "ig_ref", config: [] }, { trigger_type: "ig_ref", config: {} }]))
      .toEqual([{ trigger_type: "ig_ref", config: {} }]);
  });
});

describe("triggerDetail", () => {
  it("summarises keywords, intent and refs", () => {
    expect(triggerDetail({ trigger_type: "keyword", config: { keywords: ["a", "b", "c", "d", "e", "f"] } })).toBe("a, b, c, d +2");
    expect(triggerDetail({ trigger_type: "keyword", config: { match_type: "intent", intent: "wants a price" } })).toBe("“wants a price”");
    expect(triggerDetail({ trigger_type: "ig_ref", config: { refs: ["promo"] } })).toBe("promo");
    expect(triggerDetail({ trigger_type: "manual", config: {} })).toBeNull();
  });
});
