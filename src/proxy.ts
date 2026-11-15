import { NextResponse, type NextRequest } from 'next/server';
import {
  assertMutation,
  resolveEnrollmentSession,
  resolveSession,
} from '@/lib/auth/session';
import { cookieNames } from '@/lib/auth/cookies';
import { AuthError } from '@/lib/auth/errors';
import { postLoginPath } from '@/lib/auth/callback';
import { checkRateLimit } from '@/lib/rate-limit';

/** Public shop page views per client IP per minute (in memory, best effort). */
const STORE_PAGE_BURST = { limit: 240, windowMs: 60_000 };

/** Rightmost x-forwarded-for hop (the edge's view of the client), as the public APIs do. */
function proxyClientIp(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',').map((hop) => hop.trim()).filter(Boolean).at(-1);
  return (forwarded || request.headers.get('x-real-ip')?.trim() || 'unknown').slice(0, 64);
}
const protectedPaths = [
  '/dashboard',
  '/analytics',
  '/inbox',
  '/contacts',
  '/pipelines',
  '/broadcasts',
  '/ads',
  '/automations',
  '/automation',
  '/flows',
  '/forms',
  '/templates',
  '/commerce',
  '/agents',
  '/appointments',
  '/notifications',
  '/reports',
  '/settings',
  // Channel sections (Stage 1): /whatsapp/... and /instagram/...
  '/whatsapp',
  '/instagram',
  // Platform console: signed-out visitors go to login; the console layout itself answers 404 to
  // everyone who is not an allowlisted, MFA-verified platform admin (or without PLATFORM_DATABASE_URL).
  '/platform',
];
export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const response = NextResponse.next();
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Authentication endpoints enforce their own pre-auth/session CSRF protections.
  // Public booking and storefront endpoints are anonymous (the storefront is
  // gated by its own contact-bound token): each mutation checks its own Origin,
  // and a staff session cookie must neither 401 nor demand the staff CSRF header there.
  if (pathname.startsWith('/api/auth/') || pathname === '/auth/callback' || pathname === '/api/health' ||
    pathname.startsWith('/api/public/booking/') || pathname.startsWith('/api/public/shop/') ||
    pathname.startsWith('/api/public/store/'))
    return response;
  // The public shop pages (/s/<handle>): anonymous and indexable, so a burst
  // budget per client IP keeps one visitor from hammering the catalogue.
  if (pathname.startsWith('/s/')) {
    if (!checkRateLimit(`store:page:${proxyClientIp(request)}`, STORE_PAGE_BURST).success)
      return new NextResponse('Too many requests', { status: 429, headers: { 'Retry-After': '60', 'Cache-Control': 'no-store' } });
    return response;
  }
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
