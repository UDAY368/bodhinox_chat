import { NextResponse } from 'next/server';
import { ACCESS_LIFETIME_SECONDS } from './jwt';

export const cookieNames = () => ({
  access:
    process.env.NODE_ENV === 'production' ? '__Host-bnx_access' : 'bnx_access',
  refresh:
    process.env.NODE_ENV === 'production'
      ? '__Host-bnx_refresh'
      : 'bnx_refresh',
  csrf: process.env.NODE_ENV === 'production' ? '__Host-bnx_csrf' : 'bnx_csrf',
  recovery:
    process.env.NODE_ENV === 'production'
      ? '__Host-bnx_recovery'
      : 'bnx_recovery',
});
export function readCookie(request: Request, name: string): string | undefined {
  const value = request.headers
    .get('cookie')
    ?.split(';')
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}
const options = (httpOnly = true) => ({
  httpOnly,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
});
export function setSessionCookies(
  response: NextResponse,
  session: {
    accessToken: string;
    refreshToken: string;
    csrfToken: string;
    expiresAt: Date;
  }
): void {
  const names = cookieNames();
  response.cookies.set(names.access, session.accessToken, {
    ...options(),
    maxAge: ACCESS_LIFETIME_SECONDS,
  });
  response.cookies.set(names.refresh, session.refreshToken, {
    ...options(),
    expires: session.expiresAt,
  });
  response.cookies.set(names.csrf, session.csrfToken, {
    ...options(false),
    expires: session.expiresAt,
  });
}
export function setAccessCookie(
  response: NextResponse,
  accessToken: string
): void {
  response.cookies.set(cookieNames().access, accessToken, {
    ...options(),
    maxAge: ACCESS_LIFETIME_SECONDS,
  });
}
export function setRecoveryCookie(response: NextResponse, token: string): void {
  response.cookies.set(cookieNames().recovery, token, {
    ...options(),
    maxAge: 3600,
  });
}
export function clearSessionCookies(response: NextResponse): void {
  for (const name of Object.values(cookieNames()))
    response.cookies.set(name, '', { ...options(), maxAge: 0 });
}
