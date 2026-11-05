'use client';

// Console: workspaces, newest first, searchable by name, owner email or id.
// Plan, subscription and lifecycle status, members and stored usage only.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { TenantListRow, TenantPage } from '@/lib/platform/tenants';
import { platformApi } from '../../_components/platform-api';

export default function PlatformTenantsPage() {
  const t = useTranslations('Platform.tenants');
  const format = useFormatter();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<TenantListRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (q: string, after: string | null) => {
    setBusy(true);
    setFailed(false);
    try {
      const params = new URLSearchParams();
      if (q) params.set('search', q);
      if (after) params.set('cursor', after);
      const page = await platformApi<TenantPage>(`/api/platform/tenants?${params}`);
      setRows((prev) => (after && prev ? [...prev, ...page.tenants] : page.tenants));
      setCursor(page.nextCursor);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    void load(query, null);
  }, [load, query]);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      <form
        className="flex max-w-lg gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(search.trim());
        }}
      >
        <Input value={search} maxLength={200} placeholder={t('searchPlaceholder')} onChange={(e) => setSearch(e.target.value)} aria-label={t('searchPlaceholder')} />
        <Button type="submit" variant="outline" disabled={busy}>
          {t('search')}
        </Button>
      </form>
      {failed && <p role="status" className="text-sm">{t('loadFailed')}</p>}
      {rows !== null && rows.length === 0 && <p className="text-muted-foreground text-sm">{t('empty')}</p>}
      {rows !== null && rows.length > 0 && (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('columns.workspace')}</TableHead>
                <TableHead>{t('columns.owner')}</TableHead>
                <TableHead>{t('columns.plan')}</TableHead>
                <TableHead>{t('columns.subscription')}</TableHead>
                <TableHead>{t('columns.lifecycle')}</TableHead>
                <TableHead className="text-right">{t('columns.members')}</TableHead>
                <TableHead>{t('columns.created')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.accountId}>
                  <TableCell>
                    <Link href={`/platform/tenants/${row.accountId}`} className="font-medium hover:underline">
                      {row.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{row.ownerEmail ?? '-'}</TableCell>
                  <TableCell>
                    {row.planId}
                    {row.planVersion !== null && <span className="text-muted-foreground"> v{row.planVersion}</span>}
                  </TableCell>
                  <TableCell>{row.subscriptionStatus ?? t('noSubscription')}</TableCell>
                  <TableCell className="flex flex-wrap gap-1">
                    <Badge variant={row.lifecycleStatus === 'active' ? 'secondary' : 'destructive'}>{t(`lifecycle.${row.lifecycleStatus}`)}</Badge>
                    {row.blockManual && <Badge variant="destructive">{t('manualBlocked')}</Badge>}
                    {row.purgeDue && <Badge variant="outline">{t('purgeDue')}</Badge>}
                  </TableCell>
                  <TableCell className="text-right">{row.memberCount}</TableCell>
                  <TableCell className="text-muted-foreground">{format.dateTime(new Date(row.createdAt), { dateStyle: 'medium' })}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {cursor && (
        <Button type="button" variant="outline" className="self-start" disabled={busy} onClick={() => void load(query, cursor)}>
          {t('loadMore')}
        </Button>
      )}
    </div>
  );
}
