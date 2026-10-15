import { NextResponse } from 'next/server';
import {
  confirmEmailChange,
  isRecoveryTokenValid,
  verifyEmailToken,
} from '@/lib/auth/service';
import { clearSessionCookies, setRecoveryCookie } from '@/lib/auth/cookies';
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
    if (purpose === 'verify') {
      await verifyEmailToken(token);
      const next = safeNextPath(params.get('next'));
      return redirect(`/login?verified=1&next=${encodeURIComponent(next)}`);
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
