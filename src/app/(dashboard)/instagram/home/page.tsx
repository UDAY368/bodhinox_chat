'use client';

// Instagram › Home (Stage 5, 5F): where the Instagram section opens.
//   Start here       the three guided setups (quick automations)
//   Your last 7 days top automations (runs, CTR) and posts, leads, the top lead
//                    collector, automated messages and the time they saved (an
//                    estimate of 30 seconds per automated message)
//   Account defaults the always-on replies with their state and a link to each
//   Next moves       the suggestions after the first setup, ticked from real state
// Numbers come from GET /api/instagram/home (any member). The Instagram
// section layout explains a channel that is off or not available.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { ArrowRight, Clock, MessageCircle, Sparkles, UserPlus } from 'lucide-react';
import { NextMovesList } from '@/components/dashboard/onboarding-checklist';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/hooks/use-auth';
import { authFetch } from '@/lib/auth/client';
import { channelPath } from '@/lib/channels/routes';
import type { HomeDefaultKey, InstagramHomeSummary } from '@/lib/instagram/home-summary';
import { cn } from '@/lib/utils';

const START_HERE = [
  { wizard: 'comment_links', key: 'commentLinks', icon: MessageCircle },
  { wizard: 'grow_followers', key: 'growFollowers', icon: UserPlus },
  { wizard: 'story_leads', key: 'storyLeads', icon: Sparkles },
] as const;

/** Each default's title and explanation under Instagram.basics. */
const DEFAULT_LABEL: Record<HomeDefaultKey, { title: string; body: string }> = {
  defaultReply: { title: 'defaultReply', body: 'defaultReplyBody' },
  conversationStarters: { title: 'conversationStarters', body: 'conversationStartersBody' },
  menu: { title: 'mainMenu', body: 'mainMenuBody' },
  storyMentions: { title: 'storyMention', body: 'storyMentionBody' },
  keywords: { title: 'keywords', body: 'keywordsBody' },
};

export default function InstagramHomePage() {
  const t = useTranslations('Instagram.home');
  const tBasics = useTranslations('Instagram.basics');
  const tWizards = useTranslations('Instagram.quickAutomations');
  const tMoves = useTranslations('Dashboard.nextMoves');
  const format = useFormatter();
  const { accountId } = useAuth();
  const [summary, setSummary] = useState<InstagramHomeSummary | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!accountId) return;
    let live = true;
    void (async () => {
      try {
        const res = await authFetch('/api/instagram/home', { cache: 'no-store' });
        if (!res.ok) throw new Error(String(res.status));
        const json = (await res.json()) as { summary: InstagramHomeSummary };
        if (live) setSummary(json.summary);
      } catch {
        if (live) setFailed(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [accountId]);

  const days = summary?.lastDays;
  const empty = !!days && days.topFlows.length === 0 && days.topPosts.length === 0 && days.automatedMessages === 0 && days.leads === 0;
  const movesDone = summary?.nextMoves.filter((move) => move.done).length ?? 0;

  return (
    <div className="space-y-8" data-testid="instagram-home">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('description')}</p>
      </div>

      <section className="space-y-3" aria-labelledby="ig-home-start">
        <h2 id="ig-home-start" className="text-sm font-semibold text-foreground">{t('startHere')}</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {START_HERE.map(({ wizard, key, icon: Icon }) => (
            <Link
              key={wizard}
              href={`${channelPath('instagram', 'quickAutomations')}?wizard=${wizard}`}
              className="group flex flex-col gap-2 rounded-lg border border-border bg-background p-4 transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Icon className="h-5 w-5 text-primary" aria-hidden />
              <span className="text-sm font-semibold text-foreground">{tWizards(`${key}.title`)}</span>
              <span className="text-xs leading-relaxed text-muted-foreground">{tWizards(`${key}.description`)}</span>
              <span className="mt-auto inline-flex items-center gap-1 text-xs font-medium text-primary">
                {t('setUp')}
                <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" aria-hidden />
              </span>
            </Link>
          ))}
        </div>
      </section>

      {failed && <p className="text-sm text-destructive" role="alert">{t('loadFailed')}</p>}

      {days && (
        <section className="space-y-3" aria-labelledby="ig-home-week">
          <h2 id="ig-home-week" className="text-sm font-semibold text-foreground">{t('last7Days')}</h2>
          {empty ? (
            <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">{t('empty')}</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Stat label={t('automatedMessages')} value={format.number(days.automatedMessages)} />
                <Stat
                  label={t('timeSaved')}
                  value={t('timeSavedValue', { hours: days.timeSaved.hours, minutes: days.timeSaved.minutes })}
                  note={t('timeSavedNote')}
                  icon
                />
                <Stat label={t('leads')} value={format.number(days.leads)} />
                <Stat
                  label={t('topLeadFlow')}
                  value={days.topLeadFlow ? days.topLeadFlow.name : t('noLeadFlow')}
                  note={days.topLeadFlow ? t('leadsCount', { count: days.topLeadFlow.leads }) : undefined}
                  small
                />
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                <Card>
                  <CardHeader className="flex flex-row items-center justify-between">
                    <CardTitle className="text-sm">{t('topFlows')}</CardTitle>
                    <Link href={channelPath('instagram', 'flows')} className="text-xs text-primary hover:underline">{t('seeAll')}</Link>
                  </CardHeader>
                  <CardContent>
                    <ul className="space-y-2 text-sm">
                      {days.topFlows.map((flow) => (
                        <li key={flow.id} className="flex items-center justify-between gap-3">
                          <Link href={channelPath('instagram', 'flows', flow.id)} className="min-w-0 truncate text-foreground hover:text-primary hover:underline">
                            {flow.name}
                          </Link>
                          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                            {t('runs', { count: flow.runs })} · {flow.ctr === null ? '—' : `${flow.ctr}%`}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="flex flex-row items-center justify-between">
                    <CardTitle className="text-sm">{t('topPosts')}</CardTitle>
                    <Link href={channelPath('instagram', 'insights')} className="text-xs text-primary hover:underline">{t('seeAll')}</Link>
                  </CardHeader>
                  <CardContent>
                    <ul className="space-y-2 text-sm">
                      {days.topPosts.map((post) => (
                        <li key={post.id} className="flex items-center justify-between gap-3">
                          <span className="min-w-0 truncate text-foreground">{t('post', { id: post.id.slice(-8) })}</span>
                          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                            {t('commentsCount', { count: post.comments })} · {t('leadsCount', { count: post.leads })}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              </div>
            </>
          )}
        </section>
      )}

      {summary && (
        <div className="grid gap-6 lg:grid-cols-2">
          <section className="space-y-3" aria-labelledby="ig-home-defaults">
            <h2 id="ig-home-defaults" className="text-sm font-semibold text-foreground">{t('defaults')}</h2>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {summary.defaults.map((item) => (
                <li key={item.key} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground">
                      {tBasics(DEFAULT_LABEL[item.key].title)}
                      {item.count ? <span className="ml-1 text-xs text-muted-foreground">({format.number(item.count)})</span> : null}
                    </p>
                    <p className="text-xs text-muted-foreground">{tBasics(DEFAULT_LABEL[item.key].body)}</p>
                  </div>
                  <Badge variant="outline" className={cn('text-[10px]', item.on ? 'border-emerald-600/40 text-emerald-700 dark:text-emerald-300' : 'text-muted-foreground')}>
                    {item.on ? t('on') : t('off')}
                  </Badge>
                  <Link href={item.href} className="text-xs font-medium text-primary hover:underline">{t('open')}</Link>
                </li>
              ))}
            </ul>
          </section>

          <section className="space-y-3" aria-labelledby="ig-home-moves">
            <div className="flex items-baseline justify-between">
              <h2 id="ig-home-moves" className="text-sm font-semibold text-foreground">{tMoves('title')}</h2>
              <span className="text-xs text-muted-foreground">{tMoves('progress', { done: movesDone, total: summary.nextMoves.length })}</span>
            </div>
            <NextMovesList moves={summary.nextMoves} />
          </section>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, note, icon = false, small = false }: {
  label: string; value: string; note?: string; icon?: boolean; small?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-background p-4">
      <p className="flex items-center gap-1 text-xs text-muted-foreground">
        {icon && <Clock className="h-3 w-3" aria-hidden />}
        {label}
      </p>
      <p className={cn('mt-1 truncate font-semibold text-foreground', small ? 'text-sm' : 'text-xl tabular-nums')}>{value}</p>
      {note && <p className="mt-1 text-[11px] text-muted-foreground">{note}</p>}
    </div>
  );
}
