'use client';

import { useTranslations } from 'next-intl';
import { useAuth } from '@/hooks/use-auth';
import { hasMinRole } from '@/lib/auth/roles';
import { ReportsTab } from '@/components/analytics/reports';

/**
 * Analytics › Reports: the same report requests and downloads that sit at the
 * bottom of the Analytics page, on their own tab. Admins and owners only, as there.
 */
export default function ReportsPage() {
  const t = useTranslations('Analytics.reports');
  const { accountRole } = useAuth();
  if (!accountRole) return null;
  if (!hasMinRole(accountRole, 'admin'))
    return <p className="text-muted-foreground py-10 text-center text-sm">{t('adminsOnly')}</p>;
  return (
    <div className="space-y-5">
      <ReportsTab canManage />
    </div>
  );
}
