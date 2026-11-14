'use client';

// The Ads page. It asks GET /api/meta-ads/status first: while Meta ads are off
// or not configured it shows the not-enabled state (with the count of
// conversations started from ads, which needs no Meta approval). Otherwise it
// shows the shared controls (ad account, date range) and the Overview, Ads,
// Campaigns (manage campaigns, ad sets and ads, and the ads created here),
// Leads and Conversions tabs; without a connection it points admins to
// Settings > Ads. Admins create ads from "Create ad" once ad management is on
// and the grant has the permissions. No Facebook code loads on this page.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ExternalLink, Loader2, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AdsNotEnabled } from '@/components/ads/ads-not-enabled';
import { AdsOverview } from '@/components/ads/ads-overview';
import { AdsTable } from '@/components/ads/ads-table';
import { AdsToolbar } from '@/components/ads/ads-toolbar';
import { AdDrafts } from '@/components/ads/ad-drafts';
import { CampaignsPanel } from '@/components/ads/campaigns-panel';
import { CreateAdDialog } from '@/components/ads/create-ad-dialog';
import { LeadsTable } from '@/components/ads/leads-table';
import { ConversionsPanel } from '@/components/ads/conversions-panel';
import { presetRange, type AdsRange } from '@/components/ads/ads-shared';
import { useAuth } from '@/hooks/use-auth';
import { authFetch } from '@/lib/auth/client';
import { hasMinRole } from '@/lib/auth/roles';
import type { LinkedAdAccount } from '@/lib/meta-ads/accounts';
import type { MetaAdConnectionDto } from '@/lib/meta-ads/connection';

type Status =
  | { enabled: false; reason: 'flag_off' | 'not_configured' }
  | { enabled: true; connection: MetaAdConnectionDto | null };

interface CreateState { manageEnabled: boolean; createMissingScopes: string[]; pageName: string | null }

export default function AdsPage() {
  const t = useTranslations('Ads');
  const tc = useTranslations('Campaigns');
  const { accountRole } = useAuth();
  const [status, setStatus] = useState<Status | null>(null);
  const [failed, setFailed] = useState(false);
  const [accounts, setAccounts] = useState<LinkedAdAccount[]>([]);
  const [adAccountId, setAdAccountId] = useState<string | null>(null);
  const [range, setRange] = useState<AdsRange>(() => presetRange('last_30d'));
  const [create, setCreate] = useState<CreateState | null>(null);
  const [creating, setCreating] = useState(false);
  const [draftsKey, setDraftsKey] = useState(0);

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
  const reporting = status?.enabled && (active || connection?.status === 'token_invalid');

  // The linked ad accounts (for the switcher) and whether ads can be created here.
  useEffect(() => {
    if (!reporting) return;
    let live = true;
    authFetch('/api/meta-ads/accounts', { cache: 'no-store' })
      .then(async (res) => (res.ok ? ((await res.json()) as { accounts: LinkedAdAccount[] }).accounts : []))
      .then((list) => { if (live) setAccounts(list); })
      .catch(() => {});
    authFetch('/api/meta-ads/manage', { cache: 'no-store' })
      .then(async (res) => (res.ok ? ((await res.json()) as CreateState) : null))
      .then((view) => { if (live && view) setCreate({ manageEnabled: view.manageEnabled, createMissingScopes: view.createMissingScopes ?? [], pageName: view.pageName ?? null }); })
      .catch(() => {});
    return () => { live = false; };
  }, [reporting]);

  const canCreate = isAdmin && active && !!create?.manageEnabled && create.createMissingScopes.length === 0 && accounts.length > 0;
  const primary = accounts.find((a) => a.isPrimary)?.adAccountId ?? connection?.adAccountId ?? null;
  const managerAccount = adAccountId ?? primary;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1 basis-64">
          <h1 className="text-[22px] font-bold leading-tight tracking-tight text-foreground">{tc('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{tc('blurbs.ads')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {active && managerAccount && (
            <a
              href={`https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${encodeURIComponent(managerAccount)}`}
              target="_blank"
              rel="noopener noreferrer"
              className={canCreate
                ? 'inline-flex h-9 items-center gap-1.5 rounded-full border border-border px-4 text-sm font-medium text-foreground transition-colors duration-150 hover:bg-muted'
                : 'inline-flex h-9 items-center gap-1.5 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors duration-150 hover:bg-primary/90'}
            >
              {canCreate ? t('openAdsManager') : t('createInAdsManager')} <ExternalLink className="size-3.5" />
            </a>
          )}
          {canCreate && (
            <Button type="button" className="rounded-full" onClick={() => setCreating(true)} data-testid="create-ad">
              <Plus className="size-4" /> {t('createAd')}
            </Button>
          )}
        </div>
      </div>
      {isAdmin && active && create?.manageEnabled && create.createMissingScopes.length > 0 && (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
          {t('createNeedsScopes', { scopes: create.createMissingScopes.join(', ') })}
        </p>
      )}

      {!status && !failed && <Loader2 className="size-5 animate-spin text-primary" />}
      {failed && (
        <div className="flex items-center gap-2 text-sm text-destructive">
          {t('loadFailed')}
          <Button type="button" variant="outline" size="sm" onClick={() => void load()}>{t('retry')}</Button>
        </div>
      )}
      {status && !status.enabled && <AdsNotEnabled reason={status.reason} />}
      {status?.enabled && !active && connection?.status !== 'token_invalid' && (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-border bg-card px-4 py-12 text-center text-sm">
          <p className="text-muted-foreground">{t('notConnected')}</p>
          {isAdmin && (
            <Link href="/settings?tab=ads" className="mt-2 inline-flex h-8 items-center rounded-full border border-border px-3.5 font-medium text-foreground transition-colors duration-150 hover:bg-muted">{t('openSettings')}</Link>
          )}
        </div>
      )}
      {reporting && (
        <>
          {connection?.status === 'token_invalid' && (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm">
              <span className="text-amber-800 dark:text-amber-200">{t('tokenInvalid')}</span>
              {isAdmin && <Link href="/settings?tab=ads" className="font-medium text-primary hover:underline">{t('openSettings')}</Link>}
            </div>
          )}
          <AdsToolbar accounts={accounts} adAccountId={adAccountId} onAccount={setAdAccountId} range={range} onRange={setRange} />
          <Tabs defaultValue="overview">
            <TabsList className="max-w-full overflow-x-auto">
              <TabsTrigger value="overview">{t('tabs.overview')}</TabsTrigger>
              <TabsTrigger value="ads">{t('tabs.ads')}</TabsTrigger>
              <TabsTrigger value="campaigns">{t('tabs.campaigns')}</TabsTrigger>
              <TabsTrigger value="leads">{t('tabs.leads')}</TabsTrigger>
              <TabsTrigger value="conversions">{t('tabs.conversions')}</TabsTrigger>
            </TabsList>
            <TabsContent value="overview" className="pt-4">
              <AdsOverview range={range} adAccountId={adAccountId} />
            </TabsContent>
            <TabsContent value="ads" className="pt-4">
              <AdsTable canManage={isAdmin && active} canSegment={isAgent} range={range} adAccountId={adAccountId} />
            </TabsContent>
            <TabsContent value="campaigns" className="space-y-4 pt-4">
              <AdDrafts canManage={isAdmin && active} refreshKey={draftsKey} />
              <CampaignsPanel canManage={isAdmin && active} adAccountId={adAccountId} />
            </TabsContent>
            <TabsContent value="leads" className="pt-4">
              <LeadsTable canManage={isAdmin} />
            </TabsContent>
            <TabsContent value="conversions" className="pt-4">
              <ConversionsPanel canResolve={isAdmin} />
            </TabsContent>
          </Tabs>
        </>
      )}
      {canCreate && (
        <CreateAdDialog
          open={creating}
          onOpenChange={setCreating}
          accounts={accounts}
          adAccountId={adAccountId}
          pageName={create?.pageName ?? null}
          onCreated={() => setDraftsKey((k) => k + 1)}
        />
      )}
    </div>
  );
}
