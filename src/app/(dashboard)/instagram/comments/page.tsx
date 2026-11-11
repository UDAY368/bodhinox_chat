'use client';

// Instagram › Comments: comment flows (Stage 2: an Instagram flow started by a
// comment, built in the flow builder) and, below them, the legacy
// comment-reply rules of each connected account, each with "Convert to flow"
// (admins). The Instagram section layout already explains a channel that is
// off or not available. Rules are admin-only on the server; members see the
// accounts and a read-only note. Connection and health stay in Settings.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { InstagramCommentAccounts, type InstagramStatus } from '@/components/instagram/comment-accounts';
import { instagramCall } from '@/components/instagram/comment-rules-editor';
import { createInstagramFlow, useInstagramFlows } from '@/components/instagram/use-instagram-flows';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AiCommentsPanel } from '@/components/instagram/ai-comments-panel';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { channelPath } from '@/lib/channels/routes';

export default function InstagramCommentsPage() {
  const t = useTranslations('Instagram.comments');
  const tAi = useTranslations('Instagram.aiComments');
  const tRules = useTranslations('Settings.instagram.commentRules');
  const tSettings = useTranslations('Settings.instagram');
  const tStatus = useTranslations('Instagram.defaultReply');
  const router = useRouter();
  const { accountId } = useAuth();
  const canEdit = useCan('edit-settings');
  const canCreateFlow = useCan('send-messages');
  const [status, setStatus] = useState<InstagramStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [creating, setCreating] = useState(false);
  const { flows, failed: flowsFailed, reload: reloadFlows } = useInstagramFlows();
  const commentFlows = flows?.filter((f) => f.trigger_type === 'ig_comment' && f.status !== 'archived') ?? null;

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const { ok, json } = await instagramCall('/api/instagram/status');
      if (!ok) throw new Error('load');
      setStatus(json as unknown as InstagramStatus);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    if (!accountId) return;
    setStatus(null);
    void load();
  }, [accountId, load]);

  const newFlow = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const id = await createInstagramFlow(t('newFlow'), 'ig_comment', { post_scope: 'any' });
      if (!id) {
        toast.error(tSettings('errors.generic'));
        return;
      }
      router.push(channelPath('instagram', 'flows', id));
    } catch {
      toast.error(tSettings('errors.generic'));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-foreground text-2xl font-bold tracking-tight">{t('title')}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{t('description')}</p>
      </div>

      <Tabs defaultValue="flows">
        <TabsList>
          <TabsTrigger value="flows">{t('title')}</TabsTrigger>
          <TabsTrigger value="ai">{tAi('tab')}</TabsTrigger>
        </TabsList>
        <TabsContent value="flows" className="mt-4 space-y-6">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
              <CardTitle className="text-base">{t('flowsTitle')}</CardTitle>
              {canCreateFlow && (
                <Button type="button" size="sm" onClick={() => void newFlow()} disabled={creating}>
                  {creating ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
                  {t('newFlow')}
                </Button>
              )}
            </CardHeader>
            <CardContent className="space-y-2">
              {flowsFailed && (
                <div className="flex items-center gap-3 text-sm">
                  <p className="text-destructive">{tSettings('loadFailed')}</p>
                  <Button type="button" variant="outline" size="sm" onClick={() => void reloadFlows()}>{tSettings('retry')}</Button>
                </div>
              )}
              {!commentFlows && !flowsFailed && <Loader2 className="text-muted-foreground size-4 animate-spin" aria-label={tSettings('loading')} />}
              {commentFlows?.length === 0 && <p className="text-muted-foreground text-sm">{t('noFlows')}</p>}
              {!!commentFlows?.length && (
                <ul className="divide-y">
                  {commentFlows.map((flow) => (
                    <li key={flow.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                      <Link href={channelPath('instagram', 'flows', flow.id)} className="text-foreground min-w-0 truncate font-medium hover:underline">
                        {flow.name}
                      </Link>
                      <Badge variant={flow.status === 'active' ? 'default' : 'secondary'}>
                        {flow.status === 'active' ? tStatus('active') : tStatus('inactive')}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <div className="space-y-4">
            <div>
              <h2 className="text-foreground text-lg font-semibold">{tRules('title')}</h2>
              <p className="text-muted-foreground mt-1 text-sm">{tRules('help')}</p>
            </div>
            <InstagramCommentAccounts status={status} failed={failed} canEdit={canEdit} onRetry={() => void load()} />
          </div>
        </TabsContent>
        <TabsContent value="ai" className="mt-4">
          <AiCommentsPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
