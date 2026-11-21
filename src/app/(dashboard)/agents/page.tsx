'use client';
import { authFetch } from "@/lib/auth/client";

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { BookOpen, History, Plus, Settings2, SlidersHorizontal, Sparkles } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { AiUsageCard } from '@/components/agents/ai-usage';
import { AiActivity } from '@/components/agents/ai-activity';
import { AiConfig } from '@/components/settings/ai-config';
import { KnowledgePanel } from '@/components/ai/knowledge';
import { AgentSetupWizard } from '@/components/ai/setup-wizard';
import { AgentLearnings } from '@/components/ai/learnings';
import { AgentsPanel } from '@/components/ai/agents/agents-panel';
import { FeaturesPanel } from '@/components/ai/features/features-panel';
import { QualityPanel } from '@/components/ai/quality/quality-panel';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings, canSendMessages } from '@/lib/auth/roles';
import { SegmentedControl } from '@/components/ui/segmented-control';
import {
  requestedActivitySection, requestedTab, visibleActivitySections, visibleAgentTabs, type ActivitySection, type AgentTab,
} from '@/components/agents/agent-tabs';

type Tab = AgentTab;

const TAB_TRIGGERS = {
  agents: { icon: Sparkles, label: 'agents' },
  knowledge: { icon: BookOpen, label: 'knowledge' },
  features: { icon: SlidersHorizontal, label: 'features' },
  setup: { icon: Settings2, label: 'setup' },
  activity: { icon: History, label: 'activity' },
} as const;

/**
 * The AI page, five tabs: Agents (several agents with their test chat),
 * Knowledge (the ask box and the sources), Assistant features (switches, token
 * budget and where tokens went), Setup (step 1 connects the provider, then the
 * business profile wizard) and Activity (Quality, Learnings, Usage and the
 * activity log: a segmented control over the sections the role may see).
 */
export default function AgentsPage() {
  const t = useTranslations('AiStudio');
  const { accountRole } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;
  const canSend = accountRole ? canSendMessages(accountRole) : false;
  // One list drives both the triggers and the panels (admin-only tabs are filtered out).
  const visible = visibleAgentTabs(accountRole);
  const activitySections = visibleActivitySections(accountRole);
  const [tab, setTab] = useState<Tab>('agents');
  const [activityPick, setActivityPick] = useState<ActivitySection | null>(null);
  const [decided, setDecided] = useState(false);
  const [hasEmbeddingsKey, setHasEmbeddingsKey] = useState(false);
  const [newAgent, setNewAgent] = useState<object | null>(null);
  const [addSource, setAddSource] = useState<{ preset?: string } | null>(null);
  const providerRef = useRef<HTMLDivElement>(null);

  // Land first-time users on Setup, returning users on Agents.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch('/api/ai/config');
        const data = await res.json().catch(() => ({}));
        if (!cancelled) {
          // A link can open a tab directly (/agents?tab=features); otherwise land by setup state.
          const raw = new URLSearchParams(window.location.search).get('tab');
          const asked = requestedTab(raw);
          setTab(asked ?? (data?.configured ? 'agents' : 'setup'));
          setActivityPick(requestedActivitySection(raw));
          setHasEmbeddingsKey(data?.has_embeddings_key === true);
        }
      } catch {
        if (!cancelled) setTab('setup');
      } finally {
        if (!cancelled) setDecided(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const current = visible.includes(tab) ? tab : 'agents';
  // A section this role cannot see (an old link) falls back to the first it can.
  const activity = activityPick && activitySections.includes(activityPick) ? activityPick : activitySections[0];
  const activityLabel = (section: ActivitySection) => (section === 'log' ? t('activityLog') : t(`tabs.${section}`));
  const headerAction = canEdit && current === 'agents'
    ? { label: t('newAgent'), run: () => setNewAgent({}) }
    : canEdit && current === 'knowledge'
      ? { label: t('addSource'), run: () => setAddSource({}) }
      : null;

  return (
    <div className="mx-auto max-w-6xl min-w-0">
      <PageHeader
        className="mb-0"
        title={t('title')}
        subtitle={<span className="block max-w-3xl leading-relaxed">{t('description')}</span>}
        primaryAction={decided && headerAction ? (
          <Button type="button" className="min-h-11 sm:min-h-8" onClick={headerAction.run}><Plus aria-hidden />{headerAction.label}</Button>
        ) : undefined}
      />

      {decided && (
        <Tabs
          // A tab this role cannot see (an old link) falls back to the agent list.
          value={current}
          onValueChange={(v) => setTab(v as Tab)}
          className="mt-5"
        >
          <TabsList aria-label={t('sectionsLabel')} className="max-w-full justify-start gap-1 overflow-x-auto rounded-xl bg-muted p-[3px] [scrollbar-width:none] group-data-horizontal/tabs:h-auto">
            {visible.map((value) => {
              const { icon: Icon, label } = TAB_TRIGGERS[value];
              return (
                <TabsTrigger key={value} value={value} className="h-[30px] pointer-coarse:h-11 flex-none rounded-[9px] px-3 text-[13px] text-muted-foreground transition-colors duration-150 data-active:bg-card data-active:text-foreground data-active:shadow-sm dark:data-active:border-transparent dark:data-active:bg-card">
                  <Icon className="h-4 w-4" aria-hidden /> {t(`tabs.${label}`)}
                </TabsTrigger>
              );
            })}
          </TabsList>

          <TabsContent value="agents" className="mt-5">
            <AgentsPanel canEdit={canEdit} canTest={canSend} newRequest={newAgent} />
          </TabsContent>

          <TabsContent value="knowledge" className="mt-5">
            {/* Websites, sitemaps, files, Q&A and text with sync status, plus "Ask the knowledge base".
                Re-indexing everything stays in the provider settings under Setup. */}
            <KnowledgePanel canEdit={canEdit} canAsk={canSend} hasEmbeddingsKey={hasEmbeddingsKey} addRequest={addSource} />
          </TabsContent>

          {/* Switches, the token budget and where tokens went, plus the Instagram goals (admins). */}
          {visible.includes('features') && (
            <TabsContent value="features" className="mt-5">
              <FeaturesPanel />
            </TabsContent>
          )}

          <TabsContent value="setup" className="mt-5 space-y-6">
            {/* Step 1: connect the provider (provider, model, key, Test connection), then behaviour and limits. */}
            <div ref={providerRef} className="scroll-mt-4">
              <AiConfig />
            </div>
            <AgentSetupWizard
              canEdit={canEdit}
              knowledgeSlot={<KnowledgePanel canEdit={canEdit} hasEmbeddingsKey={hasEmbeddingsKey} />}
              onOpenKnowledge={() => setTab('knowledge')}
              onOpenProvider={() => providerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              onFinished={() => setTab('agents')}
            />
          </TabsContent>

          {/* The records, one at a time: Quality and the log hold customer text (admins). */}
          {visible.includes('activity') && activity && (
            <TabsContent value="activity" className="mt-5 space-y-5">
              {activitySections.length > 1 && (
                <SegmentedControl
                  aria-label={t('tabs.activity')}
                  value={activity}
                  onValueChange={setActivityPick}
                  options={activitySections.map((section) => ({ value: section, label: activityLabel(section) }))}
                  className="w-full sm:w-auto"
                />
              )}
              <section aria-label={activityLabel(activity)}>
                {activity === 'quality' && (
                  <QualityPanel onWriteAnswer={canEdit ? (question) => { setAddSource({ preset: question }); setTab('knowledge'); } : undefined} />
                )}
                {activity === 'learnings' && <AgentLearnings canPromote={canEdit} />}
                {activity === 'usage' && <AiUsageCard />}
                {activity === 'log' && <AiActivity />}
              </section>
            </TabsContent>
          )}
        </Tabs>
      )}
    </div>
  );
}
