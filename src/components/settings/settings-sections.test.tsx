// Stage 1 channel separation: Settings › Channels is a section, and the tabs
// of a channel the workspace does not use are hidden (an old link to one
// opens Settings › Channels instead).
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';

import { SettingsRail } from './settings-rail';
import { CHANNEL_SECTIONS, hiddenSections, resolveSection, SETTINGS_SECTIONS, visibleSection } from './settings-sections';
import { CHANNELS_SETTINGS_PATH, channelSettingsPath } from '@/lib/channels/routes';

const render = (hidden?: ReadonlySet<(typeof SETTINGS_SECTIONS)[number]>) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}} getMessageFallback={({ namespace, key }) => `${namespace}.${key}`}>
      <SettingsRail active="overview" onSelect={() => {}} hidden={hidden} />
    </NextIntlClientProvider>,
  );

describe('settings sections per channel', () => {
  it('has a Channels section reachable at the channels settings path', () => {
    expect(SETTINGS_SECTIONS).toContain('channels');
    expect(resolveSection(new URLSearchParams(CHANNELS_SETTINGS_PATH.split('?')[1]).get('tab'))).toBe('channels');
    for (const channel of ['whatsapp', 'instagram'] as const)
      expect(resolveSection(new URLSearchParams(channelSettingsPath(channel).split('?')[1]).get('tab'))).toBe(channel);
  });

  it('hides nothing until the channel state is known, or when both channels are on', () => {
    expect([...hiddenSections(null)]).toEqual([]);
    expect([...hiddenSections(['whatsapp', 'instagram'])]).toEqual([]);
  });

  it('hides WhatsApp and its templates for an Instagram-only workspace, and Instagram for a WhatsApp-only one', () => {
    expect([...hiddenSections(['instagram'])].sort()).toEqual([...CHANNEL_SECTIONS.whatsapp].sort());
    expect([...hiddenSections(['whatsapp'])]).toEqual(['instagram']);
  });

  it('opens Settings › Channels for an old link to a hidden channel tab, and anything else as asked', () => {
    const hidden = hiddenSections(['whatsapp']);
    expect(visibleSection(resolveSection('instagram'), hidden)).toBe('channels');
    expect(visibleSection(resolveSection('whatsapp'), hidden)).toBe('whatsapp');
    expect(visibleSection(resolveSection('members'), hiddenSections(['instagram']))).toBe('members');
    expect(visibleSection(resolveSection('templates'), hiddenSections(['instagram']))).toBe('channels');
  });
});

describe('SettingsRail', () => {
  it('shows every tab, including Channels, when nothing is hidden', () => {
    const html = render();
    expect(html).toContain('Settings.sections.whatsapp');
    expect(html).toContain('Settings.sections.instagram');
    expect(html).toContain('Settings.sections.templates');
    expect(html).toContain('Channels.settings.title');
  });

  it('drops the tabs of a disabled channel', () => {
    const instagramOnly = render(hiddenSections(['instagram']));
    expect(instagramOnly).not.toContain('Settings.sections.whatsapp');
    expect(instagramOnly).not.toContain('Settings.sections.templates');
    expect(instagramOnly).toContain('Settings.sections.instagram');
    const whatsappOnly = render(hiddenSections(['whatsapp']));
    expect(whatsappOnly).not.toContain('Settings.sections.instagram');
    expect(whatsappOnly).toContain('Settings.sections.whatsapp');
    expect(whatsappOnly).toContain('Channels.settings.title');
  });
});
