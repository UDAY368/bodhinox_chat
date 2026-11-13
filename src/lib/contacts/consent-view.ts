import type { Contact } from '@/types';

export type ConsentStatus = 'opted_in' | 'opted_out' | 'none';
export type ConsentSource = NonNullable<Contact['opt_in_source']>;

export interface ConsentView {
  status: ConsentStatus;
  /** When the current status began (null for 'none'). */
  at: string | null;
  /** How it began: the customer's keyword, an agent, the API or an import. */
  source: ConsentSource | null;
}

type ConsentFields = Pick<Contact, 'opted_out_at' | 'opt_out_source' | 'opted_in_at' | 'opt_in_source'>;

/** A contact's WhatsApp consent for display: an opt-out always wins over an earlier opt-in. */
export function consentView(contact: Partial<ConsentFields> | null | undefined): ConsentView {
  if (contact?.opted_out_at) return { status: 'opted_out', at: contact.opted_out_at, source: contact.opt_out_source ?? null };
  if (contact?.opted_in_at) return { status: 'opted_in', at: contact.opted_in_at, source: contact.opt_in_source ?? null };
  return { status: 'none', at: null, source: null };
}

export type ConsentFilter = 'any' | ConsentStatus;

export function matchesConsentFilter(contact: Partial<ConsentFields> | null | undefined, filter: ConsentFilter): boolean {
  return filter === 'any' || consentView(contact).status === filter;
}
