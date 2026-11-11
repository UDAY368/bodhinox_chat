"use client";

/**
 * Undo / redo for the flow editor (Stage 5).
 *
 * The editor's authored state lives in a HistoryState: `present` plus up to
 * HISTORY_LIMIT snapshots behind it and the snapshots undone ahead of it.
 * Every recorded edit (canvas or side panel) pushes the previous present;
 * edits carrying the same coalesce key within COALESCE_MS replace the present
 * instead, so typing in one field is one undo step. A new edit clears redo.
 *
 * `seq` counts every change the author made (record, undo, redo). The editor
 * compares it with the seq of its last save to know whether the draft is
 * dirty, so an undo after a save is saved again like any other edit.
 *
 * `replace` changes state without an undo step and without counting as an
 * edit (layout hydration, the server-decided status). It applies to every
 * snapshot, so undoing later never brings the old value back.
 *
 * The functions are pure so the reducer and its tests share them; the hook
 * below is a thin useReducer around them.
 */

import { useCallback, useReducer } from "react";

export const HISTORY_LIMIT = 100;
export const COALESCE_MS = 500;

export interface HistoryState<T> {
  past: T[];
  present: T;
  future: T[];
  /** Coalesce key and time of the last recorded edit. */
  lastKey: string | null;
  lastAt: number;
  /** Bumped by every record, undo and redo. */
  seq: number;
}

export function createHistory<T>(present: T): HistoryState<T> {
  return { past: [], present, future: [], lastKey: null, lastAt: 0, seq: 0 };
}

/** Records `next` as an edit. Same key within COALESCE_MS: one entry. */
export function recordEdit<T>(h: HistoryState<T>, next: T, key: string | null, now: number): HistoryState<T> {
  if (Object.is(next, h.present)) return h;
  const coalesce = key !== null && key === h.lastKey && now - h.lastAt <= COALESCE_MS && h.past.length > 0;
  return {
    past: coalesce ? h.past : [...h.past, h.present].slice(-HISTORY_LIMIT),
    present: next,
    future: [],
    lastKey: key,
    lastAt: now,
    seq: h.seq + 1,
  };
}

export function undoEdit<T>(h: HistoryState<T>): HistoryState<T> {
  if (!h.past.length) return h;
  const previous = h.past[h.past.length - 1];
  return {
    past: h.past.slice(0, -1),
    present: previous,
    future: [h.present, ...h.future],
    lastKey: null,
    lastAt: 0,
    seq: h.seq + 1,
  };
}

export function redoEdit<T>(h: HistoryState<T>): HistoryState<T> {
  if (!h.future.length) return h;
  const [next, ...rest] = h.future;
  return {
    past: [...h.past, h.present].slice(-HISTORY_LIMIT),
    present: next,
    future: rest,
    lastKey: null,
    lastAt: 0,
    seq: h.seq + 1,
  };
}

/** Applies `update` to every snapshot without an undo step and without counting as an edit. */
export function replaceAll<T>(h: HistoryState<T>, update: (snapshot: T) => T): HistoryState<T> {
  const present = update(h.present);
  if (Object.is(present, h.present) && !h.past.length && !h.future.length) return h;
  return { ...h, present, past: h.past.map(update), future: h.future.map(update) };
}

type Updater<T> = T | ((prev: T) => T);
const apply = <T>(updater: Updater<T>, prev: T): T =>
  typeof updater === "function" ? (updater as (p: T) => T)(prev) : updater;

type Action<T> =
  | { type: "record"; updater: Updater<T>; key: string | null; now: number }
  | { type: "replace"; update: (snapshot: T) => T }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "clear" };

export function historyReducer<T>(h: HistoryState<T>, action: Action<T>): HistoryState<T> {
  switch (action.type) {
    case "record":
      return recordEdit(h, apply(action.updater, h.present), action.key, action.now);
    case "replace":
      return replaceAll(h, action.update);
    case "undo":
      return undoEdit(h);
    case "redo":
      return redoEdit(h);
    case "clear":
      return { ...createHistory(h.present), seq: h.seq };
  }
}

export interface HistoryApi<T> {
  present: T;
  seq: number;
  canUndo: boolean;
  canRedo: boolean;
  /** An edit; `key` coalesces repeated edits of one field. */
  record: (updater: Updater<T>, key?: string | null) => void;
  /** A change that is not an edit (no undo step, not dirty), applied to every snapshot. */
  replace: (update: (snapshot: T) => T) => void;
  undo: () => void;
  redo: () => void;
  /** Drops every undo and redo step (after restoring another draft). */
  clear: () => void;
}

export function useHistory<T>(init: () => T): HistoryApi<T> {
  const [h, dispatch] = useReducer(historyReducer<T>, undefined, () => createHistory(init()));
  const record = useCallback((updater: Updater<T>, key: string | null = null) =>
    dispatch({ type: "record", updater, key, now: Date.now() }), []);
  const replace = useCallback((update: (snapshot: T) => T) => dispatch({ type: "replace", update }), []);
  const undo = useCallback(() => dispatch({ type: "undo" }), []);
  const redo = useCallback(() => dispatch({ type: "redo" }), []);
  const clear = useCallback(() => dispatch({ type: "clear" }), []);
  return {
    present: h.present,
    seq: h.seq,
    canUndo: h.past.length > 0,
    canRedo: h.future.length > 0,
    record,
    replace,
    undo,
    redo,
    clear,
  };
}

// ------------------------------------------------------------ keyboard

/** True for a field where the browser's own undo applies (text inputs, textareas, editable text). */
export function isTextEditingTarget(target: EventTarget | null): boolean {
  const el = target as (HTMLElement & { type?: string }) | null;
  if (!el || typeof el !== "object" || !("tagName" in el)) return false;
  if (el.isContentEditable) return true;
  const tag = String(el.tagName).toUpperCase();
  if (tag === "TEXTAREA") return true;
  if (tag !== "INPUT") return false;
  const type = String(el.type ?? "text").toLowerCase();
  return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(type);
}

/** Which history command a key press means, or null: Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z and Ctrl+Y redo. */
export function historyShortcut(e: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }): "undo" | "redo" | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  const key = e.key.toLowerCase();
  if (key === "z") return e.shiftKey ? "redo" : "undo";
  if (key === "y" && !e.shiftKey) return "redo";
  return null;
}

// Stable per-element ids, so typing in one field coalesces into one entry.
const fieldIds = new WeakMap<object, number>();
let nextFieldId = 1;

/** The coalesce key for an edit made while `active` has focus: one per text field, null otherwise. */
export function focusedFieldKey(active: Element | null): string | null {
  if (!active || !isTextEditingTarget(active)) return null;
  let id = fieldIds.get(active);
  if (!id) {
    id = nextFieldId++;
    fieldIds.set(active, id);
  }
  return `field:${id}`;
}
