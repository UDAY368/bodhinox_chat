'use client';

// Instagram › Sequences (Stage 5, 5H): the workspace's sequences with
// Subscribers, Messages, Open rate and CTR, and "New sequence". A row opens the
// timeline editor. Members read; agents and above create. Only Instagram
// sequences list here; WhatsApp ones list in the Automation list.
// Apple's way (b7): one large title with "New sequence" top right (it opens a
// sheet), a grouped list, the shared loading, empty and failed states.

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Clock, Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { GroupedList, GroupedListRow } from '@/components/ui/grouped-list';
import { InlineError } from '@/components/ui/inline-error';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/ui/page-header';
import { PageLoading } from '@/components/ui/page-loading';
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { STAGE5_LIMITS } from '@/types';
import { cn } from '@/lib/utils';
import { sequenceApi, sequenceErrorKey, type SequenceSummary } from './sequence-api';
import { formatRate } from './sequence-format';

export const sequencePath = (id: string) => `/instagram/sequences/${encodeURIComponent(id)}`;
const instagramOnly = (rows: SequenceSummary[]) => rows.filter((row) => row.channel === 'instagram');

export function SequenceList() {
  const t = useTranslations('Instagram.sequences');
  const router = useRouter();
  const { accountId } = useAuth();
  const canEdit = useCan('send-messages');
  const [rows, setRows] = useState<SequenceSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = instagramOnly(await sequenceApi.list());
      setRows(next);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    if (!accountId) return;
    let live = true;
    sequenceApi.list().then((next) => { if (live) { setRows(instagramOnly(next)); setFailed(false); } }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [accountId]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      const sequence = await sequenceApi.create(trimmed);
      router.push(sequencePath(sequence.id));
    } catch (error) {
      toast.error(t(`errors.${sequenceErrorKey(error)}`));
      setBusy(false);
    }
  };

  const closeSheet = () => { setCreating(false); setName(''); };
  const newButton = canEdit ? (
    <Button type="button" onClick={() => setCreating(true)}>
      <Plus className="size-4" />
      {t('new')}
    </Button>
  ) : undefined;

  return (
    <div>
      <PageHeader
        title={t('title')}
        subtitle={(
          <>
            {t('description')}
            <span className="mt-1 block text-xs">{t('windowWarning')}</span>
          </>
        )}
        primaryAction={newButton}
      />

      {failed && <InlineError message={t('loadFailed')} onRetry={() => void load()} />}
      {!rows && !failed && <PageLoading rows={4} />}
      {rows?.length === 0 && <EmptyState icon={Clock} title={t('empty')} />}
      {!!rows?.length && (
        <GroupedList>
          {rows.map((row) => (
            <GroupedListRow
              key={row.id}
              href={sequencePath(row.id)}
              leading={(
                <span className="bg-primary/10 text-primary inline-flex size-7 items-center justify-center rounded-lg" aria-hidden>
                  <Clock className="size-4" />
                </span>
              )}
              title={<span className="font-semibold">{row.name}</span>}
              subtitle={(
                <span className="tabular-nums">
                  {t('subscribers')} {row.subscribers} · {t('messages')} {row.messages} · <span title={t('openRateHint')}>{t('openRate')}</span> {formatRate(row.open_rate)} · {t('ctr')} {formatRate(row.ctr)}
                </span>
              )}
              trailing={(
                <span className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
                  row.status === 'active' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-muted text-muted-foreground')}>
                  {t(`statusLabel.${row.status}`)}
                </span>
              )}
            />
          ))}
        </GroupedList>
      )}

      <Sheet open={creating} onOpenChange={(open) => { if (!open && !busy) closeSheet(); }}>
        <SheetContent side="right" size="sm">
          <form onSubmit={(e) => void create(e)} className="flex h-full flex-col">
            <SheetHeader>
              <SheetTitle>{t('new')}</SheetTitle>
            </SheetHeader>
            <div className="flex-1 space-y-1.5 px-4">
              <Label htmlFor="sequence-name">{t('name')}</Label>
              <Input id="sequence-name" autoFocus value={name} maxLength={STAGE5_LIMITS.sequenceNameChars}
                placeholder={t('namePlaceholder')} onChange={(e) => setName(e.target.value)} />
            </div>
            <SheetFooter className="flex-row justify-end gap-2">
              <Button type="button" variant="ghost" onClick={closeSheet} disabled={busy}>{t('cancel')}</Button>
              <Button type="submit" disabled={busy || !name.trim()}>
                {busy && <Loader2 className="size-4 animate-spin" />}
                {t('create')}
              </Button>
            </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>
    </div>
  );
}
