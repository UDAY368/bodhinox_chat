/* eslint-disable @typescript-eslint/no-unused-vars -- Stage 5 contract stub: final signature, no-op body; the owning batch removes this line. */
// Stage 5 contract (5A creates it with its final signature and a safe no-op
// body; 5D implements it; 5B, 5E and 5G call it). Per-channel Instagram
// subscription: contacts.instagram_opted_out_at / instagram_opted_in_at. The
// contact-wide contacts.opted_out_at (WhatsApp STOP) still blocks marketing on
// every channel and is not touched here.
import type { TenantTransaction } from '@/lib/db/tenant';

export type ConsentChannel = 'instagram';
export type ConsentState = 'opted_in' | 'opted_out';

/** The contact fields consent is read from. */
export interface ConsentContact {
  opted_out_at?: string | Date | null;
  instagram_opted_out_at?: string | Date | null;
  instagram_opted_in_at?: string | Date | null;
}

/**
 * Records the contact's state on the channel inside the caller's tenant
 * transaction. No-op until 5D: writes nothing.
 */
export async function setChannelConsent(_tx: TenantTransaction, _accountId: string, _contactId: string,
  _channel: ConsentChannel, _state: ConsentState): Promise<void> {
  // 5D: UPDATE contacts SET instagram_opted_out_at / instagram_opted_in_at.
}

/**
 * Whether flows, automations, default replies and AI may message the contact
 * on Instagram. No-op until 5D: true (behaviour before Stage 5).
 */
export async function instagramAutomationAllowed(_accountId: string, _contactId: string): Promise<boolean> {
  return true;
}

/**
 * The contact's state on a channel from fields already loaded: `opted_out`
 * while instagram_opted_out_at is set, `opted_in` when only
 * instagram_opted_in_at is set, otherwise null (never chose). Pure.
 */
export function channelConsent(contact: ConsentContact | null | undefined, _channel: ConsentChannel): ConsentState | null {
  if (!contact) return null;
  if (contact.instagram_opted_out_at) return 'opted_out';
  if (contact.instagram_opted_in_at) return 'opted_in';
  return null;
}
