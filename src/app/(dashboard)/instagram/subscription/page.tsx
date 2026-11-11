'use client';

// Instagram › Subscribe and unsubscribe (Stage 5, 5D): the workspace's own
// opt-out and opt-in words (any language, added to the built-in set), one
// confirmation reply each way and one flow each way
// (GET/PUT /api/instagram/consent-settings). An unsubscribed contact gets no
// automated Instagram message; the team can still reply by hand. Every member
// reads it; admins and owners save.

import { useEffect, useState, type KeyboardEvent } from 'react';
import { Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { useInstagramFlows } from '@/components/instagram/use-instagram-flows';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useCan } from '@/hooks/use-can';
import { authFetch } from '@/lib/auth/client';
import { STAGE5_LIMITS } from '@/types';

interface ConsentSettings {
  opt_out_keywords: string[];
  opt_in_keywords: string[];
  opt_out_reply: string | null;
  opt_in_reply: string | null;
  opt_out_flow_id: string | null;
  opt_in_flow_id: string | null;
}

const EMPTY: ConsentSettings = {
  opt_out_keywords: [], opt_in_keywords: [], opt_out_reply: null, opt_in_reply: null, opt_out_flow_id: null, opt_in_flow_id: null,
};
const NONE = 'none';

function KeywordEditor({ id, label, words, builtIn, disabled, onChange }: {
  id: string; label: string; words: string[]; builtIn: string[]; disabled: boolean; onChange: (words: string[]) => void;
}) {
  const t = useTranslations('Instagram.subscription');
  const [draft, setDraft] = useState('');
  const add = () => {
    const word = draft.trim().replace(/\s+/g, ' ').toLowerCase();
    if (!word || word.length > STAGE5_LIMITS.consentKeywordChars || words.includes(word)
      || words.length >= STAGE5_LIMITS.consentKeywords) return;
    onChange([...words, word]);
    setDraft('');
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',') { event.preventDefault(); add(); }
  };
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <p className="text-muted-foreground text-xs">{t('builtIn', { words: builtIn.join(', ') })}</p>
      <div className="flex flex-wrap gap-1.5" aria-live="polite">
        {words.map((word) => (
          <Badge key={word} variant="secondary" className="gap-1">
            {word}
            {!disabled && (
              <button type="button" aria-label={`${label}: ${word}`} className="hover:text-foreground"
                onClick={() => onChange(words.filter((w) => w !== word))}>
                <X className="size-3" aria-hidden />
              </button>
            )}
          </Badge>
        ))}
      </div>
      {!disabled && (
        <Input id={id} value={draft} maxLength={STAGE5_LIMITS.consentKeywordChars} onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey} onBlur={add} disabled={words.length >= STAGE5_LIMITS.consentKeywords} />
      )}
      <p className="text-muted-foreground text-xs">{t('keywordsHelp')}</p>
    </div>
  );
}

export default function InstagramSubscriptionPage() {
  const t = useTranslations('Instagram.subscription');
  const tSettings = useTranslations('Settings.instagram');
  const canEdit = useCan('edit-settings');
  const { flows } = useInstagramFlows();
  const [settings, setSettings] = useState<ConsentSettings>(EMPTY);
  const [builtIn, setBuiltIn] = useState<{ opt_out: string[]; opt_in: string[] }>({ opt_out: [], opt_in: [] });
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const editable = canEdit && !saving;
  const choices = (flows ?? []).filter((f) => f.status !== 'archived');

  const load = async () => {
    setFailed(false);
    setLoading(true);
    try {
      const res = await authFetch('/api/instagram/consent-settings', { cache: 'no-store' });
      if (!res.ok) throw new Error('load');
      const json = (await res.json()) as { settings: ConsentSettings; built_in: { opt_out: string[]; opt_in: string[] } };
      setSettings(json.settings);
      setBuiltIn(json.built_in);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);

  const save = async () => {
    setSaving(true);
    try {
      const res = await authFetch('/api/instagram/consent-settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(settings),
      });
      if (!res.ok) throw new Error('save');
      setSettings(((await res.json()) as { settings: ConsentSettings }).settings);
      toast.success(t('saved'));
    } catch {
      toast.error(t('invalid'));
    } finally {
      setSaving(false);
    }
  };

  const flowSelect = (id: string, label: string, value: string | null, onChange: (value: string | null) => void) => (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value ?? NONE} disabled={!editable} onValueChange={(v) => onChange(!v || v === NONE ? null : String(v))}>
        <SelectTrigger id={id} className="w-full max-w-sm">
          <SelectValue>{(v: string) => (v === NONE ? t('noFlow') : choices.find((f) => f.id === v)?.name ?? t('noFlow'))}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>{t('noFlow')}</SelectItem>
          {choices.map((flow) => <SelectItem key={flow.id} value={flow.id}>{flow.name}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );

  const replyField = (id: string, label: string, value: string | null, onChange: (value: string | null) => void) => (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Textarea id={id} value={value ?? ''} disabled={!editable} maxLength={STAGE5_LIMITS.consentReplyChars} rows={3}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)} />
    </div>
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-foreground text-2xl font-bold tracking-tight">{t('title')}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{t('description')}</p>
      </div>
      {loading ? (
        <Loader2 className="text-muted-foreground size-4 animate-spin" aria-label={tSettings('loading')} />
      ) : failed ? (
        <div className="flex items-center gap-3 text-sm">
          <p className="text-destructive">{tSettings('loadFailed')}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => void load()}>{tSettings('retry')}</Button>
        </div>
      ) : (
        <>
          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('optOutKeywords')}</CardTitle>
                <CardDescription>{t('optOutReply')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                <KeywordEditor id="opt-out-words" label={t('optOutKeywords')} words={settings.opt_out_keywords}
                  builtIn={builtIn.opt_out.map((w) => w.toLowerCase())} disabled={!editable}
                  onChange={(words) => setSettings((s) => ({ ...s, opt_out_keywords: words }))} />
                {replyField('opt-out-reply', t('optOutReply'), settings.opt_out_reply,
                  (value) => setSettings((s) => ({ ...s, opt_out_reply: value })))}
                {flowSelect('opt-out-flow', t('optOutFlow'), settings.opt_out_flow_id,
                  (value) => setSettings((s) => ({ ...s, opt_out_flow_id: value })))}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('optInKeywords')}</CardTitle>
                <CardDescription>{t('optInReply')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                <KeywordEditor id="opt-in-words" label={t('optInKeywords')} words={settings.opt_in_keywords}
                  builtIn={builtIn.opt_in.map((w) => w.toLowerCase())} disabled={!editable}
                  onChange={(words) => setSettings((s) => ({ ...s, opt_in_keywords: words }))} />
                {replyField('opt-in-reply', t('optInReply'), settings.opt_in_reply,
                  (value) => setSettings((s) => ({ ...s, opt_in_reply: value })))}
                {flowSelect('opt-in-flow', t('optInFlow'), settings.opt_in_flow_id,
                  (value) => setSettings((s) => ({ ...s, opt_in_flow_id: value })))}
              </CardContent>
            </Card>
          </div>
          {canEdit ? (
            <Button onClick={() => void save()} disabled={saving}>
              {saving && <Loader2 className="size-4 animate-spin" aria-hidden />}
              {t('save')}
            </Button>
          ) : (
            <p className="text-muted-foreground text-xs">{tSettings('adminOnly')}</p>
          )}
        </>
      )}
    </div>
  );
}
