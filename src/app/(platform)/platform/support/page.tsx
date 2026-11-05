'use client';

// Console: the caller's own support requests and grants. While a grant is
// approved and unexpired, "View diagnostics" loads statuses, counts and error
// codes for that one workspace (logged as support.viewed in both trails).
// Requests are made from a workspace's page.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { PlatformSupportGrant, SupportDiagnostics } from '@/types/platform';
import { errorCode, platformApi } from '../../_components/platform-api';

export default function PlatformSupportPage() {
  const t = useTranslations('Platform.support');
  const format = useFormatter();
  const [grants, setGrants] = useState<PlatformSupportGrant[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<{ grantId: string; data: SupportDiagnostics } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(
    () => platformApi<{ grants: PlatformSupportGrant[] }>('/api/platform/support').then((r) => setGrants(r.grants), () => setFailed(true)),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);

  async function view(grantId: string) {
    setMessage(null);
    try {
      const { diagnostics } = await platformApi<{ diagnostics: SupportDiagnostics }>(`/api/platform/support/${grantId}/diagnostics`);
      setOpen({ grantId, data: diagnostics });
    } catch (error) {
      setOpen(null);
      setMessage(t(`errors.${errorCode(error, ['grant_not_active'])}`));
      await load();
    }
  }

  const when = (value: string | null) => (value ? format.dateTime(new Date(value), { dateStyle: 'medium', timeStyle: 'short' }) : '-');
  // The server already reports an approved grant past its window as 'expired'.
  const active = (g: PlatformSupportGrant) => g.status === 'approved';
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      <p className="text-muted-foreground text-sm">{t('intro')}</p>
      {failed && <p role="status" className="text-sm">{t('loadFailed')}</p>}
      {grants !== null && grants.length === 0 && <p className="text-muted-foreground text-sm">{t('empty')}</p>}
      {grants !== null && grants.length > 0 && (
        <ul className="divide-border divide-y">
          {grants.map((g) => (
            <li key={g.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
              <Link href={`/platform/tenants/${g.accountId}`} className="font-medium hover:underline">{g.accountName}</Link>
              <Badge variant={active(g) ? 'default' : 'outline'}>{t(`status.${g.status}`)}</Badge>
              <span className="text-muted-foreground">{t('requestedAt', { when: when(g.requestedAt) })}</span>
              {g.expiresAt && <span className="text-muted-foreground">{t('expiresAt', { when: when(g.expiresAt) })}</span>}
              {active(g) && (
                <Button type="button" size="sm" variant="outline" className="ml-auto" onClick={() => void view(g.id)}>
                  {t('viewDiagnostics')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {message && <p role="status" className="text-sm">{message}</p>}
      {open && <Diagnostics data={open.data} />}
    </div>
  );
}

function Diagnostics({ data }: { data: SupportDiagnostics }) {
  const t = useTranslations('Platform.support.diagnostics');
  const pairs = (record: Record<string, number> | null | undefined) =>
    Object.entries(record ?? {}).map(([k, v]) => `${k} ${v}`).join(' · ') || '-';
  return (
    <Card>
      <CardHeader><CardTitle>{t('title')}</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        <section>
          <h2 className="font-medium">{t('subscription')}</h2>
          <p className="text-muted-foreground">
            {data.subscription ? `${data.subscription.plan_id} · ${data.subscription.status}` : t('none')}
            {data.lifecycle && ` · ${data.lifecycle.status}${data.lifecycle.block_manual ? ` · ${t('manualBlocked')}` : ''}`}
          </p>
          <p className="text-muted-foreground">{t('usage')}: {pairs(data.usage)}</p>
        </section>
        <section>
          <h2 className="font-medium">{t('numbers')}</h2>
          {data.whatsapp_numbers.length === 0 ? <p className="text-muted-foreground">{t('none')}</p> : (
            <ul className="text-muted-foreground">
              {data.whatsapp_numbers.map((n) => (
                <li key={n.id}>
                  {n.status} · {n.quality_rating ?? '-'} · {n.messaging_limit_tier ?? '-'} · {n.has_token ? t('token') : t('noToken')}
                  {n.health_error_at && ` · ${t('healthError')}`}
                </li>
              ))}
            </ul>
          )}
        </section>
        <section>
          <h2 className="font-medium">{t('integrations')}</h2>
          <ul className="text-muted-foreground">
            {data.integrations.instagram.map((x, i) => <li key={`ig${i}`}>Instagram · {x.status}{x.last_error_code && ` · ${x.last_error_code}`}</li>)}
            {data.integrations.meta_ads.map((x, i) => <li key={`ma${i}`}>Meta Ads · {x.status}{x.last_error_code && ` · ${x.last_error_code}`}</li>)}
            {data.integrations.meetings.map((x, i) => <li key={`mt${i}`}>{x.provider} · {x.status}{x.last_error_code && ` · ${x.last_error_code}`}</li>)}
            {data.integrations.courier.map((x, i) => <li key={`co${i}`}>{x.provider} · {x.status}{x.last_error_code && ` · ${x.last_error_code}`}</li>)}
            <li>Shopify · {data.integrations.shopify} · WooCommerce · {data.integrations.woocommerce} · Razorpay · {data.integrations.razorpay_commerce.length}</li>
          </ul>
        </section>
        <section>
          <h2 className="font-medium">{t('jobs')}</h2>
          {data.failed_jobs.length === 0 ? <p className="text-muted-foreground">{t('none')}</p> : (
            <ul className="text-muted-foreground">
              {data.failed_jobs.map((j) => <li key={j.type}>{j.type} · {j.count}</li>)}
            </ul>
          )}
          <p className="text-muted-foreground">{t('outbound')}: {pairs(data.outbound_intents)}</p>
          <p className="text-muted-foreground">{t('billingIntents')}: {pairs(data.billing_intents)}</p>
          <p className="text-muted-foreground">
            {t('exceptions', { payments: data.open_payment_exceptions, reconciliation: data.open_reconciliation_items })}
          </p>
        </section>
      </CardContent>
    </Card>
  );
}
