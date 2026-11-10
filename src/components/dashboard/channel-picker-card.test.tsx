// Stage 1 onboarding: "Which channels do you use?" shows only to a workspace
// that never picked channels and has nothing connected; admins choose, others
// wait; Instagram shows "Coming soon" or "Upgrade" when it is not available.
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
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/lib/billing/entitlements', () => ({ getEntitlements: vi.fn() }));

import { ChannelPickerCard, CHOICES, refusedChannel, showChannelPicker } from './channel-picker-card';

const facts = (over: Partial<ChannelFacts> = {}): ChannelFacts => ({
  rows: {}, connections: { whatsapp: 'none', instagram: 'none' }, instagramPlatform: true, instagramPlan: true, ...over,
});
const render = () =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}} getMessageFallback={({ namespace, key }) => `${namespace}.${key}`}>
      <ChannelPickerCard />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  h.canEdit = true;
  h.data = null;
});

describe('showChannelPicker', () => {
  it('shows only with no channel rows and nothing connected', () => {
    expect(showChannelPicker(effectiveChannels(facts()))).toBe(true);
    expect(showChannelPicker(null)).toBe(false);
    expect(showChannelPicker(effectiveChannels(facts({ rows: { whatsapp: true } })))).toBe(false);
    // A long-standing WhatsApp workspace (a number, no rows) never sees it.
    expect(showChannelPicker(effectiveChannels(facts({ connections: { whatsapp: 'live', instagram: 'none' } })))).toBe(false);
    expect(showChannelPicker(effectiveChannels(facts({ connections: { whatsapp: 'attention', instagram: 'none' } })))).toBe(false);
    expect(showChannelPicker(effectiveChannels(facts({ connections: { whatsapp: 'none', instagram: 'live' } })))).toBe(false);
  });

  it('writes a row for both channels whatever the choice, so it never shows again', () => {
    for (const changes of Object.values(CHOICES)) expect(Object.keys(changes).sort()).toEqual(['instagram', 'whatsapp']);
    expect(CHOICES.instagram).toEqual({ whatsapp: false, instagram: true });
    expect(CHOICES.both).toEqual({ whatsapp: true, instagram: true });
  });
});

describe('refusedChannel', () => {
  it('names the channel a refusal is about', () => {
    // Choosing one channel turns the other off; a connected one refuses (409).
    expect(refusedChannel('whatsapp', 'channel_connected')).toBe('instagram');
    expect(refusedChannel('instagram', 'channel_connected')).toBe('whatsapp');
    expect(refusedChannel('instagram', 'plan_required')).toBe('instagram');
    expect(refusedChannel('both', 'platform_off')).toBe('instagram');
  });
});

describe('ChannelPickerCard', () => {
  it('renders nothing when the picker does not apply', () => {
    h.data = effectiveChannels(facts({ rows: { whatsapp: true } }));
    expect(render()).toBe('');
  });

  it('offers admins the three choices', () => {
    h.data = effectiveChannels(facts());
    const html = render();
    expect(html).toContain('data-testid="channel-picker"');
    for (const choice of ['whatsapp', 'instagram', 'both']) expect(html).toContain(`data-channel-choice="${choice}"`);
    expect(html.match(/Channels\.picker\.choose/g)).toHaveLength(3);
    expect(html).not.toContain('Channels.picker.waitingForAdmin');
  });

  it('tells members their admin has not picked yet, with no choices', () => {
    h.canEdit = false;
    h.data = effectiveChannels(facts());
    const html = render();
    expect(html).toContain('Channels.picker.waitingForAdmin');
    expect(html).not.toContain('Channels.picker.choose');
  });

  it('marks Instagram "Coming soon" while the platform is off, and "Upgrade" when the plan lacks it', () => {
    h.data = effectiveChannels(facts({ instagramPlatform: false }));
    let html = render();
    expect(html.match(/Channels\.picker\.comingSoon/g)).toHaveLength(2);
    expect(html.match(/Channels\.picker\.choose/g)).toHaveLength(1);
    h.data = effectiveChannels(facts({ instagramPlan: false }));
    html = render();
    expect(html.match(/Channels\.picker\.upgrade/g)).toHaveLength(2);
    expect(html).toContain('href="/settings?tab=plan"');
  });
});
