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
const groupsIn = (html: string) => [...html.matchAll(/data-nav-group="([a-z]+)"/g)].map((m) => m[1]);
const unreadIn = (html: string) => [...html.matchAll(/data-nav-unread="([a-z]+)"/g)].map((m) => m[1]);

beforeEach(() => {
  h.pathname = '/dashboard';
  h.isAdmin = false;
  h.unread = { all: 0, whatsapp: 0, instagram: 0 };
  h.data = null;
});

describe('Sidebar per channel set', () => {
  it('only WhatsApp: a WhatsApp group with its tools, no All inboxes, no Instagram', () => {
    h.data = workspace({}, off);
    const html = render();
    expect(groupsIn(html)).toEqual(['workspace', 'whatsapp']);
    for (const href of ['/whatsapp/inbox', '/whatsapp/flows', '/whatsapp/automations', '/broadcasts', '/settings?tab=templates', '/forms', '/ads'])
      expect(html).toContain(`href="${href}"`);
    expect(html).not.toContain('href="/inbox"');
    expect(html).not.toContain('/instagram/');
  });

  it('only Instagram: an Instagram group; the WhatsApp tools are hidden', () => {
    h.data = workspace(off, {});
    const html = render();
    expect(groupsIn(html)).toEqual(['workspace', 'instagram']);
    expect(html).toContain('href="/instagram/inbox"');
    expect(html).toContain('href="/instagram/comments"');
    for (const href of ['/broadcasts', '/settings?tab=templates', '/forms', '/ads', '/whatsapp/inbox', '/inbox'])
      expect(html).not.toContain(`href="${href}"`);
  });

  it('both: both groups and All inboxes', () => {
    h.data = workspace({}, {});
    const html = render();
    expect(groupsIn(html)).toEqual(['workspace', 'whatsapp', 'instagram']);
    expect(html).toContain('href="/inbox"');
    expect(html).toContain('Sidebar.allInboxes');
  });

  it('shows the no-row default (WhatsApp) until the channel state loads', () => {
    expect(groupsIn(render())).toEqual(['workspace', 'whatsapp']);
  });

  it('gives each inbox its own unread badge, hidden while that inbox is open', () => {
    h.data = workspace({}, {});
    h.unread = { all: 3, whatsapp: 1, instagram: 2 };
    expect(unreadIn(render())).toEqual(['all', 'whatsapp', 'instagram']);
    h.pathname = '/instagram/inbox';
    expect(unreadIn(render())).toEqual(['all', 'whatsapp']);
    h.unread = { all: 1, whatsapp: 1, instagram: 0 };
    h.pathname = '/dashboard';
    expect(unreadIn(render())).toEqual(['all', 'whatsapp']);
  });

  it('marks the active page, including nested channel pages', () => {
    h.data = workspace({}, {});
    h.pathname = '/instagram/flows/abc';
    expect(render()).toMatch(/aria-current="page"[^>]*href="\/instagram\/flows"|href="\/instagram\/flows"[^>]*aria-current="page"/);
  });

  it('puts an amber dot on a channel group that needs attention', () => {
    h.data = workspace({}, { connection: 'attention', state: 'attention' });
    const html = render();
    expect(html.match(/data-nav-attention/g)).toHaveLength(1);
    expect(html).toContain('Sidebar.groups.needsAttention');
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

  it('never links to ?tab=whatsapp', () => {
    h.data = workspace({}, {});
    expect(render()).not.toContain('tab=whatsapp');
  });
});
