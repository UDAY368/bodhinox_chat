'use client';

// Console: integration health per workspace (stored status columns, counts
// only) and background work that needs a look (failed or overdue jobs,
// unprocessed webhook receipts), plus recent failed jobs, each requeueable
// with a reason (audited; a job with an uncertain send outcome is refused).

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { PlatformHealth } from '@/lib/platform/health';
import type { PlatformFailedJobRow } from '@/types/platform';
import { errorCode, platformApi } from '../../_components/platform-api';

const REQUEUE_ERRORS = ['reason_required', 'not_found', 'not_failed', 'needs_reconciliation'] as const;

export default function PlatformHealthPage() {
  const t = useTranslations('Platform.health');
  const format = useFormatter();
  const [data, setData] = useState<PlatformHealth | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => platformApi<PlatformHealth>('/api/platform/health').then(setData, () => setFailed(true)), []);
  useEffect(() => { void load(); }, [load]);

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
      <section className="flex flex-col gap-2">
        <h2 className="font-medium">{t('failed.title')}</h2>
        {data.failedJobs.length === 0 ? <p className="text-muted-foreground text-sm">{t('allClear')}</p> : (
          <>
            <p className="text-muted-foreground text-xs">{t('failed.hint')}</p>
            <ul className="divide-y">
              {data.failedJobs.map((job) => <FailedJobRow key={job.id} job={job} onDone={load} />)}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}

function FailedJobRow({ job, onDone }: { job: PlatformFailedJobRow; onDone: () => Promise<unknown> }) {
  const t = useTranslations('Platform.health');
  const format = useFormatter();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function requeue() {
    setBusy(true);
    setMessage(null);
    try {
      await platformApi(`/api/platform/health/jobs/${job.id}/requeue`, { body: { reason: reason.trim() } });
      setMessage(t('failed.requeued'));
      await onDone();
    } catch (error) {
      setMessage(t(`failed.errors.${errorCode(error, REQUEUE_ERRORS)}`));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-col gap-2 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-mono text-xs">{job.type}</span>
        {job.accountId && <Link href={`/platform/tenants/${job.accountId}`} className="hover:underline">{job.accountName ?? job.accountId}</Link>}
        <span className="text-muted-foreground text-xs">{t('failed.attempts')}: {job.attempts}/{job.maxAttempts}</span>
        <span className="text-muted-foreground ml-auto text-xs">{t('failed.failedAt')} {format.relativeTime(new Date(job.failedAt))}</span>
      </div>
      {job.needsReconciliation ? <Badge variant="destructive" className="w-fit">{t('failed.reconcile')}</Badge> : (
        <div className="flex flex-wrap items-center gap-2">
          <Input aria-label={t('failed.reason')} placeholder={t('failed.reason')} maxLength={1000} value={reason}
            className="max-w-md" onChange={(e) => setReason(e.target.value)} />
          <Button type="button" size="sm" disabled={busy || reason.trim().length < 3} onClick={() => void requeue()}>
            {t('failed.requeue')}
          </Button>
        </div>
      )}
      {message && <p role="status" className="text-xs">{message}</p>}
    </li>
  );
}
