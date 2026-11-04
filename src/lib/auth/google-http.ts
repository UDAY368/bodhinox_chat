import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AuthError, UnauthorizedError } from './errors';
import { authError } from './http';
import { appOrigin, assertCsrf, assertOrigin, hashToken } from './csrf';
import { cookieNames, readCookie, setSessionCookies } from './cookies';
import { postLoginPath } from './callback';
import { assertMutation, requireSession, resolveSession } from './session';
import { enforceAuthRateLimit } from './service';
import {
  beginGoogleFlow,
  completeGoogleFlow,
  completeGooglePendingMfa,
  confirmPasswordForLink,
  FLOW_TTL_SECONDS,
  getGoogleLink,
  googleConfig,
  googleCookieNames,
  googleCookieOptions,
  GoogleOidcError,
  linkGoogleIdentity,
  MFA_TTL_SECONDS,
  openCookie,
  sealPendingMfa,
  signInWithGoogle,
  unlinkGoogleIdentity,
  type FlowState,
  type PendingMfa,
} from './google-oidc';

const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers });
const unavailable = () =>
  json({ error: { message: 'Google sign-in is not configured', code: 'google_unavailable' } }, 503);
function redirect(path: string): NextResponse {
  const response = NextResponse.redirect(new URL(path, appOrigin()), 303);
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}
function clearCookie(response: NextResponse, name: string): void {
  response.cookies.set(name, '', googleCookieOptions(0));
}
async function smallJson(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.includes('application/json'))
    throw new AuthError('JSON content required', 400);
  const text = await request.text();
  if (text.length > 8192) throw new AuthError('Request is too large', 413);
  return JSON.parse(text);
}
const password = z.string().min(1).max(1024);
const userAgent = (request: Request) => request.headers.get('user-agent');

/** GET /api/auth/google: whether Google sign-in is available and, when signed in, the linked account. */
export async function handleGoogleStatus(request: Request): Promise<NextResponse> {
  try {
    const context = await resolveSession(request);
    return json({
      configured: !!googleConfig(),
      linked: context ? await getGoogleLink(context.userId) : null,
    });
  } catch (error) {
    return authError(error);
  }
}

/** DELETE /api/auth/google {currentPassword}: unlinks Google. Works even if Google was unconfigured. */
export async function handleGoogleUnlink(request: Request): Promise<NextResponse> {
  try {
    const context = await requireSession(request);
    await assertMutation(request, context);
    const input = z.object({ currentPassword: password }).strict().parse(await smallJson(request));
    await enforceAuthRateLimit('password', context.userId);
    return json({ unlinked: await unlinkGoogleIdentity(context, input.currentPassword) });
  } catch (error) {
    return authError(error);
  }
}

/** GET /api/auth/google/start?next=&invite=: begins sign-in (top-level navigation from /login). */
export async function handleGoogleSignInStart(request: Request): Promise<NextResponse> {
  const config = googleConfig();
  if (!config) return unavailable();
  try {
    await enforceAuthRateLimit('global-google-start', 'application', 1000, 900);
    const params = new URL(request.url).searchParams;
    const flow = await beginGoogleFlow(
      { mode: 'signin', next: params.get('next'), invite: params.get('invite') },
      config
    );
    const response = NextResponse.redirect(flow.url, 303);
    response.headers.set('Cache-Control', 'no-store');
    response.cookies.set(googleCookieNames().flow, flow.cookie, googleCookieOptions(FLOW_TTL_SECONDS));
    return response;
  } catch (error) {
    if (error instanceof AuthError && error.status === 429) return redirect('/login?error=google_rate_limited');
    if (!(error instanceof GoogleOidcError))
      console.error('Google sign-in start failed', error instanceof Error ? error.name : 'unknown');
    return redirect('/login?error=google_unavailable');
  }
}

/** POST /api/auth/google/start {currentPassword}: begins linking Google to the signed-in user. */
export async function handleGoogleLinkStart(request: Request): Promise<NextResponse> {
  const config = googleConfig();
  if (!config) return unavailable();
  try {
    const context = await requireSession(request);
    await assertMutation(request, context);
    const input = z.object({ currentPassword: password }).strict().parse(await smallJson(request));
    await enforceAuthRateLimit('password', context.userId);
    await confirmPasswordForLink(context.userId, input.currentPassword);
    const flow = await beginGoogleFlow(
      { mode: 'link', userId: context.userId, sessionId: context.sessionId },
      config
    );
    const response = json({ url: flow.url });
    response.cookies.set(googleCookieNames().flow, flow.cookie, googleCookieOptions(FLOW_TTL_SECONDS));
    return response;
  } catch (error) {
    if (error instanceof GoogleOidcError)
      return json({ error: { message: 'Google is unavailable. Try again later.', code: error.code } }, 503);
    return authError(error);
  }
}

/** GET /api/auth/google/callback: Google redirects here with code and state. */
export async function handleGoogleCallback(request: Request): Promise<NextResponse> {
  const config = googleConfig();
  if (!config) return unavailable();
  const names = googleCookieNames();
  const flow = openCookie<FlowState>('flow', readCookie(request, names.flow), config);
  const back = (code: string) => {
    const response = redirect(
      flow?.mode === 'link' ? `/settings?tab=security&google=${code}` : `/login?error=${code}`
    );
    clearCookie(response, names.flow);
    return response;
  };
  try {
    const identity = await completeGoogleFlow(new URL(request.url).searchParams, flow, config);
    if (flow!.mode === 'link') {
      const context = await requireSession(request);
      if (context.userId !== flow!.userId || context.sessionId !== flow!.sessionId)
        return back('google_failed');
      await linkGoogleIdentity(context, identity);
      return back('linked');
    }
    const result = await signInWithGoogle(identity, userAgent(request), flow!.invite);
    if (result.kind === 'mfa') {
      const response = redirect('/login?google=mfa');
      clearCookie(response, names.flow);
      const pending: PendingMfa = { userId: result.userId, next: flow!.next, invite: flow!.invite };
      response.cookies.set(names.mfa, sealPendingMfa(pending, config), googleCookieOptions(MFA_TTL_SECONDS));
      return response;
    }
    // A new identity created from the invitation is already a member: skip the accept page.
    const response = redirect(
      postLoginPath(result.joinedInvite ? null : flow!.invite, flow!.next)
    );
    clearCookie(response, names.flow);
    setSessionCookies(response, result.session);
    return response;
  } catch (error) {
    if (error instanceof GoogleOidcError) return back(error.code);
    if (error instanceof UnauthorizedError) return back('google_failed');
    // Never log tokens, codes or profile data.
    console.error('Google sign-in callback failed', error instanceof Error ? error.name : 'unknown');
    return back('google_unavailable');
  }
}

/** POST /api/auth/google/callback {mfaCode}: finishes sign-in for users with two-step verification. */
export async function handleGoogleMfa(request: Request): Promise<NextResponse> {
  const config = googleConfig();
  if (!config) return unavailable();
  try {
    assertOrigin(request);
    const csrf = readCookie(request, cookieNames().csrf);
    if (!csrf) throw new AuthError('Reload the page and try again', 403, 'csrf_missing');
    assertCsrf(request, hashToken(csrf));
    const input = z.object({ mfaCode: z.string().min(1).max(100) }).strict().parse(await smallJson(request));
    const names = googleCookieNames();
    const pending = openCookie<PendingMfa & { jti?: unknown }>('mfa', readCookie(request, names.mfa), config);
    const session = await completeGooglePendingMfa(pending, input.mfaCode, userAgent(request));
    const response = json({ ok: true, redirect: postLoginPath(pending!.invite, pending!.next) });
    setSessionCookies(response, session);
    clearCookie(response, names.mfa);
    return response;
  } catch (error) {
    if (error instanceof GoogleOidcError)
      return json({ error: { message: 'Sign in with Google again', code: error.code } }, 400);
    return authError(error);
  }
}
