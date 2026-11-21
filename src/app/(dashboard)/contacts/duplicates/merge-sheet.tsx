'use client';

// The merge sheet: pick the contact to keep, see what will move (GET
// /api/contacts/merge counts), then Merge asks once more in the in-app confirm
// (Merge in red: the merged contact is deleted and it cannot be undone) and POSTs.
import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { GroupedList, GroupedListRow } from '@/components/ui/grouped-list';
import { InlineError } from '@/components/ui/inline-error';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { authFetch } from '@/lib/auth/client';
import type { DuplicatePair } from '@/lib/contacts/duplicates';
import type { MergeCounts } from '@/lib/contacts/merge';

const SHOWN: (keyof MergeCounts)[] = ['conversations', 'messages', 'tags', 'notes', 'orders', 'deals', 'appointments',
  'payments', 'formAnswers', 'sequences', 'customValues', 'identities', 'lists', 'tasks'];
const KNOWN_ERRORS = new Set(['phone_conflict', 'identity_conflict', 'contact_busy', 'not_found', 'forbidden']);

type Preview = { state: 'loading' } | { state: 'ready'; counts: MergeCounts } | { state: 'refused'; code: string } | { state: 'error' };

export function MergeSheet({ pair, onOpenChange, onMerged }: {
  pair: DuplicatePair | null;
  onOpenChange: (open: boolean) => void;
  onMerged: (mergedId: string) => void;
}) {
  const t = useTranslations('Contacts.duplicates');
  const confirm = useConfirm();
  const [choice, setChoice] = useState<{ pairKey: string; index: 0 | 1 } | null>(null);
  const [loaded, setLoaded] = useState<{ key: string; preview: Preview } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const pairKey = pair ? `${pair.contacts[0].id}.${pair.contacts[1].id}` : '';

  // A new pair starts with the older contact as the one kept, until the admin picks.
  const olderIndex: 0 | 1 = pair && pair.contacts[0].created_at && pair.contacts[1].created_at
    && pair.contacts[1].created_at < pair.contacts[0].created_at ? 1 : 0;
  const keepIndex = choice?.pairKey === pairKey ? choice.index : olderIndex;
  const setKeepIndex = (index: 0 | 1) => setChoice({ pairKey, index });

  const keep = pair?.contacts[keepIndex];
  const merged = pair?.contacts[keepIndex === 0 ? 1 : 0];
  // The preview shown belongs to this keep/merge choice (and retry); anything else is still loading.
  const requestKey = keep && merged ? `${keep.id}.${merged.id}.${attempt}` : '';
  const preview: Preview = loaded?.key === requestKey ? loaded.preview : { state: 'loading' };
  const setPreview = (next: Preview) => setLoaded({ key: requestKey, preview: next });

  useEffect(() => {
    if (!keep || !merged) return;
    let live = true;
    const key = `${keep.id}.${merged.id}.${attempt}`;
    const query = new URLSearchParams({ keep_id: keep.id, merge_id: merged.id });
    void authFetch(`/api/contacts/merge?${query}`, { cache: 'no-store' }).then(async (res) => {
      const body = (await res.json().catch(() => ({}))) as { counts?: MergeCounts; code?: string };
      if (!live) return;
      if (res.ok && body.counts) setLoaded({ key, preview: { state: 'ready', counts: body.counts } });
      else if (body.code && KNOWN_ERRORS.has(body.code)) setLoaded({ key, preview: { state: 'refused', code: body.code } });
      else setLoaded({ key, preview: { state: 'error' } });
    }, () => {
      if (live) setLoaded({ key, preview: { state: 'error' } });
    });
    return () => {
      live = false;
    };
  }, [keep, merged, attempt]);

  const name = (index: 0 | 1) => pair?.contacts[index].name?.trim() || t('noName');

  const submit = async () => {
    if (!keep || !merged) return;
    const names = { merged: name(keepIndex === 0 ? 1 : 0), keep: name(keepIndex) };
    const ok = await confirm({
      title: t('confirmTitle', names),
      body: t('confirmBody', names),
      confirmLabel: t('mergeConfirm'),
      cancelLabel: t('cancel'),
      destructive: true,
    });
    if (!ok) return;
    setSaving(true);
    const res = await authFetch('/api/contacts/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keep_id: keep.id, merge_id: merged.id }),
    }).catch(() => null);
    setSaving(false);
    const body = (await res?.json().catch(() => ({}))) as { code?: string } | undefined;
    if (!res?.ok) {
      if (body?.code && KNOWN_ERRORS.has(body.code)) setPreview({ state: 'refused', code: body.code });
      else toast.error(t('mergeFailed'));
      return;
    }
    toast.success(t('merged'));
    onMerged(merged.id);
  };

  const moving = preview.state === 'ready' ? SHOWN.filter((k) => preview.counts[k] > 0) : [];

  return (
    <Sheet open={!!pair} onOpenChange={onOpenChange}>
      <SheetContent size="md" className="flex w-full flex-col gap-0">
        <SheetHeader>
          <SheetTitle>{t('mergeTitle')}</SheetTitle>
          <SheetDescription>{t('mergeDescription')}</SheetDescription>
        </SheetHeader>
        {pair && (
          <div className="flex-1 space-y-5 overflow-y-auto px-4 pb-4">
            <div className="space-y-2">
              <p className="text-[13px] font-medium text-muted-foreground">{t('keepLabel')}</p>
              <SegmentedControl
                aria-label={t('keepLabel')}
                value={String(keepIndex)}
                onValueChange={(value) => setKeepIndex(value === '1' ? 1 : 0)}
                options={([0, 1] as const).map((index) => ({ value: String(index), label: <span className="truncate">{name(index)}</span> }))}
                className="w-full"
              />
              <p className="text-[13px] text-muted-foreground">
                {t('mergeInto', { merged: name(keepIndex === 0 ? 1 : 0), keep: name(keepIndex) })}
              </p>
            </div>

            <div className="space-y-2">
              <p className="text-[13px] font-medium text-muted-foreground">{t('willMove')}</p>
              {preview.state === 'loading' ? (
                <GroupedList>
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="flex min-h-11 items-center justify-between px-4" aria-hidden>
                      <span className="h-3 w-24 animate-pulse rounded bg-muted" />
                      <span className="h-3 w-6 animate-pulse rounded bg-muted" />
                    </div>
                  ))}
                </GroupedList>
              ) : preview.state === 'error' ? (
                <InlineError message={t('previewFailed')} onRetry={() => setAttempt((n) => n + 1)} className="py-6" />
              ) : preview.state === 'refused' ? (
                <p role="alert" className="rounded-group bg-destructive/10 px-4 py-3 text-sm text-destructive">{t(`refused.${preview.code}`)}</p>
              ) : moving.length === 0 ? (
                <GroupedList><GroupedListRow title={<span className="text-muted-foreground">{t('nothingMoves')}</span>} /></GroupedList>
              ) : (
                <GroupedList>
                  {moving.map((k) => (
                    <GroupedListRow key={k} title={t(`counts.${k}`)}
                      trailing={<span className="tabular-nums">{preview.state === 'ready' ? preview.counts[k] : 0}</span>} />
                  ))}
                </GroupedList>
              )}
              {preview.state === 'ready' && preview.counts.combinedConversations > 0 && (
                <p className="text-[13px] text-muted-foreground">{t('combined', { count: preview.counts.combinedConversations })}</p>
              )}
              <p className="text-[13px] text-muted-foreground">{t('rules')}</p>
            </div>
          </div>
        )}
        <SheetFooter className="flex-row justify-end gap-2 border-t border-border">
          <Button variant="ghost" className="min-h-11" onClick={() => onOpenChange(false)}>{t('cancel')}</Button>
          <Button
            className="min-h-11"
            disabled={saving || preview.state !== 'ready'}
            onClick={() => void submit()}
          >
            {saving && <Loader2 className="size-4 animate-spin" />}
            {t('mergeConfirm')}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
