'use client';

// Rendered by the console layout when the 15-minute access cookie has expired
// but a refresh cookie is still present: one authenticated request through
// authFetch refreshes the session (a 401 triggers the refresh and a retry),
// then the server layout re-checks access. Still signed out -> sign-in page.

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { authFetch } from '@/lib/auth/client';

export function PlatformSessionRefresh() {
  const router = useRouter();
  useEffect(() => {
    let live = true;
    authFetch('/api/platform/tenants', { cache: 'no-store' })
      .then((response) => {
        if (!live) return;
        if (response.status === 401) router.replace('/login');
        else router.refresh();
      })
      .catch(() => {
        if (live) router.replace('/login');
      });
    return () => {
      live = false;
    };
  }, [router]);
  return null;
}
