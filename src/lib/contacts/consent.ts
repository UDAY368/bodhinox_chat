// ============================================================
// Contact consent.
//
// Opted out (`opted_out_at`): no marketing — no broadcasts, scheduled
// automations or template steps. Replies to a customer who writes in are
// still allowed. Blocked (`blocked_at`): no automated messages at all —
// no flows, automations, AI replies or broadcasts. Agents can still
// write manually from the inbox.
// ============================================================

import type { DataClient } from '@/lib/data/types';

// shortcut: fixed English keywords; make them a workspace setting when non-English opt-outs matter.
const OPT_OUT = new Set(['STOP', 'STOP ALL', 'UNSUBSCRIBE', 'OPT OUT', 'OPTOUT']);
const OPT_IN = new Set(['START', 'SUBSCRIBE', 'UNSTOP', 'OPT IN', 'OPTIN']);

export type ConsentKeyword = 'opt_out' | 'opt_in';

/** A whole message that is exactly a consent keyword (case and punctuation ignored). */
export function consentKeyword(text: string): ConsentKeyword | null {
  const word = text.trim().replace(/[.!\s]+$/, '').replace(/\s+/g, ' ').toUpperCase();
  if (OPT_OUT.has(word)) return 'opt_out';
  if (OPT_IN.has(word)) return 'opt_in';
  return null;
}

export interface ConsentState {
  opted_out_at?: string | null;
  blocked_at?: string | null;
}

/** Why a contact must not get a marketing send, or null when it may. */
export function marketingSuppression(contact: ConsentState | null | undefined): string | null {
  if (contact?.blocked_at) return 'Contact is blocked';
  if (contact?.opted_out_at) return 'Contact opted out';
  return null;
}

/** Records a keyword opt-out or clears it on opt-in. Idempotent. */
export async function applyConsentKeyword(
  db: DataClient,
  accountId: string,
  contactId: string,
  keyword: ConsentKeyword
): Promise<void> {
  const query = db
    .from('contacts')
    .update(
      keyword === 'opt_out'
        ? { opted_out_at: new Date().toISOString(), opt_out_source: 'keyword' }
        : { opted_out_at: null, opt_out_source: null }
    )
    .eq('id', contactId)
    .eq('account_id', accountId);
  const { error } = await (keyword === 'opt_out' ? query.is('opted_out_at', null) : query);
  if (error) throw new Error('Contact consent update failed');
}
