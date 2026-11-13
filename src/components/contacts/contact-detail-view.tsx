'use client';
import { authFetch } from "@/lib/auth/client";

import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/lib/data/client';
import { addContactTag, deleteContactTag } from '@/lib/contacts/tag-api';
import { useAuth } from '@/hooks/use-auth';
import { formatCurrency } from '@/lib/currency';
import { toast } from 'sonner';
import type { Contact, Tag, ContactTag, ContactNote, CustomField, ContactCustomValue, Deal, MessageTemplate } from '@/types';
import {
  TemplatePicker,
  type TemplateSendValues,
} from '@/components/inbox/template-picker';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Phone,
  Mail,
  Building2,
  Copy,
  Check,
  Loader2,
  Plus,
  Trash2,
  Save,
  X,
  DollarSign,
  LayoutTemplate,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { contactHandle } from '@/lib/whatsapp/wa-identity';
import { parseInternationalPhone } from '@/lib/whatsapp/phone-utils';
import { MASK_CHAR } from '@/lib/inbox/masking';
import { ContactIdentities } from './contact-identities';
import { InstagramFacts } from './instagram-facts';

/** A soft inline input that turns card-coloured on focus. */
const INLINE_INPUT =
  'h-9 border-transparent bg-muted text-sm text-foreground transition-colors duration-150 hover:border-border focus-visible:bg-card';
/** A tab drawn as one option of a segmented control. */
const SEG_TAB =
  'h-full rounded-[9px] px-3 text-[13px] text-muted-foreground transition-colors duration-150 data-active:bg-card data-active:text-foreground data-active:shadow-sm';

interface ContactDetailViewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contactId: string | null;
  onUpdated: () => void;
}

export function ContactDetailView({
  open,
  onOpenChange,
  contactId,
  onUpdated,
}: ContactDetailViewProps) {
  const t = useTranslations('Contacts.detailView');
  const db = createClient();
  const { accountId, defaultCurrency, canSendMessages } = useAuth();
  const [savingConsent, setSavingConsent] = useState(false);

  const [contact, setContact] = useState<Contact | null>(null);
  const [loading, setLoading] = useState(false);
  const [copiedPhone, setCopiedPhone] = useState(false);

  // Send template — lets the business initiate (or re-open) a conversation
  // with this contact by sending an approved template. The send route
  // find-or-creates the conversation, so no inbound message is required.
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [sendingTemplate, setSendingTemplate] = useState(false);

  // Details tab
  const [editName, setEditName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editCompany, setEditCompany] = useState('');
  // The server sends a masked member only the masked number; it is shown
  // read-only, since the server refuses number writes from that member.
  const phoneMasked = !!contact?.phone?.includes(MASK_CHAR);
  const [savingDetails, setSavingDetails] = useState(false);

  // Tags tab
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [contactTagIds, setContactTagIds] = useState<string[]>([]);
  const [savingTags, setSavingTags] = useState(false);

  // Notes tab
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [newNote, setNewNote] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [loadingNotes, setLoadingNotes] = useState(false);

  // Custom fields tab
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [customValues, setCustomValues] = useState<Record<string, string>>({});
  const [savingCustom, setSavingCustom] = useState(false);
  const [loadingCustom, setLoadingCustom] = useState(false);

  // Deals tab
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loadingDeals, setLoadingDeals] = useState(false);

  const fetchContact = useCallback(async () => {
    if (!contactId) return;
    setLoading(true);

    const { data } = await db
      .from('contacts')
      .select('*')
      .eq('id', contactId)
      .single();

    if (data) {
      setContact(data);
      setEditName(data.name ?? '');
      setEditPhone(data.phone);
      setEditEmail(data.email ?? '');
      setEditCompany(data.company ?? '');
    }
    setLoading(false);
  }, [contactId, db]);

  const fetchTags = useCallback(async () => {
    if (!contactId) return;

    const [tagsRes, contactTagsRes] = await Promise.all([
      db.from('tags').select('*').order('name'),
      db.from('contact_tags').select('tag_id').eq('contact_id', contactId),
    ]);

    if (tagsRes.data) setAllTags(tagsRes.data);
    if (contactTagsRes.data) {
      setContactTagIds(contactTagsRes.data.map((ct) => ct.tag_id));
    }
  }, [contactId, db]);

  const fetchNotes = useCallback(async () => {
    if (!contactId) return;
    setLoadingNotes(true);

    const { data } = await db
      .from('contact_notes')
      .select('*')
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false });

    if (data) setNotes(data);
    setLoadingNotes(false);
  }, [contactId, db]);

  const fetchCustomFields = useCallback(async () => {
    if (!contactId) return;
    setLoadingCustom(true);

    const [fieldsRes, valuesRes] = await Promise.all([
      db.from('custom_fields').select('*').order('field_name'),
      db
        .from('contact_custom_values')
        .select('*')
        .eq('contact_id', contactId),
    ]);

    if (fieldsRes.data) setCustomFields(fieldsRes.data);
    if (valuesRes.data) {
      const map: Record<string, string> = {};
      valuesRes.data.forEach((v) => {
        map[v.custom_field_id] = v.value ?? '';
      });
      setCustomValues(map);
    }
    setLoadingCustom(false);
  }, [contactId, db]);

  const fetchDeals = useCallback(async () => {
    if (!contactId) return;
    setLoadingDeals(true);
    const { data } = await db
      .from('deals')
      .select('*, stage:pipeline_stages(*)')
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false });
    setDeals((data ?? []) as Deal[]);
    setLoadingDeals(false);
  }, [contactId, db]);

  useEffect(() => {
    if (open && contactId) {
      fetchContact();
      fetchTags();
      fetchNotes();
      fetchCustomFields();
      fetchDeals();
    }
  }, [open, contactId, fetchContact, fetchTags, fetchNotes, fetchCustomFields, fetchDeals]);

  async function copyPhone() {
    if (!contact) return;
    await navigator.clipboard.writeText(contactHandle(contact));
    setCopiedPhone(true);
    setTimeout(() => setCopiedPhone(false), 2000);
  }

  async function saveDetails() {
    if (!contactId || !editPhone.trim()) {
      toast.error(t('toastPhoneRequired'));
      return;
    }

    // Same rule as the create form: a changed number must start with `+`
    // and a country code (issue #586). Unchanged numbers — including the
    // digits-only form the inbound webhook stores — are left alone so a
    // name/email edit is never blocked by the phone field.
    const phoneChanged = editPhone.trim() !== (contact?.phone ?? '');
    if (phoneChanged && !parseInternationalPhone(editPhone)) {
      toast.error(t('toastPhoneNeedsCountryCode'));
      return;
    }

    setSavingDetails(true);
    const { error } = await db
      .from('contacts')
      .update({
        name: editName.trim() || null,
        // Send the number only when it was changed: re-saving an unchanged
        // value could write back a masked display form.
        ...(phoneChanged && !phoneMasked ? { phone: editPhone.trim() } : {}),
        email: editEmail.trim() || null,
        company: editCompany.trim() || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', contactId);

    if (error) {
      toast.error(error.code === 'PHONE_MASKED' ? t('phoneMasked') : t('toastUpdateFailed'));
    } else {
      toast.success(t('toastUpdated'));
      fetchContact();
      onUpdated();
    }
    setSavingDetails(false);
  }

  async function setConsent(field: 'opted_out_at' | 'blocked_at', on: boolean) {
    if (!contactId) return;
    setSavingConsent(true);
    const now = new Date().toISOString();
    if (field === 'opted_out_at') {
      // Consent goes through the audited route; the browser cannot write it directly.
      const res = await authFetch(`/api/contacts/${encodeURIComponent(contactId)}/consent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Unticking only removes the opt-out; recording an opt-in is a separate, confirmed step.
        body: JSON.stringify({ state: on ? 'opted_out' : 'cleared' }),
      }).catch(() => null);
      const data = res?.ok ? ((await res.json()) as { contact: Partial<Contact> }) : null;
      if (!data) toast.error(t('toastUpdateFailed'));
      else {
        setContact((prev) => (prev ? { ...prev, ...data.contact } : prev));
        onUpdated();
      }
      setSavingConsent(false);
      return;
    }
    const { error } = await db
      .from('contacts')
      .update({ blocked_at: on ? now : null, updated_at: now })
      .eq('id', contactId);
    if (error) {
      toast.error(t('toastUpdateFailed'));
    } else {
      setContact((prev) => (prev ? { ...prev, [field]: on ? now : null } : prev));
      onUpdated();
    }
    setSavingConsent(false);
  }

  async function toggleTag(tagId: string) {
    if (!contactId) return;
    setSavingTags(true);

    const isSelected = contactTagIds.includes(tagId);

    try {
      if (isSelected) {
        await deleteContactTag(contactId, tagId);
        setContactTagIds((prev) => prev.filter((id) => id !== tagId));
      } else {
        await addContactTag(contactId, tagId);
        setContactTagIds((prev) => [...prev, tagId]);
      }
      onUpdated();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('toastUpdateFailed'));
    }
    setSavingTags(false);
  }

  async function addNote() {
    if (!contactId || !newNote.trim()) return;
    setSavingNote(true);

    const {
      data: { session },
    } = await db.auth.getSession();
    const user = session?.user;
    if (!user || !accountId) {
      toast.error(t('toastNotAuthenticated'));
      setSavingNote(false);
      return;
    }

    const { error } = await db.from('contact_notes').insert({
      contact_id: contactId,
      account_id: accountId,
      user_id: user.id,
      note_text: newNote.trim(),
    });

    if (error) {
      toast.error(t('toastNoteAddFailed'));
    } else {
      setNewNote('');
      fetchNotes();
      toast.success(t('toastNoteAdded'));
    }
    setSavingNote(false);
  }

  async function deleteNote(noteId: string) {
    const { error } = await db
      .from('contact_notes')
      .delete()
      .eq('id', noteId);

    if (error) {
      toast.error(t('toastNoteDeleteFailed'));
    } else {
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
      toast.success(t('toastNoteDeleted'));
    }
  }

  async function saveCustomFields() {
    if (!contactId) return;
    setSavingCustom(true);

    try {
      // Delete existing values and re-insert
      await db
        .from('contact_custom_values')
        .delete()
        .eq('contact_id', contactId);

      const rows = Object.entries(customValues)
        .filter(([, val]) => val.trim())
        .map(([fieldId, val]) => ({
          contact_id: contactId,
          custom_field_id: fieldId,
          value: val.trim(),
        }));

      if (rows.length > 0) {
        const { error } = await db
          .from('contact_custom_values')
          .insert(rows);
        if (error) throw error;
      }

      toast.success(t('toastCustomFieldsSaved'));
    } catch {
      toast.error(t('toastCustomFieldsFailed'));
    }
    setSavingCustom(false);
  }

  async function handleSendTemplate(
    template: MessageTemplate,
    values: TemplateSendValues,
  ) {
    if (!contactId) return;
    setSendingTemplate(true);
    try {
      const res = await authFetch('/api/whatsapp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // No conversation_id — the route find-or-creates one for this
          // contact, mirroring the inbox template-send payload otherwise.
          contact_id: contactId,
          message_type: 'template',
          template_name: template.name,
          template_language: template.language,
          template_message_params: values,
          template_params: values.body,
        }),
      });

      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        const reason = payload?.error || `HTTP ${res.status}`;
        toast.error(t('toastTemplateFailed', { reason }));
        return;
      }

      toast.success(t('toastTemplateSent', { name: template.name }));
    } catch (err) {
      const reason = err instanceof Error ? err.message : t('networkError');
      toast.error(t('toastTemplateFailed', { reason }));
    } finally {
      setSendingTemplate(false);
    }
  }

  function getInitials(name?: string | null) {
    if (!name) return '?';
    return name
      .split(' ')
      .map((w) => w[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  }

  return (
    <>
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="bg-background border-border text-foreground data-[side=right]:sm:max-w-xl w-full p-0"
      >
        {loading || !contact ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="size-6 animate-spin text-primary" />
          </div>
        ) : (
          <div className="flex flex-col h-full">
            {/* Header */}
            <SheetHeader className="gap-0 px-5 pt-6 pb-4">
              <div className="flex items-center gap-4 pr-8">
                <Avatar className="size-14 bg-muted">
                  <AvatarFallback className="bg-primary/10 text-primary text-lg font-semibold">
                    {getInitials(contact.name)}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <SheetTitle className="text-[22px] font-bold tracking-tight text-foreground truncate">
                    {contact.name || t('unnamed')}
                  </SheetTitle>
                  <SheetDescription className="text-muted-foreground text-[13px] mt-0.5">
                    {t('contactDetailsDesc')}
                  </SheetDescription>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-[13px] text-muted-foreground">
                    <button
                      onClick={copyPhone}
                      className="flex items-center gap-1 tabular-nums hover:text-primary transition-colors duration-150 cursor-pointer"
                    >
                      <Phone className="size-3" />
                      {contactHandle(contact)}
                      {copiedPhone ? (
                        <Check className="size-3 text-primary" />
                      ) : (
                        <Copy className="size-3" />
                      )}
                    </button>
                    {contact.email && (
                      <span className="flex items-center gap-1">
                        <Mail className="size-3" />
                        {contact.email}
                      </span>
                    )}
                    {contact.company && (
                      <span className="flex items-center gap-1">
                        <Building2 className="size-3" />
                        {contact.company}
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <div className="mt-4">
                <Button
                  onClick={() => setTemplatePickerOpen(true)}
                  disabled={sendingTemplate}
                >
                  {sendingTemplate ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <LayoutTemplate className="size-4" />
                  )}
                  {t('sendTemplateBtn')}
                </Button>
              </div>
              <div className="mt-4 divide-y divide-border rounded-xl border border-border bg-card px-4">
                {(['opted_out_at', 'blocked_at'] as const).map((field) => (
                  <label key={field} className="flex items-center justify-between gap-3 py-2.5 text-xs">
                    <span>
                      <span className="block text-[13px] font-semibold text-foreground">
                        {t(field === 'opted_out_at' ? 'consent.optedOut' : 'consent.blocked')}
                      </span>
                      <span className="block text-muted-foreground">
                        {t(field === 'opted_out_at' ? 'consent.optedOutHint' : 'consent.blockedHint')}
                      </span>
                    </span>
                    <Switch
                      checked={Boolean(contact[field])}
                      disabled={!canSendMessages || savingConsent}
                      onCheckedChange={(on) => setConsent(field, on)}
                      aria-label={t(field === 'opted_out_at' ? 'consent.optedOut' : 'consent.blocked')}
                    />
                  </label>
                ))}
              </div>
            </SheetHeader>

            {/* Tabs */}
            <Tabs defaultValue="details" className="flex-1 flex flex-col min-h-0">
              <TabsList className="mx-5 h-9 max-w-[calc(100%-2.5rem)] shrink-0 justify-start overflow-x-auto rounded-xl bg-muted p-[3px]">
                <TabsTrigger
                  value="details"
                  className={SEG_TAB}
                >
                  {t('tabs.details')}
                </TabsTrigger>
                <TabsTrigger
                  value="tags"
                  className={SEG_TAB}
                >
                  {t('tabs.tags')}
                </TabsTrigger>
                <TabsTrigger
                  value="notes"
                  className={SEG_TAB}
                >
                  {t('tabs.notes')}
                </TabsTrigger>
                <TabsTrigger
                  value="custom"
                  className={SEG_TAB}
                >
                  {t('tabs.custom')}
                </TabsTrigger>
                <TabsTrigger
                  value="deals"
                  className={SEG_TAB}
                >
                  {t('tabs.deals')}
                </TabsTrigger>
              </TabsList>

              {/* Details Tab */}
              <TabsContent value="details" className="flex-1 overflow-y-auto px-5 py-4">
                <div className="space-y-4">
                  <div className="grid gap-3 rounded-xl border border-border bg-card p-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">{t('name')}</Label>
                    <Input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className={INLINE_INPUT}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">
                      {t('phone')} <span className="text-destructive">*</span>
                    </Label>
                    <Input
                      value={editPhone}
                      readOnly={phoneMasked}
                      aria-readonly={phoneMasked}
                      title={phoneMasked ? t('phoneMaskedHint') : undefined}
                      onChange={(e) => setEditPhone(e.target.value)}
                      className={INLINE_INPUT}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">{t('email')}</Label>
                    <Input
                      value={editEmail}
                      onChange={(e) => setEditEmail(e.target.value)}
                      className={INLINE_INPUT}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">{t('company')}</Label>
                    <Input
                      value={editCompany}
                      onChange={(e) => setEditCompany(e.target.value)}
                      className={INLINE_INPUT}
                    />
                  </div>
                  </div>
                  <Button
                    onClick={saveDetails}
                    disabled={savingDetails}
                    className="w-full sm:w-auto"
                  >
                    {savingDetails ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Save className="size-3.5" />
                    )}
                    {t('saveChangesBtn')}
                  </Button>
                  {/* Phase 11: Instagram identities (shown only while Instagram is on). */}
                  {contact && <ContactIdentities contactId={contact.id} onChanged={onUpdated} />}
                  {contact && <InstagramFacts contactId={contact.id} className="border-t border-border pt-3" />}
                </div>
              </TabsContent>

              {/* Tags Tab */}
              <TabsContent value="tags" className="flex-1 overflow-y-auto px-5 py-4">
                <div className="space-y-3">
                  <p className="text-xs text-muted-foreground">
                    {t('tagsTab.clickTagDesc')}
                  </p>
                  {allTags.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {t('tagsTab.noTagsAvailable')}
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {allTags.map((tag) => {
                        const selected = contactTagIds.includes(tag.id);
                        return (
                          <button
                            key={tag.id}
                            onClick={() => toggleTag(tag.id)}
                            disabled={savingTags}
                            className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium transition-all cursor-pointer ${
                              selected
                                ? 'ring-2 ring-primary ring-offset-1 ring-offset-border'
                                : 'opacity-50 hover:opacity-80'
                            }`}
                            style={{
                              backgroundColor: tag.color + '20',
                              color: tag.color,
                            }}
                          >
                            {selected && <Check className="size-3 mr-1" />}
                            {tag.name}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </TabsContent>

              {/* Notes Tab */}
              <TabsContent value="notes" className="flex-1 flex flex-col min-h-0 px-5 py-4">
                <div className="space-y-2 mb-3">
                  <Textarea
                    value={newNote}
                    onChange={(e) => setNewNote(e.target.value)}
                    placeholder={t('notesTab.placeholder')}
                    className="min-h-[64px] resize-none border-border bg-card text-sm text-foreground placeholder:text-muted-foreground"
                  />
                  <Button
                    onClick={addNote}
                    disabled={!newNote.trim() || savingNote}
                    size="sm"
                  >
                    {savingNote ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Plus className="size-3.5" />
                    )}
                    {t('notesTab.save')}
                  </Button>
                </div>

                <div className="flex-1 overflow-y-auto space-y-2">
                  {loadingNotes ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="size-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : notes.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-8">
                      {t('notesTab.noNotes')}
                    </p>
                  ) : (
                    notes.map((note) => (
                      <div
                        key={note.id}
                        className="rounded-xl border border-border bg-card p-3 group"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-sm text-muted-foreground whitespace-pre-wrap flex-1">
                            {note.note_text}
                          </p>
                          <button
                            type="button"
                            onClick={() => deleteNote(note.id)}
                            aria-label={t('deleteNote')}
                            className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all duration-150 cursor-pointer shrink-0"
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1.5">
                          {new Date(note.created_at).toLocaleDateString('en-US', {
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </p>
                      </div>
                    ))
                  )}
                </div>
              </TabsContent>

              {/* Custom Fields Tab */}
              <TabsContent value="custom" className="flex-1 overflow-y-auto px-5 py-4">
                {loadingCustom ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="size-5 animate-spin text-muted-foreground" />
                  </div>
                ) : customFields.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">
                    {t('noCustomFields')}
                  </p>
                ) : (
                  <div className="space-y-4">
                    <div className="grid gap-3 rounded-xl border border-border bg-card p-4 sm:grid-cols-2">
                    {customFields.map((field) => (
                      <div key={field.id} className="space-y-1.5">
                        <Label className="text-muted-foreground text-xs capitalize">
                          {field.field_name}
                        </Label>
                        <Input
                          value={customValues[field.id] ?? ''}
                          onChange={(e) =>
                            setCustomValues((prev) => ({
                              ...prev,
                              [field.id]: e.target.value,
                            }))
                          }
                          placeholder={t('enterCustomField', { name: field.field_name })}
                          className={cn(INLINE_INPUT, 'placeholder:text-muted-foreground')}
                        />
                      </div>
                    ))}
                    </div>
                    <Button
                      onClick={saveCustomFields}
                      disabled={savingCustom}
                      className="w-full sm:w-auto"
                    >
                      {savingCustom ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Save className="size-3.5" />
                      )}
                      {t('saveCustomFieldsBtn')}
                    </Button>
                  </div>
                )}
              </TabsContent>

              {/* Deals Tab */}
              <TabsContent value="deals" className="flex-1 overflow-y-auto px-5 py-4">
                {loadingDeals ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="size-5 animate-spin text-primary" />
                  </div>
                ) : deals.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t('dealsTab.noDeals')}</p>
                ) : (
                  <div className="space-y-2">
                    {deals.map((deal) => (
                      <div
                        key={deal.id}
                        className="rounded-xl border border-border bg-card p-3"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-sm font-medium text-foreground">
                            {deal.title}
                          </p>
                          {deal.stage && (
                            <span
                              className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                              style={{
                                backgroundColor: `${deal.stage.color}20`,
                                color: deal.stage.color,
                              }}
                            >
                              {deal.stage.name}
                            </span>
                          )}
                        </div>
                        <div className="mt-1.5 flex items-center justify-between text-xs text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <DollarSign className="size-3" />
                            {formatCurrency(
                              deal.value ?? 0,
                              deal.currency || defaultCurrency,
                            )}
                          </span>
                          {deal.status && deal.status !== 'open' && (
                            <span
                              className={
                                deal.status === 'won'
                                  ? 'text-primary'
                                  : 'text-destructive'
                              }
                            >
                              {deal.status}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </div>
        )}
      </SheetContent>
    </Sheet>
    <TemplatePicker
      open={templatePickerOpen}
      onOpenChange={setTemplatePickerOpen}
      onSelect={handleSendTemplate}
    />
    </>
  );
}
