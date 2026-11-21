'use client';

// Instagram › Comments: comment flows (Stage 2: an Instagram flow started by a
// comment, built in the flow builder) and, below them, the legacy
// comment-reply rules of each connected account, each with "Convert to flow"
// (admins). The Instagram section layout already explains a channel that is
// off or not available. Rules are admin-only on the server; members see the
// accounts and a read-only note. Connection and health stay in Settings.
// Apple's way (b7): one large title with "New comment flow" top right, a
// segmented control for Flows / AI replies, and grouped lists.

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, MessageCircle, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { InstagramCommentAccounts, type InstagramStatus } from '@/components/instagram/comment-accounts';
import { instagramCall } from '@/components/instagram/comment-rules-editor';
import { createInstagramFlow, useInstagramFlows } from '@/components/instagram/use-instagram-flows';
import { AiCommentsPanel } from '@/components/instagram/ai-comments-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { GroupedList, GroupedListRow } from '@/components/ui/grouped-list';
import { InlineError } from '@/components/ui/inline-error';
import { PageHeader } from '@/components/ui/page-header';
import { PageLoading } from '@/components/ui/page-loading';
import { SegmentedControl } from '@/components/ui/segmented-control';
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
  const [view, setView] = useState<'flows' | 'ai'>('flows');
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

  const newFlowButton = (
    <Button type="button" onClick={() => void newFlow()} disabled={creating}>
      {creating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
      {t('newFlow')}
    </Button>
  );

  return (
    <div>
      <PageHeader
        title={t('title')}
        subtitle={t('description')}
        primaryAction={view === 'flows' && canCreateFlow ? newFlowButton : undefined}
      >
        <SegmentedControl aria-label={t('title')} value={view} onValueChange={setView}
          options={[{ value: 'flows', label: t('title') }, { value: 'ai', label: tAi('tab') }]} />
      </PageHeader>

      {view === 'flows' ? (
        <div className="space-y-8">
          <section className="space-y-2" aria-labelledby="ig-comment-flows">
            <h2 id="ig-comment-flows" className="text-foreground px-1 text-base font-semibold">{t('flowsTitle')}</h2>
            {flowsFailed && <InlineError message={tSettings('loadFailed')} onRetry={() => void reloadFlows()} />}
            {!commentFlows && !flowsFailed && <PageLoading rows={3} />}
            {commentFlows?.length === 0 && (
              <EmptyState icon={MessageCircle} title={t('noFlows')} />
            )}
            {!!commentFlows?.length && (
              <GroupedList>
                {commentFlows.map((flow) => (
                  <GroupedListRow key={flow.id} href={channelPath('instagram', 'flows', flow.id)} title={flow.name}
                    trailing={(
                      <Badge variant={flow.status === 'active' ? 'default' : 'secondary'}>
                        {flow.status === 'active' ? tStatus('active') : tStatus('inactive')}
                      </Badge>
                    )} />
                ))}
              </GroupedList>
            )}
          </section>

          <section className="space-y-4" aria-labelledby="ig-comment-rules">
            <div className="px-1">
              <h2 id="ig-comment-rules" className="text-foreground text-base font-semibold">{tRules('title')}</h2>
              <p className="text-muted-foreground mt-1 text-sm">{tRules('help')}</p>
            </div>
            <InstagramCommentAccounts status={status} failed={failed} canEdit={canEdit} onRetry={() => void load()} />
          </section>
        </div>
      ) : (
        <AiCommentsPanel />
      )}
    </div>
  );
}
