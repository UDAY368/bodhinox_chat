// Stage 5 undo / redo: coalescing within 500 ms per field, a 100-step cap,
// redo cleared by a new edit, non-edit replacements, and the shortcuts.
import { describe, expect, it } from "vitest";

import {
  COALESCE_MS,
  createHistory,
  focusedFieldKey,
  HISTORY_LIMIT,
  historyReducer,
  historyShortcut,
  isTextEditingTarget,
  recordEdit,
  redoEdit,
  replaceAll,
  undoEdit,
} from "./use-history";

describe("recordEdit", () => {
  it("pushes the previous state and counts the edit", () => {
    const h = recordEdit(createHistory({ v: 0 }), { v: 1 }, null, 1000);
    expect(h.present).toEqual({ v: 1 });
    expect(h.past).toEqual([{ v: 0 }]);
    expect(h.seq).toBe(1);
  });

  it("typing in one field within 500 ms is one undo step", () => {
    let h = createHistory("");
    h = recordEdit(h, "h", "field:1", 1000);
    h = recordEdit(h, "he", "field:1", 1000 + COALESCE_MS - 1);
    h = recordEdit(h, "hey", "field:1", 1000 + 2 * COALESCE_MS - 2);
    expect(h.past).toEqual([""]);
    expect(h.present).toBe("hey");
    expect(h.seq).toBe(3);
    expect(undoEdit(h).present).toBe("");
  });

  it("starts a new step after a pause, another field or an edit without a key", () => {
    let h = createHistory("");
    h = recordEdit(h, "a", "field:1", 0);
    h = recordEdit(h, "ab", "field:1", COALESCE_MS + 1);
    h = recordEdit(h, "abc", "field:2", COALESCE_MS + 2);
    h = recordEdit(h, "abcd", null, COALESCE_MS + 3);
    h = recordEdit(h, "abcde", null, COALESCE_MS + 4);
    expect(h.past).toEqual(["", "a", "ab", "abc", "abcd"]);
  });

  it("keeps at most 100 snapshots", () => {
    let h = createHistory(0);
    for (let i = 1; i <= HISTORY_LIMIT + 25; i++) h = recordEdit(h, i, null, i);
    expect(h.past).toHaveLength(HISTORY_LIMIT);
    expect(h.past[0]).toBe(25);
    let undone = h;
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) undone = undoEdit(undone);
    expect(undone.present).toBe(25);
  });

  it("a new edit clears redo", () => {
    let h = recordEdit(recordEdit(createHistory(0), 1, null, 1), 2, null, 2);
    h = undoEdit(h);
    expect(h.future).toEqual([2]);
    h = recordEdit(h, 3, null, 3);
    expect(h.future).toEqual([]);
    expect(redoEdit(h)).toBe(h);
  });

  it("ignores a no-op edit", () => {
    const state = { v: 1 };
    const h = createHistory(state);
    expect(recordEdit(h, state, null, 1)).toBe(h);
  });
});

describe("undo and redo", () => {
  it("walk back and forward and count as edits (so an undo after a save is saved)", () => {
    let h = recordEdit(recordEdit(createHistory("a"), "b", null, 1), "c", null, 2);
    h = undoEdit(h);
    expect(h.present).toBe("b");
    h = undoEdit(h);
    expect(h.present).toBe("a");
    expect(undoEdit(h)).toBe(h);
    h = redoEdit(h);
    expect(h.present).toBe("b");
    expect(h.seq).toBe(5);
  });

  it("an undo ends coalescing, so the next keystroke is its own step", () => {
    let h = recordEdit(createHistory(""), "a", "field:1", 0);
    h = recordEdit(h, "ab", "field:1", 10);
    h = undoEdit(h);
    h = recordEdit(h, "x", "field:1", 20);
    expect(h.past).toEqual([""]);
  });
});

describe("replaceAll (not an edit)", () => {
  it("changes every snapshot without an undo step or a dirty count", () => {
    let h = recordEdit(createHistory({ status: "draft", n: 0 }), { status: "draft", n: 1 }, null, 1);
    h = replaceAll(h, (s) => ({ ...s, status: "active" }));
    expect(h.seq).toBe(1);
    expect(h.present.status).toBe("active");
    expect(undoEdit(h).present).toEqual({ status: "active", n: 0 });
  });

  it("the reducer's clear drops undo and redo but keeps the edit count", () => {
    let h = recordEdit(createHistory(0), 1, null, 1);
    h = historyReducer(h, { type: "clear" });
    expect(h.past).toEqual([]);
    expect(h.present).toBe(1);
    expect(h.seq).toBe(1);
  });
});

describe("shortcuts", () => {
  const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) =>
    ({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });

  it("maps Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z and Ctrl+Y", () => {
    expect(historyShortcut(key("z", { ctrlKey: true }))).toBe("undo");
    expect(historyShortcut(key("Z", { metaKey: true }))).toBe("undo");
    expect(historyShortcut(key("Z", { ctrlKey: true, shiftKey: true }))).toBe("redo");
    expect(historyShortcut(key("y", { ctrlKey: true }))).toBe("redo");
    expect(historyShortcut(key("z"))).toBeNull();
    expect(historyShortcut(key("z", { ctrlKey: true, altKey: true }))).toBeNull();
    expect(historyShortcut(key("y", { ctrlKey: true, shiftKey: true }))).toBeNull();
  });

  it("leaves text fields to the browser's own undo", () => {
    const el = (tagName: string, extra: Record<string, unknown> = {}) => ({ tagName, isContentEditable: false, ...extra }) as unknown as EventTarget;
    expect(isTextEditingTarget(el("INPUT", { type: "text" }))).toBe(true);
    expect(isTextEditingTarget(el("TEXTAREA"))).toBe(true);
    expect(isTextEditingTarget(el("DIV", { isContentEditable: true }))).toBe(true);
    expect(isTextEditingTarget(el("INPUT", { type: "checkbox" }))).toBe(false);
    expect(isTextEditingTarget(el("BUTTON"))).toBe(false);
    expect(isTextEditingTarget(null)).toBe(false);
  });

  it("gives each text field one stable coalesce key", () => {
    const a = { tagName: "INPUT", type: "text", isContentEditable: false } as unknown as Element;
    const b = { tagName: "TEXTAREA", isContentEditable: false } as unknown as Element;
    expect(focusedFieldKey(a)).toBe(focusedFieldKey(a));
    expect(focusedFieldKey(a)).not.toBe(focusedFieldKey(b));
    expect(focusedFieldKey({ tagName: "BUTTON" } as unknown as Element)).toBeNull();
    expect(focusedFieldKey(null)).toBeNull();
  });
});
