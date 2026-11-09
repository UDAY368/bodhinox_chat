import { NextResponse } from 'next/server';
import {
  confirmEmailChange,
  isRecoveryTokenValid,
  isVerifyTokenValid,
} from '@/lib/auth/service';
import {
  clearSessionCookies,
  setRecoveryCookie,
  setVerifyCookie,
} from '@/lib/auth/cookies';
import { safeNextPath } from '@/lib/auth/callback';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const token = params.get('token');
  const purpose = params.get('purpose');
  const redirect = (path: string) =>
    new NextResponse(null, {
      status: 303,
      headers: {
        Location: path,
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      },
    });
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token))
    return redirect('/login?error=link_invalid');
  try {
    if (purpose === 'reset' && (await isRecoveryTokenValid(token))) {
      const response = redirect('/reset-password');
      setRecoveryCookie(response, token);
      return response;
    }
    // Verification needs the signup password too (account pre-hijack): keep the token in an
    // HttpOnly cookie and let /verify-email ask for it. Opening the link changes nothing.
    if (purpose === 'verify' && (await isVerifyTokenValid(token))) {
      const next = safeNextPath(params.get('next'));
      const response = redirect(`/verify-email?next=${encodeURIComponent(next)}`);
      setVerifyCookie(response, token);
      return response;
    }
    if (purpose === 'change_email') {
      await confirmEmailChange(token);
      const response = redirect('/login?email_changed=1');
      clearSessionCookies(response);
      return response;
    }
  } catch {
    return redirect('/login?error=link_invalid');
  }
  return redirect('/login?error=link_invalid');
}
