// Instagram messaging window (Phase 11), checked on the server before every
// Instagram send and before any outbound intent exists.
//
// Standard: under 24 h since the customer's last message (sender_type
// 'customer'; echoes of sends made in the Instagram app are stored as 'agent'
// and never count). Human Agent: only with INSTAGRAM_HUMAN_AGENT_ENABLED, only
// for a staff composer send, between 24 h and 7 days; the send carries the tag.
// Flows, AI, comment rules, reminders and every other automated path never get
// the tag.
//
// Click-to-Direct (Stage 3): a customer message that came from a click-to-
// Instagram-Direct ad (its referral source is ADS) opens a 7-day window for
// every sender, automated ones included, and no Human Agent tag is used. It
// applies only with INSTAGRAM_CTD_WINDOW_ENABLED (Meta's exact rule is not yet
// confirmed on a live account), counted from the latest such message. Without
// the flag, or without an ad message, the window is the 24 hours above.

export const STANDARD_WINDOW_MS = 24 * 60 * 60 * 1000;
export const HUMAN_AGENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const CTD_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Who is sending: a staff member in the composer, or anything automated. */
export type InstagramSender = 'staff' | 'automated';

export type WindowDecision =
  | { allowed: true; humanAgentTag: boolean; closesAt: Date }
  | { allowed: false; reason: 'instagram_window_closed' };

export interface WindowInput {
  /** The customer's last message time; null when the customer never wrote. */
  lastCustomerAt: Date | null;
  sender: InstagramSender;
  humanAgentEnabled: boolean;
  /** When the customer's latest message from a click-to-Direct ad arrived; null or absent when there was none. */
  adReferralAt?: Date | null;
  /** INSTAGRAM_CTD_WINDOW_ENABLED; off (or absent) ignores adReferralAt. */
  ctdEnabled?: boolean;
  now?: Date;
}

export function instagramWindow(input: WindowInput): WindowDecision {
  const now = (input.now ?? new Date()).getTime();
  const last = input.lastCustomerAt ? input.lastCustomerAt.getTime() : NaN;
  const ad = input.ctdEnabled === true && input.adReferralAt ? input.adReferralAt.getTime() : NaN;
  // An ad message from the future (clock skew beyond a minute) opens nothing.
  const ctdEnd = Number.isFinite(ad) && ad <= now + 60_000 ? ad + CTD_WINDOW_MS : NaN;
  const lastUsable = Number.isFinite(last) && last <= now + 60_000;
  const standardEnd = lastUsable ? last + STANDARD_WINDOW_MS : 0;
  if (ctdEnd > now) return { allowed: true, humanAgentTag: false, closesAt: new Date(Math.max(ctdEnd, standardEnd)) };
  if (!lastUsable) return { allowed: false, reason: 'instagram_window_closed' };
  const age = Math.max(0, now - last);
  if (age < STANDARD_WINDOW_MS) return { allowed: true, humanAgentTag: false, closesAt: new Date(last + STANDARD_WINDOW_MS) };
  if (input.sender === 'staff' && input.humanAgentEnabled && age < HUMAN_AGENT_WINDOW_MS)
    return { allowed: true, humanAgentTag: true, closesAt: new Date(last + HUMAN_AGENT_WINDOW_MS) };
  return { allowed: false, reason: 'instagram_window_closed' };
}

/** What the composer banner shows (no decision is made from it; the server re-checks every send). */
export type WindowBanner =
  | { kind: 'open'; closesAt: Date }
  | { kind: 'human_agent'; closesAt: Date }
  | { kind: 'closed' };

export function instagramWindowBanner(lastCustomerAt: Date | null, humanAgentEnabled: boolean, now: Date = new Date()): WindowBanner {
  const decision = instagramWindow({ lastCustomerAt, sender: 'staff', humanAgentEnabled, now });
  if (!decision.allowed) return { kind: 'closed' };
  return decision.humanAgentTag ? { kind: 'human_agent', closesAt: decision.closesAt } : { kind: 'open', closesAt: decision.closesAt };
}
