// Stage 1: Settings › Channels mirrors the server's channel rules (a connected
// channel cannot be turned off, one channel stays on, Instagram needs plan and
// platform) and is read-only for non-admins.
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { effectiveChannels, type ChannelFacts, type WorkspaceChannels } from '@/lib/channels/workspace';

const h = vi.hoisted(() => ({ canEdit: true, data: null as WorkspaceChannels | null }));
vi.mock('@/hooks/use-can', () => ({ useCan: () => h.canEdit }));
vi.mock('@/hooks/use-workspace-channels', () => ({
  ChannelsSaveError: class extends Error {},
  useWorkspaceChannels: () => ({ data: h.data, loading: false, error: false, refresh: vi.fn(), save: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/billing/entitlements', () => ({ getEntitlements: vi.fn() }));

import { ChannelsCard, switchBlock } from './channels-card';

const facts = (over: Partial<ChannelFacts> = {}): ChannelFacts => ({
  rows: {}, connections: { whatsapp: 'none', instagram: 'none' }, instagramPlatform: true, instagramPlan: true, ...over,
});
const render = () =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}} getMessageFallback={({ namespace, key }) => `${namespace}.${key}`}>
      <ChannelsCard />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  h.canEdit = true;
  h.data = null;
});

describe('switchBlock', () => {
  it('blocks turning off a connected channel and the last enabled channel', () => {
    const live = effectiveChannels(facts({ connections: { whatsapp: 'live', instagram: 'none' } }));
    expect(switchBlock(live, 'whatsapp')).toBe('connected');
    expect(switchBlock(live, 'instagram')).toBeNull();
    const onlyWhatsapp = effectiveChannels(facts());
    expect(switchBlock(onlyWhatsapp, 'whatsapp')).toBe('lastChannel');
    const both = effectiveChannels(facts({ rows: { whatsapp: true, instagram: true } }));
    expect(switchBlock(both, 'whatsapp')).toBeNull();
    expect(switchBlock(both, 'instagram')).toBeNull();
  });

  it('blocks Instagram while it is not available', () => {
    expect(switchBlock(effectiveChannels(facts({ instagramPlan: false })), 'instagram')).toBe('unavailable');
    expect(switchBlock(effectiveChannels(facts({ instagramPlatform: false })), 'instagram')).toBe('unavailable');
  });
});

describe('ChannelsCard', () => {
  it('lists both channels with their state; admins get Connect for an enabled, unconnected channel', () => {
    h.data = effectiveChannels(facts({ rows: { whatsapp: true, instagram: true }, connections: { whatsapp: 'live', instagram: 'none' } }));
    const html = render();
    expect(html).toContain('data-channel-row="whatsapp"');
    expect(html).toContain('data-channel-state="live"');
    expect(html).toContain('data-channel-row="instagram"');
    expect(html).toContain('data-channel-state="setup"');
    expect(html).toContain('href="/settings?tab=instagram"');
    expect(html).toContain('Channels.settings.connect');
    expect(html).toContain('Channels.settings.disconnectFirst');
    expect(html).not.toContain('Channels.settings.adminOnly');
  });

  it('shows the plan blocker with an upgrade link', () => {
    h.data = effectiveChannels(facts({ instagramPlan: false }));
    const html = render();
    expect(html).toContain('Channels.settings.notIncluded');
    expect(html).toContain('href="/settings?tab=plan"');
  });

  it('is read-only for members: no connect links, every switch disabled', () => {
    h.canEdit = false;
    h.data = effectiveChannels(facts({ rows: { whatsapp: true, instagram: true } }));
    const html = render();
    expect(html).toContain('Channels.settings.adminOnly');
    expect(html).not.toContain('Channels.settings.connect');
    const switches = html.match(/role="switch"[^>]*>/g) ?? [];
    expect(switches.length).toBe(2);
    for (const element of switches) expect(element).toMatch(/disabled|aria-disabled="true"/);
  });
});
