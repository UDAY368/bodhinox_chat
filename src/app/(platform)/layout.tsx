// Platform console shell (Phase 14). Rendered only for a signed-in user whose
// verified email is in PLATFORM_ADMIN_EMAILS, who has a verified MFA factor
// and a recent MFA confirmation on this session, and only when
// PLATFORM_DATABASE_URL is set. Everyone else gets notFound(). Pages hold no
// data of their own: they load it from /api/platform/*, which repeats the
// same checks on every call. Not linked from the tenant navigation.

import type { Metadata } from 'next';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { cookieNames } from '@/lib/auth/cookies';
import { platformDatabaseConfigured } from '@/lib/db/prisma';
import { getPlatformPageAccess } from '@/lib/platform/auth';
import { PlatformGate } from './_components/platform-gate';
import { PlatformSessionRefresh } from './_components/platform-session-refresh';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Platform',
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
};

const NAV = [
  ['overview', '/platform'],
  ['tenants', '/platform/tenants'],
  ['plans', '/platform/plans'],
  ['billing', '/platform/billing'],
  ['health', '/platform/health'],
  ['support', '/platform/support'],
  ['audit', '/platform/audit'],
] as const;

export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const access = await getPlatformPageAccess();
  if (!access) {
    // An expired access cookie with a live refresh cookie: refresh on the client, then re-check.
    const jar = await cookies();
    if (platformDatabaseConfigured() && !jar.get(cookieNames().access) && jar.get(cookieNames().refresh)) return <PlatformSessionRefresh />;
    notFound();
  }
  if (access.kind !== 'ok') return <PlatformGate kind={access.kind} />;
  const t = await getTranslations('Platform');
  return (
    <div className="bg-background text-foreground min-h-dvh">
      <header className="border-border border-b">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <span className="text-sm font-semibold">{t('title')}</span>
          <nav aria-label={t('navLabel')} className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {NAV.map(([key, href]) => (
              <Link key={key} href={href} className="text-muted-foreground hover:text-foreground">
                {t(`nav.${key}`)}
              </Link>
            ))}
          </nav>
          <span className="text-muted-foreground ml-auto text-xs">{t('signedInAs', { email: access.admin.email })}</span>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
    </div>
  );
}
