'use client';

import { useMemo, useRef } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { Conversation } from '@/types';
import { getSessionWindow } from '@/lib/inbox/session';
import { conversationChannel } from '@/components/inbox/channel-badge';
import { contactHandle } from '@/lib/whatsapp/wa-identity';
import { avatarTone, initials } from '@/lib/ui/avatar-tone';
import { cn } from '@/lib/utils';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export type WindowUrgency = 'ok' | 'soon' | 'closing';

/** Under 30 minutes is closing, under 2 hours is soon. */
export function windowUrgency(remainingMs: number): WindowUrgency {
  if (remainingMs < 30 * 60 * 1000) return 'closing';
  if (remainingMs < 2 * HOUR_MS) return 'soon';
  return 'ok';
}

/** "23h", "2h", "45m": the time left, rounded down, never below 1m while open. */
export function shortTimeLeft(remainingMs: number): string {
  if (remainingMs >= HOUR_MS) return `${Math.floor(remainingMs / HOUR_MS)}h`;
  return `${Math.max(1, Math.floor(remainingMs / 60_000))}m`;
}

const RING = { ok: 'stroke-emerald-500', soon: 'stroke-amber-500', closing: 'stroke-red-500' } as const;
export const WINDOW_TEXT = {
  ok: 'text-emerald-600 dark:text-emerald-400',
  soon: 'text-amber-700 dark:text-amber-400',
  closing: 'text-red-600 dark:text-red-400',
} as const;

/** What a row needs of a chat's 24-hour window; null once it has closed. */
export function rowWindow(lastCustomerMessageAt: string | null | undefined, now: number) {
  const { active, remainingMs } = getSessionWindow(lastCustomerMessageAt, now);
  if (!active) return null;
  return { remainingMs, urgency: windowUrgency(remainingMs), left: shortTimeLeft(remainingMs), share: Math.min(1, remainingMs / DAY_MS) };
}

/**
 * AiSensy-style strip: one bordered box of avatars for the chats whose window is
 * open, closing soonest first, with ‹ › to page through. Hidden when none are open.
 */
export function WindowStrip({
  conversations,
  now,
  activeConversationId,
  onSelect,
}: {
  conversations: Conversation[];
  now: number;
  activeConversationId: string | null;
  onSelect: (conversation: Conversation) => void;
}) {
  const t = useTranslations('Inbox.conversationList');
  const scroller = useRef<HTMLUListElement>(null);
  const open = useMemo(
    () =>
      conversations
        .map((conversation) => ({ conversation, w: rowWindow(conversation.last_customer_message_at, now) }))
        .filter((x): x is { conversation: Conversation; w: NonNullable<ReturnType<typeof rowWindow>> } => x.w !== null)
        .sort((a, b) => a.w.remainingMs - b.w.remainingMs),
    [conversations, now]
  );
  if (open.length === 0) return null;
  const page = (dir: 1 | -1) => scroller.current?.scrollBy({ left: dir * 180, behavior: 'smooth' });
  const arrow =
    'text-muted-foreground hover:bg-muted hover:text-foreground flex size-6 shrink-0 items-center justify-center rounded-full transition-colors duration-150';

  return (
    <div data-window-strip role="group" aria-label={t('windowStrip')} className="flex max-w-full min-w-0 items-center gap-0.5">
      <button type="button" onClick={() => page(-1)} aria-label={t('windowStripPrev')} className={arrow}>
        <ChevronLeft className="size-4" aria-hidden />
      </button>
      <ul ref={scroller} className="flex min-w-0 gap-1.5 overflow-x-auto [scrollbar-width:none]">
        {open.map(({ conversation, w }) => {
          const contact = conversation.contact;
          const name = contact?.name || (contact ? contactHandle(contact) : '') || '?';
          const label = t('windowStripItem', { name, time: w.left });
          const isActive = conversation.id === activeConversationId;
          return (
            <li key={conversation.id} className="shrink-0">
              <button
                type="button"
                onClick={() => onSelect(conversation)}
                aria-current={isActive ? 'true' : undefined}
                aria-label={label}
                title={label}
                className="flex w-14 flex-col items-center gap-0.5 rounded-lg py-0.5 hover:bg-muted/60"
              >
                <span className="relative flex size-10 items-center justify-center">
                  <svg viewBox="0 0 44 44" className="absolute inset-0 -rotate-90" aria-hidden>
                    <circle cx="22" cy="22" r="20" fill="none" strokeWidth="3" className="stroke-border" />
                    <circle
                      cx="22"
                      cy="22"
                      r="20"
                      fill="none"
                      strokeWidth="3"
                      strokeLinecap="round"
                      pathLength={100}
                      strokeDasharray={`${Math.max(2, w.share * 100)} 100`}
                      className={RING[w.urgency]}
                    />
                  </svg>
                  <span
                    className={cn(
                      'flex size-[32px] items-center justify-center rounded-full text-[11px] font-semibold',
                      avatarTone(name),
                      isActive && 'ring-primary ring-2 ring-offset-1 ring-offset-background'
                    )}
                  >
                    {initials(name)}
                  </span>
                  <span
                    aria-hidden
                    className={cn(
                      'ring-background absolute top-0 right-0 size-2.5 rounded-full ring-2',
                      conversationChannel(conversation) === 'instagram' ? 'bg-[linear-gradient(45deg,#f9a03f,#d6338a_55%,#7b3fe4)]' : 'bg-emerald-500'
                    )}
                  />
                  <span className={cn('bg-background absolute -bottom-1 rounded-full px-1 text-[9px] leading-[12px] font-semibold tabular-nums shadow-xs', WINDOW_TEXT[w.urgency])}>
                    {w.left}
                  </span>
                </span>
                <span className="text-foreground mt-0.5 w-full truncate text-center text-[11px] leading-none">{name.split(' ')[0]}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <button type="button" onClick={() => page(1)} aria-label={t('windowStripNext')} className={arrow}>
        <ChevronRight className="size-4" aria-hidden />
      </button>
    </div>
  );
}

/** A ring around an avatar that drains as the 24-hour window runs out. */
export function WindowRing({ share, urgency }: { share: number; urgency: WindowUrgency }) {
  return (
    <svg viewBox="0 0 44 44" className="pointer-events-none absolute -inset-[3px] size-[46px] -rotate-90" aria-hidden data-window-ring>
      <circle cx="22" cy="22" r="20.5" fill="none" strokeWidth="2" className="stroke-border" />
      <circle
        cx="22"
        cy="22"
        r="20.5"
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        pathLength={100}
        strokeDasharray={`${Math.max(2, share * 100)} 100`}
        className={cn(RING[urgency], 'transition-[stroke-dasharray] duration-700')}
      />
    </svg>
  );
}
