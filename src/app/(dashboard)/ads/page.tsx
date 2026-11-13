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
  const tc = useTranslations('Campaigns');
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
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1 basis-64">
          <h1 className="text-[22px] font-bold leading-tight tracking-tight text-foreground">{tc('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{tc('blurbs.ads')}</p>
        </div>
        {active && connection.adAccountId && (
          <a
            href={`https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${encodeURIComponent(connection.adAccountId)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-9 items-center gap-1.5 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors duration-150 hover:bg-primary/90"
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
        <div className="flex flex-col items-center gap-2 rounded-xl border border-border bg-card px-4 py-12 text-center text-sm">
          <p className="text-muted-foreground">
            {connection?.status === 'token_invalid' ? t('tokenInvalid') : t('notConnected')}
          </p>
          {isAdmin && (
            <Link href="/settings?tab=ads" className="mt-2 inline-flex h-8 items-center rounded-full border border-border px-3.5 font-medium text-foreground transition-colors duration-150 hover:bg-muted">{t('openSettings')}</Link>
          )}
        </div>
      )}
      {status?.enabled && (active || connection?.status === 'token_invalid') && (
        <Tabs defaultValue="ads">
          <TabsList className="max-w-full overflow-x-auto">
            <TabsTrigger value="ads">{t('tabs.ads')}</TabsTrigger>
            <TabsTrigger value="campaigns">{t('tabs.campaigns')}</TabsTrigger>
            <TabsTrigger value="leads">{t('tabs.leads')}</TabsTrigger>
            <TabsTrigger value="conversions">{t('tabs.conversions')}</TabsTrigger>
          </TabsList>
          <TabsContent value="ads" className="pt-4">
            <AdsTable canManage={isAdmin && active} canSegment={isAgent} adAccountId={connection?.adAccountId ?? null} />
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
