import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkspaceChannel, WorkspaceChannels } from '@/lib/channels/workspace';

const h = vi.hoisted(() => ({
  pathname: '/dashboard',
  isAdmin: false,
  unread: { all: 0, whatsapp: 0, instagram: 0 },
  data: null as WorkspaceChannels | null,
}));
vi.mock('next/navigation', () => ({ usePathname: () => h.pathname }));
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ profile: null, profileLoading: false, account: null, accountRole: 'agent', signOut: vi.fn() }),
}));
vi.mock('@/hooks/use-can', () => ({ useCan: () => h.isAdmin }));
vi.mock('@/hooks/use-total-unread', () => ({ useTotalUnread: () => h.unread }));
vi.mock('@/hooks/use-unread-notifications', () => ({ useUnreadNotifications: () => 0 }));
vi.mock('@/hooks/use-workspace-channels', () => ({
  useWorkspaceChannels: () => ({ data: h.data, loading: false, error: false, refresh: vi.fn(), save: vi.fn() }),
}));

import { Sidebar } from './sidebar';

const channel = (over: Partial<WorkspaceChannel> & Pick<WorkspaceChannel, 'channel'>): WorkspaceChannel => ({
  available: true, unavailableReason: null, enabled: true, explicit: true, connection: 'live', state: 'live', ...over,
});
const off = { enabled: false, connection: 'none' as const, state: 'off' as const };
function workspace(whatsapp: Partial<WorkspaceChannel>, instagram: Partial<WorkspaceChannel>): WorkspaceChannels {
  const channels = {
    whatsapp: channel({ channel: 'whatsapp', ...whatsapp }),
    instagram: channel({ channel: 'instagram', ...instagram }),
  };
  return { channels, enabled: (['whatsapp', 'instagram'] as const).filter((c) => channels[c].enabled), chosen: true };
}

const render = () =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}} getMessageFallback={({ namespace, key }) => `${namespace}.${key}`}>
      <Sidebar />
    </NextIntlClientProvider>,
  );
const sectionsIn = (html: string) => [...html.matchAll(/data-nav-section="([a-z]+)"/g)].map((m) => m[1]);
const unreadIn = (html: string) => [...html.matchAll(/data-nav-unread="([a-z]+)"/g)].map((m) => m[1]);

beforeEach(() => {
  h.pathname = '/dashboard';
  h.isAdmin = false;
  h.unread = { all: 0, whatsapp: 0, instagram: 0 };
  h.data = null;
});

describe('Sidebar per channel set', () => {
  it('only WhatsApp: eight sections, the WhatsApp inbox as the one Inbox, Campaigns on, no Instagram', () => {
    h.data = workspace({}, off);
    const html = render();
    expect(sectionsIn(html)).toEqual(['inbox', 'contacts', 'automation', 'campaigns', 'sales', 'ai', 'analytics', 'settings']);
    for (const href of ['/whatsapp/inbox', '/contacts', '/automation', '/broadcasts', '/pipelines', '/agents', '/dashboard', '/settings'])
      expect(html).toContain(`href="${href}"`);
    expect(html).not.toContain('href="/inbox"');
    expect(html).not.toContain('/instagram/');
  });

  it('only Instagram: no Campaigns (WhatsApp tools), the Instagram inbox', () => {
    h.data = workspace(off, {});
    const html = render();
    expect(sectionsIn(html)).toEqual(['inbox', 'contacts', 'automation', 'sales', 'ai', 'analytics', 'settings']);
    expect(html).toContain('href="/instagram/inbox"');
    for (const href of ['/broadcasts', '/whatsapp/inbox', '/inbox']) expect(html).not.toContain(`href="${href}"`);
  });

  it('both: one Inbox for every channel', () => {
    h.data = workspace({}, {});
    const html = render();
    expect(html).toContain('href="/inbox"');
    expect(html).not.toContain('href="/whatsapp/inbox"');
  });

  it('shows the no-row default (WhatsApp) until the channel state loads', () => {
    const html = render();
    expect(sectionsIn(html)).toContain('campaigns');
    expect(html).toContain('href="/whatsapp/inbox"');
  });

  it('puts the unread badge on the Inbox, hidden while any inbox is open', () => {
    h.data = workspace({}, {});
    h.unread = { all: 3, whatsapp: 1, instagram: 2 };
    expect(unreadIn(render())).toEqual(['all']);
    h.pathname = '/instagram/inbox';
    expect(unreadIn(render())).toEqual([]);
    h.data = workspace({}, off);
    h.pathname = '/dashboard';
    expect(unreadIn(render())).toEqual(['whatsapp']);
  });

  it('marks the Inbox active on every channel inbox, nested pages included', () => {
    h.data = workspace({}, {});
    for (const path of ['/inbox', '/instagram/inbox/abc', '/whatsapp/inbox']) {
      h.pathname = path;
      expect(render()).toMatch(/href="\/inbox"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/inbox"/);
    }
  });

  it('shows the collapse toggle only when the shell passes one, saying which way it goes', () => {
    expect(render()).not.toContain('data-testid="sidebar-collapse"');
    const withToggle = (compact: boolean) =>
      renderToStaticMarkup(
        <NextIntlClientProvider locale="en" messages={{}} onError={() => {}} getMessageFallback={({ namespace, key }) => `${namespace}.${key}`}>
          <Sidebar compact={compact} onToggleCompact={() => {}} />
        </NextIntlClientProvider>,
      );
    expect(withToggle(false)).toMatch(/data-testid="sidebar-collapse" aria-expanded="true"[^>]*title="Sidebar.collapseSidebar"/);
    expect(withToggle(true)).toMatch(/data-testid="sidebar-collapse" aria-expanded="false"[^>]*title="Sidebar.expandSidebar"/);
  });

  it('marks the right section active for pages that live elsewhere (flows, Instagram tools, commerce, reports)', () => {
    h.data = workspace({}, {});
    const activeSection = () => /data-nav-section="([a-z]+)"[^>]*aria-current="page"/.exec(render())?.[1];
    for (const [path, id] of [['/automation', 'automation'], ['/whatsapp/flows/abc', 'automation'], ['/instagram/flows/abc', 'automation'],
      ['/instagram/comments', 'automation'], ['/commerce/orders', 'sales'], ['/appointments', 'sales'], ['/reports', 'analytics'],
      ['/ads', 'campaigns'], ['/settings', 'settings']] as const) {
      h.pathname = path;
      expect(activeSection()).toBe(id);
    }
    h.pathname = '/notifications';
    expect(activeSection()).toBeUndefined();
  });

  it('puts an amber dot on Settings when an enabled channel needs attention', () => {
    h.data = workspace({}, { connection: 'attention', state: 'attention' });
    const html = render();
    expect(html.match(/data-nav-attention/g)).toHaveLength(1);
    expect(html).toContain('Sidebar.groups.needsAttention');
    h.data = workspace({}, {});
    expect(render()).not.toContain('data-nav-attention');
  });

  it('offers admins of a WhatsApp-only workspace "Add Instagram", with Upgrade when the plan blocks it', () => {
    h.data = workspace({}, off);
    expect(render()).not.toContain('data-nav-add-channel');
    h.isAdmin = true;
    let html = render();
    expect(html).toContain('data-nav-add-channel="instagram"');
    expect(html).toContain('href="/settings?tab=channels"');
    expect(html).not.toContain('data-nav-upgrade');
    h.data = workspace({}, { ...off, available: false, unavailableReason: 'plan', state: 'unavailable' });
    expect(render()).toContain('data-nav-upgrade');
    h.data = workspace({}, { ...off, available: false, unavailableReason: 'platform_off', state: 'unavailable' });
    html = render();
    expect(html).not.toContain('data-nav-add-channel');
  });

  it('names every section link, so the icon rail still says where it goes', () => {
    h.data = workspace({}, {});
    const html = render();
    expect(html).toMatch(/<a[^>]*href="\/pipelines"[^>]*title="Sidebar.sales"|<a[^>]*title="Sidebar.sales"[^>]*href="\/pipelines"/);
    expect(html).toMatch(/title="Sidebar.analytics"/);
  });

  it('never links to ?tab=whatsapp', () => {
    h.data = workspace({}, {});
    expect(render()).not.toContain('tab=whatsapp');
  });
});
