'use client';

import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { AuditLogTable } from '@/components/settings/audit-log/audit-log-table';

// Settings → Audit log (admins and owners). Linked from Settings → Team members.
export default function AuditLogPage() {
  const { canManageMembers } = useAuth();
  const t = useTranslations('Settings.auditLog');
  return (
    <div className="space-y-6">
      <div>
        <Link href="/settings?tab=members" className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm">
          <ArrowLeft className="size-3.5" /> {t('back')}
        </Link>
        <h1 className="text-foreground mt-2 text-2xl font-bold tracking-tight">{t('title')}</h1>
      </div>
      <AuditLogTable canView={canManageMembers} />
    </div>
  );
}
