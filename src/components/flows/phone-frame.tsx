'use client';

/**
 * A phone around a chat, for the flow preview and the template detail view.
 * WhatsApp draws a dark chat, Instagram a light Direct thread. The phone is a
 * deliberate picture of a handset, so its colours are fixed rather than
 * themed: it reads the same in light and dark mode.
 */

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type PhoneChannel = 'whatsapp' | 'instagram';

export function PhoneFrame({ channel, title, subtitle, children, footer, className }: {
  channel: PhoneChannel;
  /** The business name in the chat header. */
  title: string;
  subtitle: string;
  children: ReactNode;
  /** Below the messages: the customer's reply box or choices. */
  footer?: ReactNode;
  className?: string;
}) {
  const dark = channel === 'whatsapp';
  return (
    <div
      data-phone={channel}
      className={cn(
        'flex h-[min(632px,100%)] w-[304px] max-w-full shrink-0 flex-col overflow-hidden rounded-[42px] border-[10px] border-black shadow-2xl',
        dark ? 'bg-[#222a33] text-white' : 'bg-white text-[#111]',
        className,
      )}
    >
      <div className="flex shrink-0 justify-center pt-2.5" aria-hidden>
        <span className={cn('h-1.5 w-16 rounded-full', dark ? 'bg-white/15' : 'bg-black/10')} />
      </div>
      <div className="flex shrink-0 items-center gap-3 px-5 pb-3 pt-4">
        <PhoneAvatar channel={channel} large />
        <div className="min-w-0">
          <p className="truncate text-[15px] font-semibold leading-tight">{title}</p>
          <p className={cn('truncate text-[13px]', dark ? 'text-white/55' : 'text-black/50')}>{subtitle}</p>
        </div>
      </div>
      <div className={cn('h-px shrink-0', dark ? 'bg-white/10' : 'bg-black/10')} />
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-3 py-4" aria-live="polite">
        {children}
      </div>
      {footer && <div className={cn('shrink-0 border-t px-3 py-3', dark ? 'border-white/10' : 'border-black/10')}>{footer}</div>}
    </div>
  );
}

/** The business's round avatar beside its messages. */
export function PhoneAvatar({ channel, large = false }: { channel: PhoneChannel; large?: boolean }) {
  return (
    <span aria-hidden className={cn('shrink-0 rounded-full', large ? 'h-9 w-9' : 'h-7 w-7',
      channel === 'whatsapp' ? 'bg-[#8b95a1]' : 'bg-gradient-to-br from-amber-400 via-pink-500 to-violet-600')} />
  );
}
