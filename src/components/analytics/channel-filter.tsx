'use client';

import { useTranslations } from 'next-intl';

import { useWorkspaceChannels } from '@/hooks/use-workspace-channels';

export type ChannelFilterValue = '' | 'whatsapp' | 'instagram';

/**
 * Analytics channel filter (Stage 3). Shown only while both channels are
 * enabled for the workspace (or a filter is already chosen), so a WhatsApp-only
 * workspace sees exactly the page it has today. Presentation only: the overview
 * report validates and applies ?channel= itself.
 */
export function ChannelFilter({ value, onChange }: { value: ChannelFilterValue; onChange: (value: ChannelFilterValue) => void }) {
  const t = useTranslations('Analytics.channel');
  const { data } = useWorkspaceChannels();
  const both = data ? data.enabled.includes('whatsapp') && data.enabled.includes('instagram') : false;
  if (!both && !value) return null;
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">{t('label')}</span>
      <select
        className="h-8 rounded-md border border-border bg-background px-2 text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value as ChannelFilterValue)}
      >
        <option value="">{t('all')}</option>
        <option value="whatsapp">{t('whatsapp')}</option>
        <option value="instagram">{t('instagram')}</option>
      </select>
    </label>
  );
}
