'use client';

// Stage 5 (5E): the open conversation's favourite switch and labels, in the
// inbox contact panel. Labels are applied by hand (no auto-apply rules); agents
// and above apply and create them, viewers see them. The favourite is personal.
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Plus, Star, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { InboxFolders } from '@/components/inbox/use-inbox-folders';
import { authFetch } from '@/lib/auth/client';
import { cn } from '@/lib/utils';
import { LABEL_COLORS, STAGE5_LIMITS, type LabelColor } from '@/types';

/** Theme-following dot colour per label palette token. */
export const LABEL_DOT_CLASS: Record<LabelColor, string> = {
  gray: 'bg-muted-foreground',
  red: 'bg-red-500',
  orange: 'bg-orange-500',
  amber: 'bg-amber-500',
  green: 'bg-emerald-500',
  teal: 'bg-teal-500',
  blue: 'bg-blue-500',
  violet: 'bg-violet-500',
  pink: 'bg-pink-500',
};

export function LabelDot({ color, className }: { color: LabelColor; className?: string }) {
  return <span aria-hidden className={cn('inline-block h-2 w-2 shrink-0 rounded-full', LABEL_DOT_CLASS[color], className)} />;
}

interface LabelPickerProps {
  conversationId: string;
  folders: InboxFolders;
  /** Agents and above apply, create and delete labels. */
  canEdit: boolean;
}

export function LabelPicker({ conversationId, folders, canEdit }: LabelPickerProps) {
  const t = useTranslations('Inbox.labels');
  const tf = useTranslations('Inbox.favourites');
  const [managing, setManaging] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState<LabelColor>('blue');
  const [busy, setBusy] = useState(false);
  const applied = folders.context.labelsByConversation?.get(conversationId) ?? new Set<string>();
  const favourite = folders.favouriteIds.has(conversationId);
  const atLimit = folders.labels.length >= STAGE5_LIMITS.labelsPerWorkspace;

  async function toggleFavourite() {
    setBusy(true);
    const ok = await folders.setFavourite(conversationId, !favourite);
    setBusy(false);
    if (!ok) toast.error(t('failed'));
  }

  async function toggleLabel(labelId: string) {
    setBusy(true);
    const ok = await folders.setLabel(conversationId, labelId, !applied.has(labelId));
    setBusy(false);
    if (!ok) toast.error(t('failed'));
  }

  async function createLabel(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      const res = await authFetch('/api/inbox/labels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed, color }),
      });
      const body = (await res.json().catch(() => null)) as { code?: string; label?: { id: string } } | null;
      if (!res.ok) {
        toast.error(body?.code === 'name_taken' ? t('nameTaken') : body?.code === 'limit' ? t('limit') : t('failed'));
        return;
      }
      setName('');
      folders.reloadLabels();
      if (body?.label?.id) await folders.setLabel(conversationId, body.label.id, true);
    } catch {
      toast.error(t('failed'));
    } finally {
      setBusy(false);
    }
  }

  async function deleteLabel(labelId: string, labelName: string) {
    if (!window.confirm(t('confirmDelete', { name: labelName }))) return;
    setBusy(true);
    const res = await authFetch(`/api/inbox/labels/${encodeURIComponent(labelId)}`, { method: 'DELETE' }).catch(() => null);
    setBusy(false);
    if (!res?.ok) toast.error(t('failed'));
    folders.reloadLabels();
  }

  return (
    <section className="border-border space-y-3 border-t pt-4" aria-label={t('title')}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase">{t('title')}</h3>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-pressed={favourite}
          disabled={busy}
          onClick={() => void toggleFavourite()}
          className="h-7 gap-1 px-2 text-xs"
        >
          <Star className={cn('size-3.5', favourite && 'fill-amber-400 text-amber-500')} aria-hidden />
          {favourite ? tf('remove') : tf('add')}
        </Button>
      </div>
      {folders.labels.length === 0 ? (
        <p className="text-muted-foreground text-xs">{t('empty')}</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {folders.labels.map((label) => {
            const on = applied.has(label.id);
            return (
              <li key={label.id} className="flex items-center">
                <button
                  type="button"
                  aria-pressed={on}
                  disabled={!canEdit || busy}
                  onClick={() => void toggleLabel(label.id)}
                  className={cn(
                    'focus-visible:ring-ring inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs outline-none focus-visible:ring-2',
                    on ? 'border-primary/40 bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:bg-muted',
                    !canEdit && 'cursor-default',
                  )}
                >
                  <LabelDot color={label.color} />
                  <span className="max-w-32 truncate">{label.name}</span>
                  {on && <Check className="size-3" aria-hidden />}
                </button>
                {managing && canEdit && (
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={t('deleteLabel', { name: label.name })}
                    title={t('deleteLabel', { name: label.name })}
                    onClick={() => void deleteLabel(label.id, label.name)}
                    className="text-muted-foreground hover:text-destructive focus-visible:ring-ring ml-0.5 rounded p-1 outline-none focus-visible:ring-2"
                  >
                    <Trash2 className="size-3" aria-hidden />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {canEdit && (
        <div className="space-y-2">
          <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" aria-expanded={managing} onClick={() => setManaging((v) => !v)}>
            {t('manage')}
          </Button>
          {managing && (
            <form className="space-y-2" onSubmit={(event) => void createLabel(event)}>
              <Input
                value={name}
                maxLength={STAGE5_LIMITS.labelNameChars}
                onChange={(event) => setName(event.target.value)}
                placeholder={t('name')}
                aria-label={t('name')}
                disabled={busy || atLimit}
                className="h-8 text-xs"
              />
              <fieldset className="flex flex-wrap gap-1.5" disabled={busy || atLimit}>
                <legend className="sr-only">{t('color')}</legend>
                {LABEL_COLORS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={color === option}
                    aria-label={t(`colors.${option}`)}
                    title={t(`colors.${option}`)}
                    onClick={() => setColor(option)}
                    className={cn(
                      'focus-visible:ring-ring flex h-6 w-6 items-center justify-center rounded-full border outline-none focus-visible:ring-2',
                      color === option ? 'border-foreground' : 'border-transparent',
                    )}
                  >
                    <LabelDot color={option} className="h-3 w-3" />
                  </button>
                ))}
              </fieldset>
              <Button type="submit" size="sm" className="h-7 gap-1 text-xs" disabled={busy || atLimit || !name.trim()}>
                <Plus className="size-3.5" aria-hidden />
                {t('add')}
              </Button>
              {atLimit && <p className="text-muted-foreground text-xs">{t('limit')}</p>}
            </form>
          )}
        </div>
      )}
    </section>
  );
}
