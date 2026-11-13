'use client';

import { useTranslations } from 'next-intl';
import { useAuth } from '@/hooks/use-auth';
import { hasMinRole } from '@/lib/auth/roles';
import { ReportsTab } from '@/components/analytics/reports';
import { SavedReports } from '@/components/analytics/reports/saved-reports';

/**
 * Analytics › Reports: the saved report library (build, preview, export,
 * schedule), then the one-off report files built in the background with their
 * downloads, shares and fixed-kind schedules. Admins and owners only.
 */
export default function ReportsPage() {
  const t = useTranslations('Analytics.reports');
  const ti = useTranslations('Analytics.insights.saved');
  const { accountRole } = useAuth();
  if (!accountRole) return null;
  if (!hasMinRole(accountRole, 'admin'))
    return <p className="text-muted-foreground py-10 text-center text-sm">{t('adminsOnly')}</p>;
  return (
    <div className="mx-auto w-full max-w-[1440px] min-w-0 space-y-6">
      <header className="min-w-0">
        <h1 className="text-[22px] leading-tight font-bold tracking-tight text-foreground">{ti('pageTitle')}</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{ti('pageDescription')}</p>
      </header>
      <SavedReports />
      <ReportsTab canManage />
    </div>
  );
}
