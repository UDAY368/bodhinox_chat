'use client';

import { useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
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

/**
 * The chats whose 24-hour customer-service window is open at `now`, the one
 * closing first leading. A window that has closed simply drops out, so the rail
 * rolls itself as the clock moves.
 */
export function openWindows(conversations: Conversation[], now: number) {
  return conversations
    .map((conversation) => ({ conversation, ...getSessionWindow(conversation.last_customer_message_at, now) }))
    .filter((w) => w.active)
    .sort((a, b) => a.remainingMs - b.remainingMs);
}

const RING = { ok: 'stroke-emerald-500', soon: 'stroke-amber-500', closing: 'stroke-red-500' } as const;
const TEXT = {
  ok: 'text-muted-foreground',
  soon: 'text-amber-700 dark:text-amber-400',
  closing: 'text-red-600 dark:text-red-400',
} as const;

interface SessionRailProps {
  conversations: Conversation[];
  now: number;
  activeConversationId: string | null;
  onSelect: (conversation: Conversation) => void;
}

/**
 * Open 24-hour windows as a row of avatars, each ringed by the time it has
 * left. Free-form replies are only allowed inside the window, so this is the
 * "answer these first" queue; when a window closes the chat rolls out.
 */
export function SessionRail({ conversations, now, activeConversationId, onSelect }: SessionRailProps) {
  const t = useTranslations('Inbox.sessionRail');
  const [open, setOpen] = useState(true);
  const windows = useMemo(() => openWindows(conversations, now), [conversations, now]);
  if (windows.length === 0) return null;
  const closingSoon = windows.filter((w) => w.remainingMs < 2 * HOUR_MS).length;

  return (
    <section data-session-rail aria-label={t('title')} className="border-border border-b px-3 pt-2 pb-2.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="text-foreground hover:bg-muted/60 -mx-1 flex w-[calc(100%+0.5rem)] items-center gap-2 rounded-lg px-1 py-1 text-left text-[12px] font-semibold transition-colors duration-150"
      >
        <span aria-hidden className="relative flex size-2">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500/60 motion-reduce:animate-none" />
          <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
        </span>
        {t('title')}
        <span className="bg-muted text-muted-foreground rounded-full px-1.5 text-[11px] tabular-nums">{windows.length}</span>
        {closingSoon > 0 && (
          <span className="rounded-full bg-amber-500/12 px-1.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
            {t('closingSoon', { count: closingSoon })}
          </span>
        )}
        <ChevronDown className={cn('text-muted-foreground ml-auto size-3.5 transition-transform duration-150', !open && '-rotate-90')} aria-hidden />
      </button>
      {open && (
        <ul className="studio-rail -mx-1 mt-1.5 flex gap-2 overflow-x-auto px-1 pb-0.5">
          {windows.map(({ conversation, remainingMs }) => {
            const contact = conversation.contact;
            const name = contact?.name || (contact ? contactHandle(contact) : '') || '?';
            const urgency = windowUrgency(remainingMs);
            const left = shortTimeLeft(remainingMs);
            const share = Math.min(1, remainingMs / DAY_MS);
            const isActive = conversation.id === activeConversationId;
            return (
              <li key={conversation.id} className="studio-rail-item shrink-0">
                <button
                  type="button"
                  onClick={() => onSelect(conversation)}
                  aria-current={isActive ? 'true' : undefined}
                  aria-label={t('item', { name, time: left })}
                  title={t('item', { name, time: left })}
                  className="group flex w-14 flex-col items-center gap-1 rounded-xl py-1 transition-colors duration-150 hover:bg-muted/60"
                >
                  <span className="relative flex size-11 items-center justify-center">
                    <svg viewBox="0 0 44 44" className="absolute inset-0 -rotate-90" aria-hidden>
                      <circle cx="22" cy="22" r="20" fill="none" strokeWidth="2.5" className="stroke-border" />
                      <circle
                        cx="22"
                        cy="22"
                        r="20"
                        fill="none"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        pathLength={100}
                        strokeDasharray={`${Math.max(2, share * 100)} 100`}
                        className={cn(RING[urgency], 'transition-[stroke-dasharray] duration-700')}
                      />
                    </svg>
                    <span
                      className={cn(
                        'flex size-[34px] items-center justify-center rounded-full text-[11px] font-semibold',
                        avatarTone(name),
                        isActive && 'ring-primary ring-2 ring-offset-1 ring-offset-card'
                      )}
                    >
                      {initials(name)}
                    </span>
                    <span
                      aria-hidden
                      className={cn(
                        'ring-card absolute right-0.5 bottom-0.5 size-2.5 rounded-full ring-2',
                        conversationChannel(conversation) === 'instagram'
                          ? 'bg-[linear-gradient(45deg,#f9a03f,#d6338a_55%,#7b3fe4)]'
                          : 'bg-emerald-500'
                      )}
                    />
                  </span>
                  <span className={cn('text-[10px] leading-none font-semibold tabular-nums', TEXT[urgency])}>{left}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
