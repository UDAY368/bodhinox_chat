/* eslint-disable @typescript-eslint/no-unused-vars -- Stage 5 contract stub: final signature, no-op body; the owning batch removes this line. */
// Stage 5 contract (5A creates it with its final signature and a safe no-op
// body; 5G implements it; 5B calls it for card buy buttons). A buy button opens
// a checkout link made through the existing payment-link code (carrying the run
// id), one link per run, step and button slot. There is no in-DM payment on
// Instagram. A null result drops the button (the engine logs an event).
import type { FlowRunRow, IgCardButton } from './types';

export type BuyButton = Extract<IgCardButton, { type: 'buy' }>;

/** The checkout URL for a buy button, or null. No-op until 5G: null (the button is dropped). */
export async function buyButtonUrl(_run: Pick<FlowRunRow, 'id' | 'account_id' | 'contact_id' | 'conversation_id'>,
  _nodeKey: string, _slot: string, _button: BuyButton): Promise<string | null> {
  return null;
}
