// Instagram message limits (Phase 11). Pure: no I/O, safe in client components
// (the composer counter and the flow editor use them; graph.ts enforces them).
// Documented on Meta's Send Messages page (checked 2026-11-04) unless marked
// (unconfirmed), which the live check confirms; kept as named constants.

export const INSTAGRAM_LIMITS = {
  textBytes: 1000,
  /** (unconfirmed) quick replies per message, title length and payload length. */
  quickReplies: 13,
  quickReplyTitleChars: 20,
  quickReplyPayloadChars: 1000,
  imageBytes: 8 * 1024 * 1024,
  audioBytes: 25 * 1024 * 1024,
  videoBytes: 25 * 1024 * 1024,
  fileBytes: 25 * 1024 * 1024,
} as const;

const encoder = new TextEncoder();
export const utf8Bytes = (text: string): number => encoder.encode(text).length;

/** A message body Instagram accepts: non-empty, at most 1000 UTF-8 bytes. */
export function validInstagramText(text: unknown): text is string {
  return typeof text === 'string' && text.trim().length > 0 && utf8Bytes(text) <= INSTAGRAM_LIMITS.textBytes;
}

export interface QuickReply { title: string; payload: string }

/** True when the replies fit Instagram's quick-reply limits. */
export function quickRepliesFit(replies: readonly QuickReply[]): boolean {
  return replies.length >= 1 && replies.length <= INSTAGRAM_LIMITS.quickReplies && replies.every((r) =>
    typeof r.title === 'string' && r.title.trim().length > 0 && [...r.title].length <= INSTAGRAM_LIMITS.quickReplyTitleChars &&
    typeof r.payload === 'string' && r.payload.length > 0 && r.payload.length <= INSTAGRAM_LIMITS.quickReplyPayloadChars);
}
