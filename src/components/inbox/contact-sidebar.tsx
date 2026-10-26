'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { RefreshCw, Copy, Check } from 'lucide-react';
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
import type { Contact } from '@/types';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';

interface ContactSidebarProps {
  contact: Contact | null;
  refreshToken?: string | number;
  onUpdated?: (contact: Contact) => void;
}

export function ContactSidebar({
  contact,
  refreshToken,
  onUpdated,
}: ContactSidebarProps) {
  const t = useTranslations('Inbox.sidebar');
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
  const disabled = busy || !canSendMessages || !data;
  const inputClass =
    'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm disabled:opacity-60';
  const sectionClass = 'border-t border-border pt-4';
  const addressExists = data?.customFields.some(
    (field) => field.field_name.trim().toLowerCase() === 'address'
  );
  return (
    <aside
      aria-label={t('contactDetails')}
      className="studio-contact-panel border-border bg-card flex h-full w-80 flex-col border-l"
    >
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">{t('contactDetails')}</h2>
            <Button
              size="icon"
              variant="ghost"
              aria-label={t('refresh')}
              disabled={loading || busy}
              onClick={() => void reload()}
            >
              <RefreshCw className="size-4" />
            </Button>
          </div>
          <div className="text-center">
            <div className="bg-muted mx-auto flex size-14 items-center justify-center rounded-full text-lg font-semibold">
              {current.avatar_url ? (
                // Existing contact avatars may come from connected WhatsApp accounts.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={current.avatar_url}
                  alt=""
                  className="size-14 rounded-full object-cover"
                />
              ) : (
                (current.name || handle).charAt(0).toUpperCase()
              )}
            </div>
            <h3 className="mt-2 font-semibold break-words">
              {current.name || handle}
            </h3>
            <button
              className="text-muted-foreground mt-1 inline-flex max-w-full items-center gap-2 text-xs"
              aria-label={t('copyPhone')}
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
              {copied ? (
                <Check className="size-3 shrink-0" />
              ) : (
                <Copy className="size-3 shrink-0" />
              )}
            </button>
          </div>
          {error && (
            <div
              role="alert"
              className="border-destructive/40 text-destructive rounded-lg border p-3 text-xs"
            >
              {error}
              <button className="ml-2 underline" onClick={() => void reload()}>
                {t('retry')}
              </button>
            </div>
          )}
          {loading && !data && (
            <p role="status" className="text-muted-foreground text-xs">
              {t('loading')}
            </p>
          )}
          {data && (
            <>
              <section className={sectionClass}>
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-xs font-semibold uppercase">
                    {t('details')}
                  </h3>
                  {!editing && canSendMessages && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        setBasics({
                          name: current.name ?? '',
                          email: current.email ?? '',
                          company: current.company ?? '',
                        });
                        setValues(data.customValues);
                        setEditing(true);
                      }}
                    >
                      {t('edit')}
                    </Button>
                  )}
                </div>
                {editing ? (
                  <form
                    className="space-y-3"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void mutate(async () => {
                        await saveContactBasics(contact.id, basics);
                        for (const field of data.customFields)
                          if (
                            (values[field.id] ?? '') !==
                            (data.customValues[field.id] ?? '')
                          )
                            await saveContactField(
                              contact.id,
                              field.id,
                              values[field.id] ?? ''
                            );
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
                          onChange={(e) =>
                            setBasics((prev) => ({
                              ...prev,
                              [key]: e.target.value,
                            }))
                          }
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
                          onChange={(e) =>
                            setValues((prev) => ({
                              ...prev,
                              [field.id]: e.target.value,
                            }))
                          }
                        />
                      </label>
                    ))}
                    <div className="flex gap-2">
                      <Button size="sm" type="submit" disabled={disabled}>
                        {t('save')}
                      </Button>
                      <Button
                        size="sm"
                        type="button"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => setEditing(false)}
                      >
                        {t('cancel')}
                      </Button>
                    </div>
                  </form>
                ) : (
                  <dl className="space-y-3 text-xs">
                    {(['name', 'email', 'company'] as const).map((key) => (
                      <div key={key}>
                        <dt className="text-muted-foreground">{t(key)}</dt>
                        <dd className="break-words whitespace-pre-wrap">
                          {current[key] || t('notSet')}
                        </dd>
                      </div>
                    ))}
                    {data.customFields.map((field) => (
                      <div key={field.id}>
                        <dt className="text-muted-foreground">
                          {field.field_name}
                        </dt>
                        <dd className="break-words whitespace-pre-wrap">
                          {data.customValues[field.id] || t('notSet')}
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
                {!editing && !addressExists && canEditSettings && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-3"
                    disabled={disabled}
                    onClick={() =>
                      void mutate(async () => {
                        if (!accountId || !user)
                          throw new Error(t('saveError'));
                        await createAddressField({
                          accountId,
                          userId: user.id,
                        });
                      })
                    }
                  >
                    {t('addAddress')}
                  </Button>
                )}
              </section>
              <section className={sectionClass}>
                <h3 className="text-xs font-semibold uppercase">{t('tags')}</h3>
                <div className="mt-2 flex flex-wrap gap-1">
                  {data.tags.length ? (
                    data.tags.map((tag) => (
                      <span
                        key={tag.id}
                        className="rounded-full border px-2 py-1 text-xs"
                        style={{ borderColor: tag.color }}
                      >
                        {tag.name}
                      </span>
                    ))
                  ) : (
                    <p className="text-muted-foreground text-xs">
                      {t('noTags')}
                    </p>
                  )}
                </div>
                {canSendMessages && (
                  <details className="mt-3 text-xs">
                    <summary className="cursor-pointer font-medium">
                      {t('manageTags')}
                    </summary>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {data.availableTags.map((tag) => {
                        const selected = data.tags.some(
                          (item) => item.id === tag.id
                        );
                        return (
                          <button
                            type="button"
                            key={tag.id}
                            aria-pressed={selected}
                            disabled={disabled}
                            className="border-border aria-pressed:bg-primary aria-pressed:text-primary-foreground rounded-lg border px-2 py-1 disabled:opacity-50"
                            onClick={() =>
                              void mutate(() =>
                                selected
                                  ? deleteContactTag(contact.id, tag.id)
                                  : addContactTag(contact.id, tag.id)
                              )
                            }
                          >
                            {selected && '✓ '}
                            {tag.name}
                          </button>
                        );
                      })}
                      {!data.availableTags.length && (
                        <p>{t('noAvailableTags')}</p>
                      )}
                    </div>
                  </details>
                )}
              </section>
              <section className={sectionClass}>
                <h3 className="text-xs font-semibold uppercase">
                  {t('flowAnswers')}
                </h3>
                <p className="text-muted-foreground mt-1 text-xs">
                  {t('flowAnswersHint')}
                </p>
                {data.flowRuns
                  .filter((run) => flowAnswers(run.vars).length)
                  .map((run, index) => (
                    <details
                      key={run.id}
                      open={index === 0}
                      className="border-border mt-3 rounded-lg border p-2 text-xs"
                    >
                      <summary className="cursor-pointer">
                        {data.flowNames[run.flow_id] || t('flow')}
                        <span className="text-muted-foreground block text-[10px]">
                          {new Date(run.last_advanced_at).toLocaleString()}
                        </span>
                      </summary>
                      <dl className="mt-2 space-y-2">
                        {flowAnswers(run.vars).map((answer) => (
                          <div key={answer.key}>
                            <dt className="font-medium break-words">
                              {answer.key}
                            </dt>
                            <dd className="text-muted-foreground break-words whitespace-pre-wrap">
                              {answer.value}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    </details>
                  ))}
                {!data.flowRuns.some((run) => flowAnswers(run.vars).length) && (
                  <p className="text-muted-foreground mt-2 text-xs">
                    {t('noFlowAnswers')}
                  </p>
                )}
              </section>
              <details className={sectionClass}>
                <summary className="cursor-pointer text-xs font-semibold uppercase">
                  {t('deals')} ({data.deals.length})
                </summary>
                <div className="mt-3 space-y-2">
                  {data.deals.map((deal) => (
                    <div
                      key={deal.id}
                      className="bg-muted rounded-lg p-3 text-xs"
                    >
                      <p className="font-medium">{deal.title}</p>
                      <div className="text-muted-foreground mt-1 flex justify-between gap-2">
                        <span>
                          {deal.currency ?? '$'}{' '}
                          {Number(deal.value).toLocaleString()}
                        </span>
                        <span>{deal.stage?.name}</span>
                      </div>
                    </div>
                  ))}
                  {!data.deals.length && (
                    <p className="text-muted-foreground text-xs">
                      {t('noDeals')}
                    </p>
                  )}
                </div>
              </details>
              <section className={sectionClass}>
                <h3 className="text-xs font-semibold uppercase">
                  {t('notes')}
                </h3>
                {canSendMessages && (
                  <form
                    className="mt-2 space-y-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void mutate(async () => {
                        if (!accountId || !user)
                          throw new Error(t('saveError'));
                        const result = await createClient()
                          .from('contact_notes')
                          .insert({
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
                      className={`${inputClass} text-xs`}
                      aria-label={t('addNotePlaceholder')}
                      placeholder={t('addNotePlaceholder')}
                      maxLength={10000}
                      rows={2}
                      value={newNote}
                      disabled={busy}
                      onChange={(e) => setNewNote(e.target.value)}
                    />
                    <Button
                      type="submit"
                      size="sm"
                      disabled={disabled || !newNote.trim()}
                    >
                      {t('addNote')}
                    </Button>
                  </form>
                )}
                <div className="mt-3 space-y-2">
                  {data.notes.map((note) => (
                    <div
                      key={note.id}
                      className="bg-muted rounded-lg p-3 text-xs"
                    >
                      <p className="break-words whitespace-pre-wrap">
                        {note.note_text}
                      </p>
                      <p className="text-muted-foreground mt-1 text-[10px]">
                        {new Date(note.created_at).toLocaleString()}
                      </p>
                    </div>
                  ))}
                </div>
              </section>
            </>
          )}
        </div>
      </ScrollArea>
    </aside>
  );
}
