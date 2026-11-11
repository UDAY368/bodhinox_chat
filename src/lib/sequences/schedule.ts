// Sequence schedule maths (Stage 5, 5H). Pure: safe in client and server code.
//
// A sequence is an ordered list of messages. Each message waits its delay after
// the previous one went out (the first one after the contact subscribed); a
// delay of 0 is "immediately". Instagram allows automated messages only within
// 24 hours of the person's last message, so a delay longer than that is shown
// with a warning and the worker skips a message whose window has closed.
import { SEQUENCE_DELAY_UNITS, STAGE5_LIMITS, type SequenceDelayUnit } from '@/types';

const UNIT_MS: Record<SequenceDelayUnit, number> = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 };
/** The largest delay, in minutes (the table's own check). */
export const SEQUENCE_MAX_DELAY_MINUTES = STAGE5_LIMITS.sequenceDelayMaxDays * 1440;
const INSTAGRAM_WINDOW_MS = 24 * 3_600_000;

export interface SequenceDelay { amount: number; unit: SequenceDelayUnit }

export function isDelayUnit(value: unknown): value is SequenceDelayUnit {
  return typeof value === 'string' && (SEQUENCE_DELAY_UNITS as readonly string[]).includes(value);
}

/** A whole number of minutes, hours or days from 0 up to the 365-day cap; null otherwise. */
export function parseDelay(amount: unknown, unit: unknown): SequenceDelay | null {
  if (!isDelayUnit(unit) || !Number.isSafeInteger(amount) || (amount as number) < 0) return null;
  if (delayMs({ amount: amount as number, unit }) > SEQUENCE_MAX_DELAY_MINUTES * 60_000) return null;
  return { amount: amount as number, unit };
}

export function delayMs(delay: SequenceDelay): number {
  return delay.amount * UNIT_MS[delay.unit];
}

/** When a message with this delay falls due, counted from `from` (the subscription or the previous send). */
export function dueAt(from: Date, delay: SequenceDelay): Date {
  return new Date(from.getTime() + delayMs(delay));
}

/** Whether the delay alone can carry the message past Instagram's 24-hour automated window. */
export function exceedsInstagramWindow(delay: SequenceDelay): boolean {
  return delayMs(delay) > INSTAGRAM_WINDOW_MS;
}

/**
 * The positions after a reorder: `order` must name every message id of the
 * sequence exactly once. Returns id -> new position (0-based), or null for an
 * order that adds, drops or repeats an id.
 */
export function reorderPositions(current: readonly string[], order: unknown): Map<string, number> | null {
  if (!Array.isArray(order) || order.length !== current.length) return null;
  const known = new Set(current);
  const seen = new Set<string>();
  for (const id of order) {
    if (typeof id !== 'string' || !known.has(id) || seen.has(id)) return null;
    seen.add(id);
  }
  return new Map((order as string[]).map((id, index) => [id, index]));
}

/** Moves one item up or down a list (keyboard reordering); the same list when the move is out of range. */
export function moveItem<T>(items: readonly T[], index: number, offset: -1 | 1): T[] {
  const target = index + offset;
  if (index < 0 || index >= items.length || target < 0 || target >= items.length) return [...items];
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** A rate in whole percent, or null (shown as a dash) when nothing could be counted. */
export function ratePercent(part: number, whole: number): number | null {
  if (!Number.isFinite(whole) || whole <= 0) return null;
  return Math.round((Math.min(part, whole) / whole) * 100);
}
