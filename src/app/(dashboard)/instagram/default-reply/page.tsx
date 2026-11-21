'use client';

// Instagram › Default reply (Stage 2, 2E): the Instagram flow with the
// default_reply trigger, which answers a message no other flow handles.
// Admins create it (a draft opened in the flow builder), turn it on (publish)
// or off (pause); everyone else sees its state. The engine side is 2C.
// Apple's way (b7): one large title with "Create" top right while there is no
// flow, a grouped list with the On/Off switch, the shared states.

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Loader2, MessageSquareReply, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { createInstagramFlow, useInstagramFlows, type InstagramFlowSummary } from '@/components/instagram/use-instagram-flows';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { GroupedList } from '@/components/ui/grouped-list';
import { InlineError } from '@/components/ui/inline-error';
import { PageHeader } from '@/components/ui/page-header';
import { PageLoading } from '@/components/ui/page-loading';
import { Switch } from '@/components/ui/switch';
import { useCan } from '@/hooks/use-can';
import { authFetch } from '@/lib/auth/client';
import { channelPath } from '@/lib/channels/routes';

export default function InstagramDefaultReplyPage() {
  const t = useTranslations('Instagram.defaultReply');
  const tSettings = useTranslations('Settings.instagram');
  const router = useRouter();
  const canEdit = useCan('edit-settings');
  const { flows, failed, reload } = useInstagramFlows();
  const [busy, setBusy] = useState<string | null>(null);
  const replies = flows?.filter((f) => f.trigger_type === 'default_reply' && f.status !== 'archived') ?? null;

  const create = async () => {
    if (busy) return;
    setBusy('create');
    try {
      const id = await createInstagramFlow(t('title'), 'default_reply', { frequency: 'every_time' });
      if (!id) {
        toast.error(t('saveFailed'));
        return;
      }
      router.push(channelPath('instagram', 'flows', id));
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (flow: InstagramFlowSummary, on: boolean) => {
    if (busy) return;
    setBusy(flow.id);
    try {
      const res = await authFetch(`/api/flows/${flow.id}/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: on ? 'active' : 'paused' }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: unknown };
      if (!res.ok) {
        toast.error(typeof json.error === 'string' ? json.error : t('saveFailed'));
        return;
      }
      toast.success(t('saved'));
      await reload();
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setBusy(null);
    }
  };

  const createButton = canEdit && replies?.length === 0 ? (
    <Button type="button" onClick={() => void create()} disabled={busy !== null}>
      {busy === 'create' ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
      {t('create')}
    </Button>
  ) : undefined;

  return (
    <div>
      <PageHeader title={t('title')} subtitle={t('description')} />
      {failed && <InlineError message={tSettings('loadFailed')} onRetry={() => void reload()} />}
      {!replies && !failed && <PageLoading rows={1} />}
      {replies?.length === 0 && (
        <EmptyState icon={MessageSquareReply} title={t('noFlow')} body={canEdit ? undefined : t('adminOnly')} action={createButton} />
      )}
      {!!replies?.length && (
        <GroupedList header={t('flow')} footer={canEdit ? undefined : t('adminOnly')}>
          {replies.map((flow) => {
            const on = flow.status === 'active';
            return (
              <div key={flow.id} data-default-reply={flow.id}
                className="not-first:border-separator flex min-h-11 flex-wrap items-center gap-3 px-4 py-2 text-sm not-first:border-t">
                <span className="text-foreground min-w-0 flex-1 truncate font-medium">{flow.name}</span>
                {canEdit ? (
                  <label className="flex min-h-11 items-center gap-2">
                    {busy === flow.id && <Loader2 className="size-3.5 animate-spin" />}
                    <span className="text-muted-foreground text-xs">{on ? t('active') : t('inactive')}</span>
                    <Switch checked={on} disabled={busy !== null} aria-label={on ? t('active') : t('inactive')}
                      onCheckedChange={(value: boolean) => void toggle(flow, value)} />
                  </label>
                ) : (
                  <span className="text-muted-foreground text-xs">{on ? t('active') : t('inactive')}</span>
                )}
                <Link href={channelPath('instagram', 'flows', flow.id)}
                  className="text-primary inline-flex min-h-11 items-center text-sm font-medium underline-offset-2 hover:underline">
                  {t('edit')}
                </Link>
              </div>
            );
          })}
        </GroupedList>
      )}
    </div>
  );
}
