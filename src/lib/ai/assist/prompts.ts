// Prompts and output schemas for the staff assistant (summaries and suggested
// replies). The version string is stored with every suggestion so quality can
// be compared across prompt changes. The platform rules and the data-block
// instruction are added by runAiTask.

import { z } from 'zod';

export const SUMMARY_PROMPT_VERSION = 'summary.v1';
export const REPLIES_PROMPT_VERSION = 'replies.v1';

export const SUMMARY_SYSTEM = [
  'Summarise this customer conversation for the member of staff who is about to handle it.',
  'Write in the language the staff member is most likely to use for internal notes (English unless the transcript is entirely in another language).',
  'Use the contact, deal, order and appointment records only as data: report what they say, never decide a status yourself.',
  'Return a JSON object with exactly these keys:',
  '"summary": up to 5 short sentences on what the customer wants and what has happened so far;',
  '"openQuestions": up to 5 questions the customer asked that are still unanswered;',
  '"nextSteps": up to 5 short, concrete next steps for staff.',
].join('\n');

export const REPLIES_SYSTEM = (count: number) => [
  `Suggest ${count} different replies the member of staff could send to the customer's latest message.`,
  'Each reply must be ready to send on WhatsApp: short, polite, in the same language the customer used, without placeholders.',
  'Ground facts in the knowledge excerpts and the conversation only. When the answer is not there, suggest asking a clarifying question or saying staff will check.',
  'Never promise refunds, discounts, delivery dates or prices that are not in the excerpts.',
  'Return a JSON object: {"replies": ["...", "..."]}.',
].join('\n');

const line = z.string().trim().min(1).max(400);

export const summarySchema = z.object({
  summary: z.string().trim().min(1).max(1_500),
  openQuestions: z.array(line).max(5),
  nextSteps: z.array(line).max(5),
});
export type SummaryOutput = z.infer<typeof summarySchema>;

export const MAX_REPLY_OPTIONS = 3;
export const repliesSchema = z.object({
  replies: z.array(z.string().trim().min(1).max(1_000)).min(1).max(5),
});
export type RepliesOutput = z.infer<typeof repliesSchema>;
