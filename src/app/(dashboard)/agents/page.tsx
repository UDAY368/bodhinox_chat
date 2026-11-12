'use client';
import { authFetch } from "@/lib/auth/client";

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Sparkles, Settings2, BarChart3, BookOpen, GraduationCap, History, SlidersHorizontal } from 'lucide-react';
import Image from 'next/image';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { AiPlayground } from '@/components/agents/ai-playground';
import { AiUsageCard } from '@/components/agents/ai-usage';
import { AiActivity } from '@/components/agents/ai-activity';
import { AiConfig } from '@/components/settings/ai-config';
import { KnowledgePanel } from '@/components/ai/knowledge';
import { AgentSetupWizard } from '@/components/ai/setup-wizard';
import { AgentLearnings } from '@/components/ai/learnings';
import { AiAssistantSettings } from '@/components/settings/ai-assistant-settings';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { AGENT_TABS, visibleAgentTabs, type AgentTab } from '@/components/agents/agent-tabs';

type Tab = AgentTab;

const TAB_TRIGGERS = {
  setup: { icon: Settings2, label: 'tabSetup' },
  knowledge: { icon: BookOpen, label: 'tabKnowledge' },
  learnings: { icon: GraduationCap, label: 'tabLearnings' },
  playground: { icon: Sparkles, label: 'tabPlayground' },
  features: { icon: SlidersHorizontal, label: 'tabFeatures' },
  usage: { icon: BarChart3, label: 'tabUsage' },
  activity: { icon: History, label: 'tabActivity' },
} as const;

export default function AgentsPage() {
  const t = useTranslations('Agents');
  const { accountRole } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;
  // One list drives both the triggers and the panels (Usage and Activity are admin-only).
  const visible = visibleAgentTabs(accountRole);
  const [tab, setTab] = useState<Tab>('playground');
  const [decided, setDecided] = useState(false);
  const [hasEmbeddingsKey, setHasEmbeddingsKey] = useState(false);
  const providerRef = useRef<HTMLDivElement>(null);

  // Land first-time users on Setup, returning users on the Playground.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch('/api/ai/config');
        const data = await res.json().catch(() => ({}));
        if (!cancelled) {
          // A link can open a tab directly (/agents?tab=features); otherwise land by setup state.
          const asked = new URLSearchParams(window.location.search).get('tab') as Tab | null;
          setTab(asked && (AGENT_TABS as readonly string[]).includes(asked) ? asked : data?.configured ? 'playground' : 'setup');
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

  return (
    <div className="studio-khaga mx-auto max-w-6xl">
      <div className="relative flex items-center justify-between gap-5 overflow-hidden rounded-[1.5rem] bg-[#111110] px-6 py-8 text-[#f8f7f5] sm:px-9 sm:py-10">
        <div className="relative z-10 max-w-xl">
          <p className="text-[9px] font-semibold uppercase tracking-[0.22em] text-[#e4a36e]">{t('studioEyebrow')}</p>
          <h1 className="mt-4 text-4xl font-medium tracking-[-0.055em] sm:text-5xl">{t('studioTitle')}</h1>
          <p className="mt-3 max-w-md text-sm leading-relaxed text-[#c2bfb8]">{t('studioDescription')}</p>
        </div>
        <Image src="/brand/khaga-sun-orange.webp" alt="" aria-hidden="true"
          width={640} height={640} sizes="(max-width: 640px) 96px, 224px"
          className="pointer-events-none -my-4 h-auto w-56 shrink-0 object-contain max-sm:w-24" />
      </div>
      <p className="mt-5 max-w-3xl text-sm leading-relaxed text-muted-foreground">
        {t('description')}
      </p>

      {decided && (
        <Tabs
          // A tab this role cannot see (an old link) falls back to the playground.
          value={visible.includes(tab) ? tab : 'playground'}
          onValueChange={(v) => setTab(v as Tab)}
          className="mt-6"
        >
          <TabsList className="max-w-full flex-wrap justify-start gap-1 rounded-xl border border-border bg-card p-1 group-data-horizontal/tabs:h-auto">
            {visible.map((value) => {
              const { icon: Icon, label } = TAB_TRIGGERS[value];
              return (
                <TabsTrigger key={value} value={value} className="h-auto px-3 py-2 text-xs">
                  <Icon className="mr-1.5 h-4 w-4" /> {t(label)}
                </TabsTrigger>
              );
            })}
          </TabsList>

          <TabsContent value="playground" className="mt-4">
            <AiPlayground onGoToSetup={() => setTab('setup')} />
          </TabsContent>

          <TabsContent value="setup" className="mt-4 space-y-6">
            <AgentSetupWizard
              canEdit={canEdit}
              knowledgeSlot={<KnowledgePanel canEdit={canEdit} hasEmbeddingsKey={hasEmbeddingsKey} />}
              onOpenKnowledge={() => setTab('knowledge')}
              onOpenProvider={() => providerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              onFinished={() => setTab('playground')}
            />
            {/* Provider, model, key and auto-reply limits. */}
            <div ref={providerRef} className="scroll-mt-4">
              <AiConfig />
            </div>
          </TabsContent>

          <TabsContent value="knowledge" className="mt-4">
            {/* Websites, sitemaps, files and text with crawl status. Editing a document's text and
                re-indexing everything stay in the knowledge card under Setup (AI provider settings). */}
            <KnowledgePanel canEdit={canEdit} hasEmbeddingsKey={hasEmbeddingsKey} />
          </TabsContent>

          {visible.includes('learnings') && (
            <TabsContent value="learnings" className="mt-4">
              <AgentLearnings canPromote={canEdit} />
            </TabsContent>
          )}

          {/* Summaries, suggested replies, lead assessment, insights and the monthly cap (admins). */}
          {visible.includes('features') && (
            <TabsContent value="features" className="mt-4">
              <AiAssistantSettings />
            </TabsContent>
          )}

          {visible.includes('usage') && (
            <TabsContent value="usage" className="mt-4">
              <AiUsageCard />
            </TabsContent>
          )}

          {/* What the auto-reply agent did with each customer message (admins: it holds customer text). */}
          {visible.includes('activity') && (
            <TabsContent value="activity" className="mt-4">
              <AiActivity />
            </TabsContent>
          )}
        </Tabs>
      )}
    </div>
  );
}
