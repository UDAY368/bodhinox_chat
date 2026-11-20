'use client';

// The Contacts page header shared by its three tabs (People, Segments, Custom
// fields): the shared PageHeader with the tab's one primary action and a "more"
// menu for the rest. The tabs themselves render in the shared section tab bar
// (src/components/layout/sections.ts), like every other section.
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { PageHeader, type PageHeaderAction } from '@/components/ui/page-header';

export function ContactsHeader({ primaryAction, moreActions }: { primaryAction?: ReactNode; moreActions?: PageHeaderAction[] }) {
  const t = useTranslations('Contacts.redesign');
  return <PageHeader title={t('title')} subtitle={t('subtitle')} primaryAction={primaryAction} moreActions={moreActions} className="mb-0" />;
}
