'use client';
import { authFetch } from "@/lib/auth/client";

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Bot, Sparkles, Settings2, BarChart3 } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { AiPlayground } from '@/components/agents/ai-playground';
import { AiUsageCard } from '@/components/agents/ai-usage';
import { AiConfig } from '@/components/settings/ai-config';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';

type Tab = 'playground' | 'setup' | 'usage';

export default function AgentsPage() {
  const t = useTranslations('Agents');
  const { accountRole } = useAuth();
  const canViewUsage = accountRole ? canEditSettings(accountRole) : false;
  const [tab, setTab] = useState<Tab>('playground');
  const [decided, setDecided] = useState(false);

  // Land first-time users on Setup, returning users on the Playground.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch('/api/ai/config');
        const data = await res.json().catch(() => ({}));
        if (!cancelled) setTab(data?.configured ? 'playground' : 'setup');
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
        <Bot aria-hidden="true" className="relative h-20 w-20 shrink-0 text-[#d58a50]/70 max-sm:hidden" strokeWidth={0.8} />
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
            <TabsTrigger value="playground" className="h-auto px-3 py-2 text-xs">
              <Sparkles className="mr-1.5 h-4 w-4" /> {t('tabPlayground')}
            </TabsTrigger>
            <TabsTrigger value="setup" className="h-auto px-3 py-2 text-xs">
              <Settings2 className="mr-1.5 h-4 w-4" /> {t('tabSetup')}
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

          <TabsContent value="setup" className="mt-4">
            <AiConfig />
          </TabsContent>

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
