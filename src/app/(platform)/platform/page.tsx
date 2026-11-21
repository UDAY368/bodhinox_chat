// Platform console landing: links to each area. No data is rendered here; the
// layout has already checked the platform admin.

import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';

const AREAS = [
  ['tenants', '/platform/tenants'],
  ['plans', '/platform/plans'],
  ['billing', '/platform/billing'],
  ['health', '/platform/health'],
  ['support', '/platform/support'],
  ['audit', '/platform/audit'],
] as const;

export default async function PlatformHome() {
  const t = await getTranslations('Platform');
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('title')} subtitle={t('overview.intro')} className="mb-0" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {AREAS.map(([key, href]) => (
          <Link key={key} href={href} className="block">
            <Card className="hover:bg-muted/50 h-full transition-colors">
              <CardHeader>
                <CardTitle>{t(`nav.${key}`)}</CardTitle>
                <CardDescription>{t(`overview.${key}`)}</CardDescription>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
