'use client';

// Instagram › Sequences (Stage 5, 5H): the workspace's sequences with
// Subscribers, Messages, Open rate and CTR, and "New sequence". A row opens the
// timeline editor. Members read; agents and above create.

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { STAGE5_LIMITS } from '@/types';
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
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-foreground text-2xl font-bold tracking-tight">{t('title')}</h1>
          <p className="text-muted-foreground mt-1 text-sm">{t('description')}</p>
        </div>
        {canEdit && !creating && (
          <Button type="button" onClick={() => setCreating(true)}>
            <Plus className="size-4" />
            {t('new')}
          </Button>
        )}
      </div>

      {creating && (
        <Card>
          <CardContent className="pt-6">
            <form onSubmit={(e) => void create(e)} className="flex flex-wrap items-end gap-3">
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
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('title')}</CardTitle>
          <p className="text-muted-foreground text-xs">{t('windowWarning')}</p>
        </CardHeader>
        <CardContent>
          {failed && (
            <div className="flex items-center gap-3 text-sm">
              <p className="text-destructive">{t('loadFailed')}</p>
              <Button type="button" variant="outline" size="sm" onClick={() => void load()}>{t('retry')}</Button>
            </div>
          )}
          {!rows && !failed && <Loader2 className="text-muted-foreground size-4 animate-spin" aria-label={t('loading')} />}
          {rows?.length === 0 && <p className="text-muted-foreground text-sm">{t('empty')}</p>}
          {!!rows?.length && (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('name')}</TableHead>
                    <TableHead className="text-right">{t('subscribers')}</TableHead>
                    <TableHead className="text-right">{t('messages')}</TableHead>
                    <TableHead className="text-right" title={t('openRateHint')}>{t('openRate')}</TableHead>
                    <TableHead className="text-right">{t('ctr')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Link href={sequencePath(row.id)} className="text-foreground font-medium hover:underline">{row.name}</Link>
                          <Badge variant={row.status === 'active' ? 'default' : 'secondary'}>{t(`statusLabel.${row.status}`)}</Badge>
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{row.subscribers}</TableCell>
                      <TableCell className="text-right tabular-nums">{row.messages}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatRate(row.open_rate)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatRate(row.ctr)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
