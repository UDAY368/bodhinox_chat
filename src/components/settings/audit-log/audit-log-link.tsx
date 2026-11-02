'use client';

import Link from 'next/link';
import { ScrollText } from 'lucide-react';
import { useTranslations } from 'next-intl';

/** Settings → Team members: entry point to the audit log page (admins and owners). */
export function AuditLogLink() {
  const t = useTranslations('Settings.auditLog');
  return (
    <Link href="/settings/audit-log"
      className="border-border hover:bg-muted flex items-center gap-3 rounded-md border p-3 text-sm transition-colors">
      <ScrollText className="text-muted-foreground size-4" />
      <span className="min-w-0 flex-1">
        <span className="text-foreground block font-medium">{t('title')}</span>
        <span className="text-muted-foreground block text-xs">{t('linkDescription')}</span>
      </span>
    </Link>
  );
}
