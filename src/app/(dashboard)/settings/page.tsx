'use client';

import { Suspense, useEffect, useMemo, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Sparkles } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { useTheme } from '@/hooks/use-theme';
import { useWorkspaceChannels } from '@/hooks/use-workspace-channels';
import { SettingsRail, type RailExtraItem } from '@/components/settings/settings-rail';
import { SettingsOverview } from '@/components/settings/settings-overview';
import { ProfileForm } from '@/components/settings/profile-form';
import { SecurityPanel } from '@/components/settings/security-panel';
import { AppearancePanel } from '@/components/settings/appearance-panel';
import { TemplateManager } from '@/components/settings/template-manager';
import { QuickRepliesManager } from '@/components/settings/quick-replies-manager';
import { FieldsAndTagsPanel } from '@/components/settings/fields-and-tags-panel';
import { DealsSettings } from '@/components/settings/deals-settings';
import { InboxSettings } from '@/components/settings/inbox-settings';
import { WorkingHoursCard } from '@/components/settings/inbox/working-hours-card';
import { RoutingRulesCard } from '@/components/settings/inbox/routing-rules-card';
import { AutomationPauseCard } from '@/components/settings/inbox/automation-pause-card';
import { AssignmentModeCard } from '@/components/settings/inbox/assignment-mode-card';
import { VisibilityCard } from '@/components/settings/inbox/visibility-card';
import { ConversionEventsSettings } from '@/components/settings/conversion-events-settings';
import { MediaLibraryCard } from '@/components/settings/media-library-card';
import { NotificationPreferences } from '@/components/settings/notification-preferences';
import { TeamSection } from '@/components/settings/team-section';
import { AuditLogTable } from '@/components/settings/audit-log/audit-log-table';
import { WorkspaceSection } from '@/components/settings/workspace-section';
import { ChannelsSection } from '@/components/settings/channels-section';
import { IntegrationsSection } from '@/components/settings/integrations-section';
import { SettingsDraftProvider, SettingsSaveBar, useUnsavedSections } from '@/components/settings/settings-draft';
import { ApiKeysSettings } from '@/components/settings/api-keys-settings';
import { WebhooksSettings } from '@/components/settings/webhooks-settings';
import { PlanPanel } from '@/components/settings/plan-panel';
import { BillingSection } from '@/components/settings/billing/billing-section';
import { MetaAdsCard } from '@/components/settings/meta-ads-card';
import { RateCardEditor } from '@/components/settings/rate-card-editor';
import { AiAssistantSettings } from '@/components/settings/ai-assistant-settings';
import { AiQuality } from '@/components/settings/ai-quality';
import { PrivacySection } from '@/components/settings/privacy/privacy-section';
import { HelpLink } from '@/components/help/help-link';
import {
  hiddenSections,
  railSection,
  resolveSection,
  visibleSection,
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
      <SettingsDraftProvider>
        <SettingsPageInner />
      </SettingsDraftProvider>
    </Suspense>
  );
}

function SettingsPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { accountId, defaultCurrency, canEditSettings, canManageMembers } = useAuth();
  const unsaved = useUnsavedSections();
  const tLeave = useTranslations('SettingsRedesign.saveBar');
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
  // A channel the workspace does not use has no tabs here (its connection,
  // and WhatsApp's templates); an old link to one opens Settings › Channels,
  // where it is turned on. Until the channel state loads nothing is hidden.
  const { data: channels, refresh: refreshChannels } = useWorkspaceChannels();
  // The audit log is for admins and owners only (the API refuses everyone else).
  const hidden = useMemo(() => {
    const set = new Set(hiddenSections(channels?.enabled ?? null));
    if (!canManageMembers) set.add('audit-log');
    return set as ReadonlySet<SettingsSection>;
  }, [channels?.enabled, canManageMembers]);
  const section = visibleSection(resolveSection(rawTab), hidden);
  // Connecting or removing a number or account here changes a channel's
  // state; reload it when leaving a section so the nav and banners agree.
  useEffect(() => () => { void refreshChannels(); }, [section, refreshChannels]);
  const aiItems: RailExtraItem[] = canEditSettings
    ? [{ id: AI_SECTION, label: tAi('railLabel'), icon: Sparkles, group: 'workspace' }]
    : [];

  const go = (next: SettingsSection | typeof AI_SECTION) => {
    // Leaving a section with unsaved changes drops them; ask first.
    const current = showAi ? AI_SECTION : section;
    if (next !== current && unsaved.size > 0 && !window.confirm(tLeave('leaveConfirm'))) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', next);
    router.replace(`/settings?${params.toString()}`, { scroll: false });
  };

  // The Integrations grid's Webhooks card opens API & webhooks at the webhooks list.
  const openWebhooks = () => {
    go('api');
    window.setTimeout(() => document.getElementById('webhooks')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
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
    overview: <SettingsOverview onSelect={go} hidden={hidden} />,
    profile: <ProfileForm />,
    security: <SecurityPanel />,
    appearance: <AppearancePanel />,
    notifications: <NotificationPreferences key={accountId} />,
    privacy: <PrivacySection key={accountId} />,
    workspace: <WorkspaceSection key={accountId} />,
    channels: <ChannelsSection active="channels" hidden={hidden} onSelect={go} />,
    whatsapp: <ChannelsSection active="whatsapp" hidden={hidden} onSelect={go} />,
    instagram: <ChannelsSection active="instagram" hidden={hidden} onSelect={go} />,
    templates: <TemplateManager />,
    'quick-replies': <QuickRepliesManager />,
    fields: <FieldsAndTagsPanel />,
    deals: <DealsSettings />,
    inbox: (
      <div key={accountId} className="space-y-10">
        <InboxSettings />
        <WorkingHoursCard canEdit={canEditSettings} />
        <RoutingRulesCard canEdit={canEditSettings} />
        {/* Stage 5: automation pause (5D), assignment mode and agent visibility (5E). */}
        <AutomationPauseCard canEdit={canEditSettings} />
        <AssignmentModeCard canEdit={canEditSettings} />
        <VisibilityCard canEdit={canEditSettings} />
      </div>
    ),
    'conversion-events': <ConversionEventsSettings key={accountId} canEdit={canEditSettings} />,
    media: <MediaLibraryCard key={accountId} />,
    members: <TeamSection key={accountId} />,
    api: (
      <div className="space-y-10">
        <ApiKeysSettings />
        <div id="webhooks" className="scroll-mt-4"><WebhooksSettings /></div>
      </div>
    ),
    // One Integrations card grid; old Payments and Meetings & shipping links land on their card.
    integrations: <IntegrationsSection onOpenApi={openWebhooks} />,
    payments: <IntegrationsSection focus="payments" onOpenApi={openWebhooks} />,
    connections: <IntegrationsSection focus="connections" onOpenApi={openWebhooks} />,
    'audit-log': <AuditLogTable key={accountId} canView={canManageMembers} />,
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
        <h1 className="text-foreground text-[22px] font-bold tracking-tight">
          {t('pageTitle')}
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">{t('pageDesc')}</p>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[224px_minmax(0,1fr)] lg:items-start lg:gap-8 xl:grid-cols-[232px_minmax(0,1fr)]">
        <div className="min-w-0 lg:sticky lg:top-0 lg:self-start lg:border-r lg:border-border lg:pr-3">
          <SettingsRail active={showAi ? AI_SECTION : railSection(section)} onSelect={go} hints={hints}
            extraItems={aiItems} onSelectExtra={() => go(AI_SECTION)} hidden={hidden} unsaved={unsaved} />
        </div>
        <div className="mx-auto w-full min-w-0 max-w-[880px] pb-16">
          {showAi ? (
            <div key={accountId} className="space-y-10">
              <AiAssistantSettings />
              <AiQuality />
            </div>
          ) : panel[section]}
          <SettingsSaveBar />
        </div>
      </div>
    </div>
  );
}
