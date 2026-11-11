'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { createClient } from '@/lib/data/client';
import { toast } from 'sonner';
import type { Contact, Tag, ContactTag, CustomField } from '@/types';
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
  ChevronLeft,
  ChevronRight,
  SlidersHorizontal,
  Filter,
  ListFilter,
  Download,
  List,
  X,
  Tag as TagIcon,
  PauseCircle,
  BellOff,
} from 'lucide-react';
import { authFetch } from '@/lib/auth/client';
import { changeListMembers, fetchLists, fetchSegments, type ListSummary, type SegmentSummary } from '@/lib/audience/client';
import { groupTagsByCategory } from '@/lib/contacts/tag-groups';
import { contactSearchFilter } from '@/lib/contacts/search-term';
import { Label } from '@/components/ui/label';
import { planAllows, usePlan } from '@/lib/billing/client';
import { UpgradeBadge } from '@/components/ui/upgrade-badge';
import { SegmentBuilderDialog } from '@/components/contacts/segment-builder-dialog';
import { ContactForm } from '@/components/contacts/contact-form';
import { ContactDetailView } from '@/components/contacts/contact-detail-view';
import { ImportModal } from '@/components/contacts/import-modal';
import { CustomFieldsManager } from '@/components/contacts/custom-fields-manager';
import { LeadScoreCell, useLeadScores } from '@/components/contacts/lead-score-cell';
import { useCan } from '@/hooks/use-can';
import { useWorkspaceChannels } from '@/hooks/use-workspace-channels';
import { GatedButton } from '@/components/ui/gated-button';
import { Switch } from '@/components/ui/switch';
import { useTranslations } from 'next-intl';
import { PAUSE_MINUTES_CHOICES } from '@/lib/flows/types';

const PAGE_SIZE = 25;

interface ContactWithTags extends Contact {
  tags?: Tag[];
}

/** Stage 5: the contacts page's channel filter ('' is every contact). */
type ChannelView = '' | 'whatsapp' | 'instagram';
type InstagramStatus = 'subscribed' | 'unsubscribed' | 'none';

/** The Stage 5 bulk actions (POST /api/contacts/bulk, src/lib/contacts/bulk.ts). */
type Stage5BulkAction =
  | { type: 'remove_tag'; tagId: string }
  | { type: 'unsubscribe_instagram' }
  | { type: 'pause_automations'; minutes: number | null }
  | { type: 'set_field'; fieldId: string; value: string };

export default function ContactsPage() {
  const t = useTranslations('Contacts.page');
  const tGate = useTranslations('GatedButton');
  const db = createClient();
  const canEdit = useCan('send-messages');
  const canEditSettings = useCan('edit-settings');
  const canExport = planAllows(usePlan(), 'contact_export');

  const [contacts, setContacts] = useState<ContactWithTags[]>([]);
  // Advisory AI lead scores for the contacts on screen (agents and above).
  const leadScores = useLeadScores(contacts.map((c) => c.id));
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  // Tag filter — contacts shown must have ANY of these tags (OR).
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  // Saved segment view; replaces the tag filter while active.
  const [segments, setSegments] = useState<SegmentSummary[]>([]);
  const [segmentId, setSegmentId] = useState('');
  const [builderOpen, setBuilderOpen] = useState(false);
  const [editingSegment, setEditingSegment] = useState<SegmentSummary | null>(null);
  // Static list view; like a segment, it replaces the tag filter.
  const [lists, setLists] = useState<ListSummary[]>([]);
  const [listId, setListId] = useState('');
  const [newListOpen, setNewListOpen] = useState(false);
  const [newListName, setNewListName] = useState('');
  const [listBusy, setListBusy] = useState(false);
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [campaigns, setCampaigns] = useState<{ id: string; name: string }[]>([]);
  const [exporting, setExporting] = useState(false);

  // Modals
  const [formOpen, setFormOpen] = useState(false);
  const [editContact, setEditContact] = useState<Contact | null>(null);
  const [editContactTags, setEditContactTags] = useState<ContactTag[]>([]);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailContactId, setDetailContactId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [customFieldsOpen, setCustomFieldsOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Contact | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Bulk selection: rows ticked on this page, or (allMatching) every
  // contact matching the current view, acted on server-side by filter.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  // Stage 5: channel filter, "subscribed only" and the Instagram status column, offered
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
  // results. Without this, rapidly toggling tag filters could let a slower
  // earlier request resolve last and render stale rows.
  const fetchSeq = useRef(0);

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

    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    const term = search.trim();

    let contactRows: Contact[];
    let count: number;

    if (channelView || subscribedOnly) {
      // Stage 5: the channel filter lists exactly what a bulk action on this view reaches.
      const query = new URLSearchParams({ offset: String(from), limit: String(PAGE_SIZE) });
      if (segmentId) query.set('segmentId', segmentId);
      else if (listId) query.set('listId', listId);
      else if (selectedTagIds.length) query.set('tagIds', selectedTagIds.join(','));
      if (term) query.set('search', term.slice(0, 200));
      if (channelView) query.set('channel', channelView);
      if (subscribedOnly) query.set('subscribed', '1');
      const res = await authFetch(`/api/contacts/bulk/view?${query}`, { cache: 'no-store' }).catch(() => null);
      if (seq !== fetchSeq.current) return;
      if (!res?.ok) {
        toast.error(t('toastFailedLoad'));
        setLoading(false);
        return;
      }
      const payload = (await res.json()) as { contacts: Contact[]; total: number };
      if (seq !== fetchSeq.current) return;
      contactRows = payload.contacts;
      count = payload.total;
    } else if (segmentId || listId) {
      const query = new URLSearchParams({ offset: String(from), limit: String(PAGE_SIZE), search: term });
      const path = segmentId ? `/api/segments/${segmentId}/contacts` : `/api/lists/${listId}/contacts`;
      const res = await authFetch(`${path}?${query}`, { cache: 'no-store' }).catch(() => null);
      if (seq !== fetchSeq.current) return; // superseded by a newer fetch
      if (!res?.ok) {
        toast.error(t('toastFailedLoad'));
        setLoading(false);
        return;
      }
      const payload = (await res.json()) as { contacts: Contact[]; total: number };
      if (seq !== fetchSeq.current) return;
      contactRows = payload.contacts;
      count = payload.total;
    } else if (selectedTagIds.length > 0) {
      // Tag filter active — resolve it server-side (join + distinct +
      // windowed total count + pagination) so a tag covering many
      // contacts can't silently truncate the result or overflow an IN
      // clause. See migration 025_filter_contacts_by_tags.
      const { data, error } = await db.rpc('filter_contacts_by_tags', {
        p_tag_ids: selectedTagIds,
        p_search: term || null,
        p_limit: PAGE_SIZE,
        p_offset: from,
      });
      if (seq !== fetchSeq.current) return; // superseded by a newer fetch
      if (error) {
        toast.error(t('toastFailedLoad'));
        setLoading(false);
        return;
      }
      const rows = (data ?? []) as { contact: Contact; total_count: number }[];
      contactRows = rows.map((r) => r.contact);
      count = rows.length > 0 ? Number(rows[0].total_count) : 0;
    } else {
      let query = db
        .from('contacts')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(from, to);

      if (term) query = query.or(contactSearchFilter(term));

      const { data, count: exactCount, error } = await query;
      if (seq !== fetchSeq.current) return; // superseded by a newer fetch
      if (error) {
        toast.error(t('toastFailedLoad'));
        setLoading(false);
        return;
      }
      contactRows = data ?? [];
      count = exactCount ?? 0;
    }

    setTotalCount(count);

    if (contactRows.length === 0) {
      setContacts([]);
      setLoading(false);
      return;
    }

    // Fetch tags for these contacts
    const contactIds = contactRows.map((c) => c.id);
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

    const enriched: ContactWithTags[] = contactRows.map((c) => ({
      ...c,
      tags: (tagsByContact[c.id] ?? [])
        .map((tid) => tagsMap[tid])
        .filter(Boolean),
    }));

    setContacts(enriched);
    setLoading(false);
  }, [db, page, search, selectedTagIds, segmentId, listId, tagsMap, t, channelView, subscribedOnly]);

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
        // The column is informational; it shows a dash without it.
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

  /**
   * Run a bulk action on every contact matching the current view. Returns
   * null (after telling the user) when it did not run; the server refuses
   * with 409 when the match count is no longer the one on screen.
   */
  async function runBulk(
    action: { type: 'add_to_list' | 'remove_from_list'; listId: string } | { type: 'add_tag'; tagId: string } | { type: 'delete' } | Stage5BulkAction,
    /** Stage 5: act on these ticked rows instead of the whole view. */
    contactIds?: string[],
  ) {
    const term = search.trim();
    const scope = contactIds
      ? { contactIds }
      : {
          ...(segmentId ? { segmentId } : listId ? { listId } : selectedTagIds.length ? { tagIds: selectedTagIds } : {}),
          ...(term ? { search: term.slice(0, 200) } : {}),
          ...(channelView ? { channel: channelView } : {}),
          ...(subscribedOnly ? { subscribedOnly: true } : {}),
        };
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
    if (customFields.length === 0) {
      const { data } = await db.from('custom_fields').select('*').order('field_name');
      setCustomFields(data ?? []);
    }
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

  async function exportCsv() {
    setExporting(true);
    try {
      const res = await authFetch(`/api/contacts/export${segmentId ? `?segmentId=${segmentId}` : listId ? `?listId=${listId}` : ''}`);
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('segments.exportFailed'));
        return;
      }
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'contacts.csv';
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error(t('segments.exportFailed'));
    } finally {
      setExporting(false);
    }
  }

  // Load-once-on-mount-ish data fetches. Each setter inside runs
  // inside an async promise completion (Supabase await), not
  // synchronously in the effect body, so the cascade the lint rule
  // warns about doesn't apply here.
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

  function openDetail(contactId: string) {
    setDetailContactId(contactId);
    setDetailOpen(true);
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
   * Stage 5 bulk actions (remove a tag, unsubscribe from Instagram, pause
   * automations, set a custom field): every matching contact, or the ticked
   * rows. Always server-side, with the same count check as the others.
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

  async function openSetField() {
    if (customFields.length === 0) {
      const { data } = await db.from('custom_fields').select('*').order('field_name');
      setCustomFields(data ?? []);
    }
    setBulkFieldId('');
    setBulkFieldValue('');
    setSetFieldOpen(true);
  }

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const hasNext = page < totalPages - 1;
  const hasPrev = page > 0;

  // Tag filter helpers. Every change resets to page 0 — the result set
  // shrinks/grows so page N may no longer be valid (mirrors the search box).
  const allTags = Object.values(tagsMap).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  const tagGroups = groupTagsByCategory(allTags);
  const hasActiveFilters = search.trim().length > 0 || selectedTagIds.length > 0 || segmentId !== '' || listId !== ''
    || channelView !== '' || subscribedOnly;
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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {totalCount > 0 ? t('subtitle', { count: totalCount }) : t('subtitleZero')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canEditSettings && !canExport && <UpgradeBadge />}
          {canEditSettings && (
            <Button
              variant="outline"
              onClick={exportCsv}
              disabled={exporting || !canExport}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {exporting ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
              {segmentId ? t('segments.exportSegment') : listId ? t('lists.exportList') : t('segments.exportAll')}
            </Button>
          )}
          {canEditSettings && (
            <Button
              variant="outline"
              onClick={() => setCustomFieldsOpen(true)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              <SlidersHorizontal className="size-4" />
              {t('customFieldsBtn')}
            </Button>
          )}
          <GatedButton
            variant="outline"
            canAct={canEdit}
            gateReason={tGate('reasons.addOrImportContacts')}
            onClick={() => setImportOpen(true)}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            <Upload className="size-4" />
            {t('importBtn')}
          </GatedButton>
          <GatedButton
            canAct={canEdit}
            gateReason={tGate('reasons.addOrImportContacts')}
            onClick={openAddForm}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            <Plus className="size-4" />
            {t('addContactBtn')}
          </GatedButton>
        </div>
      </div>

      {/* Search + tag filter */}
      <div className="space-y-2">
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative w-full max-w-sm">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                // Reset pagination when the query changes — the result
                // set shrinks/grows, page N may no longer be valid.
                setPage(0);
              }}
              placeholder={t('searchPlaceholder')}
              className="pl-8 bg-card border-border text-foreground placeholder:text-muted-foreground"
            />
          </div>

          <select
            aria-label={t('segments.selectLabel')}
            value={segmentId}
            onChange={(e) => selectSegment(e.target.value)}
            className="h-9 shrink-0 rounded-md border border-border bg-card px-2 text-sm text-foreground"
          >
            <option value="">{t('segments.allContacts')}</option>
            {segments.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          {canEdit && (
            <Button
              variant="outline"
              onClick={() => openSegmentBuilder(null)}
              className="border-border text-muted-foreground hover:bg-muted shrink-0"
            >
              <ListFilter className="size-4" />
              {t('segments.newSegment')}
            </Button>
          )}
          {canEdit && selectedSegment && (
            <>
              <Button
                variant="outline"
                onClick={() => openSegmentBuilder(selectedSegment)}
                aria-label={t('segments.editSegment')}
                className="border-border text-muted-foreground hover:bg-muted shrink-0"
              >
                <Pencil className="size-4" />
              </Button>
              <Button
                variant="outline"
                onClick={deleteSelectedSegment}
                aria-label={t('segments.deleteSegment')}
                className="border-border text-muted-foreground hover:bg-muted shrink-0"
              >
                <Trash2 className="size-4" />
              </Button>
            </>
          )}

          <select
            aria-label={t('lists.selectLabel')}
            value={listId}
            onChange={(e) => selectList(e.target.value)}
            className="h-9 shrink-0 rounded-md border border-border bg-card px-2 text-sm text-foreground"
          >
            <option value="">{t('lists.none')}</option>
            {lists.map((l) => (
              <option key={l.id} value={l.id}>{l.name} ({l.member_count})</option>
            ))}
          </select>
          {canEdit && (
            <Button
              variant="outline"
              onClick={() => setNewListOpen(true)}
              className="border-border text-muted-foreground hover:bg-muted shrink-0"
            >
              <List className="size-4" />
              {t('lists.newList')}
            </Button>
          )}
          {canEdit && listId && (
            <Button
              variant="outline"
              onClick={deleteSelectedList}
              aria-label={t('lists.deleteList')}
              className="border-border text-muted-foreground hover:bg-muted shrink-0"
            >
              <Trash2 className="size-4" />
            </Button>
          )}

          <Popover>
            <PopoverTrigger
              disabled={segmentId !== '' || listId !== ''}
              render={
                <Button
                  variant="outline"
                  className="border-border text-muted-foreground hover:bg-muted shrink-0"
                />
              }
            >
              <Filter className="size-4" />
              {t('filterByTags')}
              {selectedTagIds.length > 0 && (
                <span className="ml-1 inline-flex items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
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
                        <p className="px-3 pt-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
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

          {showChannelFilters && (
            <>
              <select
                aria-label={tc('channel')}
                value={channelView}
                onChange={(e) => {
                  setChannelView(e.target.value as ChannelView);
                  setPage(0);
                }}
                className="h-9 shrink-0 rounded-md border border-border bg-card px-2 text-sm text-foreground"
              >
                <option value="">{tc('allChannels')}</option>
                <option value="whatsapp">{tc('hasWhatsApp')}</option>
                <option value="instagram">{tc('hasInstagram')}</option>
              </select>
              <div className="flex shrink-0 items-center gap-2">
                <Switch
                  id="contacts-subscribed-only"
                  checked={subscribedOnly}
                  onCheckedChange={(checked) => {
                    setSubscribedOnly(checked === true);
                    setPage(0);
                  }}
                />
                <Label htmlFor="contacts-subscribed-only" className="text-sm text-muted-foreground">
                  {tc('subscribedOnly')}
                </Label>
              </div>
            </>
          )}
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
                  className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
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
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border bg-muted/40 px-4 py-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-foreground">
            <p>
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
              <Button variant="outline" size="sm" disabled={listBusy} onClick={() => void openSetField()}>
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
      <div className="rounded-lg border border-border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="border-border hover:bg-transparent">
              <TableHead className="w-10">
                <Checkbox
                  checked={allOnPageSelected}
                  indeterminate={!allOnPageSelected && someOnPageSelected}
                  onCheckedChange={toggleSelectAll}
                  disabled={contacts.length === 0}
                  aria-label={t('selectAllOnPage')}
                />
              </TableHead>
              <TableHead className="text-muted-foreground">{t('tableColumns.name')}</TableHead>
              <TableHead className="text-muted-foreground">{t('tableColumns.phone')}</TableHead>
              <TableHead className="text-muted-foreground hidden md:table-cell">{t('tableColumns.email')}</TableHead>
              <TableHead className="text-muted-foreground hidden lg:table-cell">{t('tableColumns.company')}</TableHead>
              {instagramOn && (
                <TableHead className="text-muted-foreground hidden md:table-cell">{tcs('instagram')}</TableHead>
              )}
              <TableHead className="text-muted-foreground hidden md:table-cell">{t('tableColumns.tags')}</TableHead>
              <TableHead className="text-muted-foreground hidden lg:table-cell">{t('tableColumns.createdAt')}</TableHead>
              <TableHead className="text-muted-foreground w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow className="border-border">
                <TableCell colSpan={instagramOn ? 9 : 8} className="text-center py-12">
                  <div className="flex flex-col items-center gap-2">
                    <Loader2 className="size-6 animate-spin text-primary" />
                    <p className="text-sm text-muted-foreground">{t('loading')}</p>
                  </div>
                </TableCell>
              </TableRow>
            ) : contacts.length === 0 ? (
              <TableRow className="border-border">
                <TableCell colSpan={instagramOn ? 9 : 8} className="text-center py-12">
                  <div className="flex flex-col items-center gap-2">
                    <Users className="size-8 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">
                      {hasActiveFilters
                        ? t('noContactsMatch')
                        : t('noContactsYet')}
                    </p>
                    {!hasActiveFilters && (
                      <GatedButton
                        canAct={canEdit}
                        gateReason={tGate('reasons.addOrImportContacts')}
                        variant="outline"
                        size="sm"
                        onClick={openAddForm}
                        className="mt-2 border-border text-muted-foreground hover:bg-muted"
                      >
                        <Plus className="size-3.5" />
                        {t('addFirstContact')}
                      </GatedButton>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              contacts.map((contact) => (
                <TableRow
                  key={contact.id}
                  className="border-border hover:bg-muted/50 cursor-pointer"
                  onClick={() => openDetail(contact.id)}
                >
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selected.has(contact.id)}
                      onCheckedChange={() => toggleSelect(contact.id)}
                      aria-label={t('selectContact', { name: contact.name || contact.phone })}
                    />
                  </TableCell>
                  <TableCell className="text-foreground font-medium">
                    {contact.name || <span className="text-muted-foreground italic">{t('unnamed')}</span>}
                    <LeadScoreCell entry={leadScores[contact.id]} />
                  </TableCell>
                  <TableCell className="text-muted-foreground font-mono text-xs">
                    {contact.phone}
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden md:table-cell text-sm">
                    {contact.email || <span className="text-muted-foreground">-</span>}
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden lg:table-cell text-sm">
                    {contact.company || <span className="text-muted-foreground">-</span>}
                  </TableCell>
                  {instagramOn && (
                    <TableCell className="hidden md:table-cell text-xs" data-testid="contact-instagram-status">
                      {igStatus[contact.id] === 'subscribed' ? (
                        <span className="text-foreground">{tcs('subscribed')}</span>
                      ) : igStatus[contact.id] === 'unsubscribed' ? (
                        <span className="text-muted-foreground">{tcs('unsubscribed')}</span>
                      ) : (
                        <span className="text-muted-foreground">{tcs('none')}</span>
                      )}
                    </TableCell>
                  )}
                  <TableCell className="hidden md:table-cell">
                    <div className="flex flex-wrap gap-1">
                      {contact.tags && contact.tags.length > 0 ? (
                        contact.tags.slice(0, 3).map((tag) => (
                          <span
                            key={tag.id}
                            className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium"
                            style={{
                              backgroundColor: tag.color + '20',
                              color: tag.color,
                            }}
                          >
                            {tag.name}
                          </span>
                        ))
                      ) : (
                        <span className="text-muted-foreground text-xs">-</span>
                      )}
                      {contact.tags && contact.tags.length > 3 && (
                        <span className="text-[10px] text-muted-foreground">
                          +{contact.tags.length - 3}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs hidden lg:table-cell">
                    {new Date(contact.created_at).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-muted-foreground hover:text-foreground"
                            onClick={(e) => e.stopPropagation()}
                            aria-label={t('rowActions', { name: contact.name || contact.phone })}
                          />
                        }
                      >
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="end"
                        className="bg-popover border-border"
                      >
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation();
                            openEditForm(contact);
                          }}
                          className="text-popover-foreground focus:bg-muted focus:text-foreground"
                        >
                          <Pencil className="size-4" />
                          {t('editAction')}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator className="bg-border" />
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={(e) => {
                            e.stopPropagation();
                            confirmDelete(contact);
                          }}
                        >
                          <Trash2 className="size-4" />
                          {t('deleteAction')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {t('showingPagination', {
              start: page * PAGE_SIZE + 1,
              end: Math.min((page + 1) * PAGE_SIZE, totalCount),
              total: totalCount
            })}
          </p>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon-sm"
              disabled={!hasPrev}
              onClick={() => setPage((p) => p - 1)}
              aria-label={t('previousPage')}
              className="border-border text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span className="text-xs text-muted-foreground px-2">
              {t('pageCount', { page: page + 1, total: totalPages })}
            </span>
            <Button
              variant="outline"
              size="icon-sm"
              disabled={!hasNext}
              onClick={() => setPage((p) => p + 1)}
              aria-label={t('nextPage')}
              className="border-border text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      )}

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
          openDetail(id);
        }}
      />

      {/* Contact Detail Sheet */}
      <ContactDetailView
        open={detailOpen}
        onOpenChange={setDetailOpen}
        contactId={detailContactId}
        onUpdated={fetchContacts}
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
        customFields={customFields}
        onSaved={(saved) => {
          loadSegments();
          if (saved.id === segmentId) fetchContacts();
          else selectSegment(saved.id);
        }}
      />

      {/* Custom Fields Manager (admin+) */}
      {canEditSettings && (
        <CustomFieldsManager
          open={customFieldsOpen}
          onOpenChange={setCustomFieldsOpen}
        />
      )}

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

      {/* Stage 5: set a custom field on the selection */}
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
                onChange={(e) => setBulkFieldId(e.target.value)}
                className="h-9 w-full rounded-md border border-border bg-card px-2 text-sm text-foreground"
              >
                <option value="">{tb('chooseField')}</option>
                {customFields.map((f) => (
                  <option key={f.id} value={f.id}>{f.field_name}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bulk-field-value" className="text-muted-foreground">{tb('value')}</Label>
              <Input
                id="bulk-field-value"
                value={bulkFieldValue}
                maxLength={1000}
                onChange={(e) => setBulkFieldValue(e.target.value)}
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
