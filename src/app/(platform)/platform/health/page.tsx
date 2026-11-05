'use client';

// Console: integration health per workspace (stored status columns, counts
// only) and background work that needs a look (failed or overdue jobs,
// unprocessed webhook receipts).

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { PlatformHealth } from '@/lib/platform/health';
import { platformApi } from '../../_components/platform-api';

export default function PlatformHealthPage() {
  const t = useTranslations('Platform.health');
  const format = useFormatter();
  const [data, setData] = useState<PlatformHealth | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    platformApi<PlatformHealth>('/api/platform/health').then(setData, () => setFailed(true));
  }, []);

  if (failed) return <p role="status" className="text-sm">{t('loadFailed')}</p>;
  if (!data) return <p className="text-muted-foreground text-sm">{t('loading')}</p>;
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      {!data.sharedKeyCheck && <p className="text-muted-foreground text-xs">{t('sharedKeyOff')}</p>}
      <section className="flex flex-col gap-2">
        <h2 className="font-medium">{t('integrations')}</h2>
        {data.integrations.length === 0 ? <p className="text-muted-foreground text-sm">{t('allClear')}</p> : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('columns.workspace')}</TableHead>
                  <TableHead className="text-right">{t('columns.disconnectedNumbers')}</TableHead>
                  <TableHead className="text-right">{t('columns.numberErrors')}</TableHead>
                  <TableHead className="text-right">{t('columns.instagram')}</TableHead>
                  <TableHead className="text-right">{t('columns.metaAds')}</TableHead>
                  <TableHead className="text-right">{t('columns.meetings')}</TableHead>
                  <TableHead className="text-right">{t('columns.courier')}</TableHead>
                  <TableHead className="text-right">{t('columns.tokensExpiring')}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.integrations.map((row) => (
                  <TableRow key={row.accountId}>
                    <TableCell><Link href={`/platform/tenants/${row.accountId}`} className="hover:underline">{row.accountName}</Link></TableCell>
                    <TableCell className="text-right">{row.disconnectedNumbers}</TableCell>
                    <TableCell className="text-right">{row.numberHealthErrors}</TableCell>
                    <TableCell className="text-right">{row.instagramAttention}</TableCell>
                    <TableCell className="text-right">{row.metaAdsAttention}</TableCell>
                    <TableCell className="text-right">{row.meetingsAttention}</TableCell>
                    <TableCell className="text-right">{row.courierAttention}</TableCell>
                    <TableCell className="text-right">{row.tokensExpiring}</TableCell>
                    <TableCell>{row.sharedRazorpayKey && <Badge variant="destructive">{t('sharedKey')}</Badge>}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="font-medium">{t('backlog')}</h2>
        {data.backlog.length === 0 ? <p className="text-muted-foreground text-sm">{t('allClear')}</p> : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('columns.source')}</TableHead>
                  <TableHead>{t('columns.type')}</TableHead>
                  <TableHead>{t('columns.status')}</TableHead>
                  <TableHead className="text-right">{t('columns.workspaces')}</TableHead>
                  <TableHead className="text-right">{t('columns.items')}</TableHead>
                  <TableHead>{t('columns.oldest')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.backlog.map((row) => (
                  <TableRow key={`${row.source}:${row.type}:${row.status}`}>
                    <TableCell>{t(`sources.${row.source}`)}</TableCell>
                    <TableCell className="font-mono text-xs">{row.type}</TableCell>
                    <TableCell>{row.status}</TableCell>
                    <TableCell className="text-right">{row.workspaces ?? '-'}</TableCell>
                    <TableCell className="text-right">{row.items}</TableCell>
                    <TableCell>{row.oldest ? format.relativeTime(new Date(row.oldest)) : '-'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  );
}
