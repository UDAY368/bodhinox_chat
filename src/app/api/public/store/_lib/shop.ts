/**
 * Shared plumbing for the public shop APIs (/api/public/store/<handle>/**,
 * store plan Phase 1). Same rules as the private storefront APIs
 * (../../shop/_lib/public.ts): the proxy lets these paths through before any
 * session handling, every POST checks its own Origin, bodies are small JSON,
 * an in-memory burst budget per IP runs first and durable limits back it, a
 * handle that is not a published shop is the plain 404, and answers are
 * code-only and never cached. Logs carry no phone number, code or cart.
 */
import { NextResponse } from 'next/server';
import { assertOrigin } from '@/lib/auth/csrf';
import { isShopHandleFormat } from '@/lib/commerce/public-shop';
import { burstAllowed, clientIp, json, notFound, publicError, readBody, tooMany } from '../../shop/_lib/public';

export type HandleParams = { params: Promise<{ handle: string }> };

/** One anonymous POST: Origin, burst, handle format, body, then `work` (null answer = 404). */
export async function shopPost(
  request: Request, { params }: HandleParams, scope: string,
  work: (handle: string, body: Record<string, unknown>, ip: string) => Promise<unknown | null>,
): Promise<NextResponse> {
  try {
    assertOrigin(request);
    if (!burstAllowed('mutate', request)) return tooMany();
    const { handle } = await params;
    if (!isShopHandleFormat(handle)) return notFound();
    const body = await readBody(request);
    if (!body) return json({ code: 'invalid' }, 400);
    const result = await work(handle, body, clientIp(request));
    return result === null ? notFound() : json(result);
  } catch (error) {
    return publicError(error, `store:${scope}`);
  }
}
