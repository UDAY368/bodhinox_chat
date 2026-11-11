// Sequences (Stage 5, 5H): pure display helpers shared by the list and the
// timeline editor (no React, so they are unit-tested on their own).
import { exceedsInstagramWindow, parseDelay } from '@/lib/sequences/schedule';
import type { SequenceDelayUnit } from '@/types';

/** A rate in whole percent, or a dash when nothing could be counted (never a misleading 0%). */
export function formatRate(value: number | null): string {
  return value === null ? '—' : `${value}%`;
}

export type ScheduleLabel =
  | { kind: 'immediately'; anchor: 'first' | 'previous' }
  | { kind: 'after'; amount: number; unit: SequenceDelayUnit; anchor: 'first' | 'previous' };

/** What the timeline shows above a message: when it goes out, and counted from what. */
export function scheduleLabel(position: number, amount: number, unit: SequenceDelayUnit): ScheduleLabel {
  const anchor = position === 0 ? 'first' : 'previous';
  return amount === 0 ? { kind: 'immediately', anchor } : { kind: 'after', amount, unit, anchor };
}

/**
 * The delay typed in the schedule editor: a whole number (as text) and a unit.
 * Returns the delay to save, or null with the same rules as the server.
 */
export function parseDelayInput(amount: string, unit: SequenceDelayUnit): { amount: number; unit: SequenceDelayUnit } | null {
  if (!/^\d{1,6}$/.test(amount.trim())) return null;
  return parseDelay(Number(amount.trim()), unit);
}

/** Whether the editor warns that Instagram's 24-hour window can close before this message. */
export function windowWarning(amount: number, unit: SequenceDelayUnit): boolean {
  return exceedsInstagramWindow({ amount, unit });
}
