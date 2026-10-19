'use client';

import { useTranslations } from 'next-intl';

export function PasswordRequirements({ id }: { id?: string }) {
  const t = useTranslations('PasswordInput');
  return <p id={id} className="text-xs text-muted-foreground">{t('requirements')}</p>;
}
