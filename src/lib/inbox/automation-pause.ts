/* eslint-disable @typescript-eslint/no-unused-vars -- Stage 5 contract stub: final signature, no-op body; the owning batch removes this line. */
// Stage 5 contract (5A creates it with its final signature and a safe no-op
// body; 5D implements it; 5B and 5E call it). Timed pause of automated replies:
// conversations.bot_paused + bot_paused_until (NULL: until resumed) +
// bot_paused_by. Until 5D, nothing is written and the existing pause
// (bot_paused only) behaves exactly as before.

/** Which conversations a pause covers: one conversation, or every conversation of a contact. */
export type PauseTarget = { conversationId: string; contactId?: never } | { contactId: string; conversationId?: never };

export type PauseInput = PauseTarget & {
  /** One of PAUSE_MINUTES_CHOICES (src/lib/flows/types.ts); null pauses until resumed. */
  minutes: number | null;
  /** The member who paused (null for a flow or automation). */
  byUserId: string | null;
};

export type ResumeInput = PauseTarget & { byUserId: string | null };

/** Pauses automated replies. No-op until 5D: writes nothing. */
export async function pauseAutomations(_accountId: string, _input: PauseInput): Promise<void> {
  // 5D: UPDATE conversations SET bot_paused, bot_paused_until, bot_paused_by under withTenant.
}

/** Resumes automated replies. No-op until 5D: writes nothing. */
export async function resumeAutomations(_accountId: string, _input: ResumeInput): Promise<void> {
  // 5D: clears bot_paused, bot_paused_until and bot_paused_by.
}
