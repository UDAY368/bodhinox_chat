// The 'ai.assess_conversation' job contract, shared by the job, the inbound
// enqueue and the refresh route (kept apart from job.ts to avoid an import cycle).

export const AI_ASSESS_JOB = 'ai.assess_conversation';
/** Debounce slot: one assessment per conversation per 10 minutes. */
export const AI_ASSESS_SLOT_MS = 10 * 60_000;
/** Prompt version stored with every assessment. */
export const ASSESS_PROMPT_VERSION = 'assess.v1';

export interface AssessJobPayload {
  conversationId: string;
}

/** Dedupe key and run time for the slot `now` falls in (run at the slot's end). */
export function assessJobSlot(conversationId: string, now: number = Date.now()): { dedupeKey: string; runAt: Date } {
  const slot = Math.floor(now / AI_ASSESS_SLOT_MS);
  return { dedupeKey: `ai-assess:${conversationId}:${slot}`, runAt: new Date((slot + 1) * AI_ASSESS_SLOT_MS) };
}
