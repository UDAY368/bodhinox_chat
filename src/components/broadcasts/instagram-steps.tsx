'use client';

// Instagram campaign steps of the wizard (Campaigns redesign): write the text,
// then review who gets it (only people inside their 24-hour window) and send.

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowLeft, ArrowRight, Loader2, Send, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { AudienceConfig } from '@/lib/broadcast-audience';
import { estimateInstagramAudience, type InstagramAudienceCount } from '@/lib/broadcasts/campaign-client';
import { PhoneFrame, TextBubble } from './broadcast-display';

export const IG_TEXT_MAX = 1000;

export function InstagramMessageStep({ text, onTextChange, onNext, onBack }: {
  text: string;
  onTextChange: (text: string) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const t = useTranslations('Campaigns.wizard');
  const [touched, setTouched] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const error = touched && !text.trim() ? t('messageRequired') : null;

  function insertFirstName() {
    const el = ref.current;
    const token = '{first name}';
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const next = (text.slice(0, start) + token + text.slice(end)).slice(0, IG_TEXT_MAX);
    onTextChange(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold text-foreground">{t('messageTitle')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('messageSubtitle')}</p>
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Label htmlFor="ig-message">{t('messageLabel')}</Label>
            <Button type="button" variant="outline" size="sm" onClick={insertFirstName}>
              <UserRound />
              {t('insertFirstName')}
            </Button>
          </div>
          <Textarea
            id="ig-message"
            ref={ref}
            rows={7}
            maxLength={IG_TEXT_MAX}
            value={text}
            placeholder={t('messagePlaceholder')}
            aria-invalid={!!error}
            aria-describedby="ig-message-hint"
            onChange={(e) => onTextChange(e.target.value)}
            onBlur={() => setTouched(true)}
            className="bg-muted"
          />
          <div id="ig-message-hint" className="flex items-start justify-between gap-2 text-xs">
            <span className={error ? 'text-destructive' : 'text-muted-foreground'}>{error ?? t('messageHint')}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">{text.length}/{IG_TEXT_MAX}</span>
          </div>
        </div>
        <aside aria-label={t('preview')}>
          <PhoneFrame who={t('yourBusiness')}>
            <TextBubble text={text} sampleName={t('sampleName')} emptyLabel={t('previewEmpty')} />
          </PhoneFrame>
        </aside>
      </div>
      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button variant="outline" onClick={onBack} className="text-muted-foreground">
          <ArrowLeft className="h-4 w-4" />
          {t('back')}
        </Button>
        <Button onClick={() => { setTouched(true); if (text.trim()) onNext(); }}>
          {t('next')}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

export function InstagramReviewStep({ name, text, audience, audienceLabel, sending, onSend, onBack }: {
  name: string;
  text: string;
  audience: AudienceConfig;
  audienceLabel: string;
  sending: boolean;
  onSend: () => void;
  onBack: () => void;
}) {
  const t = useTranslations('Campaigns.wizard');
  const [count, setCount] = useState<InstagramAudienceCount | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    estimateInstagramAudience(audience)
      .then((c) => { if (!cancelled) { setCount(c); setFailed(false); } })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [audience]);

  const outside = count ? Math.max(0, count.onInstagram - count.eligible) : 0;
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold text-foreground">{t('reviewTitle')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('reviewSubtitle')}</p>
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="min-w-0 space-y-4">
          <dl className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">{t('reviewName')}</dt><dd className="break-words text-foreground">{name}</dd>
            <dt className="text-muted-foreground">{t('reviewChannel')}</dt><dd className="text-foreground">{t('channelInstagram')}</dd>
            <dt className="text-muted-foreground">{t('reviewAudience')}</dt><dd className="break-words text-foreground">{audienceLabel}</dd>
            <dt className="text-muted-foreground">{t('reviewWhen')}</dt><dd className="text-foreground">{t('reviewNow')}</dd>
          </dl>
          <div className="rounded-xl border border-border bg-card p-4" aria-live="polite">
            {count ? (
              <>
                <p className="flex items-baseline gap-2">
                  <strong className="text-2xl font-bold tabular-nums text-foreground">{count.eligible.toLocaleString()}</strong>
                  <span className="text-sm text-muted-foreground">{t('willGetIt', { count: count.eligible })}</span>
                </p>
                <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
                  {outside > 0 && <li>{t('leftOutWindow', { count: outside })}</li>}
                  <li>{t('leftOutRule')}</li>
                </ul>
              </>
            ) : failed ? (
              <p className="text-sm text-destructive">{t('countFailed')}</p>
            ) : (
              <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t('counting')}</p>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{t('instagramNoSchedule')}</p>
        </div>
        <aside aria-label={t('preview')}>
          <PhoneFrame who={t('yourBusiness')}>
            <TextBubble text={text} sampleName={t('sampleName')} emptyLabel={t('previewEmpty')} />
          </PhoneFrame>
        </aside>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
        <Button variant="outline" onClick={onBack} disabled={sending} className="text-muted-foreground">
          <ArrowLeft className="h-4 w-4" />
          {t('back')}
        </Button>
        <Button onClick={onSend} disabled={sending || !count || count.eligible === 0}>
          {sending ? <Loader2 className="animate-spin" /> : <Send />}
          {t('sendNow')}
        </Button>
      </div>
    </div>
  );
}
