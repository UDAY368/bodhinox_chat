'use client';

import { Suspense, useMemo, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Sparkles } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { useTheme } from '@/hooks/use-theme';
import { SettingsRail, type RailExtraItem } from '@/components/settings/settings-rail';
import { SettingsOverview } from '@/components/settings/settings-overview';
import { ProfileForm } from '@/components/settings/profile-form';
import { SecurityPanel } from '@/components/settings/security-panel';
import { AppearancePanel } from '@/components/settings/appearance-panel';
import { WhatsAppConfig } from '@/components/settings/whatsapp-config';
import { TemplateManager } from '@/components/settings/template-manager';
import { QuickRepliesManager } from '@/components/settings/quick-replies-manager';
import { FieldsAndTagsPanel } from '@/components/settings/fields-and-tags-panel';
import { DealsSettings } from '@/components/settings/deals-settings';
import { InboxSettings } from '@/components/settings/inbox-settings';
import { WorkingHoursCard } from '@/components/settings/inbox/working-hours-card';
import { RoutingRulesCard } from '@/components/settings/inbox/routing-rules-card';
import { MediaLibraryCard } from '@/components/settings/media-library-card';
import { NotificationPreferences } from '@/components/settings/notification-preferences';
import { MembersTab } from '@/components/settings/members-tab';
import { TeamsCard } from '@/components/settings/teams/teams-card';
import { PermissionsMatrix } from '@/components/settings/teams/permissions-matrix';
import { AuditLogLink } from '@/components/settings/audit-log/audit-log-link';
import { ApiKeysSettings } from '@/components/settings/api-keys-settings';
import { WebhooksSettings } from '@/components/settings/webhooks-settings';
import { ShopifyCard } from '@/components/settings/shopify-card';
import { WooCommerceCard } from '@/components/settings/woocommerce-card';
import { PlanPanel } from '@/components/settings/plan-panel';
import { BillingSection } from '@/components/settings/billing/billing-section';
import { PaymentsCard } from '@/components/settings/payments-card';
import { MetaAdsCard } from '@/components/settings/meta-ads-card';
import { InstagramCard } from '@/components/settings/instagram-card';
import { ZoomCard } from '@/components/settings/zoom-card';
import { ShiprocketCard } from '@/components/settings/shiprocket-card';
import { RateCardEditor } from '@/components/settings/rate-card-editor';
import { AiAssistantSettings } from '@/components/settings/ai-assistant-settings';
import { AiQuality } from '@/components/settings/ai-quality';
import { PrivacySection } from '@/components/settings/privacy/privacy-section';
import { HelpLink } from '@/components/help/help-link';
import { IntegrationHealthCard } from '@/components/settings/integrations/health-card';
import {
  resolveSection,
  type SettingsSection,
} from '@/components/settings/settings-sections';

/** The admin-only AI assistant section (`?tab=ai`). */
const AI_SECTION = 'ai';

// `useSearchParams` opts this page out of static prerendering unless it
// sits under a Suspense boundary. Without one, the production build hits
// the "missing Suspense with CSR bailout" error and the whole page bails
// to client-side rendering — shipping a settings screen whose rail never
// wires up its click handlers. You land on the section the URL carried
// (the account-menu Settings link points at `?tab=whatsapp`) and can't
// navigate away. Mirror the login/signup split: a thin wrapper supplies
// the boundary; the inner component reads the query string.
export default function SettingsPage() {
  return (
    <Suspense fallback={null}>
      <SettingsPageInner />
    </Suspense>
  );
}

function SettingsPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { accountId, defaultCurrency, canEditSettings, canManageMembers } = useAuth();
  const { mode } = useTheme();
  const t = useTranslations('Settings');
  const tAi = useTranslations('AiAssistantSettings');

  // The URL (`?tab=`) is the single source of truth for the active
  // section — deep-linkable, and it keeps the existing links in the
  // app sidebar/header working. Legacy tab values (tags, custom-fields)
  // resolve onto their new home; unknown/empty → the Overview landing.
  // `?tab=ai` (the AI assistant, admins only) is handled here, outside
  // the shared section list.
  const rawTab = searchParams.get('tab');
  const showAi = rawTab === AI_SECTION && canEditSettings;
  const section = resolveSection(rawTab);
  const aiItems: RailExtraItem[] = canEditSettings
    ? [{ id: AI_SECTION, label: tAi('railLabel'), icon: Sparkles, group: 'workspace' }]
    : [];

  const go = (next: SettingsSection | typeof AI_SECTION) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', next);
    router.replace(`/settings?${params.toString()}`, { scroll: false });
  };

  // Cheap, fetch-free rail hints. The Overview landing carries the
  // full live status/counts; the rail just surfaces the two that are
  // already in context.
  const hints: Partial<Record<SettingsSection, ReactNode>> = useMemo(
    () => ({
      appearance: mode.charAt(0).toUpperCase() + mode.slice(1),
      deals: defaultCurrency,
    }),
    [mode, defaultCurrency]
  );

  const panel: Record<SettingsSection, ReactNode> = {
    overview: <SettingsOverview onSelect={go} />,
    profile: <ProfileForm />,
    security: <SecurityPanel />,
    appearance: <AppearancePanel />,
    notifications: <NotificationPreferences key={accountId} />,
    privacy: <PrivacySection key={accountId} />,
    whatsapp: <WhatsAppConfig />,
    instagram: <InstagramCard key={accountId} />,
    templates: <TemplateManager />,
    'quick-replies': <QuickRepliesManager />,
    fields: <FieldsAndTagsPanel />,
    deals: <DealsSettings />,
    inbox: (
      <div key={accountId} className="space-y-10">
        <InboxSettings />
        <WorkingHoursCard canEdit={canEditSettings} />
        <RoutingRulesCard canEdit={canEditSettings} />
      </div>
    ),
    media: <MediaLibraryCard key={accountId} />,
    members: (
      <div key={accountId} className="space-y-10">
        <MembersTab />
        <TeamsCard canEdit={canManageMembers} />
        <PermissionsMatrix canEdit={canManageMembers} />
        {canManageMembers && <AuditLogLink />}
      </div>
    ),
    api: (
      <div className="space-y-10">
        <ApiKeysSettings />
        <WebhooksSettings />
        <ShopifyCard />
        <WooCommerceCard />
      </div>
    ),
    payments: <PaymentsCard />,
    connections: (
      <div key={accountId} className="space-y-10">
        <IntegrationHealthCard />
        <ZoomCard />
        <ShiprocketCard />
      </div>
    ),
    ads: <MetaAdsCard key={accountId} />,
    plan: (
      <div className="space-y-10">
        <PlanPanel />
        <BillingSection key={accountId} />
        <RateCardEditor />
        <HelpLink section="billing" />
      </div>
    ),
  };

  return (
    <div>
      <div>
        <h1 className="text-foreground text-2xl font-bold tracking-tight">
          {t('pageTitle')}
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">{t('pageDesc')}</p>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[236px_minmax(0,1fr)] lg:items-start">
        <SettingsRail active={showAi ? AI_SECTION : section} onSelect={go} hints={hints}
          extraItems={aiItems} onSelectExtra={() => go(AI_SECTION)} />
        <div className="min-w-0">
          {showAi ? (
            <div key={accountId} className="space-y-10">
              <AiAssistantSettings />
              <AiQuality />
            </div>
          ) : panel[section]}
        </div>
      </div>
    </div>
  );
}
