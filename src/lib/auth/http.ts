import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthPrisma } from '@/lib/db/prisma';
import { AuthError, UnauthorizedError } from './errors';
import { checkAuthEmailTransport, sendAuthEmail } from './email';
import {
  appOrigin,
  assertCsrf,
  assertOrigin,
  hashToken,
  randomToken,
} from './csrf';
import {
  clearSessionCookies,
  cookieNames,
  readCookie,
  setAccessCookie,
  setSessionCookies,
} from './cookies';
import {
  assertMutation,
  requireSession,
  resolveEnrollmentSession,
} from './session';
import {
  disableMfa,
  enrollMfa,
  getMfaStatus,
  verifyMfaEnrollment,
} from './mfa';
import {
  enforceAuthRateLimit,
  isRecoveryTokenValid,
  login,
  requestEmail,
  requestEmailChange,
  resetPassword,
  revokeSessions,
  rotateRefreshToken,
  signup,
  switchTenant,
  updatePassword,
  type IssuedSession,
} from './service';

const email = z.string().email().max(254);
const password = z.string().min(1).max(1024);
const code = z.string().max(100).optional();
function json(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  });
}
export function authError(error: unknown): NextResponse {
  if (error instanceof AuthError)
    return json(
      { error: { message: error.message, code: error.code } },
      error.status
    );
  if (error instanceof z.ZodError || error instanceof SyntaxError)
    return json(
      { error: { message: 'Invalid request', code: 'invalid_input' } },
      400
    );
  // Never log request/cookie/password material or DB connection strings.
  console.error(
    'Authentication operation failed',
    error instanceof Error ? error.name : 'unknown'
  );
  return json(
    {
      error: {
        message: 'Authentication service unavailable',
        code: 'unavailable',
      },
    },
    503
  );
}
async function body(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.includes('application/json'))
    throw new AuthError('JSON content required', 400);
  const reader = request.body?.getReader();
  if (!reader) throw new AuthError('JSON body required', 400);
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.byteLength;
    if (length > 8192) {
      await reader.cancel();
      throw new AuthError('Request is too large', 413);
    }
    chunks.push(part.value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function assertPreauthCsrf(request: Request): void {
  assertOrigin(request);
  const token = readCookie(request, cookieNames().csrf);
  if (!token)
    throw new AuthError('Reload the page and try again', 403, 'csrf_missing');
  assertCsrf(request, hashToken(token));
}
export function assertTokenClient(request: Request): void {
  if (
    new URL(request.url).protocol !== 'https:' ||
    new URL(appOrigin()).protocol !== 'https:' ||
    request.headers.has('cookie') ||
    request.headers.has('origin') ||
    [...request.headers.keys()].some((name) => name.startsWith('sec-fetch-'))
  ) {
    throw new AuthError(
      'Token-client mode requires HTTPS and a non-browser request without cookies',
      403,
      'invalid_client_mode'
    );
  }
}
function tokenResponse(issued: IssuedSession): NextResponse {
  return json({
    access_token: issued.accessToken,
    refresh_token: issued.refreshToken,
    csrf_token: issued.csrfToken,
    token_type: 'Bearer',
    expires_in: 900,
    refresh_expires_at: issued.expiresAt.toISOString(),
  });
}
export async function handleAuthGet(
  request: Request,
  action: string
): Promise<NextResponse> {
  try {
    if (action === 'email-status') {
      const context = await requireSession(request);
      if (context.role !== 'owner') throw new AuthError('Owner access required', 403, 'forbidden');
      await enforceAuthRateLimit('email-status', context.userId, 5, 900);
      return json(await checkAuthEmailTransport());
    }
    if (action === 'csrf') {
      const response = json({ ok: true });
      // Keep the session CSRF cookie stable: replacing it here would desynchronize its database hash.
      if (!readCookie(request, cookieNames().csrf))
        response.cookies.set(cookieNames().csrf, randomToken(), {
          secure: process.env.NODE_ENV === 'production',
          httpOnly: false,
          sameSite: 'strict',
          path: '/',
          maxAge: 86400,
        });
      return response;
    }
    if (action === 'recovery') {
      const token = readCookie(request, cookieNames().recovery);
      return json({ valid: !!token && (await isRecoveryTokenValid(token)) });
    }
    if (action === 'session') {
      const context = await resolveEnrollmentSession(request);
      if (!context) return json({ session: null }, 401);
      const mfaRequired =
        process.env.NODE_ENV === 'production' &&
        ['owner', 'admin'].includes(context.role) &&
        !(await getMfaStatus(context));
      return json({
        session: {
          user: context.user,
          expires_at: context.expiresAt,
          accountId: context.accountId,
          role: context.role,
          mfaRequired,
        },
      });
    }
    if (action === 'mfa') {
      const context = await resolveEnrollmentSession(request);
      if (!context) throw new UnauthorizedError();
      return json({ enabled: await getMfaStatus(context) });
    }
    return json({ error: { message: 'Not found' } }, 404);
  } catch (error) {
    return authError(error);
  }
}
export async function handleAuthPost(
  request: Request,
  action: string
): Promise<NextResponse> {
  try {
    if (action === 'token-login' || action === 'token-refresh') {
      assertTokenClient(request);
      await enforceAuthRateLimit(`global-${action}`, 'application', 1000, 900);
      const input = await body(request);
      if (action === 'token-login') {
        const parsed = z
          .object({
            clientMode: z.literal('token'),
            email,
            password,
            mfaCode: code,
            accountId: z.string().uuid().optional(),
          })
          .strict()
          .parse(input);
        return tokenResponse(await login(parsed));
      }
      const parsed = z
        .object({
          clientMode: z.literal('token'),
          refreshToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
          csrfToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        })
        .strict()
        .parse(input);
      const incoming = new Headers(request.headers);
      incoming.set('x-csrf-token', parsed.csrfToken);
      return tokenResponse(
        await rotateRefreshToken(
          parsed.refreshToken,
          new Request(request.url, { headers: incoming }),
          true
        )
      );
    }
    if (
      [
        'login',
        'signup',
        'reset-request',
        'verify-request',
        'reset',
        'refresh',
      ].includes(action)
    ) {
      assertPreauthCsrf(request);
      if (action !== 'refresh')
        await enforceAuthRateLimit(
          `global-${action}`,
          'application',
          action === 'signup' ? 100 : 1000,
          900
        );
      if (action === 'refresh') {
        const token = readCookie(request, cookieNames().refresh);
        if (!token) throw new UnauthorizedError();
        const response = json({ ok: true });
        setSessionCookies(response, await rotateRefreshToken(token, request));
        return response;
      }
      const input = await body(request);
      if (action === 'login') {
        const parsed = z
          .object({
            email,
            password,
            mfaCode: code,
            accountId: z.string().uuid().optional(),
          })
          .strict()
          .parse(input);
        const response = json({ ok: true });
        setSessionCookies(response, await login(parsed));
        return response;
      }
      if (action === 'signup') {
        await signup(
          z
            .object({
              email,
              password,
              fullName: z.string().min(1).max(200),
              next: z.string().max(2048).optional(),
            })
            .strict()
            .parse(input)
        );
        return json({ ok: true });
      }
      if (action === 'reset-request' || action === 'verify-request') {
        const parsed = z
          .object({ email, next: z.string().max(2048).optional() })
          .strict()
          .parse(input);
        await requestEmail({
          ...parsed,
          purpose: action === 'reset-request' ? 'reset' : 'verify',
        });
        return json({ ok: true });
      }
      const parsed = z
        .object({ password, mfaCode: code })
        .strict()
        .parse(input);
      const token = readCookie(request, cookieNames().recovery);
      if (!token)
        throw new UnauthorizedError('Request a new password reset link');
      await enforceAuthRateLimit('reset-token', hashToken(token));
      await resetPassword(token, parsed.password, parsed.mfaCode);
      const response = json({ ok: true });
      clearSessionCookies(response);
      return response;
    }
    const restrictedAction =
      action.startsWith('mfa-') ||
      action === 'logout' ||
      action === 'logout-all';
    const context = restrictedAction
      ? await resolveEnrollmentSession(request)
      : await requireSession(request);
    if (!context) throw new UnauthorizedError();
    await assertMutation(request, context);
    if (action === 'logout' || action === 'logout-all') {
      await revokeSessions(context, action === 'logout-all');
      const response = json({ ok: true });
      clearSessionCookies(response);
      return response;
    }
    const input = await body(request);
    if (action === 'email-test') {
      if (context.role !== 'owner') throw new AuthError('Owner access required', 403, 'forbidden');
      z.object({}).strict().parse(input);
      await enforceAuthRateLimit('email-test', context.userId, 3, 900);
      await sendAuthEmail({
        from: process.env.AUTH_EMAIL_FROM,
        to: context.user.email,
        subject: 'Bodhinox Chat email verification delivery test',
        text: 'Delivery test for account verification emails. No action is required. Your password and team memberships have not changed.',
      });
      return json({ ok: true });
    }
    if (action === 'switch') {
      const parsed = z
        .object({
          accountId: z.string().uuid(),
          clientMode: z.literal('token').optional(),
        })
        .strict()
        .parse(input);
      if (parsed.clientMode) assertTokenClient(request);
      else if (request.headers.has('authorization'))
        throw new AuthError('Declare token client mode', 400);
      const switched = await switchTenant(context, parsed.accountId);
      if (parsed.clientMode)
        return json({
          access_token: switched.accessToken,
          token_type: 'Bearer',
          expires_in: 900,
        });
      const response = json({ ok: true });
      setAccessCookie(response, switched.accessToken);
      return response;
    }
    if (action === 'password') {
      const parsed = z
        .object({ password, currentPassword: password, mfaCode: code })
        .strict()
        .parse(input);
      await enforceAuthRateLimit('password', context.userId);
      await updatePassword(
        context,
        parsed.password,
        parsed.currentPassword,
        parsed.mfaCode
      );
      const response = json({ ok: true });
      clearSessionCookies(response);
      return response;
    }
    if (action === 'email-change') {
      const parsed = z
        .object({ email, currentPassword: password, mfaCode: code })
        .strict()
        .parse(input);
      await requestEmailChange(
        context,
        parsed.email,
        parsed.currentPassword,
        parsed.mfaCode
      );
      return json({ ok: true });
    }
    if (action === 'user') {
      const parsed = z
        .object({ fullName: z.string().min(1).max(200) })
        .strict()
        .parse(input);
      await getAuthPrisma().$transaction(async (tx) => {
        await tx.$executeRaw`UPDATE auth_users SET full_name=${parsed.fullName} WHERE id=${context.userId}::uuid AND disabled_at IS NULL`;
        await tx.$executeRaw`UPDATE profiles SET full_name=${parsed.fullName},updated_at=NOW() WHERE user_id=${context.userId}::uuid`;
      });
      return json({ ok: true });
    }
    if (action.startsWith('mfa-')) {
      await enforceAuthRateLimit('mfa', context.userId);
      if (action === 'mfa-enroll') {
        const parsed = z
          .object({ currentPassword: password })
          .strict()
          .parse(input);
        return json(await enrollMfa(context, parsed.currentPassword));
      }
      if (action === 'mfa-verify') {
        const parsed = z
          .object({ code: z.string().regex(/^\d{6}$/) })
          .strict()
          .parse(input);
        return json({
          recoveryCodes: await verifyMfaEnrollment(context, parsed.code),
        });
      }
      if (action === 'mfa-disable') {
        const parsed = z
          .object({
            currentPassword: password,
            code: z.string().min(1).max(100),
          })
          .strict()
          .parse(input);
        await disableMfa(context, parsed.currentPassword, parsed.code);
        const response = json({ ok: true });
        clearSessionCookies(response);
        return response;
      }
    }
    return json({ error: { message: 'Not found' } }, 404);
  } catch (error) {
    return authError(error);
  }
}
