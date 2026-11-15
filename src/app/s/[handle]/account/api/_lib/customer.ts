/**
 * The buyer account API of the public shop (/s/<handle>/account/api/**, store
 * plan Phase 5). It lives under the shop's own path so the one account cookie
 * (Path=/s/<handle>) reaches it and nothing else. The proxy lets /s/ through
 * without the staff session or its CSRF header; every call here is a POST
 * through the shared shopPost helper (Origin, burst, small JSON body, plain
 * 404 for a hidden shop, code-only answers, no caching). Logs carry no phone,
 * token, code or address.
 */
import type { NextResponse } from 'next/server';
import { customerTokenFrom } from '@/lib/commerce/shop-customer-cookie';
import { shopPost, type HandleParams } from '@/app/api/public/store/_lib/shop';

export type { HandleParams };

/** One POST from the account pages; `token` is the account cookie's value (null when absent or malformed). */
export function customerPost(
  request: Request, context: HandleParams, scope: string,
  work: (handle: string, body: Record<string, unknown>, token: string | null, ip: string) => Promise<unknown | null>,
): Promise<NextResponse> {
  const token = customerTokenFrom(request.headers.get('cookie'));
  return shopPost(request, context, `account_${scope}`, (handle, body, ip) => work(handle, body, token, ip));
}
