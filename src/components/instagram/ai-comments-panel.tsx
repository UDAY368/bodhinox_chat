'use client';

// Instagram › Comments › AI replies (Stage 3, 3C; owner decision 2): the three
// switches (draft with AI, post without approval, replies per day) and the
// approval queue. Nothing is posted in public until an admin approves a draft,
// unless auto-approve is on. Waiting drafts show their comment as Instagram has
// it now (Bodhinox stores no comment text). Members read; admins change and decide.
// Apple's way (b7): grouped lists (settings, queue, history) instead of cards,
// the shared loading, empty and failed states, 44px buttons.

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { instagramCall, jsonInit } from '@/components/instagram/comment-rules-editor';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { GroupedList } from '@/components/ui/grouped-list';
import { InlineError } from '@/components/ui/inline-error';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageLoading } from '@/components/ui/page-loading';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useCan } from '@/hooks/use-can';
import { INSTAGRAM_LIMITS } from '@/lib/instagram/graph-limits';

const MAX_DAILY_CAP = 500;

interface Settings { configured: boolean; aiActive: boolean; enabled: boolean; autoApprove: boolean; dailyCap: number }
interface Item {
  id: string;
  status: 'pending' | 'approved' | 'rejected' | 'sent' | 'unknown' | 'failed' | 'expired';
  sentiment: 'positive' | 'neutral' | 'negative';
  intent: string | null;
  reply: string;
  autoApproved: boolean;
  comment: { available: boolean; text: string | null; username: string | null } | null;
}
interface Loaded { settings: Settings; items: Item[] }

const INTENTS = new Set(['praise', 'question', 'purchase_intent', 'complaint', 'spam', 'other']);
/** One row of a grouped list: a hairline above every row but the first. */
const ROW = 'not-first:border-separator px-4 py-3 text-sm not-first:border-t';

export function AiCommentsPanel() {
  const t = useTranslations('Instagram.aiComments');
  const tCommon = useTranslations('Flows.header');
  const canEdit = useCan('edit-settings');
  const [pending, setPending] = useState<Loaded | null>(null);
  const [history, setHistory] = useState<Item[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cap, setCap] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const [now, past] = await Promise.all([
        instagramCall('/api/instagram/ai-comments?view=pending'),
        instagramCall('/api/instagram/ai-comments?view=history'),
      ]);
      if (!now.ok || !past.ok) throw new Error('load');
      const loaded = now.json as unknown as Loaded;
      setPending(loaded);
      setCap(String(loaded.settings.dailyCap));
      setHistory((past.json as unknown as Loaded).items);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const save = async (patch: Record<string, unknown>) => {
    if (saving) return;
    setSaving(true);
    try {
      const { ok, json } = await instagramCall('/api/instagram/ai-comments', jsonInit('PUT', patch));
      if (!ok) {
        toast.error(json.error === 'ai_not_configured' ? t('needsAi') : t('settingsFailed'));
        return;
      }
      const settings = (json as unknown as { settings: Settings }).settings;
      setPending((current) => (current ? { ...current, settings } : current));
      setCap(String(settings.dailyCap));
      toast.success(t('settingsSaved'));
    } catch {
      toast.error(t('settingsFailed'));
    } finally {
      setSaving(false);
    }
  };

  const decide = async (item: Item, body: { decision: 'approve'; reply_text?: string } | { decision: 'reject' }) => {
    if (busy) return;
    setBusy(item.id);
    try {
      const { ok, json } = await instagramCall(`/api/instagram/ai-comments/${item.id}`, jsonInit('POST', body));
      if (!ok) {
        toast.error(json.error === 'already_decided' ? t('alreadyDecided') : t('decideFailed'));
        if (json.error === 'already_decided') void load();
        return;
      }
      toast.success(body.decision === 'approve' ? t('approved') : t('rejected'));
      setEditing(null);
      void load();
    } catch {
      toast.error(t('decideFailed'));
    } finally {
      setBusy(null);
    }
  };

  const approveEdited = (item: Item) => {
    const text = (editing?.id === item.id ? editing.text : item.reply).trim();
    if (!text) { toast.error(t('replyEmpty')); return; }
    if ([...text].length > INSTAGRAM_LIMITS.commentReplyChars) {
      toast.error(t('replyTooLong', { max: INSTAGRAM_LIMITS.commentReplyChars }));
      return;
    }
    void decide(item, { decision: 'approve', ...(text !== item.reply ? { reply_text: text } : {}) });
  };

  const label = (group: 'sentiment' | 'intent' | 'status', value: string | null) =>
    value && (group !== 'intent' || INTENTS.has(value)) ? t(`${group}.${value}` as never) : null;

  if (failed) return <InlineError message={t('loadFailed')} onRetry={() => void load()} />;
  if (!pending) return <PageLoading rows={4} />;
  const { settings, items } = pending;
  const capValue = Number(cap);
  const capValid = Number.isInteger(capValue) && capValue >= 1 && capValue <= MAX_DAILY_CAP;

  return (
    <div className="space-y-8">
      <section className="space-y-2" aria-labelledby="ai-comments-title">
        <div className="px-1">
          <h2 id="ai-comments-title" className="text-foreground text-base font-semibold">{t('title')}</h2>
          <p className="text-muted-foreground text-sm">{t('description')}</p>
          {!settings.aiActive && <p className="text-muted-foreground mt-1 text-sm">{t('needsAi')}</p>}
          {!canEdit && <p className="text-muted-foreground mt-1 text-sm">{t('adminOnly')}</p>}
        </div>
        <GroupedList>
          <div className={`${ROW} flex min-h-11 items-center justify-between gap-3 py-2`}>
            <Label htmlFor="ai-comments-enabled" className="font-normal">{t('enabled')}</Label>
            <Switch id="ai-comments-enabled" checked={settings.enabled} disabled={!canEdit || saving || (!settings.aiActive && !settings.enabled)}
              onCheckedChange={(checked) => void save({ enabled: checked })} />
          </div>
          <div className={`${ROW} space-y-1 py-2`}>
            <div className="flex min-h-11 items-center justify-between gap-3">
              <Label htmlFor="ai-comments-auto" className="font-normal">{t('autoApprove')}</Label>
              <Switch id="ai-comments-auto" checked={settings.autoApprove} disabled={!canEdit || saving || !settings.enabled}
                onCheckedChange={(checked) => void save({ auto_approve: checked })} />
            </div>
            <p className="text-muted-foreground text-xs">{t('autoApproveHelp')}</p>
            {settings.autoApprove && <p className="text-destructive text-xs">{t('autoApproveWarning')}</p>}
          </div>
          <div className={`${ROW} space-y-1`}>
            <Label htmlFor="ai-comments-cap" className="font-normal">{t('dailyCap')}</Label>
            <div className="flex items-center gap-2">
              <Input id="ai-comments-cap" type="number" min={1} max={MAX_DAILY_CAP} className="w-28" value={cap}
                disabled={!canEdit || saving} onChange={(e) => setCap(e.target.value)} />
              {canEdit && (
                <Button type="button" variant="outline" className="min-h-11 sm:min-h-8" disabled={saving || !capValid || capValue === settings.dailyCap}
                  onClick={() => void save({ daily_cap: capValue })}>
                  {saving && <Loader2 className="size-3.5 animate-spin" />}
                  {tCommon('save')}
                </Button>
              )}
            </div>
            <p className="text-muted-foreground text-xs">{t('dailyCapHelp', { max: MAX_DAILY_CAP })}</p>
          </div>
        </GroupedList>
      </section>

      <section className="space-y-2" aria-labelledby="ai-comments-queue">
        <h2 id="ai-comments-queue" className="text-foreground px-1 text-base font-semibold">{t('queue')}</h2>
        {items.length === 0 ? <EmptyState icon={Sparkles} title={t('empty')} /> : (
          <GroupedList>
          {items.map((item) => {
            const unavailable = item.comment?.available === false;
            const isEditing = editing?.id === item.id;
            return (
              <div key={item.id} className={`${ROW} space-y-2`}>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={item.sentiment === 'negative' ? 'destructive' : 'secondary'}>{label('sentiment', item.sentiment)}</Badge>
                  {label('intent', item.intent) && <Badge variant="outline">{label('intent', item.intent)}</Badge>}
                </div>
                <div>
                  <p className="text-muted-foreground text-xs font-medium">{t('comment')}{item.comment?.username ? ` · @${item.comment.username}` : ''}</p>
                  <p className="whitespace-pre-wrap">{unavailable ? t('commentUnavailable') : item.comment?.text}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs font-medium">{t('reply')}</p>
                  {isEditing ? (
                    <Textarea value={editing.text} aria-label={t('reply')} onChange={(e) => setEditing({ id: item.id, text: e.target.value })} />
                  ) : (
                    <p className="whitespace-pre-wrap">{item.reply}</p>
                  )}
                </div>
                {canEdit && (
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" className="min-h-11 sm:min-h-8" disabled={busy !== null || unavailable} onClick={() => approveEdited(item)}>
                      {busy === item.id && <Loader2 className="size-3.5 animate-spin" />}
                      {t('approve')}
                    </Button>
                    <Button type="button" variant="outline" className="min-h-11 sm:min-h-8" disabled={busy !== null || unavailable}
                      onClick={() => setEditing(isEditing ? null : { id: item.id, text: item.reply })}>
                      {t('edit')}
                    </Button>
                    <Button type="button" variant="ghost" className="min-h-11 sm:min-h-8" disabled={busy !== null} onClick={() => void decide(item, { decision: 'reject' })}>
                      {t('reject')}
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
          </GroupedList>
        )}
      </section>

      {!!history?.length && (
        <section className="space-y-2" aria-labelledby="ai-comments-history">
          <h2 id="ai-comments-history" className="text-foreground px-1 text-base font-semibold">{t('history')}</h2>
          <GroupedList>
              {history.map((item) => (
                <div key={item.id} className={`${ROW} space-y-1`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={item.status === 'sent' ? 'default' : 'secondary'}>{label('status', item.status)}</Badge>
                    {item.autoApproved && <Badge variant="outline">{t('autoApprovedBadge')}</Badge>}
                  </div>
                  <p className="text-muted-foreground whitespace-pre-wrap">{item.reply}</p>
                  {item.status === 'unknown' && <p className="text-destructive text-xs">{t('reconcile')}</p>}
                </div>
              ))}
          </GroupedList>
        </section>
      )}
    </div>
  );
}
