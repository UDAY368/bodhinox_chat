// The chrome of the public pages (Phase 14): landing (src/app/page.tsx), pricing,
// help, privacy and terms. Static and localized; no tenant data is read.

import type { ReactNode } from 'react';
import Link from 'next/link';
import { MessageSquare } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

export async function MarketingShell({ children }: { children: ReactNode }) {
  const t = await getTranslations('Marketing.nav');
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="border-b border-border">
        <nav className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link href="/" className="flex items-center gap-2 font-semibold">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10">
              <MessageSquare className="size-4 text-primary" />
            </span>
            Bodhinox Chat
          </Link>
          <div className="flex flex-1 items-center gap-5 text-sm text-muted-foreground">
            <Link href="/pricing" className="hover:text-foreground">{t('pricing')}</Link>
            <Link href="/help" className="hover:text-foreground">{t('help')}</Link>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <Link href="/login" className="text-muted-foreground hover:text-foreground">{t('signIn')}</Link>
            <Link href="/signup" className="rounded-lg bg-primary px-3 py-1.5 font-medium text-primary-foreground hover:bg-primary/90">
              {t('getStarted')}
            </Link>
          </div>
        </nav>
      </header>
      <main className="flex-1">{children}</main>
      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-6 text-sm text-muted-foreground">
          <span>© Bodhinox Chat</span>
          <Link href="/pricing" className="hover:text-foreground">{t('pricing')}</Link>
          <Link href="/help" className="hover:text-foreground">{t('help')}</Link>
          <Link href="/privacy" className="hover:text-foreground">{t('privacy')}</Link>
          <Link href="/terms" className="hover:text-foreground">{t('terms')}</Link>
        </div>
      </footer>
    </div>
  );
}
