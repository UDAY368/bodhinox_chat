'use client';

// The inbox (Stage 1 channel separation): one channel's inbox at
// /whatsapp/inbox or /instagram/inbox, or every channel at /inbox (the All
// view, while both channels are enabled). A channel inbox loads only its
// channel's conversations; realtime stays one subscription, filtered here by
// channel. Each channel's connection banners show only in its own inbox.
import { Suspense, useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useMatchMedia } from '@/hooks/use-match-media';
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
  normalizeConversation,
  upsertListRows,
  type ListOrder,
} from '@/lib/inbox/conversations';
import { fetchListMatches } from '@/components/inbox/inbox-list-api';
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
import { ConversationList, type RowAction } from '@/components/inbox/conversation-list';
import { NewMessageDialog } from '@/components/inbox/new-message-dialog';
import { useAuth } from '@/hooks/use-auth';
import { MessageThread } from '@/components/inbox/message-thread';
import { ContactSidebar } from '@/components/inbox/contact-sidebar';
import { conversationChannel } from '@/components/inbox/channel-badge';
import { authFetch } from '@/lib/auth/client';
import Link from 'next/link';
import { InboxSearch } from '@/components/inbox/search/inbox-search';
import { useInboxFolders } from '@/components/inbox/use-inbox-folders';
import { parseInboxFilter } from '@/lib/inbox/inbox-filters';
import { panelReloadFor, type PanelChange } from '@/lib/inbox/panel-reload';
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
  const tThread = useTranslations('Inbox.messageThread');
  const tSidebar = useTranslations('Inbox.sidebar');
  const tChannel = useTranslations('Inbox.channel');
  const tSearch = useTranslations('InboxSearch');
  const tRow = useTranslations('Inbox.rowMenu');
  const { user, canSendMessages } = useAuth();
  const [newMessageOpen, setNewMessageOpen] = useState(false);
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

  /**
   * Below 1366px the three columns do not fit (the thread was crushed to a
   * few words per line), so the contact panel becomes a slide-over over the
   * thread: closed until asked for, tied to the conversation it was opened
   * for (switching chats closes it), and never saved. From 1366px the 280px
   * panel sits beside the chat, keeping the saved side-panel preference above.
   */
  const widePanel = useMatchMedia('(min-width: 1366px)');
  const [overlayFor, setOverlayFor] = useState<string | null>(null);
  const activeConversationId = activeConversation?.id ?? null;
  const panelShown = widePanel ? contactPanelOpen : overlayFor !== null && overlayFor === activeConversationId;

  const handleToggleContactPanel = useCallback(() => {
    if (!widePanel) {
      setOverlayFor((open) => (open ? null : activeConversationId));
      return;
    }
    setContactPanelOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(CONTACT_PANEL_STORAGE_KEY, String(next));
      } catch {
        // Persistence is best-effort; ignore storage failures.
      }
      return next;
    });
  }, [widePanel, activeConversationId]);

  // Escape closes the slide-over.
  useEffect(() => {
    if (widePanel || !overlayFor) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOverlayFor(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [widePanel, overlayFor]);

  // The slide-over is modal: the list and thread behind it leave the focus order and the
  // accessibility tree, focus moves into the panel, and it returns to the toggle on close.
  const overlayRef = useRef<HTMLDivElement>(null);
  const overlayOpen = panelShown && !widePanel;
  useEffect(() => {
    const panel = overlayRef.current;
    if (!overlayOpen || !panel?.parentElement) return;
    const opener = document.activeElement as HTMLElement | null;
    const behind = [...panel.parentElement.children].filter(
      (el): el is HTMLElement => el !== panel && el instanceof HTMLElement && el.tagName !== 'BUTTON',
    );
    behind.forEach((el) => el.setAttribute('inert', ''));
    panel.focus();
    return () => {
      behind.forEach((el) => el.removeAttribute('inert'));
      if (opener?.isConnected) opener.focus();
    };
  }, [overlayOpen]);

  // Fire the deep-link auto-select exactly once per URL — subsequent
  // list refreshes (realtime, manual refetch) must not snap the user
  // back to the deep-linked conversation if they've already clicked
  // elsewhere.
  const autoSelectedForDeepLinkRef = useRef<string | null>(null);
  // Search-hit jump for the open thread (see handleOpenSearchResult).
  const [jumpRequest, setJumpRequest] = useState<JumpRequest | null>(null);
  const jumpNonceRef = useRef(0);


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

  /**
   * The list is filtered and paged by the server (GET /api/inbox/conversations).
   * Its current query, order and whether more pages remain, as the list reports
   * them, so a realtime event is checked against the same filter.
   */
  const listStateRef = useRef<{ params: string; order: ListOrder; hasMore: boolean }>({ params: '', order: 'recent', hasMore: false });
  const handleListState = useCallback((state: { params: string; order: ListOrder; hasMore: boolean }) => {
    listStateRef.current = state;
  }, []);
  const activeIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeIdRef.current = activeConversation?.id ?? null;
  });
  /** Whether the list has a view or narrowing (every row of an unfiltered list matches). */
  const listFiltered = () => {
    const params = new URLSearchParams(listStateRef.current.params);
    params.delete('scope');
    return params.size > 0;
  };

  // Conversations a realtime event named that must be checked against the
  // list's filter: one batched request (ids=) answers which match now, with
  // their row and contact (realtime payloads carry neither the contact nor the
  // computed reply times). A match is added or refreshed in place, a row that
  // no longer matches leaves the list; the rest of the list is not refetched.
  const pendingChecksRef = useRef<Set<string>>(new Set());
  const checkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushChecksRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    flushChecksRef.current = () => {
      checkTimerRef.current = null;
      const ids = [...pendingChecksRef.current].slice(0, 100);
      if (!ids.length) return;
      for (const id of ids) pendingChecksRef.current.delete(id);
      if (pendingChecksRef.current.size) checkTimerRef.current = setTimeout(() => flushChecksRef.current(), 300);
      const state = listStateRef.current;
      fetchListMatches(state.params, ids)
        .then((changes) => {
          // A new filter loads its own first page.
          if (listStateRef.current.params !== state.params) return;
          const current = listStateRef.current;
          setConversations((prev) => upsertListRows(prev, changes.conversations, {
            order: current.order,
            hasMore: current.hasMore,
            activeId: activeIdRef.current,
            removedIds: changes.removedIds,
          }));
        })
        .catch(() => {
          // The next resync catches up.
        });
    };
  });
  const hydrateConversation = useCallback((convId: string) => {
    if (otherChannelConvIdsRef.current.has(convId)) return;
    pendingChecksRef.current.add(convId);
    if (!checkTimerRef.current) checkTimerRef.current = setTimeout(() => flushChecksRef.current(), 300);
  }, []);
  useEffect(() => () => {
    if (checkTimerRef.current) clearTimeout(checkTimerRef.current);
  }, []);

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

  // Stage 5 folders (labels, favourites, the member's pending reminders and snoozes).
  const folderFilter = parseInboxFilter(searchParams.get('filter'));
  // The server applies the Failed folder itself, so its ids are not loaded here.
  const folders = useInboxFolders(scope, resyncToken);
  // The member's own pending snoozes: a snoozed conversation leaves their list until the time passes
  // (or they wake it) and comes back by itself. Personal; nobody else's list changes. The Reminders
  // folder lists snoozed conversations too.
  const [snoozeClock, setSnoozeClock] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setSnoozeClock(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  // A snooze that just ran out: the server left that conversation out of the
  // pages, so ask whether it matches now (it comes back in its place).
  const lastSnoozeTickRef = useRef(snoozeClock);
  useEffect(() => {
    const since = lastSnoozeTickRef.current;
    lastSnoozeTickRef.current = snoozeClock;
    for (const r of folders.reminders) {
      const at = Date.parse(r.remind_at);
      if (r.kind === 'snooze' && at > since && at <= snoozeClock) hydrateConversation(r.conversation_id);
    }
  }, [snoozeClock, folders.reminders, hydrateConversation]);
  const listedConversations = useMemo(() => {
    if (folderFilter === 'reminders') return conversations;
    const hidden = new Set(
      folders.reminders
        .filter((s) => s.kind === 'snooze' && Date.parse(s.remind_at) > snoozeClock)
        .map((s) => s.conversation_id)
    );
    // An open conversation stays visible even if it was just snoozed.
    return hidden.size === 0 ? conversations : conversations.filter((c) => !hidden.has(c.id) || c.id === activeConversation?.id);
  }, [folderFilter, folders.reminders, snoozeClock, conversations, activeConversation?.id]);

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
          // Patched in place, then moved to its place in the list order.
          setConversations((prev) => {
            const loaded = prev.find((c) => c.id === newMsg.conversation_id);
            if (!loaded) return prev;
            const patched = {
              ...loaded,
              last_message_text: newMsg.content_text ?? '',
              last_message_at: newMsg.created_at,
              last_customer_message_at: latestCustomerMessageAt(loaded.last_customer_message_at, newMsg),
              unread_count: activeConversation?.id === newMsg.conversation_id ? 0 : loaded.unread_count + 1,
            };
            return upsertListRows(prev, [patched], { order: listStateRef.current.order, hasMore: listStateRef.current.hasMore, activeId: activeConversation?.id });
          });
          // A view that depends on messages (unread, waiting, the 24-hour window) may no longer hold it.
          if (listFiltered()) hydrateConversation(newMsg.conversation_id);
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
        // A new conversation joins the list (in its place) once the server
        // says it matches the filter; the check also brings its contact.
        if (!knownConvIdsRef.current.has(conv.id)) hydrateConversation(conv.id);
      }

      if (event.eventType === 'UPDATE') {
        if (knownConvIdsRef.current.has(conv.id)) {
          // If this UPDATE is for the conv the user is currently viewing,
          // suppress the incoming unread_count — the user is reading it
          // RIGHT NOW, so any positive value would just flicker the badge
          // back on for the ~100ms it takes for the reset effect's server
          // UPDATE to round-trip. Non-active convs take the value as-is.
          const isActive = activeConversation?.id === conv.id;
          setConversations((prev) => {
            const loaded = prev.find((c) => c.id === conv.id);
            if (!loaded) return prev;
            const patched = { ...loaded, ...conv, contact: loaded.contact, unread_count: isActive ? 0 : conv.unread_count };
            return upsertListRows(prev, [patched], { order: listStateRef.current.order, hasMore: listStateRef.current.hasMore, activeId: activeConversation?.id });
          });
          // In place; a filtered list also asks whether it still matches (resolved, reassigned, read).
          if (listFiltered()) hydrateConversation(conv.id);
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
  // The contact panel reloads only on a change to its contact or that contact's deals (src/lib/inbox/panel-reload.ts).
  const [panelChange, setPanelChange] = useState<PanelChange | null>(null);
  const activeContactId = activeContact?.id;
  const handleRecordEvent = useCallback(
    (table: 'contacts' | 'deals', event: { new: Record<string, unknown>; old: Record<string, unknown> }) => {
      const kind = panelReloadFor(table, event, activeContactId);
      if (kind) setPanelChange((prev) => ({ kind, seq: (prev?.seq ?? 0) + 1 }));
    },
    [activeContactId]
  );
  const { isConnected } = useRealtime({
    channelName: 'inbox-realtime',
    onMessageEvent: handleMessageEvent,
    onConversationEvent: handleConversationEvent,
    onResync: () => setResyncToken((token) => token + 1),
    onRecordEvent: handleRecordEvent,
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

  // A ?c=<id> conversation the loaded page does not hold (older, or outside
  // the filter) is read on its own, so a deep link always opens its thread.
  const deepLinkFetchRef = useRef<string | null>(null);
  const resolveDeepLinkOrFetch = useCallback(
    (loaded: Conversation[]) => {
      if (deepLinkConvId && !loaded.some((c) => c.id === deepLinkConvId) && deepLinkFetchRef.current !== deepLinkConvId
        && autoSelectedForDeepLinkRef.current !== deepLinkConvId) {
        deepLinkFetchRef.current = deepLinkConvId;
        let query = createClient().from('conversations').select(CONVERSATION_SELECT).eq('id', deepLinkConvId);
        if (scope !== 'all') query = query.eq('channel', scope);
        void query.maybeSingle().then(({ data }) => {
          if (data) resolveDeepLink([normalizeConversation(data)]);
        });
        return;
      }
      resolveDeepLink(loaded);
    },
    [deepLinkConvId, resolveDeepLink, scope]
  );

  // The first page of the list's filter replaces the rows; the open thread stays.
  const handleConversationsLoaded = useCallback(
    (loaded: Conversation[]) => {
      const activeId = activeIdRef.current;
      setConversations(activeId ? loaded.map((c) => (c.id === activeId ? { ...c, unread_count: 0 } : c)) : loaded);
      resolveDeepLinkOrFetch(loaded);
    },
    [resolveDeepLinkOrFetch]
  );

  // A further page (infinite scroll) goes below the loaded rows.
  // A loaded copy of a row the page also holds is replaced by the fresh one, in its place.
  const handleConversationsAppended = useCallback((page: Conversation[]) => {
    setConversations((prev) => upsertListRows(prev, page, { order: listStateRef.current.order, hasMore: false, activeId: activeIdRef.current }));
  }, []);

  // A resync between full reloads: patch in only the conversations that
  // changed (or drop those that left the filter), so the list keeps its rows
  // and the open thread is untouched. A ?c=<id> link opened since the last
  // sync (a notification click) is resolved against the changed rows and the
  // list already loaded.
  const handleConversationsChanged = useCallback(
    (changes: { conversations: Conversation[]; removedIds: string[] }) => {
      const state = listStateRef.current;
      setConversations((prev) => upsertListRows(prev, changes.conversations, {
        order: state.order,
        hasMore: state.hasMore,
        activeId: activeConversation?.id,
        removedIds: changes.removedIds,
      }));
      resolveDeepLinkOrFetch([...changes.conversations, ...conversations]);
    },
    [activeConversation?.id, conversations, resolveDeepLinkOrFetch]
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

  // The contact changed (contact panel edits, block / unblock in the thread).
  const handleContactUpdated = useCallback((updated: Contact) => {
    setActiveContact((previous) => (previous?.id === updated.id ? updated : previous));
    setConversations((previous) =>
      previous.map((item) =>
        item.contact_id === updated.id ? { ...item, contact: { ...item.contact, ...updated } } : item
      )
    );
  }, []);

  // A field of a conversation changed in the thread (automation paused or resumed).
  const handleConversationPatch = useCallback((conversationId: string, patch: Partial<Conversation>) => {
    setConversations((prev) => prev.map((c) => (c.id === conversationId ? { ...c, ...patch } : c)));
    setActiveConversation((prev) => (prev && prev.id === conversationId ? { ...prev, ...patch } : prev));
  }, []);

  // Marked unread from the thread: it shows unread in the list, and the chat
  // closes (an open chat would read itself straight away).
  const markUnreadInList = useCallback((conversationId: string, unread: boolean) => {
    setConversations((prev) =>
      prev.map((c) => (c.id === conversationId ? { ...c, unread_count: unread ? Math.max(1, c.unread_count) : 0 } : c))
    );
  }, []);

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

  // The New message dialog opened (or started) a conversation: list and open it,
  // or go to its channel's inbox when this inbox does not show that channel.
  const handleOpenConversation = useCallback((conversation: Conversation) => {
    if (!inScope(scope, conversation)) {
      router.push(conversationInboxPath(channelOfConversation(conversation), enabledChannels ?? [], conversation.id));
      return;
    }
    setConversations((prev) => (prev.some((c) => c.id === conversation.id) ? prev : [conversation, ...prev]));
    handleSelectConversation(conversation);
  }, [scope, router, enabledChannels, handleSelectConversation]);

  const handleMarkedUnread = useCallback((conversationId: string) => {
    markUnreadInList(conversationId, true);
    if (activeConversation?.id === conversationId) handleCloseConversation();
  }, [markUnreadInList, activeConversation?.id, handleCloseConversation]);

  // A row's right-click menu.
  const handleRowAction = useCallback(async (conversation: Conversation, action: RowAction) => {
    try {
      if (action === 'read' || action === 'unread') {
        const res = await authFetch(`/api/conversations/${encodeURIComponent(conversation.id)}/unread`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ unread: action === 'unread' }),
        });
        if (!res.ok) throw new Error('unread');
        markUnreadInList(conversation.id, action === 'unread');
        if (action === 'unread' && activeConversation?.id === conversation.id) handleCloseConversation();
        toast.success(action === 'unread' ? tRow('markedUnread') : tRow('markedRead'));
        return;
      }
      const db = createClient();
      if (action === 'assign-me') {
        if (!user?.id || conversation.assigned_agent_id === user.id) return;
        const { error } = await db.from('conversations').update({ assigned_agent_id: user.id }).eq('id', conversation.id);
        if (error) throw new Error('assign');
        handleAssignChange(conversation.id, user.id);
        toast.success(tRow('assignedToYou'));
        return;
      }
      const status: ConversationStatus = action === 'close' ? 'closed' : 'open';
      const { error } = await db.from('conversations').update({ status }).eq('id', conversation.id);
      if (error) throw new Error('status');
      handleStatusChange(conversation.id, status);
      toast.success(action === 'close' ? tRow('closed') : tRow('reopened'));
    } catch {
      toast.error(tRow('failed'));
    }
  }, [markUnreadInList, activeConversation?.id, handleCloseConversation, user?.id, handleAssignChange, handleStatusChange, tRow]);

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
      className="studio-inbox bg-card -m-4 flex h-[calc(100dvh-3.5rem)] flex-col overflow-hidden sm:-m-6"
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

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {/* Left panel: Conversation list.
            Hidden on mobile when a conversation is selected so the
            thread can occupy the full width. Always visible on lg+. */}
        <div
          className={cn(
            // min-w-0: a long contact name must truncate, not widen the column past the screen.
            'flex h-full min-w-0 flex-1 lg:flex-none',
            hasActiveConv ? 'hidden lg:flex' : 'flex'
          )}
        >
          <ConversationList
            activeConversationId={activeConversation?.id ?? null}
            onSelect={handleSelectConversation}
            conversations={listedConversations}
            onConversationsLoaded={handleConversationsLoaded}
            onConversationsAppended={handleConversationsAppended}
            onConversationsChanged={handleConversationsChanged}
            onListState={handleListState}
            canBulk={canSendMessages}
            resyncToken={resyncToken}
            channel={scope}
            folders={folders}
            onNewMessage={canSendMessages ? () => setNewMessageOpen(true) : undefined}
            onRowAction={canSendMessages ? (conversation, action) => void handleRowAction(conversation, action) : undefined}
            headerAction={
              <button
                type="button"
                onClick={() => setSearchOpen(true)}
                aria-label={tSearch('placeholder')}
                title={tSearch('placeholder')}
                className="text-muted-foreground hover:bg-muted hover:text-foreground inline-flex size-8 items-center justify-center rounded-lg transition-colors duration-150"
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
            contactPanelOpen={panelShown}
            onToggleContactPanel={handleToggleContactPanel}
            jumpRequest={jumpRequestFor(jumpRequest, activeConversation?.id)}
            instagramHumanAgent={instagramHumanAgent}
            onMarkedUnread={handleMarkedUnread}
            onContactUpdated={handleContactUpdated}
            onConversationPatch={handleConversationPatch}
            onStartNew={canSendMessages ? () => setNewMessageOpen(true) : undefined}
          />
        </div>

        {/* Right panel: Contact sidebar. A side column from 1366px (the agent can
            hide it, #258); below that a slide-over above the thread, closed by its
            own collapse button, a click outside or Escape. */}
        {panelShown && !widePanel && (
          <button
            type="button"
            aria-label={tThread('hideContactPanel')}
            onClick={() => setOverlayFor(null)}
            className="absolute inset-0 z-20 bg-black/25"
          />
        )}
        {panelShown && (widePanel || activeConversation) && (
          <div
            ref={overlayRef}
            data-contact-panel={widePanel ? 'column' : 'overlay'}
            {...(widePanel
              ? {}
              : { role: 'dialog', 'aria-modal': true, 'aria-label': tSidebar('contactDetails'), tabIndex: -1 })}
            className={cn(
              !widePanel && 'outline-none',
              widePanel
                ? 'shrink-0'
                : 'absolute inset-y-0 right-0 z-30 flex w-full max-w-[300px] shadow-2xl [&>aside]:w-full'
            )}
          >
            <ContactSidebar
              key={activeContact?.id}
              contact={activeContact}
              conversationId={activeConversation?.id}
              channel={conversationChannel(activeConversation)}
              folders={folders}
              onCollapse={handleToggleContactPanel}
              change={panelChange}
              handlingKey={`${activeConversation?.assigned_agent_id ?? ''}:${activeConversation?.status ?? ''}`}
              onUpdated={handleContactUpdated}
              botPaused={activeConversation?.bot_paused ?? false}
              pauseKey={`${activeConversation?.id ?? ''}:${activeConversation?.updated_at ?? ''}:${activeConversation?.bot_paused ?? ''}:${(activeConversation as { bot_paused_until?: string | null } | null)?.bot_paused_until ?? ''}`}
            />
          </div>
        )}
      </div>

      <NewMessageDialog
        open={newMessageOpen}
        onOpenChange={setNewMessageOpen}
        channels={(scope === 'all' ? (enabledChannels?.length ? enabledChannels : ['whatsapp']) : [scope]) as ('whatsapp' | 'instagram')[]}
        onOpen={handleOpenConversation}
      />

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
