'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AuthProvider, useAuth } from '@/hooks/use-auth';
import { Sidebar } from '@/components/layout/sidebar';
import { Header } from '@/components/layout/header';
import { AccountAccessAlert } from '@/components/layout/account-access-alert';
import { TermsBanner } from '@/components/settings/privacy/terms-banner';
import { PresenceHeartbeat } from '@/components/presence/presence-heartbeat';
import { BrowserNotificationsListener } from '@/components/notifications/browser-notifications-listener';

// Auth-gated dashboard shell. Extracted from the layout so the layout
// itself can stay a server component and export metadata (noindex) —
// client components can't export Next's metadata object.

function DashboardShellInner({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  // The flow editor fills the screen in its legacy and per-channel locations.
  const flowEditor = /^(?:\/(?:whatsapp|instagram))?\/flows\/[^/]+$/.test(pathname);
  const t = useTranslations('DashboardShell');

  // Sidebar drawer state — only used on mobile. On lg+ the sidebar is
  // always visible and this stays at `false` (ignored by the component).
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  useEffect(() => {
    if (!loading && !user) {
      router.push('/login');
    }
  }, [user, loading, router]);

  if (loading) {
    return (
      <div className="bg-background flex h-screen items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="border-primary h-8 w-8 animate-spin rounded-full border-2 border-t-transparent" />
          <p className="text-muted-foreground text-sm">{t('loading')}</p>
        </div>
      </div>
    );
  }

  if (!user) return null;

  return (
    <div className={`studio-shell bg-background flex h-dvh overflow-hidden${flowEditor ? ' studio-flow-shell' : ''}`}>
      {/* Reports this tab's online/away presence once we know a user is
          signed in. Headless — renders nothing. */}
      <PresenceHeartbeat />
      {/* Desktop alerts for new customer messages (opt-in via Settings →
          Your profile). Headless — renders nothing. */}
      <BrowserNotificationsListener />
      <Sidebar open={sidebarOpen} onClose={closeSidebar} compact={flowEditor && !sidebarOpen} />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Header showMenuToggle={flowEditor} menuExpanded={sidebarOpen} onOpenSidebar={() => setSidebarOpen(previous => !previous)} />
        {/* Thinner horizontal padding on mobile so cards have room to breathe. */}
        <main className="studio-main flex-1 overflow-y-auto p-4 sm:p-6 xl:px-9 xl:py-8">
          {/* Above every page: writes are being rejected and here's why.
              Renders nothing unless the account/role failed to resolve. */}
          <AccountAccessAlert />
          {/* Nothing unless TERMS_VERSION is set and this user has not accepted it. */}
          <TermsBanner />
          {children}
        </main>
      </div>
    </div>
  );
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <DashboardShellInner>{children}</DashboardShellInner>
    </AuthProvider>
  );
}
