'use client';
import { authFetch } from "@/lib/auth/client";

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { BarChart3, BookOpen, GraduationCap, History, Plus, Settings2, ShieldCheck, SlidersHorizontal, Sparkles } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
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
import { requestedTab, visibleAgentTabs, type AgentTab } from '@/components/agents/agent-tabs';

type Tab = AgentTab;

const TAB_TRIGGERS = {
  agents: { icon: Sparkles, label: 'agents' },
  knowledge: { icon: BookOpen, label: 'knowledge' },
  features: { icon: SlidersHorizontal, label: 'features' },
  quality: { icon: ShieldCheck, label: 'quality' },
  setup: { icon: Settings2, label: 'setup' },
  learnings: { icon: GraduationCap, label: 'learnings' },
  usage: { icon: BarChart3, label: 'usage' },
  activity: { icon: History, label: 'activity' },
} as const;

/**
 * The AI page: Agents (several agents with their test chat), Knowledge (the
 * ask box and the sources), Assistant features (switches, token budget and
 * where tokens went) and Quality, then Setup (business profile wizard and
 * provider settings), Learnings, Usage and Activity.
 */
export default function AgentsPage() {
  const t = useTranslations('AiStudio');
  const { accountRole } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;
  const canSend = accountRole ? canSendMessages(accountRole) : false;
  // One list drives both the triggers and the panels (admin-only tabs are filtered out).
  const visible = visibleAgentTabs(accountRole);
  const [tab, setTab] = useState<Tab>('agents');
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
          const asked = requestedTab(new URLSearchParams(window.location.search).get('tab'));
          setTab(asked ?? (data?.configured ? 'agents' : 'setup'));
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
  const headerAction = canEdit && current === 'agents'
    ? { label: t('newAgent'), run: () => setNewAgent({}) }
    : canEdit && current === 'knowledge'
      ? { label: t('addSource'), run: () => setAddSource({}) }
      : null;

  return (
    <div className="mx-auto max-w-6xl min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-[22px] font-bold tracking-tight text-foreground">{t('title')}</h1>
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted-foreground">{t('description')}</p>
        </div>
        {decided && headerAction && (
          <Button type="button" className="shrink-0" onClick={headerAction.run}><Plus aria-hidden />{headerAction.label}</Button>
        )}
      </div>

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
                <TabsTrigger key={value} value={value} className="h-[30px] flex-none rounded-[9px] px-3 text-[13px] text-muted-foreground transition-colors duration-150 data-active:bg-card data-active:text-foreground data-active:shadow-sm dark:data-active:border-transparent dark:data-active:bg-card">
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

          {/* How the AI's replies did (admins: it shows customer text). */}
          {visible.includes('quality') && (
            <TabsContent value="quality" className="mt-5">
              <QualityPanel onWriteAnswer={canEdit ? (question) => { setAddSource({ preset: question }); setTab('knowledge'); } : undefined} />
            </TabsContent>
          )}

          <TabsContent value="setup" className="mt-5 space-y-6">
            <AgentSetupWizard
              canEdit={canEdit}
              knowledgeSlot={<KnowledgePanel canEdit={canEdit} hasEmbeddingsKey={hasEmbeddingsKey} />}
              onOpenKnowledge={() => setTab('knowledge')}
              onOpenProvider={() => providerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              onFinished={() => setTab('agents')}
            />
            {/* Provider, model, key and auto-reply limits. */}
            <div ref={providerRef} className="scroll-mt-4">
              <AiConfig />
            </div>
          </TabsContent>

          {visible.includes('learnings') && (
            <TabsContent value="learnings" className="mt-5">
              <AgentLearnings canPromote={canEdit} />
            </TabsContent>
          )}

          {visible.includes('usage') && (
            <TabsContent value="usage" className="mt-5">
              <AiUsageCard />
            </TabsContent>
          )}

          {/* What the auto-reply agents did with each customer message (admins: it holds customer text). */}
          {visible.includes('activity') && (
            <TabsContent value="activity" className="mt-5">
              <AiActivity />
            </TabsContent>
          )}
        </Tabs>
      )}
    </div>
  );
}
