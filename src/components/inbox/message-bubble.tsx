'use client';

import { templateMessageView } from '@/lib/whatsapp/template-message-view';
import { cn } from '@/lib/utils';
import type { Message, MessageReaction, MessageTemplate } from '@/types';
import {
  Clock,
  Check,
  CheckCheck,
  XCircle,
  MapPin,
  LayoutTemplate,
  CornerDownLeft,
  Sparkles,
} from 'lucide-react';
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
}: {
  status: Message['status'];
  /** Tooltip for the failed state — Meta's reason, when we have one. */
  title?: string | null;
}) {
  switch (status) {
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

function MessageContent({
  message,
  template,
  t,
  isAgent,
  onOpenMedia,
}: {
  message: Message;
  template?: MessageTemplate | null;
  t: ReturnType<typeof useTranslations>;
  /** Used to distinguish outbound template badges. */
  isAgent: boolean;
  onOpenMedia?: (messageId: string) => void;
}) {
  // Passed to the media bubbles as a no-arg callback; `undefined` when the
  // parent wired up no viewer, which is what makes them non-clickable.
  const openMedia = onOpenMedia ? () => onOpenMedia(message.id) : undefined;

  switch (message.content_type) {
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
            <span className="text-muted-foreground inline-flex items-center gap-1 text-[10px] font-medium tracking-wide uppercase">
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
}: MessageBubbleProps) {
  const t = useTranslations('Inbox.bubble');

  const isAgent =
    message.sender_type === 'agent' || message.sender_type === 'bot';
  const time = format(new Date(message.created_at), 'HH:mm');
  const failure = isAgent ? failureReason(message) : null;

  // Row alignment + width cap are owned by <MessageActions> so its hover
  // group matches the bubble's content area, not the full row.
  return (
    <div className={cn('flex flex-col', isAgent ? 'items-end' : 'items-start')}>
      <div
        className={cn(
          'studio-message relative rounded-lg px-3 py-2 leading-relaxed',
          isAgent
            ? 'studio-message-outgoing bg-primary-soft text-foreground rounded-tr-none'
            : 'border-border bg-card text-foreground rounded-bl-md border'
        )}
      >
        {reply && (
          <ReplyQuote authorLabel={reply.authorLabel} preview={reply.preview} />
        )}
        <MessageContent
          message={message}
          template={template}
          t={t}
          isAgent={isAgent}
          onOpenMedia={onOpenMedia}
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
              className="studio-message-badge bg-primary/10 text-primary inline-flex items-center gap-0.5 rounded-full px-1.5 py-px text-[9px] leading-none font-semibold tracking-wide uppercase"
              title={t('aiBadgeTitle')}
            >
              <Sparkles className="h-2.5 w-2.5" />
              {t('aiBadge')}
            </span>
          )}
          <span className="text-muted-foreground text-[10px]">{time}</span>
          {isAgent && <StatusIcon status={message.status} title={failure} />}
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
