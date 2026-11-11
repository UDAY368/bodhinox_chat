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

// Built-in English keywords on every channel. Instagram workspaces can add their
// own words in any language (instagram_consent_settings, Stage 5); WhatsApp keeps this set.
// 'STOP PROMOTIONS' is the label of Meta's marketing opt-out quick-reply button.
const OPT_OUT = new Set(['STOP', 'STOP ALL', 'STOP PROMOTIONS', 'UNSUBSCRIBE', 'OPT OUT', 'OPTOUT']);
const OPT_IN = new Set(['START', 'SUBSCRIBE', 'UNSTOP', 'OPT IN', 'OPTIN']);

/** The built-in keywords, for display next to a workspace's own. */
export const BUILT_IN_OPT_OUT = [...OPT_OUT];
export const BUILT_IN_OPT_IN = [...OPT_IN];

export type ConsentKeyword = 'opt_out' | 'opt_in';

/** A workspace's own keywords (stored trimmed and lowercased, 1-50 characters, up to 20 each). */
export interface CustomConsentKeywords {
  optOut: readonly string[];
  optIn: readonly string[];
}

/** How a workspace keyword is stored and compared: trimmed, inner spaces collapsed, case folded. */
export function normalizeConsentKeyword(text: string): string {
  return text.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * A whole message that is exactly a consent keyword: a built-in one (case,
 * punctuation, '_' and '-' ignored), or one of the workspace's own (exact match
 * after trimming and case folding). An opt-out word wins over an opt-in word.
 */
export function consentKeyword(text: string, custom?: CustomConsentKeywords | null): ConsentKeyword | null {
  const word = text.trim().replace(/[.!\s]+$/, '').replace(/[\s_-]+/g, ' ').trim().toUpperCase();
  if (OPT_OUT.has(word)) return 'opt_out';
  if (custom) {
    const own = normalizeConsentKeyword(text);
    if (own && custom.optOut.includes(own)) return 'opt_out';
    if (OPT_IN.has(word)) return 'opt_in';
    if (own && custom.optIn.includes(own)) return 'opt_in';
    return null;
  }
  if (OPT_IN.has(word)) return 'opt_in';
  return null;
}

/**
 * The consent keyword of a template quick-reply tap: its label or its payload.
 * Only an opt-out counts; a 'Start' button usually starts a flow, so a tap never
 * opts in (typing START still does).
 */
export function quickReplyOptOut(label: string | null, payload: string | null): ConsentKeyword | null {
  return [label, payload].some((value) => value && consentKeyword(value) === 'opt_out') ? 'opt_out' : null;
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
