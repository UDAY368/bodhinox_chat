'use client';

import { templateMessageView } from '@/lib/whatsapp/template-message-view';
import { cn } from '@/lib/utils';
import type { ConversationChannel, Message, MessageReaction, MessageTemplate } from '@/types';
import {
  Clock,
  Check,
  CheckCheck,
  XCircle,
  MapPin,
  LayoutTemplate,
  CornerDownLeft,
  Sparkles,
  CircleHelp,
  ImageOff,
  Link2,
  FileText,
} from 'lucide-react';
import { useState } from 'react';
import { format } from 'date-fns';
import { ReplyQuote } from './reply-quote';
import { MessageReactions } from './message-reactions';
import {
  MediaAudioBubble,
  MediaDocumentBubble,
  MediaImageBubble,
  MediaUnavailable,
  MediaVideoBubble,
} from './message-media';
import { InteractivePreview } from '@/components/interactive/interactive-preview';
import { cardViews, IgButtonsPreview, IgCardsPreview } from './instagram-template-preview';
import { OrderBubble, orderFromPayload } from '@/components/commerce/orders/order-bubble';
import { useTranslations } from 'next-intl';

interface MessageBubbleProps {
  message: Message;
  template?: MessageTemplate | null;
  /** Pre-computed quote info for messages that reply to another. */
  reply?: { authorLabel: string; preview: string } | null;
  reactions?: MessageReaction[];
  currentUserId?: string;
  onToggleReaction?: (emoji: string) => void;
  /**
   * Opens the thread's media viewer on this message. Only images and videos
   * call it; omitted when the parent renders no viewer, in which case media
   * stays inline and non-clickable.
   */
  onOpenMedia?: (messageId: string) => void;
  /** The conversation's channel; Instagram media comes from Meta's CDN and can expire. */
  channel?: ConversationChannel;
  /** Instagram: this is the newest message the business sent, so it carries the Sent / Seen line. */
  receipt?: boolean;
  /** Inside <MessageActions>, which owns the row alignment and width cap. */
  wrapped?: boolean;
}

/** Instagram's words for a sent message's state (it shows no ticks); null where it shows nothing. */
export function instagramReceipt(status: Message['status']): 'sending' | 'sent' | 'seen' | null {
  if (status === 'sending') return 'sending';
  if (status === 'sent' || status === 'delivered') return 'sent';
  if (status === 'read') return 'seen';
  // failed and unknown have their own lines under the bubble.
  return null;
}

/**
 * "[title] — [details]" for a failed message, or null when the row
 * predates migration 042 / Meta sent no reason. Shared by the status
 * icon's tooltip and the line under the bubble.
 */
/** InteractivePreview with the empty-state labels in the UI language. */
function LocalizedInteractivePreview({
  payload,
}: {
  payload: NonNullable<Message['interactive_payload']>;
}) {
  const t = useTranslations('Interactive');
  // Instagram cards (a flow's or a saved template's generic template) draw as cards.
  const raw = payload as unknown as { kind?: string; cards?: unknown; body?: string; buttons?: { title?: string; url?: string }[]; ig?: unknown };
  if (raw.kind === 'cards') return <IgCardsPreview cards={cardViews(raw.cards)} />;
  // An Instagram button template's link buttons carry a url instead of an action.
  if (raw.kind === 'buttons' && raw.ig && raw.buttons?.some((b) => b.url))
    return <IgButtonsPreview text={raw.body ?? ''} buttons={raw.buttons.map((b) => ({ title: b.title ?? '', link: !!b.url }))} />;
  return (
    <InteractivePreview
      payload={payload}
      showPrelude={false}
      labels={{
        body: t('previewBody'),
        button: t('previewButton'),
        menu: t('previewMenu'),
        link: t('openLink'),
        automation: t('existingAutomation'),
        flow: t('existingFlow'),
        location: t('mediaLocation'),
        file: t('mediaFile'),
        image: t('mediaImage'),
        video: t('mediaVideo'),
      }}
    />
  );
}

function failureReason(message: Message): string | null {
  if (message.status !== 'failed' || !message.error_title) return null;
  return message.error_details
    ? `${message.error_title} — ${message.error_details}`
    : message.error_title;
}

function StatusIcon({
  status,
  title,
  uncertainTitle,
}: {
  status: Message['status'];
  /** Tooltip for the failed state — Meta's reason, when we have one. */
  title?: string | null;
  /** Tooltip for an Instagram send whose outcome is unknown. */
  uncertainTitle?: string;
}) {
  switch (status) {
    case 'unknown':
      return (
        <span className="inline-flex" title={uncertainTitle}>
          <CircleHelp className="h-3 w-3 text-amber-500" />
        </span>
      );
    case 'sending':
      return <Clock className="text-muted-foreground h-3 w-3" />;
    case 'sent':
      return <Check className="text-muted-foreground h-3 w-3" />;
    case 'delivered':
      return <CheckCheck className="text-muted-foreground h-3 w-3" />;
    case 'read':
      return <CheckCheck className="h-3 w-3 text-blue-400" />;
    case 'failed':
      return (
        <span className="inline-flex" title={title ?? undefined}>
          <XCircle className="h-3 w-3 text-red-400" />
        </span>
      );
    default:
      return null;
  }
}

/** The fixed Instagram extras stored under interactive_payload.ig. */
function igExtras(message: Message): { url?: string; type?: string } | null {
  const payload = message.interactive_payload as unknown;
  if (!payload || typeof payload !== 'object') return null;
  const ig = (payload as { ig?: unknown }).ig;
  if (!ig || typeof ig !== 'object') return null;
  const { url, type } = ig as { url?: unknown; type?: unknown };
  return {
    url: typeof url === 'string' && /^https:\/\//.test(url) ? url : undefined,
    type: typeof type === 'string' ? type : undefined,
  };
}

/**
 * A customer's Instagram attachment, shown from Meta's CDN URL. Those URLs
 * expire (mirroring is deferred), so a failed load says the media is no longer
 * available on Instagram instead of showing a broken element.
 */
function InstagramMediaBubble({ message, tc }: { message: Message; tc: ReturnType<typeof useTranslations> }) {
  const [broken, setBroken] = useState(false);
  const url = message.media_url!;
  if (broken) {
    return (
      <div className="bg-muted/40 text-muted-foreground flex items-center gap-2 rounded-lg px-3 py-2 text-xs">
        <ImageOff className="h-4 w-4 shrink-0" />
        <span>{tc('mediaUnavailable')}</span>
      </div>
    );
  }
  switch (message.content_type) {
    case 'image':
      return (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt=""
          referrerPolicy="no-referrer"
          className="max-h-64 max-w-60 rounded-lg object-contain"
          onError={() => setBroken(true)}
        />
      );
    case 'video':
      return (
        <video src={url} controls preload="metadata" className="max-h-64 max-w-60 rounded-lg" onError={() => setBroken(true)} />
      );
    case 'audio':
      return <audio src={url} controls preload="metadata" className="max-w-60" onError={() => setBroken(true)} />;
    default:
      return (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          referrerPolicy="no-referrer"
          className="inline-flex items-center gap-2 text-sm underline-offset-2 hover:underline"
        >
          <FileText className="h-4 w-4 shrink-0" />
          <span className="truncate">{message.content_text || tc('instagram')}</span>
        </a>
      );
  }
}

function MessageContent({
  message,
  template,
  t,
  tc,
  isAgent,
  onOpenMedia,
  channel,
}: {
  message: Message;
  template?: MessageTemplate | null;
  t: ReturnType<typeof useTranslations>;
  /** Inbox.channel translator (Instagram bubbles). */
  tc: ReturnType<typeof useTranslations>;
  /** Used to distinguish outbound template badges. */
  isAgent: boolean;
  onOpenMedia?: (messageId: string) => void;
  channel?: ConversationChannel;
}) {
  // Passed to the media bubbles as a no-arg callback; `undefined` when the
  // parent wired up no viewer, which is what makes them non-clickable.
  const openMedia = onOpenMedia ? () => onOpenMedia(message.id) : undefined;

  if (
    channel === 'instagram' &&
    message.sender_type === 'customer' &&
    message.media_url &&
    ['image', 'video', 'audio', 'document'].includes(message.content_type)
  ) {
    return <InstagramMediaBubble message={message} tc={tc} />;
  }

  switch (message.content_type) {
    case 'story_reply': {
      const story = igExtras(message)?.url;
      return (
        <div className="flex flex-col gap-0.5">
          <span className="text-muted-foreground inline-flex items-center gap-1 text-[11px] font-medium">
            <CornerDownLeft className="h-3 w-3" />
            {story ? (
              <a href={story} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="hover:underline">
                {tc('storyReply')}
              </a>
            ) : (
              tc('storyReply')
            )}
          </span>
          {message.content_text && (
            <p className="text-sm break-words whitespace-pre-wrap">{message.content_text}</p>
          )}
        </div>
      );
    }

    case 'share': {
      const link = igExtras(message)?.url;
      return (
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
            <Link2 className="h-3.5 w-3.5 shrink-0" />
            {link ? (
              <a href={link} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="truncate hover:underline">
                {tc('share')}
              </a>
            ) : (
              tc('share')
            )}
          </span>
          {message.content_text && (
            <p className="text-sm break-words whitespace-pre-wrap">{message.content_text}</p>
          )}
        </div>
      );
    }

    case 'unsupported':
      return (
        <div className="flex flex-col gap-1">
          <p className="text-muted-foreground text-xs italic">{tc('unsupported')}</p>
          {message.content_text && (
            <p className="text-sm break-words whitespace-pre-wrap">{message.content_text}</p>
          )}
        </div>
      );

    case 'text':
      return (
        <p className="text-sm break-words whitespace-pre-wrap">
          {message.content_text}
        </p>
      );

    case 'image':
      return (
        <div>
          {message.media_url ? (
            <MediaImageBubble message={message} onOpen={openMedia} t={t} />
          ) : (
            <MediaUnavailable label={t('photo')} t={t} />
          )}
          {message.content_text && (
            <p className="mt-1 text-sm break-words whitespace-pre-wrap">
              {message.content_text}
            </p>
          )}
        </div>
      );

    case 'video':
      return (
        <div>
          {message.media_url ? (
            <MediaVideoBubble message={message} onOpen={openMedia} t={t} />
          ) : (
            <MediaUnavailable label={t('video')} t={t} />
          )}
          {message.content_text && (
            <p className="mt-1 text-sm break-words whitespace-pre-wrap">
              {message.content_text}
            </p>
          )}
        </div>
      );

    case 'audio':
      return (
        <div>
          {message.media_url ? (
            <MediaAudioBubble message={message} t={t} />
          ) : (
            <MediaUnavailable label={t('audio')} t={t} />
          )}
        </div>
      );

    case 'document':
      if (!message.media_url) {
        return (
          <MediaUnavailable
            label={message.content_text || t('document')}
            t={t}
          />
        );
      }
      return <MediaDocumentBubble message={message} t={t} />;

    case 'template': {
      const view = templateMessageView(message, template ?? null);
      // Keep the template name for legacy messages without a saved body.
      return (
        <div>
          <span
            className={cn(
              'mb-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium',
              isAgent
                ? 'studio-message-badge bg-primary/10 text-primary'
                : 'bg-primary/20 text-primary'
            )}
          >
            <LayoutTemplate className="h-3 w-3" />
            {t('template')}
          </span>
          {view.header?.type === 'text' && (
            <p className="mt-1 text-sm font-semibold break-words whitespace-pre-wrap">
              {view.header.text}
            </p>
          )}
          {view.header &&
            view.header.type !== 'text' &&
            (view.header.url ? (
              view.header.type === 'image' ? (
                <MediaImageBubble
                  message={{ ...message, media_url: view.header.url }}
                  t={t}
                />
              ) : view.header.type === 'video' ? (
                <MediaVideoBubble
                  message={{ ...message, media_url: view.header.url }}
                  t={t}
                />
              ) : (
                <MediaDocumentBubble
                  message={{ ...message, media_url: view.header.url }}
                  t={t}
                />
              )
            ) : (
              <MediaUnavailable
                label={t(
                  view.header.type === 'image' ? 'photo' : view.header.type
                )}
                t={t}
              />
            ))}
          {message.content_text ? (
            <p className="mt-1 text-sm break-words whitespace-pre-wrap">
              {message.content_text}
            </p>
          ) : (
            message.template_name && (
              <p className="mt-1 text-sm break-words italic opacity-80">
                {message.template_name}
              </p>
            )
          )}
          {view.footer && (
            <p className="mt-2 text-xs break-words whitespace-pre-wrap opacity-70">
              {view.footer}
            </p>
          )}
          {view.buttons.length > 0 && (
            <div className="mt-2 space-y-1 border-t border-current/20 pt-2">
              {view.buttons.map((button, index) => (
                <div
                  key={index}
                  className="rounded border border-current/20 px-3 py-1 text-center text-xs"
                >
                  {button.text}
                </div>
              ))}
            </div>
          )}
        </div>
      );
    }

    case 'location':
      return (
        <div className="flex items-center gap-2 text-sm">
          <MapPin className="text-muted-foreground h-4 w-4 shrink-0" />
          <span>{message.content_text || t('locationShared')}</span>
        </div>
      );

    case 'interactive': {
      // Three cases share content_type='interactive':
      //  - OUTBOUND with payload (composer / automation / Flow send after
      //    migration 035): render the buttons/list as they appear on the phone.
      //  - INBOUND tap (customer chose an option, sender_type='customer'):
      //    no payload; show the tapped option's title with a reply affordance
      //    so agents can tell it's a tap, not the customer typing.
      //  - OUTBOUND with NO payload (legacy bot/Flow sends from before
      //    migration 035 backfilled the column): show the body text plainly —
      //    it is our own message, NOT a customer tap.
      // A customer's address-form reply stores its fields here too; show its text instead.
      if (message.interactive_payload && message.sender_type !== 'customer') {
        return (
          <LocalizedInteractivePreview payload={message.interactive_payload} />
        );
      }
      // A cart sent from the catalogue (its items are in interactive_payload.order).
      if (message.sender_type === 'customer' && orderFromPayload(message.interactive_payload)) {
        return <OrderBubble payload={message.interactive_payload} />;
      }
      if (message.sender_type === 'customer') {
        return (
          <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground inline-flex items-center gap-1 text-[11px] font-medium">
              <CornerDownLeft className="h-3 w-3" />
              {t('buttonReply')}
            </span>
            <p className="text-sm break-words whitespace-pre-wrap">
              {message.content_text || t('interactiveReply')}
            </p>
          </div>
        );
      }
      return (
        <p className="text-sm break-words whitespace-pre-wrap">
          {message.content_text || t('interactiveReply')}
        </p>
      );
    }

    default:
      return (
        <p className="text-sm break-words whitespace-pre-wrap">
          {message.content_text || t('unsupported')}
        </p>
      );
  }
}

export function MessageBubble({
  message,
  template,
  reply,
  reactions,
  currentUserId,
  onToggleReaction,
  onOpenMedia,
  channel,
  receipt,
  wrapped = false,
}: MessageBubbleProps) {
  const t = useTranslations('Inbox.bubble');
  const tc = useTranslations('Inbox.channel');

  const isAgent =
    message.sender_type === 'agent' || message.sender_type === 'bot';
  const time = format(new Date(message.created_at), 'HH:mm');
  const failure = isAgent ? failureReason(message) : null;

  if (channel === 'instagram') {
    // Instagram's own look: round bubbles, the time on hover (and for screen readers),
    // and Sent / Seen under the newest outgoing message instead of ticks.
    const state = isAgent && receipt ? instagramReceipt(message.status) : null;
    return (
      <div className={cn('flex flex-col', !wrapped && 'max-w-[85%] @xl:max-w-[min(65%,40rem)]', isAgent ? 'ml-auto items-end' : 'mr-auto items-start')}>
        <div
          title={time}
          className={cn('ig-message relative px-3 py-2 leading-snug', isAgent ? 'ig-message-outgoing' : 'ig-message-incoming')}
        >
          {reply && <ReplyQuote authorLabel={reply.authorLabel} preview={reply.preview} />}
          <MessageContent message={message} template={template} t={t} tc={tc} isAgent={isAgent} onOpenMedia={onOpenMedia} channel={channel} />
          <span className="sr-only">{time}</span>
        </div>
        {(message.ai_generated || state) && (
          <div className="mt-0.5 flex items-center gap-1 px-2">
            {message.ai_generated && (
              <span className="ig-message-badge inline-flex items-center gap-0.5 rounded-full px-1.5 py-px text-[10px] leading-none font-semibold"
                title={t('aiBadgeTitle')}>
                <Sparkles className="h-2.5 w-2.5" />
                {t('aiBadge')}
              </span>
            )}
            {state && <span className="text-muted-foreground text-[11px]" data-receipt={state}>{t(`igReceipt.${state}`)}</span>}
          </div>
        )}
        {failure && (
          <p className="text-muted-foreground mt-0.5 px-2 text-[10px] leading-tight" title={failure}>{t('notDelivered')}: {failure}</p>
        )}
        {isAgent && message.status === 'unknown' && (
          <p data-delivery-uncertain className="mt-0.5 px-2 text-[10px] leading-tight text-amber-700 dark:text-amber-400">{tc('deliveryUncertain')}</p>
        )}
        {reactions && reactions.length > 0 && onToggleReaction && (
          <MessageReactions reactions={reactions} currentUserId={currentUserId} onToggle={onToggleReaction} />
        )}
      </div>
    );
  }

  // Row alignment + width cap are owned by <MessageActions> so its hover
  // group matches the bubble's content area, not the full row.
  return (
    <div className={cn('flex flex-col', isAgent ? 'items-end' : 'items-start')}>
      <div
        className={cn(
          'studio-message relative rounded-[18px] px-3 py-2 leading-relaxed',
          isAgent
            ? 'studio-message-outgoing bg-primary text-primary-foreground rounded-br-md'
            : 'bg-muted text-foreground rounded-bl-md'
        )}
      >
        {reply && (
          <ReplyQuote authorLabel={reply.authorLabel} preview={reply.preview} />
        )}
        <MessageContent
          message={message}
          template={template}
          t={t}
          tc={tc}
          isAgent={isAgent}
          onOpenMedia={onOpenMedia}
          channel={channel}
        />
        <div
          className={cn(
            'mt-1 flex items-center gap-1',
            isAgent ? 'justify-end' : 'justify-start'
          )}
        >
          {/* Identify replies generated by the auto-reply bot. */}
          {message.ai_generated && (
            <span
              className="studio-message-badge bg-primary/10 text-primary inline-flex items-center gap-0.5 rounded-full px-1.5 py-px text-[10px] leading-none font-semibold"
              title={t('aiBadgeTitle')}
            >
              <Sparkles className="h-2.5 w-2.5" />
              {t('aiBadge')}
            </span>
          )}
          <span className="text-muted-foreground text-[11px] tabular-nums">{time}</span>
          {isAgent && (
            <StatusIcon status={message.status} title={failure} uncertainTitle={tc('deliveryUncertain')} />
          )}
        </div>
      </div>
      {failure && (
        <p
          className="text-muted-foreground mt-0.5 px-1 text-[10px] leading-tight"
          title={failure}
        >
          {t('notDelivered')}: {failure}
        </p>
      )}
      {isAgent && message.status === 'unknown' && (
        <p
          data-delivery-uncertain
          className="mt-0.5 px-1 text-[10px] leading-tight text-amber-700 dark:text-amber-400"
        >
          {tc('deliveryUncertain')}
        </p>
      )}
      {reactions && reactions.length > 0 && onToggleReaction && (
        <MessageReactions
          reactions={reactions}
          currentUserId={currentUserId}
          onToggle={onToggleReaction}
        />
      )}
    </div>
  );
}
