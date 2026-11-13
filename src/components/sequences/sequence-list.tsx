'use client';

// Instagram › Sequences (Stage 5, 5H): the workspace's sequences with
// Subscribers, Messages, Open rate and CTR, and "New sequence". A row opens the
// timeline editor. Members read; agents and above create.

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Clock, Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { STAGE5_LIMITS } from '@/types';
import { cn } from '@/lib/utils';
import { sequenceApi, sequenceErrorKey, type SequenceSummary } from './sequence-api';
import { formatRate } from './sequence-format';

export const sequencePath = (id: string) => `/instagram/sequences/${encodeURIComponent(id)}`;

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
      const next = await sequenceApi.list();
      setRows(next);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    if (!accountId) return;
    let live = true;
    sequenceApi.list().then((next) => { if (live) { setRows(next); setFailed(false); } }, () => { if (live) setFailed(true); });
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

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-foreground text-[22px] font-bold tracking-tight">{t('title')}</h1>
          <p className="text-muted-foreground mt-1 text-sm">{t('description')}</p>
          <p className="text-muted-foreground mt-1 text-xs">{t('windowWarning')}</p>
        </div>
        {canEdit && !creating && (
          <Button type="button" onClick={() => setCreating(true)}>
            <Plus className="size-4" />
            {t('new')}
          </Button>
        )}
      </div>

      {creating && (
        <form onSubmit={(e) => void create(e)} className="border-border bg-card mt-6 flex flex-wrap items-end gap-3 rounded-xl border p-4">
          <div className="min-w-56 flex-1 space-y-1.5">
            <Label htmlFor="sequence-name">{t('name')}</Label>
            <Input id="sequence-name" autoFocus value={name} maxLength={STAGE5_LIMITS.sequenceNameChars}
              placeholder={t('namePlaceholder')} onChange={(e) => setName(e.target.value)} />
          </div>
          <Button type="submit" disabled={busy || !name.trim()}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {t('create')}
          </Button>
          <Button type="button" variant="ghost" onClick={() => { setCreating(false); setName(''); }}>{t('cancel')}</Button>
        </form>
      )}

      <div className="mt-6">
        {failed && (
          <div className="border-border flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3 text-sm">
            <p className="text-destructive">{t('loadFailed')}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => void load()}>{t('retry')}</Button>
          </div>
        )}
        {!rows && !failed && (
          <div className="flex justify-center py-12">
            <Loader2 className="text-muted-foreground size-5 animate-spin" aria-label={t('loading')} />
          </div>
        )}
        {rows?.length === 0 && (
          <div className="border-border bg-card flex flex-col items-center gap-2 rounded-xl border px-4 py-12 text-center">
            <span className="bg-primary/10 text-primary mb-2 inline-flex size-[52px] items-center justify-center rounded-2xl">
              <Clock className="size-6" aria-hidden />
            </span>
            <p className="text-muted-foreground text-sm">{t('empty')}</p>
          </div>
        )}
        {!!rows?.length && (
          <div className="border-border bg-card overflow-x-auto rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted hover:bg-muted border-border">
                  <TableHead className="text-muted-foreground h-9 px-4 text-xs font-semibold">{t('name')}</TableHead>
                  <TableHead className="text-muted-foreground h-9 px-4 text-right text-xs font-semibold">{t('subscribers')}</TableHead>
                  <TableHead className="text-muted-foreground h-9 px-4 text-right text-xs font-semibold">{t('messages')}</TableHead>
                  <TableHead className="text-muted-foreground h-9 px-4 text-right text-xs font-semibold" title={t('openRateHint')}>{t('openRate')}</TableHead>
                  <TableHead className="text-muted-foreground h-9 px-4 text-right text-xs font-semibold">{t('ctr')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id} className="border-border/60 hover:bg-muted/50 transition-colors duration-150">
                    <TableCell className="px-4 py-3">
                      <div className="flex min-w-0 items-center gap-3">
                        <span className="bg-primary/10 text-primary inline-flex size-[34px] shrink-0 items-center justify-center rounded-[10px]" aria-hidden>
                          <Clock className="size-4" />
                        </span>
                        <Link href={sequencePath(row.id)} className="text-foreground hover:text-primary truncate text-sm font-semibold transition-colors duration-150">{row.name}</Link>
                        <span className={cn('inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
                          row.status === 'active' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-muted text-muted-foreground')}>
                          {t(`statusLabel.${row.status}`)}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="px-4 py-3 text-right text-[13px] tabular-nums">{row.subscribers}</TableCell>
                    <TableCell className="px-4 py-3 text-right text-[13px] tabular-nums">{row.messages}</TableCell>
                    <TableCell className="px-4 py-3 text-right text-[13px] tabular-nums">{formatRate(row.open_rate)}</TableCell>
                    <TableCell className="px-4 py-3 text-right text-[13px] tabular-nums">{formatRate(row.ctr)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}
