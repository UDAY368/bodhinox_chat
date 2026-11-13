'use client';
import { BotPauseControl } from './bot-pause-control';
import {
  historyAfterNewestPage,
  isNearBottom,
  loadMessagePage,
  MESSAGE_PAGE_SIZE,
  type ThreadHistory,
} from '@/lib/inbox/message-history';
import {
  isTempMessage,
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
import { conversationChannel } from '@/components/inbox/channel-badge';
import { ReminderDialog } from './follow-up-bar';
import { ConsentChip, OptedOutBanner } from './consent';
import { avatarTone, initials } from '@/lib/ui/avatar-tone';
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
  PanelRight,
  Bell,
  StickyNote,
  RotateCcw,
  MoreHorizontal,
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
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
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
import { InstagramTemplatePicker, type InstagramTemplate } from './instagram-template-picker';
import { AiThreadBanner } from './ai-thread-banner';
import { AiSummaryPanel } from './ai-assist/ai-summary-panel';
import { useAssistAvailability } from './ai-assist/use-ai-assist';
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
const THREAD_BG_CLASSES = 'studio-thread bg-card';

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
  const tChannel = useTranslations('Inbox.channel');
  const tReminders = useTranslations('Inbox.reminders');
  const tSidebar = useTranslations('Inbox.sidebar');
  const [reminderOpen, setReminderOpen] = useState(false);
  const tSearch = useTranslations('InboxSearch');
  const [notesOpen, setNotesOpen] = useState(false);
  const [resolving, setResolving] = useState(false);
  const tTimer = useTranslations('Inbox.sessionTimer');
  // Which number this conversation is on (shown with 2+ numbers only).
  const { numbers: whatsappNumbers } = useWhatsAppNumbers();
  const sessionNow = useSessionClock();
  const tQuote = useTranslations('Inbox.replyQuote');

  const { user, canSendMessages } = useAuth();
  // AI assistant features this member can use (summaries, suggested replies).
  const assist = useAssistAvailability(canSendMessages);
  const { getPresence, getRow, now } = usePresence();
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState<ThreadHistory | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const historyRequestRef = useRef(0);
  const olderRequestRef = useRef(false);
  const prependScrollRef = useRef<{ height: number; top: number } | null>(null);
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Whether the agent is reading the end of the thread (new messages then
  // scroll into view) and which conversation the view was last positioned
  // for. Scrolled up into history, a resync or a new message keeps the place.
  const followBottomRef = useRef(true);
  const positionedForRef = useRef<string | null>(null);
  const lastShownIdRef = useRef<string | null>(null);
  // The conversation whose newest page is on screen; a fetch for the same
  // one is a silent resync (no spinner, no reset of the history cursor).
  const loadedForRef = useRef<string | null>(null);
  const shownIdsRef = useRef<Set<string>>(new Set());
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
    shownIdsRef.current = new Set(messages.map((m) => m.id));
  }, [messages]);

  // Leaving a conversation (or unmounting) invalidates its older-page load in
  // flight, so those messages can never be prepended to another thread.
  useEffect(
    () => () => {
      ++historyRequestRef.current;
      loadedForRef.current = null;
    },
    [conversationId]
  );

  useEffect(() => {
    if (!conversationId) return;

    const db = createClient();
    let cancelled = false;
    // A resync of the thread on screen refreshes it in place: an older-page
    // load in flight stays valid and the spinner never replaces the thread.
    const silent = loadedForRef.current === conversationId;
    if (!silent) {
      loadedForRef.current = null;
      ++historyRequestRef.current;
      olderRequestRef.current = false;
      setLoadingOlder(false);
    }

    (async () => {
      if (!silent) setLoading(true);

      try {
        const { data, error } = await loadMessagePage(db, conversationId);

        if (cancelled) return;

        if (error) {
          console.error('Failed to fetch messages:', error);
        } else {
          const page = data ?? [];
          onMessagesLoadedRef.current(page, conversationId);
          setHistory((previous) =>
            historyAfterNewestPage(
              silent ? previous : null,
              conversationId,
              page,
              shownIdsRef.current
            )
          );
          loadedForRef.current = conversationId;
        }
      } catch (error) {
        if (!cancelled) console.error('Failed to fetch messages:', error);
      } finally {
        if (!cancelled && !silent) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
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

  // Keep the view in place when messages change: an older page keeps the
  // message the agent was reading still; a newly opened thread, or one the
  // agent is reading at the end, scrolls to the newest message. A resync
  // while the agent reads history leaves the scroll position alone.
  useEffect(() => {
    if (scrollRef.current) {
      const el = scrollRef.current;
      const anchor = prependScrollRef.current;
      const opened = positionedForRef.current !== conversationId;
      // The agent's own just-sent message always comes into view.
      const last = messages[messages.length - 1];
      const ownSend = !!last && isTempMessage(last) && last.id !== lastShownIdRef.current;
      if (anchor) el.scrollTop = anchor.top + el.scrollHeight - anchor.height;
      else if (opened || ownSend || followBottomRef.current) el.scrollTop = el.scrollHeight;
      lastShownIdRef.current = last?.id ?? null;
      prependScrollRef.current = null;
      if (opened && messages.length > 0) {
        positionedForRef.current = conversationId ?? null;
        followBottomRef.current = true;
      }
    }
  }, [messages, conversationId]);

  const handleSend = useCallback(
    async (text: string, replyToId?: string, aiSuggestionId?: string) => {
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
            // Recorded after the send (accepted or edited); never changes it.
            ...(aiSuggestionId ? { ai_suggestion_id: aiSuggestionId } : {}),
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

  // WhatsApp opens Meta-approved templates; Instagram (which has none) opens the
  // workspace's saved card and button messages.
  const [igTemplatesOpen, setIgTemplatesOpen] = useState(false);
  const handleOpenTemplates = useCallback(() => {
    if (isInstagram) setIgTemplatesOpen(true);
    else setTemplateModalOpen(true);
  }, [isInstagram]);

  const handleSendIgTemplate = useCallback(
    async (template: InstagramTemplate) => {
      if (!conversation) return;
      const tempId = newTempMessageId();
      const cards = 'cards' in template.payload ? template.payload.cards : null;
      const optimistic: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: 'agent',
        content_type: 'interactive',
        content_text: cards ? cards[0]?.title : ('text' in template.payload ? template.payload.text : undefined),
        interactive_payload: (cards
          ? { kind: 'cards', cards, ig: { generic_template: true } }
          : { kind: 'buttons', body: (template.payload as { text: string }).text,
              buttons: (template.payload as { buttons: { type: string; title: string; url?: string }[] }).buttons.map((b) =>
                b.type === 'web_url' ? { url: b.url, title: b.title } : { id: b.title, title: b.title }),
              ig: { button_template: true } }) as unknown as Message['interactive_payload'],
        status: 'sending',
        created_at: new Date().toISOString(),
      };
      onNewMessage(optimistic);
      try {
        const res = await authFetch('/api/whatsapp/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversation_id: conversation.id, message_type: 'ig_template', template_id: template.id }),
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) {
          const reason = payload?.message || payload?.error || `HTTP ${res.status}`;
          toast.error(t('sendFailed', { reason }));
          // An outcome Meta left unclear is never shown as failed: check Instagram before resending.
          onUpdateMessage(tempId, uncertainSendUpdate(payload) ?? { status: 'failed' });
          return;
        }
        onUpdateMessage(tempId, confirmedSendUpdate(payload));
      } catch (err) {
        const reason = err instanceof Error ? err.message : t('networkError');
        toast.error(t('sendFailed', { reason }));
        onUpdateMessage(tempId, { status: 'failed' });
      }
    },
    [conversation, onNewMessage, onUpdateMessage, t]
  );

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
        <div className="studio-empty-icon bg-muted text-muted-foreground flex size-14 items-center justify-center rounded-2xl">
          <MessageSquare
            className="size-6"
            strokeWidth={1.25}
            aria-hidden="true"
          />
        </div>
        <h3 className="text-foreground mt-4 text-[15px] font-semibold">
          {t('selectConversation')}
        </h3>
        <p className="text-muted-foreground mt-1 max-w-72 text-[13px] leading-relaxed">
          {t('selectConversationHint')}
        </p>
      </div>
    );
  }

  const displayName = contact.name || contactHandle(contact);
  const messageGroups = groupMessagesByDate(messages);
  const memberNames = new Map(profiles.map((p) => [p.user_id, p.full_name?.trim() || '']));
  // Who sent an outgoing message: the member (by sender_id), automation, or the team when
  // the send predates sender attribution. Null for the customer's own messages.
  const senderLabel = (m: Message): string | null => {
    if (m.sender_type === 'bot') return t(m.ai_generated ? 'senderAi' : 'senderAutomation');
    if (m.sender_type !== 'agent') return null;
    if (!m.sender_id) return t('senderTeam');
    return memberNames.get(m.sender_id) || t('senderFormerMember');
  };
  // Instagram shows its Sent / Seen line under the newest message the business sent only.
  const lastOutgoingId = isInstagram
    ? [...messages].reverse().find((m) => m.sender_type === 'agent' || m.sender_type === 'bot')?.id
    : undefined;
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
    <div className={cn('flex min-w-0 flex-1 flex-col', THREAD_BG_CLASSES)} data-thread-channel={threadChannel}>
      {/* One-line header. The thread is a size container, so what shows depends on
          the room the thread actually has (the list and contact panel take their
          share), not on the window: the name and Resolve / assignee / ⋯ always fit;
          the handle row's extras appear as space allows. */}
      <div className="studio-thread-header border-border bg-card flex min-h-16 items-center gap-2 border-b px-2 py-2 @md:gap-3 @md:px-4">
        <div className="flex min-w-0 flex-1 items-center gap-2 @md:gap-3">
          {/* Back to the list — below lg, where the list and thread take turns. */}
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              aria-label={t('backToConversations')}
              className="text-muted-foreground hover:bg-muted hover:text-foreground flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors duration-150 lg:hidden"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
          )}
          {/* The contact: tapping it opens their details, like the panel button on the right.
              The heading stays outside the button so screen readers can still jump to it. */}
          <h2 className="sr-only">{displayName}</h2>
          <button
            type="button"
            data-thread-who
            aria-label={`${displayName}: ${contactPanelOpen ? t('hideContact') : t('showContact')}`}
            onClick={onToggleContactPanel}
            disabled={!onToggleContactPanel}
            aria-expanded={onToggleContactPanel ? contactPanelOpen : undefined}
            title={contactPanelOpen ? t('hideContact') : t('showContact')}
            className="hover:bg-muted/60 -my-1 flex min-w-0 shrink items-center gap-2.5 rounded-xl py-1 pr-2 pl-1 text-left transition-colors duration-150 disabled:pointer-events-none @md:gap-3"
          >
            <span
              aria-hidden
              className={cn(
                'relative flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold',
                avatarTone(displayName)
              )}
            >
              {initials(contact.name || displayName)}
            </span>
            <span className="min-w-0">
              <span className="text-foreground block truncate text-[15px] leading-5 font-semibold">
                {displayName}
              </span>
              <span className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs leading-4">
                <span
                  aria-hidden
                  className={cn(
                    'size-2 shrink-0 rounded-full',
                    isInstagram ? 'bg-gradient-to-tr from-amber-400 via-pink-500 to-violet-600' : 'bg-emerald-500'
                  )}
                />
                <span className="truncate">
                  {[tChannel(threadChannel), isInstagram ? null : contactHandle(contact), currentStatus ? t(`status${currentStatus.label}`) : null]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
            </span>
          </button>
          <div className="flex min-w-0 flex-1 items-center gap-1.5 self-end pb-0.5 text-xs">
              {!isInstagram && (
                <span className="hidden shrink-0 @2xl:inline-flex">
                  <ConversationNumberBadge conversation={conversation} numbers={whatsappNumbers} />
                </span>
              )}
              {!isInstagram && (
                <Badge
                  variant="outline"
                  className={cn(
                    'border-border hidden h-4 shrink-0 gap-1 px-1.5 text-[10px] @md:inline-flex',
                    sessionInfo.expired ? 'text-red-400' : 'text-primary'
                  )}
                >
                  <Clock className="h-3 w-3" />
                  {sessionInfo.remaining}
                </Badge>
              )}
              {/* WhatsApp consent: may templates and broadcasts reach this customer? */}
              {!isInstagram && <ConsentChip contact={contact} className="hidden @xl:inline-flex" />}
              <span className="hidden shrink-0 items-center gap-1.5 @3xl:flex">
                <LifecycleChip state={lifecycle} label={tLifecycle(lifecycle)} />
                {sla && <SlaBadge sla={sla} t={tList} tl={tLifecycle} />}
              </span>
              {!isInstagram && (
                <span className="hidden shrink-0 @3xl:inline-flex">
                  <AdReferralBadge conversationId={conversation.id} />
                </span>
              )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1 @md:gap-1.5">
          {/* Assignee: their initials, and their name once there is room; it never wraps. */}
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={assignLabel}
              title={assignLabel}
              data-assignee
              className={cn(
                'border-border hover:bg-muted data-popup-open:bg-muted inline-flex h-9 max-w-[11rem] items-center gap-1.5 rounded-full border pr-2.5 pl-1.5 text-[13px] font-semibold whitespace-nowrap transition-colors duration-150',
                assignedAgentId ? 'text-foreground' : 'text-muted-foreground'
              )}
            >
              <span
                className={cn(
                  'flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold',
                  assignedAgentId ? avatarTone(assignLabel) : 'bg-muted'
                )}
              >
                {assignedAgentId ? initials(assignLabel) : <UserPlus className="h-3.5 w-3.5" />}
              </span>
              <span className="hidden min-w-0 truncate @2xl:inline">{assignLabel}</span>
              <ChevronDown className="h-3 w-3 shrink-0" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="border-border bg-popover">
              {profiles.length === 0 ? (
                <DropdownMenuItem disabled className="text-muted-foreground text-sm">
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
                      className={cn('text-sm', isSelected ? 'text-primary' : 'text-popover-foreground')}
                    >
                      <PresenceDot
                        status={presence}
                        label={presenceLabel(presence, getRow(p.user_id)?.last_seen_at ?? null, now)}
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

          {canSendMessages && (
            <button
              type="button"
              onClick={() => void handleResolveToggle()}
              disabled={resolving}
              aria-label={isResolved ? t('reopen') : t('resolve')}
              title={isResolved ? t('reopen') : t('resolve')}
              className={cn(
                'inline-flex h-9 items-center justify-center gap-1.5 rounded-full px-2.5 text-[13px] font-semibold whitespace-nowrap transition-colors duration-150 disabled:opacity-60 @xl:px-3.5',
                isResolved
                  ? 'border-border text-muted-foreground hover:bg-muted border'
                  : 'bg-muted text-foreground hover:bg-muted/70'
              )}
            >
              {isResolved ? <RotateCcw className="h-4 w-4" /> : <Check className="h-4 w-4" strokeWidth={2.5} />}
              <span className="hidden @xl:inline">{isResolved ? t('reopen') : t('resolve')}</span>
            </button>
          )}

          {/* Remind me: a reminder or snooze for this chat. */}
          <button
            type="button"
            onClick={() => setReminderOpen(true)}
            disabled={!canSendMessages}
            aria-label={tReminders('add')}
            title={tReminders('add')}
            data-thread-remind
            className="text-muted-foreground hover:bg-muted hover:text-foreground inline-flex size-9 items-center justify-center rounded-lg transition-colors duration-150 disabled:opacity-40"
          >
            <Bell className="h-[18px] w-[18px]" />
          </button>

          {/* Contact details panel (on small screens tap the contact's name instead). */}
          {onToggleContactPanel && (
            <button
              type="button"
              onClick={onToggleContactPanel}
              aria-pressed={contactPanelOpen}
              aria-label={tSidebar('contactDetails')}
              title={contactPanelOpen ? t('hideContact') : t('showContact')}
              data-thread-panel
              className={cn(
                'hover:bg-muted hover:text-foreground hidden size-9 items-center justify-center rounded-lg transition-colors duration-150 @md:inline-flex',
                contactPanelOpen ? 'bg-muted text-foreground' : 'text-muted-foreground'
              )}
            >
              <PanelRight className="h-[18px] w-[18px]" />
            </button>
          )}

          {/* Everything else: status, internal notes, refresh. */}
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={t('moreActions')}
              title={t('moreActions')}
              data-thread-more
              className={cn(
                'hover:bg-muted hover:text-foreground inline-flex size-9 items-center justify-center rounded-lg transition-colors duration-150',
                notesOpen ? 'text-primary' : 'text-muted-foreground'
              )}
            >
              <MoreHorizontal className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="border-border bg-popover min-w-52">
              <DropdownMenuGroup>
                <DropdownMenuLabel className="text-muted-foreground text-xs">{t('status')}</DropdownMenuLabel>
                {STATUS_OPTIONS.map((opt) => (
                  <DropdownMenuItem
                    key={opt.value}
                    onClick={() => handleStatusChange(opt.value)}
                    className={cn('text-sm', opt.color)}
                  >
                    <span className="flex-1">{t(`status${opt.label}`)}</span>
                    {currentStatus?.value === opt.value && <Check className="ml-2 h-3 w-3" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
              <DropdownMenuSeparator className="bg-border" />
              <DropdownMenuItem onClick={() => setNotesOpen((open) => !open)} className="text-sm">
                <StickyNote className="mr-2 h-4 w-4" />
                {notesOpen ? t('hideNotes') : t('showNotes')}
              </DropdownMenuItem>
              {onRefresh && (
                <DropdownMenuItem onClick={handleRefreshClick} disabled={isRefreshing} className="text-sm">
                  <RefreshCw className={cn('mr-2 h-4 w-4', isRefreshing && 'animate-spin')} />
                  {t('refresh')}
                </DropdownMenuItem>
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
        onScroll={(e) => {
          followBottomRef.current = isNearBottom(e.currentTarget);
        }}
        className="studio-messages flex-1 overflow-y-auto px-3 py-5 @2xl:px-6"
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
                  className="text-primary hover:bg-muted mx-auto block rounded-full px-3 py-1.5 text-xs font-medium transition-colors duration-150 disabled:opacity-50"
                >
                  {t(loadingOlder ? 'loadingOlder' : 'loadOlder')}
                </button>
              )}
            {messageGroups.map((group) => (
              <div key={group.date}>
                {/* Date separator */}
                <div className="mt-2 mb-3 flex items-center justify-center">
                  <span className="studio-date text-muted-foreground text-xs font-medium">
                    {formatDateSeparator(group.date, t)}
                  </span>
                </div>
                {/* Messages */}
                <div className="space-y-2">
                  {group.messages.map((msg, index) => {
                    // Named once per run of messages from the same sender.
                    const label = senderLabel(msg);
                    const previous = index > 0 ? group.messages[index - 1] : null;
                    const showSender = label !== null && (!previous || senderLabel(previous) !== label);
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
                      {showSender && (
                        <p className="studio-sender text-muted-foreground mb-0.5 truncate pr-2 text-right text-[11px] font-medium" data-sender={msg.sender_id ?? msg.sender_type}>
                          {label}
                        </p>
                      )}
                      {isInstagram ? (
                        <MessageBubble
                          message={msg}
                          reply={reply}
                          onOpenMedia={handleMediaChange}
                          channel={threadChannel}
                          receipt={msg.id === lastOutgoingId}
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
      <AiThreadBanner
        conversationId={conversation.id}
        disabled={conversation.ai_autoreply_disabled ?? false}
        channel={conversation.channel}
        handoffSummary={conversation.ai_handoff_summary}
        assignedAgentId={assignedAgentId}
        currentUserId={user?.id}
        onChange={(patch) => {
          if ('assigned_agent_id' in patch) {
            onAssignChange(conversation.id, patch.assigned_agent_id ?? null);
          }
        }}
      />

      {/* AI summary for staff (only when the workspace turned it on). */}
      {canSendMessages && assist?.summary.ok && <AiSummaryPanel key={conversation.id} conversationId={conversation.id} />}

      {/* An opted-out customer: say what is still allowed before anyone types. */}
      {!isInstagram && <OptedOutBanner contact={contact} />}

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
        assistSuggest={canSendMessages && (assist?.suggest.ok ?? false)}
        toolbarExtra={
          <BotPauseControl
            key={`${conversation.id}:${conversation.updated_at}:${conversation.bot_paused}`}
            conversationId={conversation.id}
            paused={conversation.bot_paused ?? false}
          />
        }
      />
      </div>
      {notesOpen && (
        <aside
          aria-label={t('notes')}
          className="border-border bg-card w-full min-w-0 overflow-y-auto border-l p-4 sm:w-[300px] sm:shrink-0"
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
      {isInstagram && (
        <InstagramTemplatePicker
          open={igTemplatesOpen}
          onOpenChange={setIgTemplatesOpen}
          onSend={(template) => void handleSendIgTemplate(template)}
          canEdit={canSendMessages}
        />
      )}

      {/* Full-size viewer for the thread's images/videos. Renders nothing
          until a bubble opens it. */}
      <MediaLightbox
        items={mediaGallery}
        activeId={mediaMessageId}
        onActiveIdChange={handleMediaChange}
        contactLabel={contactDisplayName}
      />
      <ReminderDialog conversationId={conversation.id} open={reminderOpen} onOpenChange={setReminderOpen} />
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
