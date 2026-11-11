// Stage 5 autosave: saves 1.5 s after the last edit, one save at a time,
// stops for good on draft_changed, and flush() waits for a pending save
// (Publish / Pause / Archive await it).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AUTOSAVE_DELAY_MS, AutosaveController, type AutosaveStatus, type SaveOutcome } from "./use-autosave";

// Like the editor: `seq` counts edits; a save records the seq it started with.
function harness(outcomes: SaveOutcome[] = []) {
  let seq = 0;
  let savedSeq = 0;
  const statuses: AutosaveStatus["kind"][] = [];
  let release: (() => void) | null = null;
  let hold = false;
  const save = vi.fn(async (): Promise<SaveOutcome> => {
    const startSeq = seq;
    if (hold) await new Promise<void>((resolve) => { release = resolve; });
    const outcome = outcomes.shift() ?? { ok: true };
    if (outcome.ok) savedSeq = startSeq;
    return outcome;
  });
  const controller = new AutosaveController({ save, isDirty: () => seq !== savedSeq, onStatus: (s) => statuses.push(s.kind) });
  return {
    controller,
    save,
    statuses,
    edit() { seq += 1; controller.changed(); },
    /** A save made outside the controller (the Overwrite PUT). */
    markSaved() { savedSeq = seq; },
    hold() { hold = true; },
    release() { hold = false; release?.(); },
  };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("AutosaveController", () => {
  it("debounces: saves once, 1.5 s after the last edit", async () => {
    const h = harness();
    h.edit();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS - 100);
    h.edit();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS - 100);
    expect(h.save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(h.save).toHaveBeenCalledTimes(1);
    expect(h.statuses).toEqual(["pending", "pending", "saving", "saved"]);
  });

  it("does nothing while the draft is clean", async () => {
    const h = harness();
    h.controller.changed();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2);
    expect(h.save).not.toHaveBeenCalled();
    expect(await h.controller.flush()).toBe(true);
  });

  it("an edit during a save is saved after it, never in parallel", async () => {
    const h = harness();
    h.hold();
    h.edit();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(h.save).toHaveBeenCalledTimes(1);
    h.edit();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2);
    expect(h.save).toHaveBeenCalledTimes(1);
    h.release();
    // The first save settled without the second edit: it is saved after the delay.
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(h.save).toHaveBeenCalledTimes(2);
    expect(h.statuses.at(-1)).toBe("saved");
  });

  it("stops for good on draft_changed and never overwrites silently", async () => {
    const h = harness([{ ok: false, conflict: true }]);
    h.edit();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(h.controller.conflicted).toBe(true);
    expect(h.statuses.at(-1)).toBe("conflict");
    h.edit();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 3);
    expect(h.save).toHaveBeenCalledTimes(1);
    expect(await h.controller.flush()).toBe(false);
    expect(h.save).toHaveBeenCalledTimes(1);
    // The author chose Overwrite: saving resumes.
    h.controller.resume();
    h.edit();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(h.save).toHaveBeenCalledTimes(2);
  });

  it("after a successful Overwrite, resume leaves the conflict state for Saved", async () => {
    const h = harness([{ ok: false, conflict: true }]);
    h.edit();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(h.statuses.at(-1)).toBe("conflict");
    h.markSaved();
    h.controller.resume();
    expect(h.statuses.at(-1)).toBe("saved");
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2);
    expect(h.save).toHaveBeenCalledTimes(1);
  });

  it("a failed save reports why and waits for the next edit", async () => {
    const h = harness([{ ok: false, reason: "offline" }]);
    h.edit();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 3);
    expect(h.save).toHaveBeenCalledTimes(1);
    expect(h.statuses.at(-1)).toBe("error");
  });

  it("flush saves now and waits for a save in flight (the pending-save guard)", async () => {
    const h = harness();
    h.edit();
    expect(h.controller.busy).toBe(true);
    expect(await h.controller.flush()).toBe(true);
    expect(h.save).toHaveBeenCalledTimes(1);
    expect(h.controller.busy).toBe(false);

    h.hold();
    h.edit();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(h.controller.busy).toBe(true);
    let flushed: boolean | null = null;
    void h.controller.flush().then((ok) => { flushed = ok; });
    await vi.advanceTimersByTimeAsync(0);
    expect(flushed).toBeNull();
    h.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(flushed).toBe(true);
    expect(h.save).toHaveBeenCalledTimes(2);
  });

  it("flush resolves false when the save fails", async () => {
    const h = harness([{ ok: false, reason: "server", message: "Name is empty" }]);
    h.edit();
    expect(await h.controller.flush()).toBe(false);
  });

  it("dispose cancels a waiting save; a remount (revive) saves again", async () => {
    const h = harness();
    h.edit();
    h.controller.dispose();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2);
    expect(h.save).not.toHaveBeenCalled();
    h.controller.revive();
    h.edit();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(h.save).toHaveBeenCalledTimes(1);
  });

  it("calls the latest callbacks it was given", async () => {
    const h = harness();
    const later = vi.fn(async (): Promise<SaveOutcome> => ({ ok: true }));
    h.controller.setCallbacks({ save: later, isDirty: () => true });
    h.controller.changed();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(later).toHaveBeenCalledTimes(1);
    expect(h.save).not.toHaveBeenCalled();
  });
});
