'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { RefreshCw, Copy, Check, ChevronRight, Pencil, Plus, UserRound } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { createClient } from '@/lib/data/client';
import { addContactTag, deleteContactTag } from '@/lib/contacts/tag-api';
import {
  loadContactDetails,
  saveContactBasics,
  saveContactField,
  createAddressField,
  flowAnswers,
  type ContactDetails,
} from '@/lib/inbox/contact-details';
import { contactHandle } from '@/lib/whatsapp/wa-identity';
import { MASK_CHAR } from '@/lib/inbox/masking';
import type { Contact, ConversationChannel } from '@/types';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { avatarTone, initials } from '@/lib/ui/avatar-tone';
import { ScrollArea } from '@/components/ui/scroll-area';
import { AssessmentPanel } from '@/components/inbox/ai-assessment/assessment-panel';
import { HandlingHistory } from '@/components/inbox/handling-history';
import { LabelPicker } from '@/components/inbox/label-picker';
import type { InboxFolders } from '@/components/inbox/use-inbox-folders';
import { InstagramFacts } from '@/components/contacts/instagram-facts';
import { ConsentSection } from '@/components/inbox/consent';

interface ContactSidebarProps {
  contact: Contact | null;
  refreshToken?: string | number;
  /** Changes when the open conversation's assignee or status changes, so its history reloads. */
  handlingKey?: string;
  onUpdated?: (contact: Contact) => void;
  onCollapse?: () => void;
  /** The open conversation's channel (from its row); Instagram is marked. */
  channel?: ConversationChannel;
  /** The open conversation, for its advisory AI assessment (hidden without it). */
  conversationId?: string | null;
  /** Stage 5: labels and favourites of the open conversation (hidden without them). */
  folders?: InboxFolders;
}

export function ContactSidebar({
  contact,
  refreshToken,
  handlingKey,
  onUpdated,
  onCollapse,
  channel = 'whatsapp',
  conversationId,
  folders,
}: ContactSidebarProps) {
  const t = useTranslations('Inbox.sidebar');
  const tThread = useTranslations('Inbox.messageThread');
  const tChannel = useTranslations('Inbox.channel');
  const format = useFormatter();
  const { accountId, user, canSendMessages, canEditSettings } = useAuth();
  const [data, setData] = useState<ContactDetails | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [basics, setBasics] = useState({ name: '', email: '', company: '' });
  const [values, setValues] = useState<Record<string, string>>({});
  const [newNote, setNewNote] = useState('');
  const [copied, setCopied] = useState(false);
  const request = useRef(0);
  const contactId = contact?.id;
  const loadError = t('loadError');
  const reload = useCallback(async () => {
    if (!contactId) return null;
    const current = ++request.current;
    setLoading(true);
    try {
      const next = await loadContactDetails(contactId);
      if (current !== request.current) return null;
      setData(next);
      setError('');
      return next;
    } catch (err) {
      if (current === request.current)
        setError(err instanceof Error ? err.message : loadError);
      return null;
    } finally {
      if (current === request.current) setLoading(false);
    }
  }, [contactId, loadError]);
  useEffect(() => {
    void reload();
    return () => {
      // This counter tracks async requests, rather than a DOM element.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      request.current++;
    };
  }, [reload, refreshToken]);
  async function mutate(action: () => Promise<unknown>) {
    if (busy || !canSendMessages) return;
    setBusy(true);
    setError('');
    try {
      await action();
      const next = await reload();
      if (next) onUpdated?.({ ...next.contact, tags: next.tags });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('saveError'));
    } finally {
      setBusy(false);
    }
  }
  if (!contact) return null;
  const current = data?.contact ?? contact;
  const handle = contactHandle(current);
  // Masked members get "+91 98•••••210" from the server; copying that is
  // useless, so it is shown as plain text.
  const handleMasked = handle.includes(MASK_CHAR);
  const disabled = busy || !canSendMessages || !data;
  const inputClass =
    'w-full rounded-xl border border-border bg-card px-3 py-2 text-sm disabled:opacity-60';
  const countClass = 'bg-muted text-muted-foreground rounded-full px-1.5 text-[11px] font-semibold tabular-nums';
  // Collapsible sections: a quiet summary row with a chevron (inbox.css).
  const summaryClass = 'studio-sec-summary flex h-9 cursor-pointer list-none items-center gap-2 text-[13px] font-semibold';
  const addressExists = data?.customFields.some(
    (field) => field.field_name.trim().toLowerCase() === 'address'
  );
  const detailRows: Array<{ key: string; label: string; value: string | null | undefined }> = [
    { key: 'channel', label: t('channel'), value: tChannel(channel) },
    { key: 'phone', label: t('phone'), value: current.phone },
    { key: 'email', label: t('email'), value: current.email },
    { key: 'company', label: t('company'), value: current.company },
    ...(data?.customFields ?? []).map((field) => ({
      key: field.id,
      label: field.field_name,
      value: data?.customValues[field.id],
    })),
    {
      key: 'firstSeen',
      label: t('firstSeen'),
      value: current.created_at ? format.dateTime(new Date(current.created_at), { dateStyle: 'medium' }) : null,
    },
  ];
  return (
    <aside
      aria-label={t('contactDetails')}
      className="studio-contact-panel border-border bg-card flex h-full w-[300px] flex-col border-l"
    >
      <ScrollArea className="min-h-0 flex-1">
        <div className="studio-panel-body pb-5">
          {/* Who this is: avatar with its channel, name, handle and a way to the full contact. */}
          <div className="relative px-4 pt-4 pb-4 text-center">
            <div className="absolute inset-x-2 top-2 flex items-center justify-between">
              {onCollapse ? (
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={tThread('hideContactPanel')}
                  title={tThread('hideContactPanel')}
                  disabled={busy}
                  onClick={onCollapse}
                  className="text-muted-foreground"
                >
                  <ChevronRight className="size-4" />
                </Button>
              ) : (
                <span />
              )}
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t('refresh')}
                title={t('refresh')}
                disabled={loading || busy}
                onClick={() => void reload()}
                className="text-muted-foreground"
              >
                <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
              </Button>
            </div>
            <div
              className={cn(
                'relative mx-auto mt-2 flex size-16 items-center justify-center rounded-full text-[20px] font-semibold',
                avatarTone(current.name || handle)
              )}
            >
              {current.avatar_url ? (
                // Existing contact avatars may come from connected WhatsApp accounts.
                // eslint-disable-next-line @next/next/no-img-element
                <img src={current.avatar_url} alt="" className="size-16 rounded-full object-cover" />
              ) : (
                initials(current.name || handle)
              )}
              <span
                aria-hidden
                className={cn(
                  'ring-card absolute right-0 bottom-0 size-4 rounded-full ring-[2.5px]',
                  channel === 'instagram'
                    ? 'bg-gradient-to-tr from-amber-400 via-pink-500 to-violet-600'
                    : 'bg-emerald-500'
                )}
              />
            </div>
            <h3 className="mt-3 text-[17px] leading-6 font-semibold tracking-[-0.01em] break-words">
              {current.name || handle}
            </h3>
            {/* An Instagram-only contact has no phone or WhatsApp handle. */}
            {!handle ? null : handleMasked ? (
              <span className="text-muted-foreground mt-0.5 inline-flex max-w-full text-[13px] break-all">{handle}</span>
            ) : (
              <button
                className="text-muted-foreground hover:text-foreground mt-0.5 inline-flex max-w-full items-center gap-1.5 text-[13px] transition-colors duration-150"
                aria-label={t('copyPhone')}
                title={t('copyPhone')}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(handle);
                    setCopied(true);
                  } catch {
                    setError(t('copyError'));
                  }
                }}
              >
                <span className="break-all">{handle}</span>
                {copied ? <Check className="size-3 shrink-0" /> : <Copy className="size-3 shrink-0 opacity-60" />}
              </button>
            )}
            <div className="mt-3 flex justify-center">
              <Link
                href={`/contacts/${encodeURIComponent(contact.id)}`}
                className="border-border hover:bg-muted inline-flex h-8 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-semibold transition-colors duration-150"
              >
                <UserRound className="size-3.5" aria-hidden />
                {t('viewContact')}
              </Link>
            </div>
          </div>
          {error && (
            <div role="alert" className="border-destructive/40 text-destructive mx-4 mb-3 rounded-lg border p-3 text-xs">
              {error}
              <button className="ml-2 underline" onClick={() => void reload()}>
                {t('retry')}
              </button>
            </div>
          )}
          {loading && !data && (
            <p role="status" className="text-muted-foreground px-4 pb-3 text-xs">
              {t('loading')}
            </p>
          )}
          {data && (
            <>
              {/* WhatsApp consent; an Instagram chat shows its own subscription under Instagram facts. */}
              {channel !== 'instagram' && <ConsentSection
                contact={current}
                canEdit={canSendMessages}
                onChanged={(fields) => {
                  setData((prev) => (prev ? { ...prev, contact: { ...prev.contact, ...fields } } : prev));
                  onUpdated?.({ ...current, ...fields, tags: data.tags });
                }}
              />}
              <AssessmentPanel conversationId={conversationId} refreshToken={refreshToken} />
              <details open>
                <summary className={summaryClass}><h3>{t('details')}</h3></summary>
                {editing ? (
                  <form
                    className="mt-2 space-y-3"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void mutate(async () => {
                        await saveContactBasics(contact.id, basics);
                        for (const field of data.customFields)
                          if ((values[field.id] ?? '') !== (data.customValues[field.id] ?? ''))
                            await saveContactField(contact.id, field.id, values[field.id] ?? '');
                        setEditing(false);
                      });
                    }}
                  >
                    {(['name', 'email', 'company'] as const).map((key) => (
                      <label key={key} className="block space-y-1 text-xs">
                        {t(key)}
                        <input
                          type={key === 'email' ? 'email' : 'text'}
                          maxLength={key === 'email' ? 254 : 255}
                          className={inputClass}
                          value={basics[key]}
                          disabled={busy}
                          onChange={(e) => setBasics((prev) => ({ ...prev, [key]: e.target.value }))}
                        />
                      </label>
                    ))}
                    {data.customFields.map((field) => (
                      <label key={field.id} className="block space-y-1 text-xs">
                        {field.field_name}
                        <input
                          className={inputClass}
                          maxLength={10000}
                          value={values[field.id] ?? ''}
                          disabled={busy}
                          onChange={(e) => setValues((prev) => ({ ...prev, [field.id]: e.target.value }))}
                        />
                      </label>
                    ))}
                    <div className="flex gap-2">
                      <Button size="sm" type="submit" disabled={disabled}>
                        {t('save')}
                      </Button>
                      <Button size="sm" type="button" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
                        {t('cancel')}
                      </Button>
                    </div>
                  </form>
                ) : (
                  <dl className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-[13px]">
                    {detailRows.map((row) => (
                      <div key={row.key} className="contents">
                        <dt className="text-muted-foreground max-w-32 break-words">{row.label}</dt>
                        <dd
                          className={cn('min-w-0 text-right break-words whitespace-pre-wrap', !row.value && 'text-muted-foreground')}
                        >
                          {row.value || t('notSet')}
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
                {!editing && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {canSendMessages && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setBasics({ name: current.name ?? '', email: current.email ?? '', company: current.company ?? '' });
                          setValues(data.customValues);
                          setEditing(true);
                        }}
                        className="bg-muted hover:bg-muted/70 inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-semibold transition-colors duration-150 disabled:opacity-50"
                      >
                        <Pencil className="size-3.5" aria-hidden />
                        {t('editDetails')}
                      </button>
                    )}
                    {!addressExists && canEditSettings && (
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() =>
                          void mutate(async () => {
                            if (!accountId || !user) throw new Error(t('saveError'));
                            await createAddressField({ accountId, userId: user.id });
                          })
                        }
                        className="border-border hover:bg-muted inline-flex h-8 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-medium transition-colors duration-150 disabled:opacity-50"
                      >
                        <Plus className="size-3.5" aria-hidden />
                        {t('addAddress')}
                      </button>
                    )}
                  </div>
                )}
              </details>
              {conversationId && folders && (
                <LabelPicker conversationId={conversationId} folders={folders} canEdit={canSendMessages} />
              )}
              <details open>
                <summary className={summaryClass}>
                  <h3>{t('tags')}</h3>
                  {data.tags.length > 0 && <span className={countClass}>{data.tags.length}</span>}
                </summary>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {data.tags.length ? (
                    data.tags.map((tag) => (
                      <span
                        key={tag.id}
                        className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
                        style={{ backgroundColor: `${tag.color}1f`, color: tag.color }}
                      >
                        {tag.name}
                      </span>
                    ))
                  ) : (
                    <p className="text-muted-foreground text-xs">{t('noTags')}</p>
                  )}
                </div>
                {canSendMessages && (
                  <details className="mt-3 text-xs">
                    <summary className="text-primary cursor-pointer font-medium">{t('manageTags')}</summary>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {data.availableTags.map((tag) => {
                        const selected = data.tags.some((item) => item.id === tag.id);
                        return (
                          <button
                            type="button"
                            key={tag.id}
                            aria-pressed={selected}
                            disabled={disabled}
                            className="border-border aria-pressed:bg-primary/10 aria-pressed:text-primary rounded-full border px-2.5 py-1 transition-colors duration-150 aria-pressed:border-transparent disabled:opacity-50"
                            onClick={() =>
                              void mutate(() =>
                                selected ? deleteContactTag(contact.id, tag.id) : addContactTag(contact.id, tag.id)
                              )
                            }
                          >
                            {selected && '✓ '}
                            {tag.name}
                          </button>
                        );
                      })}
                      {!data.availableTags.length && <p>{t('noAvailableTags')}</p>}
                    </div>
                  </details>
                )}
              </details>
              <details open>
                <summary className={summaryClass}>
                  <h3>{t('notes')}</h3>
                  {data.notes.length > 0 && <span className={countClass}>{data.notes.length}</span>}
                </summary>
                {canSendMessages && (
                  <form
                    className="mt-2 flex items-start gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void mutate(async () => {
                        if (!accountId || !user) throw new Error(t('saveError'));
                        const result = await createClient().from('contact_notes').insert({
                          contact_id: contact.id,
                          account_id: accountId,
                          user_id: user.id,
                          note_text: newNote.trim(),
                        });
                        if (result.error) throw new Error(result.error.message);
                        setNewNote('');
                      });
                    }}
                  >
                    <textarea
                      className={cn(inputClass, 'min-h-10 resize-none text-[13px] leading-5')}
                      aria-label={t('addNotePlaceholder')}
                      placeholder={t('addNotePlaceholder')}
                      maxLength={10000}
                      rows={1}
                      value={newNote}
                      disabled={busy}
                      onChange={(e) => setNewNote(e.target.value)}
                    />
                    <Button type="submit" variant="secondary" className="h-10 shrink-0 rounded-full px-4" disabled={disabled || !newNote.trim()}>
                      {t('addNote')}
                    </Button>
                  </form>
                )}
                <div className="mt-3 space-y-2">
                  {data.notes.map((note) => (
                    <div key={note.id} className="studio-note rounded-xl px-3 py-2.5 text-[13px]">
                      <p className="break-words whitespace-pre-wrap">{note.note_text}</p>
                      <p className="mt-1 text-[11px] opacity-75">{new Date(note.created_at).toLocaleString()}</p>
                    </div>
                  ))}
                </div>
              </details>
              {conversationId && (
                <HandlingHistory conversationId={conversationId} refreshToken={`${refreshToken ?? ''}|${handlingKey ?? ''}`} />
              )}
              {channel === 'instagram' && <InstagramFacts contactId={contact.id} refreshToken={refreshToken} />}
              <details>
                <summary className={summaryClass}><h3>{t('flowAnswers')}</h3></summary>
                <p className="text-muted-foreground mt-1 text-xs">{t('flowAnswersHint')}</p>
                {data.flowRuns
                  .filter((run) => flowAnswers(run.vars).length)
                  .map((run, index) => (
                    <details key={run.id} open={index === 0} className="border-border mt-3 rounded-xl border p-2.5 text-xs">
                      <summary className="cursor-pointer">
                        {data.flowNames[run.flow_id] || t('flow')}
                        <span className="text-muted-foreground block text-[10px]">
                          {new Date(run.last_advanced_at).toLocaleString()}
                        </span>
                      </summary>
                      <dl className="mt-2 space-y-2">
                        {flowAnswers(run.vars).map((answer) => (
                          <div key={answer.key}>
                            <dt className="font-medium break-words">{answer.key}</dt>
                            <dd className="text-muted-foreground break-words whitespace-pre-wrap">{answer.value}</dd>
                          </div>
                        ))}
                      </dl>
                    </details>
                  ))}
                {!data.flowRuns.some((run) => flowAnswers(run.vars).length) && (
                  <p className="text-muted-foreground mt-2 text-xs">{t('noFlowAnswers')}</p>
                )}
              </details>
              <details>
                <summary className={summaryClass}>
                  <h3>{t('deals')}</h3>
                  <span className={countClass}>{data.deals.length}</span>
                </summary>
                <div className="mt-3 space-y-2">
                  {data.deals.map((deal) => (
                    <div key={deal.id} className="bg-muted rounded-xl p-3 text-xs">
                      <p className="font-medium">{deal.title}</p>
                      <div className="text-muted-foreground mt-1 flex justify-between gap-2">
                        <span>
                          {deal.currency ?? '$'} {Number(deal.value).toLocaleString()}
                        </span>
                        <span>{deal.stage?.name}</span>
                      </div>
                    </div>
                  ))}
                  {!data.deals.length && <p className="text-muted-foreground text-xs">{t('noDeals')}</p>}
                </div>
              </details>
            </>
          )}
        </div>
      </ScrollArea>
    </aside>
  );
}
