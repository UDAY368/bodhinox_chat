/* eslint-disable @typescript-eslint/no-unused-vars -- Stage 5 contract stub: final signature, no-op body; the owning batch removes this line. */
'use client';

import { useTranslations } from 'next-intl';
import { SettingsPanelHead } from './settings-panel-head';

// Stage 5 contract (5A mounts it as Settings › Conversion events; 5F
// implements the list and the /api/account/conversion-events routes). Until
// then it shows the section heading only.
export function ConversionEventsSettings(_props: { canEdit: boolean }) {
  const t = useTranslations('Settings.conversionEvents');
  return (
    <section className="max-w-2xl">
      <SettingsPanelHead title={t('title')} description={t('description')} />
    </section>
  );
}
