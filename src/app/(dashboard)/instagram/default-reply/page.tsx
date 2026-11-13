'use client';

// Instagram › Default reply (Stage 2, 2E): the Instagram flow with the
// default_reply trigger, which answers a message no other flow handles.
// Admins create it (a draft opened in the flow builder), turn it on (publish)
// or off (pause); everyone else sees its state. The engine side is 2C.

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { createInstagramFlow, useInstagramFlows, type InstagramFlowSummary } from '@/components/instagram/use-instagram-flows';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-foreground text-[22px] font-bold tracking-tight">{t('title')}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{t('description')}</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('flow')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {failed && (
            <div className="flex items-center gap-3 text-sm">
              <p className="text-destructive">{tSettings('loadFailed')}</p>
              <Button type="button" variant="outline" size="sm" onClick={() => void reload()}>{tSettings('retry')}</Button>
            </div>
          )}
          {!replies && !failed && <Loader2 className="text-muted-foreground size-4 animate-spin" aria-label={tSettings('loading')} />}
          {replies?.length === 0 && <p className="text-muted-foreground text-sm">{t('noFlow')}</p>}
          {replies?.map((flow) => {
            const on = flow.status === 'active';
            return (
              <div key={flow.id} className="bg-muted/40 flex flex-wrap items-center gap-3 rounded-md p-3 text-sm" data-default-reply={flow.id}>
                <span className="text-foreground min-w-0 flex-1 truncate font-medium">{flow.name}</span>
                {canEdit ? (
                  <label className="flex items-center gap-2">
                    {busy === flow.id && <Loader2 className="size-3.5 animate-spin" />}
                    <Switch checked={on} disabled={busy !== null} aria-label={on ? t('active') : t('inactive')}
                      onCheckedChange={(value: boolean) => void toggle(flow, value)} />
                    <span className="text-muted-foreground text-xs">{on ? t('active') : t('inactive')}</span>
                  </label>
                ) : (
                  <span className="text-muted-foreground text-xs">{on ? t('active') : t('inactive')}</span>
                )}
                <Link href={channelPath('instagram', 'flows', flow.id)}
                  className="text-primary text-sm font-medium underline-offset-2 hover:underline">
                  {t('edit')}
                </Link>
              </div>
            );
          })}
          {canEdit && replies?.length === 0 && (
            <Button type="button" size="sm" onClick={() => void create()} disabled={busy !== null}>
              {busy === 'create' ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
              {t('create')}
            </Button>
          )}
          {!canEdit && <p className="text-muted-foreground text-xs">{t('adminOnly')}</p>}
        </CardContent>
      </Card>
    </div>
  );
}
