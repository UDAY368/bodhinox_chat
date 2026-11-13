'use client';

import './inbox.css';
import { avatarTone, initials } from '@/lib/ui/avatar-tone';
import { SessionRail } from './session-rail';
import { matchesConsentFilter, type ConsentFilter } from '@/lib/contacts/consent-view';
import { contactHandle } from '@/lib/whatsapp/wa-identity';

import { useRouter, useSearchParams } from 'next/navigation';
import { inboxPath, inScope, type InboxScope } from '@/lib/inbox/inbox-scope';
import { savedViewChannel } from '@/lib/inbox/saved-filters';
import {
  labelFilter,
  labelOfFilter,
  matchesAgentFilter,
  matchesInboxFilter,
  parseInboxFilter,
  type InboxFilter,
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
import {
  INBOX_FULL_RELOAD_MS,
  loadInboxConversations,
  matchesContactFilters,
  nextSyncCursor,
  normalizeConversations,
} from '@/lib/inbox/conversations';
import { matchesSessionFilter, type SessionFilter } from '@/lib/inbox/session';
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
  Timer,
  Phone,
  ShieldCheck,
  BellOff,
} from 'lucide-react';
import { InboxFilterPicker, type FilterCategory } from '@/components/inbox/inbox-filter-picker';
import { formatDistanceToNow } from 'date-fns';
import { useFormatter, useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
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
  matchesNumberFilter,
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
  conversations: Conversation[];
  onConversationsLoaded: (conversations: Conversation[]) => void;
  /**
   * Receives only the conversations changed since the last sync (a resync
   * between full reloads). Without it every resync reloads the whole list.
   */
  onConversationsChanged?: (changed: Conversation[]) => void;
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

/** The views offered as chips under the search, everyday first; the rest live in the More views menu. */
const VIEW_CHIPS = ['all', 'open', 'mine', 'unassigned', 'closed'] as const;

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
  const agentFilter = useAgentFilter(resyncToken);
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
      { label: t('filterPending'), value: 'pending' },
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
      LIFECYCLE_STATES.map((state) => ({
        label: tl(state),
        value: `lifecycle-${state}` as InboxFilter,
      })),
    [tl]
  );

  const [search, setSearch] = useState('');
  // Searching also looks inside every message (the server's inbox search), so a
  // chat whose older message matches is listed with the matching words marked.
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
        // Names, numbers and last messages still match without it.
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
  const sessionOptions: { value: SessionFilter; label: string }[] = [
    { value: 'all', label: t('allSessions') },
    { value: 'active', label: t('sessionActive') },
    { value: 'expired', label: t('sessionExpired') },
  ];
  const sessionLabel = sessionOptions.find(
    (option) => option.value === sessionFilter
  )!.label;
  const [loading, setLoading] = useState(true);
  // Contact-based filters (issue #272). Tags use OR logic (a conversation
  // matches if its contact carries any selected tag), consistent with
  // Broadcast audience filtering. Company is an exact match on the field.
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<string | null>(null);
  // WhatsApp consent (opt-in / opt-out); not part of saved views.
  const [consentFilter, setConsentFilter] = useState<ConsentFilter>('any');
  const tConsent = useTranslations('Inbox.consent');

  // Keep the latest callback in a ref so the fetch effect below can
  // have a stable, empty-dep identity. Previously the fetch useCallback
  // depended on `onConversationsLoaded`, which depends on the parent's
  // `deepLinkConvId` — so every URL change (including one the parent
  // triggered via router.replace after a click) caused a fresh
  // conversations fetch. That extra refetch was the trigger for the
  // deep-link auto-select running a second time and wiping the active
  // thread's messages.
  // Mutation lives in an effect (not render) per React 19's refs rule;
  // the fetch runs once on mount so it's fine to read the slightly
  // older value — the very next render updates the ref for any
  // subsequent async completion.
  const onConversationsLoadedRef = useRef(onConversationsLoaded);
  const onConversationsChangedRef = useRef(onConversationsChanged);
  useEffect(() => {
    onConversationsLoadedRef.current = onConversationsLoaded;
    onConversationsChangedRef.current = onConversationsChanged;
  });
  // Incremental sync state: a resync reads only conversations whose
  // updated_at moved past `cursor`; a full reload (on mount, then at most
  // every INBOX_FULL_RELOAD_MS) also drops deleted rows and refreshes
  // contact names and tags, which do not touch the conversation row.
  const syncRef = useRef<{ cursor: string | null; fullAt: number }>({ cursor: null, fullAt: 0 });

  useEffect(() => {
    const db = createClient();
    let cancelled = false;

    (async () => {
      const sync = syncRef.current;
      const incremental =
        !!onConversationsChangedRef.current &&
        sync.cursor !== null &&
        Date.now() - sync.fullAt < INBOX_FULL_RELOAD_MS;
      const startedAt = Date.now();
      const { data, error } = await loadInboxConversations(db, {
        ...(incremental ? { updatedSince: sync.cursor! } : {}),
        // A channel inbox reads only its channel's rows.
        ...(scope === 'all' ? {} : { channel: scope }),
      });

      if (cancelled) return;

      if (error) {
        // Supabase errors have non-enumerable properties — log fields explicitly
        console.error('Failed to fetch conversations:', {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        setLoading(false);
        return;
      }

      const rows = normalizeConversations(data ?? []);
      syncRef.current = {
        cursor: nextSyncCursor(rows, incremental ? sync.cursor : null),
        fullAt: incremental ? sync.fullAt : startedAt,
      };
      if (incremental) onConversationsChangedRef.current?.(rows);
      else onConversationsLoadedRef.current(rows);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
    // `resyncToken` is included so the parent can force a refetch when
    // the realtime channel reconnects, the tab regains focus or the
    // server's 30-second resync arrives. Between full reloads it reads
    // only the conversations changed since the last sync. `scope` is fixed
    // for a page (each inbox is its own route).
  }, [resyncToken, scope]);

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

  // Company options are derived from the loaded conversations — there's no
  // separate companies table, and only companies with a live conversation
  // are worth offering as an inbox filter.
  const companies = useMemo(() => {
    const set = new Set<string>();
    for (const c of conversations) {
      const co = c.contact?.company?.trim();
      if (co) set.add(co);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [conversations]);

  const tagsById = useMemo(() => {
    const m = new Map<string, Tag>();
    for (const t of tags) m.set(t.id, t);
    return m;
  }, [tags]);

  const folderContext = folders?.context;
  const baseFiltered = useMemo(() => {
    // A channel inbox shows only its channel, whatever reached the list.
    let result = allChannels ? conversations : conversations.filter((c) => inScope(scope, c));

    result = result.filter((c) => matchesInboxFilter(c, filter, now, myTeam ?? undefined, folderContext));

    if (activeNumberFilter !== null) {
      // A number filter is a WhatsApp filter: Instagram conversations have no number.
      result = result.filter(
        (c) => conversationChannel(c) === 'whatsapp' && matchesNumberFilter(c, activeNumberFilter)
      );
    }

    if (activeChannelFilter !== null) {
      result = result.filter((c) => conversationChannel(c) === activeChannelFilter);
    }

    if (agentFilter.agent) {
      result = result.filter((c) => matchesAgentFilter(c, agentFilter.agent, agentFilter.handledIds));
    }

    // Contact-based filters (tags via OR logic, exact company match).
    if (selectedTagIds.length > 0 || selectedCompany !== null) {
      result = result.filter((c) =>
        matchesContactFilters(c, {
          tagIds: selectedTagIds,
          company: selectedCompany,
        })
      );
    }

    if (consentFilter !== 'any') {
      // WhatsApp consent: Instagram chats have their own subscription, so they drop out here.
      result = result.filter((c) => conversationChannel(c) === 'whatsapp' && matchesConsentFilter(c.contact, consentFilter));
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((c) => {
        const name = c.contact?.name?.toLowerCase() ?? '';
        const phone = c.contact?.phone?.toLowerCase() ?? '';
        const lastMsg = c.last_message_text?.toLowerCase() ?? '';
        return name.includes(q) || phone.includes(q) || lastMsg.includes(q) || !!searchHits?.has(c.id);
      });
    }

    return result;
  }, [conversations, allChannels, scope, filter, search, searchHits, selectedTagIds, selectedCompany, now, activeNumberFilter, activeChannelFilter, myTeam, folderContext, agentFilter.agent, agentFilter.handledIds, consentFilter]);

  // Channel tabs (the All inbox): how many chats each channel holds in the current view.
  const channelCounts = useMemo(() => {
    const inView = conversations.filter((c) => matchesInboxFilter(c, filter, now, myTeam ?? undefined, folderContext));
    return {
      all: inView.length,
      whatsapp: inView.filter((c) => conversationChannel(c) === 'whatsapp').length,
      instagram: inView.filter((c) => conversationChannel(c) === 'instagram').length,
    };
  }, [conversations, filter, now, myTeam, folderContext]);

  // Quick views above the list, each with how many of this inbox's chats it holds.
  const quickViews = useMemo(() => {
    const inThisInbox = allChannels ? conversations : conversations.filter((c) => inScope(scope, c));
    const values: InboxFilter[] = ['all', 'open', 'unread', 'unassigned', ...(folders ? (['mine'] as const) : []), 'closed'];
    return values.map((value) => ({
      value,
      label: (FILTER_OPTIONS.find((o) => o.value === value) ?? FOLDER_OPTIONS.find((o) => o.value === value))?.label ?? value,
      count: inThisInbox.filter((c) => matchesInboxFilter(c, value, now, myTeam ?? undefined, folderContext)).length,
    }));
  }, [allChannels, conversations, scope, folders, FILTER_OPTIONS, FOLDER_OPTIONS, now, myTeam, folderContext]);

  const sessionCounts = useMemo(() => {
    const active = baseFiltered.filter((c) =>
      matchesSessionFilter(c.last_customer_message_at, 'active', now)
    ).length;
    return {
      all: baseFiltered.length,
      active,
      expired: baseFiltered.length - active,
    };
  }, [baseFiltered, now]);
  const filtered = useMemo(() => {
    const sessionMatched = baseFiltered.filter((c) =>
      matchesSessionFilter(c.last_customer_message_at, sessionFilter, now)
    );
    // Stable sort on the last message time; chats with no message go last when newest first.
    const at = (c: Conversation) => (c.last_message_at ? Date.parse(c.last_message_at) : 0);
    return sessionMatched.sort((a, b) => at(b) - at(a));
  }, [baseFiltered, sessionFilter, now]);

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

  const hasContactFilters =
    selectedTagIds.length > 0 ||
    selectedCompany !== null ||
    sessionFilter !== 'all' ||
    activeNumberFilter !== null ||
    activeChannelFilter !== null;

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
    'bg-muted text-foreground hover:bg-muted/70 inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-xs transition-colors duration-150';

  const viewCount = (value: InboxFilter) => quickViews.find((v) => v.value === value)?.count;
  const unreadCount = viewCount('unread') ?? 0;

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
      // Only from the list itself or with nothing focused: elsewhere the arrows keep scrolling (the chat, menus, fields).
      if (target && target !== document.body && !target.closest('.studio-conversation-list')) return;
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
      'inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-xs font-medium whitespace-nowrap transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-1',
      on ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
    );
  const viewChips = VIEW_CHIPS.filter((value) => value !== 'mine' || folders);
  const chipLabel = (value: InboxFilter) =>
    (FILTER_OPTIONS.find((o) => o.value === value) ?? FOLDER_OPTIONS.find((o) => o.value === value))?.label ?? value;
  const inMoreMenu = !(viewChips as readonly string[]).includes(filter) && filter !== 'unread';

  // Every view that is not a chip: waiting, my team, expiring soon, pending, folders, labels, lifecycle.
  const moreViews = (
    <DropdownMenu>
      <DropdownMenuTrigger data-view-menu className={cn(chipClass(inMoreMenu), 'gap-1')}>
        <span className="max-w-32 truncate">{inMoreMenu ? (activeFilter?.label ?? t('moreViews')) : t('moreViews')}</span>
        <ChevronDown className="size-3.5 opacity-60" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="border-border bg-popover max-h-[70vh] w-60 overflow-y-auto">
        {FILTER_OPTIONS.filter((opt) => !(viewChips as readonly string[]).includes(opt.value) && opt.value !== 'unread').map((opt) => (
          <DropdownMenuItem
            key={opt.value}
            onClick={() => selectFilter(opt.value)}
            className={cn('gap-3 text-sm', filter === opt.value ? 'text-primary' : 'text-popover-foreground')}
          >
            <span className="flex-1">{opt.label}</span>
          </DropdownMenuItem>
        ))}
        {FOLDER_OPTIONS.filter((opt) => opt.value !== 'mine').length > 0 && (
          <>
            <DropdownMenuSeparator className="bg-border" />
            {FOLDER_OPTIONS.filter((opt) => opt.value !== 'mine').map((opt) => (
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
      {(pickedCount > 0 || hasContactFilters) && (
        <button type="button" onClick={clearContactFilters} className="text-muted-foreground hover:text-foreground shrink-0 px-1 text-xs">
          {t('clearAll')}
        </button>
      )}
    </>
  );
  const hasPickedChips = pickedCount > 0 || hasContactFilters;

  // The list's own head, as in the design: title and tools, search, channel tabs, views, saved views.
  const listHead = (
    <div data-inbox-toolbar className="studio-chat-filters border-border bg-card flex flex-col gap-2 border-b px-3 pt-3 pb-2">
      <div className="flex min-w-0 items-center gap-0.5">
        <h2 className="text-foreground min-w-0 flex-1 truncate text-base font-semibold">
          {scope === 'all' ? t('title') : tc(scope)}
        </h2>
        <InboxFilterPicker categories={filterCategories} activeCount={pickedCount} iconOnly />
        <SavedFiltersMenu current={currentFilters} onApply={applySavedFilters} scope={scope} store={savedStore} iconOnly />
        {headerAction}
        {onNewMessage && (
          <button
            type="button"
            onClick={onNewMessage}
            aria-label={t('newMessage')}
            title={t('newMessage')}
            data-new-message
            className="text-muted-foreground hover:bg-muted hover:text-foreground inline-flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors duration-150"
          >
            <SquarePen className="h-4 w-4" aria-hidden />
          </button>
        )}
      </div>
      {searchBox}
      {allChannels && (
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
      )}
      <div className="-mx-1 flex min-w-0 items-center gap-1 overflow-x-auto px-1 py-0.5 [scrollbar-width:none]" data-filter-row aria-label={t('views')} role="group">
        {viewChips.map((value) => (
          <button key={value} type="button" aria-pressed={filter === value} onClick={() => selectFilter(value)} className={chipClass(filter === value)}>
            {chipLabel(value)}
            <span className="tabular-nums opacity-70">{viewCount(value)}</span>
          </button>
        ))}
        <button
          type="button"
          aria-pressed={filter === 'unread'}
          onClick={() => selectFilter(filter === 'unread' ? 'all' : 'unread')}
          className={chipClass(filter === 'unread')}
        >
          {t('filterUnread')}
          {unreadCount > 0 && <span className="tabular-nums opacity-70">{unreadCount}</span>}
        </button>
        {moreViews}
        <DropdownMenu>
          <DropdownMenuTrigger aria-label={`${t('session')}: ${sessionLabel}`} title={`${t('session')}: ${sessionLabel}`} className={chipClass(sessionFilter !== 'all')}>
            <Timer className="size-3.5" aria-hidden />
            {sessionFilter !== 'all' && <span>{sessionLabel}</span>}
            <ChevronDown className="size-3.5 opacity-60" aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="border-border bg-popover w-52">
            <DropdownMenuRadioGroup value={sessionFilter} onValueChange={(value) => setSessionFilter(value as SessionFilter)}>
              {sessionOptions.map((option) => (
                <DropdownMenuRadioItem key={option.value} value={option.value} className="gap-4 text-sm">
                  {option.label}
                  <span className="text-muted-foreground ml-auto text-xs tabular-nums">{sessionCounts[option.value]}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <SavedFilterChips store={savedStore} current={currentFilters} onApply={applySavedFilters} scope={scope} />
      {hasPickedChips && (
        <div className="-mx-1 flex min-w-0 items-center gap-1.5 overflow-x-auto px-1 [scrollbar-width:none]">{pickedChips}</div>
      )}
    </div>
  );

  return (
    <div className="studio-conversation-list border-border bg-card flex h-full w-full min-w-0 flex-col border-r lg:w-72 xl:w-80 2xl:w-[340px]">
      {listHead}

      {/* Open 24-hour windows, closing first; a chat rolls out when its window ends. */}
      <SessionRail conversations={baseFiltered} now={now} activeConversationId={activeConversationId} onSelect={handleSelect} />

      {/* Conversation Items.
          `min-h-0` is load-bearing: a flex child defaults to
          min-height:auto, so without it this ScrollArea grows to fit
          every conversation instead of shrinking to the remaining
          space — the list then overflows and gets clipped by the
          parent's overflow-hidden with no scrollbar (issue #229). */}
      <ScrollArea className="min-h-0 flex-1">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="border-primary h-5 w-5 animate-spin rounded-full border-2 border-t-transparent" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center px-4 py-12 text-center">
            <span className="bg-muted text-muted-foreground mb-3 flex size-11 items-center justify-center rounded-2xl" aria-hidden>
              <Search className="size-5" />
            </span>
            <p className="text-muted-foreground text-sm">
              {/* An empty channel inbox (nothing to filter) names its channel. */}
              {scope !== 'all' && !conversations.some((c) => inScope(scope, c))
                ? tci(scope === 'instagram' ? 'emptyInstagram' : 'emptyWhatsapp')
                : t('noConversations')}
            </p>
            <div className="mt-3 flex flex-wrap justify-center gap-2">
              {(filter !== 'all' || search || hasPickedChips || activeChannelFilter) && (
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
                onSelect={handleSelect}
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
          </div>
        )}
      </ScrollArea>
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

  const handleClick = useCallback(() => {
    onSelect(conversation);
  }, [onSelect, conversation]);

  const timeAgo = conversation.last_message_at
    ? formatDistanceToNow(new Date(conversation.last_message_at), {
        addSuffix: false,
      })
    : '';

  return (
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
          <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
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
        <div className="mt-1.5 flex min-w-0 items-center gap-1.5 overflow-hidden">
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
