'use client';

// Console: the append-only platform audit trail, newest first, optionally for
// one workspace (?accountId=). Every platform action also wrote a row to that
// workspace's own audit log.

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { PlatformAuditRow } from '@/types/platform';
import { platformApi } from '../../_components/platform-api';

export default function PlatformAuditPage() {
  return (
    <Suspense>
      <AuditTrail />
    </Suspense>
  );
}

function AuditTrail() {
  const t = useTranslations('Platform.audit');
  const format = useFormatter();
  const accountId = useSearchParams().get('accountId');
  const [rows, setRows] = useState<PlatformAuditRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (after: string | null) => {
    setBusy(true);
    try {
      const params = new URLSearchParams();
      if (accountId) params.set('accountId', accountId);
      if (after) params.set('cursor', after);
      const page = await platformApi<{ entries: PlatformAuditRow[]; nextCursor: string | null }>(`/api/platform/audit?${params}`);
      setRows((prev) => (after && prev ? [...prev, ...page.entries] : page.entries));
      setCursor(page.nextCursor);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }, [accountId]);
  useEffect(() => {
    void load(null);
  }, [load]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        {accountId && (
          <Link href="/platform/audit" className="text-muted-foreground text-sm hover:underline">{t('showAll')}</Link>
        )}
      </div>
      {failed && <p role="status" className="text-sm">{t('loadFailed')}</p>}
      {rows !== null && rows.length === 0 && <p className="text-muted-foreground text-sm">{t('empty')}</p>}
      {rows !== null && rows.length > 0 && (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('columns.when')}</TableHead>
                <TableHead>{t('columns.admin')}</TableHead>
                <TableHead>{t('columns.action')}</TableHead>
                <TableHead>{t('columns.workspace')}</TableHead>
                <TableHead>{t('columns.reason')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="whitespace-nowrap">{format.dateTime(new Date(row.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}</TableCell>
                  <TableCell>{row.adminEmail}</TableCell>
                  <TableCell className="font-mono text-xs">{row.action}</TableCell>
                  <TableCell>
                    {row.targetAccountId ? (
                      <Link href={`/platform/tenants/${row.targetAccountId}`} className="font-mono text-xs hover:underline">{row.targetAccountId.slice(0, 8)}</Link>
                    ) : '-'}
                  </TableCell>
                  <TableCell className="max-w-md break-words">{row.reason ?? '-'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {cursor && (
        <Button type="button" variant="outline" className="self-start" disabled={busy} onClick={() => void load(cursor)}>
          {t('loadMore')}
        </Button>
      )}
    </div>
  );
}
