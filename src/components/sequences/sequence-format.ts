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

/** The editor page of a sequence: WhatsApp sequences live under /whatsapp so they open while Instagram is off. */
export function sequencePath(channel: 'instagram' | 'whatsapp' | string | null | undefined, id: string): string {
  return `/${channel === 'whatsapp' ? 'whatsapp' : 'instagram'}/sequences/${encodeURIComponent(id)}`;
}

/** The template variable values a step offers: a contact field, or text typed by hand. */
export const TEMPLATE_FIELD_CHOICES = ['name', 'phone', 'email', 'company'] as const;
export type TemplateFieldChoice = (typeof TEMPLATE_FIELD_CHOICES)[number] | 'text';

/** The field a stored value maps from ({{contact.name|...}} -> name), else 'text'. */
export function templateValueSource(value: string): TemplateFieldChoice {
  const m = /^\{\{contact\.(name|phone|email|company)(?:\|[^{}|]*)?\}\}$/.exec(value.trim());
  return m ? (m[1] as TemplateFieldChoice) : 'text';
}

/** The stored value for a contact field, with a fallback for an empty one. */
export function contactPlaceholder(field: (typeof TEMPLATE_FIELD_CHOICES)[number], fallback = '-'): string {
  const safe = fallback.replace(/[{}|]/g, '').trim().slice(0, 100) || '-';
  return `{{contact.${field}|${safe}}}`;
}

/** How many body values a template needs ({{1}}..{{n}}). */
export function templateVariableCount(bodyText: string): number {
  const nums = [...bodyText.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
  return nums.length ? Math.min(Math.max(...nums), 20) : 0;
}
