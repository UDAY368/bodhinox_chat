import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ pathname: '/commerce/orders/abc' }));
vi.mock('next/navigation', () => ({ usePathname: () => h.pathname, useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ profile: null, signOut: vi.fn() }) }));
vi.mock('@/hooks/use-unread-notifications', () => ({ useUnreadNotifications: () => 0 }));
vi.mock('@/hooks/use-workspace-channels', () => ({ useWorkspaceChannels: () => ({ data: null }) }));
vi.mock('@/components/layout/page-search', () => ({ PageSearch: () => null }));
vi.mock('@/components/layout/mode-toggle', () => ({ ModeToggle: () => null }));

import { Header } from './header';

const render = (pathname: string) => {
  h.pathname = pathname;
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}} getMessageFallback={({ namespace, key }) => `${namespace}.${key}`}>
      <Header />
    </NextIntlClientProvider>,
  );
};

describe('Header', () => {
  it('is a breadcrumb, not a second page title', () => {
    const html = render('/commerce/orders/abc');
    expect(html).not.toContain('<h1');
    expect(html).toContain('<nav aria-label="Sidebar.breadcrumb"');
    expect(html).toMatch(/<a[^>]*href="\/pipelines"[^>]*>Sidebar.sales<\/a>/);
    expect(html).toMatch(/<a[^>]*href="\/commerce\/orders"[^>]*>Sidebar.orders<\/a>/);
    expect(html).not.toContain('aria-current');
    expect(html).toContain('material-chrome');
    expect(html).not.toContain('studio-header-center');
  });

  it('marks the current page as the last crumb, which phones show alone', () => {
    const html = render('/commerce/reviews');
    expect(html).toMatch(/<li class="[^"]*hidden sm:flex[^"]*">.*Sidebar.store/);
    expect(html).toMatch(/<li class="min-w-0 items-center gap-1.5 flex">(?:(?!<li).)*<span aria-current="page"[^>]*>Sidebar.reviews<\/span>/);
  });
});
