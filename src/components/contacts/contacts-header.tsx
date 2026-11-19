'use client';

// The Contacts page header shared by its three tabs (People, Segments, Custom
// fields): title and the tab's actions. The tabs themselves render in the shared
// section tab bar (src/components/layout/sections.ts), like every other section.
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';

export function ContactsHeader({ actions }: { actions?: ReactNode }) {
  const t = useTranslations('Contacts.redesign');
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-[22px] font-bold tracking-tight text-foreground">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>
      {actions && <div className="flex min-w-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
