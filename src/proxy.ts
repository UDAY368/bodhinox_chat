import { NextResponse, type NextRequest } from 'next/server';
import {
  assertMutation,
  resolveEnrollmentSession,
  resolveSession,
} from '@/lib/auth/session';
import { cookieNames } from '@/lib/auth/cookies';
import { AuthError } from '@/lib/auth/errors';
import { postLoginPath } from '@/lib/auth/callback';
const protectedPaths = [
  '/dashboard',
  '/analytics',
  '/inbox',
  '/contacts',
  '/pipelines',
  '/broadcasts',
  '/ads',
  '/automations',
  '/flows',
  '/forms',
  '/commerce',
  '/agents',
  '/notifications',
  '/settings',
];
export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const response = NextResponse.next();
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Authentication endpoints enforce their own pre-auth/session CSRF protections.
  if (pathname.startsWith('/api/auth/') || pathname === '/auth/callback' || pathname === '/api/health')
    return response;
  const protectedPage = protectedPaths.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`)
  );
  const authPage = ['/login', '/signup', '/forgot-password'].includes(pathname);
  const hasCookie =
    request.cookies.has(cookieNames().access) ||
    request.cookies.has(cookieNames().refresh);
  if (!protectedPage && !authPage && !pathname.startsWith('/api/'))
    return response;
  try {
    const context = hasCookie ? await resolveSession(request) : null;
    if (
      !context &&
      hasCookie &&
      (protectedPage || authPage) &&
      (await resolveEnrollmentSession(request))
    ) {
      const target = request.nextUrl.clone();
      target.pathname = '/mfa';
      target.search = '';
      target.searchParams.set('next', postLoginPath(request.nextUrl.searchParams.get('invite'), request.nextUrl.searchParams.get('next') ?? (protectedPage ? pathname : null)));
      return NextResponse.redirect(target);
    }
    if (
      pathname.startsWith('/api/') &&
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      hasCookie
    ) {
      if (!context)
        return NextResponse.json(
          { error: 'Authentication required' },
          { status: 401 }
        );
      await assertMutation(request, context);
    }
    if (context && authPage) {
      const target = request.nextUrl.clone(),
        invite = request.nextUrl.searchParams.get('invite');
      const destination = new URL(postLoginPath(invite, request.nextUrl.searchParams.get('next')), target.origin);
      target.pathname = destination.pathname;
      target.search = '';
      target.search = destination.search;
      return NextResponse.redirect(target);
    }
    // A refresh cookie allows only the public shell to boot and refresh via POST; every API still authorizes independently.
    if (
      !context &&
      protectedPage &&
      !request.cookies.has(cookieNames().refresh)
    ) {
      const target = request.nextUrl.clone();
      target.pathname = '/login';
      target.search = '';
      target.searchParams.set('next', pathname);
      return NextResponse.redirect(target);
    }
    return response;
  } catch (error) {
    if (error instanceof AuthError)
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    return NextResponse.json(
      { error: 'Authentication service unavailable' },
      { status: 503 }
    );
  }
}
export const config = {
  matcher: [
    "/api/:path*",
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
