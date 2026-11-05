import { cookies } from 'next/headers';

import { cookieNames } from '@/lib/auth/cookies';

/** Whether the request carries a session cookie (signed in, or able to refresh). */
export async function hasSessionCookie(): Promise<boolean> {
  const jar = await cookies();
  const names = cookieNames();
  return jar.has(names.access) || jar.has(names.refresh);
}
