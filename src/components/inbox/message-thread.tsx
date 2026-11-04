'use client';
import { BotPauseControl } from './bot-pause-control';
import {
  loadMessagePage,
  MESSAGE_PAGE_SIZE,
} from '@/lib/inbox/message-history';
import {
  newTempMessageId,
  confirmedSendUpdate,
} from '@/lib/inbox/optimistic-messages';
import {
  matchMessageTemplate,
  templateNamesInMessages,
} from '@/lib/whatsapp/template-message-view';
import { authFetch } from '@/lib/auth/client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { createClient } from '@/lib/data/client';
import { useAuth } from '@/hooks/use-auth';
import { usePresence } from '@/hooks/use-presence';
import { PresenceDot } from '@/components/presence/presence-dot';
import { presenceLabel } from '@/lib/presence';
import { cn } from '@/lib/utils';
import { ConversationNumberBadge } from '@/components/settings/numbers/conversation-number';
import { ChannelBadge, conversationChannel } from '@/components/inbox/channel-badge';
import { useWhatsAppNumbers } from '@/components/settings/numbers/use-whatsapp-numbers';
import type {
  Conversation,
  Message,
  MessageReaction,
  Contact,
  ConversationStatus,
  MessageTemplate,
  Profile,
  InteractiveMessagePayload,
} from '@/types';
import {
  MessageSquare,
  ChevronDown,
  UserPlus,
  Check,
  Clock,
  ArrowLeft,
  RefreshCw,
  PanelRightOpen,
  PanelRightClose,
  StickyNote,
  CheckCircle2,
  RotateCcw,
} from 'lucide-react';
import { NotesPanel } from './notes/notes-panel';
import {
  MESSAGE_ID_ATTRIBUTE,
  useJumpToMessage,
} from './search/use-jump-to-message';
import { LifecycleChip, SlaBadge } from './conversation-list';
import { firstResponseSla, lifecycleOf } from '@/lib/inbox/lifecycle-view';
import { format, isToday, isYesterday } from 'date-fns';
import { getSessionWindow, latestCustomerMessageAt } from '@/lib/inbox/session';
import { useSessionClock } from '@/hooks/use-session-clock';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MessageBubble } from './message-bubble';
import { MessageActions } from './message-actions';
import { MediaLightbox } from './media-lightbox';
import { collectMediaGallery } from '@/lib/media/gallery';
import {
  MessageComposer,
  CHAT_MEDIA_BUCKET,
  type SendMediaPayload,
} from './message-composer';
import { deleteAccountMedia } from '@/lib/storage/upload-media';
import { TemplatePicker, type TemplateSendValues } from './template-picker';
import { AiThreadBanner } from './ai-thread-banner';
import { AdReferralBadge } from './ad-referral-badge';
import { buildReplyPreview } from './reply-quote';
import { renderTemplateBody } from '@/lib/whatsapp/template-body';
import { contactHandle } from '@/lib/whatsapp/wa-identity';
import { toast } from 'sonner';

interface ReplyDraft {
  id: string;
  authorLabel: string;
  preview: string;
}

interface MessageThreadProps {
  conversation: Conversation | null;
  contact: Contact | null;
  messages: Message[];
  onMessagesLoaded: (
    messages: Message[],
    conversationId: string,
    older?: boolean
  ) => void;
  onNewMessage: (message: Message) => void;
  onUpdateMessage: (id: string, updates: Partial<Message>) => void;
  onStatusChange: (conversationId: string, status: ConversationStatus) => void;
  onAssignChange: (
    conversationId: string,
    assignedAgentId: string | null
  ) => void;
  /**
   * On mobile, the thread is shown full-screen with the conversation list
   * hidden. This callback lets the page deselect the active conversation
   * and reveal the list again. Rendered as a back-arrow in the header on
   * mobile only.
   */
  onBack?: () => void;
  /**
   * Increment to force the messages + reactions fetch effects to refire.
   * Parent bumps this on realtime reconnect / tab visibility → visible
   * so the open thread catches up on any events sent while the WS was
   * disconnected or the tab was throttled. Optional so existing callers
   * keep working.
   */
  resyncToken?: number;
  /**
   * Fired by the manual-refresh button in the thread header. The parent
   * typically bumps the same `resyncToken` it controls — this gives the
   * user a way to force a refetch when they suspect realtime missed an
   * event (or they're impatient). Optional so existing callers keep
   * working; the button is only rendered when this is provided.
   */
  onRefresh?: () => void;
  /**
   * Desktop-only contact-panel toggle. The page owns the open/closed
   * state (it's the one that renders the sidebar), so the thread just
   * reflects it and asks the page to flip it. Both optional so existing
   * callers keep working; the toggle button only renders when
   * `onToggleContactPanel` is wired up.
   */
  contactPanelOpen?: boolean;
  onToggleContactPanel?: () => void;
  /**
   * Scroll to and flash a message (from inbox search). A new `nonce` repeats
   * the jump for the same message. Older history pages load as needed.
   */
  jumpRequest?: { messageId: string; nonce: number } | null;
  /** Meta approved the Instagram Human Agent feature (from /api/instagram/status); banner only, the server re-checks. */
  instagramHumanAgent?: boolean;
}

function formatDateSeparator(
  dateStr: string,
  t: ReturnType<typeof useTranslations>
): string {
  const date = new Date(dateStr);
  if (isToday(date)) return t('today');
  if (isYesterday(date)) return t('yesterday');
  return format(date, 'MMMM d, yyyy');
}

function groupMessagesByDate(messages: Message[]) {
  const groups: { date: string; messages: Message[] }[] = [];
  let currentDate = '';

  for (const msg of messages) {
    const day = format(new Date(msg.created_at), 'yyyy-MM-dd');
    if (day !== currentDate) {
      currentDate = day;
      groups.push({ date: msg.created_at, messages: [msg] });
    } else {
      groups[groups.length - 1].messages.push(msg);
    }
  }

  return groups;
}

const STATUS_OPTIONS: {
  label: string;
  value: ConversationStatus;
  color: string;
}[] = [
  { label: 'Open', value: 'open', color: 'text-primary' },
  { label: 'Pending', value: 'pending', color: 'text-amber-400' },
  { label: 'Closed', value: 'closed', color: 'text-muted-foreground' },
];

// The empty and selected thread share the same quiet workspace surface.
const THREAD_BG_CLASSES = 'studio-thread bg-background';

export function MessageThread({
  conversation,
  contact,
  messages,
  onMessagesLoaded,
  onNewMessage,
  onUpdateMessage,
  onStatusChange,
  onAssignChange,
  onBack,
  resyncToken = 0,
  onRefresh,
  contactPanelOpen,
  onToggleContactPanel,
  jumpRequest = null,
  instagramHumanAgent = false,
}: MessageThreadProps) {
  const t = useTranslations('Inbox.messageThread');
  const tList = useTranslations('Inbox.conversationList');
  const tLifecycle = useTranslations('InboxLifecycle');
  const tSearch = useTranslations('InboxSearch');
  const [notesOpen, setNotesOpen] = useState(false);
  const [resolving, setResolving] = useState(false);
  const tTimer = useTranslations('Inbox.sessionTimer');
  // Which number this conversation is on (shown with 2+ numbers only).
  const { numbers: whatsappNumbers } = useWhatsAppNumbers();
  const sessionNow = useSessionClock();
  const tQuote = useTranslations('Inbox.replyQuote');

  const { user, canSendMessages } = useAuth();
  const { getPresence, getRow, now } = usePresence();
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState<{
    conversationId: string;
    before: Message | undefined;
    hasOlder: boolean;
  } | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const historyRequestRef = useRef(0);
  const olderRequestRef = useRef(false);
  const prependScrollRef = useRef<{ height: number; top: number } | null>(null);
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [reactions, setReactions] = useState<MessageReaction[]>([]);
  // Bumped by conversation_notes events (ids only); the notes panel re-reads on change.
  const [notesRevision, setNotesRevision] = useState(0);
  // Purely visual spin state for the manual-refresh button. The actual
  // refetch is fire-and-forget through `onRefresh` (which bumps the
  // parent's resyncToken); the 700ms spin is just feedback so the click
  // doesn't feel like a no-op. Cleared via the timer ref on unmount.
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (refreshTimerRef.current !== null) {
        clearTimeout(refreshTimerRef.current);
      }
    };
  }, []);
  const handleRefreshClick = useCallback(() => {
    if (isRefreshing || !onRefresh) return;
    setIsRefreshing(true);
    onRefresh();
    refreshTimerRef.current = setTimeout(() => {
      setIsRefreshing(false);
      refreshTimerRef.current = null;
    }, 700);
  }, [isRefreshing, onRefresh]);
  const [replyTo, setReplyTo] = useState<ReplyDraft | null>(null);
  // Which attachment the media viewer is showing. Lives here rather than in
  // the bubble so the viewer can page through every image/video in the
  // thread (issue #373). Paired with the conversation it belongs to and read
  // back through that check below, so switching threads closes the viewer
  // without an effect racing the messages refetch.
  const [openMedia, setOpenMedia] = useState<{
    conversationId: string;
    messageId: string;
  } | null>(null);

  // Profiles are bounded by RLS to rows the current user is allowed to
  // see — today that's just the current user, but the dropdown keeps the
  // shape ready for shared-team workspaces without a refactor.
  useEffect(() => {
    let cancelled = false;
    const db = createClient();
    db.from('profiles')
      .select('*')
      .order('full_name')
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error('Failed to fetch profiles:', error);
          return;
        }
        setProfiles((data as Profile[]) ?? []);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const threadChannel = conversationChannel(conversation);
  const isInstagram = threadChannel === 'instagram';
  const lastCustomerAt = useMemo(
    () =>
      messages.reduce(
        (latest, message) => latestCustomerMessageAt(latest, message),
        conversation?.last_customer_message_at ?? null
      ),
    [messages, conversation?.last_customer_message_at]
  );

  // 24-hour session timer
  const sessionInfo = useMemo(() => {
    if (!lastCustomerAt)
      return { expired: true, remaining: tTimer('noCustomerMessages') };
    const window = getSessionWindow(lastCustomerAt, sessionNow);
    if (!window.active) {
      return { expired: true, remaining: tTimer('expired') };
    }
    const remaining =
      window.remainingMs >= 3_600_000
        ? tTimer('xhRemaining', {
            hours: Math.ceil(window.remainingMs / 3_600_000),
          })
        : tTimer('xmRemaining', {
            minutes: Math.ceil(window.remainingMs / 60_000),
          });
    return { expired: false, remaining };
  }, [lastCustomerAt, sessionNow, tTimer]);

  // Store latest callback in a ref so fetchMessages doesn't need to
  // depend on `onMessagesLoaded` — otherwise parent re-renders cause
  // fetchMessages to change → useEffect re-fires → refetch → realtime
  // UPDATE on conversations.unread_count → parent re-renders → LOOP.
  // The ref is written inside an effect so the mutation doesn't happen
  // during render (React 19 refs rule); consumers only read `.current`
  // inside the async fetch completion, which runs after the render.
  const onMessagesLoadedRef = useRef(onMessagesLoaded);
  useEffect(() => {
    onMessagesLoadedRef.current = onMessagesLoaded;
  });

  const conversationId = conversation?.id;
  const hasUnread = (conversation?.unread_count ?? 0) > 0;

  const mediaMessageId =
    openMedia && openMedia.conversationId === conversationId
      ? openMedia.messageId
      : null;
  const handleMediaChange = useCallback(
    (messageId: string | null) => {
      setOpenMedia(
        messageId && conversationId ? { conversationId, messageId } : null
      );
    },
    [conversationId]
  );

  // Fetch messages whenever the selected conversation changes. Kept
  // separate from the unread-reset effect so that incoming messages
  // arriving while the thread is open don't trigger a full refetch —
  // they only flip hasUnread, which only the reset effect listens to.
  useEffect(() => {
    if (!conversationId) return;

    const db = createClient();
    let cancelled = false;
    const generation = ++historyRequestRef.current;
    olderRequestRef.current = false;
    setLoadingOlder(false);

    (async () => {
      setLoading(true);

      try {
        const { data, error } = await loadMessagePage(db, conversationId);

        if (cancelled) return;

        if (error) {
          console.error('Failed to fetch messages:', error);
        } else {
          onMessagesLoadedRef.current(data ?? [], conversationId);
          setHistory({
            conversationId,
            before: data?.[0],
            hasOlder: (data?.length ?? 0) === MESSAGE_PAGE_SIZE,
          });
        }
      } catch (error) {
        if (!cancelled) console.error('Failed to fetch messages:', error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      historyRequestRef.current = generation + 1;
    };
    // `resyncToken` is included so the parent can force a refetch when
    // the realtime channel reconnects or the tab regains focus —
    // realtime is best-effort and any message events sent while the WS
    // was disconnected or throttled are otherwise lost.
  }, [conversationId, resyncToken]);

  const loadOlder = async () => {
    if (
      !conversationId ||
      history?.conversationId !== conversationId ||
      !history.before ||
      !history.hasOlder ||
      olderRequestRef.current
    )
      return;
    olderRequestRef.current = true;
    setLoadingOlder(true);
    const generation = historyRequestRef.current;
    try {
      const { data, error } = await loadMessagePage(
        createClient(),
        conversationId,
        history.before
      );
      if (generation !== historyRequestRef.current) return;
      if (error) {
        toast.error(t('historyLoadFailed'));
        return;
      }
      if (scrollRef.current)
        prependScrollRef.current = {
          height: scrollRef.current.scrollHeight,
          top: scrollRef.current.scrollTop,
        };
      onMessagesLoadedRef.current(data ?? [], conversationId, true);
      setHistory({
        conversationId,
        before: data?.[0],
        hasOlder: (data?.length ?? 0) === MESSAGE_PAGE_SIZE,
      });
    } catch {
      if (generation === historyRequestRef.current)
        toast.error(t('historyLoadFailed'));
    } finally {
      if (generation === historyRequestRef.current) {
        olderRequestRef.current = false;
        setLoadingOlder(false);
      }
    }
  };

  const { jumpTo } = useJumpToMessage({
    scrollRef,
    messages,
    hasOlder:
      history?.conversationId === conversationId
        ? (history?.hasOlder ?? false)
        : false,
    loadOlder,
    loadingOlder,
    ready: !loading && history?.conversationId === conversationId,
    onNotFound: () => toast.error(tSearch('jumpNotFound')),
  });
  useEffect(() => {
    if (jumpRequest) jumpTo(jumpRequest.messageId);
    // Re-run per request (nonce), not when the hook identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpRequest?.nonce]);

  const templateNames = useMemo(
    () => templateNamesInMessages(messages).join(','),
    [messages]
  );
  useEffect(() => {
    let cancelled = false;
    if (!templateNames) return;
    createClient()
      .from('message_templates')
      .select<MessageTemplate>('*')
      .in('name', templateNames.split(','))
      .then(({ data }) => {
        if (!cancelled) setTemplates(data ?? []);
      });
    return () => {
      cancelled = true;
    };
  }, [templateNames, conversationId]);

  // Reactions fetch — pulls the current state from the DB. Kept separate
  // from the channel subscription below so a `resyncToken` bump just
  // refetches the rows without also tearing down and rebuilding the
  // realtime channel.
  useEffect(() => {
    if (!conversationId) {
      setReactions([]);
      return;
    }
    const db = createClient();
    let cancelled = false;

    (async () => {
      const { data, error } = await db
        .from('message_reactions')
        .select('*')
        .eq('conversation_id', conversationId);
      if (cancelled) return;
      if (error) {
        console.error('Failed to fetch reactions:', error);
        return;
      }
      setReactions((data as MessageReaction[]) ?? []);
    })();

    return () => {
      cancelled = true;
    };
  }, [conversationId, resyncToken]);

  // Reactions and notes realtime subscription per conversation. Subscribing
  // here (not at the page level) keeps the channel scoped to the visible
  // conversation and avoids cross-conversation chatter on a busy inbox. Notes
  // share this channel (one event stream) rather than opening their own: every
  // channel is an EventSource, and a browser allows only a few connections per
  // host, so another stream could stall the page's own requests.
  useEffect(() => {
    if (!conversationId) return;
    const db = createClient();

    const channel = db
      .channel(`reactions:${conversationId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'message_reactions',
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const row = payload.new as unknown as MessageReaction;
          setReactions((prev) => {
            if (prev.some((r) => r.id === row.id)) return prev;
            // Swap any matching optimistic temp row for the real one so
            // the pill doesn't double up after a successful POST.
            const tempIdx = prev.findIndex(
              (r) =>
                r.id.startsWith('temp-') &&
                r.message_id === row.message_id &&
                r.actor_type === row.actor_type &&
                r.actor_id === row.actor_id
            );
            if (tempIdx >= 0) {
              const copy = prev.slice();
              copy[tempIdx] = row;
              return copy;
            }
            return [...prev, row];
          });
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'message_reactions',
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const row = payload.new as unknown as MessageReaction;
          setReactions((prev) => prev.map((r) => (r.id === row.id ? row : r)));
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'DELETE',
          schema: 'public',
          table: 'message_reactions',
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const old = payload.old as Partial<MessageReaction>;
          if (!old?.id) return;
          setReactions((prev) => prev.filter((r) => r.id !== old.id));
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'conversation_notes',
          filter: `conversation_id=eq.${conversationId}`,
        },
        () => setNotesRevision((n) => n + 1)
      )
      .subscribe();

    return () => {
      db.removeChannel(channel);
    };
  }, [conversationId]);

  // Clear any in-progress reply draft when the active conversation changes —
  // a quote pulled from conversation A shouldn't bleed into conversation B.
  useEffect(() => {
    setReplyTo(null);
  }, [conversationId]);

  // Reset the server-side unread_count to 0 whenever an unread count
  // surfaces on the active conversation — covers both (a) opening a
  // conversation that had unread messages and (b) new messages arriving
  // while the user is already viewing the thread (webhook server-bumps
  // unread_count to N+1; the realtime UPDATE propagates it into the
  // client, which re-runs this effect and flips it back to 0).
  //
  // Guarding on hasUnread prevents the eq-update loop: once unread_count
  // is 0 the condition is false, so no further UPDATE is issued.
  useEffect(() => {
    if (!conversationId || !hasUnread || !canSendMessages) return;
    const db = createClient();
    db.rpc('mark_conversation_read', {
      p_conversation_id: conversationId,
    }).then(({ error }) => {
      if (error) console.error('Failed to reset unread_count:', error);
    });
  }, [conversationId, hasUnread, canSendMessages]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      const el = scrollRef.current;
      const anchor = prependScrollRef.current;
      el.scrollTop = anchor
        ? anchor.top + el.scrollHeight - anchor.height
        : el.scrollHeight;
      prependScrollRef.current = null;
    }
  }, [messages]);

  const handleSend = useCallback(
    async (text: string, replyToId?: string) => {
      if (!conversation) return;

      const tempId = newTempMessageId();

      // Optimistic update — shows the message immediately with "sending" status
      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: 'agent',
        content_type: 'text',
        content_text: text,
        status: 'sending',
        created_at: new Date().toISOString(),
        reply_to_message_id: replyToId,
      };
      onNewMessage(optimisticMsg);
      setReplyTo(null);

      try {
        const res = await authFetch('/api/whatsapp/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversation_id: conversation.id,
            message_type: 'text',
            content_text: text,
            reply_to_message_id: replyToId,
          }),
        });

        const payload = await res.json().catch(() => ({}));

        if (!res.ok) {
          const reason = payload?.message || payload?.error || `HTTP ${res.status}`;
          console.error('Failed to send message:', res.status);
          toast.error(t('sendFailed', { reason }));
          // Mark the optimistic bubble as failed so the user sees what happened.
          // An Instagram send whose outcome is unknown is never shown as failed:
          // it may have been delivered (check Instagram before resending).
          onUpdateMessage(tempId, uncertainSendUpdate(payload) ?? { status: 'failed' });
          return;
        }

        // Success — the realtime INSERT event will replace the temp bubble
        // with the real DB row. If realtime hasn't arrived yet, at least
        // flip status to 'sent' so the UI stops showing "sending".
        onUpdateMessage(tempId, confirmedSendUpdate(payload));
      } catch (err) {
        console.error('Failed to send message:', err);
        const reason = err instanceof Error ? err.message : t('networkError');
        toast.error(t('sendFailed', { reason }));
        onUpdateMessage(tempId, { status: 'failed' });
      }
    },
    [conversation, onNewMessage, onUpdateMessage, t]
  );

  const handleSendMedia = useCallback(
    async (payload: SendMediaPayload) => {
      if (!conversation) return;

      // Documents show their filename in our own bubble (and to the
      // recipient as the Meta caption when no caption was typed); other
      // kinds use the caption as-is. Audio carries no caption.
      const contentText =
        payload.kind === 'document'
          ? payload.caption || payload.filename || t('documentFallback')
          : payload.caption;

      const tempId = newTempMessageId();
      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: 'agent',
        content_type: payload.kind,
        content_text: contentText,
        media_url: payload.mediaUrl,
        status: 'sending',
        created_at: new Date().toISOString(),
        reply_to_message_id: payload.replyToId,
      };
      onNewMessage(optimisticMsg);
      setReplyTo(null);

      try {
        const res = await authFetch('/api/whatsapp/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversation_id: conversation.id,
            message_type: payload.kind,
            media_url: payload.mediaUrl,
            content_text: contentText,
            filename: payload.filename,
            reply_to_message_id: payload.replyToId,
          }),
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          const reason = data?.message || data?.error || `HTTP ${res.status}`;
          console.error('Failed to send media:', res.status);
          toast.error(t('sendFailed', { reason }));
          const uncertain = uncertainSendUpdate(data);
          onUpdateMessage(tempId, uncertain ?? { status: 'failed' });
          // An uncertain Instagram send may have delivered the file: keep it.
          if (uncertain) return;
          // The upload never reached the recipient — GC the orphaned
          // object rather than leaving it in the public bucket forever.
          if (payload.path)
            void deleteAccountMedia(CHAT_MEDIA_BUCKET, payload.path).catch(
              () => {}
            );
          return;
        }

        onUpdateMessage(tempId, confirmedSendUpdate(data));
      } catch (err) {
        console.error('Failed to send media:', err);
        const reason = err instanceof Error ? err.message : t('networkError');
        toast.error(t('sendFailed', { reason }));
        onUpdateMessage(tempId, { status: 'failed' });
        if (payload.path)
          void deleteAccountMedia(CHAT_MEDIA_BUCKET, payload.path).catch(
            () => {}
          );
      }
    },
    [conversation, onNewMessage, onUpdateMessage, t]
  );

  const handleSendInteractive = useCallback(
    async (payload: InteractiveMessagePayload, replyToId?: string) => {
      if (!conversation) return;

      const tempId = newTempMessageId();
      // Optimistic bubble — renders the buttons/list immediately via the
      // interactive_payload, same as the persisted row will.
      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: 'agent',
        content_type: 'interactive',
        content_text: payload.body,
        interactive_payload: payload,
        status: 'sending',
        created_at: new Date().toISOString(),
        reply_to_message_id: replyToId,
      };
      onNewMessage(optimisticMsg);

      try {
        const res = await authFetch('/api/whatsapp/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversation_id: conversation.id,
            message_type: 'interactive',
            interactive_payload: payload,
            reply_to_message_id: replyToId,
          }),
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          const reason = data?.error || `HTTP ${res.status}`;
          console.error('Failed to send interactive message:', reason);
          toast.error(t('sendFailed', { reason }));
          onUpdateMessage(tempId, { status: 'failed' });
          return;
        }

        onUpdateMessage(tempId, confirmedSendUpdate(data));
      } catch (err) {
        console.error('Failed to send interactive message:', err);
        const reason = err instanceof Error ? err.message : t('networkError');
        toast.error(t('sendFailed', { reason }));
        onUpdateMessage(tempId, { status: 'failed' });
      }
    },
    [conversation, onNewMessage, onUpdateMessage, t]
  );

  const handleStatusChange = useCallback(
    async (status: ConversationStatus) => {
      if (!conversation) return;

      const db = createClient();
      await db
        .from('conversations')
        .update({ status })
        .eq('id', conversation.id);

      onStatusChange(conversation.id, status);
    },
    [conversation, onStatusChange]
  );

  // Resolve / reopen. Writing `status` is enough: the conversation_lifecycle
  // trigger moves lifecycle_state (closed → resolved, reopen → requesting or
  // assigned) and stamps resolved_at / reopened_count.
  const handleResolveToggle = useCallback(async () => {
    if (!conversation || resolving) return;
    const next: ConversationStatus =
      conversation.status === 'closed' ? 'open' : 'closed';
    setResolving(true);
    try {
      const { error } = await createClient()
        .from('conversations')
        .update({ status: next })
        .eq('id', conversation.id);
      if (error) {
        toast.error(t('resolveFailed'));
        return;
      }
      onStatusChange(conversation.id, next);
    } finally {
      setResolving(false);
    }
  }, [conversation, resolving, onStatusChange, t]);

  const handleOpenTemplates = useCallback(() => {
    setTemplateModalOpen(true);
  }, []);

  const handleSendTemplate = useCallback(
    async (
      template: MessageTemplate,
      values: TemplateSendValues
    ) => {
      if (!conversation) return;

      const renderedBody = renderTemplateBody(template.body_text, values.body);
      const tempId = newTempMessageId();

      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: 'agent',
        content_type: 'template',
        content_text: renderedBody,
        template_name: template.name,
        status: 'sending',
        created_at: new Date().toISOString(),
      };
      onNewMessage(optimisticMsg);

      try {
        const res = await authFetch('/api/whatsapp/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversation_id: conversation.id,
            message_type: 'template',
            template_name: template.name,
            template_language: template.language,
            // Structured params drive the new send-builder path
            // (header media + URL button substitution). Body values
            // are mirrored under both shapes so the route can fall
            // back if the template row isn't found locally.
            // Location, offer end, one-time code and carousel card
            // values ride along with the picker's other values.
            template_message_params: values,
            template_params: values.body,
            content_text: renderedBody,
          }),
        });

        const payload = await res.json().catch(() => ({}));

        if (!res.ok) {
          const reason = payload?.error || `HTTP ${res.status}`;
          console.error('Failed to send template:', reason);
          toast.error(t('sendTemplateFailed', { reason }));
          onUpdateMessage(tempId, { status: 'failed' });
          return;
        }

        onUpdateMessage(tempId, confirmedSendUpdate(payload));
      } catch (err) {
        console.error('Failed to send template:', err);
        const reason = err instanceof Error ? err.message : t('networkError');
        toast.error(t('sendTemplateFailed', { reason }));
        onUpdateMessage(tempId, { status: 'failed' });
      }
    },
    [conversation, onNewMessage, onUpdateMessage, t]
  );

  // Build a quick id → Message map so reply quotes can be rendered without
  // an extra fetch — the thread already holds the full conversation.
  const messagesById = useMemo(() => {
    const map = new Map<string, Message>();
    for (const m of messages) map.set(m.id, m);
    return map;
  }, [messages]);

  // Images + videos in the thread, in order — the set the media viewer
  // pages through with ← / →.
  const mediaGallery = useMemo(() => collectMediaGallery(messages), [messages]);

  // Bucket reactions by their target message_id for O(1) per-bubble lookup.
  const reactionsByMessageId = useMemo(() => {
    const map = new Map<string, MessageReaction[]>();
    for (const r of reactions) {
      const bucket = map.get(r.message_id);
      if (bucket) bucket.push(r);
      else map.set(r.message_id, [r]);
    }
    return map;
  }, [reactions]);

  const contactDisplayName =
    contact?.name || (contact ? contactHandle(contact) : '') || t('customer');

  // Author label for a quoted message: "You" when we sent the parent,
  // contact name when the customer sent it.
  const authorLabelFor = useCallback(
    (m: Message): string => {
      const isAgentMsg = m.sender_type === 'agent' || m.sender_type === 'bot';
      return isAgentMsg ? t('you') : contactDisplayName;
    },
    [contactDisplayName, t]
  );

  const handleStartReply = useCallback(
    (msg: Message) => {
      setReplyTo({
        id: msg.id,
        authorLabel: authorLabelFor(msg),
        preview: buildReplyPreview(msg, tQuote),
      });
    },
    [authorLabelFor, tQuote]
  );

  // Single reaction-set primitive. emoji === "" removes; otherwise adds/swaps.
  // The "toggle" semantic (pill click) is computed at the call site where the
  // current reactions for the bubble are already in scope — keeps this
  // function dependency-free w.r.t. the reaction list.
  const postReaction = useCallback(
    async (messageId: string, emoji: string) => {
      if (!user?.id || !conversation) {
        console.warn('[reactions] missing user or conversation');
        return;
      }
      if (messageId.startsWith('temp-')) {
        toast.error(t('waitForSending'));
        return;
      }

      const convId = conversation.id;
      const userId = user.id;
      let snapshot: MessageReaction[] = [];

      // Functional updater — captures the freshest reactions list, never a
      // stale closure. Snapshot stored for rollback on POST failure.
      setReactions((prev) => {
        snapshot = prev;
        const own = prev.find(
          (r) =>
            r.message_id === messageId &&
            r.actor_type === 'agent' &&
            r.actor_id === userId
        );
        if (emoji === '') return own ? prev.filter((r) => r !== own) : prev;
        if (own) return prev.map((r) => (r === own ? { ...own, emoji } : r));
        return [
          ...prev,
          {
            id: newTempMessageId(),
            message_id: messageId,
            conversation_id: convId,
            actor_type: 'agent',
            actor_id: userId,
            emoji,
            created_at: new Date().toISOString(),
          },
        ];
      });

      try {
        const res = await authFetch('/api/whatsapp/react', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message_id: messageId, emoji }),
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          throw new Error(payload?.error || `HTTP ${res.status}`);
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : t('networkError');
        toast.error(t('reactionFailed', { reason }));
        setReactions(snapshot);
      }
    },
    [conversation, user?.id, t]
  );

  const handleAssignChange = useCallback(
    async (agentId: string | null) => {
      if (!conversation) return;

      const db = createClient();
      const { error } = await db
        .from('conversations')
        .update({ assigned_agent_id: agentId })
        .eq('id', conversation.id);

      if (error) {
        console.error('Failed to update assignment:', error);
        toast.error(t('assignmentUpdateFailed'));
        return;
      }

      onAssignChange(conversation.id, agentId);
    },
    [conversation, onAssignChange, t]
  );

  // Keep the empty and selected thread surfaces consistent.
  if (!conversation || !contact) {
    return (
      <div
        className={cn(
          'studio-thread-empty flex flex-1 flex-col items-center justify-center px-6 text-center',
          THREAD_BG_CLASSES
        )}
      >
        <div className="studio-empty-icon flex h-28 w-28 items-center justify-center rounded-full">
          <MessageSquare
            className="h-14 w-14"
            strokeWidth={1.25}
            aria-hidden="true"
          />
        </div>
        <h3 className="text-foreground mt-6 text-xl font-medium">
          {t('selectConversation')}
        </h3>
        <p className="text-muted-foreground mt-2 max-w-72 text-sm leading-relaxed">
          {t('selectConversationHint')}
        </p>
      </div>
    );
  }

  const displayName = contact.name || contactHandle(contact);
  const messageGroups = groupMessagesByDate(messages);
  const currentStatus = STATUS_OPTIONS.find(
    (s) => s.value === conversation.status
  );
  const assignedAgentId = conversation.assigned_agent_id ?? null;
  const currentAssignee = profiles.find((p) => p.user_id === assignedAgentId);
  const assignLabel = assignedAgentId
    ? (currentAssignee?.full_name ?? t('assigned'))
    : t('assign');
  const lifecycle = lifecycleOf(conversation);
  const sla = firstResponseSla(conversation, sessionNow);
  const isResolved = conversation.status === 'closed';
  const noteMembers = profiles.map((p) => ({
    id: p.user_id,
    name: p.full_name || '',
  }));

  return (
    // `min-w-0` is load-bearing: the page already puts min-w-0 on the
    // thread's flex *wrapper* (issue #165), but this root keeps the
    // default `min-width: auto`, so a single wide message (long unbroken
    // URL/word) expands the whole thread past its flex share and the chat
    // paints on top of the contact sidebar at lg+ — outgoing bubbles get
    // clipped and the hover toolbar overlaps the Tags panel. Letting the
    // root shrink lets the bubbles' break-words / max-w caps apply.
    // Issue #257.
    <div className={cn('flex min-w-0 flex-1 flex-col', THREAD_BG_CLASSES)}>
      <div className="studio-thread-header border-border bg-card flex items-center justify-between gap-2 border-b px-3 py-3 sm:px-5">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          {/* Back-to-list button — mobile only. Hidden on lg+ where the
              conversation list is always visible next to the thread. */}
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              aria-label={t('backToConversations')}
              className="text-muted-foreground hover:bg-muted hover:text-foreground flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md lg:hidden"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
          )}
          <div className="bg-muted text-foreground flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-sm font-medium">
            {displayName.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0">
            <h2 className="text-foreground truncate text-sm font-semibold">
              {displayName}
            </h2>
            <p className="text-muted-foreground truncate text-xs">
              {contactHandle(contact)}
            </p>
            <div className="flex min-w-0 items-center gap-1.5">
              <ChannelBadge channel={threadChannel} />
              {!isInstagram && (
                <ConversationNumberBadge conversation={conversation} numbers={whatsappNumbers} />
              )}
            </div>
            {!isInstagram && <AdReferralBadge conversationId={conversation.id} />}
          </div>
          {/* Session timer badge — hidden on the narrowest phones so
              the name + back arrow keep their room. */}
          <Badge
            variant="outline"
            className={cn(
              'border-border ml-1 hidden gap-1 text-[10px] sm:ml-2 sm:inline-flex',
              isInstagram && 'sm:hidden',
              sessionInfo.expired ? 'text-red-400' : 'text-primary'
            )}
          >
            <Clock className="h-3 w-3" />
            {sessionInfo.remaining}
          </Badge>
          <div className="hidden items-center gap-1.5 md:flex">
            <LifecycleChip state={lifecycle} label={tLifecycle(lifecycle)} />
            {sla && <SlaBadge sla={sla} t={tList} tl={tLifecycle} />}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Contact-panel toggle — desktop only. The contact sidebar
              eats a chunk of horizontal width that crowds the thread on
              smaller laptops; this lets agents reclaim it when they just
              want to read and reply. Hidden on mobile, where the sidebar
              never renders as a permanent panel anyway. Issue #258. */}
          {onToggleContactPanel && (
            <button
              type="button"
              onClick={onToggleContactPanel}
              aria-label={
                contactPanelOpen ? t('hideContactPanel') : t('showContactPanel')
              }
              title={contactPanelOpen ? t('hideContact') : t('showContact')}
              aria-pressed={contactPanelOpen}
              className={cn(
                'hover:bg-muted hover:text-foreground hidden h-7 w-7 items-center justify-center rounded-md transition-colors lg:inline-flex',
                contactPanelOpen ? 'text-primary' : 'text-muted-foreground'
              )}
            >
              {contactPanelOpen ? (
                <PanelRightClose className="h-4 w-4" />
              ) : (
                <PanelRightOpen className="h-4 w-4" />
              )}
            </button>
          )}

          {/* Manual refresh — forces a refetch of the messages + the
              conversation list (the parent bumps its resyncToken). Useful
              when realtime missed an event or the agent just wants to be
              sure nothing's stale. Only rendered when the parent wires
              up `onRefresh`. */}
          {onRefresh && (
            <button
              type="button"
              onClick={handleRefreshClick}
              disabled={isRefreshing}
              aria-label={t('refreshConversation')}
              title={t('refresh')}
              className={cn(
                'text-muted-foreground hover:bg-muted hover:text-foreground inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors disabled:opacity-60'
              )}
            >
              <RefreshCw
                className={cn('h-3.5 w-3.5', isRefreshing && 'animate-spin')}
              />
            </button>
          )}

          {/* Internal notes — never sent to the customer. */}
          <button
            type="button"
            onClick={() => setNotesOpen((open) => !open)}
            aria-pressed={notesOpen}
            aria-label={notesOpen ? t('hideNotes') : t('showNotes')}
            title={notesOpen ? t('hideNotes') : t('showNotes')}
            className={cn(
              'hover:bg-muted hover:text-foreground inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-xs transition-colors',
              notesOpen ? 'text-primary' : 'text-muted-foreground'
            )}
          >
            <StickyNote className="h-3.5 w-3.5" />
            <span className="hidden xl:inline">{t('notes')}</span>
          </button>

          {canSendMessages && (
            <button
              type="button"
              onClick={() => void handleResolveToggle()}
              disabled={resolving}
              className={cn(
                'hover:bg-muted inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-xs transition-colors disabled:opacity-60',
                isResolved ? 'text-muted-foreground' : 'text-primary'
              )}
            >
              {isResolved ? (
                <RotateCcw className="h-3.5 w-3.5" />
              ) : (
                <CheckCircle2 className="h-3.5 w-3.5" />
              )}
              <span className="hidden sm:inline">
                {isResolved ? t('reopen') : t('resolve')}
              </span>
            </button>
          )}

          {/* Status dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger
              className={cn(
                'hover:bg-muted inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-xs',
                currentStatus?.color ?? 'text-muted-foreground'
              )}
            >
              {currentStatus ? t(`status${currentStatus.label}`) : t('status')}
              <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="border-border bg-popover"
            >
              {STATUS_OPTIONS.map((opt) => (
                <DropdownMenuItem
                  key={opt.value}
                  onClick={() => handleStatusChange(opt.value)}
                  className={cn('text-sm', opt.color)}
                >
                  {t(`status${opt.label}`)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Assign dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger
              className={cn(
                'hover:bg-muted inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-xs',
                assignedAgentId ? 'text-primary' : 'text-muted-foreground'
              )}
            >
              <UserPlus className="h-3 w-3" />
              <span className="hidden sm:inline">{assignLabel}</span>
              <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="border-border bg-popover"
            >
              {profiles.length === 0 ? (
                <DropdownMenuItem
                  disabled
                  className="text-muted-foreground text-sm"
                >
                  {t('noTeammates')}
                </DropdownMenuItem>
              ) : (
                profiles.map((p) => {
                  const isSelected = p.user_id === assignedAgentId;
                  const presence = getPresence(p.user_id);
                  return (
                    <DropdownMenuItem
                      key={p.id}
                      onClick={() => handleAssignChange(p.user_id)}
                      className={cn(
                        'text-sm',
                        isSelected ? 'text-primary' : 'text-popover-foreground'
                      )}
                    >
                      <PresenceDot
                        status={presence}
                        label={presenceLabel(
                          presence,
                          getRow(p.user_id)?.last_seen_at ?? null,
                          now
                        )}
                        className="mr-2"
                      />
                      <span className="flex-1">
                        {p.full_name}
                        {p.user_id === user?.id ? t('me') : ''}
                      </span>
                      {isSelected && <Check className="ml-2 h-3 w-3" />}
                    </DropdownMenuItem>
                  );
                })
              )}
              {assignedAgentId && (
                <>
                  <DropdownMenuSeparator className="bg-border" />
                  <DropdownMenuItem
                    onClick={() => handleAssignChange(null)}
                    className="text-muted-foreground text-sm"
                  >
                    {t('unassign')}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
      <div
        className={cn(
          'min-w-0 flex-1 flex-col',
          notesOpen ? 'hidden sm:flex' : 'flex'
        )}
      >
      {/* Messages Area */}
      <div
        ref={scrollRef}
        className="studio-messages flex-1 overflow-y-auto px-4 py-6 sm:px-6"
      >
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="border-primary h-5 w-5 animate-spin rounded-full border-2 border-t-transparent" />
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12">
            <p className="text-muted-foreground text-sm">
              {t('noMessagesYet')}
            </p>
            <p className="text-muted-foreground text-xs">
              {t('sendTemplateHint')}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {history?.conversationId === conversationId &&
              history?.hasOlder && (
                <button
                  type="button"
                  onClick={() => void loadOlder()}
                  disabled={loadingOlder}
                  className="text-primary hover:bg-muted mx-auto block rounded-md px-3 py-2 text-xs disabled:opacity-50"
                >
                  {t(loadingOlder ? 'loadingOlder' : 'loadOlder')}
                </button>
              )}
            {messageGroups.map((group) => (
              <div key={group.date}>
                {/* Date separator */}
                <div className="mb-4 flex items-center justify-center">
                  <span className="bg-muted text-muted-foreground rounded-full px-3 py-1 text-[10px] font-medium">
                    {formatDateSeparator(group.date, t)}
                  </span>
                </div>
                {/* Messages */}
                <div className="space-y-2">
                  {group.messages.map((msg) => {
                    const parent = msg.reply_to_message_id
                      ? messagesById.get(msg.reply_to_message_id)
                      : null;
                    const reply = parent
                      ? {
                          authorLabel:
                            parent.sender_type === 'agent' ||
                            parent.sender_type === 'bot'
                              ? t('me')
                              : contact?.name || contact?.phone || t('unknown'),
                          preview: buildReplyPreview(parent, tQuote),
                        }
                      : null;
                    const msgReactions = reactionsByMessageId.get(msg.id);
                    // Toggle is computed at the call site — `msgReactions`
                    // and `user?.id` are already in scope, no extra hook.
                    const handlePillToggle = (emoji: string) => {
                      const own = msgReactions?.find(
                        (r) =>
                          r.actor_type === 'agent' && r.actor_id === user?.id
                      );
                      const next = own?.emoji === emoji ? '' : emoji;
                      void postReaction(msg.id, next);
                    };
                    return (
                      <div
                        key={msg.id}
                        {...{ [MESSAGE_ID_ATTRIBUTE]: msg.id }}
                      >
                      {isInstagram ? (
                        <MessageBubble
                          message={msg}
                          reply={reply}
                          onOpenMedia={handleMediaChange}
                          channel={threadChannel}
                        />
                      ) : (
                      <MessageActions
                        message={msg}
                        onReply={() => handleStartReply(msg)}
                        onReact={(emoji) => {
                          if (emoji) void postReaction(msg.id, emoji);
                        }}
                      >
                        <MessageBubble
                          message={msg}
                          template={matchMessageTemplate(msg, templates)}
                          reply={reply}
                          reactions={msgReactions}
                          currentUserId={user?.id}
                          onToggleReaction={handlePillToggle}
                          onOpenMedia={handleMediaChange}
                        />
                      </MessageActions>
                      )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* AI auto-reply banner — take over an active bot, or resume it
          after a handoff. Renders nothing unless the account has
          auto-reply configured. */}
      <BotPauseControl
        key={`${conversation.id}:${conversation.updated_at}:${conversation.bot_paused}`}
        conversationId={conversation.id}
        paused={conversation.bot_paused ?? false}
      />
      <AiThreadBanner
        conversationId={conversation.id}
        disabled={conversation.ai_autoreply_disabled ?? false}
        handoffSummary={conversation.ai_handoff_summary}
        assignedAgentId={assignedAgentId}
        currentUserId={user?.id}
        onChange={(patch) => {
          if ('assigned_agent_id' in patch) {
            onAssignChange(conversation.id, patch.assigned_agent_id ?? null);
          }
        }}
      />

      {/* Composer */}
      <MessageComposer
        conversationId={conversation.id}
        sessionExpired={sessionInfo.expired}
        onSend={handleSend}
        onSendMedia={handleSendMedia}
        onSendInteractive={handleSendInteractive}
        onOpenTemplates={handleOpenTemplates}
        replyTo={isInstagram ? null : replyTo}
        onClearReply={() => setReplyTo(null)}
        channel={threadChannel}
        lastCustomerAt={lastCustomerAt}
        now={sessionNow}
        humanAgentEnabled={instagramHumanAgent}
      />
      </div>
      {notesOpen && (
        <aside
          aria-label={t('notes')}
          className="border-border bg-card w-full min-w-0 overflow-y-auto border-l p-4 sm:w-80 sm:shrink-0"
        >
          <NotesPanel
            key={conversation.id}
            conversationId={conversation.id}
            canWrite={canSendMessages}
            members={noteMembers}
            revision={notesRevision}
          />
        </aside>
      )}
      </div>

      <TemplatePicker
        open={templateModalOpen}
        onOpenChange={setTemplateModalOpen}
        onSelect={handleSendTemplate}
      />

      {/* Full-size viewer for the thread's images/videos. Renders nothing
          until a bubble opens it. */}
      <MediaLightbox
        items={mediaGallery}
        activeId={mediaMessageId}
        onActiveIdChange={handleMediaChange}
        contactLabel={contactDisplayName}
      />
    </div>
  );
}

/**
 * An Instagram send whose provider outcome is uncertain (409
 * delivery_uncertain): the bubble becomes the stored 'unknown' row, never
 * 'failed', so nobody resends blindly. Null for every other error.
 */
function uncertainSendUpdate(response: unknown): Partial<Message> | null {
  const body = response as { error?: unknown; message_id?: unknown } | null;
  if (body?.error !== 'delivery_uncertain') return null;
  return typeof body.message_id === 'string' && body.message_id
    ? { status: 'unknown', id: body.message_id }
    : { status: 'unknown' };
}
