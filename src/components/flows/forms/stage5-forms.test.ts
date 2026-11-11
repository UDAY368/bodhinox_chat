// Stage 5 builder helpers: randomizer totals, variable insertion at the
// cursor, condition subjects and operators per channel, smart-delay and
// reply-delay maths, the keyword "match meaning" switch, send modes and
// AI goal editing.
import { describe, expect, it } from "vitest";

import { IG_PROFILE_FACTS, SYSTEM_FACTS } from "@/lib/flows/types";
import type { BuilderNode } from "../shared";
import { replyDelayParts, setReplyDelay } from "../triggers/ig-trigger-config";
import { actionPickerGroups, defaultAction, moveItem, readActions } from "./actions-form";
import { freeGoalTypes, readGoals, toggleLeadField } from "./ai-goals-editor";
import {
  BASE_SUBJECTS,
  conditionSubjectsFor,
  groupSubjects,
  isYesNoSubject,
  linkSteps,
  operatorsFor,
  ruleForSubject,
} from "./condition-subjects";
import { addPath, randomizerTotal, readPaths, removePath } from "./randomizer-form";
import { delaySeconds, delayWithinLimit, mayOutlastWindow } from "./smart-delay-form";
import { cleanFallback, flowVariables, insertAtCursor, placeholderToken, variableGroups } from "./variable-picker";

const node = (node_key: string, node_type: BuilderNode["node_type"], config: Record<string, unknown> = {}): BuilderNode => ({ node_key, node_type, config });

describe("randomizer", () => {
  const paths = (...weights: number[]) => weights.map((weight, i) => ({ id: "ABCDEF"[i], weight, next_node_key: "" }));

  it("is valid only with 2-6 whole shares totalling 100", () => {
    expect(randomizerTotal(paths(50, 50))).toEqual({ total: 100, valid: true });
    expect(randomizerTotal(paths(60, 50))).toEqual({ total: 110, valid: false });
    expect(randomizerTotal(paths(100)).valid).toBe(false);
    expect(randomizerTotal(paths(20, 20, 20, 20, 10, 5, 5)).valid).toBe(false);
    expect(randomizerTotal(paths(49.5, 50.5)).valid).toBe(false);
    expect(randomizerTotal(paths(-10, 110)).valid).toBe(false);
  });

  it("adding a path takes its share from the largest so the total stays 100", () => {
    const three = addPath(paths(50, 50));
    expect(three.map((p) => p.id)).toEqual(["A", "B", "C"]);
    expect(randomizerTotal(three)).toEqual({ total: 100, valid: true });
    let six = three;
    for (let i = 0; i < 5; i++) six = addPath(six);
    expect(six).toHaveLength(6);
    expect(randomizerTotal(six).total).toBe(100);
  });

  it("removing a path gives its share to the first, never below two", () => {
    expect(removePath(paths(30, 30, 40), 2)).toEqual([{ id: "A", weight: 70, next_node_key: "" }, { id: "B", weight: 30, next_node_key: "" }]);
    expect(removePath(paths(50, 50), 0)).toHaveLength(2);
  });

  it("reads stored paths defensively", () => {
    expect(readPaths([{ id: "A", weight: "x" }, null, { id: "B", weight: 40, next_node_key: "n" }])).toEqual([
      { id: "A", weight: 0, next_node_key: "" },
      { id: "B", weight: 40, next_node_key: "n" },
    ]);
  });
});

describe("variable picker", () => {
  it("inserts at the cursor, replacing a selection, and puts the cursor after the token", () => {
    expect(insertAtCursor("Hi !", 3, 3, "{{contact.name}}")).toEqual({ value: "Hi {{contact.name}}!", caret: 19 });
    expect(insertAtCursor("Hi NAME!", 3, 7, "{{contact.name}}")).toEqual({ value: "Hi {{contact.name}}!", caret: 19 });
    expect(insertAtCursor("Hi", null, null, "{{vars.x}}")).toEqual({ value: "Hi{{vars.x}}", caret: 12 });
    expect(insertAtCursor("Hi", 99, 99, "x")).toEqual({ value: "Hix", caret: 3 });
  });

  it("builds placeholders with a cleaned fallback", () => {
    expect(placeholderToken("contact", "name")).toBe("{{contact.name}}");
    expect(placeholderToken("custom", "f1", "  there ")).toBe("{{custom.f1|there}}");
    expect(placeholderToken("vars", "x", "a}}{{b|c")).toBe("{{vars.x|abc}}");
    // The engine fills {{workspace.key}} without a fallback form: one would reach the customer as typed.
    expect(placeholderToken("workspace", "store_name", "our shop")).toBe("{{workspace.store_name}}");
    expect(cleanFallback("x".repeat(200))).toHaveLength(100);
  });

  it("lists variables set by other steps, never the current one", () => {
    const nodes = [
      node("ask", "collect_input", { var_key: "email" }),
      node("set", "set_attribute", { target: "var", key: "plan" }),
      node("api", "api_request", { mappings: [{ var_key: "order_id" }, { var_key: "bad key" }] }),
      node("sheet", "google_sheets", { var_map: [{ column: "A", var_key: "row_name" }] }),
      node("me", "collect_input", { var_key: "mine" }),
    ];
    expect(flowVariables(nodes, "me")).toEqual(["email", "order_id", "plan", "row_name"]);
  });

  it("groups and filters options", () => {
    const groups = variableGroups([
      { source: "vars", key: "email", label: "email" },
      { source: "contact", key: "name", label: "name" },
      { source: "contact", key: "email", label: "email" },
    ], "mail");
    expect(groups.map((g) => [g.source, g.items.map((i) => i.key)])).toEqual([["contact", ["email"]], ["vars", ["email"]]]);
  });
});

describe("condition subjects", () => {
  it("WhatsApp flows keep exactly their six subjects; Instagram adds the Stage 5 ones", () => {
    expect(conditionSubjectsFor("whatsapp")).toEqual(BASE_SUBJECTS);
    expect(conditionSubjectsFor("any")).toEqual(BASE_SUBJECTS);
    expect(conditionSubjectsFor("instagram")).toEqual([...BASE_SUBJECTS, "ig_profile", "system", "segment", "link_click", "workspace_field", "sequence"]);
  });

  it("groups the picker as Recommended, General filters and System fields", () => {
    expect(groupSubjects(conditionSubjectsFor("instagram"))).toEqual([
      { group: "recommended", subjects: ["tag", "contact_field", "ig_profile"] },
      { group: "general", subjects: ["custom_field", "time", "date", "segment", "link_click", "sequence"] },
      { group: "system", subjects: ["var", "system", "workspace_field"] },
    ]);
  });

  it("allows each subject only the operators its type supports", () => {
    expect(operatorsFor("segment")).toEqual(["equals"]);
    expect(operatorsFor("link_click")).toEqual(["equals"]);
    expect(operatorsFor("ig_profile", "follows_business")).toEqual(["equals"]);
    expect(operatorsFor("ig_profile", "follower_count")).toEqual(["equals", "not_equals", "gt", "gte", "lt", "lte"]);
    expect(operatorsFor("system", "last_interaction_at")).toEqual(["present", "absent", "gt", "lt"]);
    expect(operatorsFor("system", "contact_id")).toEqual(["equals", "not_equals"]);
    expect(operatorsFor("system", "ig_username")).toEqual(["present", "absent", "equals", "not_equals", "contains"]);
    expect(operatorsFor("system", "subscribed")).toEqual(["equals"]);
    expect(operatorsFor("time")).not.toContain("present");
    expect(operatorsFor("tag")).toContain("present");
    expect(operatorsFor("workspace_field")).not.toContain("between");
  });

  it("a new rule picks the first fact, a valid operator and yes for a yes/no subject (the follow gate)", () => {
    expect(ruleForSubject("ig_profile")).toEqual({ subject: "ig_profile", subject_key: IG_PROFILE_FACTS[0], operator: "equals", value: "true" });
    expect(ruleForSubject("system")).toEqual({ subject: "system", subject_key: SYSTEM_FACTS[0], operator: "present", value: "" });
    expect(ruleForSubject("segment")).toEqual({ subject: "segment", subject_key: "", operator: "equals", value: "true" });
    expect(ruleForSubject("time").operator).toBe("between");
    expect(ruleForSubject("var").operator).toBe("equals");
    expect(isYesNoSubject("ig_profile", "follower_count")).toBe(false);
  });

  it("link clicked tests only steps that send links", () => {
    const steps = [
      node("card", "send_card"),
      node("gallery", "send_gallery"),
      node("buttons", "send_buttons", { link_buttons: [{ title: "Go", url: "https://x.test" }] }),
      node("plain", "send_buttons", { link_buttons: [] }),
      node("text", "send_message"),
    ];
    expect(linkSteps(steps).map((n) => n.node_key)).toEqual(["card", "gallery", "buttons"]);
  });
});

describe("smart delay", () => {
  it("measures a duration and flags waits that may outlast Instagram's window", () => {
    expect(delaySeconds({ mode: "duration", amount: 2, unit: "hours" })).toBe(7200);
    expect(delaySeconds({ mode: "duration", amount: 2 })).toBe(7200);
    expect(delaySeconds({ mode: "duration", amount: 5, amount_field_id: "f" })).toBeNull();
    expect(delaySeconds({ mode: "until_date", date: "2026-12-01T00:00:00Z" })).toBeNull();
    expect(mayOutlastWindow({ mode: "duration", amount: 23, unit: "hours" })).toBe(false);
    expect(mayOutlastWindow({ mode: "duration", amount: 24, unit: "hours" })).toBe(true);
    expect(mayOutlastWindow({ mode: "duration", amount: 1, unit: "hours", send_window: { from: "09:00", to: "17:00", weekdays: [1] } })).toBe(true);
    expect(mayOutlastWindow({ mode: "until_date" })).toBe(true);
    expect(delayWithinLimit({ mode: "duration", amount: 365, unit: "days" })).toBe(true);
    expect(delayWithinLimit({ mode: "duration", amount: 366, unit: "days" })).toBe(false);
  });
});

describe("comment reply delay", () => {
  it("stores whole seconds up to 10 minutes and shows minutes when they divide evenly", () => {
    expect(setReplyDelay({}, 2, "minutes")).toEqual({ reply_delay_seconds: 120 });
    expect(setReplyDelay({}, 45, "seconds")).toEqual({ reply_delay_seconds: 45 });
    expect(setReplyDelay({}, 30, "minutes")).toEqual({ reply_delay_seconds: 600 });
    expect(setReplyDelay({ reply_delay_seconds: 60, keep: 1 }, 0, "seconds")).toEqual({ keep: 1 });
    expect(setReplyDelay({ reply_delay_seconds: 60 }, null, "seconds")).toEqual({});
    expect(replyDelayParts(120)).toEqual({ amount: 2, unit: "minutes" });
    expect(replyDelayParts(90)).toEqual({ amount: 90, unit: "seconds" });
    expect(replyDelayParts(undefined)).toEqual({ amount: 0, unit: "seconds" });
  });
});

describe("actions step", () => {
  it("groups the picker as Contact data, Automation, Inbox and Ads; consent and sequences only on Instagram", () => {
    const ig = actionPickerGroups(true);
    expect(ig.map((g) => g.group)).toEqual(["contact", "automation", "inbox", "ads"]);
    expect(ig.flatMap((g) => g.types)).toContain("set_channel_consent");
    const wa = actionPickerGroups(false).flatMap((g) => g.types);
    expect(wa).not.toContain("set_channel_consent");
    expect(wa).not.toContain("subscribe_sequence");
    expect(wa).toContain("add_tag");
  });

  it("reorders, defaults and reads actions", () => {
    expect(moveItem(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
    expect(moveItem(["a", "b"], 0, -1)).toEqual(["a", "b"]);
    expect(defaultAction("pause_automations")).toEqual({ type: "pause_automations", minutes: 60 });
    expect(readActions([{ type: "add_tag", tag_id: "t" }, { type: "nope" }, null])).toEqual([{ type: "add_tag", tag_id: "t" }]);
  });
});

describe("AI goals", () => {
  it("offers each goal type once and caps lead fields at five", () => {
    const goals = readGoals([{ type: "share_link", url: "https://x.test" }, { type: "bogus" }]);
    expect(goals).toHaveLength(1);
    expect(freeGoalTypes(goals)).toEqual(["grow_followers", "capture_lead"]);
    let fields: string[] = [];
    for (const f of ["name", "email", "phone", "company", "custom:a", "custom:b"]) fields = toggleLeadField(fields, f);
    expect(fields).toEqual(["name", "email", "phone", "company", "custom:a"]);
    expect(toggleLeadField(fields, "email")).toEqual(["name", "phone", "company", "custom:a"]);
  });
});
