'use client';

// Instagram › Automations › Basics (Stage 5, 5F; owner amendment 2): the
// always-on replies, one card each, with their current state and a Set up /
// Edit action that opens the existing tool. Story mention reply opens the
// workspace's story-mention automation, or creates one from the starter
// template (a draft, which the author reviews and sets live). "Say hi to new
// followers" is listed as unavailable: Instagram does not let apps message new
// followers. State comes from GET /api/instagram/home (any member); creating a
// flow needs an agent or above (the server enforces role and CSRF).

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AtSign, Ban, KeyRound, ListTree, Loader2, MessageSquareReply, MessagesSquare, UserPlus } from 'lucide-react';

import { AutomationHubRail } from '@/components/flows/flow-list';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { authFetch } from '@/lib/auth/client';
import { channelPath } from '@/lib/channels/routes';
import type { HomeDefault, HomeDefaultKey, InstagramHomeSummary } from '@/lib/instagram/home-summary';
import { cn } from '@/lib/utils';

/** The starter that answers story mentions (src/lib/flows/templates.ts). */
const STORY_MENTION_TEMPLATE = 'ig_story_mention_thanks';

const CARDS: Array<{ key: HomeDefaultKey; title: string; body: string; icon: typeof AtSign }> = [
  { key: 'defaultReply', title: 'defaultReply', body: 'defaultReplyBody', icon: MessageSquareReply },
  { key: 'conversationStarters', title: 'conversationStarters', body: 'conversationStartersBody', icon: MessagesSquare },
  { key: 'storyMentions', title: 'storyMention', body: 'storyMentionBody', icon: AtSign },
  { key: 'menu', title: 'mainMenu', body: 'mainMenuBody', icon: ListTree },
  { key: 'keywords', title: 'keywords', body: 'keywordsBody', icon: KeyRound },
];

export default function InstagramBasicsPage() {
  const t = useTranslations('Instagram.basics');
  const tHome = useTranslations('Instagram.home');
  const router = useRouter();
  const { accountId } = useAuth();
  const canCreate = useCan('send-messages');
  const [defaults, setDefaults] = useState<Map<HomeDefaultKey, HomeDefault> | null>(null);
  const [failed, setFailed] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!accountId) return;
    let live = true;
    void (async () => {
      try {
        const res = await authFetch('/api/instagram/home', { cache: 'no-store' });
        if (!res.ok) throw new Error(String(res.status));
        const json = (await res.json()) as { summary: InstagramHomeSummary };
        if (live) setDefaults(new Map(json.summary.defaults.map((item) => [item.key, item])));
      } catch {
        if (live) setFailed(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [accountId]);

  async function createStoryMentionFlow() {
    setCreating(true);
    try {
      const res = await authFetch('/api/flows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template_slug: STORY_MENTION_TEMPLATE, channel_scope: 'instagram' }),
      });
      const json = (await res.json().catch(() => ({}))) as { flow?: { id: string }; error?: string };
      if (!res.ok || !json.flow) throw new Error(json.error);
      router.push(channelPath('instagram', 'flows', json.flow.id));
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t('loadFailed'));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex flex-col gap-6 md:flex-row">
      <AutomationHubRail active="basics" />
      <div className="min-w-0 flex-1 space-y-6" data-testid="instagram-basics">
        <div>
          <h1 className="text-[22px] font-bold tracking-tight text-foreground">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('description')}</p>
        </div>
        {failed && <p className="text-sm text-destructive" role="alert">{t('loadFailed')}</p>}
        <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {CARDS.map(({ key, title, body, icon: Icon }) => {
            const state = defaults?.get(key);
            const createsFlow = key === 'storyMentions' && !!defaults && !state?.flowId;
            const action = state?.on ? t('edit') : t('setUp');
            return (
              <li key={key} className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4" data-basic={key}>
                <div className="flex items-start gap-3">
                  <Icon className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-foreground">{t(title)}</p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t(body)}</p>
                  </div>
                  {state && (
                    <Badge variant="outline" className={cn('shrink-0 text-[10px]', state.on ? 'border-emerald-600/40 text-emerald-700 dark:text-emerald-300' : 'text-muted-foreground')}>
                      {state.on ? tHome('on') : tHome('off')}
                    </Badge>
                  )}
                </div>
                <div className="mt-auto flex justify-end">
                  {createsFlow ? (
                    <Button size="sm" disabled={!canCreate || creating} onClick={() => void createStoryMentionFlow()}
                      aria-label={`${t('setUp')}: ${t(title)}`}>
                      {creating && <Loader2 className="h-4 w-4 animate-spin" />}
                      {t('setUp')}
                    </Button>
                  ) : (
                    state ? (
                      <Link href={state.href} aria-label={`${action}: ${t(title)}`}
                        className={buttonVariants({ size: 'sm', variant: state.on ? 'outline' : 'default' })}>
                        {action}
                      </Link>
                    ) : (
                      <Button size="sm" disabled>{t('setUp')}</Button>
                    )
                  )}
                </div>
              </li>
            );
          })}
          <li className="flex flex-col gap-3 rounded-xl border border-border bg-muted/30 p-4" data-basic="newFollowers">
            <div className="flex items-start gap-3">
              <UserPlus className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-muted-foreground">{t('newFollowers')}</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t('newFollowersBody')}</p>
              </div>
              <Badge variant="outline" className="shrink-0 gap-1 text-[10px] text-muted-foreground">
                <Ban className="h-3 w-3" aria-hidden />
                {t('unavailable')}
              </Badge>
            </div>
          </li>
        </ul>
      </div>
    </div>
  );
}
