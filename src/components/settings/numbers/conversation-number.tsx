'use client';

// Which WhatsApp number a conversation is on, for the inbox list, its number
// filter and the thread header. Shown only when the workspace has two or more
// numbers; with one number nothing changes on screen.

import { useTranslations } from 'next-intl';
import { Phone } from 'lucide-react';
import { cn } from '@/lib/utils';
import { pickableNumbers } from './number-select';
import { numberLabel, type WhatsAppNumberDto } from './use-whatsapp-numbers';

/** Filter value for conversations whose number was disconnected. */
export const NO_NUMBER = 'none';

type OnNumber = { whatsapp_config_id?: string | null };

export function conversationNumberId(conversation: object): string | null {
  return (conversation as OnNumber).whatsapp_config_id ?? null;
}

/** null shows every conversation; NO_NUMBER those without a number; else one number's. */
export function matchesNumberFilter(conversation: object, filter: string | null): boolean {
  if (filter === null) return true;
  const id = conversationNumberId(conversation);
  return filter === NO_NUMBER ? id === null : id === filter;
}

/**
 * The numbers the inbox filter offers: connected ones (pickableNumbers, which
 * keeps the current filter), plus a disconnected number that listed
 * conversations are still on, so its history stays reachable.
 */
export function inboxFilterNumbers<T extends Pick<WhatsAppNumberDto, 'id' | 'removed'>>(
  numbers: T[],
  conversations: object[],
  currentId: string | null
): T[] {
  const offered = new Set(pickableNumbers(numbers, currentId).map((n) => n.id));
  const withHistory = new Set(conversations.map(conversationNumberId));
  return numbers.filter((n) => offered.has(n.id) || withHistory.has(n.id));
}

interface ConversationNumberBadgeProps {
  conversation: object;
  numbers: WhatsAppNumberDto[];
  className?: string;
}

export function ConversationNumberBadge({ conversation, numbers, className }: ConversationNumberBadgeProps) {
  const t = useTranslations('whatsappNumbers');
  if (numbers.length < 2) return null;
  const id = conversationNumberId(conversation);
  const number = id ? numbers.find((n) => n.id === id) : undefined;
  const label = number ? numberLabel(number, t) : t('picker.noNumber');
  return (
    <span
      className={cn('text-muted-foreground inline-flex max-w-full min-w-0 items-center gap-1 text-[10px]', className)}
      title={t('picker.onNumber', { name: label })}
    >
      <Phone className="size-2.5 shrink-0" aria-hidden />
      <span className="truncate">{label}</span>
    </span>
  );
}
