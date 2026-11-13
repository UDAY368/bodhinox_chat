'use client';

import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, GalleryHorizontal, Loader2, MousePointerClick, Pencil, Plus, Send, Trash2, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { authFetch } from '@/lib/auth/client';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { cardViews, IgButtonsPreview, IgCardsPreview } from './instagram-template-preview';

// The limits Instagram enforces (src/lib/instagram/graph-limits.ts); the server checks them again.
const LIMITS = { name: 80, cards: 10, buttons: 3, buttonTitle: 20, cardTitle: 80, cardSubtitle: 80, text: 640 } as const;

type ButtonDraft = { type: 'reply' | 'web_url'; title: string; url: string };
type CardDraft = { title: string; subtitle: string; imageUrl: string; buttons: ButtonDraft[] };
type Draft = { id?: string; name: string; kind: 'cards' | 'button'; cards: CardDraft[]; text: string; buttons: ButtonDraft[] };

type StoredButton = { type: 'web_url' | 'postback'; title: string; url?: string };
export interface InstagramTemplate {
  id: string;
  name: string;
  kind: 'cards' | 'button';
  payload: { cards: { title: string; subtitle?: string; imageUrl?: string; buttons?: StoredButton[] }[] } | { text: string; buttons: StoredButton[] };
}

const emptyButton = (): ButtonDraft => ({ type: 'reply', title: '', url: '' });
const emptyCard = (): CardDraft => ({ title: '', subtitle: '', imageUrl: '', buttons: [] });
const emptyDraft = (): Draft => ({ name: '', kind: 'cards', cards: [emptyCard()], text: '', buttons: [emptyButton()] });
const toDraftButton = (b: StoredButton): ButtonDraft => ({ type: b.type === 'web_url' ? 'web_url' : 'reply', title: b.title, url: b.url ?? '' });

function draftOf(template: InstagramTemplate): Draft {
  const base = { ...emptyDraft(), id: template.id, name: template.name, kind: template.kind };
  if ('cards' in template.payload)
    return { ...base, cards: template.payload.cards.map((c) => ({ title: c.title, subtitle: c.subtitle ?? '', imageUrl: c.imageUrl ?? '', buttons: (c.buttons ?? []).map(toDraftButton) })) };
  return { ...base, text: template.payload.text, buttons: template.payload.buttons.map(toDraftButton) };
}

const buttonBody = (b: ButtonDraft) => (b.type === 'web_url' ? { type: 'web_url', title: b.title.trim(), url: b.url.trim() } : { type: 'reply', title: b.title.trim() });
function bodyOf(draft: Draft) {
  return {
    name: draft.name.trim(),
    kind: draft.kind,
    payload: draft.kind === 'cards'
      ? { cards: draft.cards.map((c) => ({ title: c.title.trim(), subtitle: c.subtitle.trim() || undefined, imageUrl: c.imageUrl.trim() || undefined, buttons: c.buttons.map(buttonBody) })) }
      : { text: draft.text.trim(), buttons: draft.buttons.map(buttonBody) },
  };
}

const httpsOk = (url: string) => {
  try { return new URL(url).protocol === 'https:'; } catch { return false; }
};
/** Characters as Instagram counts them (an emoji is one). */
const chars = (text: string) => [...text.trim()].length;
const MAX_PAYLOAD_BYTES = 20000;

/** Why Save is not offered yet: one translated key + values per problem, first problem first. */
export type DraftProblem = { key: string; values?: Record<string, number> };
function buttonProblem(b: ButtonDraft): DraftProblem | null {
  if (!chars(b.title)) return { key: 'problems.buttonLabel' };
  if (chars(b.title) > LIMITS.buttonTitle) return { key: 'problems.buttonLabelLong', values: { max: LIMITS.buttonTitle } };
  if (b.type === 'web_url' && !httpsOk(b.url.trim())) return { key: 'problems.buttonUrl' };
  return null;
}
/** The same checks the server makes, so Save is only offered for a template Instagram accepts. */
export function draftProblems(draft: Draft): DraftProblem[] {
  const problems: DraftProblem[] = [];
  if (!draft.name.trim()) problems.push({ key: 'problems.name' });
  if (draft.kind === 'button') {
    if (!chars(draft.text)) problems.push({ key: 'problems.text' });
    else if (chars(draft.text) > LIMITS.text) problems.push({ key: 'problems.textLong', values: { max: LIMITS.text } });
    for (const b of draft.buttons) { const p = buttonProblem(b); if (p) problems.push(p); }
  } else {
    draft.cards.forEach((c, i) => {
      const n = i + 1;
      if (!chars(c.title)) problems.push({ key: 'problems.cardTitle', values: { n } });
      else if (chars(c.title) > LIMITS.cardTitle) problems.push({ key: 'problems.cardTitleLong', values: { n, max: LIMITS.cardTitle } });
      if (chars(c.subtitle) > LIMITS.cardSubtitle) problems.push({ key: 'problems.cardSubtitleLong', values: { n, max: LIMITS.cardSubtitle } });
      if (c.imageUrl.trim() && !httpsOk(c.imageUrl.trim())) problems.push({ key: 'problems.imageUrl', values: { n } });
      for (const b of c.buttons) { const p = buttonProblem(b); if (p) problems.push({ ...p, values: { ...p.values, n } }); }
    });
  }
  if (!problems.length && new TextEncoder().encode(JSON.stringify(bodyOf(draft).payload)).length > MAX_PAYLOAD_BYTES)
    problems.push({ key: 'problems.tooLarge' });
  return problems;
}

const inputClass = 'border-border bg-card focus-visible:ring-ring/40 h-9 w-full rounded-lg border px-3 text-[13px] outline-none focus-visible:ring-2';

interface PickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Sends the chosen template into the open conversation. */
  onSend: (template: InstagramTemplate) => void;
  /** Agents and above create, edit and delete; viewers only browse. */
  canEdit: boolean;
}

/**
 * Instagram's "templates": the workspace's saved card and button messages.
 * Meta has no approved templates for Instagram, so these are sent like any
 * other message, inside the 24-hour window.
 */
export function InstagramTemplatePicker({ open, onOpenChange, onSend, canEdit }: PickerProps) {
  const t = useTranslations('Inbox.igTemplates');
  const [templates, setTemplates] = useState<InstagramTemplate[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await authFetch('/api/instagram/message-templates', { cache: 'no-store' });
      const data = (await res.json().catch(() => ({}))) as { templates?: InstagramTemplate[] };
      setTemplates(res.ok ? (data.templates ?? []) : []);
    } catch {
      setTemplates([]);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) setDraft(null);
  };

  const save = async () => {
    if (!draft || draftProblems(draft).length || saving) return;
    setSaving(true);
    try {
      const res = await authFetch(draft.id ? `/api/instagram/message-templates/${encodeURIComponent(draft.id)}` : '/api/instagram/message-templates', {
        method: draft.id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyOf(draft)),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(t(`errors.${['duplicate_name', 'too_many', 'too_large', 'invalid_template'].includes(data.error ?? '') ? data.error : 'failed'}` as never));
        return;
      }
      toast.success(t('saved'));
      setDraft(null);
      await load();
    } catch {
      toast.error(t('errors.failed'));
    } finally {
      setSaving(false);
    }
  };

  // Deleting asks once (it removes the template for the whole workspace).
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const remove = async (template: InstagramTemplate) => {
    setConfirmDelete(null);
    const res = await authFetch(`/api/instagram/message-templates/${encodeURIComponent(template.id)}`, { method: 'DELETE' }).catch(() => null);
    if (!res?.ok && res?.status !== 404) toast.error(t('errors.deleteFailed'));
    else toast.success(t('deleted', { name: template.name }));
    await load();
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="flex max-h-[88vh] flex-col gap-0 p-0 sm:max-w-2xl">
        <DialogHeader className="border-border border-b px-5 pt-5 pb-4">
          <div className="flex items-center gap-2">
            {draft && (
              <Button type="button" variant="ghost" size="icon-sm" aria-label={t('back')} onClick={() => setDraft(null)}>
                <ArrowLeft className="size-4" />
              </Button>
            )}
            <DialogTitle>{draft ? (draft.id ? t('editTitle') : t('newTitle')) : t('title')}</DialogTitle>
          </div>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {draft ? (
            <TemplateEditor draft={draft} onChange={setDraft} />
          ) : templates === null ? (
            <div className="flex justify-center py-10"><Loader2 className="text-muted-foreground size-5 animate-spin" /></div>
          ) : templates.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <span className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-2xl"><GalleryHorizontal className="size-5" /></span>
              <p className="max-w-sm text-[13px] text-muted-foreground">{t('empty')}</p>
            </div>
          ) : (
            <ul className="space-y-3" data-ig-template-list>
              {templates.map((template) => (
                <li key={template.id} className="border-border rounded-2xl border p-3.5">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold">{template.name}</span>
                    <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-[11px] font-medium">
                      {template.kind === 'cards' ? t('kindCards') : t('kindButton')}
                    </span>
                    {canEdit && (
                      <>
                        <Button type="button" variant="ghost" size="icon-sm" aria-label={t('edit', { name: template.name })} onClick={() => setDraft(draftOf(template))}>
                          <Pencil className="size-3.5" />
                        </Button>
                        <Button type="button" variant="ghost" size="icon-sm" aria-label={t('delete', { name: template.name })} aria-expanded={confirmDelete === template.id} onClick={() => setConfirmDelete(template.id)} className="hover:text-destructive">
                          <Trash2 className="size-3.5" />
                        </Button>
                      </>
                    )}
                  </div>
                  {confirmDelete === template.id && (
                    <div role="group" aria-label={t('delete', { name: template.name })} className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-red-500/8 px-3 py-2 text-[13px]">
                      <span className="min-w-0 flex-1">{t('confirmDelete', { name: template.name })}</span>
                      <Button type="button" size="sm" variant="destructive" className="rounded-full" autoFocus onClick={() => void remove(template)}>
                        {t('deleteConfirm')}
                      </Button>
                      <Button type="button" size="sm" variant="ghost" className="rounded-full" onClick={() => setConfirmDelete(null)}>
                        {t('cancel')}
                      </Button>
                    </div>
                  )}
                  <div className="mt-3">
                    {'cards' in template.payload ? (
                      <IgCardsPreview cards={cardViews(template.payload.cards)} />
                    ) : (
                      <IgButtonsPreview text={template.payload.text} buttons={template.payload.buttons.map((b) => ({ title: b.title, link: b.type === 'web_url' }))} />
                    )}
                  </div>
                  {canEdit && (
                    <div className="mt-3 flex justify-end">
                      <Button type="button" size="sm" className="rounded-full" onClick={() => { onSend(template); close(false); }}>
                        <Send className="size-3.5" />
                        {t('send')}
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {canEdit && (
          <div className="border-border flex items-center justify-between gap-2 border-t px-5 py-3">
            {draft ? (
              <>
                <DraftStatus draft={draft} />
                <Button type="button" className="rounded-full" disabled={saving || draftProblems(draft).length > 0} onClick={() => void save()}>
                  {saving && <Loader2 className="size-4 animate-spin" />}
                  {t('save')}
                </Button>
              </>
            ) : (
              <>
                <span className="text-muted-foreground text-xs">{t('windowHint')}</span>
                <Button type="button" variant="outline" className="rounded-full" onClick={() => setDraft(emptyDraft())}>
                  <Plus className="size-4" />
                  {t('new')}
                </Button>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The first thing stopping Save, or the limits once the template is complete. */
function DraftStatus({ draft }: { draft: Draft }) {
  const t = useTranslations('Inbox.igTemplates');
  const [first, ...rest] = draftProblems(draft);
  return (
    <p role="status" aria-live="polite" className={cn('min-w-0 text-xs', first ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground')}>
      {first ? t(first.key as never, first.values as never) + (rest.length ? ` ${t('problems.more', { count: rest.length })}` : '') : t('limitsHint')}
    </p>
  );
}

function TemplateEditor({ draft, onChange }: { draft: Draft; onChange: (draft: Draft) => void }) {
  const t = useTranslations('Inbox.igTemplates');
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  const setCard = (index: number, patch: Partial<CardDraft>) =>
    set({ cards: draft.cards.map((c, i) => (i === index ? { ...c, ...patch } : c)) });

  return (
    <div className="grid grid-cols-1 gap-5 md:grid-cols-[minmax(0,1fr)_240px]">
      <div className="space-y-4">
        <label className="block space-y-1.5 text-xs font-medium">
          {t('name')}
          <input className={inputClass} value={draft.name} maxLength={LIMITS.name} placeholder={t('namePlaceholder')} onChange={(e) => set({ name: e.target.value })} />
        </label>

        <div role="radiogroup" aria-label={t('kind')} className="bg-muted inline-flex rounded-full p-1">
          {(['cards', 'button'] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              role="radio"
              aria-checked={draft.kind === kind}
              onClick={() => set({ kind })}
              className={cn('inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium transition-colors duration-150',
                draft.kind === kind ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}
            >
              {kind === 'cards' ? <GalleryHorizontal className="size-3.5" /> : <MousePointerClick className="size-3.5" />}
              {kind === 'cards' ? t('kindCards') : t('kindButton')}
            </button>
          ))}
        </div>

        {draft.kind === 'cards' ? (
          <div className="space-y-3">
            {draft.cards.map((card, index) => (
              <fieldset key={index} className="border-border space-y-2.5 rounded-2xl border p-3.5">
                <legend className="sr-only">{t('cardN', { n: index + 1 })}</legend>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold">{t('cardN', { n: index + 1 })}</span>
                  {draft.cards.length > 1 && (
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={t('removeCard', { n: index + 1 })}
                      onClick={() => set({ cards: draft.cards.filter((_, i) => i !== index) })}>
                      <X className="size-3.5" />
                    </Button>
                  )}
                </div>
                <input className={inputClass} aria-label={t('cardTitle')} placeholder={t('cardTitle')} value={card.title} onChange={(e) => setCard(index, { title: e.target.value })} />
                <input className={inputClass} aria-label={t('cardSubtitle')} placeholder={t('cardSubtitle')} value={card.subtitle} onChange={(e) => setCard(index, { subtitle: e.target.value })} />
                <input className={inputClass} aria-label={t('imageUrl')} placeholder={t('imageUrlPlaceholder')} type="url" value={card.imageUrl} onChange={(e) => setCard(index, { imageUrl: e.target.value })} />
                <ButtonsEditor buttons={card.buttons} min={0} onChange={(buttons) => setCard(index, { buttons })} />
              </fieldset>
            ))}
            {draft.cards.length < LIMITS.cards && (
              <Button type="button" variant="outline" size="sm" className="rounded-full" onClick={() => set({ cards: [...draft.cards, emptyCard()] })}>
                <Plus className="size-3.5" />
                {t('addCard')}
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <label className="block space-y-1.5 text-xs font-medium">
              {t('text')}
              <textarea className={cn(inputClass, 'h-24 resize-none py-2 leading-5')} value={draft.text} onChange={(e) => set({ text: e.target.value })} />
            </label>
            <ButtonsEditor buttons={draft.buttons} min={1} onChange={(buttons) => set({ buttons })} />
          </div>
        )}
      </div>

      <div className="space-y-2">
        <p className="text-muted-foreground text-xs font-medium">{t('preview')}</p>
        <div className="bg-muted/60 rounded-2xl p-3">
          {draft.kind === 'cards' ? (
            <IgCardsPreview
              cards={draft.cards.map((c) => ({
                title: c.title.trim() || t('cardTitle'),
                subtitle: c.subtitle.trim() || null,
                imageUrl: httpsOk(c.imageUrl.trim()) ? c.imageUrl.trim() : null,
                buttons: c.buttons.map((b) => ({ title: b.title.trim() || t('buttonTitle'), link: b.type === 'web_url' })),
              }))}
            />
          ) : (
            <IgButtonsPreview
              text={draft.text.trim() || t('text')}
              buttons={draft.buttons.map((b) => ({ title: b.title.trim() || t('buttonTitle'), link: b.type === 'web_url' }))}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function ButtonsEditor({ buttons, min, onChange }: { buttons: ButtonDraft[]; min: number; onChange: (buttons: ButtonDraft[]) => void }) {
  const t = useTranslations('Inbox.igTemplates');
  const setButton = (index: number, patch: Partial<ButtonDraft>) => onChange(buttons.map((b, i) => (i === index ? { ...b, ...patch } : b)));
  return (
    <div className="space-y-2">
      {buttons.map((button, index) => (
        <div key={index} className="bg-muted/40 space-y-2 rounded-xl p-2">
          <div className="flex items-center gap-2">
            <select
              aria-label={t('buttonType')}
              value={button.type}
              onChange={(e) => setButton(index, { type: e.target.value as ButtonDraft['type'] })}
              className="border-border bg-card h-9 shrink-0 rounded-lg border px-2 text-[13px]"
            >
              <option value="reply">{t('buttonReply')}</option>
              <option value="web_url">{t('buttonLink')}</option>
            </select>
            <input className={cn(inputClass, 'min-w-0 flex-1')} aria-label={t('buttonTitle')} placeholder={t('buttonTitle')} value={button.title} onChange={(e) => setButton(index, { title: e.target.value })} />
            {buttons.length > min && (
              <Button type="button" variant="ghost" size="icon-sm" className="shrink-0" aria-label={t('removeButton')} onClick={() => onChange(buttons.filter((_, i) => i !== index))}>
                <X className="size-3.5" />
              </Button>
            )}
          </div>
          {button.type === 'web_url' && (
            <input className={inputClass} aria-label={t('buttonUrl')} placeholder="https://" type="url" value={button.url} onChange={(e) => setButton(index, { url: e.target.value })} />
          )}
        </div>
      ))}
      {buttons.length < LIMITS.buttons && (
        <button type="button" onClick={() => onChange([...buttons, emptyButton()])} className="text-primary text-xs font-medium hover:underline">
          + {t('addButton')}
        </button>
      )}
    </div>
  );
}
