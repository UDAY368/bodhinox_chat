// Stage 5 canvas helpers: the grouped add-step menu, canvas notes, node
// stats parsing, the header's save-state text and the editor's draft body.
import { describe, expect, it } from "vitest";

import { ALL_CAPABILITIES } from "@/lib/flows/node-registry";
import { CANVAS_NOTE_LIMITS } from "@/lib/flows/types";
import { addNote, addStepGroups, isNoteNodeId, noteNodeId, parseNodeStats, readNotes, removeNote, updateNote } from "./canvas-extras";
import { commentTriggerOf, draftMarker, draftPayload, isDraftConflict, nodeTypesForScope, type BuilderState } from "./flow-editor-state";
import { saveStateView } from "./header";
import { resolveFallbackPolicy } from "@/lib/flows/fallback";

describe("add-step menu groups", () => {
  it("groups Instagram steps as Content, AI and Logic, without the private reply or the start step", () => {
    const groups = addStepGroups(nodeTypesForScope("instagram"), { ...ALL_CAPABILITIES });
    expect(groups.map((g) => g.group)).toEqual(["content", "ai", "logic"]);
    const all = groups.flatMap((g) => g.types);
    expect(all).not.toContain("ig_private_reply");
    expect(all).not.toContain("start");
    expect(groups.find((g) => g.group === "logic")?.types).toEqual(expect.arrayContaining(["actions", "condition", "randomizer", "smart_delay"]));
    expect(groups.find((g) => g.group === "ai")?.types).toEqual(["ai_reply"]);
  });

  it("hides Google Sheets unless the workspace has the sheets capability", () => {
    const types = nodeTypesForScope("instagram");
    expect(addStepGroups(types, { ...ALL_CAPABILITIES, sheets: false }).flatMap((g) => g.types)).not.toContain("google_sheets");
    expect(addStepGroups(types, null).flatMap((g) => g.types)).not.toContain("google_sheets");
    expect(addStepGroups(types, { ...ALL_CAPABILITIES, sheets: true }).flatMap((g) => g.types)).toContain("google_sheets");
  });

  it("WhatsApp menus keep their steps and gain no Stage 5 step", () => {
    const wa = addStepGroups(nodeTypesForScope("whatsapp"), { ...ALL_CAPABILITIES }).flatMap((g) => g.types);
    for (const type of ["actions", "randomizer", "smart_delay", "google_sheets"]) expect(wa).not.toContain(type);
    expect(wa).toEqual(expect.arrayContaining(["send_message", "send_template", "condition", "handoff"]));
  });

  it("filters by the search text", () => {
    const groups = addStepGroups(nodeTypesForScope("instagram"), { ...ALL_CAPABILITIES }, { query: "random", label: (t) => t });
    expect(groups.flatMap((g) => g.types)).toEqual(["randomizer"]);
  });
});

describe("canvas notes", () => {
  it("adds, edits, moves and removes notes within the limits", () => {
    let notes = addNote([], 10.4, 20.6, "Remember the promo code");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ text: "Remember the promo code", x: 10, y: 21 });
    const id = notes[0].id;
    notes = updateNote(notes, id, { text: "x".repeat(CANVAS_NOTE_LIMITS.chars + 50), x: 5 });
    expect(notes[0].text).toHaveLength(CANVAS_NOTE_LIMITS.chars);
    expect(notes[0].x).toBe(5);
    expect(removeNote(notes, id)).toEqual([]);
    let many = readNotes([]);
    for (let i = 0; i < CANVAS_NOTE_LIMITS.notes + 3; i++) many = addNote(many, i, i);
    expect(many).toHaveLength(CANVAS_NOTE_LIMITS.notes);
    expect(new Set(many.map((n) => n.id)).size).toBe(many.length);
  });

  it("reads only well-formed notes and tells note nodes apart", () => {
    expect(readNotes([{ id: "a", text: "t", x: 1, y: 2 }, { id: "b", text: "t", x: "1", y: 2 }, null])).toEqual([{ id: "a", text: "t", x: 1, y: 2 }]);
    expect(isNoteNodeId(noteNodeId("a"))).toBe(true);
    expect(isNoteNodeId("send_message")).toBe(false);
  });
});

describe("node stats", () => {
  it("reads either shape and ignores junk", () => {
    expect(parseNodeStats({ nodes: { wait: { waiting: 3, passed: 7 } } })).toEqual({ wait: { waiting: 3, passed: 7 } });
    expect(parseNodeStats({ nodes: [{ node_key: "wait", waiting: 1.9, passed: -2 }, { waiting: 1 }] })).toEqual({ wait: { waiting: 1, passed: 0 } });
    expect(parseNodeStats(null)).toEqual({});
    expect(parseNodeStats({ error: "x" })).toEqual({});
  });
});

describe("header save state", () => {
  it("says Saving, Saved or Not saved with the reason", () => {
    expect(saveStateView({ kind: "idle" }, false)).toBeNull();
    expect(saveStateView({ kind: "idle" }, true)).toEqual({ key: "saving" });
    expect(saveStateView({ kind: "pending" }, true)).toEqual({ key: "saving" });
    expect(saveStateView({ kind: "saving" }, true)).toEqual({ key: "saving" });
    expect(saveStateView({ kind: "saved" }, false)).toEqual({ key: "saved" });
    expect(saveStateView({ kind: "error", reason: "offline" }, true)).toEqual({ key: "notSavedReason", reason: "offline" });
    expect(saveStateView({ kind: "error", reason: "server", message: "Name is empty" }, true)).toEqual({ key: "notSavedReason", message: "Name is empty" });
    expect(saveStateView({ kind: "conflict" }, true)).toEqual({ key: "notSaved" });
  });
});

describe("draft body (autosave contract)", () => {
  const state: BuilderState = {
    name: "Flow", description: "", trigger_type: "keyword", trigger_config: { keywords: ["hi"] }, entry_node_id: null,
    fallback_policy: resolveFallbackPolicy(undefined), status: "draft", test_numbers: [], nodes: [],
  };

  it("sends triggers, usernames, notes and the base it was edited from", () => {
    const body = draftPayload({ ...state, test_usernames: ["shop"] }, "instagram", "2026-11-11T10:00:00.000Z");
    expect(body).toMatchObject({ extra_triggers: [], test_usernames: ["shop"], canvas_notes: [], channel_scope: "instagram", base_updated_at: "2026-11-11T10:00:00.000Z" });
    expect(draftPayload(state, "whatsapp", null)).not.toHaveProperty("base_updated_at");
  });

  it("recognises the draft_changed refusal", () => {
    expect(isDraftConflict(409, { code: "draft_changed" })).toBe(true);
    expect(isDraftConflict(409, { error: "draft_changed" })).toBe(true);
    expect(isDraftConflict(409, { error: "Something else" })).toBe(false);
    expect(isDraftConflict(422, { code: "draft_changed" })).toBe(false);
  });

  it("judges comment steps by a comment trigger among the extras too", () => {
    expect(commentTriggerOf({ trigger_type: "keyword", extra_triggers: [{ trigger_type: "ig_comment", config: {} }] })).toBe("ig_comment");
    expect(commentTriggerOf({ trigger_type: "keyword" })).toBe("keyword");
  });
});

describe("autosave draft marker", () => {
  it("prefers draft_saved_at, which run counts and status changes do not move, over updated_at", () => {
    expect(draftMarker({ draft_saved_at: "2026-11-11T10:00:00.000Z", updated_at: "2026-11-11T10:05:00.000Z" })).toBe("2026-11-11T10:00:00.000Z");
    expect(draftMarker({ draft_saved_at: null, updated_at: "2026-11-11T10:05:00.000Z" })).toBe("2026-11-11T10:05:00.000Z");
    expect(draftMarker({})).toBeNull();
    expect(draftMarker(undefined)).toBeNull();
  });
});
