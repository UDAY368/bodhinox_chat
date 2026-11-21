'use client';

import './inbox.css';
import { avatarTone, initials } from '@/lib/ui/avatar-tone';
import { WindowRing, WindowStrip, WINDOW_TEXT, rowWindow } from './session-rail';
import type { ConsentFilter } from '@/lib/contacts/consent-view';
import { contactHandle } from '@/lib/whatsapp/wa-identity';

import { useRouter, useSearchParams } from 'next/navigation';
import { inboxPath, inScope, type InboxScope } from '@/lib/inbox/inbox-scope';
import { savedViewChannel } from '@/lib/inbox/saved-filters';
import {
  labelFilter,
  labelOfFilter,
  listQueryParams,
  parseInboxFilter,
  type InboxFilter,
  type InboxListQuery,
} from '@/lib/inbox/inbox-filters';
import { useMyTeamMembers } from '@/components/inbox/use-my-team';
import { useAgentFilter } from '@/components/inbox/use-agent-filter';
import type { InboxFolders } from '@/components/inbox/use-inbox-folders';
import { LabelDot } from '@/components/inbox/label-picker';
import type { ConversationLabel } from '@/lib/inbox/labels';
import {
  Fragment,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { createClient } from '@/lib/data/client';
import { INBOX_FULL_RELOAD_MS, nextSyncCursor, type ListOrder } from '@/lib/inbox/conversations';
import type { SessionFilter } from '@/lib/inbox/session';
import {
  BulkRequestError,
  fetchListChanges,
  fetchListPage,
  postBulkAction,
  type BulkAction,
  type InboxListCounts,
} from '@/components/inbox/inbox-list-api';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { toast } from 'sonner';
import { useSessionClock } from '@/hooks/use-session-clock';
import { cn } from '@/lib/utils';
import type { Conversation, Tag } from '@/types';
import { authFetch } from '@/lib/auth/client';
import { splitSnippet } from '@/lib/inbox/search-snippet';
import {
  Search,
  SquarePen,
  Bell,
  Check,
  RotateCcw,
  UserPlus,
  Mail,
  MailOpen,
  SlidersHorizontal,
  ChevronDown,
  X,
  Bot,
  Clock,
  AlertTriangle,
  Star,
  UserRound,
  Tag as TagIcon,
  Building2,
  Phone,
  ShieldCheck,
  BellOff,
  CheckCheck,
} from 'lucide-react';
import { InboxFilterPicker, type FilterCategory } from '@/components/inbox/inbox-filter-picker';
import { formatDistanceToNow } from 'date-fns';
import { useFormatter, useTranslations } from 'next-intl';
import { InlineError } from '@/components/ui/inline-error';
import { PageLoading } from '@/components/ui/page-loading';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  LIFECYCLE_STATES,
  compactDuration,
  firstResponseSla,
  lifecycleOf,
  type FirstResponseSla,
} from '@/lib/inbox/lifecycle-view';
import type { ConversationLifecycleState } from '@/types';
import {
  SavedFilterChips,
  SavedFiltersMenu,
  useSavedFilters,
  type InboxFilters,
} from '@/components/inbox/saved-filters/saved-filters-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ChannelBadge, conversationChannel } from '@/components/inbox/channel-badge';
import type { ConversationChannel } from '@/types';
import {
  ConversationNumberBadge,
  inboxFilterNumbers,
  NO_NUMBER,
} from '@/components/settings/numbers/conversation-number';
import { numberOptionLabel } from '@/components/settings/numbers/number-select';
import {
  useWhatsAppNumbers,
  type WhatsAppNumberDto,
} from '@/components/settings/numbers/use-whatsapp-numbers';

interface ConversationListProps {
  activeConversationId: string | null;
  onSelect: (conversation: Conversation) => void;
  /** The loaded rows, in list order: the server filtered and paged them (GET /api/inbox/conversations). */
  conversations: Conversation[];
  /** The first page of the current filter: replaces the loaded rows. */
  onConversationsLoaded: (conversations: Conversation[]) => void;
  /** A further page (infinite scroll): added below the loaded rows. */
  onConversationsAppended: (conversations: Conversation[]) => void;
  /**
   * A resync between full reloads: rows changed since the last sync that
   * match the filter (replace or add), and ids that no longer match (drop).
   */
  onConversationsChanged: (changes: { conversations: Conversation[]; removedIds: string[] }) => void;
  /**
   * The list's current query (URL parameters), order and whether more pages
   * remain, so realtime updates can be checked against the same filter.
   */
  onListState?: (state: { params: string; order: ListOrder; hasMore: boolean }) => void;
  /** Ticking rows and the bulk actions (agents and above). */
  canBulk?: boolean;
  /**
   * Increment to force the fetch effect below to refire. The parent
   * bumps this on realtime reconnect / tab visibility → visible so the
   * list catches up on any events sent while the WS was disconnected
   * or the tab was throttled. Optional so existing callers keep working.
   */
  resyncToken?: number;
  /** Extra control in the list header (the page puts message search here). */
  headerAction?: ReactNode;
  /** Opens the New message dialog (list header and empty list). */
  onNewMessage?: () => void;
  /** A row's right-click (or Shift+F10) menu action. */
  onRowAction?: (conversation: Conversation, action: RowAction) => void;
  /**
   * The inbox this list is in. A channel inbox loads only its channel's
   * conversations and has no channel filter; the All view loads every
   * channel and offers the channel filter. The number filter is WhatsApp's.
   */
  channel?: InboxScope;
  /**
   * Stage 5 folders: Mine, Favourites, Reminders and one per label, with the
   * data they read. Without it the folders are not offered.
   */
  folders?: InboxFolders;
}

/** What a row's context menu can do. */
export type RowAction = 'read' | 'unread' | 'assign-me' | 'close' | 'reopen';

/** The most conversations one "Select all" action reaches (bulk-actions.ts MAX_BULK_CONVERSATIONS). */
const MAX_BULK = 5000;

/** Views shown as status tabs instead of in the views menu. */
const TAB_VIEWS: readonly string[] = ['lifecycle-requesting', 'lifecycle-assigned'];

export function ConversationList({
  activeConversationId,
  onSelect,
  conversations,
  onConversationsLoaded,
  onConversationsChanged,
  resyncToken = 0,
  headerAction,
  channel: scope = 'all',
  folders,
  onNewMessage,
  onRowAction,
  onConversationsAppended,
  onListState,
  canBulk = false,
}: ConversationListProps) {
  const t = useTranslations('Inbox.conversationList');
  const tFolders = useTranslations('Inbox.folders');
  const tl = useTranslations('InboxLifecycle');
  const tn = useTranslations('whatsappNumbers');
  const tci = useTranslations('Inbox.channelInbox');
  // With two or more numbers each WhatsApp row names its number and a filter
  // appears; Instagram conversations have no number, so the Instagram inbox has neither.
  const { numbers } = useWhatsAppNumbers();
  const multiNumber = scope !== 'instagram' && numbers.length > 1;
  const [numberFilter, setNumberFilter] = useState<string | null>(null);
  // Channel filter: only the All view lists more than one channel.
  const tc = useTranslations('Inbox.channel');
  const allChannels = scope === 'all';
  const [channelFilter, setChannelFilter] = useState<ConversationChannel | null>(null);
  const activeChannelFilter = allChannels ? channelFilter : null;
  // Disconnected numbers are offered only while listed conversations are on
  // them (history), marked "(disconnected)".
  const filterNumbers = useMemo(
    () => inboxFilterNumbers(numbers, conversations, numberFilter),
    [numbers, conversations, numberFilter]
  );
  // A filter on a number that is gone from the workspace falls back to all.
  const activeNumberFilter =
    multiNumber &&
    (numberFilter === NO_NUMBER || filterNumbers.some((n) => n.id === numberFilter))
      ? numberFilter
      : null;
  const numberFilterLabel =
    activeNumberFilter === null
      ? tn('picker.inboxFilter')
      : activeNumberFilter === NO_NUMBER
        ? tn('picker.noNumber')
        : numberOptionLabel(filterNumbers.find((n) => n.id === activeNumberFilter)!, tn);

  // Members of the caller's teams; null when the caller is in no team.
  const myTeam = useMyTeamMembers();
  const ta = useTranslations('Inbox.agentFilter');
  const agentFilter = useAgentFilter();
  const setAgentFilter = agentFilter.setAgent;
  const agentName = (id: string) => agentFilter.members.find((m) => m.id === id)?.name || ta('anyAgent');
  const FILTER_OPTIONS: { label: string; value: InboxFilter }[] = useMemo(
    () => [
      { label: t('filterAll'), value: 'all' },
      { label: t('filterUnread'), value: 'unread' },
      { label: t('filterWaiting'), value: 'waiting' },
      { label: t('filterUnassigned'), value: 'unassigned' },
      ...(myTeam ? [{ label: t('filterMyTeam'), value: 'my-team' as const }] : []),
      { label: t('filterExpiringSoon'), value: 'expiring-soon' },
      { label: t('filterOpen'), value: 'open' },
      { label: t('filterClosed'), value: 'closed' },
    ],
    [t, myTeam]
  );
  // Stage 5 folders, offered once the folder data is wired in.
  const FOLDER_OPTIONS: { label: string; value: InboxFilter }[] = useMemo(
    () =>
      folders
        ? [
            { label: tFolders('mine'), value: 'mine' },
            { label: tFolders('favourites'), value: 'favourites' },
            { label: tFolders('reminders'), value: 'reminders' },
            { label: tFolders('failed'), value: 'failed' },
          ]
        : [],
    [tFolders, folders]
  );
  const labels = folders?.labels;
  const LABEL_OPTIONS: { label: string; value: InboxFilter; labelInfo: ConversationLabel }[] = useMemo(
    () => (labels ?? []).map((label) => ({ label: label.name, value: labelFilter(label.id), labelInfo: label })),
    [labels]
  );
  const labelsById = useMemo(() => new Map((labels ?? []).map((label) => [label.id, label])), [labels]);
  const LIFECYCLE_OPTIONS: { label: string; value: InboxFilter }[] = useMemo(
    () =>
      // Resolved is the Resolved status filter already: one word, one place.
      LIFECYCLE_STATES.filter((state) => state !== 'resolved').map((state) => ({
        label: tl(state),
        value: `lifecycle-${state}` as InboxFilter,
      })),
    [tl]
  );

  const [search, setSearch] = useState('');
  // The server filters by the search box; it waits until typing pauses.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 350);
    return () => clearTimeout(timer);
  }, [search]);
  // Matching words inside an older message, shown on the row (the server's inbox search).
  const [messageHits, setMessageHits] = useState<{ q: string; hits: Map<string, string> } | null>(null);
  useEffect(() => {
    const q = search.trim();
    if (q.length < 2) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q, limit: '50' });
        if (scope !== 'all') params.set('channel', scope);
        const res = await authFetch(`/api/inbox/search?${params}`, { cache: 'no-store' });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { results?: { conversation_id: string; snippet: string }[] };
        const hits = new Map<string, string>();
        for (const hit of data.results ?? []) if (!hits.has(hit.conversation_id)) hits.set(hit.conversation_id, hit.snippet);
        if (!cancelled) setMessageHits({ q, hits });
      } catch {
        // The rows still match; only the marked words are missing.
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [search, scope]);
  const searchHits = messageHits && messageHits.q === search.trim() ? messageHits.hits : null;
  const savedStore = useSavedFilters();
  const searchParams = useSearchParams();
  const router = useRouter();
  const filter = parseInboxFilter(searchParams.get('filter'));
  const selectFilter = (value: InboxFilter) => {
    if (value === filter) return;
    const params = new URLSearchParams(searchParams.toString());
    if (value === 'all') params.delete('filter');
    else params.set('filter', value);
    router.replace(`${inboxPath(scope)}${params.size ? `?${params}` : ''}`, {
      scroll: false,
    });
  };
  const [sessionFilter, setSessionFilter] = useState<SessionFilter>('all');
  const now = useSessionClock();
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  // Contact-based filters (issue #272). Tags use OR logic (a conversation
  // matches if its contact carries any selected tag), consistent with
  // Broadcast audience filtering. Company is an exact match on the field.
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<string | null>(null);
  // WhatsApp consent (opt-in / opt-out); not part of saved views.
  const [consentFilter, setConsentFilter] = useState<ConsentFilter>('any');
  const tConsent = useTranslations('Inbox.consent');

  // Everything the list filters by, as the server query (inbox-filters.ts).
  const listQuery: InboxListQuery = useMemo(
    () => ({
      scope,
      filter,
      channel: activeChannelFilter,
      numberId: activeNumberFilter,
      agent: agentFilter.agent,
      tagIds: selectedTagIds,
      company: selectedCompany,
      consent: consentFilter,
      search: debouncedSearch,
      session: sessionFilter,
    }),
    [scope, filter, activeChannelFilter, activeNumberFilter, agentFilter.agent, selectedTagIds, selectedCompany, consentFilter, debouncedSearch, sessionFilter]
  );
  const queryKey = listQueryParams(listQuery).toString();
  const order: ListOrder = sessionFilter === 'active' ? 'window' : 'recent';

  // Latest callbacks in refs, so the fetch effects run only when the query
  // (or a resync) changes, never because the parent re-rendered.
  const loadedRef = useRef(onConversationsLoaded);
  const appendedRef = useRef(onConversationsAppended);
  const changedRef = useRef(onConversationsChanged);
  useEffect(() => {
    loadedRef.current = onConversationsLoaded;
    appendedRef.current = onConversationsAppended;
    changedRef.current = onConversationsChanged;
  });
  const [counts, setCounts] = useState<InboxListCounts | null>(null);
  const [companies, setCompanies] = useState<string[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  // Resync state: a resync reads only the rows changed since `cursor`; the
  // first page is reloaded at most every INBOX_FULL_RELOAD_MS (deleted rows,
  // contact edits) while only that page is loaded.
  const syncRef = useRef<{ key: string; cursor: string | null; fullAt: number; pages: number }>({ key: '', cursor: null, fullAt: 0, pages: 0 });

  useEffect(() => {
    onListState?.({ params: queryKey, order, hasMore: nextCursor !== null });
  }, [onListState, queryKey, order, nextCursor]);

  // The first page whenever the query changes (or a reload is asked for).
  useEffect(() => {
    let cancelled = false;
    const startedAt = Date.now();
    fetchListPage(queryKey)
      .then((page) => {
        if (cancelled) return;
        syncRef.current = { key: queryKey, cursor: nextSyncCursor(page.conversations, null), fullAt: startedAt, pages: 1 };
        setLoadFailed(false);
        setNextCursor(page.nextCursor);
        if (page.counts) setCounts(page.counts);
        if (page.companies) setCompanies(page.companies);
        loadedRef.current(page.conversations);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [queryKey, reloadToken]);

  // A resync (realtime reconnect, tab shown, the server's periodic resync):
  // only the rows changed since the last sync, checked against the query.
  const lastResync = useRef(resyncToken);
  useEffect(() => {
    if (lastResync.current === resyncToken) return;
    lastResync.current = resyncToken;
    const sync = syncRef.current;
    if (sync.key !== queryKey) return;
    if (!sync.cursor || (sync.pages <= 1 && Date.now() - sync.fullAt >= INBOX_FULL_RELOAD_MS)) {
      setReloadToken((n) => n + 1);
      return;
    }
    let cancelled = false;
    fetchListChanges(queryKey, sync.cursor)
      .then((changes) => {
        if (cancelled || syncRef.current.key !== queryKey) return;
        if (changes.overflow) {
          setReloadToken((n) => n + 1);
          return;
        }
        syncRef.current = { ...syncRef.current, cursor: nextSyncCursor(changes.conversations, syncRef.current.cursor) };
        if (changes.counts) setCounts(changes.counts);
        changedRef.current({ conversations: changes.conversations, removedIds: changes.removedIds });
      })
      .catch(() => {
        // The next resync tries again.
      });
    return () => {
      cancelled = true;
    };
  }, [resyncToken, queryKey]);

  // The next page, when the end of the list scrolls into view.
  const loadMore = useCallback(() => {
    if (!nextCursor || loadingMore) return;
    const key = queryKey;
    setLoadingMore(true);
    fetchListPage(key, nextCursor)
      .then((page) => {
        if (syncRef.current.key !== key) return;
        syncRef.current = { ...syncRef.current, pages: syncRef.current.pages + 1 };
        setNextCursor(page.nextCursor);
        appendedRef.current(page.conversations);
      })
      .catch(() => toast.error(t('loadFailed')))
      .finally(() => setLoadingMore(false));
  }, [nextCursor, loadingMore, queryKey, t]);
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !nextCursor) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadMore();
    }, { rootMargin: '400px 0px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadMore, nextCursor]);

  // Tag definitions for the filter picker — loaded once so labels/colours
  // stay stable regardless of which conversations happen to be loaded.
  useEffect(() => {
    const db = createClient();
    let cancelled = false;
    (async () => {
      const { data } = await db.from('tags').select('*').order('name');
      if (!cancelled && data) setTags(data as Tag[]);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const tagsById = useMemo(() => {
    const m = new Map<string, Tag>();
    for (const t of tags) m.set(t.id, t);
    return m;
  }, [tags]);

  const folderContext = folders?.context;
  // The server filtered and ordered the rows; a channel inbox still shows only
  // its channel, whatever a realtime event put in the list.
  const filtered = useMemo(
    () => (allChannels ? conversations : conversations.filter((c) => inScope(scope, c))),
    [conversations, allChannels, scope]
  );

  // Channel tabs (the All inbox): how many chats each channel holds in the current view.
  const channelCounts = counts?.channels ?? { all: 0, whatsapp: 0, instagram: 0 };
  /** Every conversation the filter matches on the server (what "Select all" reaches). */
  const total = Math.max(counts?.total ?? 0, filtered.length);

  // Quick views above the list, each with how many of this inbox's chats it holds.
  const quickViews = useMemo(() => {
    const values: InboxFilter[] = ['all', 'open', 'unread', 'unassigned', ...(folders ? (['mine'] as const) : []), 'closed', 'lifecycle-requesting', 'lifecycle-assigned'];
    return values.map((value) => ({
      value,
      label: (FILTER_OPTIONS.find((o) => o.value === value) ?? FOLDER_OPTIONS.find((o) => o.value === value))?.label ?? value,
      count: counts?.views[value as keyof InboxListCounts['views']],
    }));
  }, [counts, folders, FILTER_OPTIONS, FOLDER_OPTIONS]);

  const activeWindowCount = counts?.activeWindow ?? 0;
  const sessionCounts = { expired: counts?.windows.expired ?? 0 };

  // ---------------------------------------------------------------- selection and bulk actions
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  /** "Select all N matching": the action goes to the server's filter, not the ticked ids. */
  const [allMatching, setAllMatching] = useState(false);
  /** Phones: the Select button turns taps into ticks. */
  const [selectMode, setSelectMode] = useState(false);
  const anchorRef = useRef<string | null>(null);
  const [selectionKey, setSelectionKey] = useState(queryKey);
  if (selectionKey !== queryKey) {
    // A new filter starts a new selection.
    setSelectionKey(queryKey);
    setSelected(new Set());
    setAllMatching(false);
  }
  const selecting = canBulk && (selectMode || selected.size > 0 || allMatching);
  const toggleSelected = useCallback((id: string, range: boolean) => {
    setAllMatching(false);
    setSelected((prev) => {
      const next = new Set(prev);
      const ids = filtered.map((c) => c.id);
      const from = anchorRef.current ? ids.indexOf(anchorRef.current) : -1;
      const to = ids.indexOf(id);
      if (range && from >= 0 && to >= 0) {
        for (const pick of ids.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(pick);
      } else if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    anchorRef.current = id;
  }, [filtered]);
  const clearSelection = useCallback(() => {
    setSelected(new Set());
    setAllMatching(false);
    setSelectMode(false);
    anchorRef.current = null;
  }, []);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{ action: BulkAction; label: string } | null>(null);
  const selectedCount = allMatching ? total : selected.size;
  const runBulk = useCallback(async (action: BulkAction) => {
    setBulkBusy(true);
    try {
      const result = await postBulkAction(action, allMatching ? { query: queryKey } : { ids: [...selected] });
      toast.success(t('bulkDone', { count: result.changed }));
      if (result.refusedIds.length) toast.message(t('bulkRefused', { count: result.refusedIds.length }));
      if (action.type === 'label') folders?.reloadLabels();
      clearSelection();
      setReloadToken((n) => n + 1);
    } catch (error) {
      toast.error(error instanceof BulkRequestError && error.code === 'too_many'
        ? t('bulkTooMany', { max: MAX_BULK.toLocaleString() })
        : t('bulkFailed'));
    } finally {
      setBulkBusy(false);
    }
  }, [allMatching, queryKey, selected, t, folders, clearSelection]);
  // Every matching conversation, and resolving, ask first; a few ticked rows act at once.
  const askBulk = (action: BulkAction, label: string) => {
    if (allMatching || action.type === 'resolve') setConfirmAction({ action, label });
    else void runBulk(action);
  };
  const loadedIds = filtered.map((c) => c.id);
  const allLoadedSelected = allMatching || (loadedIds.length > 0 && loadedIds.every((id) => selected.has(id)));
  const toggleAllLoaded = () => {
    setAllMatching(false);
    setSelected(allLoadedSelected ? new Set() : new Set(loadedIds));
  };

  const toggleTag = useCallback((id: string) => {
    setSelectedTagIds((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );
  }, []);

  const clearContactFilters = useCallback(() => {
    setSelectedTagIds([]);
    setSelectedCompany(null);
    setSessionFilter('all');
    setNumberFilter(null);
    setChannelFilter(null);
    setAgentFilter(null);
    setConsentFilter('any');
  }, [setAgentFilter]);

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearch(e.target.value);
    },
    []
  );

  const handleSelect = useCallback(
    (conv: Conversation) => {
      onSelect(conv);
    },
    [onSelect]
  );

  const activeFilter =
    FILTER_OPTIONS.find((o) => o.value === filter) ??
    FOLDER_OPTIONS.find((o) => o.value === filter) ??
    LABEL_OPTIONS.find((o) => o.value === filter) ??
    LIFECYCLE_OPTIONS.find((o) => o.value === filter) ??
    (labelOfFilter(filter) ? { label: tFolders('labels'), value: filter } : undefined);

  // The member's private saved views capture exactly these controls.
  const currentFilters: InboxFilters = useMemo(
    () => ({
      filter,
      session: sessionFilter,
      tagIds: selectedTagIds,
      company: selectedCompany,
      numberId: scope === 'instagram' ? null : numberFilter,
      search,
      channel: savedViewChannel(scope, activeChannelFilter, numberFilter),
    }),
    [filter, sessionFilter, selectedTagIds, selectedCompany, numberFilter, search, scope, activeChannelFilter]
  );
  const applySavedFilters = (next: InboxFilters) => {
    setSessionFilter(next.session);
    setSelectedTagIds(next.tagIds);
    setSelectedCompany(next.company);
    setNumberFilter(next.numberId);
    setSearch(next.search);
    if (allChannels) setChannelFilter(next.channel);
    selectFilter(next.filter);
  };

  const chip =
    'bg-muted text-foreground hover:bg-muted/70 inline-flex h-7 pointer-coarse:h-11 shrink-0 items-center gap-1 rounded-full px-2.5 text-xs transition-colors duration-150';

  const viewCount = (value: InboxFilter) => quickViews.find((v) => v.value === value)?.count;

  // Everything that narrows the list besides the view, channel and sort: the "+ Filter" picker.
  const consentLabel = (value: ConsentFilter) =>
    value === 'any' ? tConsent('any') : tConsent(value === 'opted_in' ? 'optedIn' : value === 'opted_out' ? 'optedOut' : 'none');
  const filterCategories: FilterCategory[] = [
    {
      id: 'consent',
      label: tConsent('filter'),
      icon: <ShieldCheck />,
      options: (['any', 'opted_in', 'opted_out', 'none'] as const).map((value) => ({
        id: value,
        label: consentLabel(value),
        reset: value === 'any',
        selected: consentFilter === value,
        onSelect: () => setConsentFilter(value),
      })),
    },
    ...(agentFilter.members.length > 1
      ? [
          {
            id: 'agent',
            label: ta('agent'),
            icon: <UserRound />,
            options: [
              {
                id: 'any',
                label: ta('anyAgent'),
                reset: true,
                selected: agentFilter.agent === null,
                onSelect: () => agentFilter.setAgent(null),
              },
              ...(['assigned', 'handled'] as const).flatMap((mode) =>
                agentFilter.members.map((m) => ({
                  id: `${mode}-${m.id}`,
                  label: ta(mode === 'handled' ? 'handledBy' : 'assignedTo', { name: m.name || ta('anyAgent') }),
                  section: ta(mode === 'handled' ? 'sectionHandled' : 'sectionAssigned'),
                  selected: agentFilter.agent?.memberId === m.id && agentFilter.agent.mode === mode,
                  onSelect: () => agentFilter.setAgent({ memberId: m.id, mode }),
                }))
              ),
            ],
          },
        ]
      : []),
    ...(tags.length > 0
      ? [
          {
            id: 'tags',
            label: t('tags'),
            icon: <TagIcon />,
            multi: true,
            options: tags.map((tag) => ({
              id: tag.id,
              label: tag.name,
              mark: <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: tag.color }} aria-hidden />,
              selected: selectedTagIds.includes(tag.id),
              onSelect: () => toggleTag(tag.id),
            })),
          },
        ]
      : []),
    ...(companies.length > 0
      ? [
          {
            id: 'company',
            label: t('company'),
            icon: <Building2 />,
            options: [
              { id: '', label: t('allCompanies'), reset: true, selected: selectedCompany === null, onSelect: () => setSelectedCompany(null) },
              ...companies.map((co) => ({
                id: co,
                label: co,
                selected: selectedCompany === co,
                onSelect: () => setSelectedCompany(co),
              })),
            ],
          },
        ]
      : []),
    ...(multiNumber
      ? [
          {
            id: 'number',
            label: tn('picker.inboxFilter'),
            icon: <Phone />,
            options: [
              { id: '', label: tn('picker.allNumbers'), reset: true, selected: activeNumberFilter === null, onSelect: () => setNumberFilter(null) },
              ...filterNumbers.map((n) => ({
                id: n.id,
                label: numberOptionLabel(n, tn),
                selected: activeNumberFilter === n.id,
                onSelect: () => setNumberFilter(n.id),
              })),
              {
                id: NO_NUMBER,
                label: tn('picker.noNumber'),
                selected: activeNumberFilter === NO_NUMBER,
                onSelect: () => setNumberFilter(NO_NUMBER),
              },
            ],
          },
        ]
      : []),
  ];
  const pickedCount =
    selectedTagIds.length +
    (selectedCompany !== null ? 1 : 0) +
    (activeNumberFilter !== null ? 1 : 0) +
    (agentFilter.agent ? 1 : 0) +
    (consentFilter !== 'any' ? 1 : 0);

  // Up / Down move through the list (not while typing, or with a menu or dialog open).
  const filteredRef = useRef<Conversation[]>([]);
  useEffect(() => {
    filteredRef.current = filtered;
  });
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      // Only from the list itself: elsewhere (the chat after a click, menus, fields) the arrows keep scrolling.
      if (!target?.closest('.studio-conversation-list')) return;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="menu"], [role="listbox"], [role="dialog"], [role="tablist"]')) return;
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      const rows = filteredRef.current;
      if (rows.length === 0) return;
      event.preventDefault();
      const index = rows.findIndex((c) => c.id === activeConversationId);
      const next = index < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
      if (index >= 0 && next === index) return;
      onSelect(rows[next]);
      requestAnimationFrame(() => {
        const row = listRef.current?.querySelector<HTMLElement>(`[data-conversation-id="${rows[next].id}"]`);
        row?.scrollIntoView({ block: 'nearest' });
        row?.focus({ preventScroll: true });
      });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [activeConversationId, onSelect]);

  const [rowMenu, setRowMenu] = useState<{ conversation: Conversation; x: number; y: number } | null>(null);
  const remindersById = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of folders?.reminders ?? []) {
      if (r.kind !== 'reminder') continue;
      const prev = map.get(r.conversation_id);
      if (!prev || Date.parse(r.remind_at) < Date.parse(prev)) map.set(r.conversation_id, r.remind_at);
    }
    return map;
  }, [folders?.reminders]);

  const windowStrip = (
    <WindowStrip conversations={filtered} now={now} activeConversationId={activeConversationId} onSelect={handleSelect} />
  );

  const searchBox = (
    <div className="relative min-w-0">
      <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" aria-hidden />
      <Input
        type="search"
        value={search}
        onChange={handleSearchChange}
        placeholder={t('searchPlaceholder')}
        aria-label={t('searchPlaceholder')}
        className="border-border bg-muted text-foreground placeholder-muted-foreground focus:border-primary/50 h-9 rounded-full pl-9 text-[13px]"
      />
    </div>
  );

  const chipClass = (on: boolean) =>
    cn(
      'inline-flex h-7 pointer-coarse:h-11 shrink-0 items-center gap-1 rounded-full px-2.5 text-xs font-medium whitespace-nowrap transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-1',
      on ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
    );
  const inMoreMenu = (filter !== 'all' && !TAB_VIEWS.includes(filter)) || sessionFilter === 'expired';

  // Every view that is not a chip: waiting, my team, expiring soon, folders, labels, lifecycle.
  const moreViews = (
    <DropdownMenu>
      <DropdownMenuTrigger data-view-menu className={cn(chipClass(inMoreMenu), 'gap-1')}>
        <span className="max-w-32 truncate">
          {sessionFilter === 'expired' && filter === 'all' ? t('sessionExpired') : inMoreMenu ? (activeFilter?.label ?? t('moreViews')) : t('moreViews')}
        </span>
        <ChevronDown className="size-3.5 opacity-60" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="border-border bg-popover max-h-[70vh] w-60 overflow-y-auto">
        {FILTER_OPTIONS.map((opt) => (
          <DropdownMenuItem
            key={opt.value}
            onClick={() => {
              if (opt.value === 'all') setSessionFilter('all');
              selectFilter(opt.value);
            }}
            className={cn('gap-3 text-sm', filter === opt.value ? 'text-primary' : 'text-popover-foreground')}
          >
            <span className="flex-1">{opt.label}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator className="bg-border" />
        <DropdownMenuItem
          onClick={() => setSessionFilter(sessionFilter === 'expired' ? 'all' : 'expired')}
          className={cn('gap-3 text-sm', sessionFilter === 'expired' ? 'text-primary' : 'text-popover-foreground')}
        >
          <span className="flex-1">{t('sessionExpired')}</span>
          <span className="text-muted-foreground text-xs tabular-nums">{sessionCounts.expired}</span>
        </DropdownMenuItem>
        {FOLDER_OPTIONS.length > 0 && (
          <>
            <DropdownMenuSeparator className="bg-border" />
            {FOLDER_OPTIONS.map((opt) => (
              <DropdownMenuItem
                key={opt.value}
                onClick={() => selectFilter(opt.value)}
                className={cn('gap-3 text-sm', filter === opt.value ? 'text-primary' : 'text-popover-foreground')}
              >
                <span className="flex-1">{opt.label}</span>
              </DropdownMenuItem>
            ))}
          </>
        )}
        {LABEL_OPTIONS.length > 0 && (
          <>
            <DropdownMenuSeparator className="bg-border" />
            <DropdownMenuGroup>
              <DropdownMenuLabel>{tFolders('labels')}</DropdownMenuLabel>
              {LABEL_OPTIONS.map((opt) => (
                <DropdownMenuItem
                  key={opt.value}
                  onClick={() => selectFilter(opt.value)}
                  className={cn('gap-2 text-sm', filter === opt.value ? 'text-primary' : 'text-popover-foreground')}
                >
                  <LabelDot color={opt.labelInfo.color} />
                  <span className="truncate">{opt.label}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </>
        )}
        <DropdownMenuSeparator className="bg-border" />
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t('lifecycle')}</DropdownMenuLabel>
          {LIFECYCLE_OPTIONS.map((opt) => (
            <DropdownMenuItem
              key={opt.value}
              onClick={() => selectFilter(opt.value)}
              className={cn('text-sm', filter === opt.value ? 'text-primary' : 'text-popover-foreground')}
            >
              {opt.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const pickedChips = (
    <>
      {agentFilter.agent && (
        <button type="button" data-agent-filter onClick={() => agentFilter.setAgent(null)} className={chip}>
          <span className="max-w-40 truncate">
            {ta(agentFilter.agent.mode === 'handled' ? 'handledBy' : 'assignedTo', { name: agentName(agentFilter.agent.memberId) })}
          </span>
          <X className="h-3 w-3" aria-hidden />
        </button>
      )}
      {selectedTagIds.map((id) => {
        const tag = tagsById.get(id);
        return (
          <button type="button" key={id} onClick={() => toggleTag(id)} className={chip}>
            <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: tag?.color ?? 'var(--muted-foreground)' }} />
            <span className="max-w-28 truncate">{tag?.name ?? t('tags')}</span>
            <X className="h-3 w-3" aria-hidden />
          </button>
        );
      })}
      {selectedCompany && (
        <button type="button" onClick={() => setSelectedCompany(null)} className={chip}>
          <span className="max-w-28 truncate">{selectedCompany}</span>
          <X className="h-3 w-3" aria-hidden />
        </button>
      )}
      {consentFilter !== 'any' && (
        <button type="button" onClick={() => setConsentFilter('any')} className={chip} data-consent-filter={consentFilter}>
          <ShieldCheck className="h-3 w-3" aria-hidden />
          <span className="max-w-28 truncate">{consentLabel(consentFilter)}</span>
          <X className="h-3 w-3" aria-hidden />
        </button>
      )}
      {activeNumberFilter !== null && (
        <button type="button" onClick={() => setNumberFilter(null)} className={chip}>
          <span className="max-w-28 truncate">{numberFilterLabel}</span>
          <X className="h-3 w-3" aria-hidden />
        </button>
      )}
    </>
  );
  // Only real chips, each with its own ×. The channel toggle and status tabs already show their own state.
  const hasPickedChips = pickedCount > 0;

  const tools = (
    <>
      <InboxFilterPicker categories={filterCategories} activeCount={pickedCount} iconOnly />
      <SavedFiltersMenu current={currentFilters} onApply={applySavedFilters} scope={scope} store={savedStore} iconOnly />
      {headerAction}
      {canBulk && (
        <button
          type="button"
          onClick={() => (selecting ? clearSelection() : setSelectMode(true))}
          aria-pressed={selecting}
          data-select-mode
          className="text-primary inline-flex h-11 shrink-0 items-center rounded-lg px-2 text-sm font-medium"
        >
          {selecting ? t('done') : t('select')}
        </button>
      )}
      {onNewMessage && (
        <button
          type="button"
          onClick={onNewMessage}
          aria-label={t('newMessage')}
          title={t('newMessage')}
          data-new-message
          className="text-muted-foreground hover:bg-muted hover:text-foreground inline-flex size-8 pointer-coarse:size-11 shrink-0 items-center justify-center rounded-lg transition-colors duration-150"
        >
          <SquarePen className="h-4 w-4" aria-hidden />
        </button>
      )}
    </>
  );

  const channelTabs =
  allChannels && (
      <div role="tablist" aria-label={tc('filterLabel')} className="bg-muted grid grid-cols-3 gap-0.5 rounded-lg p-0.5" data-channel-tabs>
        {([null, 'whatsapp', 'instagram'] as const).map((value) => {
          const on = activeChannelFilter === value;
          return (
            <button
              key={value ?? 'all'}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setChannelFilter(value)}
              className={cn(
                'flex h-7 min-w-0 items-center justify-center gap-1 rounded-md px-1.5 text-xs font-medium transition-colors duration-150 focus-visible:outline-2',
                on ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {value && <ChannelDot channel={value} />}
              <span className="truncate">{value ? tc(value) : t('filterAll')}</span>
              <span className="text-muted-foreground shrink-0 tabular-nums">{channelCounts[value ?? 'all']}</span>
            </button>
          );
        })}
      </div>
  );

  // Status tabs. Clicking the selected tab again goes back to every chat.
  const statusTabs = [
    {
      key: 'active',
      label: t('tabActive'),
      count: activeWindowCount,
      on: sessionFilter === 'active',
      pick: () => {
        setSessionFilter(sessionFilter === 'active' ? 'all' : 'active');
        selectFilter('all');
      },
    },
    ...(['lifecycle-requesting', 'lifecycle-assigned'] as const).map((value) => ({
      key: value,
      label: t(value === 'lifecycle-requesting' ? 'tabRequesting' : 'tabIntervened'),
      count: viewCount(value),
      on: filter === value && sessionFilter !== 'active',
      pick: () => {
        setSessionFilter('all');
        selectFilter(filter === value ? 'all' : value);
      },
    })),
  ];
  const statusTabBar = (
    <div role="group" aria-label={t('views')} data-status-tabs className="border-border flex border-b">
      {statusTabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          aria-pressed={tab.on}
          onClick={tab.pick}
          className={cn(
            'relative flex h-10 min-w-0 flex-1 items-center justify-center px-1 text-[11px] font-semibold tracking-[0.04em] whitespace-nowrap uppercase transition-colors duration-150',
            tab.on
              ? 'text-primary after:bg-primary after:absolute after:inset-x-2 after:bottom-0 after:h-[3px] after:rounded-t-full'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <span className="truncate">{tab.label}</span>&nbsp;<span className="tabular-nums">({tab.count ?? 0})</span>
        </button>
      ))}
    </div>
  );

  // Search, filters and the open-window avatars head the list at every width; the top bar is only the breadcrumb.
  const listHead = (
    <div data-inbox-list-head className="studio-chat-filters bg-card flex flex-col">
      <div className="flex flex-col gap-2 px-3 pt-3 pb-2">
        <div className="flex min-w-0 items-center justify-end gap-0.5">
          {moreViews}
          {tools}
        </div>
        {windowStrip}
        {searchBox}
        {channelTabs}
        <SavedFilterChips store={savedStore} current={currentFilters} onApply={applySavedFilters} scope={scope} />
        {hasPickedChips && (
          <div className="-mx-1 flex min-w-0 items-center gap-1.5 overflow-x-auto px-1 [scrollbar-width:none]">{pickedChips}</div>
        )}
      </div>
      {statusTabBar}
    </div>
  );

  return (
    <div className="studio-conversation-list border-border bg-card flex h-full w-full min-w-0 flex-col border-r lg:w-72 xl:w-80 2xl:w-[340px]">
      {listHead}

      {/* Conversation Items.
          `min-h-0` is load-bearing: a flex child defaults to
          min-height:auto, so without it this ScrollArea grows to fit
          every conversation instead of shrinking to the remaining
          space — the list then overflows and gets clipped by the
          parent's overflow-hidden with no scrollbar (issue #229). */}
      <ScrollArea className="min-h-0 flex-1">
        {loading ? (
          <PageLoading rows={8} />
        ) : loadFailed && filtered.length === 0 ? (
          <InlineError message={t('loadFailed')} onRetry={() => setReloadToken((n) => n + 1)} />
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center px-4 py-12 text-center">
            <span className="bg-muted text-muted-foreground mb-3 flex size-11 items-center justify-center rounded-2xl" aria-hidden>
              <Search className="size-5" />
            </span>
            <p className="text-muted-foreground text-sm">
              {/* An empty channel inbox (nothing to filter) names its channel. */}
              {scope !== 'all' && counts?.views.all === 0
                ? tci(scope === 'instagram' ? 'emptyInstagram' : 'emptyWhatsapp')
                : t('noConversations')}
            </p>
            <div className="mt-3 flex flex-wrap justify-center gap-2">
              {(filter !== 'all' || search || hasPickedChips || activeChannelFilter || sessionFilter !== 'all') && (
                <button
                  type="button"
                  onClick={() => {
                    setSearch('');
                    clearContactFilters();
                    selectFilter('all');
                  }}
                  className="border-border hover:bg-muted inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium"
                >
                  <SlidersHorizontal className="size-3.5" aria-hidden />
                  {t('clearFilters')}
                </button>
              )}
              {onNewMessage && (
                <button
                  type="button"
                  onClick={onNewMessage}
                  className="border-border hover:bg-muted inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium"
                >
                  <SquarePen className="size-3.5" aria-hidden />
                  {t('newMessage')}
                </button>
              )}
            </div>
          </div>
        ) : (
          <div ref={listRef} className="flex flex-col gap-0.5 px-2 pt-1 pb-3">
            {filtered.map((conv) => (
              <ConversationItem
                key={conv.id}
                conversation={conv}
                isActive={conv.id === activeConversationId}
                onSelect={selecting ? (c) => toggleSelected(c.id, false) : handleSelect}
                selection={
                  canBulk
                    ? {
                        selecting,
                        selected: allMatching || selected.has(conv.id),
                        onToggle: (range) => toggleSelected(conv.id, range),
                        label: t('selectRow', { name: conv.contact?.name || conv.contact?.phone || t('unknown') }),
                      }
                    : undefined
                }
                t={t}
                tl={tl}
                now={now}
                numbers={multiNumber ? numbers : NO_NUMBERS}
                multiChannel={allChannels}
                favourite={folderContext?.favouriteIds?.has(conv.id) ?? false}
                labels={labelsFor(folderContext?.labelsByConversation?.get(conv.id), labelsById)}
                favouriteLabel={tFolders('favourites')}
                optedOutLabel={tConsent('optedOut')}
                snippet={
                  search.trim() && !(conv.contact?.name ?? '').toLowerCase().includes(search.trim().toLowerCase())
                    ? (searchHits?.get(conv.id) ?? null)
                    : null
                }
                reminderAt={remindersById.get(conv.id) ?? null}
                onContextMenu={
                  onRowAction
                    ? (event) => {
                        event.preventDefault();
                        const rect = event.currentTarget.getBoundingClientRect();
                        // A mouse right-click opens at the pointer; the keyboard (Shift+F10) at the row.
                        const fromKeyboard = event.clientX === 0 && event.clientY === 0;
                        setRowMenu({ conversation: conv, x: fromKeyboard ? rect.left + 16 : event.clientX, y: fromKeyboard ? rect.top + 16 : event.clientY });
                      }
                    : undefined
                }
              />
            ))}
            {nextCursor && (
              <div ref={sentinelRef} className="flex h-12 items-center justify-center" data-list-more>
                {loadingMore && <span className="border-primary size-4 animate-spin rounded-full border-2 border-t-transparent" aria-label={t('loadingMore')} />}
              </div>
            )}
          </div>
        )}
      </ScrollArea>
      {selecting && (
        <BulkBar
          count={selectedCount}
          busy={bulkBusy}
          allLoadedSelected={allLoadedSelected}
          canSelectAll={!allMatching && allLoadedSelected && total > selected.size}
          total={total}
          members={agentFilter.members}
          labels={labels ?? []}
          onToggleAllLoaded={toggleAllLoaded}
          onSelectAll={() => setAllMatching(true)}
          onAction={askBulk}
        />
      )}
      <ConfirmDialog
        open={confirmAction !== null}
        onOpenChange={(open) => !open && setConfirmAction(null)}
        title={t('bulkConfirmTitle', { action: confirmAction?.label ?? '', count: selectedCount })}
        body={allMatching ? t('bulkConfirmMatching') : t('bulkConfirmResolve')}
        confirmLabel={confirmAction?.label}
        destructive={allMatching}
        onConfirm={async () => {
          if (confirmAction) await runBulk(confirmAction.action);
        }}
      />
      {rowMenu && onRowAction && (
        <RowContextMenu
          x={rowMenu.x}
          y={rowMenu.y}
          conversation={rowMenu.conversation}
          onClose={() => setRowMenu(null)}
          onAction={(action) => {
            const target = rowMenu.conversation;
            setRowMenu(null);
            onRowAction(target, action);
          }}
        />
      )}
    </div>
  );
}

/**
 * A row's right-click menu: mark read or unread, assign to me, close or
 * reopen. Opens at the pointer (or the row, from the keyboard), keeps inside
 * the window, takes focus, and closes on Escape, a click elsewhere or scroll.
 */
function RowContextMenu({
  x,
  y,
  conversation,
  onClose,
  onAction,
}: {
  x: number;
  y: number;
  conversation: Conversation;
  onClose: () => void;
  onAction: (action: RowAction) => void;
}) {
  const t = useTranslations('Inbox.rowMenu');
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({ left: Math.max(8, Math.min(x, window.innerWidth - width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - height - 8)) });
    el.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [x, y]);
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onScroll = () => onClose();
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [onClose]);
  const unread = conversation.unread_count > 0;
  const closed = conversation.status === 'closed';
  const items: { action: RowAction; label: string; icon: ReactNode }[] = [
    { action: unread ? 'read' : 'unread', label: unread ? t('markRead') : t('markUnread'), icon: unread ? <MailOpen className="size-4" /> : <Mail className="size-4" /> },
    { action: 'assign-me', label: t('assignToMe'), icon: <UserPlus className="size-4" /> },
    { action: closed ? 'reopen' : 'close', label: closed ? t('reopen') : t('close'), icon: closed ? <RotateCcw className="size-4" /> : <Check className="size-4" /> },
  ];
  const move = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const index = buttons.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = (index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length;
      buttons[next]?.focus();
    }
  };
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={t('label')}
      onKeyDown={move}
      style={{ left: pos.left, top: pos.top }}
      className="border-border bg-popover text-popover-foreground fixed z-50 min-w-48 rounded-lg border p-1 shadow-lg"
    >
      {items.map((item) => (
        <button
          key={item.action}
          type="button"
          role="menuitem"
          onClick={() => onAction(item.action)}
          className="hover:bg-muted focus-visible:bg-muted flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none [&_svg]:text-muted-foreground"
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>
  );
}


/**
 * Edit mode's bar under the list (Apple's way): Select All or Deselect All
 * and how many are ticked, "Select all N" when every loaded row is ticked and
 * more match, then Assign, Resolve, Label and Mark read as 44px toolbar items.
 */
function BulkBar({
  count,
  busy,
  allLoadedSelected,
  canSelectAll,
  total,
  members,
  labels,
  onToggleAllLoaded,
  onSelectAll,
  onAction,
}: {
  count: number;
  busy: boolean;
  allLoadedSelected: boolean;
  canSelectAll: boolean;
  total: number;
  members: { id: string; name: string }[];
  labels: ConversationLabel[];
  onToggleAllLoaded: () => void;
  onSelectAll: () => void;
  onAction: (action: BulkAction, label: string) => void;
}) {
  const t = useTranslations('Inbox.conversationList');
  const ta = useTranslations('Inbox.agentFilter');
  const item = 'text-primary hover:bg-muted inline-flex h-11 min-w-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg px-1 text-[11px] font-medium disabled:text-muted-foreground disabled:opacity-60';
  const off = busy || count === 0;
  const tooMany = t('bulkTooMany', { max: MAX_BULK.toLocaleString() });
  return (
    <div
      role="toolbar"
      aria-label={t('bulkActions')}
      data-bulk-bar
      className="border-border bg-card flex shrink-0 flex-col border-t px-2 pt-1 pb-[max(0.25rem,env(safe-area-inset-bottom))]"
    >
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <button type="button" onClick={onToggleAllLoaded} className="text-primary h-11 shrink-0 px-1 font-medium" data-bulk-toggle-all>
          {allLoadedSelected ? t('deselectAll') : t('selectAllLoaded')}
        </button>
        <span className="text-foreground min-w-0 flex-1 truncate text-center font-semibold tabular-nums" data-bulk-count aria-live="polite">
          {t('selectedCount', { count })}
        </span>
        {canSelectAll ? (
          total <= MAX_BULK ? (
            <button type="button" onClick={onSelectAll} className="text-primary h-11 shrink-0 px-1 font-medium" data-bulk-select-all>
              {t('selectAllMatching', { count: total })}
            </button>
          ) : (
            <span className="text-muted-foreground max-w-32 shrink-0 truncate text-xs" title={tooMany}>
              {tooMany}
            </span>
          )
        ) : (
          // Keeps the count centred.
          <span className="w-11 shrink-0" aria-hidden />
        )}
      </div>
      <div className="flex min-w-0 items-stretch gap-0.5">
        <DropdownMenu>
          <DropdownMenuTrigger className={item} disabled={off} data-bulk-assign>
            <UserPlus className="size-5" aria-hidden />
            {t('bulkAssign')}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="border-border bg-popover max-h-[60vh] w-56 overflow-y-auto">
            {members.map((member) => (
              <DropdownMenuItem key={member.id} className="min-h-11" onClick={() => onAction({ type: 'assign', agentId: member.id }, t('bulkAssign'))}>
                <span className="truncate">{member.name || ta('anyAgent')}</span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator className="bg-border" />
            <DropdownMenuItem className="min-h-11" onClick={() => onAction({ type: 'assign', agentId: null }, t('bulkUnassign'))}>
              {t('bulkUnassign')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <button type="button" className={item} disabled={off} onClick={() => onAction({ type: 'resolve' }, t('bulkResolve'))} data-bulk-resolve>
          <Check className="size-5" aria-hidden />
          {t('bulkResolve')}
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger className={item} disabled={off || labels.length === 0} data-bulk-label>
            <TagIcon className="size-5" aria-hidden />
            {t('bulkLabel')}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top" className="border-border bg-popover max-h-[60vh] w-56 overflow-y-auto">
            {labels.map((label) => (
              <DropdownMenuItem key={label.id} onClick={() => onAction({ type: 'label', labelId: label.id }, t('bulkLabel'))} className="min-h-11 gap-2">
                <LabelDot color={label.color} />
                <span className="truncate">{label.name}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <button type="button" className={item} disabled={off} onClick={() => onAction({ type: 'read' }, t('bulkMarkRead'))} data-bulk-read>
          <CheckCheck className="size-5" aria-hidden />
          {t('bulkMarkRead')}
        </button>
      </div>
    </div>
  );
}

function ChannelDot({ channel }: { channel: ConversationChannel }) {
  return <span aria-hidden className={cn('size-2 shrink-0 rounded-full', channel === 'whatsapp' ? 'bg-emerald-500' : 'bg-pink-500')} />;
}

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  onSelect: (conversation: Conversation) => void;
  t: ReturnType<typeof useTranslations>;
  tl: ReturnType<typeof useTranslations>;
  /** Session clock, shared with the list so SLA labels tick together. */
  now: number;
  /** The workspace's numbers when it has two or more, else empty. */
  numbers: WhatsAppNumberDto[];
  /** The All view: every row names its channel. A channel inbox marks none. */
  multiChannel?: boolean;
  /** Stage 5: the member marked it a favourite. */
  favourite?: boolean;
  /** Stage 5: its labels, in name order. */
  labels?: ConversationLabel[];
  favouriteLabel?: string;
  /** Accessible name of the opted-out mark. */
  optedOutLabel?: string;
  /** A search hit inside an older message, its matches marked (search-snippet.ts). */
  snippet?: string | null;
  /** The member's next follow-up reminder on this chat (ISO), shown as a bell tag. */
  reminderAt?: string | null;
  /** Right-click (or Shift+F10) opens the row menu. */
  onContextMenu?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  /** The row's tick box (bulk actions); shown on hover, or always while selecting. */
  selection?: { selecting: boolean; selected: boolean; onToggle: (range: boolean) => void; label: string };
}

const NO_NUMBERS: WhatsAppNumberDto[] = [];
const NO_LABELS: ConversationLabel[] = [];

/** The labels of one conversation, in the workspace's label order. */
function labelsFor(ids: ReadonlySet<string> | undefined, byId: ReadonlyMap<string, ConversationLabel>): ConversationLabel[] {
  if (!ids?.size) return NO_LABELS;
  return [...byId.values()].filter((label) => ids.has(label.id));
}

function ConversationItem({
  conversation,
  isActive,
  onSelect,
  t,
  tl,
  now,
  numbers,
  multiChannel = false,
  favourite = false,
  labels = NO_LABELS,
  favouriteLabel,
  optedOutLabel,
  snippet = null,
  reminderAt = null,
  onContextMenu,
  selection,
}: ConversationItemProps) {
  const format = useFormatter();
  const contact = conversation.contact;
  const channel = conversationChannel(conversation);
  const lifecycle = lifecycleOf(conversation);
  const sla = firstResponseSla(conversation, now);
  const displayName = contact?.name || contact?.phone || t('unknown');
  // Same seed as the thread header and contact panel, so a person keeps one colour.
  const avatarSeed = contact?.name || (contact ? contactHandle(contact) : '') || displayName;
  const avatarText = initials(avatarSeed);
  const window24 = rowWindow(conversation.last_customer_message_at, now);

  const handleClick = useCallback(() => {
    onSelect(conversation);
  }, [onSelect, conversation]);
  const shiftRef = useRef(false);

  const timeAgo = conversation.last_message_at
    ? formatDistanceToNow(new Date(conversation.last_message_at), {
        addSuffix: false,
      })
    : '';

  return (
    <div className="group/row relative" data-row-selected={selection?.selected || undefined}>
    {selection && (
      // Over the avatar: the shared tick box with a 44px hit area. Shift-click ticks every row from the last one ticked.
      <div
        onClickCapture={(event) => {
          shiftRef.current = event.shiftKey;
        }}
        className={cn(
          'absolute top-0.5 left-0.5 z-10 flex size-11 items-center justify-center transition-opacity duration-150 focus-within:opacity-100',
          selection.selecting ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100'
        )}
      >
        <Checkbox
          checked={selection.selected}
          onCheckedChange={() => selection.onToggle(shiftRef.current)}
          aria-label={selection.label}
          data-row-checkbox
          className="relative size-5 rounded-md after:absolute after:-inset-3 after:content-['']"
        />
      </div>
    )}
    <button
      type="button"
      onClick={handleClick}
      onContextMenu={onContextMenu}
      data-conversation-id={conversation.id}
      aria-current={isActive ? 'true' : undefined}
      data-unread={conversation.unread_count > 0 || undefined}
      className={cn(
        'studio-conversation hover:bg-muted/60 flex w-full min-w-0 items-start gap-3 rounded-xl px-2.5 py-2.5 text-left',
        isActive && 'bg-primary/10 hover:bg-primary/10'
      )}
    >
      {/* Avatar */}
      <div className={cn('relative flex size-10 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold', avatarTone(avatarSeed))}>
        {window24 && <WindowRing share={window24.share} urgency={window24.urgency} />}
        {contact?.avatar_url ? (
          <img
            src={contact.avatar_url}
            alt={displayName}
            className="size-10 rounded-full object-cover"
          />
        ) : (
          avatarText
        )}
        <span
          aria-hidden
          data-channel-dot={channel}
          className={cn(
            'border-card absolute -right-0.5 -bottom-0.5 size-[15px] rounded-full border-2',
            channel === 'instagram' ? 'bg-[linear-gradient(45deg,#f9a03f,#d6338a_55%,#7b3fe4)]' : 'bg-emerald-500'
          )}
        />
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-foreground flex min-w-0 items-center gap-1 truncate text-sm font-semibold">
            <span className="truncate">{displayName}</span>
            {favourite && (
              <Star className="h-3 w-3 shrink-0 fill-amber-400 text-amber-500" aria-label={favouriteLabel} />
            )}
            {channel === 'whatsapp' && contact?.opted_out_at && (
              <BellOff className="h-3 w-3 shrink-0 text-red-500" aria-label={optedOutLabel} data-row-opted-out />
            )}
          </span>
          <span className="text-muted-foreground flex shrink-0 items-center gap-1.5 text-xs tabular-nums">
            {window24 && (
              <span
                data-window-left
                title={t('windowLeft', { time: window24.left })}
                className={cn('font-semibold', WINDOW_TEXT[window24.urgency])}
              >
                {window24.left}
              </span>
            )}
            {timeAgo}
          </span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p className={cn('truncate text-[13px]', conversation.unread_count > 0 ? 'text-foreground font-medium' : 'text-muted-foreground')}>
            {snippet
              ? splitSnippet(snippet).map((part, i) =>
                  part.match ? (
                    <mark key={i} className="bg-primary/15 text-foreground rounded-sm px-0.5 font-semibold">{part.text}</mark>
                  ) : (
                    <Fragment key={i}>{part.text}</Fragment>
                  )
                )
              : conversation.last_message_text || t('noMessagesYet')}
          </p>
          {conversation.unread_count > 0 && (
            <span className="studio-unread-count bg-primary text-primary-foreground flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums">
              {conversation.unread_count}
            </span>
          )}
        </div>
        <div className="mt-1.5 flex h-5 min-w-0 flex-wrap content-start items-center gap-x-1.5 overflow-hidden">
          <LifecycleChip state={lifecycle} label={tl(lifecycle)} />
          {sla && <SlaBadge sla={sla} t={t} tl={tl} />}
          {multiChannel && <ChannelBadge channel={channel} showWhatsApp compact />}
          {channel === 'whatsapp' && (
            <ConversationNumberBadge conversation={conversation} numbers={numbers} className="min-w-0" />
          )}
          {reminderAt && (
            <span
              data-row-reminder
              title={t('reminderTag', { when: format.dateTime(new Date(reminderAt), { dateStyle: 'medium', timeStyle: 'short' }) })}
              className="studio-note inline-flex min-w-0 shrink-0 items-center gap-1 rounded-full px-2 py-px text-[11px] font-medium"
            >
              <Bell className="h-2.5 w-2.5 shrink-0" aria-hidden />
              <span className="max-w-24 truncate">{format.dateTime(new Date(reminderAt), { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</span>
            </span>
          )}
          {labels.map((label) => (
            <span key={label.id} className="bg-muted text-muted-foreground inline-flex min-w-0 items-center gap-1 rounded-full px-2 py-px text-[11px] font-medium">
              <LabelDot color={label.color} className="h-1.5 w-1.5" />
              <span className="max-w-20 truncate">{label.name}</span>
            </span>
          ))}
        </div>
      </div>
    </button>
    </div>
  );
}

const LIFECYCLE_CHIP_CLASSES: Record<ConversationLifecycleState, string> = {
  bot: 'bg-violet-500/10 text-violet-700 dark:text-violet-300',
  requesting: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
  assigned: 'bg-primary/10 text-primary',
  resolved: 'bg-muted text-muted-foreground',
};

/** Small lifecycle state pill (Bot / Requesting / Assigned / Resolved). */
export function LifecycleChip({
  state,
  label,
  className,
}: {
  state: ConversationLifecycleState;
  label: string;
  className?: string;
}) {
  return (
    <span
      data-lifecycle={state}
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 rounded-full px-2 py-px text-[11px] font-medium',
        LIFECYCLE_CHIP_CLASSES[state],
        className
      )}
    >
      {state === 'bot' && <Bot className="h-2.5 w-2.5" aria-hidden />}
      {label}
    </span>
  );
}

/**
 * First-response SLA countdown ("Reply in 12m") or breach ("Overdue 2h").
 * `t` is the Inbox.conversationList translator, `tl` InboxLifecycle.
 */
export function SlaBadge({
  sla,
  t,
  tl,
  className,
}: {
  sla: FirstResponseSla;
  t: ReturnType<typeof useTranslations>;
  tl: ReturnType<typeof useTranslations>;
  className?: string;
}) {
  const breached = sla.kind === 'breached';
  const duration = compactDuration(breached ? sla.msOver : sla.msLeft);
  const due = new Date(sla.dueAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  return (
    <span
      data-sla={sla.kind}
      title={breached ? tl('slaBreached') : tl('slaDue', { time: due })}
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 text-[10px] tabular-nums',
        breached ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground',
        className
      )}
    >
      {breached ? (
        <AlertTriangle className="h-3 w-3" aria-hidden />
      ) : (
        <Clock className="h-3 w-3" aria-hidden />
      )}
      {breached ? t('slaOverdue', duration) : t('slaDueIn', duration)}
    </span>
  );
}
