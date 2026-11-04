'use client';

// The channel a conversation is on (Phase 11). An Instagram conversation is
// always marked; WhatsApp, the default, is marked only when the workspace also
// has Instagram conversations (`showWhatsApp`), so single-channel inboxes look
// as before. The channel comes from the conversation row.
import { Camera, MessageCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import type { Conversation, ConversationChannel } from '@/types';

/** The conversation's channel; rows from before Phase 11 are WhatsApp. */
export function conversationChannel(conversation: Pick<Conversation, 'channel'> | null | undefined): ConversationChannel {
  return conversation?.channel === 'instagram' ? 'instagram' : 'whatsapp';
}

export function isInstagramConversation(conversation: Pick<Conversation, 'channel'> | null | undefined): boolean {
  return conversationChannel(conversation) === 'instagram';
}

interface ChannelBadgeProps {
  channel: ConversationChannel;
  /** Mark WhatsApp too (the workspace has more than one channel). */
  showWhatsApp?: boolean;
  /** Icon only, with the name as its accessible label. */
  compact?: boolean;
  className?: string;
}

export function ChannelBadge({ channel, showWhatsApp = false, compact = false, className }: ChannelBadgeProps) {
  const t = useTranslations('Inbox.channel');
  if (channel === 'whatsapp' && !showWhatsApp) return null;
  const label = t(channel);
  const Icon = channel === 'instagram' ? Camera : MessageCircle;
  return (
    <span
      data-channel={channel}
      title={label}
      aria-label={compact ? label : undefined}
      role={compact ? 'img' : undefined}
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-px text-[10px] font-medium',
        channel === 'instagram'
          ? 'bg-pink-500/10 text-pink-700 dark:text-pink-300'
          : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
        className
      )}
    >
      <Icon className="h-2.5 w-2.5" aria-hidden />
      {!compact && label}
    </span>
  );
}
