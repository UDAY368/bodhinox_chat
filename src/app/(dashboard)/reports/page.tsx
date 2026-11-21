'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/hooks/use-auth';
import { hasMinRole } from '@/lib/auth/roles';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
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
  const [buildRequest, setBuildRequest] = useState<object | null>(null);
  if (!accountRole) return null;
  if (!hasMinRole(accountRole, 'admin'))
    return <p className="text-muted-foreground py-10 text-center text-sm">{t('adminsOnly')}</p>;
  return (
    <div className="mx-auto w-full max-w-[1440px] min-w-0 space-y-6">
      <PageHeader
        title={ti('pageTitle')}
        subtitle={ti('pageDescription')}
        className="mb-0"
        primaryAction={<Button className="min-h-11 sm:min-h-8" onClick={() => setBuildRequest({})}><Plus aria-hidden />{ti('build')}</Button>}
      />
      <SavedReports buildRequest={buildRequest} />
      <ReportsTab canManage />
    </div>
  );
}
