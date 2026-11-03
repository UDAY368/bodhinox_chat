'use client';
import { authFetch } from "@/lib/auth/client";

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Sparkles, Settings2, BarChart3, BookOpen, GraduationCap } from 'lucide-react';
import Image from 'next/image';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { AiPlayground } from '@/components/agents/ai-playground';
import { AiUsageCard } from '@/components/agents/ai-usage';
import { AiConfig } from '@/components/settings/ai-config';
import { KnowledgePanel } from '@/components/ai/knowledge';
import { AgentSetupWizard } from '@/components/ai/setup-wizard';
import { AgentLearnings } from '@/components/ai/learnings';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings, canSendMessages } from '@/lib/auth/roles';

type Tab = 'setup' | 'knowledge' | 'learnings' | 'playground' | 'usage';

export default function AgentsPage() {
  const t = useTranslations('Agents');
  const { accountRole } = useAuth();
  const canViewUsage = accountRole ? canEditSettings(accountRole) : false;
  const canEdit = canViewUsage;
  const canViewLearnings = accountRole ? canSendMessages(accountRole) : false;
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
          setTab(data?.configured ? 'playground' : 'setup');
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
          value={tab}
          onValueChange={(v) => setTab(v as Tab)}
          className="mt-6"
        >
          <TabsList className="max-w-full flex-wrap justify-start gap-1 rounded-xl border border-border bg-card p-1 group-data-horizontal/tabs:h-auto">
            <TabsTrigger value="setup" className="h-auto px-3 py-2 text-xs">
              <Settings2 className="mr-1.5 h-4 w-4" /> {t('tabSetup')}
            </TabsTrigger>
            <TabsTrigger value="knowledge" className="h-auto px-3 py-2 text-xs">
              <BookOpen className="mr-1.5 h-4 w-4" /> {t('tabKnowledge')}
            </TabsTrigger>
            {canViewLearnings && (
              <TabsTrigger value="learnings" className="h-auto px-3 py-2 text-xs">
                <GraduationCap className="mr-1.5 h-4 w-4" /> {t('tabLearnings')}
              </TabsTrigger>
            )}
            <TabsTrigger value="playground" className="h-auto px-3 py-2 text-xs">
              <Sparkles className="mr-1.5 h-4 w-4" /> {t('tabPlayground')}
            </TabsTrigger>
            {canViewUsage && (
              <TabsTrigger value="usage" className="h-auto px-3 py-2 text-xs">
                <BarChart3 className="mr-1.5 h-4 w-4" /> {t('tabUsage')}
              </TabsTrigger>
            )}
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

          {canViewLearnings && (
            <TabsContent value="learnings" className="mt-4">
              <AgentLearnings canPromote={canEdit} />
            </TabsContent>
          )}

          {canViewUsage && (
            <TabsContent value="usage" className="mt-4">
              <AiUsageCard />
            </TabsContent>
          )}
        </Tabs>
      )}
    </div>
  );
}
