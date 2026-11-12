'use client';

// The Ads page. It asks GET /api/meta-ads/status first: while Meta ads are off
// or not configured it shows the not-enabled state (with the count of
// conversations started from ads, which needs no Meta approval). Otherwise it
// shows the Ads, Campaigns (manage campaigns, ad sets and ads), Leads and
// Conversions tabs; without a connection it points
// admins to Settings > Ads. No Facebook code loads on this page.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ExternalLink, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AdsNotEnabled } from '@/components/ads/ads-not-enabled';
import { AdsTable } from '@/components/ads/ads-table';
import { CampaignsPanel } from '@/components/ads/campaigns-panel';
import { LeadsTable } from '@/components/ads/leads-table';
import { ConversionsPanel } from '@/components/ads/conversions-panel';
import { useAuth } from '@/hooks/use-auth';
import { authFetch } from '@/lib/auth/client';
import { hasMinRole } from '@/lib/auth/roles';
import type { MetaAdConnectionDto } from '@/lib/meta-ads/connection';

type Status =
  | { enabled: false; reason: 'flag_off' | 'not_configured' }
  | { enabled: true; connection: MetaAdConnectionDto | null };

export default function AdsPage() {
  const t = useTranslations('Ads');
  const { accountRole } = useAuth();
  const [status, setStatus] = useState<Status | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const res = await authFetch('/api/meta-ads/status', { cache: 'no-store' });
      if (!res.ok) throw new Error();
      setStatus((await res.json()) as Status);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const isAdmin = !!accountRole && hasMinRole(accountRole, 'admin');
  const isAgent = !!accountRole && hasMinRole(accountRole, 'agent');
  const connection = status?.enabled ? status.connection : null;
  const active = connection?.status === 'active';

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('description')}</p>
        </div>
        {active && connection.adAccountId && (
          <a
            href={`https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${encodeURIComponent(connection.adAccountId)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
          >
            {t('createInAdsManager')} <ExternalLink className="size-3.5" />
          </a>
        )}
      </div>

      {!status && !failed && <Loader2 className="size-5 animate-spin text-primary" />}
      {failed && (
        <div className="flex items-center gap-2 text-sm text-destructive">
          {t('loadFailed')}
          <Button type="button" variant="outline" size="sm" onClick={() => void load()}>{t('retry')}</Button>
        </div>
      )}
      {status && !status.enabled && <AdsNotEnabled reason={status.reason} />}
      {status?.enabled && !active && (
        <div className="rounded-lg border border-border bg-card p-6 text-sm">
          <p className="text-muted-foreground">
            {connection?.status === 'token_invalid' ? t('tokenInvalid') : t('notConnected')}
          </p>
          {isAdmin && (
            <Link href="/settings?tab=ads" className="mt-2 inline-block text-primary hover:underline">{t('openSettings')}</Link>
          )}
        </div>
      )}
      {status?.enabled && (active || connection?.status === 'token_invalid') && (
        <Tabs defaultValue="ads">
          <TabsList>
            <TabsTrigger value="ads">{t('tabs.ads')}</TabsTrigger>
            <TabsTrigger value="campaigns">{t('tabs.campaigns')}</TabsTrigger>
            <TabsTrigger value="leads">{t('tabs.leads')}</TabsTrigger>
            <TabsTrigger value="conversions">{t('tabs.conversions')}</TabsTrigger>
          </TabsList>
          <TabsContent value="ads" className="pt-4">
            <AdsTable canManage={isAdmin && active} canSegment={isAgent} />
          </TabsContent>
          <TabsContent value="campaigns" className="pt-4">
            <CampaignsPanel canManage={isAdmin && active} />
          </TabsContent>
          <TabsContent value="leads" className="pt-4">
            <LeadsTable canManage={isAdmin} />
          </TabsContent>
          <TabsContent value="conversions" className="pt-4">
            <ConversionsPanel canResolve={isAdmin} />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
