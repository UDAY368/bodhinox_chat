// Guards shared by every path that turns model output into customer-facing
// text: the inbox draft, suggested replies, auto-reply and the flow ai_reply
// step. Pure helpers plus one small read (is this a health-type workspace).
//
//   input   redactChat masks personal data in chat turns before the call;
//           classifySensitive (safety/sensitive.ts) routes health topics to
//           staff before any call.
//   output  guardCustomerText withholds medical or status claims, withholds
//           text in a script the lexicons cannot read for a health-type
//           workspace, and strips every URL that is not allowed.

import type { TenantTransaction } from '@/lib/db/tenant';
import { appOrigin } from '@/lib/auth/csrf';
import type { AgentProfile } from '../agent-profile';
import type { ChatMessage, KnowledgeCitation } from '../types';
import { checkOutputClaims, failClosedForScript, isHealthBusinessType, type ClaimCategory } from '../safety/claims';
import { redactForProvider } from '../safety/redact';
import { findUrls, stripUnlistedUrls } from '../safety/untrusted';

/** Chat turns with personal data masked; `redacted` when anything changed. */
export function redactChat(messages: readonly ChatMessage[]): { messages: ChatMessage[]; redacted: boolean } {
  let redacted = false;
  const out = messages.map((m) => {
    const r = redactForProvider(m.content);
    if (r.redacted) redacted = true;
    return { ...m, content: r.text };
  });
  return { messages: out, redacted };
}

const urlsIn = findUrls;

export interface UrlAllowlist {
  urls: string[];
  origins: string[];
}

/**
 * What customer-facing output may link to: cited knowledge sources'
 * source_url, links the operator wrote in the agent profile or legacy prompt
 * (trusted operator text), the agent profile's website origin and the app's
 * own origin (booking pages, storefront links). Links merely written inside
 * retrieved knowledge text (a crawled page's third-party links) are not.
 */
export function urlAllowlist(args: {
  citations?: readonly KnowledgeCitation[];
  profile?: Pick<AgentProfile, 'website_url' | 'instructions' | 'greeting'> | null;
  legacyPrompt?: string | null;
}): UrlAllowlist {
  const urls = [
    ...(args.citations ?? []).map((c) => c.source_url).filter((u): u is string => !!u),
    ...urlsIn(args.profile?.instructions), ...urlsIn(args.profile?.greeting), ...urlsIn(args.legacyPrompt),
  ];
  const origins: string[] = [];
  if (args.profile?.website_url) origins.push(args.profile.website_url);
  try {
    origins.push(appOrigin());
  } catch {
    // APP_URL unset (tests): no app origin.
  }
  return { urls, origins };
}

export type CustomerTextGuard =
  | { ok: true; text: string; flags: string[] }
  | { ok: false; reason: 'claim' | 'uncovered_script'; categories: ClaimCategory[]; flags: string[] };

/** Customer-facing text: withheld on a forbidden claim or an unreadable script; unlisted URLs stripped. */
export function guardCustomerText(text: string, opts: { allow: UrlAllowlist; healthWorkspace: boolean }): CustomerTextGuard {
  const claims = checkOutputClaims(text);
  if (claims.blocked) return { ok: false, reason: 'claim', categories: claims.categories, flags: claims.categories.map((c) => `claim_${c}`) };
  if (failClosedForScript(text, opts.healthWorkspace)) return { ok: false, reason: 'uncovered_script', categories: [], flags: ['uncovered_script'] };
  const stripped = stripUnlistedUrls(text, opts.allow);
  return { ok: true, text: stripped.text, flags: stripped.stripped ? ['url_stripped'] : [] };
}

/**
 * Health-type workspace: its agent profile names a health business, or it
 * runs appointment services. Customer output in a script the lexicons cannot
 * read is then withheld. Inside the caller's tenant transaction.
 */
export async function isHealthWorkspace(
  tx: TenantTransaction,
  accountId: string,
  profile: Pick<AgentProfile, 'business_type'> | null,
): Promise<boolean> {
  if (isHealthBusinessType(profile?.business_type)) return true;
  const [row] = await tx.$queryRaw<{ has: boolean }[]>`SELECT EXISTS(
    SELECT 1 FROM appointment_services WHERE account_id=${accountId}::uuid AND archived_at IS NULL) AS has`;
  return row?.has === true;
}
