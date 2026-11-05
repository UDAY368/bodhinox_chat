// `/`: the landing page for signed-out visitors (Phase 14). Anyone with a session
// cookie (access or refresh) still goes straight to /dashboard, exactly as before,
// where the proxy refreshes the session or redirects to sign-in as usual.

import { redirect } from 'next/navigation';

import { Landing } from './(marketing)/landing';
import { hasSessionCookie } from './(marketing)/session';
import { MarketingShell } from './(marketing)/shell';

export default async function RootPage() {
  if (await hasSessionCookie()) redirect('/dashboard');
  return (
    <MarketingShell>
      <Landing />
    </MarketingShell>
  );
}
