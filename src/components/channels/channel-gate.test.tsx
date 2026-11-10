import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkspaceChannel, WorkspaceChannels } from '@/lib/channels/workspace';

const h = vi.hoisted(() => ({
  canEdit: true,
  pathname: '/instagram/flows',
  hook: { data: null as WorkspaceChannels | null, loading: false, error: false },
}));
vi.mock('@/hooks/use-can', () => ({ useCan: () => h.canEdit }));
vi.mock('next/navigation', () => ({ usePathname: () => h.pathname }));
vi.mock('@/hooks/use-workspace-channels', () => ({
  ChannelsSaveError: class extends Error {},
  useWorkspaceChannels: () => ({ ...h.hook, refresh: vi.fn(), save: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

import { ChannelGate } from './channel-gate';

const channel = (over: Partial<WorkspaceChannel> & Pick<WorkspaceChannel, 'channel'>): WorkspaceChannel => ({
  available: true, unavailableReason: null, enabled: true, explicit: false, connection: 'live', state: 'live', ...over,
});
const workspace = (instagram: Partial<WorkspaceChannel>): WorkspaceChannels => ({
  channels: { whatsapp: channel({ channel: 'whatsapp' }), instagram: channel({ channel: 'instagram', ...instagram }) },
  enabled: ['whatsapp'],
  chosen: true,
});

const render = (target: 'whatsapp' | 'instagram' = 'instagram') =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}} getMessageFallback={({ namespace, key }) => `${namespace}.${key}`}>
      <ChannelGate channel={target}><main>section page</main></ChannelGate>
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  h.canEdit = true;
  h.pathname = '/instagram/flows';
  h.hook = { data: null, loading: false, error: false };
});

describe('ChannelGate', () => {
  it('renders the page for a live channel with no banner', () => {
    h.hook.data = workspace({});
    const html = render();
    expect(html).toContain('section page');
    expect(html).not.toContain('data-channel-banner');
  });

  it('explains an off channel instead of rendering the page, with Turn on for admins', () => {
    h.hook.data = workspace({ enabled: false, state: 'off', connection: 'none' });
    let html = render();
    expect(html).not.toContain('section page');
    expect(html).toContain('ChannelGate.offTitle');
    expect(html).toContain('ChannelGate.turnOn');
    h.canEdit = false;
    html = render();
    expect(html).toContain('ChannelGate.askAdmin');
    expect(html).not.toContain('ChannelGate.turnOn');
  });

  it('passes through the page that gates itself, even while loading or off', () => {
    const passthrough = (pathname: string) => {
      h.pathname = pathname;
      return renderToStaticMarkup(
        <NextIntlClientProvider locale="en" messages={{}} onError={() => {}} getMessageFallback={({ namespace, key }) => `${namespace}.${key}`}>
          <ChannelGate channel="instagram" exceptPath="/instagram/inbox"><main>section page</main></ChannelGate>
        </NextIntlClientProvider>,
      );
    };
    h.hook = { data: null, loading: true, error: false };
    expect(passthrough('/instagram/inbox')).toContain('section page');
    h.hook.data = workspace({ available: false, unavailableReason: 'platform_off', enabled: false, state: 'unavailable' });
    expect(passthrough('/instagram/inbox')).toContain('section page');
    // Every other page in the section stays gated.
    expect(passthrough('/instagram/flows')).not.toContain('section page');
  });

  it('says why an unavailable channel shows nothing (plan or platform)', () => {
    h.hook.data = workspace({ available: false, unavailableReason: 'plan', enabled: false, state: 'unavailable' });
    expect(render()).toContain('ChannelGate.unavailablePlanTitle');
    expect(render()).toContain('/settings?tab=plan');
    h.hook.data = workspace({ available: false, unavailableReason: 'platform_off', enabled: false, state: 'unavailable' });
    expect(render()).toContain('ChannelGate.unavailablePlatformTitle');
    expect(render()).not.toContain('section page');
  });

  it('shows the setup banner with a connect link for admins and the Instagram routing hint', () => {
    h.hook.data = workspace({ connection: 'none', state: 'setup' });
    let html = render();
    expect(html).toContain('section page');
    expect(html).toContain('data-channel-banner="setup"');
    expect(html).toContain('ChannelGate.setupInstagram');
    expect(html).toContain('ChannelGate.instagramRoutingHint');
    expect(html).toContain('/settings?tab=instagram');
    h.canEdit = false;
    html = render();
    expect(html).not.toContain('/settings?tab=instagram');
    expect(html).toContain('ChannelGate.askAdmin');
  });

  it('shows the attention banner, but leaves it to the inbox and flow editor to place their own', () => {
    h.hook.data = workspace({ connection: 'attention', state: 'attention' });
    expect(render()).toContain('ChannelGate.attentionInstagram');
    h.pathname = '/instagram/inbox';
    expect(render()).not.toContain('data-channel-banner');
    h.pathname = '/instagram/flows/abc';
    expect(render()).not.toContain('data-channel-banner');
  });

  it('waits while loading and fails open when the state cannot be loaded', () => {
    h.hook = { data: null, loading: true, error: false };
    expect(render()).toContain('ChannelGate.loading');
    expect(render()).not.toContain('section page');
    h.hook = { data: null, loading: false, error: true };
    expect(render()).toContain('section page');
  });

  it('gates WhatsApp the same way', () => {
    h.pathname = '/whatsapp/automations';
    h.hook.data = workspace({});
    h.hook.data.channels.whatsapp = channel({ channel: 'whatsapp', enabled: false, state: 'off', connection: 'none' });
    expect(render('whatsapp')).toContain('ChannelGate.offTitle');
  });
});
