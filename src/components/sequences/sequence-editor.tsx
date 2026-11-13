'use client';

// Instagram › Sequences › one sequence (Stage 5, 5H): the timeline editor.
// Each message is an Instagram automation of the workspace, sent its delay
// after the previous one (the first after subscribing). Per message: when it is
// sent, drag (or the arrow buttons) to reorder, the Active switch, a link to
// open its automation, and Sent / Clicks / Open rate / CTR. "+ Message" creates
// a new draft automation or picks an existing one. Any Instagram delay longer
// than 24 hours carries the window warning: the server skips a message whose
// window has closed (window_closed) and never sends it late.

import { useCallback, useEffect, useState, type DragEvent, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowDown, ArrowLeft, ArrowUp, GripVertical, Loader2, Pause, Pencil, Play, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { useFormatter, useTranslations } from 'next-intl';

import { useInstagramFlows } from '@/components/instagram/use-instagram-flows';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { channelPath } from '@/lib/channels/routes';
import { moveItem } from '@/lib/sequences/schedule';
import { SEQUENCE_DELAY_UNITS, STAGE5_LIMITS, type SequenceDelayUnit } from '@/types';
import {
  sequenceApi,
  sequenceErrorKey,
  type SequenceDetail,
  type SequenceMessageView,
  type SequenceSubscriber,
} from './sequence-api';
import { formatRate, parseDelayInput, scheduleLabel, windowWarning } from './sequence-format';

type T = ReturnType<typeof useTranslations<'Instagram.sequences'>>;

const SEQUENCES_PATH = '/instagram/sequences';

export function SequenceEditor({ id }: { id: string }) {
  const t = useTranslations('Instagram.sequences');
  const router = useRouter();
  const { accountId } = useAuth();
  const canEdit = useCan('send-messages');
  const [sequence, setSequence] = useState<SequenceDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [subscribersKey, setSubscribersKey] = useState(0);

  const load = useCallback(async () => {
    try {
      const next = await sequenceApi.get(id);
      setSequence(next);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [id]);

  useEffect(() => {
    if (!accountId) return;
    let live = true;
    sequenceApi.get(id).then((next) => { if (live) { setSequence(next); setFailed(false); } }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [accountId, id]);

  /** Runs one change; the server answers with the whole sequence, which replaces the local copy. */
  const run = async (work: () => Promise<SequenceDetail | void>): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    try {
      const next = await work();
      if (next) setSequence(next);
      return true;
    } catch (error) {
      toast.error(t(`errors.${sequenceErrorKey(error)}`));
      void load();
      return false;
    } finally {
      setBusy(false);
    }
  };

  const rename = async (event: FormEvent) => {
    event.preventDefault();
    const name = renaming?.trim();
    if (!name) return;
    if (await run(() => sequenceApi.update(id, { name }))) setRenaming(null);
  };

  const reorder = (order: string[]) => {
    if (!sequence) return;
    const byId = new Map(sequence.items.map((item) => [item.id, item]));
    // Shown at once; the server's answer (or a reload after a refusal) settles it.
    setSequence({ ...sequence, items: order.map((itemId, position) => ({ ...byId.get(itemId)!, position })) });
    void run(() => sequenceApi.reorder(id, order));
  };

  if (failed)
    return (
      <div className="flex items-center gap-3 text-sm">
        <p className="text-destructive">{t('loadFailed')}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => void load()}>{t('retry')}</Button>
      </div>
    );
  if (!sequence) return <Loader2 className="text-muted-foreground size-4 animate-spin" aria-label={t('loading')} />;

  const ids = sequence.items.map((item) => item.id);

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link href={SEQUENCES_PATH} className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm">
          <ArrowLeft className="size-3.5" />
          {t('back')}
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-3">
          {renaming !== null ? (
            <form onSubmit={(e) => void rename(e)} className="flex flex-1 flex-wrap items-center gap-2">
              <Input aria-label={t('rename')} autoFocus value={renaming} maxLength={STAGE5_LIMITS.sequenceNameChars}
                className="max-w-sm" onChange={(e) => setRenaming(e.target.value)} />
              <Button type="submit" size="sm" disabled={busy || !renaming.trim()}>{t('save')}</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setRenaming(null)}>{t('cancel')}</Button>
            </form>
          ) : (
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="text-foreground truncate text-[22px] font-bold tracking-tight">{sequence.name}</h1>
              <Badge variant={sequence.status === 'active' ? 'default' : 'secondary'}>{t(`statusLabel.${sequence.status}`)}</Badge>
              {canEdit && (
                <Button type="button" size="icon-sm" variant="ghost" aria-label={t('rename')} onClick={() => setRenaming(sequence.name)}>
                  <Pencil className="size-3.5" />
                </Button>
              )}
            </div>
          )}
          {canEdit && (
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" disabled={busy}
                onClick={() => void run(() => sequenceApi.update(id, { status: sequence.status === 'active' ? 'paused' : 'active' }))}>
                {sequence.status === 'active' ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
                {sequence.status === 'active' ? t('pause') : t('resume')}
              </Button>
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setConfirmDelete(true)}>
                <Trash2 className="size-3.5" />
                {t('remove')}
              </Button>
            </div>
          )}
        </div>
        <dl className="text-muted-foreground flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <Stat label={t('subscribers')} value={String(sequence.subscribers)} />
          <Stat label={t('sent')} value={String(sequence.sent)} />
          <Stat label={t('openRate')} value={formatRate(sequence.open_rate)} hint={t('openRateHint')} />
          <Stat label={t('ctr')} value={formatRate(sequence.ctr)} />
        </dl>
      </div>

      <div className="border-border bg-muted/40 text-muted-foreground flex gap-2 rounded-lg border p-3 text-sm" role="note">
        <TriangleAlert className="mt-0.5 size-4 shrink-0" />
        <div className="space-y-1">
          <p>{t('windowWarning')}</p>
          <p>{t('howToJoin')}</p>
          {!canEdit && <p>{t('readOnly')}</p>}
        </div>
      </div>

      <ol className="space-y-3" aria-label={t('messages')}>
        {sequence.items.length === 0 && <li className="text-muted-foreground text-sm">{t('emptyMessages')}</li>}
        {sequence.items.map((item, index) => (
          <MessageRow key={item.id} t={t} item={item} index={index} count={ids.length} canEdit={canEdit} busy={busy}
            onMove={(offset) => reorder(moveItem(ids, index, offset))}
            onDrop={(fromId) => {
              const from = ids.indexOf(fromId);
              if (from < 0 || from === index) return;
              const order = ids.filter((x) => x !== fromId);
              order.splice(index, 0, fromId);
              reorder(order);
            }}
            onPatch={(patch) => run(() => sequenceApi.updateMessage(id, item.id, patch))}
            onRemove={() => void run(() => sequenceApi.removeMessage(id, item.id))} />
        ))}
      </ol>

      {canEdit && sequence.items.length < STAGE5_LIMITS.sequenceMessages && (
        <AddMessage t={t} sequence={sequence} busy={busy}
          onAddNew={(name) => run(() => sequenceApi.addNew(id, name))}
          onAddExisting={(flowId) => run(() => sequenceApi.addExisting(id, flowId))} />
      )}

      <Subscribers t={t} id={id} canEdit={canEdit} reloadKey={subscribersKey}
        onChanged={() => { setSubscribersKey((k) => k + 1); void load(); }} />

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent className="border-border bg-popover sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">{t('removeTitle')}</DialogTitle>
            <DialogDescription className="text-muted-foreground">{t('removeBody')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setConfirmDelete(false)}>{t('cancel')}</Button>
            <Button type="button" variant="destructive" disabled={busy}
              onClick={() => void run(async () => {
                await sequenceApi.archive(id);
                setConfirmDelete(false);
                router.push(SEQUENCES_PATH);
              })}>
              {t('remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex gap-1.5" title={hint}>
      <dt>{label}</dt>
      <dd className="text-foreground font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function scheduleText(t: T, item: Pick<SequenceMessageView, 'position' | 'delay_amount' | 'delay_unit'>): string {
  const label = scheduleLabel(item.position, item.delay_amount, item.delay_unit);
  const when = label.kind === 'immediately'
    ? t('immediately')
    : t('after', { amount: label.amount, unit: t(`unit.${label.unit}`, { count: label.amount }) });
  return `${when} · ${label.anchor === 'first' ? t('scheduleFirst') : t('schedulePrevious')}`;
}

function MessageRow({ t, item, index, count, canEdit, busy, onMove, onDrop, onPatch, onRemove }: {
  t: T; item: SequenceMessageView; index: number; count: number; canEdit: boolean; busy: boolean;
  onMove: (offset: -1 | 1) => void; onDrop: (fromId: string) => void;
  onPatch: (patch: { delay_amount?: number; delay_unit?: string; active?: boolean }) => Promise<boolean>; onRemove: () => void;
}) {
  const number = index + 1;
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState(String(item.delay_amount));
  const [unit, setUnit] = useState<SequenceDelayUnit>(item.delay_unit);
  const [dragOver, setDragOver] = useState(false);
  const delay = parseDelayInput(amount, unit);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!delay) return;
    if (await onPatch({ delay_amount: delay.amount, delay_unit: delay.unit })) setEditing(false);
  };

  const dragProps = canEdit ? {
    onDragOver: (e: DragEvent) => { e.preventDefault(); setDragOver(true); },
    onDragLeave: () => setDragOver(false),
    onDrop: (e: DragEvent) => { e.preventDefault(); setDragOver(false); onDrop(e.dataTransfer.getData('text/x-sequence-message')); },
  } : {};

  return (
    <li className="space-y-1.5" {...dragProps} data-testid="sequence-message">
      <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
        <span>{scheduleText(t, item)}</span>
        {canEdit && !editing && (
          <Button type="button" variant="ghost" size="icon-xs" aria-label={t('editSchedule', { number })}
            onClick={() => { setAmount(String(item.delay_amount)); setUnit(item.delay_unit); setEditing(true); }}>
            <Pencil className="size-3" />
          </Button>
        )}
        {windowWarning(item.delay_amount, item.delay_unit) && (
          <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
            <TriangleAlert className="size-3" />
            {t('windowShort')}
          </span>
        )}
      </div>
      {editing && (
        <form onSubmit={(e) => void save(e)} className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor={`delay-${item.id}`} className="text-xs">{t('delayAmount')}</Label>
            <Input id={`delay-${item.id}`} inputMode="numeric" className="w-24" value={amount} autoFocus
              onChange={(e) => setAmount(e.target.value)} aria-invalid={!delay} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t('delayUnit')}</Label>
            <Select value={unit} onValueChange={(v) => { if (v) setUnit(v as SequenceDelayUnit); }}>
              <SelectTrigger aria-label={t('delayUnit')} className="w-32">
                <SelectValue>{t(`unit.${unit}`, { count: delay?.amount ?? 2 })}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {SEQUENCE_DELAY_UNITS.map((u) => <SelectItem key={u} value={u}>{t(`unit.${u}`, { count: 2 })}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <Button type="submit" size="sm" disabled={busy || !delay}>{t('save')}</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>{t('cancel')}</Button>
          {!delay && <p className="text-destructive w-full text-xs">{t('delayInvalid')}</p>}
          {delay && windowWarning(delay.amount, delay.unit) && <p className="w-full text-xs text-amber-600 dark:text-amber-400">{t('windowWarning')}</p>}
        </form>
      )}
      <Card className={dragOver ? 'ring-primary ring-2' : undefined}>
        <CardContent className="flex flex-wrap items-center gap-3 py-3">
          {canEdit && (
            <span draggable aria-label={t('dragHandle', { number })} role="img" className="text-muted-foreground cursor-grab"
              onDragStart={(e) => { e.dataTransfer.setData('text/x-sequence-message', item.id); e.dataTransfer.effectAllowed = 'move'; }}>
              <GripVertical className="size-4" />
            </span>
          )}
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="text-foreground text-sm font-medium">{t('messageLabel', { number })}</p>
            {item.flow_id ? (
              <Link href={channelPath('instagram', 'flows', item.flow_id)} className="text-primary text-sm hover:underline">
                {item.flow_name ?? t('openMessage')} · {t('openMessage')}
              </Link>
            ) : (
              <p className="text-destructive text-sm">{t('missing')}</p>
            )}
            {item.flow_id && item.flow_status !== 'active' && <p className="text-muted-foreground text-xs">{t('notLive')}</p>}
            {index === 0 && <p className="text-muted-foreground text-xs">{t('notPromotional')}</p>}
          </div>
          <dl className="text-muted-foreground grid grid-cols-4 gap-x-4 text-xs">
            <dt>{t('sent')}</dt><dt>{t('clicks')}</dt><dt title={t('openRateHint')}>{t('openRate')}</dt><dt>{t('ctr')}</dt>
            <dd className="text-foreground tabular-nums">{item.sent}</dd>
            <dd className="text-foreground tabular-nums">{item.clicks}</dd>
            <dd className="text-foreground tabular-nums">{formatRate(item.open_rate)}</dd>
            <dd className="text-foreground tabular-nums">{formatRate(item.ctr)}</dd>
          </dl>
          <div className="flex items-center gap-1">
            <Label className="text-muted-foreground mr-1 text-xs" htmlFor={`active-${item.id}`}>{t('active')}</Label>
            <Switch id={`active-${item.id}`} aria-label={t('activeLabel', { number })} checked={item.active}
              disabled={!canEdit || busy} onCheckedChange={(checked) => void onPatch({ active: checked })} />
            {canEdit && (
              <>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={t('moveUp', { number })} disabled={busy || index === 0}
                  onClick={() => onMove(-1)}><ArrowUp className="size-3.5" /></Button>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={t('moveDown', { number })} disabled={busy || index === count - 1}
                  onClick={() => onMove(1)}><ArrowDown className="size-3.5" /></Button>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={t('removeMessage', { number })} disabled={busy}
                  onClick={onRemove}><Trash2 className="size-3.5" /></Button>
              </>
            )}
          </div>
        </CardContent>
      </Card>
    </li>
  );
}

function AddMessage({ t, sequence, busy, onAddNew, onAddExisting }: {
  t: T; sequence: SequenceDetail; busy: boolean;
  onAddNew: (name: string) => Promise<boolean>; onAddExisting: (flowId: string) => Promise<boolean>;
}) {
  const { flows } = useInstagramFlows();
  const [mode, setMode] = useState<'closed' | 'new' | 'existing'>('closed');
  const defaultName = t('newMessageDefault', { sequence: sequence.name, number: sequence.items.length + 1 })
    .slice(0, STAGE5_LIMITS.sequenceNameChars);
  const [name, setName] = useState('');
  const [flowId, setFlowId] = useState('');
  const choices = (flows ?? []).filter((f) => f.status !== 'archived');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const ok = mode === 'new' ? await onAddNew(name.trim() || defaultName) : flowId ? await onAddExisting(flowId) : false;
    if (ok) { setMode('closed'); setName(''); setFlowId(''); }
  };

  if (mode === 'closed')
    return (
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={() => { setName(defaultName); setMode('new'); }}>
          <Plus className="size-4" />
          {t('addMessage')} · {t('createNew')}
        </Button>
        <Button type="button" variant="outline" onClick={() => setMode('existing')}>
          <Plus className="size-4" />
          {t('addMessage')} · {t('selectExisting')}
        </Button>
      </div>
    );

  const flowLabel = choices.find((f) => f.id === flowId)?.name;
  return (
    <Card>
      <CardContent className="pt-6">
        <form onSubmit={(e) => void submit(e)} className="flex flex-wrap items-end gap-3">
          {mode === 'new' ? (
            <div className="min-w-56 flex-1 space-y-1.5">
              <Label htmlFor="sequence-new-message">{t('newMessageName')}</Label>
              <Input id="sequence-new-message" autoFocus value={name} maxLength={STAGE5_LIMITS.sequenceNameChars}
                onChange={(e) => setName(e.target.value)} />
            </div>
          ) : (
            <div className="min-w-56 flex-1 space-y-1.5">
              <Label>{t('chooseAutomation')}</Label>
              {flows && choices.length === 0 ? (
                <p className="text-muted-foreground text-sm">{t('noAutomations')}</p>
              ) : (
                <Select value={flowId} onValueChange={(v) => setFlowId(typeof v === 'string' ? v : '')}>
                  <SelectTrigger aria-label={t('chooseAutomation')} className="w-full">
                    <SelectValue>{flowLabel ?? t('chooseAutomation')}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {choices.map((f) => <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              )}
            </div>
          )}
          <Button type="submit" disabled={busy || (mode === 'existing' && !flowId)}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {t('add')}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setMode('closed')}>{t('cancel')}</Button>
        </form>
      </CardContent>
    </Card>
  );
}

function Subscribers({ t, id, canEdit, reloadKey, onChanged }: {
  t: T; id: string; canEdit: boolean; reloadKey: number; onChanged: () => void;
}) {
  const format = useFormatter();
  const [rows, setRows] = useState<SequenceSubscriber[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await sequenceApi.subscribers(id);
      setRows(next);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [id]);

  useEffect(() => {
    let live = true;
    sequenceApi.subscribers(id).then((next) => { if (live) { setRows(next); setFailed(false); } }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [id, reloadKey]);

  const unsubscribe = async (contactId: string) => {
    setBusy(contactId);
    try {
      await sequenceApi.unsubscribe(id, contactId);
      onChanged();
    } catch (error) {
      toast.error(t(`errors.${sequenceErrorKey(error)}`));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('subscribersTitle')}</CardTitle>
      </CardHeader>
      <CardContent>
        {failed && (
          <div className="flex items-center gap-3 text-sm">
            <p className="text-destructive">{t('loadFailed')}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => void load()}>{t('retry')}</Button>
          </div>
        )}
        {!rows && !failed && <Loader2 className="text-muted-foreground size-4 animate-spin" aria-label={t('loading')} />}
        {rows?.length === 0 && <p className="text-muted-foreground text-sm">{t('noSubscribers')}</p>}
        {!!rows?.length && (
          <ul className="divide-y">
            {rows.map((row) => {
              const running = row.status === 'active' || row.status === 'sending';
              return (
                <li key={row.contact_id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <div className="min-w-0">
                    <p className="text-foreground truncate font-medium">{row.name || t('unnamedContact')}</p>
                    <p className="text-muted-foreground text-xs">
                      {t(`subscriberStatus.${row.status}`)}
                      {running && ' · '}
                      {running && (row.next_due_at
                        ? t('nextDue', { time: format.dateTime(new Date(row.next_due_at), { dateStyle: 'medium', timeStyle: 'short' }) })
                        : t('waiting'))}
                    </p>
                  </div>
                  {canEdit && running && (
                    <Button type="button" variant="outline" size="sm" disabled={busy === row.contact_id}
                      onClick={() => void unsubscribe(row.contact_id)}>
                      {t('unsubscribe')}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
