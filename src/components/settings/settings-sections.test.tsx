// Stage 1 channel separation: Settings › Channels is a section, and the tabs
// of a channel the workspace does not use are hidden (an old link to one
// opens Settings › Channels instead).
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';

import { SettingsRail } from './settings-rail';
import { CHANNEL_SECTIONS, hiddenSections, railSection, resolveSection, SETTINGS_SECTIONS, visibleSection } from './settings-sections';
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
  it('shows one Channels entry (WhatsApp and Instagram are its tabs), and the redesign sections', () => {
    const html = render();
    expect(html).toContain('Channels.settings.title');
    expect(html).toContain('Settings.sections.templates');
    expect(html).not.toContain('Settings.sections.whatsapp');
    expect(html).not.toContain('Settings.sections.instagram');
    for (const section of ['workspace', 'integrations', 'audit-log']) expect(html).toContain(`Settings.sections.${section}`);
    // Payments and Meetings & shipping are cards in Integrations now.
    expect(html).not.toContain('Settings.sections.payments');
    expect(html).not.toContain('Settings.sections.connections');
  });

  it('drops the templates tab of a disabled WhatsApp channel', () => {
    const instagramOnly = render(hiddenSections(['instagram']));
    expect(instagramOnly).not.toContain('Settings.sections.templates');
    expect(instagramOnly).toContain('Channels.settings.title');
  });

  it('marks the parent entry active for a child section, and sections with unsaved changes', () => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={{}} onError={() => {}} getMessageFallback={({ namespace, key }) => `${namespace}.${key}`}>
        <SettingsRail active={railSection('whatsapp')} onSelect={() => {}} unsaved={new Set(['workspace'])} />
      </NextIntlClientProvider>,
    );
    const current = html.split('<button').find((button) => button.includes('aria-current="page"')) ?? '';
    expect(current).toContain('Channels.settings.title');
    expect(html).toContain('Settings.unsavedChanges');
  });
});

describe('redesign sections', () => {
  it('opens old links inside their new home and keeps every old tab value valid', () => {
    expect(railSection('whatsapp')).toBe('channels');
    expect(railSection('instagram')).toBe('channels');
    expect(railSection('payments')).toBe('integrations');
    expect(railSection('connections')).toBe('integrations');
    expect(railSection('api')).toBe('api');
    for (const tab of ['payments', 'connections', 'api', 'members', 'workspace', 'integrations', 'audit-log'])
      expect(resolveSection(tab)).toBe(tab);
  });

  it('sends a hidden audit log link to the Overview, not to Channels', () => {
    expect(visibleSection('audit-log', new Set(['audit-log']))).toBe('overview');
  });
});
