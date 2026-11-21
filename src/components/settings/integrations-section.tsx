'use client';

/**
 * Settings › Integrations: one grouped list of connected tools (status badge
 * and Manage or Set up on each row), followed by every
 * integration's full settings card, so nothing the app could do before is
 * lost. Old links keep working: ?tab=connections and ?tab=payments open this
 * section at Zoom and Razorpay. Webhooks open API keys & webhooks.
 */
import { useEffect, useState, type ComponentType } from 'react';
import { useTranslations } from 'next-intl';
import { CreditCard, FileSpreadsheet, ShoppingBag, Store, Truck, Video, Webhook } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { Badge } from '@/components/ui/badge';
import { GroupedList, GroupedListRow } from '@/components/ui/grouped-list';
import { authFetch } from '@/lib/auth/client';
import type { HealthState, IntegrationHealthRow, IntegrationKind } from '@/lib/platform/health';
import { GoogleSheetsCard } from './integrations/google-sheets-card';
import { IntegrationHealthCard } from './integrations/health-card';
import { PaymentsCard } from './payments-card';
import { SettingsPanelHead } from './settings-panel-head';
import { CourierCard } from './courier-card';
import { ShiprocketCard } from './shiprocket-card';
import { ShopifyCard } from './shopify-card';
import { WooCommerceCard } from './woocommerce-card';
import { ZoomCard } from './zoom-card';

type AppId = 'shopify' | 'woocommerce' | 'razorpay' | 'zoom' | 'shiprocket' | 'sheets' | 'webhooks';

const APPS: { id: AppId; icon: ComponentType<{ className?: string }>; kind: IntegrationKind | null }[] = [
  { id: 'shopify', icon: ShoppingBag, kind: 'shopify' },
  { id: 'woocommerce', icon: Store, kind: 'woocommerce' },
  { id: 'razorpay', icon: CreditCard, kind: 'razorpay' },
  { id: 'zoom', icon: Video, kind: 'meetings' },
  { id: 'shiprocket', icon: Truck, kind: 'courier' },
  { id: 'sheets', icon: FileSpreadsheet, kind: null },
  { id: 'webhooks', icon: Webhook, kind: null },
];

/** The worst state among a kind's rows, or null when none is connected (pure). */
export function stateFor(rows: IntegrationHealthRow[] | null, kind: IntegrationKind | null): HealthState | null {
  if (!rows || !kind) return null;
  const mine = rows.filter((row) => row.kind === kind);
  if (!mine.length) return null;
  if (mine.some((row) => row.state === 'attention')) return 'attention';
  if (mine.some((row) => row.state === 'ok')) return 'ok';
  return 'disconnected';
}

export function IntegrationsSection({ focus, onOpenApi }: { focus?: 'payments' | 'connections' | null; onOpenApi: () => void }) {
  const t = useTranslations('SettingsRedesign.integrations');
  const { accountId, canEditSettings } = useAuth();
  const [rows, setRows] = useState<IntegrationHealthRow[] | null>(null);

  useEffect(() => {
    let live = true;
    void authFetch('/api/integrations/health', { cache: 'no-store' })
      .then(async (r) => (r.ok ? ((await r.json()).integrations as IntegrationHealthRow[]) : null))
      .then((list) => { if (live) setRows(list); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [accountId]);

  // An old link to Payments or Meetings & shipping lands on that card.
  useEffect(() => {
    if (!focus) return;
    const id = window.setTimeout(() => {
      document.getElementById(focus === 'payments' ? 'integration-razorpay' : 'integration-zoom')?.scrollIntoView({ block: 'start' });
    }, 150);
    return () => window.clearTimeout(id);
  }, [focus]);

  const open = (app: AppId) => {
    if (app === 'webhooks') return onOpenApi();
    const target = document.getElementById(`integration-${app}`);
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    target?.focus({ preventScroll: true });
  };

  const badge = (state: HealthState | null) => {
    if (state === 'ok') return <Badge variant="secondary">{t('connected')}</Badge>;
    if (state === 'attention') return <Badge variant="destructive">{t('attention')}</Badge>;
    if (state === 'disconnected') return <Badge variant="outline">{t('disconnected')}</Badge>;
    return <Badge variant="outline">{t('notConnected')}</Badge>;
  };

  return (
    <div key={accountId} className="space-y-10">
      <section>
        <SettingsPanelHead title={t('title')} description={t('description')} />
        {/* One grouped list of tools: tapping a row opens its settings below. */}
        <GroupedList>
          {APPS.map(({ id, icon: Icon, kind }) => {
            const state = stateFor(rows, kind);
            return (
              <GroupedListRow
                key={id}
                leading={
                  <span className="flex size-7 items-center justify-center rounded-lg bg-muted text-primary" aria-hidden>
                    <Icon className="size-4" />
                  </span>
                }
                title={t(`apps.${id}.name`)}
                subtitle={t(`apps.${id}.text`)}
                trailing={
                  <span className="flex items-center gap-2">
                    {kind ? badge(state) : null}
                    <span className="hidden sm:inline">{state || id === 'webhooks' || id === 'sheets' ? t('manage') : t('setUp')}</span>
                  </span>
                }
                chevron
                onClick={() => open(id)}
              />
            );
          })}
        </GroupedList>
      </section>

      <IntegrationHealthCard />
      <div id="integration-shopify" tabIndex={-1} className="scroll-mt-4 outline-none"><ShopifyCard /></div>
      <div id="integration-woocommerce" tabIndex={-1} className="scroll-mt-4 outline-none"><WooCommerceCard /></div>
      <div id="integration-razorpay" tabIndex={-1} className="scroll-mt-4 outline-none"><PaymentsCard /></div>
      <div id="integration-zoom" tabIndex={-1} className="scroll-mt-4 outline-none"><ZoomCard /></div>
      <div id="integration-shiprocket" tabIndex={-1} className="scroll-mt-4 outline-none"><ShiprocketCard /></div>
      <div id="integration-delhivery" tabIndex={-1} className="scroll-mt-4 outline-none"><CourierCard provider="delhivery" /></div>
      <div id="integration-shipway" tabIndex={-1} className="scroll-mt-4 outline-none"><CourierCard provider="shipway" /></div>
      {/* Stage 5 (5G): Google Sheets, behind GOOGLE_SHEETS_ENABLED. */}
      <div id="integration-sheets" tabIndex={-1} className="scroll-mt-4 outline-none"><GoogleSheetsCard canEdit={canEditSettings} /></div>
    </div>
  );
}
