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
import { hasHeaderSlot } from './header-slot';

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

  it('gives inbox routes, and only them, the desktop slot for the open-windows strip', () => {
    for (const path of ['/inbox', '/whatsapp/inbox', '/instagram/inbox', '/inbox/abc']) expect(hasHeaderSlot(path)).toBe(true);
    for (const path of ['/contacts', '/whatsapp/flows', '/instagram/automations', '/inboxes', '/settings/inbox']) expect(hasHeaderSlot(path)).toBe(false);
    expect(render('/whatsapp/inbox')).toMatch(/<div data-header-slot="true" class="hidden [^"]*lg:flex"><\/div>/);
    expect(render('/commerce/orders')).not.toContain('data-header-slot');
  });
});
