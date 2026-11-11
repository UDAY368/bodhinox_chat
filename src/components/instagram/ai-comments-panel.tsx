'use client';

// Instagram › Comments › AI replies (Stage 3, 3C; owner decision 2): the three
// switches (draft with AI, post without approval, replies per day) and the
// approval queue. Nothing is posted in public until an admin approves a draft,
// unless auto-approve is on. Waiting drafts show their comment as Instagram has
// it now (Bodhinox stores no comment text). Members read; admins change and decide.

import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { instagramCall, jsonInit } from '@/components/instagram/comment-rules-editor';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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

export function AiCommentsPanel() {
  const t = useTranslations('Instagram.aiComments');
  const tCommon = useTranslations('Flows.header');
  const tRetry = useTranslations('Settings.instagram');
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

  if (failed) {
    return (
      <div className="flex items-center gap-3 text-sm">
        <p className="text-destructive">{t('loadFailed')}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => void load()}>{tRetry('retry')}</Button>
      </div>
    );
  }
  if (!pending) return <Loader2 className="text-muted-foreground size-4 animate-spin" aria-hidden />;
  const { settings, items } = pending;
  const capValue = Number(cap);
  const capValid = Number.isInteger(capValue) && capValue >= 1 && capValue <= MAX_DAILY_CAP;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="space-y-1">
          <CardTitle className="text-base">{t('title')}</CardTitle>
          <p className="text-muted-foreground text-sm">{t('description')}</p>
        </CardHeader>
        <CardContent className="space-y-4">
          {!settings.aiActive && <p className="text-muted-foreground text-sm">{t('needsAi')}</p>}
          {!canEdit && <p className="text-muted-foreground text-sm">{t('adminOnly')}</p>}
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="ai-comments-enabled">{t('enabled')}</Label>
            <Switch id="ai-comments-enabled" checked={settings.enabled} disabled={!canEdit || saving || (!settings.aiActive && !settings.enabled)}
              onCheckedChange={(checked) => void save({ enabled: checked })} />
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="ai-comments-auto">{t('autoApprove')}</Label>
              <Switch id="ai-comments-auto" checked={settings.autoApprove} disabled={!canEdit || saving || !settings.enabled}
                onCheckedChange={(checked) => void save({ auto_approve: checked })} />
            </div>
            <p className="text-muted-foreground text-xs">{t('autoApproveHelp')}</p>
            {settings.autoApprove && <p className="text-destructive text-xs">{t('autoApproveWarning')}</p>}
          </div>
          <div className="space-y-1">
            <Label htmlFor="ai-comments-cap">{t('dailyCap')}</Label>
            <div className="flex items-center gap-2">
              <Input id="ai-comments-cap" type="number" min={1} max={MAX_DAILY_CAP} className="w-28" value={cap}
                disabled={!canEdit || saving} onChange={(e) => setCap(e.target.value)} />
              {canEdit && (
                <Button type="button" size="sm" variant="outline" disabled={saving || !capValid || capValue === settings.dailyCap}
                  onClick={() => void save({ daily_cap: capValue })}>
                  {saving && <Loader2 className="size-3.5 animate-spin" />}
                  {tCommon('save')}
                </Button>
              )}
            </div>
            <p className="text-muted-foreground text-xs">{t('dailyCapHelp', { max: MAX_DAILY_CAP })}</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">{t('queue')}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {items.length === 0 && <p className="text-muted-foreground text-sm">{t('empty')}</p>}
          {items.map((item) => {
            const unavailable = item.comment?.available === false;
            const isEditing = editing?.id === item.id;
            return (
              <div key={item.id} className="space-y-2 rounded-lg border p-3 text-sm">
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
                    <Button type="button" size="sm" disabled={busy !== null || unavailable} onClick={() => approveEdited(item)}>
                      {busy === item.id && <Loader2 className="size-3.5 animate-spin" />}
                      {t('approve')}
                    </Button>
                    <Button type="button" size="sm" variant="outline" disabled={busy !== null || unavailable}
                      onClick={() => setEditing(isEditing ? null : { id: item.id, text: item.reply })}>
                      {t('edit')}
                    </Button>
                    <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={() => void decide(item, { decision: 'reject' })}>
                      {t('reject')}
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      {!!history?.length && (
        <Card>
          <CardHeader><CardTitle className="text-base">{t('history')}</CardTitle></CardHeader>
          <CardContent>
            <ul className="divide-y">
              {history.map((item) => (
                <li key={item.id} className="space-y-1 py-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={item.status === 'sent' ? 'default' : 'secondary'}>{label('status', item.status)}</Badge>
                    {item.autoApproved && <Badge variant="outline">{t('autoApprovedBadge')}</Badge>}
                  </div>
                  <p className="text-muted-foreground whitespace-pre-wrap">{item.reply}</p>
                  {item.status === 'unknown' && <p className="text-destructive text-xs">{t('reconcile')}</p>}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
