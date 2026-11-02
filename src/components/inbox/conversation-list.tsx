'use client';

import './inbox.css';

import { useRouter, useSearchParams } from 'next/navigation';
import {
  matchesInboxFilter,
  parseInboxFilter,
  type InboxFilter,
} from '@/lib/inbox/inbox-filters';
import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { createClient } from '@/lib/data/client';
import {
  loadInboxConversations,
  matchesContactFilters,
  normalizeConversations,
} from '@/lib/inbox/conversations';
import { matchesSessionFilter, type SessionFilter } from '@/lib/inbox/session';
import { useSessionClock } from '@/hooks/use-session-clock';
import { cn } from '@/lib/utils';
import type { Conversation, ConversationStatus, Tag } from '@/types';
import { Search, ChevronDown, X, Bot, Clock, AlertTriangle } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
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
   * Increment to force the fetch effect below to refire. The parent
   * bumps this on realtime reconnect / tab visibility → visible so the
   * list catches up on any events sent while the WS was disconnected
   * or the tab was throttled. Optional so existing callers keep working.
   */
  resyncToken?: number;
  /** Extra control beside the "Chats" heading (the page puts message search here). */
  headerAction?: ReactNode;
}

const STATUS_COLORS: Record<ConversationStatus, string> = {
  open: 'bg-primary',
  pending: 'bg-amber-500',
  closed: 'bg-muted-foreground',
};

export function ConversationList({
  activeConversationId,
  onSelect,
  conversations,
  onConversationsLoaded,
  resyncToken = 0,
  headerAction,
}: ConversationListProps) {
  const t = useTranslations('Inbox.conversationList');
  const tl = useTranslations('InboxLifecycle');
  const tn = useTranslations('whatsappNumbers');
  // With two or more numbers each row names its number and a filter appears.
  const { numbers } = useWhatsAppNumbers();
  const multiNumber = numbers.length > 1;
  const [numberFilter, setNumberFilter] = useState<string | null>(null);
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

  const FILTER_OPTIONS: { label: string; value: InboxFilter }[] = useMemo(
    () => [
      { label: t('filterAll'), value: 'all' },
      { label: t('filterUnread'), value: 'unread' },
      { label: t('filterWaiting'), value: 'waiting' },
      { label: t('filterUnassigned'), value: 'unassigned' },
      { label: t('filterExpiringSoon'), value: 'expiring-soon' },
      { label: t('filterOpen'), value: 'open' },
      { label: t('filterPending'), value: 'pending' },
      { label: t('filterClosed'), value: 'closed' },
    ],
    [t]
  );
  const LIFECYCLE_OPTIONS: { label: string; value: InboxFilter }[] = useMemo(
    () =>
      LIFECYCLE_STATES.map((state) => ({
        label: tl(state),
        value: `lifecycle-${state}` as InboxFilter,
      })),
    [tl]
  );

  const [search, setSearch] = useState('');
  const searchParams = useSearchParams();
  const router = useRouter();
  const filter = parseInboxFilter(searchParams.get('filter'));
  const selectFilter = (value: InboxFilter) => {
    if (value === filter) return;
    const params = new URLSearchParams(searchParams.toString());
    if (value === 'all') params.delete('filter');
    else params.set('filter', value);
    router.replace(`/inbox${params.size ? `?${params}` : ''}`, {
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
  useEffect(() => {
    onConversationsLoadedRef.current = onConversationsLoaded;
  });

  useEffect(() => {
    const db = createClient();
    let cancelled = false;

    (async () => {
      const { data, error } = await loadInboxConversations(db);

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

      onConversationsLoadedRef.current(normalizeConversations(data ?? []));
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
    // `resyncToken` is included so the parent can force a refetch when
    // the realtime channel reconnects or the tab regains focus — catches
    // up on any events sent while the WS was disconnected or throttled.
  }, [resyncToken]);

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

  const baseFiltered = useMemo(() => {
    let result = conversations;

    result = result.filter((c) => matchesInboxFilter(c, filter, now));

    if (activeNumberFilter !== null) {
      result = result.filter((c) => matchesNumberFilter(c, activeNumberFilter));
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
  }, [conversations, filter, search, selectedTagIds, selectedCompany, now, activeNumberFilter]);

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
  const filtered = useMemo(
    () =>
      baseFiltered.filter((c) =>
        matchesSessionFilter(c.last_customer_message_at, sessionFilter, now)
      ),
    [baseFiltered, sessionFilter, now]
  );

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
  }, []);

  const hasContactFilters =
    selectedTagIds.length > 0 ||
    selectedCompany !== null ||
    sessionFilter !== 'all' ||
    activeNumberFilter !== null;

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
    LIFECYCLE_OPTIONS.find((o) => o.value === filter);

  // The member's private saved views capture exactly these controls.
  const currentFilters: InboxFilters = useMemo(
    () => ({
      filter,
      session: sessionFilter,
      tagIds: selectedTagIds,
      company: selectedCompany,
      numberId: numberFilter,
      search,
    }),
    [filter, sessionFilter, selectedTagIds, selectedCompany, numberFilter, search]
  );
  const applySavedFilters = (next: InboxFilters) => {
    setSessionFilter(next.session);
    setSelectedTagIds(next.tagIds);
    setSelectedCompany(next.company);
    setNumberFilter(next.numberId);
    setSearch(next.search);
    selectFilter(next.filter);
  };

  return (
    // w-full on mobile so the list occupies the whole viewport when it's
    // the single pane showing; fixed 320px on desktop where it shares the
    // row with the thread + contact sidebar.
    <div className="studio-conversation-list border-border bg-card flex h-full w-full flex-col border-r lg:w-80 xl:w-88">
      <div className="studio-chats-header flex items-center justify-between gap-2 px-5 py-4">
        <h1 className="text-foreground text-xl leading-tight font-semibold tracking-tight">
          {t('chats')}
        </h1>
        {headerAction}
      </div>
      {/* Search + Filter */}
      <div className="studio-chat-filters border-border space-y-2 border-b px-3 py-3">
        <div className="relative">
          <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
          <Input
            value={search}
            onChange={handleSearchChange}
            placeholder={t('searchPlaceholder')}
            aria-label={t('searchPlaceholder')}
            className="border-border bg-muted text-foreground placeholder-muted-foreground focus:border-primary/50 pl-9 text-sm"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger className="text-muted-foreground hover:text-foreground hover:bg-muted inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-xs">
              {activeFilter?.label ?? t('filterAll')}
              <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="border-border bg-popover"
            >
              {FILTER_OPTIONS.map((opt) => (
                <DropdownMenuItem
                  key={opt.value}
                  onClick={() => selectFilter(opt.value)}
                  className={cn(
                    'text-sm',
                    filter === opt.value
                      ? 'text-primary'
                      : 'text-popover-foreground'
                  )}
                >
                  {opt.label}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator className="bg-border" />
              <DropdownMenuGroup>
                <DropdownMenuLabel>{t('lifecycle')}</DropdownMenuLabel>
                {LIFECYCLE_OPTIONS.map((opt) => (
                  <DropdownMenuItem
                    key={opt.value}
                    onClick={() => selectFilter(opt.value)}
                    className={cn(
                      'text-sm',
                      filter === opt.value
                        ? 'text-primary'
                        : 'text-popover-foreground'
                    )}
                  >
                    {opt.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <SavedFiltersMenu
            current={currentFilters}
            onApply={applySavedFilters}
          />

          {tags.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  'hover:bg-muted inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-xs',
                  selectedTagIds.length > 0
                    ? 'text-primary'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {t('tags')}
                {selectedTagIds.length > 0 && (
                  <span className="bg-primary text-primary-foreground flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold">
                    {selectedTagIds.length}
                  </span>
                )}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="border-border bg-popover max-h-64 w-56"
              >
                {tags.map((t) => (
                  <DropdownMenuCheckboxItem
                    key={t.id}
                    checked={selectedTagIds.includes(t.id)}
                    onCheckedChange={() => toggleTag(t.id)}
                    className="text-popover-foreground text-sm"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: t.color }}
                      />
                      <span className="truncate">{t.name}</span>
                    </span>
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {companies.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  'hover:bg-muted inline-flex h-7 max-w-40 items-center justify-center gap-1 rounded-md px-2 text-xs',
                  selectedCompany
                    ? 'text-primary'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <span className="truncate">
                  {selectedCompany ?? t('company')}
                </span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="border-border bg-popover max-h-64 w-56"
              >
                <DropdownMenuItem
                  onClick={() => setSelectedCompany(null)}
                  className={cn(
                    'text-sm',
                    selectedCompany === null
                      ? 'text-primary'
                      : 'text-popover-foreground'
                  )}
                >
                  {t('allCompanies')}
                </DropdownMenuItem>
                {companies.map((co) => (
                  <DropdownMenuItem
                    key={co}
                    onClick={() => setSelectedCompany(co)}
                    className={cn(
                      'text-sm',
                      selectedCompany === co
                        ? 'text-primary'
                        : 'text-popover-foreground'
                    )}
                  >
                    <span className="truncate">{co}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {multiNumber && (
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={`${tn('picker.inboxFilter')}: ${numberFilterLabel}`}
                className={cn(
                  'hover:bg-muted inline-flex h-7 max-w-40 items-center justify-center gap-1 rounded-md px-2 text-xs',
                  activeNumberFilter === null
                    ? 'text-muted-foreground hover:text-foreground'
                    : 'text-primary'
                )}
              >
                <span className="truncate">{numberFilterLabel}</span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="border-border bg-popover max-h-64 w-56"
              >
                <DropdownMenuRadioGroup
                  value={activeNumberFilter ?? ''}
                  onValueChange={(value) => setNumberFilter(value || null)}
                >
                  <DropdownMenuRadioItem value="" className="text-sm">
                    {tn('picker.allNumbers')}
                  </DropdownMenuRadioItem>
                  {filterNumbers.map((n) => (
                    <DropdownMenuRadioItem key={n.id} value={n.id} className="text-sm">
                      <span className="truncate">{numberOptionLabel(n, tn)}</span>
                    </DropdownMenuRadioItem>
                  ))}
                  <DropdownMenuRadioItem value={NO_NUMBER} className="text-sm">
                    {tn('picker.noNumber')}
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={`${t('session')}: ${sessionLabel}`}
              className={cn(
                'hover:bg-muted inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-xs',
                sessionFilter === 'all'
                  ? 'text-muted-foreground hover:text-foreground'
                  : 'text-primary'
              )}
            >
              {sessionFilter === 'all' ? t('session') : sessionLabel}
              <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="border-border bg-popover"
            >
              <DropdownMenuRadioGroup
                value={sessionFilter}
                onValueChange={(value) =>
                  setSessionFilter(value as SessionFilter)
                }
              >
                {sessionOptions.map((option) => (
                  <DropdownMenuRadioItem
                    key={option.value}
                    value={option.value}
                    className="gap-4 text-sm"
                  >
                    {option.label}
                    <span className="text-muted-foreground ml-auto text-xs tabular-nums">
                      {sessionCounts[option.value]}
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {hasContactFilters && (
          <div className="flex flex-wrap items-center gap-1">
            {selectedTagIds.map((id) => {
              const tag = tagsById.get(id);
              return (
                <button
                  key={id}
                  onClick={() => toggleTag(id)}
                  className="bg-muted text-foreground hover:bg-muted/70 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]"
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{
                      backgroundColor: tag?.color ?? 'var(--muted-foreground)',
                    }}
                  />
                  <span className="max-w-24 truncate">
                    {tag?.name ?? t('tags')}
                  </span>
                  <X className="h-3 w-3" />
                </button>
              );
            })}
            {selectedCompany && (
              <button
                onClick={() => setSelectedCompany(null)}
                className="bg-muted text-foreground hover:bg-muted/70 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]"
              >
                <span className="max-w-24 truncate">{selectedCompany}</span>
                <X className="h-3 w-3" />
              </button>
            )}
            {activeNumberFilter !== null && (
              <button
                onClick={() => setNumberFilter(null)}
                className="bg-muted text-foreground hover:bg-muted/70 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]"
              >
                <span className="max-w-24 truncate">{numberFilterLabel}</span>
                <X className="h-3 w-3" />
              </button>
            )}
            {sessionFilter !== 'all' && (
              <button
                onClick={() => setSessionFilter('all')}
                className="bg-muted text-foreground hover:bg-muted/70 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]"
              >
                {sessionLabel}
                <X className="h-3 w-3" />
              </button>
            )}
            <button
              onClick={clearContactFilters}
              className="text-muted-foreground hover:text-foreground px-1 text-[11px]"
            >
              {t('clearAll')}
            </button>
          </div>
        )}
      </div>

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
          <div className="px-4 py-12 text-center">
            <p className="text-muted-foreground text-sm">
              {t('noConversations')}
            </p>
          </div>
        ) : (
          <div className="flex flex-col">
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
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
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
}

const NO_NUMBERS: WhatsAppNumberDto[] = [];

function ConversationItem({
  conversation,
  isActive,
  onSelect,
  t,
  tl,
  now,
  numbers,
}: ConversationItemProps) {
  const contact = conversation.contact;
  const lifecycle = lifecycleOf(conversation);
  const sla = firstResponseSla(conversation, now);
  const displayName = contact?.name || contact?.phone || t('unknown');
  const initials = displayName.charAt(0).toUpperCase();

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
        'studio-conversation hover:bg-muted/50 border-border flex w-full items-center gap-3 border-b px-4 py-3 text-left transition-colors',
        isActive && 'bg-muted'
      )}
    >
      {/* Avatar */}
      <div className="bg-muted text-foreground flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-sm font-medium">
        {contact?.avatar_url ? (
          <img
            src={contact.avatar_url}
            alt={displayName}
            className="h-11 w-11 rounded-full object-cover"
          />
        ) : (
          initials
        )}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-foreground truncate text-sm font-medium">
            {displayName}
          </span>
          <span className="text-muted-foreground shrink-0 text-[10px]">
            {timeAgo}
          </span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p className="text-muted-foreground truncate text-xs">
            {conversation.last_message_text || t('noMessagesYet')}
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            {conversation.unread_count > 0 && (
              <span className="studio-unread-count bg-primary text-primary-foreground flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-bold">
                {conversation.unread_count}
              </span>
            )}
            <span
              className={cn(
                'h-2 w-2 rounded-full',
                STATUS_COLORS[conversation.status]
              )}
              title={conversation.status}
            />
          </div>
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
          <LifecycleChip state={lifecycle} label={tl(lifecycle)} />
          {sla && <SlaBadge sla={sla} t={t} tl={tl} />}
          <ConversationNumberBadge conversation={conversation} numbers={numbers} className="min-w-0" />
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
        'inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-px text-[10px] font-medium',
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
