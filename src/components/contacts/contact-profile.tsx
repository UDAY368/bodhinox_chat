'use client';

// The full-page contact profile (/contacts/[id]). Header with Message, Edit,
// Delete and More (copy, export, block). Left: Details and Custom fields that
// save one field at a time as they are edited, Notes and the Timeline. Right:
// Labels, Messaging consent per channel (plus Instagram identities), the
// contact's Conversations, Orders and Deals. Keeps every capability of the old
// side panel: consent, erase, send a template, deals, tags, notes, custom fields.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { useLocale, useTranslations } from 'next-intl';
import {
  ArrowLeft, Ban, Check, Copy, Download, Loader2, MessageSquare, MoreHorizontal, Pencil, Plus, Send, ShoppingBag, Tag as TagIcon,
  Trash2, UserRound, X, Inbox, FileText, ShieldCheck, Upload, CircleDot,
} from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { TemplatePicker, type TemplateSendValues } from '@/components/inbox/template-picker';
import { authFetch } from '@/lib/auth/client';
import { createClient } from '@/lib/data/client';
import { addContactTag, deleteContactTag } from '@/lib/contacts/tag-api';
import { formatCurrency } from '@/lib/currency';
import { formatMoney } from '@/lib/commerce/money';
import { conversationInboxPath } from '@/lib/inbox/inbox-scope';
import { MASK_CHAR } from '@/lib/inbox/masking';
import { planAllows, usePlan } from '@/lib/billing/client';
import { avatarTone, initials } from '@/lib/ui/avatar-tone';
import { contactHandle } from '@/lib/whatsapp/wa-identity';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { useWorkspaceChannels } from '@/hooks/use-workspace-channels';
import type { ContactOverview, TimelineEvent } from '@/lib/contacts/profile';
import type { Channel, Contact, ContactNote, Deal, MessageTemplate, Tag } from '@/types';
import { ContactForm } from './contact-form';
import { ContactIdentities } from './contact-identities';
import { InstagramFacts } from './instagram-facts';
import { CustomFieldInput, FIELD_SELECT } from './custom-field-input';
import { downloadContactsCsv, memberName, saveContactField, useContactMembers, useCustomFields } from './contacts-client';
import { formatDay, formatLastSeen, formatWhen } from './format';

const CARD = 'min-w-0 rounded-2xl border border-border bg-card p-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)] sm:p-5';
const CARD_TITLE = 'text-[15px] font-semibold text-foreground';
const INLINE = 'h-9 border-transparent bg-muted text-sm text-foreground transition-colors duration-150 hover:border-border focus-visible:bg-card';
const TIMELINE_PREVIEW = 5;

type DetailKey = 'name' | 'phone' | 'email' | 'company' | 'city';
const DETAIL_KEYS: DetailKey[] = ['name', 'phone', 'email', 'company', 'city'];

export function ContactProfile({ contactId }: { contactId: string }) {
  const t = useTranslations('Contacts.redesign');
  const tp = useTranslations('Contacts.page');
  const td = useTranslations('Contacts.detailView');
  const locale = useLocale();
  const router = useRouter();
  const searchParams = useSearchParams();
  const db = createClient();
  const { accountId, defaultCurrency } = useAuth();
  const canEdit = useCan('send-messages');
  const canEditSettings = useCan('edit-settings');
  const plan = usePlan();
  const canExport = canEditSettings && planAllows(plan, 'contact_export');
  const members = useContactMembers();
  const { fields: customFields } = useCustomFields();
  const { data: channels } = useWorkspaceChannels();
  const enabledChannels: Channel[] = useMemo(() => (channels?.enabled ?? ['whatsapp']) as Channel[], [channels]);

  const [contact, setContact] = useState<Contact | null>(null);
  const [missing, setMissing] = useState(false);
  const [draft, setDraft] = useState<Record<DetailKey, string>>({ name: '', phone: '', email: '', company: '', city: '' });
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<DetailKey | 'owner', string>>>({});
  const [overview, setOverview] = useState<ContactOverview | null>(null);
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [savingTag, setSavingTag] = useState(false);
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [newNote, setNewNote] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [noteToDelete, setNoteToDelete] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [savedValues, setSavedValues] = useState<Record<string, string>>({});
  const [valueErrors, setValueErrors] = useState<Record<string, string>>({});
  const [deals, setDeals] = useState<Deal[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [savingConsent, setSavingConsent] = useState<string | null>(null);
  const [optInAsk, setOptInAsk] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [igOnlyOpen, setIgOnlyOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const messageAsked = useRef(false);

  const phoneMasked = !!contact?.phone?.includes(MASK_CHAR);

  const loadContact = useCallback(async () => {
    const { data } = await db.from('contacts').select('*').eq('id', contactId).maybeSingle();
    if (!data) {
      setMissing(true);
      return;
    }
    const row = data as Contact;
    setContact(row);
    setDraft({ name: row.name ?? '', phone: row.phone ?? '', email: row.email ?? '', company: row.company ?? '', city: row.city ?? '' });
  }, [contactId, db]);

  const loadOverview = useCallback(async () => {
    const res = await authFetch(`/api/contacts/${encodeURIComponent(contactId)}`, { cache: 'no-store' }).catch(() => null);
    if (res?.ok) {
      const body = (await res.json()) as ContactOverview;
      setOverview(body);
      return body;
    }
    return null;
  }, [contactId]);

  const loadTags = useCallback(async () => {
    const [tags, links] = await Promise.all([
      db.from('tags').select('*').order('name'),
      db.from('contact_tags').select('tag_id').eq('contact_id', contactId),
    ]);
    setAllTags((tags.data ?? []) as Tag[]);
    setTagIds((links.data ?? []).map((l: { tag_id: string }) => l.tag_id));
  }, [contactId, db]);

  const loadNotes = useCallback(async () => {
    const { data } = await db.from('contact_notes').select('*').eq('contact_id', contactId).order('created_at', { ascending: false });
    setNotes((data ?? []) as ContactNote[]);
  }, [contactId, db]);

  const loadValues = useCallback(async () => {
    const { data } = await db.from('contact_custom_values').select('*').eq('contact_id', contactId);
    const map: Record<string, string> = {};
    (data ?? []).forEach((v: { custom_field_id: string; value?: string | null }) => {
      map[v.custom_field_id] = v.value ?? '';
    });
    setValues(map);
    setSavedValues(map);
  }, [contactId, db]);

  const loadDeals = useCallback(async () => {
    const { data } = await db.from('deals').select('*, stage:pipeline_stages(*)').eq('contact_id', contactId).order('created_at', { ascending: false });
    setDeals((data ?? []) as Deal[]);
  }, [contactId, db]);

  useEffect(() => {
    void loadContact();
    void loadOverview();
    void loadTags();
    void loadNotes();
    void loadValues();
    void loadDeals();
  }, [loadContact, loadOverview, loadTags, loadNotes, loadValues, loadDeals]);

  const refreshAfterChange = useCallback(() => {
    void loadOverview();
  }, [loadOverview]);

  const errorText = (code: string) => {
    const known = ['too_long', 'invalid_email', 'invalid_phone', 'duplicate_phone', 'phone_masked', 'phone_required', 'not_member',
      'not_a_number', 'not_a_date', 'not_a_choice', 'field_not_found'];
    return known.includes(code) ? t(`profile.errors.${code}`) : t('profile.errors.failed');
  };

  async function saveDetail(key: DetailKey) {
    if (!contact || !canEdit) return;
    const value = draft[key].trim();
    if (value === (contact[key] ?? '')) return;
    if (key === 'phone' && phoneMasked) return;
    setFieldErrors((prev) => ({ ...prev, [key]: undefined }));
    const saved = await saveContactField(contact.id, { field: key, value });
    if (!saved.ok) {
      setFieldErrors((prev) => ({ ...prev, [key]: errorText(saved.code) }));
      return;
    }
    const row = saved.data.contact as Partial<Contact>;
    setContact((prev) => (prev ? { ...prev, ...row } : prev));
    setDraft((prev) => ({ ...prev, [key]: (row[key] as string | null | undefined) ?? '' }));
    toast.success(t('profile.saved'));
    refreshAfterChange();
  }

  async function saveOwner(ownerId: string) {
    if (!contact) return;
    setFieldErrors((prev) => ({ ...prev, owner: undefined }));
    const saved = await saveContactField(contact.id, { field: 'owner_id', value: ownerId });
    if (!saved.ok) {
      setFieldErrors((prev) => ({ ...prev, owner: errorText(saved.code) }));
      return;
    }
    setContact((prev) => (prev ? { ...prev, owner_id: ownerId || null } : prev));
    toast.success(t('profile.saved'));
    refreshAfterChange();
  }

  async function saveValue(fieldId: string, value: string) {
    if (!contact || !canEdit) return;
    if (value.trim() === (savedValues[fieldId] ?? '')) return;
    setValueErrors((prev) => ({ ...prev, [fieldId]: '' }));
    const saved = await saveContactField(contact.id, { customFieldId: fieldId, value });
    if (!saved.ok) {
      setValueErrors((prev) => ({ ...prev, [fieldId]: errorText(saved.code) }));
      return;
    }
    const stored = String(saved.data.value ?? '');
    setValues((prev) => ({ ...prev, [fieldId]: stored }));
    setSavedValues((prev) => ({ ...prev, [fieldId]: stored }));
    toast.success(t('profile.saved'));
    refreshAfterChange();
  }

  async function setBlocked(on: boolean) {
    if (!contact) return;
    const saved = await saveContactField(contact.id, { field: 'blocked', value: on });
    if (!saved.ok) {
      toast.error(td('toastUpdateFailed'));
      return;
    }
    const row = saved.data.contact as Partial<Contact>;
    setContact((prev) => (prev ? { ...prev, blocked_at: row.blocked_at ?? null } : prev));
    toast.success(on ? t('profile.blockedToast', { name: firstName }) : t('profile.unblockedToast', { name: firstName }));
    refreshAfterChange();
  }

  async function setConsent(channel: 'whatsapp' | 'instagram', state: 'opted_in' | 'opted_out' | 'cleared') {
    if (!contact) return;
    setSavingConsent(channel);
    const res = await authFetch(`/api/contacts/${encodeURIComponent(contact.id)}/consent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, channel }),
    }).catch(() => null);
    setSavingConsent(null);
    const data = res?.ok ? ((await res.json()) as { contact: Partial<Contact> }) : null;
    if (!data) {
      toast.error(td('toastUpdateFailed'));
      return;
    }
    setContact((prev) => (prev ? { ...prev, ...data.contact } : prev));
    refreshAfterChange();
  }

  async function toggleTag(tagId: string) {
    if (!contact) return;
    setSavingTag(true);
    try {
      if (tagIds.includes(tagId)) {
        await deleteContactTag(contact.id, tagId);
        setTagIds((prev) => prev.filter((id) => id !== tagId));
      } else {
        await addContactTag(contact.id, tagId);
        setTagIds((prev) => [...prev, tagId]);
      }
      refreshAfterChange();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : td('toastUpdateFailed'));
    } finally {
      setSavingTag(false);
    }
  }

  async function addNote() {
    if (!contact || !newNote.trim()) return;
    setSavingNote(true);
    const { data: { session } } = await db.auth.getSession();
    if (!session?.user || !accountId) {
      toast.error(td('toastNotAuthenticated'));
      setSavingNote(false);
      return;
    }
    const { error } = await db.from('contact_notes').insert({
      contact_id: contact.id,
      account_id: accountId,
      user_id: session.user.id,
      note_text: newNote.trim(),
    });
    setSavingNote(false);
    if (error) {
      toast.error(td('toastNoteAddFailed'));
      return;
    }
    setNewNote('');
    toast.success(td('toastNoteAdded'));
    void loadNotes();
    refreshAfterChange();
  }

  async function deleteNote() {
    if (!noteToDelete) return;
    const { error } = await db.from('contact_notes').delete().eq('id', noteToDelete);
    setNoteToDelete(null);
    if (error) {
      toast.error(td('toastNoteDeleteFailed'));
      return;
    }
    setNotes((prev) => prev.filter((n) => n.id !== noteToDelete));
    toast.success(td('toastNoteDeleted'));
    refreshAfterChange();
  }

  /**
   * Message: open the contact's conversation when there is one; otherwise a
   * WhatsApp chat starts with an approved template, which needs a number, no
   * block and no opt-out (Instagram only lets the business reply).
   */
  const message = useCallback((data: ContactOverview | null = overview) => {
    if (!contact) return;
    const conversations = data?.conversations ?? [];
    const convo = [...conversations].sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1))[0];
    if (convo) {
      router.push(conversationInboxPath(convo.channel as Channel, enabledChannels, convo.id));
      return;
    }
    const name = contact.name?.split(' ')[0] || contactHandle(contact);
    if (contact.blocked_at) {
      toast.error(t('profile.message.blocked', { name }));
      return;
    }
    if (!contact.phone) {
      setIgOnlyOpen(true);
      return;
    }
    if (contact.opted_out_at) {
      toast.error(t('profile.message.optedOut', { name }));
      return;
    }
    setPickerOpen(true);
  }, [contact, overview, router, enabledChannels, t]);

  // ?message=1 (the table's row menu): start the message flow once the contact has loaded.
  useEffect(() => {
    if (messageAsked.current || !contact || !overview || searchParams.get('message') !== '1') return;
    messageAsked.current = true;
    if (canEdit) message(overview);
  }, [contact, overview, searchParams, canEdit, message]);

  async function sendTemplate(template: MessageTemplate, sendValues: TemplateSendValues) {
    if (!contact) return;
    setSending(true);
    try {
      const res = await authFetch('/api/whatsapp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // No conversation_id: the route finds or creates one for this contact.
          contact_id: contact.id,
          message_type: 'template',
          template_name: template.name,
          template_language: template.language,
          template_message_params: sendValues,
          template_params: sendValues.body,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(td('toastTemplateFailed', { reason: payload?.error || `HTTP ${res.status}` }));
        return;
      }
      toast.success(td('toastTemplateSent', { name: template.name }));
      // Jump to the chat the send opened (the reload also shows the send on the timeline).
      const fresh = await loadOverview();
      const convo = fresh?.conversations.find((c) => c.channel === 'whatsapp');
      if (convo) router.push(conversationInboxPath('whatsapp', enabledChannels, convo.id));
    } catch (err) {
      toast.error(td('toastTemplateFailed', { reason: err instanceof Error ? err.message : td('networkError') }));
    } finally {
      setSending(false);
    }
  }

  async function handleDelete() {
    if (!contact) return;
    setDeleting(true);
    const { error } = await db.from('contacts').delete().eq('id', contact.id);
    setDeleting(false);
    if (error) {
      toast.error(tp('toastFailedDelete'));
      return;
    }
    toast.success(tp('toastDeleted'));
    router.push('/contacts');
  }

  async function handleErase() {
    if (!contact) return;
    setDeleting(true);
    const res = await authFetch(`/api/contacts/${contact.id}/erase`, { method: 'POST' }).catch(() => null);
    setDeleting(false);
    if (!res?.ok) {
      toast.error(tp('toastEraseFailed'));
      return;
    }
    toast.success(tp('toastEraseQueued'));
    router.push('/contacts');
  }

  async function copyHandle() {
    if (!contact) return;
    const handle = contact.phone || (overview?.instagram_usernames[0] ? `@${overview.instagram_usernames[0]}` : contactHandle(contact));
    try {
      await navigator.clipboard.writeText(handle);
      toast.success(t('profile.copied', { value: handle }));
    } catch {
      toast.error(t('profile.copyFailed'));
    }
  }

  async function exportContact() {
    if (!contact) return;
    const done = await downloadContactsCsv(`ids=${contact.id}`);
    if (!done.ok) toast.error(done.error || tp('segments.exportFailed'));
  }

  if (missing) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-2xl border border-border bg-card px-6 py-16 text-center">
        <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground"><UserRound className="size-5" /></span>
        <h1 className="text-base font-semibold text-foreground">{t('profile.notFoundTitle')}</h1>
        <p className="text-sm text-muted-foreground">{t('profile.notFoundText')}</p>
        <Link href="/contacts" className={buttonVariants({ variant: 'outline' })}>{t('profile.backToPeople')}</Link>
      </div>
    );
  }
  if (!contact) {
    return <div className="flex justify-center py-24"><Loader2 className="size-6 animate-spin text-primary" aria-label={t('loading')} /></div>;
  }

  const displayName = contact.name || contactHandle(contact) || tp('unnamed');
  const firstName = contact.name?.split(' ')[0] || displayName;
  const lastSeen = overview?.conversations.reduce<string | null>((max, c) => (c.last_message_at && (!max || c.last_message_at > max) ? c.last_message_at : max), null) ?? null;
  const ownerOptionMissing = !!contact.owner_id && members.length > 0 && !members.some((m) => m.user_id === contact.owner_id);
  const contactTags = allTags.filter((tag) => tagIds.includes(tag.id));
  const timeline = overview?.timeline ?? [];
  const shownEvents = showAll ? timeline : timeline.slice(0, TIMELINE_PREVIEW);
  const hasWhatsApp = !!contact.phone;
  const hasInstagram = overview?.has_instagram ?? false;

  return (
    <div className="min-w-0 space-y-5">
      <Link href="/contacts" className="inline-flex items-center gap-1.5 rounded-md text-[13px] font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
        <ArrowLeft className="size-4" aria-hidden />
        {t('profile.backToPeople')}
      </Link>

      {/* Header */}
      <header className="flex flex-wrap items-center gap-4">
        <div className="flex min-w-0 flex-[1_1_260px] items-center gap-4">
          <span aria-hidden className={cn('flex size-14 shrink-0 items-center justify-center rounded-full text-lg font-semibold', avatarTone(displayName))}>
            {initials(contact.name)}
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="text-[22px] font-bold tracking-tight break-words text-foreground [overflow-wrap:anywhere]">{displayName}</h1>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              {[contact.city, t('profile.added', { date: formatDay(contact.created_at, locale) }),
                lastSeen ? t('profile.lastSeen', { when: formatLastSeen(lastSeen, locale, t) }) : null].filter(Boolean).join(' · ')}
            </p>
            {(contact.opted_out_at || contact.blocked_at) && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {contact.opted_out_at && <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">{t('badges.optedOut')}</span>}
                {contact.blocked_at && <span data-testid="contact-blocked-badge" className="rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive">{t('badges.blocked')}</span>}
              </div>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canEdit && (
            <Button onClick={() => message()} disabled={sending}>
              {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              {t('profile.message.button')}
            </Button>
          )}
          {canEdit && (
            <Button variant="ghost" onClick={() => setEditOpen(true)}>
              <Pencil className="size-4" />
              {tp('editAction')}
            </Button>
          )}
          {canEdit && (
            <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setDeleteOpen(true)}>
              <Trash2 className="size-4" />
              {tp('deleteAction')}
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={t('profile.more')} />}>
              <MoreHorizontal className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="bg-popover border-border">
              <DropdownMenuItem onClick={() => void copyHandle()}>
                <Copy className="size-4" />
                {t('profile.copyHandle')}
              </DropdownMenuItem>
              {canExport && (
                <DropdownMenuItem onClick={() => void exportContact()}>
                  <Download className="size-4" />
                  {t('profile.exportOne')}
                </DropdownMenuItem>
              )}
              {canEdit && (
                <DropdownMenuItem onClick={() => void setBlocked(!contact.blocked_at)}>
                  <Ban className="size-4" />
                  {contact.blocked_at ? t('profile.unblock') : t('profile.block')}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <div className="grid grid-cols-1 items-start gap-4 min-[1100px]:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-4">
          {/* Details */}
          <section className={CARD} aria-labelledby="ct-details">
            <h2 id="ct-details" className={cn(CARD_TITLE, 'mb-3')}>{t('profile.details')}</h2>
            <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
              {DETAIL_KEYS.map((key) => (
                <div key={key} className="min-w-0 space-y-1">
                  <Label htmlFor={`ct-${key}`} className="text-xs text-muted-foreground">{t(`fields.${key}`)}</Label>
                  <Input
                    id={`ct-${key}`}
                    type={key === 'email' ? 'email' : key === 'phone' ? 'tel' : 'text'}
                    value={draft[key]}
                    placeholder={t('profile.add')}
                    readOnly={!canEdit || (key === 'phone' && phoneMasked)}
                    title={key === 'phone' && phoneMasked ? td('phoneMaskedHint') : undefined}
                    aria-invalid={!!fieldErrors[key]}
                    aria-describedby={fieldErrors[key] ? `ct-${key}-error` : undefined}
                    onChange={(e) => setDraft((prev) => ({ ...prev, [key]: e.target.value }))}
                    onBlur={() => void saveDetail(key)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      if (e.key === 'Escape') setDraft((prev) => ({ ...prev, [key]: contact[key] ?? '' }));
                    }}
                    className={INLINE}
                  />
                  {fieldErrors[key] && <p id={`ct-${key}-error`} className="text-xs font-medium text-destructive">{fieldErrors[key]}</p>}
                </div>
              ))}
              <div className="min-w-0 space-y-1">
                <Label htmlFor="ct-owner" className="text-xs text-muted-foreground">{t('fields.owner')}</Label>
                <select
                  id="ct-owner"
                  value={contact.owner_id ?? ''}
                  disabled={!canEdit}
                  onChange={(e) => void saveOwner(e.target.value)}
                  className={cn(FIELD_SELECT, 'border-transparent bg-muted')}
                >
                  <option value="">{t('owner.noOne')}</option>
                  {members.map((m) => (
                    <option key={m.user_id} value={m.user_id}>{m.full_name || t('owner.unnamedMember')}</option>
                  ))}
                  {ownerOptionMissing && <option value={contact.owner_id!}>{t('owner.formerMember')}</option>}
                </select>
                {fieldErrors.owner && <p className="text-xs font-medium text-destructive">{fieldErrors.owner}</p>}
              </div>
            </div>
          </section>

          {/* Custom fields */}
          <section className={CARD} aria-labelledby="ct-custom">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 id="ct-custom" className={CARD_TITLE}>{t('profile.customFields')}</h2>
              <Link href="/contacts/fields" className="rounded-md text-[13px] font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
                {t('profile.manageFields')}
              </Link>
            </div>
            {customFields.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">{t('profile.noCustomFields')}</p>
            ) : (
              <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
                {customFields.map((f) => (
                  <div key={f.id} className="min-w-0 space-y-1">
                    <Label htmlFor={`cf-${f.id}`} className="text-xs text-muted-foreground">{f.field_name}</Label>
                    <CustomFieldInput
                      id={`cf-${f.id}`}
                      type={f.field_type}
                      choices={f.choices}
                      value={values[f.id] ?? ''}
                      disabled={!canEdit}
                      onChange={(v) => setValues((prev) => ({ ...prev, [f.id]: v }))}
                      onCommit={(v) => void saveValue(f.id, v)}
                      className={f.field_type === 'choice' ? 'border-transparent bg-muted' : INLINE}
                    />
                    {valueErrors[f.id] && <p className="text-xs font-medium text-destructive">{valueErrors[f.id]}</p>}
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Notes */}
          <section className={CARD} aria-labelledby="ct-notes">
            <h2 id="ct-notes" className={CARD_TITLE}>{t('profile.notes')}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('profile.notesHint')}</p>
            {canEdit && (
              <div className="mt-3 flex items-end gap-2">
                <Textarea
                  value={newNote}
                  rows={2}
                  aria-label={t('profile.newNote')}
                  placeholder={t('profile.notePlaceholder', { name: firstName })}
                  onChange={(e) => setNewNote(e.target.value)}
                  className="min-h-[40px] min-w-0 flex-1 resize-y border-border bg-card text-sm"
                />
                <Button onClick={() => void addNote()} disabled={!newNote.trim() || savingNote} className="shrink-0">
                  {savingNote ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                  {t('profile.addNote')}
                </Button>
              </div>
            )}
            <div className="mt-3 space-y-2">
              {notes.map((note) => (
                <div key={note.id} className="rounded-xl bg-amber-500/10 p-3">
                  <p className="text-sm whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]">{note.note_text}</p>
                  <div className="mt-1.5 flex items-center justify-between gap-2">
                    <small className="text-xs text-muted-foreground">
                      {[memberName(members, note.user_id), formatWhen(note.created_at, locale, t)].filter(Boolean).join(' · ')}
                    </small>
                    {canEdit && (
                      <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" aria-label={td('deleteNote')} onClick={() => setNoteToDelete(note.id)}>
                        <Trash2 className="size-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Timeline */}
          <section className={CARD} aria-labelledby="ct-timeline">
            <h2 id="ct-timeline" className={cn(CARD_TITLE, 'mb-3')}>{t('profile.timeline')}</h2>
            {timeline.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">{overview ? t('profile.noEvents') : t('loading')}</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {shownEvents.map((event, i) => (
                  <li key={`${event.kind}-${event.at}-${i}`} className="flex items-start gap-2.5">
                    <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                      <EventIcon kind={event.kind} />
                    </span>
                    <div className="min-w-0">
                      <p className="text-[13px] text-foreground [overflow-wrap:anywhere]">{describeEvent(event)}</p>
                      <small className="text-xs text-muted-foreground">{formatWhen(event.at, locale, t)}</small>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {timeline.length > TIMELINE_PREVIEW && (
              <button type="button" onClick={() => setShowAll((v) => !v)} className="mt-3 rounded-md text-[13px] font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
                {showAll ? t('profile.showLess') : t('profile.showAll', { count: timeline.length })}
              </button>
            )}
          </section>
        </div>

        <aside className="flex min-w-0 flex-col gap-4">
          {/* Labels */}
          <section className={CARD} aria-labelledby="ct-labels">
            <h2 id="ct-labels" className={cn(CARD_TITLE, 'mb-3')}>{t('profile.labels')}</h2>
            <div className="flex flex-wrap items-center gap-1.5">
              {contactTags.map((tag) => (
                <span key={tag.id} className="inline-flex max-w-full items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium" style={{ backgroundColor: tag.color + '20', color: tag.color }}>
                  <span className="truncate">{tag.name}</span>
                  {canEdit && (
                    <button type="button" disabled={savingTag} onClick={() => void toggleTag(tag.id)} aria-label={t('profile.removeLabel', { name: tag.name })}
                      className="rounded-full opacity-70 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
                      <X className="size-3" />
                    </button>
                  )}
                </span>
              ))}
              {canEdit && (
                <DropdownMenu>
                  <DropdownMenuTrigger render={<button type="button" className="inline-flex h-7 items-center gap-1 rounded-full border border-dashed border-border px-2.5 text-xs text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50" />}>
                    <Plus className="size-3" />
                    {t('profile.addLabel')}
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto bg-popover border-border">
                    {allTags.length === 0 ? (
                      <p className="px-3 py-2 text-xs text-muted-foreground">{td('tagsTab.noTagsAvailable')}</p>
                    ) : allTags.map((tag) => (
                      <DropdownMenuCheckboxItem key={tag.id} checked={tagIds.includes(tag.id)} disabled={savingTag} onCheckedChange={() => void toggleTag(tag.id)}>
                        <span className="size-2 rounded-full" style={{ backgroundColor: tag.color }} />
                        {tag.name}
                      </DropdownMenuCheckboxItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              {!canEdit && contactTags.length === 0 && <p className="text-[13px] text-muted-foreground">{t('profile.noLabels')}</p>}
            </div>
          </section>

          {/* Messaging consent, one switch per channel */}
          <section className={CARD} aria-labelledby="ct-messaging">
            <h2 id="ct-messaging" className={cn(CARD_TITLE, 'mb-1')}>{t('profile.messaging')}</h2>
            <div className="divide-y divide-border">
              <div className="flex items-center gap-3 py-2.5">
                <span aria-hidden className="size-2 shrink-0 rounded-full bg-emerald-500" />
                <div className="min-w-0 flex-1">
                  <strong className="block text-[13px] font-semibold text-foreground">WhatsApp</strong>
                  <small className="block text-xs text-muted-foreground">
                    {!hasWhatsApp ? t('profile.consent.notConnected')
                      : contact.opted_out_at ? t('profile.consent.optedOut')
                        : contact.opted_in_at ? t('profile.consent.optedInOn', { date: formatDay(contact.opted_in_at, locale) })
                          : t('profile.consent.noRecord')}
                  </small>
                </div>
                <Switch
                  checked={hasWhatsApp && !contact.opted_out_at}
                  disabled={!hasWhatsApp || !canEdit || savingConsent !== null}
                  aria-label={t('profile.consent.whatsappLabel')}
                  onCheckedChange={(on) => (on ? setOptInAsk(true) : void setConsent('whatsapp', 'opted_out'))}
                />
              </div>
              <div className="flex items-center gap-3 py-2.5">
                <span aria-hidden className="size-2 shrink-0 rounded-full bg-pink-500" />
                <div className="min-w-0 flex-1">
                  <strong className="block text-[13px] font-semibold text-foreground">Instagram</strong>
                  <small className="block text-xs text-muted-foreground">
                    {!hasInstagram ? t('profile.consent.notConnected')
                      : contact.instagram_opted_out_at ? t('profile.consent.optedOut') : t('profile.consent.subscribed')}
                  </small>
                </div>
                <Switch
                  checked={hasInstagram && !contact.instagram_opted_out_at}
                  disabled={!hasInstagram || !canEdit || savingConsent !== null}
                  aria-label={t('profile.consent.instagramLabel')}
                  onCheckedChange={(on) => void setConsent('instagram', on ? 'opted_in' : 'opted_out')}
                />
              </div>
            </div>
            <div className="mt-2 space-y-3">
              <ContactIdentities contactId={contact.id} onChanged={refreshAfterChange} />
              <InstagramFacts contactId={contact.id} className="border-t border-border pt-3" />
            </div>
          </section>

          {/* Conversations */}
          <section className={CARD} aria-labelledby="ct-convos">
            <h2 id="ct-convos" className={cn(CARD_TITLE, 'mb-2')}>{t('profile.conversations')}</h2>
            {overview && overview.conversations.length > 0 ? (
              <ul className="-mx-2 flex flex-col gap-0.5">
                {overview.conversations.map((c) => (
                  <li key={c.id}>
                    <Link href={conversationInboxPath(c.channel as Channel, enabledChannels, c.id)}
                      className="flex items-center gap-2.5 rounded-lg p-2 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
                      <span aria-hidden className={cn('size-2 shrink-0 rounded-full', c.channel === 'instagram' ? 'bg-pink-500' : 'bg-emerald-500')} />
                      <span className="min-w-0 flex-1">
                        <strong className="block truncate text-[13px] font-semibold text-foreground">{c.last_message_text || (c.channel === 'instagram' ? 'Instagram' : 'WhatsApp')}</strong>
                        <small className="block text-xs text-muted-foreground">
                          {[c.channel === 'instagram' ? 'Instagram' : 'WhatsApp', c.last_message_at ? formatLastSeen(c.last_message_at, locale, t) : null].filter(Boolean).join(' · ')}
                        </small>
                      </span>
                      <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium',
                        c.status === 'closed' ? 'bg-muted text-muted-foreground' : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300')}>
                        {c.status === 'closed' ? t('profile.closed') : c.status === 'pending' ? t('profile.pending') : t('profile.open')}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <>
                <p className="text-[13px] text-muted-foreground">{t('profile.noConversations')}</p>
                {canEdit && (
                  <Button variant="outline" size="sm" className="mt-2" onClick={() => message()}>
                    <MessageSquare className="size-3.5" />
                    {t('profile.startConversation')}
                  </Button>
                )}
              </>
            )}
          </section>

          {/* Orders */}
          <section className={CARD} aria-labelledby="ct-orders">
            <h2 id="ct-orders" className={cn(CARD_TITLE, 'mb-2')}>{t('profile.orders')}</h2>
            {overview && overview.orders.length > 0 ? (
              <ul className="-mx-2 flex flex-col gap-0.5">
                {overview.orders.map((o) => (
                  <li key={o.id}>
                    <Link href={`/commerce/orders/${o.id}`} className="flex items-center gap-2.5 rounded-lg p-2 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
                      <span className="min-w-0 flex-1">
                        <strong className="block truncate text-[13px] font-semibold text-foreground">{t('profile.orderName', { ref: o.external_id || o.id.slice(0, 8) })}</strong>
                        <small className="block text-xs text-muted-foreground">{formatDay(o.created_at, locale)} · {o.status}</small>
                      </span>
                      <b className="shrink-0 text-[13px] font-semibold tabular-nums text-foreground">{formatMoney(o.total_minor, o.currency, locale)}</b>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-muted-foreground">{t('profile.noOrders')}</p>
            )}
          </section>

          {/* Deals */}
          <section className={CARD} aria-labelledby="ct-deals">
            <h2 id="ct-deals" className={cn(CARD_TITLE, 'mb-2')}>{t('profile.deals')}</h2>
            {deals.length > 0 ? (
              <ul className="-mx-2 flex flex-col gap-0.5">
                {deals.map((deal) => (
                  <li key={deal.id}>
                    <Link href="/pipelines" className="flex items-center gap-2.5 rounded-lg p-2 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
                      <span className="min-w-0 flex-1">
                        <strong className="block truncate text-[13px] font-semibold text-foreground">{deal.title}</strong>
                        <small className="block truncate text-xs text-muted-foreground">
                          {[deal.stage?.name, deal.status && deal.status !== 'open' ? deal.status : null].filter(Boolean).join(' · ')}
                        </small>
                      </span>
                      <b className="shrink-0 text-[13px] font-semibold tabular-nums text-foreground">{formatCurrency(deal.value ?? 0, deal.currency || defaultCurrency)}</b>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-muted-foreground">{td('dealsTab.noDeals')}</p>
            )}
          </section>
        </aside>
      </div>

      <ContactForm
        open={editOpen}
        onOpenChange={setEditOpen}
        contact={contact}
        contactTags={tagIds.map((tagId) => ({ id: tagId, contact_id: contact.id, tag_id: tagId }))}
        onSaved={() => {
          void loadContact();
          void loadTags();
          refreshAfterChange();
        }}
      />

      <TemplatePicker open={pickerOpen} onOpenChange={setPickerOpen} onSelect={(tpl, v) => void sendTemplate(tpl, v)} />

      {/* Instagram only lets a business reply */}
      <Dialog open={igOnlyOpen} onOpenChange={setIgOnlyOpen}>
        <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('profile.message.igOnlyTitle')}</DialogTitle>
            <DialogDescription>{t('profile.message.igOnlyText', { name: firstName })}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="bg-popover border-border">
            <Button onClick={() => setIgOnlyOpen(false)}>{t('profile.ok')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Turning WhatsApp messages on: record an opt-in, or only remove the opt-out */}
      <Dialog open={optInAsk} onOpenChange={setOptInAsk}>
        <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('profile.consent.askTitle', { name: firstName })}</DialogTitle>
            <DialogDescription>{t('profile.consent.askText')}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col gap-2 bg-popover border-border sm:flex-row">
            <Button variant="outline" onClick={() => setOptInAsk(false)}>{t('cancel')}</Button>
            {contact.opted_out_at && (
              <Button variant="outline" onClick={() => { setOptInAsk(false); void setConsent('whatsapp', 'cleared'); }}>
                {t('profile.consent.onlyClear')}
              </Button>
            )}
            <Button onClick={() => { setOptInAsk(false); void setConsent('whatsapp', 'opted_in'); }}>
              <ShieldCheck className="size-4" />
              {t('profile.consent.yesAgreed')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete, or (admins) erase everything stored about the person */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{tp('deleteContactTitle')}</DialogTitle>
            <DialogDescription>{tp('deleteContactDesc', { name: displayName })}</DialogDescription>
            {canEditSettings && <p className="text-xs text-muted-foreground">{tp('eraseHint')}</p>}
          </DialogHeader>
          <DialogFooter className="bg-popover border-border">
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>{tp('cancel')}</Button>
            {canEditSettings && (
              <Button variant="outline" onClick={() => void handleErase()} disabled={deleting} className="border-destructive text-destructive">
                {tp('eraseBtn')}
              </Button>
            )}
            <Button variant="destructive" onClick={() => void handleDelete()} disabled={deleting}>
              {deleting && <Loader2 className="size-4 animate-spin" />}
              {tp('deleteBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={noteToDelete !== null} onOpenChange={(open) => !open && setNoteToDelete(null)}>
        <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('profile.deleteNoteTitle')}</DialogTitle>
            <DialogDescription>{t('profile.deleteNoteText')}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="bg-popover border-border">
            <Button variant="outline" onClick={() => setNoteToDelete(null)}>{t('cancel')}</Button>
            <Button variant="destructive" onClick={() => void deleteNote()}>{tp('deleteBtn')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );

  /** One timeline row in words (ids resolved to member, label and field names). */
  function describeEvent(event: TimelineEvent): string {
    const d = event.detail as Record<string, unknown>;
    const who = memberName(members, event.actor_id);
    const by = (text: string) => (who ? t('timeline.by', { text, name: who }) : text);
    switch (event.kind) {
      case 'created':
        return t('timeline.created');
      case 'conversation_started':
        return t('timeline.conversation', { channel: d.channel === 'instagram' ? 'Instagram' : 'WhatsApp' });
      case 'order_placed':
        return t('timeline.order');
      case 'tag_added':
        return t('timeline.tagAdded', { name: String(d.tag_name ?? '') });
      case 'tag_removed':
        return by(d.tag_name ? t('timeline.tagRemoved', { name: String(d.tag_name) }) : t('timeline.tagRemovedDeleted'));
      case 'note_added':
        return by(t('timeline.note'));
      case 'field_changed':
        return by(t('timeline.fieldChanged', { field: DETAIL_KEYS.includes(d.field as DetailKey) ? t(`fields.${d.field as DetailKey}`) : String(d.field ?? '') }));
      case 'custom_field_changed': {
        const name = customFields.find((f) => f.id === d.field_id)?.field_name ?? t('timeline.deletedField');
        return by(d.cleared ? t('timeline.customCleared', { field: name }) : t('timeline.customSet', { field: name }));
      }
      case 'owner_changed': {
        const owner = memberName(members, typeof d.owner_id === 'string' ? d.owner_id : null);
        return by(d.owner_id ? t('timeline.assigned', { name: owner ?? t('owner.formerMember') }) : t('timeline.ownerRemoved'));
      }
      case 'consent_changed': {
        const channel = d.channel === 'instagram' ? 'Instagram' : 'WhatsApp';
        const key = d.state === 'opted_out' ? 'timeline.optedOut' : d.state === 'cleared' ? 'timeline.optOutCleared' : 'timeline.optedIn';
        return by(t(key, { channel }));
      }
      case 'blocked':
        return by(t('timeline.blocked'));
      case 'unblocked':
        return by(t('timeline.unblocked'));
      case 'template_sent':
        return by(typeof d.template === 'string' && d.template ? t('timeline.templateSentNamed', { name: d.template }) : t('timeline.templateSent'));
      default:
        return '';
    }
  }
}

function EventIcon({ kind }: { kind: TimelineEvent['kind'] }) {
  const cls = 'size-3.5';
  switch (kind) {
    case 'conversation_started': return <Inbox className={cls} />;
    case 'order_placed': return <ShoppingBag className={cls} />;
    case 'tag_added':
    case 'tag_removed': return <TagIcon className={cls} />;
    case 'note_added': return <FileText className={cls} />;
    case 'owner_changed': return <UserRound className={cls} />;
    case 'consent_changed': return <Check className={cls} />;
    case 'blocked':
    case 'unblocked': return <Ban className={cls} />;
    case 'template_sent': return <Send className={cls} />;
    case 'created': return <Upload className={cls} />;
    case 'field_changed':
    case 'custom_field_changed': return <Pencil className={cls} />;
    default: return <CircleDot className={cls} />;
  }
}
