'use client';

// A local, approximate preview of the ad being made in Create ad: the feed
// card, or the full-screen story / WhatsApp Status shape. It updates as the
// admin types. It is drawn here from the form's own values (no Meta call), so
// it is a guide to how the text and image fit, not Meta's exact rendering.

import { useState } from 'react';
import { ImageIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

export type PreviewShape = 'feed' | 'story' | 'status';

export interface AdPreviewProps {
  pageName: string | null;
  primaryText: string;
  headline: string;
  description: string;
  /** A local blob: URL (or https URL) of the image or video thumbnail. */
  imageUrl: string | null;
  ctaLabel: string;
  /** Show the WhatsApp Status shape (click-to-WhatsApp and website ads). */
  allowStatus: boolean;
}

export function AdPreview({ pageName, primaryText, headline, description, imageUrl, ctaLabel, allowStatus }: AdPreviewProps) {
  const t = useTranslations('Ads.preview');
  const [shape, setShape] = useState<PreviewShape>('feed');
  const shapes: PreviewShape[] = allowStatus ? ['feed', 'story', 'status'] : ['feed', 'story'];
  const current = shapes.includes(shape) ? shape : 'feed';
  const name = pageName ?? t('yourPage');
  const media = imageUrl
    // A local preview of the chosen file (blob: URL) or the uploaded image.
    // eslint-disable-next-line @next/next/no-img-element
    ? <img src={imageUrl} alt="" className="size-full object-cover" />
    : <span className="flex size-full items-center justify-center text-muted-foreground"><ImageIcon className="size-8" aria-hidden /></span>;

  return (
    <figure className="space-y-2" data-testid="ad-preview" aria-label={t('title')}>
      <div className="flex items-center justify-between gap-2">
        <figcaption className="text-xs font-medium text-muted-foreground">{t('title')}</figcaption>
        <div role="radiogroup" aria-label={t('shape')} className="flex gap-0.5 rounded-lg bg-muted p-0.5">
          {shapes.map((s) => (
            <button key={s} type="button" role="radio" aria-checked={current === s} onClick={() => setShape(s)}
              className={cn('rounded-md px-2 py-0.5 text-[11px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring',
                current === s ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
              {t(`shapes.${s}`)}
            </button>
          ))}
        </div>
      </div>

      {current === 'feed' ? (
        <div className="mx-auto w-full max-w-[18rem] overflow-hidden rounded-xl border border-border bg-card text-[12px] shadow-sm">
          <div className="flex items-center gap-2 px-3 py-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[11px] font-bold text-primary">{name.slice(0, 1).toUpperCase()}</span>
            <span className="min-w-0">
              <span className="block truncate font-semibold text-foreground">{name}</span>
              <span className="block text-[10px] text-muted-foreground">{t('sponsored')}</span>
            </span>
          </div>
          <p className="line-clamp-3 whitespace-pre-line px-3 pb-2 text-foreground">{primaryText || <span className="text-muted-foreground">{t('textPlaceholder')}</span>}</p>
          <div className="aspect-square bg-muted">{media}</div>
          <div className="flex items-center gap-2 bg-muted/60 px-3 py-2">
            <span className="min-w-0 flex-1">
              <span className="block truncate font-semibold text-foreground">{headline || t('headlinePlaceholder')}</span>
              {description && <span className="block truncate text-[11px] text-muted-foreground">{description}</span>}
            </span>
            <span className="shrink-0 rounded-md bg-card px-2.5 py-1 text-[11px] font-semibold text-foreground">{ctaLabel}</span>
          </div>
        </div>
      ) : (
        <div className="relative mx-auto aspect-[9/16] w-full max-w-[11rem] overflow-hidden rounded-xl bg-neutral-900 text-[11px] text-white shadow-sm">
          <div className="absolute inset-0 opacity-90">{media}</div>
          <div className="absolute inset-x-0 top-0 flex items-center gap-1.5 bg-gradient-to-b from-black/60 to-transparent p-2">
            <span className="flex size-5 items-center justify-center rounded-full bg-white/25 text-[10px] font-bold">{name.slice(0, 1).toUpperCase()}</span>
            <span className="truncate font-semibold">{name}</span>
            <span className="text-[9px] text-white/70">· {t('sponsored')}</span>
          </div>
          <div className="absolute inset-x-0 bottom-0 space-y-1.5 bg-gradient-to-t from-black/75 to-transparent p-2 pt-8">
            <p className="line-clamp-2">{primaryText || t('textPlaceholder')}</p>
            <span className="block rounded-full bg-white py-1 text-center text-[11px] font-semibold text-neutral-900">{ctaLabel}</span>
          </div>
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">{t('note')}</p>
    </figure>
  );
}
