'use client';

import './inbox.css';
import { avatarTone, initials } from '@/lib/ui/avatar-tone';
import { SessionRail } from './session-rail';
import { useMatchMedia } from '@/hooks/use-match-media';
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
  useSyncExternalStore,
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
import { createPortal } from 'react-dom';
import {
  Search,
  ChevronDown,
  X,
  Bot,
  Clock,
  AlertTriangle,
  Star,
  MessageSquare,
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
import { useTranslations } from 'next-intl';
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
  SavedFiltersMenu,
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
  /** Extra control at the end of the toolbar (the page puts message search here). */
  headerAction?: ReactNode;
  /**
   * Where the filter toolbar renders: a full-width row the page places above
   * the list and the thread. Without it the toolbar sits on top of the list.
   */
  toolbarSlot?: HTMLElement | null;
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
  toolbarSlot = null,
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
  // The page header's middle slot (layout/header.tsx), where the conversation search goes.
  const headerSlot = useSyncExternalStore(noSubscribe, findHeaderSlot, noHeaderSlot);
  const inHeader = useMatchMedia('(min-width: 768px)') && headerSlot !== null;
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
        return name.includes(q) || phone.includes(q) || lastMsg.includes(q);
      });
    }

    return result;
  }, [conversations, allChannels, scope, filter, search, selectedTagIds, selectedCompany, now, activeNumberFilter, activeChannelFilter, myTeam, folderContext, agentFilter.agent, agentFilter.handledIds, consentFilter]);

  // Quick views above the list, each with how many of this inbox's chats it holds.
  const quickViews = useMemo(() => {
    const inThisInbox = allChannels ? conversations : conversations.filter((c) => inScope(scope, c));
    const values: InboxFilter[] = ['all', 'unread', 'unassigned', ...(folders ? (['mine'] as const) : []), 'closed'];
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

  const pill =
    'inline-flex h-8 shrink-0 items-center gap-1 rounded-full border px-2.5 text-[13px] font-medium whitespace-nowrap transition-colors duration-150';
  const pillIdle = 'border-border text-foreground hover:bg-muted';
  const pillOn = 'bg-primary/10 text-primary border-transparent';
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

  const searchBox = (className?: string) => (
    <div className={cn('relative', className)}>
      <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
      <Input
        value={search}
        onChange={handleSearchChange}
        placeholder={t('searchPlaceholder')}
        aria-label={t('searchPlaceholder')}
        className="border-border bg-muted text-foreground placeholder-muted-foreground focus:border-primary/50 h-8 rounded-full pl-9 text-[13px]"
      />
    </div>
  );

  // The filter pills, active-filter chips and the page's action, shared by both layouts.
  const filterBar = (
    <>
        <div className="-my-1 flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto py-1 [scrollbar-width:none]" data-filter-row>
          {/* View: every inbox view, with counts on the everyday ones. */}
          <DropdownMenu>
            <DropdownMenuTrigger data-view-menu className={cn(pill, filter === 'all' || filter === 'unread' ? pillIdle : pillOn)}>
              <MessageSquare className="size-3.5" aria-hidden />
              {filter === 'unread' ? t('filterAll') : (activeFilter?.label ?? t('filterAll'))}
              <ChevronDown className="size-3.5 opacity-60" aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="border-border bg-popover max-h-[70vh] w-60 overflow-y-auto">
              {FILTER_OPTIONS.map((opt) => (
                <DropdownMenuItem
                  key={opt.value}
                  onClick={() => selectFilter(opt.value)}
                  className={cn('gap-3 text-sm', filter === opt.value ? 'text-primary' : 'text-popover-foreground')}
                >
                  <span className="flex-1">{opt.label}</span>
                  {viewCount(opt.value) !== undefined && (
                    <span className="text-muted-foreground text-xs tabular-nums">{viewCount(opt.value)}</span>
                  )}
                </DropdownMenuItem>
              ))}
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
                      {viewCount(opt.value) !== undefined && (
                        <span className="text-muted-foreground text-xs tabular-nums">{viewCount(opt.value)}</span>
                      )}
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

          {/* Unread: one tap on, one tap off. */}
          <button
            type="button"
            aria-pressed={filter === 'unread'}
            onClick={() => selectFilter(filter === 'unread' ? 'all' : 'unread')}
            className={cn(pill, filter === 'unread' ? pillOn : pillIdle)}
          >
            {t('filterUnread')}
            {unreadCount > 0 && (
              <span className={cn('text-xs tabular-nums', filter === 'unread' ? 'text-primary' : 'text-muted-foreground')}>
                {unreadCount}
              </span>
            )}
          </button>

          {/* Channel: only the All inbox lists more than one channel. */}
          {allChannels && (
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={`${tc('filterLabel')}: ${activeChannelFilter ? tc(activeChannelFilter) : tc('all')}`}
                className={cn(pill, activeChannelFilter ? pillOn : pillIdle)}
              >
                {activeChannelFilter && <ChannelDot channel={activeChannelFilter} />}
                {activeChannelFilter ? tc(activeChannelFilter) : tc('all')}
                <ChevronDown className="size-3.5 opacity-60" aria-hidden />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="border-border bg-popover w-48">
                <DropdownMenuRadioGroup
                  value={activeChannelFilter ?? ''}
                  onValueChange={(value) => setChannelFilter((value || null) as ConversationChannel | null)}
                >
                  <DropdownMenuRadioItem value="" className="text-sm">{tc('all')}</DropdownMenuRadioItem>
                  {(['whatsapp', 'instagram'] as const).map((value) => (
                    <DropdownMenuRadioItem key={value} value={value} className="gap-2 text-sm">
                      <ChannelDot channel={value} />
                      {tc(value)}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/* Session: whether the 24-hour reply window is still open. */}
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={`${t('session')}: ${sessionLabel}`}
              className={cn(pill, sessionFilter === 'all' ? pillIdle : pillOn)}
            >
              <Timer className="size-3.5" aria-hidden />
              {sessionLabel}
              <ChevronDown className="size-3.5 opacity-60" aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="border-border bg-popover w-52">
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

          <SavedFiltersMenu current={currentFilters} onApply={applySavedFilters} scope={scope} />

          <InboxFilterPicker categories={filterCategories} activeCount={pickedCount} />

          {/* What the picker has on, each removable. */}
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
        </div>
        {headerAction && <div className="shrink-0">{headerAction}</div>}
    </>
  );

  // Phones: its own two rows above the list (search, then the pills).
  const toolbar = (
    <div data-inbox-toolbar className="studio-chat-filters border-border bg-card border-b">
      <div className="px-3 pt-3">{searchBox()}</div>
      <div className="flex items-center gap-2 px-3 py-2.5 lg:px-4">
        {filterBar}
      </div>
    </div>
  );

  // From 768px: one row inside the page header, next to the page title.
  const headerBar = (
    <div data-inbox-toolbar data-inbox-header-bar className="flex min-w-0 flex-1 items-center gap-2">
      {searchBox('w-44 shrink-0 xl:w-56')}
      <span aria-hidden className="bg-border h-5 w-px shrink-0" />
      {filterBar}
    </div>
  );

  return (
    <>
      {/* md and up: search and filters share the page header's row; phones keep their own rows. */}
      {inHeader ? createPortal(headerBar, headerSlot!) : toolbarSlot && createPortal(toolbar, toolbarSlot)}
      {/* w-full on mobile so the list occupies the whole viewport when it's
          the single pane showing; a fixed column on desktop where it shares
          the row with the thread + contact sidebar. */}
      <div className="studio-conversation-list border-border bg-card flex h-full w-full flex-col border-r lg:w-72 xl:w-80 2xl:w-[340px]">
        {!toolbarSlot && !inHeader && toolbar}

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
          </div>
        ) : (
          <div className="flex flex-col gap-0.5 px-2 pt-1 pb-3">
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
              />
            ))}
          </div>
        )}
      </ScrollArea>
      </div>
    </>
  );
}

const noSubscribe = () => () => {};
const findHeaderSlot = () => document.getElementById('studio-header-center');
const noHeaderSlot = () => null;

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
}: ConversationItemProps) {
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
            {conversation.last_message_text || t('noMessagesYet')}
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
