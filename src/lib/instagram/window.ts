// Instagram messaging window (Phase 11), checked on the server before every
// Instagram send and before any outbound intent exists.
//
// Standard: under 24 h since the customer's last message (sender_type
// 'customer'; echoes of sends made in the Instagram app are stored as 'agent'
// and never count). Human Agent: only with INSTAGRAM_HUMAN_AGENT_ENABLED, only
// for a staff composer send, between 24 h and 7 days; the send carries the tag.
// Flows, AI, comment rules, reminders and every other automated path never get
// the tag. The Click-to-Direct 7-day window is deferred (treated as 24 h).

export const STANDARD_WINDOW_MS = 24 * 60 * 60 * 1000;
export const HUMAN_AGENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

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
  now?: Date;
}

export function instagramWindow(input: WindowInput): WindowDecision {
  const now = (input.now ?? new Date()).getTime();
  const last = input.lastCustomerAt ? input.lastCustomerAt.getTime() : NaN;
  if (!Number.isFinite(last) || last > now + 60_000) return { allowed: false, reason: 'instagram_window_closed' };
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
