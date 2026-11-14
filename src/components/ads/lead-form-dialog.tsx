'use client';

// "New form" in Create ad (lead form ads): builds a Meta instant form on the
// connected Page (POST /api/meta-ads/leadforms) with the standard questions,
// up to five questions of the business's own, a privacy policy link and a
// thank-you screen. The new form is then chosen for the ad.

import { useState } from 'react';
import { Loader2, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authFetch } from '@/lib/auth/client';
import { cn } from '@/lib/utils';

/** Mirrors LEAD_QUESTION_TYPES in src/lib/meta-ads/graph.ts (server-only). */
const QUESTIONS = ['FULL_NAME', 'PHONE', 'EMAIL', 'CITY', 'COMPANY_NAME', 'JOB_TITLE'] as const;

export function LeadFormDialog({ open, onOpenChange, onCreated }: {
  open: boolean; onOpenChange: (open: boolean) => void; onCreated: (form: { id: string; name: string }) => void;
}) {
  const t = useTranslations('Ads.leadForm');
  const [name, setName] = useState('');
  const [questions, setQuestions] = useState<string[]>(['FULL_NAME', 'PHONE']);
  const [custom, setCustom] = useState<string[]>([]);
  const [privacyUrl, setPrivacyUrl] = useState('');
  const [thankYou, setThankYou] = useState('');
  const [busy, setBusy] = useState(false);

  const valid = !!name.trim() && (questions.includes('PHONE') || questions.includes('EMAIL')) && /^https:\/\/\S+$/.test(privacyUrl.trim())
    && custom.every((c) => c.trim());

  const save = async () => {
    setBusy(true);
    try {
      const res = await authFetch('/api/meta-ads/leadforms', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(), questions, customQuestions: custom.map((c) => c.trim()), privacyUrl: privacyUrl.trim(),
          ...(thankYou.trim() ? { thankYouBody: thankYou.trim() } : {}),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { form?: { id: string; name: string }; error?: string };
      if (!res.ok || !body.form) throw new Error(body.error ?? 'generic');
      toast.success(t('created'));
      onCreated(body.form);
      onOpenChange(false);
      setName(''); setCustom([]); setThankYou('');
    } catch (error) {
      const code = error instanceof Error ? error.message : 'generic';
      toast.error(t.has(`errors.${code}`) ? t(`errors.${code}`) : t('errors.generic'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg" data-testid="lead-form-dialog">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="lead-form-name">{t('name')}</Label>
            <Input id="lead-form-name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} placeholder={t('namePlaceholder')} />
          </div>
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium text-foreground">{t('questions')}</legend>
            <div className="flex flex-wrap gap-1.5">
              {QUESTIONS.map((q) => (
                <button key={q} type="button" aria-pressed={questions.includes(q)}
                  onClick={() => setQuestions(questions.includes(q) ? questions.filter((x) => x !== q) : [...questions, q])}
                  className={cn('rounded-full border px-2.5 py-1 text-xs', questions.includes(q) ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-muted')}>
                  {t(`types.${q}`)}
                </button>
              ))}
            </div>
            {!questions.includes('PHONE') && !questions.includes('EMAIL') && <p className="text-xs text-destructive">{t('needContact')}</p>}
          </fieldset>
          <div className="space-y-1.5">
            <p className="text-sm font-medium text-foreground">{t('custom')}</p>
            {custom.map((c, i) => (
              <div key={i} className="flex gap-2">
                <Input aria-label={t('customLabel', { n: i + 1 })} value={c} maxLength={200} placeholder={t('customPlaceholder')}
                  onChange={(e) => setCustom(custom.map((x, j) => (j === i ? e.target.value : x)))} />
                <Button type="button" variant="ghost" size="icon" aria-label={t('removeQuestion')} onClick={() => setCustom(custom.filter((_, j) => j !== i))}>
                  <X className="size-4" />
                </Button>
              </div>
            ))}
            {custom.length < 5 && (
              <Button type="button" variant="outline" size="sm" onClick={() => setCustom([...custom, ''])}><Plus className="size-3.5" /> {t('addQuestion')}</Button>
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor="lead-form-privacy">{t('privacyUrl')}</Label>
            <Input id="lead-form-privacy" type="url" value={privacyUrl} onChange={(e) => setPrivacyUrl(e.target.value)} placeholder="https://" />
            <p className="text-xs text-muted-foreground">{t('privacyHelp')}</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="lead-form-thanks">{t('thankYou')}</Label>
            <Input id="lead-form-thanks" value={thankYou} maxLength={160} onChange={(e) => setThankYou(e.target.value)} placeholder={t('thankYouPlaceholder')} />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>{t('cancel')}</Button>
          <Button type="button" onClick={() => void save()} disabled={!valid || busy}>
            {busy && <Loader2 className="size-3.5 animate-spin" />} {t('create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
