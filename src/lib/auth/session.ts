import { cookies, headers } from 'next/headers';
import { getAuthPrisma } from '@/lib/db/prisma';
import { cookieNames, readCookie } from './cookies';
import { verifyAccessToken } from './jwt';
import { assertCsrf, assertOrigin } from './csrf';
import { UnauthorizedError } from './errors';
import { isAccountRole, type AccountRole } from './roles';

export interface AuthContext {
  userId: string;
  accountId: string;
  role: AccountRole;
  sessionId: string;
  expiresAt: number;
  user: {
    id: string;
    email: string;
    user_metadata: { full_name: string };
    created_at?: string;
  };
}
type SessionRow = {
  user_id: string;
  account_id: string;
  role: string;
  email: string;
  full_name: string;
  expires_at: Date;
  created_at: Date;
};
async function resolve(
  request: Request | undefined,
  allowEnrollment: boolean
): Promise<AuthContext | null> {
  const cookie = request
    ? readCookie(request, cookieNames().access)
    : (await cookies()).get(cookieNames().access)?.value;
  const refresh = request
    ? readCookie(request, cookieNames().refresh)
    : (await cookies()).get(cookieNames().refresh)?.value;
  const authorization = request
    ? request.headers.get('authorization')
    : (await headers()).get('authorization');
  const bearer = authorization?.startsWith('Bearer ')
    ? authorization.slice(7).trim()
    : undefined;
  // A request must select one identity transport; API keys are separately resolved by their own endpoint contract.
  if ((cookie || refresh) && bearer) return null;
  const token = cookie ?? bearer;
  if (!token) return null;
  let claims;
  try {
    claims = await verifyAccessToken(token);
  } catch {
    return null;
  }
  const rows = await getAuthPrisma().$queryRaw<SessionRow[]>`
    SELECT s.user_id, s.account_id, s.expires_at, u.email, u.full_name, u.created_at, m.role
    FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id
    JOIN account_memberships m ON m.user_id=s.user_id AND m.account_id=s.account_id
    WHERE s.id=${claims.sid}::uuid AND s.user_id=${claims.sub}::uuid AND s.account_id=${claims.tenant_id}::uuid
      AND s.revoked_at IS NULL AND s.expires_at>NOW() AND u.disabled_at IS NULL AND u.email_verified_at IS NOT NULL
      AND (NOT EXISTS(SELECT 1 FROM auth_mfa_factors f WHERE f.user_id=u.id AND f.verified_at IS NOT NULL) OR s.mfa_verified_at IS NOT NULL)
      AND (${allowEnrollment} OR ${process.env.NODE_ENV !== 'production'} OR m.role NOT IN ('owner','admin')
        OR EXISTS(SELECT 1 FROM auth_mfa_factors f WHERE f.user_id=u.id AND f.verified_at IS NOT NULL))`;
  const row = rows[0];
  if (!row || !isAccountRole(row.role)) return null;
  return {
    userId: row.user_id,
    accountId: row.account_id,
    role: row.role,
    sessionId: claims.sid,
    expiresAt: Math.min(
      claims.exp,
      Math.floor(row.expires_at.getTime() / 1000)
    ),
    user: {
      id: row.user_id,
      email: row.email,
      user_metadata: { full_name: row.full_name },
      created_at: row.created_at.toISOString(),
    },
  };
}
export async function resolveSession(
  request?: Request
): Promise<AuthContext | null> {
  return resolve(request, false);
}
/** Restricted identity for the MFA enrollment endpoints; never use this to authorize CRM data. */
export async function resolveEnrollmentSession(
  request?: Request
): Promise<AuthContext | null> {
  return resolve(request, true);
}
export async function requireSession(request?: Request): Promise<AuthContext> {
  const context = await resolveSession(request);
  if (!context) throw new UnauthorizedError();
  return context;
}
export async function assertMutation(
  request: Request,
  context: AuthContext
): Promise<void> {
  const authorization = request.headers.get('authorization');
  if (
    authorization?.startsWith('Bearer ') &&
    !readCookie(request, cookieNames().access) &&
    !readCookie(request, cookieNames().refresh)
  ) {
    let claims;
    try {
      claims = await verifyAccessToken(authorization.slice(7).trim());
    } catch {
      throw new UnauthorizedError();
    }
    if (
      claims.sid !== context.sessionId ||
      claims.sub !== context.userId ||
      claims.tenant_id !== context.accountId
    )
      throw new UnauthorizedError();
    return;
  }
  assertOrigin(request);
  const rows = await getAuthPrisma().$queryRaw<{ csrf_hash: string }[]>`
    SELECT csrf_hash FROM auth_sessions WHERE id=${context.sessionId}::uuid AND user_id=${context.userId}::uuid
      AND revoked_at IS NULL AND expires_at>NOW()`;
  if (!rows[0]) throw new UnauthorizedError();
  assertCsrf(request, rows[0].csrf_hash);
}
/** Server route compatibility: still requires the real browser Origin and CSRF headers. */
export async function assertCurrentMutation(
  context: AuthContext
): Promise<void> {
  const incoming = await headers();
  await assertMutation(
    new Request('http://internal.invalid', { headers: incoming }),
    context
  );
}
