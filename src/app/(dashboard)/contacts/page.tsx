'use client';

// Contacts > People: the contact table with search, filters (segment, list,
// labels, owner, channel, consent), sorting, bulk actions and 25-per-page
// pagination. Every row lists through GET /api/contacts/bulk/view, so the
// count shown is the count a bulk action on "every matching contact" checks.
// A row opens the full-page profile at /contacts/[id].

import { Suspense, useState, useEffect, useCallback, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/data/client';
import { toast } from 'sonner';
import type { Contact, Tag, ContactTag } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Search,
  Plus,
  Upload,
  MoreHorizontal,
  Pencil,
  Trash2,
  Loader2,
  Users,
  SlidersHorizontal,
  Filter,
  Download,
  List,
  X,
  Tag as TagIcon,
  PauseCircle,
  BellOff,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  UserRound,
  Send,
  UserPlus,
} from 'lucide-react';
import { authFetch } from '@/lib/auth/client';
import { cn } from '@/lib/utils';
import { changeListMembers, fetchLists, fetchSegments, type ListSummary, type SegmentSummary } from '@/lib/audience/client';
import { groupTagsByCategory } from '@/lib/contacts/tag-groups';
import { Label } from '@/components/ui/label';
import { planAllows, usePlan } from '@/lib/billing/client';
import { UpgradeBadge } from '@/components/ui/upgrade-badge';
import { TablePagination } from '@/components/ui/table-pagination';
import { avatarTone, initials } from '@/lib/ui/avatar-tone';
import { SegmentBuilderDialog } from '@/components/contacts/segment-builder-dialog';
import { ContactForm } from '@/components/contacts/contact-form';
import { ImportModal } from '@/components/contacts/import-modal';
import { LeadScoreCell, useLeadScores } from '@/components/contacts/lead-score-cell';
import { ContactsHeader } from '@/components/contacts/contacts-header';
import { CustomFieldInput, FIELD_SELECT } from '@/components/contacts/custom-field-input';
import { downloadContactsCsv, useContactMembers, useCustomFields } from '@/components/contacts/contacts-client';
import { formatLastSeen } from '@/components/contacts/format';
import { useCan } from '@/hooks/use-can';
import { useWorkspaceChannels } from '@/hooks/use-workspace-channels';
import { GatedButton } from '@/components/ui/gated-button';
import { Switch } from '@/components/ui/switch';
import { useLocale, useTranslations } from 'next-intl';
import { PAUSE_MINUTES_CHOICES } from '@/lib/flows/types';
import type { ContactSort } from '@/lib/contacts/bulk';

const PAGE_SIZE = 25;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A filter rendered as a soft chip (a native select or a popover trigger). */
const CHIP =
  'h-8 max-w-56 shrink-0 cursor-pointer truncate rounded-full border border-border bg-card px-3 text-[13px] text-muted-foreground transition-colors duration-150 hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50';
const CHIP_ON = 'border-transparent bg-primary/10 font-semibold text-primary hover:bg-primary/15';
const TH = 'h-11 text-xs font-medium text-muted-foreground';

/** A row of the table: the contact, its tags and the columns the list endpoint adds. */
interface ContactRow extends Contact {
  tags?: Tag[];
  owner_name?: string | null;
  last_seen_at?: string | null;
  instagram_username?: string | null;
}

/** Stage 5: the contacts page's channel filter ('' is every contact). */
type ChannelView = '' | 'whatsapp' | 'instagram';
type InstagramStatus = 'subscribed' | 'unsubscribed' | 'none';
type OwnerFilter = '' | 'none' | string;
type ConsentFilter = '' | 'opted_in' | 'opted_out';

/** The Stage 5 bulk actions (POST /api/contacts/bulk, src/lib/contacts/bulk.ts). */
type Stage5BulkAction =
  | { type: 'remove_tag'; tagId: string }
  | { type: 'unsubscribe_instagram' }
  | { type: 'pause_automations'; minutes: number | null }
  | { type: 'set_field'; fieldId: string; value: string }
  | { type: 'assign_owner'; ownerId: string | null };

const SORTS: ContactSort[] = ['name', 'city', 'owner', 'seen', 'created'];
const defaultDir = (sort: ContactSort): 'asc' | 'desc' => (sort === 'created' || sort === 'seen' ? 'desc' : 'asc');

export default function ContactsPage() {
  return (
    <Suspense fallback={null}>
      <ContactsPeople />
    </Suspense>
  );
}

function ContactsPeople() {
  const t = useTranslations('Contacts.page');
  const tr = useTranslations('Contacts.redesign');
  const tGate = useTranslations('GatedButton');
  const locale = useLocale();
  const router = useRouter();
  const searchParams = useSearchParams();
  const db = createClient();
  const canEdit = useCan('send-messages');
  const canEditSettings = useCan('edit-settings');
  const canExport = planAllows(usePlan(), 'contact_export');
  const members = useContactMembers();
  const { fields: customFields } = useCustomFields();

  const [contacts, setContacts] = useState<ContactRow[]>([]);
  // Advisory AI lead scores for the contacts on screen (agents and above).
  const leadScores = useLeadScores(contacts.map((c) => c.id));
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  // Tag filter — contacts shown must have ANY of these tags (OR).
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  // Saved segment view; replaces the tag filter while active. ?segment= comes from the Segments tab.
  const [segments, setSegments] = useState<SegmentSummary[]>([]);
  const [segmentId, setSegmentId] = useState(() => {
    const id = searchParams.get('segment') ?? '';
    return UUID.test(id) ? id : '';
  });
  const [builderOpen, setBuilderOpen] = useState(false);
  const [editingSegment, setEditingSegment] = useState<SegmentSummary | null>(null);
  // Static list view; like a segment, it replaces the tag filter.
  const [lists, setLists] = useState<ListSummary[]>([]);
  const [listId, setListId] = useState('');
  const [newListOpen, setNewListOpen] = useState(false);
  const [newListName, setNewListName] = useState('');
  const [listBusy, setListBusy] = useState(false);
  const [campaigns, setCampaigns] = useState<{ id: string; name: string }[]>([]);
  const [exporting, setExporting] = useState(false);
  // Contacts redesign: owner and consent filters, and the table's sort.
  const [ownerFilter, setOwnerFilter] = useState<OwnerFilter>('');
  const [consentFilter, setConsentFilter] = useState<ConsentFilter>('');
  const [sort, setSort] = useState<{ key: ContactSort; dir: 'asc' | 'desc' }>({ key: 'created', dir: 'desc' });

  // Modals
  const [formOpen, setFormOpen] = useState(false);
  const [editContact, setEditContact] = useState<Contact | null>(null);
  const [editContactTags, setEditContactTags] = useState<ContactTag[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Contact | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Bulk selection: rows ticked on this page, or (allMatching) every
  // contact matching the current view, acted on server-side by filter.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  // Stage 5: channel filter, "subscribed only" and the Instagram status, offered
  // only while Instagram is on (a WhatsApp-only workspace sees the page it had).
  const tc = useTranslations('Contacts.filters');
  const tcs = useTranslations('Contacts.channelStatus');
  const tb = useTranslations('Contacts.bulk');
  const tPause = useTranslations('Inbox.pause');
  const { data: channels } = useWorkspaceChannels();
  const instagramOn = channels?.enabled.includes('instagram') ?? false;
  const [channelView, setChannelView] = useState<ChannelView>('');
  const [subscribedOnly, setSubscribedOnly] = useState(false);
  const [igStatus, setIgStatus] = useState<Record<string, InstagramStatus>>({});
  const [setFieldOpen, setSetFieldOpen] = useState(false);
  const [bulkFieldId, setBulkFieldId] = useState('');
  const [bulkFieldValue, setBulkFieldValue] = useState('');

  // All tags for display
  const [tagsMap, setTagsMap] = useState<Record<string, Tag>>({});

  // Guards against out-of-order fetch responses: each fetchContacts run
  // claims a sequence number and only the latest is allowed to commit its
  // results, so a slower earlier request can never render stale rows.
  const fetchSeq = useRef(0);

  // "View contact" from the inbox links here with ?contact=<id>: open that contact's page.
  useEffect(() => {
    const id = searchParams.get('contact');
    if (id && UUID.test(id)) router.replace(`/contacts/${id}`);
  }, [searchParams, router]);

  const fetchTags = useCallback(async () => {
    const { data } = await db.from('tags').select('*');
    if (data) {
      const map: Record<string, Tag> = {};
      data.forEach((t) => (map[t.id] = t));
      setTagsMap(map);
      // Drop any filter selections whose tag no longer exists (e.g. a tag
      // deleted elsewhere) so it can't linger invisibly in the query.
      setSelectedTagIds((prev) => {
        const pruned = prev.filter((id) => map[id]);
        return pruned.length === prev.length ? prev : pruned;
      });
    }
  }, [db]);

  const fetchContacts = useCallback(async () => {
    const seq = ++fetchSeq.current;
    setLoading(true);
    // The visible rows are about to change — drop any selection that
    // referred to the old page/search results so the bulk bar can't
    // act on rows the user can no longer see.
    setSelected(new Set());
    setAllMatching(false);

    const term = search.trim();
    const query = new URLSearchParams({ offset: String(page * PAGE_SIZE), limit: String(PAGE_SIZE), sort: sort.key, dir: sort.dir });
    if (segmentId) query.set('segmentId', segmentId);
    else if (listId) query.set('listId', listId);
    else if (selectedTagIds.length) query.set('tagIds', selectedTagIds.join(','));
    if (term) query.set('search', term.slice(0, 200));
    if (channelView) query.set('channel', channelView);
    if (subscribedOnly) query.set('subscribed', '1');
    if (ownerFilter) query.set('ownerId', ownerFilter);
    if (consentFilter) query.set('consent', consentFilter);
    const res = await authFetch(`/api/contacts/bulk/view?${query}`, { cache: 'no-store' }).catch(() => null);
    if (seq !== fetchSeq.current) return;
    if (!res?.ok) {
      toast.error(t('toastFailedLoad'));
      setLoading(false);
      return;
    }
    const payload = (await res.json()) as { contacts: ContactRow[]; total: number };
    if (seq !== fetchSeq.current) return;
    setTotalCount(payload.total);

    if (payload.contacts.length === 0) {
      setContacts([]);
      setLoading(false);
      return;
    }

    // Tags for these contacts
    const contactIds = payload.contacts.map((c) => c.id);
    const { data: contactTags } = await db
      .from('contact_tags')
      .select('contact_id, tag_id')
      .in('contact_id', contactIds);
    if (seq !== fetchSeq.current) return; // superseded by a newer fetch

    const tagsByContact: Record<string, string[]> = {};
    contactTags?.forEach((ct) => {
      if (!tagsByContact[ct.contact_id]) tagsByContact[ct.contact_id] = [];
      tagsByContact[ct.contact_id].push(ct.tag_id);
    });

    setContacts(payload.contacts.map((c) => ({
      ...c,
      tags: (tagsByContact[c.id] ?? []).map((tid) => tagsMap[tid]).filter(Boolean),
    })));
    setLoading(false);
  }, [db, page, search, selectedTagIds, segmentId, listId, tagsMap, t, channelView, subscribedOnly, ownerFilter, consentFilter, sort]);

  // Stage 5: the Instagram status of the rows on screen, read from stored state.
  const contactIdsKey = contacts.map((c) => c.id).join(',');
  useEffect(() => {
    if (!instagramOn || !contactIdsKey) return;
    let live = true;
    authFetch(`/api/contacts/bulk/status?ids=${encodeURIComponent(contactIdsKey)}`, { cache: 'no-store' })
      .then(async (res) => {
        const body = res.ok ? ((await res.json()) as { statuses: Record<string, InstagramStatus> }) : null;
        if (live && body) setIgStatus(body.statuses);
      })
      .catch(() => {
        // The status is informational; the row shows none without it.
      });
    return () => {
      live = false;
    };
  }, [instagramOn, contactIdsKey]);

  const loadSegments = useCallback(async () => {
    try {
      setSegments(await fetchSegments());
    } catch {
      toast.error(t('segments.loadFailed'));
    }
  }, [t]);

  const loadLists = useCallback(async () => {
    try {
      setLists(await fetchLists());
    } catch {
      toast.error(t('lists.loadFailed'));
    }
  }, [t]);

  useEffect(() => {
    loadSegments();
    loadLists();
  }, [loadSegments, loadLists]);

  function selectSegment(id: string) {
    setSegmentId(id);
    setListId('');
    setSelectedTagIds([]);
    setPage(0);
  }

  function selectList(id: string) {
    setListId(id);
    setSegmentId('');
    setSelectedTagIds([]);
    setPage(0);
  }

  async function createList() {
    setListBusy(true);
    try {
      const res = await authFetch('/api/lists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newListName.trim() }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || t('lists.createFailed'));
        return;
      }
      toast.success(t('lists.created'));
      setNewListOpen(false);
      setNewListName('');
      await loadLists();
      selectList((payload as { list: ListSummary }).list.id);
    } catch {
      toast.error(t('lists.createFailed'));
    } finally {
      setListBusy(false);
    }
  }

  async function deleteSelectedList() {
    const res = await authFetch(`/api/lists/${listId}`, { method: 'DELETE' }).catch(() => null);
    if (!res?.ok) {
      toast.error(t('lists.deleteFailed'));
      return;
    }
    toast.success(t('lists.deleted'));
    selectList('');
    loadLists();
  }

  /** The current view as a bulk scope (POST /api/contacts/bulk). */
  function viewScope() {
    const term = search.trim();
    return {
      ...(segmentId ? { segmentId } : listId ? { listId } : selectedTagIds.length ? { tagIds: selectedTagIds } : {}),
      ...(term ? { search: term.slice(0, 200) } : {}),
      ...(channelView ? { channel: channelView } : {}),
      ...(subscribedOnly ? { subscribedOnly: true } : {}),
      ...(ownerFilter ? { ownerId: ownerFilter } : {}),
      ...(consentFilter ? { consent: consentFilter } : {}),
    };
  }

  /**
   * Run a bulk action on every contact matching the current view. Returns
   * null (after telling the user) when it did not run; the server refuses
   * with 409 when the match count is no longer the one on screen.
   */
  async function runBulk(
    action: { type: 'add_to_list' | 'remove_from_list'; listId: string } | { type: 'add_tag'; tagId: string } | { type: 'delete' } | Stage5BulkAction,
    /** Act on these ticked rows instead of the whole view. */
    contactIds?: string[],
  ) {
    const scope = contactIds ? { contactIds } : viewScope();
    const res = await authFetch('/api/contacts/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope, action, expected: contactIds ? contactIds.length : totalCount }),
    }).catch(() => null);
    const payload = (await res?.json().catch(() => null)) as { changed?: number; matched?: number; error?: string } | null;
    if (res?.status === 409) {
      toast.error(t('bulkCountChanged'));
      fetchContacts();
      return null;
    }
    if (!res?.ok) throw new Error(payload?.error || undefined);
    return { matched: payload?.matched ?? totalCount, changed: payload?.changed ?? 0 };
  }

  async function changeSelectedMembers(targetListId: string, mode: 'add' | 'remove') {
    const ids = [...selected];
    setListBusy(true);
    try {
      let count = ids.length;
      if (allMatching) {
        const done = await runBulk({ type: mode === 'add' ? 'add_to_list' : 'remove_from_list', listId: targetListId });
        if (!done) return;
        count = done.matched;
      } else {
        await changeListMembers(targetListId, { [mode]: ids });
      }
      const name = lists.find((l) => l.id === targetListId)?.name ?? '';
      toast.success(mode === 'add' ? t('lists.added', { count, name }) : t('lists.removed', { count }));
      setSelected(new Set());
      setAllMatching(false);
      loadLists();
      if (targetListId === listId) fetchContacts();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('lists.changeFailed'));
    } finally {
      setListBusy(false);
    }
  }

  async function openSegmentBuilder(segment: SegmentSummary | null) {
    // Recent campaigns that actually went out, for retargeting conditions.
    const { data: sent } = await db.from('broadcasts').select('id,name')
      .in('status', ['sending', 'sent', 'failed']).order('created_at', { ascending: false }).limit(200);
    setCampaigns(sent ?? []);
    setEditingSegment(segment);
    setBuilderOpen(true);
  }

  async function deleteSelectedSegment() {
    const res = await authFetch(`/api/segments/${segmentId}`, { method: 'DELETE' }).catch(() => null);
    if (!res?.ok) {
      toast.error(t('segments.deleteFailed'));
      return;
    }
    toast.success(t('segments.deleted'));
    selectSegment('');
    loadSegments();
  }

  async function exportCsv(query: string) {
    setExporting(true);
    try {
      const done = await downloadContactsCsv(query);
      if (!done.ok) toast.error(done.error || t('segments.exportFailed'));
    } finally {
      setExporting(false);
    }
  }

  useEffect(() => {
    fetchTags();
  }, [fetchTags]);

  useEffect(() => {
    fetchContacts();
  }, [fetchContacts]);

  function openAddForm() {
    setEditContact(null);
    setEditContactTags([]);
    setFormOpen(true);
  }

  async function openEditForm(contact: Contact) {
    const { data } = await db
      .from('contact_tags')
      .select('*')
      .eq('contact_id', contact.id);
    setEditContact(contact);
    setEditContactTags(data ?? []);
    setFormOpen(true);
  }

  function confirmDelete(contact: Contact) {
    setDeleteTarget(contact);
    setDeleteConfirmOpen(true);
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);

    const { error } = await db
      .from('contacts')
      .delete()
      .eq('id', deleteTarget.id);

    if (error) {
      toast.error(t('toastFailedDelete'));
    } else {
      toast.success(t('toastDeleted'));
      fetchContacts();
    }

    setDeleting(false);
    setDeleteConfirmOpen(false);
    setDeleteTarget(null);
  }

  // Admins: full erasure (contact, media it sent, campaign and form data, raw webhook copies), queued server-side.
  async function handleErase() {
    if (!deleteTarget) return;
    setDeleting(true);
    const res = await authFetch(`/api/contacts/${deleteTarget.id}/erase`, { method: 'POST' }).catch(() => null);
    if (res?.ok) toast.success(t('toastEraseQueued'));
    else toast.error(t('toastEraseFailed'));
    setDeleting(false);
    setDeleteConfirmOpen(false);
    setDeleteTarget(null);
  }

  const allOnPageSelected =
    contacts.length > 0 && contacts.every((c) => selected.has(c.id));
  const someOnPageSelected = contacts.some((c) => selected.has(c.id));

  function toggleSelectAll() {
    setAllMatching(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) {
        contacts.forEach((c) => next.delete(c.id));
      } else {
        contacts.forEach((c) => next.add(c.id));
      }
      return next;
    });
  }

  function toggleSelect(id: string) {
    setAllMatching(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleBulkDelete() {
    const ids = [...selected];
    if (ids.length === 0) return;
    setDeleting(true);

    let error: unknown = null;
    let count = ids.length;
    if (allMatching) {
      try {
        const done = await runBulk({ type: 'delete' });
        if (!done) {
          setDeleting(false);
          setBulkDeleteOpen(false);
          return;
        }
        count = done.changed;
      } catch (err) {
        error = err;
      }
    } else {
      ({ error } = await db.from('contacts').delete().in('id', ids));
    }

    if (error) {
      toast.error(t('toastBulkFailedDelete'));
    } else {
      toast.success(t('toastBulkDeleted', { count }));
      setSelected(new Set());
      setAllMatching(false);
      fetchContacts();
    }

    setDeleting(false);
    setBulkDeleteOpen(false);
  }

  /** Bulk tagging, like CSV import, does not run tag_added automations. */
  async function addTagToSelected(tagId: string) {
    const ids = [...selected];
    setListBusy(true);
    try {
      let count = ids.length;
      if (allMatching) {
        const done = await runBulk({ type: 'add_tag', tagId });
        if (!done) return;
        count = done.matched;
      } else {
        const { error } = await db
          .from('contact_tags')
          .upsert(ids.map((contactId) => ({ contact_id: contactId, tag_id: tagId })), {
            onConflict: 'contact_id,tag_id',
            ignoreDuplicates: true,
          });
        if (error) throw error;
      }
      toast.success(t('tagAdded', { count }));
      setSelected(new Set());
      setAllMatching(false);
      fetchContacts();
    } catch {
      toast.error(t('tagFailed'));
    } finally {
      setListBusy(false);
    }
  }

  // The bulk bar acts on this many contacts.
  const selectionCount = allMatching ? totalCount : selected.size;

  /**
   * Server-side bulk actions (remove a tag, unsubscribe from Instagram, pause
   * automations, set a custom field, assign an owner): every matching contact,
   * or the ticked rows, with the same count check as the others.
   */
  async function runStage5Bulk(action: Stage5BulkAction, confirmed = false): Promise<boolean> {
    if (!confirmed && !window.confirm(tb('confirm', { count: selectionCount }))) return false;
    setListBusy(true);
    try {
      const done = await runBulk(action, allMatching ? undefined : [...selected]);
      if (!done) return false;
      toast.success(tb('done', { count: done.matched }));
      setSelected(new Set());
      setAllMatching(false);
      fetchContacts();
      return true;
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : tb('failed'));
      return false;
    } finally {
      setListBusy(false);
    }
  }

  function openSetField() {
    setBulkFieldId('');
    setBulkFieldValue('');
    setSetFieldOpen(true);
  }

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const bulkField = customFields.find((f) => f.id === bulkFieldId);

  // Tag filter helpers. Every change resets to page 0 — the result set
  // shrinks/grows so page N may no longer be valid (mirrors the search box).
  const allTags = Object.values(tagsMap).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  const tagGroups = groupTagsByCategory(allTags);
  const filtersOn = selectedTagIds.length > 0 || segmentId !== '' || listId !== ''
    || channelView !== '' || subscribedOnly || ownerFilter !== '' || consentFilter !== '';
  const hasActiveFilters = search.trim().length > 0 || filtersOn;
  const showChannelFilters = instagramOn || channelView !== '' || subscribedOnly;
  const selectedSegment = segments.find((s) => s.id === segmentId) ?? null;

  function toggleTagFilter(tagId: string) {
    setSelectedTagIds((prev) =>
      prev.includes(tagId)
        ? prev.filter((id) => id !== tagId)
        : [...prev, tagId]
    );
    setPage(0);
  }

  function clearTagFilters() {
    setSelectedTagIds([]);
    setPage(0);
  }

  function clearFilters() {
    setSelectedTagIds([]);
    setSegmentId('');
    setListId('');
    setChannelView('');
    setSubscribedOnly(false);
    setOwnerFilter('');
    setConsentFilter('');
    setPage(0);
  }

  function sortBy(key: ContactSort, dir?: 'asc' | 'desc') {
    setSort((prev) => ({ key, dir: dir ?? (prev.key === key ? (prev.dir === 'asc' ? 'desc' : 'asc') : defaultDir(key)) }));
    setPage(0);
  }

  const sortLabel = (key: ContactSort) => tr(`sort.${key}`);

  /** A sortable column header (aria-sort names the order). */
  function sortHead(id: ContactSort, label: string, className?: string) {
    const on = sort.key === id;
    return (
      <TableHead className={cn(TH, className)} aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
        <button
          type="button"
          onClick={() => sortBy(id)}
          className={cn('inline-flex items-center gap-1 rounded-md hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50', on && 'text-foreground')}
        >
          {label}
          {on && (sort.dir === 'asc' ? <ArrowUp className="size-3" aria-hidden /> : <ArrowDown className="size-3" aria-hidden />)}
        </button>
      </TableHead>
    );
  }

  const exportQuery = segmentId ? `segmentId=${segmentId}` : listId ? `listId=${listId}` : '';

  return (
    <div className="min-w-0 space-y-5">
      <ContactsHeader
        tab="people"
        known={{ people: loading || filtersOn || search.trim() ? null : totalCount }}
        actions={
          <>
            {canEditSettings && !canExport && <UpgradeBadge />}
            {canEdit && (
              <Button variant="ghost" onClick={() => setNewListOpen(true)} className="text-muted-foreground">
                <List className="size-4" />
                {t('lists.newList')}
              </Button>
            )}
            <GatedButton
              variant="outline"
              canAct={canEdit}
              gateReason={tGate('reasons.addOrImportContacts')}
              onClick={() => setImportOpen(true)}
            >
              <Upload className="size-4" />
              {t('importBtn')}
            </GatedButton>
            {canEditSettings && (
              <Button
                variant="outline"
                onClick={() => exportCsv(exportQuery)}
                disabled={exporting || !canExport}
              >
                {exporting ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
                {segmentId ? t('segments.exportSegment') : listId ? t('lists.exportList') : t('segments.exportAll')}
              </Button>
            )}
            <GatedButton
              canAct={canEdit}
              gateReason={tGate('reasons.addOrImportContacts')}
              onClick={openAddForm}
            >
              <Plus className="size-4" />
              {t('addContactBtn')}
            </GatedButton>
          </>
        }
      />

      {/* Search + filter chips + sort */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-72">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={search}
              aria-label={t('searchPlaceholder')}
              onChange={(e) => {
                setSearch(e.target.value);
                // Reset pagination when the query changes — the result
                // set shrinks/grows, page N may no longer be valid.
                setPage(0);
              }}
              placeholder={t('searchPlaceholder')}
              className="h-10 rounded-xl border-transparent bg-muted pl-10 text-foreground placeholder:text-muted-foreground focus-visible:bg-card"
            />
          </div>

          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <select
            aria-label={t('segments.selectLabel')}
            value={segmentId}
            onChange={(e) => selectSegment(e.target.value)}
            className={cn(CHIP, segmentId && CHIP_ON)}
          >
            <option value="">{t('segments.allContacts')}</option>
            {segments.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          {canEdit && selectedSegment && (
            <>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => openSegmentBuilder(selectedSegment)}
                aria-label={t('segments.editSegment')}
                className="text-muted-foreground"
              >
                <Pencil className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={deleteSelectedSegment}
                aria-label={t('segments.deleteSegment')}
                className="text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="size-4" />
              </Button>
            </>
          )}

          <select
            aria-label={t('lists.selectLabel')}
            value={listId}
            onChange={(e) => selectList(e.target.value)}
            className={cn(CHIP, listId && CHIP_ON)}
          >
            <option value="">{t('lists.none')}</option>
            {lists.map((l) => (
              <option key={l.id} value={l.id}>{l.name} ({l.member_count})</option>
            ))}
          </select>
          {canEdit && listId && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={deleteSelectedList}
              aria-label={t('lists.deleteList')}
              className="text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="size-4" />
            </Button>
          )}

          <Popover>
            <PopoverTrigger
              disabled={segmentId !== '' || listId !== ''}
              render={
                <button
                  type="button"
                  className={cn(CHIP, 'inline-flex items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-50', selectedTagIds.length > 0 && CHIP_ON)}
                />
              }
            >
              <Filter className="size-3.5" />
              {t('filterByTags')}
              {selectedTagIds.length > 0 && (
                <span className="inline-flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold tabular-nums text-primary-foreground">
                  {selectedTagIds.length}
                </span>
              )}
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64 p-0">
              <div className="flex items-center justify-between px-3 py-2 border-b border-border">
                <span className="text-sm font-medium text-popover-foreground">
                  {t('filterByTags')}
                </span>
                {selectedTagIds.length > 0 && (
                  <button
                    onClick={clearTagFilters}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    {t('clearAll')}
                  </button>
                )}
              </div>
              {allTags.length === 0 ? (
                <p className="px-3 py-4 text-sm text-muted-foreground text-center">
                  {t('noTagsYet')}
                </p>
              ) : (
                <div className="max-h-64 overflow-y-auto py-1">
                  {tagGroups.map((group) => (
                    <div key={group.category ?? ''}>
                      {/* Headings only once categories are in use. */}
                      {tagGroups.length > 1 && (
                        <p className="px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground">
                          {group.category ?? t('otherTags')}
                        </p>
                      )}
                      {group.tags.map((tag) => (
                        <label
                          key={tag.id}
                          className="flex items-center gap-2.5 px-3 py-1.5 cursor-pointer hover:bg-muted/50"
                        >
                          <Checkbox
                            checked={selectedTagIds.includes(tag.id)}
                            onCheckedChange={() => toggleTagFilter(tag.id)}
                            aria-label={t('filterByTag', { name: tag.name })}
                          />
                          <span
                            className="size-2.5 shrink-0 rounded-full"
                            style={{ backgroundColor: tag.color }}
                          />
                          <span className="text-sm text-popover-foreground truncate">
                            {tag.name}
                          </span>
                        </label>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </PopoverContent>
          </Popover>

          <select
            aria-label={tr('filters.owner')}
            value={ownerFilter}
            onChange={(e) => {
              setOwnerFilter(e.target.value);
              setPage(0);
            }}
            className={cn(CHIP, ownerFilter && CHIP_ON)}
          >
            <option value="">{tr('filters.anyOwner')}</option>
            {members.map((m) => (
              <option key={m.user_id} value={m.user_id}>{m.full_name || tr('owner.unnamedMember')}</option>
            ))}
            <option value="none">{tr('owner.noOne')}</option>
          </select>

          {showChannelFilters && (
            <select
              aria-label={tc('channel')}
              value={channelView}
              onChange={(e) => {
                setChannelView(e.target.value as ChannelView);
                setPage(0);
              }}
              className={cn(CHIP, channelView && CHIP_ON)}
            >
              <option value="">{tc('allChannels')}</option>
              <option value="whatsapp">{tc('hasWhatsApp')}</option>
              <option value="instagram">{tc('hasInstagram')}</option>
            </select>
          )}

          <select
            aria-label={tr('filters.consent')}
            value={consentFilter}
            onChange={(e) => {
              setConsentFilter(e.target.value as ConsentFilter);
              setPage(0);
            }}
            className={cn(CHIP, consentFilter && CHIP_ON)}
          >
            <option value="">{tr('filters.anyConsent')}</option>
            <option value="opted_in">{tr('filters.optedIn')}</option>
            <option value="opted_out">{tr('filters.optedOut')}</option>
          </select>

          {showChannelFilters && (
            <div className="flex h-8 shrink-0 items-center gap-2 rounded-full border border-border bg-card pl-1.5 pr-3">
              <Switch
                id="contacts-subscribed-only"
                checked={subscribedOnly}
                onCheckedChange={(checked) => {
                  setSubscribedOnly(checked === true);
                  setPage(0);
                }}
              />
              <Label htmlFor="contacts-subscribed-only" className="text-[13px] font-normal text-muted-foreground">
                {tc('subscribedOnly')}
              </Label>
            </div>
          )}

          {filtersOn && (
            <button type="button" onClick={clearFilters} className="rounded-md px-1.5 text-[13px] text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
              {tr('filters.clear')}
            </button>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger
              render={<button type="button" className={cn(CHIP, 'ml-auto inline-flex items-center gap-1.5')} aria-label={tr('sort.label', { order: sortLabel(sort.key) })} />}
            >
              <ArrowUpDown className="size-3.5" aria-hidden />
              {sortLabel(sort.key)}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="bg-popover border-border">
              <DropdownMenuRadioGroup value={sort.key} onValueChange={(value) => sortBy(value as ContactSort, defaultDir(value as ContactSort))}>
                {SORTS.map((key) => (
                  <DropdownMenuRadioItem key={key} value={key}>{sortLabel(key)}</DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator className="bg-border" />
              <DropdownMenuItem onClick={() => sortBy(sort.key, sort.dir === 'asc' ? 'desc' : 'asc')}>
                <ArrowUpDown className="size-4" />
                {tr('sort.reverse')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          </div>
        </div>

        {/* Active tag-filter chips */}
        {selectedTagIds.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {selectedTagIds.map((id) => {
              const tag = tagsMap[id];
              if (!tag) return null;
              return (
                <span
                  key={id}
                  className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium"
                  style={{
                    backgroundColor: tag.color + '20',
                    color: tag.color,
                  }}
                >
                  {tag.name}
                  <button
                    onClick={() => toggleTagFilter(id)}
                    aria-label={t('removeTagFilter', { name: tag.name })}
                    className="hover:opacity-70"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              );
            })}
            <button
              onClick={clearTagFilters}
              className="text-xs text-muted-foreground hover:text-foreground px-1"
            >
              {t('clearAll')}
            </button>
          </div>
        )}
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div
          role="toolbar"
          aria-label={t('selectedCount', { count: selectionCount })}
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-primary/10 py-2 pl-4 pr-2"
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-foreground">
            <p className="font-semibold tabular-nums">
              {allMatching
                ? t('allMatchingSelected', { count: totalCount })
                : t('selectedCount', { count: selected.size })}
            </p>
            {!allMatching && allOnPageSelected && totalCount > contacts.length && (
              <button
                type="button"
                onClick={() => setAllMatching(true)}
                className="text-primary underline-offset-2 hover:underline"
              >
                {t('selectAllMatching', { count: totalCount })}
              </button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSelected(new Set());
                setAllMatching(false);
              }}
              className="text-muted-foreground hover:text-foreground"
            >
              {t('clearSelection')}
            </Button>
            {canEdit && allTags.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="outline" size="sm" disabled={listBusy} />}>
                  <TagIcon className="size-4" />
                  {t('addTag')}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto bg-popover border-border">
                  {allTags.map((tag) => (
                    <DropdownMenuItem key={tag.id} onClick={() => addTagToSelected(tag.id)}>
                      <span className="size-2 rounded-full" style={{ backgroundColor: tag.color }} />
                      {tag.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {canEdit && (
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="outline" size="sm" disabled={listBusy} />}>
                  <UserPlus className="size-4" />
                  {tr('bulk.assignOwner')}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto bg-popover border-border">
                  {members.map((m) => (
                    <DropdownMenuItem key={m.user_id} onClick={() => void runStage5Bulk({ type: 'assign_owner', ownerId: m.user_id })}>
                      <UserRound className="size-4" />
                      {m.full_name || tr('owner.unnamedMember')}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator className="bg-border" />
                  <DropdownMenuItem onClick={() => void runStage5Bulk({ type: 'assign_owner', ownerId: null })}>
                    {tr('owner.noOne')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {canEditSettings && canExport && !allMatching && (
              <Button variant="outline" size="sm" disabled={exporting} onClick={() => exportCsv(`ids=${[...selected].join(',')}`)}>
                <Download className="size-4" />
                {tr('bulk.export')}
              </Button>
            )}
            {canEdit && allTags.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="outline" size="sm" disabled={listBusy} />}>
                  <TagIcon className="size-4" />
                  {tb('removeTag')}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto bg-popover border-border">
                  {allTags.map((tag) => (
                    <DropdownMenuItem key={tag.id} onClick={() => void runStage5Bulk({ type: 'remove_tag', tagId: tag.id })}>
                      <span className="size-2 rounded-full" style={{ backgroundColor: tag.color }} />
                      {tag.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {canEdit && (
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="outline" size="sm" disabled={listBusy} />}>
                  <PauseCircle className="size-4" />
                  {tb('pauseAutomations')}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="bg-popover border-border">
                  {PAUSE_MINUTES_CHOICES.map((minutes) => (
                    <DropdownMenuItem key={String(minutes)} onClick={() => void runStage5Bulk({ type: 'pause_automations', minutes })}>
                      {tPause(`choices.${minutes === null ? 'forever' : String(minutes)}`)}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {canEdit && (
              <Button variant="outline" size="sm" disabled={listBusy} onClick={openSetField}>
                <SlidersHorizontal className="size-4" />
                {tb('setField')}
              </Button>
            )}
            {canEdit && instagramOn && (
              <Button variant="outline" size="sm" disabled={listBusy} onClick={() => void runStage5Bulk({ type: 'unsubscribe_instagram' })}>
                <BellOff className="size-4" />
                {tb('unsubscribeInstagram')}
              </Button>
            )}
            {canEdit && listId && (
              <Button variant="outline" size="sm" disabled={listBusy} onClick={() => changeSelectedMembers(listId, 'remove')}>
                <X className="size-4" />
                {t('lists.removeFromList')}
              </Button>
            )}
            {canEdit && lists.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="outline" size="sm" disabled={listBusy} />}>
                  <List className="size-4" />
                  {t('lists.addToList')}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="bg-popover border-border">
                  {lists.map((l) => (
                    <DropdownMenuItem key={l.id} onClick={() => changeSelectedMembers(l.id, 'add')}>
                      {l.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <GatedButton
              variant="destructive"
              size="sm"
              canAct={canEdit}
              gateReason={tGate('reasons.deleteContacts')}
              onClick={() => setBulkDeleteOpen(true)}
            >
              <Trash2 className="size-4" />
              {t('deleteSelected')}
            </GatedButton>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
        <div className="overflow-x-auto">
        <Table className="table-fixed">
          <TableHeader>
            <TableRow className="border-border bg-muted/50 hover:bg-muted/50">
              <TableHead className="h-11 w-12 pl-5">
                <Checkbox
                  checked={allOnPageSelected}
                  indeterminate={!allOnPageSelected && someOnPageSelected}
                  onCheckedChange={toggleSelectAll}
                  disabled={contacts.length === 0}
                  aria-label={t('selectAllOnPage')}
                />
              </TableHead>
              {sortHead('name', t('tableColumns.name'))}
              <TableHead className={cn(TH, 'hidden w-[20%] sm:table-cell')}>{tr('columns.channels')}</TableHead>
              <TableHead className={cn(TH, 'hidden w-[15%] md:table-cell')}>{t('tableColumns.tags')}</TableHead>
              {sortHead('owner', tr('columns.owner'), 'hidden w-[12%] lg:table-cell')}
              {sortHead('city', tr('columns.city'), 'hidden w-[10%] xl:table-cell')}
              {sortHead('seen', tr('columns.lastSeen'), 'hidden w-[10%] xl:table-cell')}
              <TableHead className="w-12"><span className="sr-only">{tr('columns.actions')}</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow className="border-border hover:bg-transparent">
                <TableCell colSpan={8} className="py-16 text-center">
                  <div className="flex flex-col items-center gap-2">
                    <Loader2 className="size-5 animate-spin text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">{t('loading')}</p>
                  </div>
                </TableCell>
              </TableRow>
            ) : contacts.length === 0 ? (
              <TableRow className="border-border hover:bg-transparent">
                <TableCell colSpan={8} className="py-16 text-center whitespace-normal">
                  <div className="flex flex-col items-center gap-3">
                    <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                      {hasActiveFilters ? <Search className="size-5" /> : <Users className="size-5" />}
                    </span>
                    <p className="text-sm text-muted-foreground">
                      {hasActiveFilters
                        ? t('noContactsMatch')
                        : t('noContactsYet')}
                    </p>
                    {hasActiveFilters ? (
                      <Button variant="outline" onClick={() => { clearFilters(); setSearch(''); }}>
                        {tr('filters.clearAll')}
                      </Button>
                    ) : (
                      <GatedButton
                        canAct={canEdit}
                        gateReason={tGate('reasons.addOrImportContacts')}
                        variant="outline"
                        onClick={openAddForm}
                      >
                        <Plus className="size-4" />
                        {t('addFirstContact')}
                      </GatedButton>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              contacts.map((contact) => {
                const label = contact.name || contact.phone || contact.instagram_username || '';
                const sub = contact.email || contact.city || '';
                return (
                <TableRow
                  key={contact.id}
                  data-state={selected.has(contact.id) ? 'selected' : undefined}
                  className="h-16 cursor-pointer border-border transition-colors duration-150 hover:bg-muted/40 data-[state=selected]:bg-primary/5"
                  onClick={() => router.push(`/contacts/${contact.id}`)}
                >
                  <TableCell className="pl-5" onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selected.has(contact.id)}
                      onCheckedChange={() => toggleSelect(contact.id)}
                      aria-label={t('selectContact', { name: label })}
                    />
                  </TableCell>
                  <TableCell className="min-w-0 font-medium text-foreground">
                    <Link
                      href={`/contacts/${contact.id}`}
                      onClick={(e) => e.stopPropagation()}
                      className="flex min-w-0 items-center gap-3 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    >
                      <span
                        aria-hidden
                        className={cn('flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold', avatarTone(label))}
                      >
                        {initials(contact.name)}
                      </span>
                      <span className="flex min-w-0 flex-col">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate text-[14px] font-semibold">
                            {contact.name || <span className="font-normal italic text-muted-foreground">{t('unnamed')}</span>}
                          </span>
                          <LeadScoreCell entry={leadScores[contact.id]} />
                        </span>
                        {sub && <span className="truncate text-xs font-normal text-muted-foreground">{sub}</span>}
                      </span>
                    </Link>
                  </TableCell>
                  <TableCell className="hidden min-w-0 sm:table-cell">
                    <div className="flex min-w-0 flex-col gap-1 text-[13px] text-foreground/80">
                      {contact.phone && (
                        <span className="inline-flex min-w-0 items-center gap-2 tabular-nums">
                          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
                          <span className="truncate">{contact.phone}</span>
                        </span>
                      )}
                      {contact.instagram_username && (
                        <span className="inline-flex min-w-0 items-center gap-2">
                          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-pink-500" />
                          <span className="truncate">@{contact.instagram_username}</span>
                        </span>
                      )}
                      <span className="flex flex-wrap gap-1">
                        {contact.opted_out_at && (
                          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">{tr('badges.optedOut')}</span>
                        )}
                        {contact.blocked_at && (
                          <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive">{tr('badges.blocked')}</span>
                        )}
                        {instagramOn && igStatus[contact.id] && igStatus[contact.id] !== 'none' && (
                          <span
                            data-testid="contact-instagram-status"
                            className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium',
                              igStatus[contact.id] === 'subscribed'
                                ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                                : 'bg-muted text-muted-foreground')}
                          >
                            {tcs('instagram')}: {igStatus[contact.id] === 'subscribed' ? tcs('subscribed') : tcs('unsubscribed')}
                          </span>
                        )}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <div className="flex flex-wrap items-center gap-1">
                      {contact.tags && contact.tags.length > 0 ? (
                        contact.tags.slice(0, 3).map((tag) => (
                          <span
                            key={tag.id}
                            className="inline-flex max-w-full items-center truncate rounded-full px-2.5 py-0.5 text-xs font-medium"
                            style={{
                              backgroundColor: tag.color + '20',
                              color: tag.color,
                            }}
                          >
                            {tag.name}
                          </span>
                        ))
                      ) : (
                        <span aria-hidden className="text-xs text-muted-foreground">—</span>
                      )}
                      {contact.tags && contact.tags.length > 3 && (
                        <span className="text-xs tabular-nums text-muted-foreground">
                          +{contact.tags.length - 3}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="hidden text-[13px] lg:table-cell">
                    {contact.owner_id ? (
                      <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
                        <span aria-hidden className={cn('flex size-5 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold', avatarTone(contact.owner_name || contact.owner_id))}>
                          {initials(contact.owner_name || '')}
                        </span>
                        <span className="truncate">{contact.owner_name || tr('owner.formerMember')}</span>
                      </span>
                    ) : (
                      <span className="text-muted-foreground">{tr('owner.noOne')}</span>
                    )}
                  </TableCell>
                  <TableCell className="hidden truncate text-[13px] text-muted-foreground xl:table-cell">
                    {contact.city || <span aria-hidden>—</span>}
                  </TableCell>
                  <TableCell className="hidden text-[13px] tabular-nums text-muted-foreground xl:table-cell">
                    {contact.last_seen_at ? formatLastSeen(contact.last_seen_at, locale, tr) : <span aria-hidden>—</span>}
                  </TableCell>
                  <TableCell className="pr-3 text-right" onClick={(e) => e.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-muted-foreground hover:text-foreground"
                            aria-label={t('rowActions', { name: label })}
                          />
                        }
                      >
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="end"
                        className="bg-popover border-border"
                      >
                        <DropdownMenuItem onClick={() => router.push(`/contacts/${contact.id}`)}>
                          <UserRound className="size-4" />
                          {tr('row.open')}
                        </DropdownMenuItem>
                        {canEdit && (
                          <DropdownMenuItem onClick={() => router.push(`/contacts/${contact.id}?message=1`)}>
                            <Send className="size-4" />
                            {tr('row.message')}
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem
                          onClick={() => openEditForm(contact)}
                          className="text-popover-foreground focus:bg-muted focus:text-foreground"
                        >
                          <Pencil className="size-4" />
                          {t('editAction')}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator className="bg-border" />
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => confirmDelete(contact)}
                        >
                          <Trash2 className="size-4" />
                          {t('deleteAction')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
        </div>

        {!loading && totalCount > 0 && (
          <TablePagination
            className="border-t border-border"
            page={page}
            totalPages={totalPages}
            onPageChange={setPage}
            summary={t('showingPagination', {
              start: page * PAGE_SIZE + 1,
              end: Math.min((page + 1) * PAGE_SIZE, totalCount),
              total: totalCount
            })}
            labels={{
              nav: t('paginationLabel'),
              previous: t('previousPage'),
              next: t('nextPage'),
              page: (n) => t('goToPage', { page: n }),
            }}
          />
        )}
      </div>
      {/* Contact Form Dialog */}
      <ContactForm
        open={formOpen}
        onOpenChange={setFormOpen}
        contact={editContact}
        contactTags={editContactTags}
        onSaved={() => {
          fetchContacts();
          fetchTags();
        }}
        onViewExisting={(id) => {
          setFormOpen(false);
          router.push(`/contacts/${id}`);
        }}
      />

      {/* Import Modal */}
      <ImportModal
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={fetchContacts}
      />

      <SegmentBuilderDialog
        open={builderOpen}
        onOpenChange={setBuilderOpen}
        segment={editingSegment}
        tags={allTags}
        lists={lists}
        campaigns={campaigns}
        customFields={customFields.map((f) => ({ id: f.id, field_name: f.field_name, field_type: f.field_type, user_id: '', account_id: '', created_at: f.created_at }))}
        onSaved={(saved) => {
          loadSegments();
          if (saved.id === segmentId) fetchContacts();
          else selectSegment(saved.id);
        }}
      />

      {/* New static list */}
      <Dialog open={newListOpen} onOpenChange={setNewListOpen}>
        <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">{t('lists.newTitle')}</DialogTitle>
            <DialogDescription className="text-muted-foreground">{t('lists.newDesc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="list-name" className="text-muted-foreground">{t('lists.nameLabel')}</Label>
            <Input
              id="list-name"
              value={newListName}
              maxLength={100}
              placeholder={t('lists.namePlaceholder')}
              onChange={(e) => setNewListName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newListName.trim()) createList();
              }}
            />
          </div>
          <DialogFooter className="bg-popover border-border">
            <Button variant="outline" onClick={() => setNewListOpen(false)} className="border-border text-muted-foreground hover:bg-muted">
              {t('cancel')}
            </Button>
            <Button onClick={createList} disabled={listBusy || !newListName.trim()}>
              {listBusy && <Loader2 className="size-4 animate-spin" />}
              {t('lists.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">{t('deleteContactTitle')}</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('deleteContactDesc', { name: deleteTarget?.name || deleteTarget?.phone || '' })}
            </DialogDescription>
            {canEditSettings && <p className="text-xs text-muted-foreground">{t('eraseHint')}</p>}
          </DialogHeader>
          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={() => setDeleteConfirmOpen(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            {canEditSettings && (
              <Button variant="outline" onClick={handleErase} disabled={deleting} className="border-destructive text-destructive">
                {t('eraseBtn')}
              </Button>
            )}
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting && <Loader2 className="size-4 animate-spin" />}
              {t('deleteBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Set a custom field on the selection (checked against the field's type) */}
      <Dialog open={setFieldOpen} onOpenChange={setSetFieldOpen}>
        <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">{tb('setField')}</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {tb('confirm', { count: selectionCount })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="bulk-field" className="text-muted-foreground">{tb('field')}</Label>
              <select
                id="bulk-field"
                value={bulkFieldId}
                onChange={(e) => {
                  setBulkFieldId(e.target.value);
                  setBulkFieldValue('');
                }}
                className={FIELD_SELECT}
              >
                <option value="">{tb('chooseField')}</option>
                {customFields.map((f) => (
                  <option key={f.id} value={f.id}>{f.field_name}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bulk-field-value" className="text-muted-foreground">{tb('value')}</Label>
              <CustomFieldInput
                id="bulk-field-value"
                type={bulkField?.field_type ?? 'text'}
                choices={bulkField?.choices ?? []}
                value={bulkFieldValue}
                onChange={setBulkFieldValue}
                disabled={!bulkField}
              />
            </div>
          </div>
          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={() => setSetFieldOpen(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button
              disabled={listBusy || !bulkFieldId || !bulkFieldValue.trim()}
              onClick={async () => {
                const ok = await runStage5Bulk({ type: 'set_field', fieldId: bulkFieldId, value: bulkFieldValue.trim() }, true);
                if (ok) setSetFieldOpen(false);
              }}
            >
              {listBusy && <Loader2 className="size-4 animate-spin" />}
              {tb('apply')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Delete Confirmation */}
      <Dialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {t('deleteBulkTitle')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('deleteBulkDesc', { count: selectionCount })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={() => setBulkDeleteOpen(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleBulkDelete}
              disabled={deleting}
            >
              {deleting && <Loader2 className="size-4 animate-spin" />}
              {t('deleteBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
