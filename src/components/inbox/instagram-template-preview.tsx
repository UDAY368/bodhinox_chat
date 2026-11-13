'use client';

import { ExternalLink, ImageIcon, Reply } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

/** One card as the preview draws it: from a saved template or a stored message row. */
export interface IgCardView {
  title: string;
  subtitle?: string | null;
  imageUrl?: string | null;
  buttons: { title: string; link: boolean }[];
}

type Button = { type?: string; title?: string; url?: string };
const isLink = (b: Button) => b.type === 'web_url' || typeof b.url === 'string';

/** A saved template's cards ({ imageUrl, buttons:[{type}] }) or a message row's ({ image_url }). */
export function cardViews(cards: unknown): IgCardView[] {
  if (!Array.isArray(cards)) return [];
  return cards.map((raw) => {
    const card = (raw ?? {}) as { title?: string; subtitle?: string | null; imageUrl?: string | null; image_url?: string | null; buttons?: Button[] };
    return {
      title: card.title ?? '',
      subtitle: card.subtitle ?? null,
      imageUrl: card.imageUrl ?? card.image_url ?? null,
      buttons: (card.buttons ?? []).map((b) => ({ title: b.title ?? '', link: isLink(b) })),
    };
  });
}

function ButtonRow({ title, link }: { title: string; link: boolean }) {
  const Icon = link ? ExternalLink : Reply;
  return (
    <span className="border-border text-primary flex items-center justify-center gap-1.5 border-t py-2 text-[13px] font-medium">
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">{title}</span>
    </span>
  );
}

/** A generic template as Instagram shows it: a row of cards (a gallery when more than one). */
export function IgCardsPreview({ cards, className }: { cards: IgCardView[]; className?: string }) {
  const t = useTranslations('Inbox.igTemplates');
  return (
    <div
      role="group"
      aria-label={t('gallery', { count: cards.length })}
      tabIndex={cards.length > 1 ? 0 : undefined}
      className={cn('focus-visible:ring-ring/50 flex max-w-full gap-2 overflow-x-auto rounded-xl pb-1 outline-none focus-visible:ring-2', className)}
      data-ig-cards={cards.length}
    >
      {cards.map((card, index) => (
        <div
          key={index}
          className="bg-card text-foreground ring-border flex w-[220px] shrink-0 flex-col overflow-hidden rounded-xl shadow-sm ring-1"
        >
          {card.imageUrl ? (
            // Card images are https links the member chose; Meta shows the same image.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={card.imageUrl} alt={card.title} className="aspect-[1.91/1] w-full object-cover" referrerPolicy="no-referrer" />
          ) : (
            <span className="bg-muted text-muted-foreground flex aspect-[1.91/1] w-full items-center justify-center">
              <ImageIcon className="size-5" aria-hidden />
            </span>
          )}
          <div className="px-3 py-2">
            <p className="truncate text-[13px] font-semibold">{card.title}</p>
            {card.subtitle && <p className="text-muted-foreground mt-0.5 line-clamp-2 text-xs">{card.subtitle}</p>}
          </div>
          {card.buttons.map((b, i) => (
            <ButtonRow key={i} {...b} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** A button template: the text with its 1–3 buttons underneath. */
export function IgButtonsPreview({ text, buttons, className }: { text: string; buttons: { title: string; link: boolean }[]; className?: string }) {
  return (
    <div className={cn('bg-card text-foreground ring-border w-full max-w-[260px] overflow-hidden rounded-xl shadow-sm ring-1', className)}>
      <p className="px-3 py-2 text-[13px] break-words whitespace-pre-wrap">{text}</p>
      {buttons.map((b, i) => (
        <ButtonRow key={i} {...b} />
      ))}
    </div>
  );
}
