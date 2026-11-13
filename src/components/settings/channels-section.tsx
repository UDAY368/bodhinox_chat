'use client';

/**
 * Settings › Channels as one section (the prototype's layout): Overview, where
 * each channel is turned on or off, then one tab per channel the workspace
 * uses with its full connection page (WhatsApp numbers, embedded signup,
 * green-tick checklist and business profile; the Instagram account). Each tab
 * keeps its old URL (?tab=whatsapp, ?tab=instagram).
 */
import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { ChannelsCard } from './channels-card';
import { InstagramCard } from './instagram-card';
import { SectionTabsBar } from './section-tabs-bar';
import { WhatsAppConfig } from './whatsapp-config';
import type { SettingsSection } from './settings-sections';

type ChannelTab = 'channels' | 'whatsapp' | 'instagram';

export function ChannelsSection({ active, hidden, onSelect }: {
  active: ChannelTab;
  hidden: ReadonlySet<SettingsSection>;
  onSelect: (section: ChannelTab) => void;
}) {
  const t = useTranslations('SettingsRedesign.channels');
  const { accountId } = useAuth();
  const tabs = ([
    { id: 'channels', label: t('overview') },
    { id: 'whatsapp', label: t('whatsapp') },
    { id: 'instagram', label: t('instagram') },
  ] as { id: ChannelTab; label: string }[]).filter((tab) => tab.id === 'channels' || !hidden.has(tab.id));
  return (
    <div>
      {tabs.length > 1 && <SectionTabsBar label={t('tabs')} tabs={tabs} active={active} onSelect={onSelect} idPrefix="channels-tab" />}
      <div role="tabpanel" aria-labelledby={`channels-tab-${active}`}>
        {active === 'whatsapp' ? <WhatsAppConfig /> : active === 'instagram' ? <InstagramCard key={accountId} /> : <ChannelsCard key={accountId} />}
      </div>
    </div>
  );
}
