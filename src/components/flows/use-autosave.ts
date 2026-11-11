"use client";

/**
 * Autosave for the flow editor (Stage 5).
 *
 * A changed draft saves AUTOSAVE_DELAY_MS after the last edit. One save runs
 * at a time; an edit made while a save is in flight is saved after it. When
 * the server answers `draft_changed` (someone saved a newer draft) autosave
 * stops for good and the editor asks the author to reload or overwrite: it
 * never overwrites silently. A failed save waits for the next edit or a
 * manual "Save now".
 *
 * `flush()` saves now (or waits for the save in flight) and resolves whether
 * the draft is saved; Publish, Pause and Archive await it instead of being
 * disabled while a save is pending.
 *
 * The controller is plain TypeScript with injected callbacks so its timing is
 * unit-tested with fake timers; useAutosave wires it to React.
 */

import { useEffect, useState } from "react";

export const AUTOSAVE_DELAY_MS = 1500;

export type SaveOutcome =
  | { ok: true }
  | { ok: false; conflict: true }
  | { ok: false; conflict?: false; reason: "offline" | "failed" | "server"; message?: string | null };

export type AutosaveStatus =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; reason: "offline" | "failed" | "server"; message?: string | null }
  | { kind: "conflict" };

export interface AutosaveOptions {
  /** Saves the current draft. Must not throw. */
  save: () => Promise<SaveOutcome>;
  /** Whether the editor has edits the last save did not include. */
  isDirty: () => boolean;
  onStatus: (status: AutosaveStatus) => void;
  delayMs?: number;
}

export class AutosaveController {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<SaveOutcome> | null = null;
  private stopped = false;
  private disposed = false;
  private readonly delay: number;

  constructor(private opts: AutosaveOptions) {
    this.delay = opts.delayMs ?? AUTOSAVE_DELAY_MS;
  }

  /** Swaps in the latest save / isDirty callbacks (the editor re-renders with new closures). */
  setCallbacks(callbacks: Pick<AutosaveOptions, "save" | "isDirty">): void {
    this.opts = { ...this.opts, ...callbacks };
  }

  /** True after a `draft_changed` answer: nothing saves until the author decides. */
  get conflicted(): boolean {
    return this.stopped;
  }

  /** Call after every edit (and after each save settles): schedules a save while the draft is dirty. */
  changed(): void {
    if (this.stopped || this.disposed) return;
    this.cancelTimer();
    if (!this.opts.isDirty()) return;
    if (!this.inFlight) this.opts.onStatus({ kind: "pending" });
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, this.delay);
  }

  /** Saves now if dirty (after any save in flight). Resolves true when the draft is saved. */
  async flush(): Promise<boolean> {
    if (this.stopped) return false;
    this.cancelTimer();
    if (this.inFlight) await this.inFlight;
    if (this.stopped) return false;
    if (!this.opts.isDirty()) return true;
    const outcome = await this.run();
    return outcome.ok && !this.opts.isDirty();
  }

  /** The author chose Overwrite (or reloaded): saving may resume. */
  resume(): void {
    this.stopped = false;
  }

  /** Stops timers (the editor unmounted, or is leaving). */
  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
  }

  /** Mounted again (React may unmount and remount an effect in development): saving may continue. */
  revive(): void {
    this.disposed = false;
  }

  /** Whether a save is waiting or running (the leave guard reads it). */
  get busy(): boolean {
    return this.timer !== null || this.inFlight !== null;
  }

  private cancelTimer() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private run(): Promise<SaveOutcome> {
    if (this.inFlight) return this.inFlight;
    this.opts.onStatus({ kind: "saving" });
    const current = this.opts.save().catch((): SaveOutcome => ({ ok: false, reason: "failed" }));
    this.inFlight = current.then((outcome) => {
      this.inFlight = null;
      if (this.disposed) return outcome;
      if (!outcome.ok && outcome.conflict) {
        this.stopped = true;
        this.cancelTimer();
        this.opts.onStatus({ kind: "conflict" });
      } else if (!outcome.ok) {
        this.opts.onStatus({ kind: "error", reason: outcome.reason, message: outcome.message ?? null });
      } else if (this.opts.isDirty()) {
        // Edited while saving: save again after the delay.
        this.changed();
      } else {
        this.opts.onStatus({ kind: "saved" });
      }
      return outcome;
    });
    return this.inFlight;
  }
}

/**
 * React wiring: one controller per editor. `seq` is the edit counter; every
 * change re-arms the timer. Returns the status and the controller.
 */
export function useAutosave(opts: Omit<AutosaveOptions, "onStatus"> & { seq: number; enabled: boolean }): {
  status: AutosaveStatus;
  controller: AutosaveController;
} {
  const [status, setStatus] = useState<AutosaveStatus>({ kind: "idle" });
  const [controller] = useState(() => new AutosaveController({
    save: opts.save,
    isDirty: opts.isDirty,
    onStatus: (next) => setStatus(next),
    delayMs: opts.delayMs,
  }));
  // The controller always calls this render's save / isDirty.
  const { save, isDirty } = opts;
  useEffect(() => {
    controller.setCallbacks({ save, isDirty });
  }, [controller, save, isDirty]);
  useEffect(() => {
    if (opts.enabled) controller.changed();
  }, [controller, opts.seq, opts.enabled]);
  useEffect(() => {
    controller.revive();
    return () => controller.dispose();
  }, [controller]);
  return { status, controller };
}
