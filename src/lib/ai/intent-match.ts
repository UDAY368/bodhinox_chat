/* eslint-disable @typescript-eslint/no-unused-vars -- Stage 5 contract stub: final signature, no-op body; the owning batch removes this line. */
// Stage 5 contract (5A creates it with its final signature and a safe no-op
// body; 5G implements it; 5B calls it after every exact trigger failed and
// before default_reply). One classification call per inbound message covers
// every candidate intent flow, cached by message id, with a timeout; a
// timeout, AI off or budget exhausted means no match. Text is never logged.

/** A flow whose keyword trigger uses `match_type: "intent"`. */
export interface IntentCandidate {
  flowId: string;
  /** The intent sentence (≤ FLOW_TRIGGER_LIMITS.intentChars). */
  intent: string;
}

/** The id of the flow whose intent the message matches, or null. No-op until 5G: null. */
export async function intentMatches(_accountId: string, _messageId: string, _text: string,
  _candidates: readonly IntentCandidate[]): Promise<string | null> {
  return null;
}
