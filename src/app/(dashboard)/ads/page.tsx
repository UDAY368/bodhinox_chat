'use client';

// The Ads page. It asks GET /api/meta-ads/status first: while Meta ads are off
// or not configured it shows the not-enabled state (with the count of
// conversations started from ads, which needs no Meta approval). Otherwise it
// shows the setup card (admins, until every step is done), the shared
// controls (ad account, date range) and five tabs: Overview, Campaigns
// (Performance numbers, or Manage: the ads created here and the campaign
// tree), Audiences, Leads (with the conversions sent to Meta) and Automation
// (rules). The last tab, date range and ad account are kept in this browser.
// Without a connection it points admins to Settings > Ads. Admins create ads from "Create ad" once ad management is on
// and the grant has the permissions. No Facebook code loads on this page.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ExternalLink, Megaphone, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { InlineError } from '@/components/ui/inline-error';
import { PageHeader } from '@/components/ui/page-header';
import { PageLoading } from '@/components/ui/page-loading';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { AdsSetupChecklist, setupSteps } from '@/components/ads/ads-setup-checklist';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AdsNotEnabled } from '@/components/ads/ads-not-enabled';
import { AdsOverview } from '@/components/ads/ads-overview';
import { AdsTable } from '@/components/ads/ads-table';
import { AdsToolbar } from '@/components/ads/ads-toolbar';
import { AdDrafts } from '@/components/ads/ad-drafts';
import { AudiencesPanel } from '@/components/ads/audiences-panel';
import { RulesPanel } from '@/components/ads/rules-panel';
import { CampaignsPanel } from '@/components/ads/campaigns-panel';
import { CreateAdDialog } from '@/components/ads/create-ad-dialog';
import { LeadsTable } from '@/components/ads/leads-table';
import { ConversionsPanel } from '@/components/ads/conversions-panel';
import { customRange, presetRange, type AdsRange } from '@/components/ads/ads-shared';
import { useAuth } from '@/hooks/use-auth';
import { authFetch } from '@/lib/auth/client';
import { hasMinRole } from '@/lib/auth/roles';
import type { LinkedAdAccount } from '@/lib/meta-ads/accounts';
import type { MetaAdConnectionDto } from '@/lib/meta-ads/connection';

type Status =
  | { enabled: false; reason: 'flag_off' | 'not_configured' }
  | { enabled: true; connection: MetaAdConnectionDto | null };

const TABS = ['overview', 'campaigns', 'audiences', 'leads', 'automation'] as const;
type Tab = (typeof TABS)[number];
type CampaignView = 'performance' | 'manage';
const PREFS_KEY = 'bodhinox.ads.prefs';

interface Prefs { tab?: Tab; view?: CampaignView; range?: AdsRange; account?: string | null }

/** The saved choices, checked field by field (storage can hold anything). */
function readPrefs(): Prefs {
  try {
    const raw = JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? '{}') as Record<string, unknown>;
    const prefs: Prefs = {};
    if (TABS.includes(raw.tab as Tab)) prefs.tab = raw.tab as Tab;
    if (raw.view === 'performance' || raw.view === 'manage') prefs.view = raw.view;
    const range = raw.range as Partial<AdsRange> | undefined;
    if (range && (range.preset === 'last_7d' || range.preset === 'last_30d' || range.preset === 'last_90d')) prefs.range = presetRange(range.preset);
    else if (range?.preset === 'custom' && typeof range.from === 'string' && typeof range.to === 'string') prefs.range = customRange(range.from, range.to);
    if (typeof raw.account === 'string' || raw.account === null) prefs.account = raw.account as string | null;
    return prefs;
  } catch {
    return {};
  }
}

function writePrefs(next: Prefs) {
  try { window.localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch { /* storage blocked: choices last for this view only */ }
}

interface CreateState { manageEnabled: boolean; createMissingScopes: string[]; pageName: string | null }

const adsManagerUrl = (account: string) =>
  `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${encodeURIComponent(account)}`;

export default function AdsPage() {
  const t = useTranslations('Ads');
  const tc = useTranslations('Campaigns');
  const { accountRole } = useAuth();
  const [status, setStatus] = useState<Status | null>(null);
  const [failed, setFailed] = useState(false);
  const [accounts, setAccounts] = useState<LinkedAdAccount[]>([]);
  const [prefs] = useState<Prefs>(() => (typeof window === 'undefined' ? {} : readPrefs()));
  const [adAccountId, setAdAccountId] = useState<string | null>(prefs.account ?? null);
  const [range, setRange] = useState<AdsRange>(() => prefs.range ?? presetRange('last_30d'));
  const [tab, setTab] = useState<Tab>(prefs.tab ?? 'overview');
  const [view, setView] = useState<CampaignView>(prefs.view ?? 'performance');
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

  // Keep the choices; drop a saved ad account that is no longer linked.
  useEffect(() => {
    writePrefs({ tab, view, range, account: adAccountId });
  }, [tab, view, range, adAccountId]);
  useEffect(() => {
    if (adAccountId && accounts.length > 0 && !accounts.some((a) => a.adAccountId === adAccountId)) setAdAccountId(null);
  }, [accounts, adAccountId]);

  const canCreate = isAdmin && active && !!create?.manageEnabled && create.createMissingScopes.length === 0 && accounts.length > 0;
  const primary = accounts.find((a) => a.isPrimary)?.adAccountId ?? connection?.adAccountId ?? null;
  const managerAccount = adAccountId ?? primary;

  return (
    <div className="space-y-6">
      <PageHeader
        title={tc('title')}
        subtitle={tc('blurbs.ads')}
        primaryAction={canCreate ? (
          <Button type="button" onClick={() => setCreating(true)} data-testid="create-ad">
            <Plus className="size-4" /> {t('createAd')}
          </Button>
        ) : active && managerAccount ? (
          <Button
            render={<a href={adsManagerUrl(managerAccount)} target="_blank" rel="noopener noreferrer" />}
            nativeButton={false}
          >
            {t('createInAdsManager')} <ExternalLink className="size-3.5" />
          </Button>
        ) : undefined}
        moreActions={active && managerAccount && canCreate ? [{
          label: t('openAdsManager'),
          icon: ExternalLink,
          onSelect: () => { window.open(adsManagerUrl(managerAccount), '_blank', 'noopener,noreferrer'); },
        }] : undefined}
      />
      {isAdmin && status?.enabled && (connection === null || active) && (connection === null || create !== null) && (
        <AdsSetupChecklist steps={setupSteps({
          connected: active, adAccounts: accounts.length, pageId: connection?.pageId ?? null,
          manageEnabled: !!create?.manageEnabled, missingScopes: create?.createMissingScopes ?? [],
        })} />
      )}

      {!status && !failed && <PageLoading />}
      {failed && <InlineError message={t('loadFailed')} onRetry={() => void load()} />}
      {status && !status.enabled && <AdsNotEnabled reason={status.reason} />}
      {status?.enabled && !active && connection?.status !== 'token_invalid' && (
        <EmptyState
          icon={Megaphone}
          title={t('notConnected')}
          className="rounded-group border border-separator bg-grouped-surface py-12"
          action={isAdmin ? <Button variant="outline" render={<Link href="/settings?tab=ads" />} nativeButton={false}>{t('openSettings')}</Button> : undefined}
        />
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
          <Tabs value={tab} onValueChange={(next) => setTab(next as Tab)}>
            <TabsList className="max-w-full overflow-x-auto">
              {TABS.map((key) => <TabsTrigger key={key} value={key}>{t(`tabs.${key}`)}</TabsTrigger>)}
            </TabsList>
            <TabsContent value="overview" className="pt-4">
              <AdsOverview range={range} adAccountId={adAccountId} />
            </TabsContent>
            <TabsContent value="campaigns" className="space-y-4 pt-4">
              <SegmentedControl
                aria-label={t('campaignView.label')}
                value={view}
                onValueChange={setView}
                options={(['performance', 'manage'] as const).map((key) => ({ value: key, label: t(`campaignView.${key}`) }))}
              />
              {view === 'performance'
                ? <AdsTable canManage={isAdmin && active} canSegment={isAgent} range={range} adAccountId={adAccountId} />
                : (
                  <>
                    <AdDrafts canManage={isAdmin && active} refreshKey={draftsKey} />
                    <CampaignsPanel canManage={isAdmin && active} adAccountId={adAccountId} />
                  </>
                )}
            </TabsContent>
            <TabsContent value="audiences" className="pt-4">
              <AudiencesPanel canManage={isAdmin && active && !!create?.manageEnabled} accounts={accounts} />
            </TabsContent>
            <TabsContent value="leads" className="space-y-8 pt-4">
              <LeadsTable canManage={isAdmin} />
              <section className="space-y-3" aria-labelledby="ads-conversions-title">
                <div>
                  <h2 id="ads-conversions-title" className="text-sm font-semibold text-foreground">{t('conversionsTitle')}</h2>
                  <p className="text-xs text-muted-foreground">{t('conversionsBlurb')}</p>
                </div>
                <ConversionsPanel canResolve={isAdmin} />
              </section>
            </TabsContent>
            <TabsContent value="automation" className="pt-4">
              <RulesPanel canManage={isAdmin && active} canPause={!!create?.manageEnabled} />
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
