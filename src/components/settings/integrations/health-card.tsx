'use client';

// Settings: the integration Health card. One row per connected integration
// from GET /api/integrations/health (stored status columns only, no provider
// call on load): state, last success, last error code and where to fix it.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { RefreshCw } from 'lucide-react';
import { authFetch } from '@/lib/auth/client';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { HealthState, IntegrationHealthRow } from '@/lib/platform/health';

const STATE_VARIANT: Record<HealthState, 'secondary' | 'destructive' | 'outline'> = {
  ok: 'secondary',
  attention: 'destructive',
  disconnected: 'outline',
};

export function IntegrationHealthCard(): React.ReactElement {
  const t = useTranslations('Settings.integrationHealth');
  const format = useFormatter();
  const [rows, setRows] = useState<IntegrationHealthRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const response = await authFetch('/api/integrations/health');
      if (!response.ok) throw new Error('load failed');
      setRows((await response.json()).integrations as IntegrationHealthRow[]);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const when = (value: string | null) => (value ? format.relativeTime(new Date(value)) : t('never'));
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="text-foreground">{t('title')}</CardTitle>
          <CardDescription className="text-muted-foreground">{t('description')}</CardDescription>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={() => void load()} disabled={loading} aria-label={t('refresh')}>
          <RefreshCw className={loading ? 'size-4 animate-spin' : 'size-4'} aria-hidden />
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {rows === null && !failed && <p className="text-muted-foreground text-sm">{t('loading')}</p>}
        {failed && (
          <p role="status" className="text-sm">
            {t('loadFailed')}
          </p>
        )}
        {rows !== null && rows.length === 0 && <p className="text-muted-foreground text-sm">{t('empty')}</p>}
        {rows !== null && rows.length > 0 && (
          <ul className="divide-border divide-y">
            {rows.map((row) => (
              <li key={`${row.kind}:${row.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {t(`kinds.${row.kind}`)}
                    {row.label && <span className="text-muted-foreground ml-2 font-normal">{row.label}</span>}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {t('lastSuccess', { when: when(row.lastSuccessAt) })}
                    {row.lastErrorCode && <> · {t('lastError', { code: row.lastErrorCode })}</>}
                    {row.tokenExpiresAt && <> · {t('tokenExpires', { when: when(row.tokenExpiresAt) })}</>}
                  </p>
                </div>
                <Badge variant={STATE_VARIANT[row.state]}>{t(`states.${row.state}`)}</Badge>
                {row.state !== 'ok' && (
                  <Link href={row.href} className={buttonVariants({ variant: 'link', size: 'sm', className: 'px-0' })}>
                    {t('fix')}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
