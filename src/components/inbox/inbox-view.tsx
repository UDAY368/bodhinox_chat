'use client';

// The inbox (Stage 1 channel separation): one channel's inbox at
// /whatsapp/inbox or /instagram/inbox, or every channel at /inbox (the All
// view, while both channels are enabled). A channel inbox loads only its
// channel's conversations; realtime stays one subscription, filtered here by
// channel. Each channel's connection banners show only in its own inbox.
import { Suspense, useState, useCallback, useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { createClient } from '@/lib/data/client';
import { ChannelStatusBanner } from '@/components/channels/channel-gate';
import { useWorkspaceChannels } from '@/hooks/use-workspace-channels';
import { channelSettingsPath } from '@/lib/channels/routes';
import {
  channelOfConversation,
  channelStatusBanners,
  conversationInboxPath,
  inboxPath,
  inScope,
  type InboxScope,
} from '@/lib/inbox/inbox-scope';
import {
  CONVERSATION_SELECT,
  mergeConversations,
  normalizeConversation,
} from '@/lib/inbox/conversations';
import {
  applyRealtimeInsert,
  applyMessageUpdate,
  mergeFetchedPage,
  prependOlderMessages,
} from '@/lib/inbox/optimistic-messages';
import { latestCustomerMessageAt } from '@/lib/inbox/session';
import type {
  Conversation,
  Message,
  Contact,
  ConversationStatus,
} from '@/types';
import { useRealtime } from '@/hooks/use-realtime';
import { ConversationList } from '@/components/inbox/conversation-list';
import { MessageThread } from '@/components/inbox/message-thread';
import { ContactSidebar } from '@/components/inbox/contact-sidebar';
import { conversationChannel } from '@/components/inbox/channel-badge';
import { authFetch } from '@/lib/auth/client';
import Link from 'next/link';
import { InboxSearch } from '@/components/inbox/search/inbox-search';
import {
  jumpRequestFor,
  type JumpRequest,
} from '@/components/inbox/search/search-request';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Camera, TextSearch, WifiOff } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

// Remembers the agent's show/hide choice for the desktop contact panel
// across reloads and sessions (device-scoped, like the theme prefs).
const CONTACT_PANEL_STORAGE_KEY = 'wacrm:inbox:contact-panel-open';

// `useSearchParams` (the `?c=<id>` deep link below) requires a Suspense
// boundary or the production build bails to CSR and errors out. Thin
// wrapper supplies it; the inner component holds all the inbox state.
export function InboxView({ channel }: { channel: InboxScope }) {
  return (
    <Suspense fallback={null}>
      <InboxViewInner key={channel} scope={channel} />
    </Suspense>
  );
}

function InboxViewInner({ scope }: { scope: InboxScope }) {
  const t = useTranslations('Inbox.page');
  const tChannel = useTranslations('Inbox.channel');
  const tSearch = useTranslations('InboxSearch');
  const router = useRouter();
  const searchParams = useSearchParams();
  const basePath = inboxPath(scope);
  const { data: workspaceChannels } = useWorkspaceChannels();
  const enabledChannels = workspaceChannels?.enabled;
  /**
   * `?c=<id>` deep-link support. Used when landing here from the
   * dashboard's recent-conversations list so the right thread opens
   * automatically instead of showing the empty center panel.
   */
  const deepLinkConvId = searchParams.get('c');

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversation, setActiveConversation] =
    useState<Conversation | null>(null);
  const [activeContact, setActiveContact] = useState<Contact | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [whatsappConnected, setWhatsappConnected] = useState<boolean | null>(
    null
  );
  // Phase 11: Instagram accounts needing attention. Empty while Instagram is
  // off (the status route answers {enabled:false} and never calls Meta).
  const [instagramAccounts, setInstagramAccounts] = useState<InstagramBannerAccount[]>([]);
  const [instagramHumanAgent, setInstagramHumanAgent] = useState(false);
  /**
   * Bumped whenever we want children (ConversationList, MessageThread)
   * to refetch from the DB — used as a safety net against missed
   * realtime events. Bumped on WS reconnect and on tab visibility →
   * visible. The initial mount fetches don't depend on this; they fire
   * once on conversationId-change as usual.
   */
  const [resyncToken, setResyncToken] = useState(0);

  /**
   * Whether the desktop contact sidebar (tags / deals / notes) is shown.
   * Defaults to `true` (the historical behaviour) and is restored from
   * localStorage after mount. We deliberately do NOT read localStorage in
   * the initializer: the server renders with `true`, so reading a stored
   * `false` synchronously would produce a hydration mismatch. The effect
   * below reconciles to the stored value right after mount instead.
   */
  const [contactPanelOpen, setContactPanelOpen] = useState(true);
  useEffect(() => {
    try {
      const stored = localStorage.getItem(CONTACT_PANEL_STORAGE_KEY);
      if (stored !== null) setContactPanelOpen(stored === 'true');
    } catch {
      // localStorage can throw in private-browsing / sandboxed contexts.
    }
  }, []);

  const handleToggleContactPanel = useCallback(() => {
    setContactPanelOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(CONTACT_PANEL_STORAGE_KEY, String(next));
      } catch {
        // Persistence is best-effort; ignore storage failures.
      }
      return next;
    });
  }, []);

  // Fire the deep-link auto-select exactly once per URL — subsequent
  // list refreshes (realtime, manual refetch) must not snap the user
  // back to the deep-linked conversation if they've already clicked
  // elsewhere.
  const autoSelectedForDeepLinkRef = useRef<string | null>(null);
  // Search-hit jump for the open thread (see handleOpenSearchResult).
  const [jumpRequest, setJumpRequest] = useState<JumpRequest | null>(null);
  const jumpNonceRef = useRef(0);

  // Tracks conversations whose hydrate fetch is currently in flight. The
  // conv-INSERT and the first-message-INSERT events both call into
  // hydrateConversation; the dedupe here keeps it at one refetch per
  // new conversation even when both events arrive within milliseconds.
  const hydratingConvIdsRef = useRef<Set<string>>(new Set());

  /**
   * Conversations of another channel seen by this channel inbox's realtime
   * subscription (it receives every channel's events). Remembered so their
   * messages are dropped without a refetch each time. Always empty in the All view.
   */
  const otherChannelConvIdsRef = useRef<Set<string>>(new Set());
  const belongsHere = useCallback(
    (conversation: { id: string; channel?: string | null }) => {
      if (inScope(scope, conversation)) return true;
      otherChannelConvIdsRef.current.add(conversation.id);
      return false;
    },
    [scope]
  );

  // The server page sends /inbox to the one enabled channel's inbox; this
  // covers a request it could not resolve (an access cookie refreshed later).
  // A ?c= link stays: the All view lists and opens that conversation.
  useEffect(() => {
    if (scope !== 'all' || deepLinkConvId || enabledChannels?.length !== 1) return;
    const query = searchParams.toString();
    router.replace(`${inboxPath(enabledChannels[0])}${query ? `?${query}` : ''}`, { scroll: false });
  }, [scope, deepLinkConvId, enabledChannels, router, searchParams]);

  /**
   * Synchronous mirror of the conversation ids currently in `conversations`
   * state. Event handlers need to know "do we already have this conv?"
   * without waiting for a setState updater to run — updaters fire during
   * reconciliation, *after* the synchronous handler code returns, so a
   * `let foundInList = false; setState(p => { foundInList = ...; return ... })`
   * flag reads as `false` in the same tick (this exact bug shipped in #105
   * and caused #106: every incoming message and every status flip fired a
   * redundant DB hydrate, swamping the db client and starving the
   * realtime channel). The ref is kept in sync via the effect below.
   */
  const knownConvIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const next = new Set<string>();
    for (const c of conversations) next.add(c.id);
    knownConvIdsRef.current = next;
  }, [conversations]);

  // Pull the conversation row with its `contact` joined and merge it
  // into state. Needed because Supabase Realtime payloads only carry the
  // row's own columns — a brand-new conversation arrives without a
  // contact, which surfaced as "Unknown" names, empty avatars, and
  // (when the conv-INSERT event was delayed past the message-INSERT)
  // conversations stuck on "No messages yet" until the user reloaded.
  // Also self-heals if a realtime event was missed: callers can invoke
  // this whenever they reference a conversation id they don't recognise.
  const hydrateConversation = useCallback(async (convId: string) => {
    if (hydratingConvIdsRef.current.has(convId) || otherChannelConvIdsRef.current.has(convId)) return;
    hydratingConvIdsRef.current.add(convId);
    try {
      const db = createClient();
      let query = db
        .from('conversations')
        .select(CONVERSATION_SELECT)
        .eq('id', convId);
      // A channel inbox never reads another channel's row (the column is NOT NULL).
      if (scope !== 'all') query = query.eq('channel', scope);
      const { data, error } = await query.maybeSingle();
      if (error) {
        // Supabase errors have non-enumerable properties — log fields
        // explicitly so the console message isn't just `{}`.
        console.error('Failed to hydrate conversation:', {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        return;
      }
      if (!data) {
        if (scope !== 'all') {
          // Not this channel's conversation: remember it, and drop the row a
          // realtime payload without its channel may have prepended.
          otherChannelConvIdsRef.current.add(convId);
          setConversations((prev) => prev.filter((c) => c.id !== convId));
        }
        return;
      }
      const fetched = normalizeConversation(data);
      if (!belongsHere(fetched)) {
        // Prepended from a realtime payload that did not name its channel.
        setConversations((prev) => prev.filter((c) => c.id !== fetched.id));
        return;
      }
      setConversations((prev) => {
        const existing = prev.find((c) => c.id === fetched.id);
        if (existing) {
          // Already in state — keep its fields (a realtime UPDATE may
          // have landed while the fetch was in flight and patched
          // last_message_text / unread_count to fresher values than
          // the row we just read). Only backfill `contact`, which the
          // realtime payloads never carry.
          return prev.map((c) =>
            c.id === fetched.id
              ? {
                  ...c,
                  contact: c.contact ?? fetched.contact,
                  last_reply_at: fetched.last_reply_at,
                  last_customer_message_at:
                    c.last_customer_message_at ??
                    fetched.last_customer_message_at,
                }
              : c
          );
        }
        return [fetched, ...prev];
      });
    } finally {
      hydratingConvIdsRef.current.delete(convId);
    }
  }, [belongsHere, scope]);

  // Check WhatsApp connection status on mount (the WhatsApp inbox's banner only).
  useEffect(() => {
    if (scope !== 'whatsapp') return;
    const checkConnection = async () => {
      const db = createClient();
      const {
        data: { session },
      } = await db.auth.getSession();
      const user = session?.user;

      if (!user) return;

      // whatsapp_config is one-row-per-account post-multi-user, so
      // the previous `.eq('user_id', user.id)` would miss the row
      // for any teammate who didn't personally save the config —
      // the "WhatsApp not connected" banner would show in the
      // shared inbox even though the admin had it configured.
      // Resolve account_id via the profile and query by that.
      const { data: profile } = await db
        .from('profiles')
        .select('account_id')
        .eq('user_id', user.id)
        .maybeSingle();
      const accountId = profile?.account_id as string | undefined;
      if (!accountId) {
        setWhatsappConnected(false);
        return;
      }

      // A workspace can connect several numbers; the banner shows only
      // when none of them is connected.
      const { data } = await db
        .from('whatsapp_config')
        .select('status')
        .eq('account_id', accountId);

      setWhatsappConnected(
        ((data ?? []) as { status?: string }[]).some((row) => row.status === 'connected')
      );
    };

    checkConnection();
  }, [scope]);

  // Instagram account state: the Instagram inbox's banners, and the HUMAN_AGENT
  // reply window for Instagram threads (which the WhatsApp inbox never opens).
  useEffect(() => {
    if (scope === 'whatsapp') return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await authFetch('/api/instagram/status');
        if (!res.ok) return;
        const body = (await res.json().catch(() => null)) as InstagramStatusBody | null;
        if (cancelled || !body?.enabled) return;
        if (Array.isArray(body.accounts)) setInstagramAccounts(body.accounts);
        setInstagramHumanAgent(body.humanAgentEnabled === true);
      } catch {
        // The banner is advisory; the inbox works without it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scope]);

  // Handle realtime message events
  const handleMessageEvent = useCallback(
    (event: { eventType: string; new: Message; old: Partial<Message> }) => {
      const newMsg = event.new;
      // A message of a conversation on another channel has no place in this inbox.
      if (otherChannelConvIdsRef.current.has(newMsg.conversation_id)) return;
      // Reply timestamps are computed by the tenant-scoped read model, not in realtime row payloads.
      if (newMsg.sender_type === 'agent' || newMsg.sender_type === 'bot') {
        void hydrateConversation(newMsg.conversation_id);
      }

      if (event.eventType === 'INSERT') {
        // Add to messages if it belongs to active conversation
        if (
          activeConversation &&
          newMsg.conversation_id === activeConversation.id
        ) {
          setMessages((prev) => applyRealtimeInsert(prev, newMsg));
        }

        // Update conversation list preview. We need to know *synchronously*
        // whether the conv is already in state to decide between patching
        // the preview and triggering a hydrate — see the comment on
        // knownConvIdsRef for why a closure flag inside the updater would
        // always read false here.
        if (knownConvIdsRef.current.has(newMsg.conversation_id)) {
          setConversations((prev) =>
            prev.map((c) =>
              c.id === newMsg.conversation_id
                ? {
                    ...c,
                    last_message_text: newMsg.content_text ?? '',
                    last_message_at: newMsg.created_at,
                    last_customer_message_at: latestCustomerMessageAt(
                      c.last_customer_message_at,
                      newMsg
                    ),
                    unread_count:
                      activeConversation?.id === newMsg.conversation_id
                        ? 0
                        : c.unread_count + 1,
                  }
                : c
            )
          );
        } else {
          // First time we're seeing this conv: the conv-INSERT event
          // hasn't landed yet, or was missed. Hydrate from the DB so
          // the row surfaces with its `contact` joined; the conv-UPDATE
          // event the webhook emits right after the message INSERT will
          // converge state when it arrives.
          hydrateConversation(newMsg.conversation_id);
        }
      }

      if (event.eventType === 'UPDATE') {
        // Update message status
        setMessages((prev) =>
          prev.map((m) => (m.id === newMsg.id ? { ...m, ...newMsg } : m))
        );
      }
    },
    [activeConversation, hydrateConversation]
  );

  // Handle realtime conversation events
  const handleConversationEvent = useCallback(
    (event: {
      eventType: string;
      new: Conversation;
      old: Partial<Conversation>;
    }) => {
      const conv = event.new;
      // Rows carry their channel (null is WhatsApp); another channel's
      // conversation is remembered and skipped. A payload without the field
      // is settled by the hydrate below, which reads the row.
      if (conv.channel !== undefined && !belongsHere(conv)) return;

      if (event.eventType === 'INSERT') {
        // Prepend immediately for snappy UX so the new conv shows in the
        // list right away, then hydrate to fill in the `contact` join
        // (realtime payloads never include joins). Skip both if we
        // already have the row — that shouldn't happen normally, but
        // out-of-order delivery would have us prepending a duplicate.
        if (!knownConvIdsRef.current.has(conv.id)) {
          setConversations((prev) => {
            if (prev.some((c) => c.id === conv.id)) return prev;
            return [conv, ...prev];
          });
          hydrateConversation(conv.id);
        }
      }

      if (event.eventType === 'UPDATE') {
        if (knownConvIdsRef.current.has(conv.id)) {
          // If this UPDATE is for the conv the user is currently viewing,
          // suppress the incoming unread_count — the user is reading it
          // RIGHT NOW, so any positive value would just flicker the badge
          // back on for the ~100ms it takes for the reset effect's server
          // UPDATE to round-trip. Non-active convs take the value as-is.
          const isActive = activeConversation?.id === conv.id;
          setConversations((prev) =>
            prev.map((c) =>
              c.id === conv.id
                ? {
                    ...c,
                    ...conv,
                    unread_count: isActive ? 0 : conv.unread_count,
                  }
                : c
            )
          );
        } else {
          // UPDATE arrived before the INSERT (or after a missed INSERT)
          // — fetch the row so it surfaces with its contact joined. The
          // patch contained in `conv` will already be reflected in what
          // the hydrate fetch returns.
          hydrateConversation(conv.id);
        }

        // Update active conversation if it changed
        if (activeConversation && conv.id === activeConversation.id) {
          setActiveConversation((prev) => (prev ? { ...prev, ...conv } : prev));
        }
      }
    },
    [activeConversation, hydrateConversation, belongsHere]
  );

  // Subscribe to realtime. The `isConnected` flag below feeds the
  // reconnect resync: realtime is best-effort and events sent while the
  // WS was disconnected (laptop sleep, network blip, background-tab
  // throttle) are simply lost. We need a way to catch up.
  const { isConnected } = useRealtime({
    channelName: 'inbox-realtime',
    onMessageEvent: handleMessageEvent,
    onConversationEvent: handleConversationEvent,
    onResync: () => setResyncToken((token) => token + 1),
    enabled: true,
  });

  /**
   * Bump `resyncToken` whenever the realtime channel transitions from
   * disconnected → connected *after* the initial connect. The initial
   * connect is covered by the children's on-mount fetches; only later
   * reconnects need a manual refetch to fill the gap.
   *
   * Tracked via a `was-connected` ref rather than a count so that React
   * strict-mode's dev-only effect double-fire doesn't read as a
   * reconnect.
   */
  const wasConnectedRef = useRef(false);
  const initialConnectDoneRef = useRef(false);
  useEffect(() => {
    if (isConnected && !wasConnectedRef.current) {
      // false → true transition
      if (initialConnectDoneRef.current) {
        setResyncToken((n) => n + 1);
      } else {
        initialConnectDoneRef.current = true;
      }
    }
    wasConnectedRef.current = isConnected;
  }, [isConnected]);

  /**
   * Refetch when the tab regains focus. Background tabs may have their
   * WS throttled by the browser even without a full disconnect, so a
   * visibilitychange → visible is a reliable signal that we may have
   * missed events. Cheap to fire; the children dedupe on their own.
   */
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        setResyncToken((n) => n + 1);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  /**
   * Manual refresh trigger for the thread-header refresh button.
   * Bumps the same resyncToken the reconnect / visibility paths use,
   * so it goes through the existing dedupe & refetch plumbing — no
   * separate code path to keep in sync.
   */
  const handleManualRefresh = useCallback(() => {
    setResyncToken((n) => n + 1);
  }, []);

  const resolveDeepLink = useCallback(
    (loaded: Conversation[]) => {
      // Resolve a pending deep-link here rather than in an effect — this
      // is an event handler, so the setState calls below are allowed by
      // react-hooks/set-state-in-effect. Runs once per ?c=<id> URL value
      // via the ref, so realtime refreshes of the list can't snap the
      // user back to the deep-linked thread after they've navigated.
      if (
        deepLinkConvId &&
        autoSelectedForDeepLinkRef.current !== deepLinkConvId &&
        loaded.length > 0
      ) {
        autoSelectedForDeepLinkRef.current = deepLinkConvId;
        // If the deep-linked conversation is already the active one
        // (e.g. because the user clicked it in the list and we
        // router.replace()'d the URL, which made the ConversationList
        // refetch and land us back here), do NOT re-apply it. Doing so
        // would setMessages([]) on a thread whose messages have
        // already been loaded by MessageThread — and because
        // conversationId didn't change, MessageThread wouldn't
        // refetch. The thread would read "No messages yet" until a
        // full page reload rehydrated state from scratch.
        if (activeConversation?.id === deepLinkConvId) return;
        const match = loaded.find((c) => c.id === deepLinkConvId);
        if (match) {
          setActiveConversation(match);
          setActiveContact(match.contact ?? null);
          setMessages([]);
          // Mirror the optimistic unread reset that handleSelectConversation
          // does — the user just deep-linked into this conv, treat that the
          // same as a click. Leaves activeConversation.unread_count alone so
          // the MessageThread reset effect still fires the server UPDATE.
          if (match.unread_count > 0) {
            setConversations((prev) =>
              prev.map((c) =>
                c.id === match.id ? { ...c, unread_count: 0 } : c
              )
            );
          }
        }
      }
    },
    [deepLinkConvId, activeConversation?.id]
  );

  const handleConversationsLoaded = useCallback(
    (loaded: Conversation[]) => {
      setConversations(loaded);
      resolveDeepLink(loaded);
    },
    [resolveDeepLink]
  );

  // A resync between full reloads: patch in only the conversations that
  // changed, so the list keeps its rows and the open thread is untouched.
  // A ?c=<id> link opened since the last sync (a notification click) is
  // resolved against the changed rows and the list already loaded.
  const handleConversationsChanged = useCallback(
    (changed: Conversation[]) => {
      setConversations((prev) => mergeConversations(prev, changed, activeConversation?.id));
      resolveDeepLink([...changed, ...conversations]);
    },
    [activeConversation?.id, conversations, resolveDeepLink]
  );

  const handleSelectConversation = useCallback(
    (conv: Conversation) => {
      // Re-clicking the already-active conversation would clear the
      // messages array, but the fetch effect in MessageThread only re-runs
      // when conversationId changes — so messages would stay empty until
      // the user navigated away and back. Bail out early instead.
      if (activeConversation?.id === conv.id) return;
      // A pending search jump belongs to the conversation it was made for.
      setJumpRequest(null);
      setActiveConversation(conv);
      setActiveContact(conv.contact ?? null);
      setMessages([]);
      // Optimistically clear the unread badge for this conv. The
      // server-side reset is fired by the unread-reset effect inside
      // MessageThread (which reads activeConversation.unread_count, not
      // the list copy — so we deliberately leave that intact below to
      // keep the effect firing), and the realtime UPDATE that comes
      // back will sync to 0 again as a no-op. Zeroing the list copy
      // here means the user sees the badge disappear the instant they
      // click instead of waiting for the round-trip — and it persists
      // even if the realtime UPDATE is dropped.
      setConversations((prev) =>
        prev.map((c) =>
          c.id === conv.id && c.unread_count > 0 ? { ...c, unread_count: 0 } : c
        )
      );
      // Record the selection on the deep-link ref BEFORE we change the
      // URL. The router.replace below flips `deepLinkConvId`, which can
      // in turn cause ConversationList to refetch and eventually call
      // handleConversationsLoaded again. Without this line, the ref
      // still points at the previous value, the auto-select block
      // sees `ref !== deepLinkConvId`, fires a second time, and
      // clobbers the messages MessageThread just fetched.
      autoSelectedForDeepLinkRef.current = conv.id;
      // Reflect the selection in the URL so a refresh lands the user
      // back in the same thread, and so copy-paste links work. Use
      // replace() to avoid polluting browser history with every click.
      const params = new URLSearchParams(searchParams.toString());
      params.set('c', conv.id);
      router.replace(`${basePath}?${params}`, { scroll: false });
    },
    [activeConversation?.id, router, searchParams, basePath]
  );

  // Mobile "back" — deselect the conversation so the list pane comes
  // back. Also clears the ?c= param so a refresh lands on the list
  // instead of re-opening the thread the user just backed out of.
  const handleCloseConversation = useCallback(() => {
    setJumpRequest(null);
    setActiveConversation(null);
    setActiveContact(null);
    setMessages([]);
    // Clearing the ref lets the deep-link auto-selector fire again if
    // the user later visits /inbox?c=<same-id> — desirable UX.
    autoSelectedForDeepLinkRef.current = null;
    const params = new URLSearchParams(searchParams.toString());
    params.delete('c');
    router.replace(`${basePath}${params.size ? `?${params}` : ''}`, {
      scroll: false,
    });
  }, [router, searchParams, basePath]);

  const handleMessagesLoaded = useCallback(
    (loaded: Message[], conversationId: string, older = false) => {
      setMessages((prev) =>
        older
          ? prependOlderMessages(prev, loaded)
          : mergeFetchedPage(prev, loaded, conversationId)
      );
    },
    []
  );

  const handleNewMessage = useCallback((msg: Message) => {
    setMessages((prev) => {
      if (prev.some((m) => m.id === msg.id)) return prev;
      return [...prev, msg];
    });
  }, []);

  const handleUpdateMessage = useCallback(
    (id: string, updates: Partial<Message>) => {
      setMessages((prev) => applyMessageUpdate(prev, id, updates));
    },
    []
  );

  const handleStatusChange = useCallback(
    (conversationId: string, status: ConversationStatus) => {
      setConversations((prev) =>
        prev.map((c) => (c.id === conversationId ? { ...c, status } : c))
      );
      if (activeConversation?.id === conversationId) {
        setActiveConversation((prev) => (prev ? { ...prev, status } : prev));
      }
    },
    [activeConversation]
  );

  const handleAssignChange = useCallback(
    (conversationId: string, assignedAgentId: string | null) => {
      setConversations((prev) =>
        prev.map((c) =>
          c.id === conversationId
            ? { ...c, assigned_agent_id: assignedAgentId ?? undefined }
            : c
        )
      );
      if (activeConversation?.id === conversationId) {
        setActiveConversation((prev) =>
          prev
            ? { ...prev, assigned_agent_id: assignedAgentId ?? undefined }
            : prev
        );
      }
    },
    [activeConversation]
  );

  // Message search: picking a hit opens its conversation (loading it when the
  // list doesn't hold it) and asks the thread to scroll to the message.
  const [searchOpen, setSearchOpen] = useState(false);
  const handleOpenSearchResult = useCallback(
    async (conversationId: string, messageId: string) => {
      setSearchOpen(false);
      let conv = conversations.find((c) => c.id === conversationId) ?? null;
      if (!conv) {
        const { data, error } = await createClient()
          .from('conversations')
          .select(CONVERSATION_SELECT)
          .eq('id', conversationId)
          .maybeSingle();
        if (error || !data) {
          toast.error(t('openConversationFailed'));
          return;
        }
        const fetched = normalizeConversation(data);
        if (!inScope(scope, fetched)) {
          // A hit in another channel's conversation opens it in that channel's inbox.
          router.push(conversationInboxPath(channelOfConversation(fetched), enabledChannels ?? [], fetched.id));
          return;
        }
        conv = fetched;
        setConversations((prev) =>
          prev.some((c) => c.id === fetched.id) ? prev : [fetched, ...prev]
        );
      }
      handleSelectConversation(conv);
      // Set after selecting (which clears any earlier request). The nonce
      // only ever grows, so picking the same hit again still re-jumps.
      jumpNonceRef.current += 1;
      setJumpRequest({ conversationId, messageId, nonce: jumpNonceRef.current });
    },
    [conversations, handleSelectConversation, t, scope, router, enabledChannels]
  );

  // On mobile (<lg) we show a SINGLE pane — either the list or the
  // thread — rather than cramming both side-by-side. Selecting a
  // conversation slides the thread in; the thread's back button pops
  // it back to the list. On lg+ both panes render side-by-side as
  // before, unchanged.
  const hasActiveConv = !!activeConversation;
  // Each channel's banners show only in its own inbox (the channel layout
  // leaves the slim channel banner to this page).
  const instagramBanners = scope === 'instagram' ? instagramBannerRows(instagramAccounts, conversations) : [];
  const statusBanners = channelStatusBanners(scope, workspaceChannels?.channels, {
    whatsappBannerShown: whatsappConnected === false,
    instagramBannersShown: instagramBanners.length > 0,
  });

  return (
    <div
      data-inbox-scope={scope}
      className="studio-inbox bg-background -m-4 flex h-[calc(100vh-3.5rem)] flex-col overflow-hidden sm:-m-6"
    >
      {statusBanners.map((state) => (
        <div key={state.channel} className="shrink-0 border-b border-amber-500/20 [&>div]:mb-0 [&>div]:rounded-none [&>div]:border-0">
          <ChannelStatusBanner state={state} />
        </div>
      ))}

      {/* WhatsApp connection banner — in the flex column, not absolute,
          so it pushes the panels down instead of overlapping them. */}
      {scope === 'whatsapp' && whatsappConnected === false && (
        <div className="flex shrink-0 items-center justify-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-4 py-2">
          <WifiOff className="h-4 w-4 text-amber-700 dark:text-amber-400" />
          <p className="text-xs text-amber-700 dark:text-amber-400">
            {t('whatsappNotConnected')}
          </p>
        </div>
      )}

      {instagramBanners.map((row) => (
        <div
          key={row.id}
          data-instagram-banner={row.kind}
          className="flex shrink-0 items-center justify-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-4 py-2"
        >
          <Camera className="h-4 w-4 text-amber-700 dark:text-amber-400" aria-hidden />
          <p className="text-xs text-amber-700 dark:text-amber-400">
            {tChannel(row.kind === 'disconnected' ? 'accountDisconnected' : 'reconnectNeeded')}
            {row.username ? ` (@${row.username})` : ''}
          </p>
          <Link
            href={channelSettingsPath('instagram')}
            className="text-xs font-medium text-amber-800 underline-offset-2 hover:underline dark:text-amber-300"
          >
            {tChannel('openSettings')}
          </Link>
        </div>
      ))}

      <div className="flex flex-1 overflow-hidden">
        {/* Left panel: Conversation list.
            Hidden on mobile when a conversation is selected so the
            thread can occupy the full width. Always visible on lg+. */}
        <div
          className={cn(
            'flex h-full flex-1 lg:flex-none',
            hasActiveConv ? 'hidden lg:flex' : 'flex'
          )}
        >
          <ConversationList
            activeConversationId={activeConversation?.id ?? null}
            onSelect={handleSelectConversation}
            conversations={conversations}
            onConversationsLoaded={handleConversationsLoaded}
            onConversationsChanged={handleConversationsChanged}
            resyncToken={resyncToken}
            channel={scope}
            headerAction={
              <button
                type="button"
                onClick={() => setSearchOpen(true)}
                aria-label={tSearch('placeholder')}
                title={tSearch('placeholder')}
                className="text-muted-foreground hover:bg-muted hover:text-foreground inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors"
              >
                <TextSearch className="h-4 w-4" />
              </button>
            }
          />
        </div>

        {/* Center panel: Message thread.
            Hidden on mobile when no conversation is selected so the
            list can occupy the full width. Always visible on lg+
            (shows its own empty-state if no thread is picked yet).

            `min-w-0` is load-bearing: without it, a single wide piece
            of content inside the thread (long quote preview, very
            long URL in a message body) forces the flex child past
            its share and pushes the contact-sidebar panel off-screen
            on the right. Issue #165. */}
        <div
          className={cn(
            'flex h-full min-w-0 flex-1 lg:flex',
            hasActiveConv ? 'flex' : 'hidden lg:flex'
          )}
        >
          <MessageThread
            conversation={activeConversation}
            contact={activeContact}
            messages={messages}
            onMessagesLoaded={handleMessagesLoaded}
            onNewMessage={handleNewMessage}
            onUpdateMessage={handleUpdateMessage}
            onStatusChange={handleStatusChange}
            onAssignChange={handleAssignChange}
            onBack={handleCloseConversation}
            resyncToken={resyncToken}
            onRefresh={handleManualRefresh}
            contactPanelOpen={contactPanelOpen}
            onToggleContactPanel={handleToggleContactPanel}
            jumpRequest={jumpRequestFor(jumpRequest, activeConversation?.id)}
            instagramHumanAgent={instagramHumanAgent}
          />
        </div>

        {/* Right panel: Contact sidebar — desktop only, and only when the
            agent hasn't collapsed it via the thread-header toggle (#258).
            On mobile it's always hidden (the `lg:block` below), so the
            toggle — which is itself desktop-only — never affects it. */}
        {contactPanelOpen && (
          <div className="hidden lg:block">
            <ContactSidebar
              key={activeContact?.id}
              contact={activeContact}
              conversationId={activeConversation?.id}
              channel={conversationChannel(activeConversation)}
              onCollapse={handleToggleContactPanel}
              refreshToken={`${resyncToken}:${messages.length}`}
              onUpdated={(updated) => {
                setActiveContact((previous) =>
                  previous?.id === updated.id ? updated : previous
                );
                setConversations((previous) =>
                  previous.map((item) =>
                    item.contact_id === updated.id
                      ? { ...item, contact: { ...item.contact, ...updated } }
                      : item
                  )
                );
              }}
            />
          </div>
        )}
      </div>

      <Dialog open={searchOpen} onOpenChange={setSearchOpen}>
        <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{tSearch('placeholder')}</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 flex-1">
            <InboxSearch
              onOpen={(conversationId, messageId) =>
                void handleOpenSearchResult(conversationId, messageId)
              }
            />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface InstagramBannerAccount {
  id: string;
  username: string | null;
  status: 'active' | 'token_invalid' | 'permission_missing' | 'disconnected';
  missingScopes?: { dm?: string[] };
}

interface InstagramBannerRow {
  id: string;
  username: string | null;
  kind: 'reconnect' | 'disconnected';
}

interface InstagramStatusBody {
  enabled?: boolean;
  humanAgentEnabled?: boolean;
  accounts?: InstagramBannerAccount[];
}

/**
 * One banner per Instagram account staff must act on: token invalid or DM
 * permission missing ("reconnect needed"), or disconnected while its
 * conversations are still listed (sends there are refused).
 */
function instagramBannerRows(
  accounts: InstagramBannerAccount[],
  conversations: Conversation[]
): InstagramBannerRow[] {
  if (accounts.length === 0) return [];
  const listed = new Set(
    conversations
      .filter((c) => conversationChannel(c) === 'instagram' && c.instagram_account_id)
      .map((c) => c.instagram_account_id as string)
  );
  return accounts.flatMap((account): InstagramBannerRow[] => {
    if (account.status === 'token_invalid' || (account.status === 'permission_missing' && (account.missingScopes?.dm?.length ?? 0) > 0))
      return [{ id: account.id, username: account.username, kind: 'reconnect' }];
    if (account.status === 'disconnected' && listed.has(account.id))
      return [{ id: account.id, username: account.username, kind: 'disconnected' }];
    return [];
  });
}
