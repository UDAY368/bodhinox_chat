'use client';

// Instagram › Sequences › one sequence (Stage 5, 5H): the timeline editor.
// Each message is an Instagram automation of the workspace, sent its delay
// after the previous one (the first after subscribing). Per message: when it is
// sent, drag (or the arrow buttons) to reorder, the Active switch, a link to
// open its automation, and Sent / Clicks / Open rate / CTR. Any Instagram delay
// longer than 24 hours carries the window warning: the server skips a message
// whose window has closed (window_closed) and never sends it late.
// Batch 7: a channel choice (Instagram / WhatsApp, while there are no
// messages), WhatsApp steps (a message, when it is sent, and the template sent
// when the 24-hour window is closed, edited in a sheet) and "Exit when".
// Apple's way: one large title, one primary button ("Add message", which opens
// a sheet), Rename / Pause / Delete in the "more" menu, deletes confirmed in
// the in-app dialog. Phase 2: 44px row buttons, subscribers in a grouped list.

import { useCallback, useEffect, useState, type DragEvent, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowDown, ArrowLeft, ArrowUp, GripVertical, Loader2, Pause, Pencil, Play, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { useFormatter, useTranslations } from 'next-intl';

import { useInstagramFlows } from '@/components/instagram/use-instagram-flows';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { GroupedList } from '@/components/ui/grouped-list';
import { InlineError } from '@/components/ui/inline-error';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/ui/page-header';
import { PageLoading } from '@/components/ui/page-loading';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { channelPath } from '@/lib/channels/routes';
import type { ExitSettings } from '@/lib/sequences/whatsapp';
import { moveItem } from '@/lib/sequences/schedule';
import { SEQUENCE_DELAY_UNITS, STAGE5_LIMITS, type SequenceDelayUnit } from '@/types';
import {
  sequenceApi,
  sequenceErrorKey,
  type SequenceDetail,
  type SequenceMessageView,
  type SequenceSubscriber,
} from './sequence-api';
import { formatRate, parseDelayInput, scheduleLabel, sequencePath, windowWarning } from './sequence-format';
import { ChannelControl, ExitWhenSection, stepFromItem, WhatsAppStepSheet, type StepDelay } from './whatsapp-step';

type T = ReturnType<typeof useTranslations<'Instagram.sequences'>>;

const SEQUENCES_PATH = '/instagram/sequences';
/** WhatsApp sequences list in the Automation list (there is no WhatsApp sequences tab). */
const AUTOMATION_PATH = '/automation';

export function SequenceEditor({ id }: { id: string }) {
  const t = useTranslations('Instagram.sequences');
  const router = useRouter();
  const confirm = useConfirm();
  const { accountId } = useAuth();
  const canEdit = useCan('send-messages');
  const [sequence, setSequence] = useState<SequenceDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [adding, setAdding] = useState(false);
  const [subscribersKey, setSubscribersKey] = useState(0);
  /** The WhatsApp step sheet: 'new', a message id, or closed (null). */
  const [stepSheet, setStepSheet] = useState<string | null>(null);

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

  const reorder = (order: string[]) => {
    if (!sequence) return;
    const byId = new Map(sequence.items.map((item) => [item.id, item]));
    // Shown at once; the server's answer (or a reload after a refusal) settles it.
    setSequence({ ...sequence, items: order.map((itemId, position) => ({ ...byId.get(itemId)!, position })) });
    void run(() => sequenceApi.reorder(id, order));
  };

  if (failed) return <InlineError message={t('loadFailed')} onRetry={() => void load()} />;
  if (!sequence) return <PageLoading rows={4} />;

  const ids = sequence.items.map((item) => item.id);
  const whatsapp = sequence.channel === 'whatsapp';
  const backPath = whatsapp ? AUTOMATION_PATH : SEQUENCES_PATH;
  const canAdd = canEdit && sequence.items.length < STAGE5_LIMITS.sequenceMessages;
  const sheetItem = stepSheet && stepSheet !== 'new' ? sequence.items.find((item) => item.id === stepSheet) ?? null : null;
  const newStepDelay: StepDelay = sequence.items.length === 0
    ? { delay_amount: 0, delay_unit: 'minutes' } : { delay_amount: 1, delay_unit: 'days' };
  const saveStep = (step: Parameters<typeof sequenceApi.addWhatsApp>[1], delay: StepDelay) => run(() => stepSheet === 'new'
    ? sequenceApi.addWhatsApp(id, step, delay)
    : sequenceApi.updateMessage(id, stepSheet!, { whatsapp: step, ...delay }));
  const exitSettings: ExitSettings = {
    exit_on_reply: sequence.exit_on_reply, exit_on_tag_id: sequence.exit_on_tag_id, exit_on_purchase: sequence.exit_on_purchase,
  };

  const removeSequence = async () => {
    if (!(await confirm({ title: t('removeTitle'), body: t('removeBody'), confirmLabel: t('remove'), destructive: true }))) return;
    await run(async () => {
      await sequenceApi.archive(id);
      router.push(backPath);
    });
  };

  const removeMessage = async (item: SequenceMessageView, number: number) => {
    if (!(await confirm({
      title: t('removeMessageTitle', { number }), body: t('removeMessageBody'), confirmLabel: t('removeMessageConfirm'), destructive: true,
    }))) return;
    await run(() => sequenceApi.removeMessage(id, item.id));
  };

  return (
    <div className="space-y-6">
      <Link href={backPath} className="text-muted-foreground hover:text-foreground inline-flex min-h-11 items-center gap-1 text-sm">
        <ArrowLeft className="size-3.5" />
        {t('back')}
      </Link>
      <PageHeader
        className="mb-0"
        title={sequence.name}
        subtitle={
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
            <Badge variant={sequence.status === 'active' ? 'default' : 'secondary'}>{t(`statusLabel.${sequence.status}`)}</Badge>
            <dl className="flex flex-wrap gap-x-6 gap-y-1">
              <Stat label={t('subscribers')} value={String(sequence.subscribers)} />
              <Stat label={t('sent')} value={String(sequence.sent)} />
              <Stat label={t('openRate')} value={formatRate(sequence.open_rate)} hint={t('openRateHint')} />
              <Stat label={t('ctr')} value={formatRate(sequence.ctr)} />
            </dl>
          </div>
        }
        primaryAction={canAdd ? (
          <Button type="button" disabled={busy} onClick={() => (whatsapp ? setStepSheet('new') : setAdding(true))}>
            <Plus className="size-4" />
            {t('addMessageButton')}
          </Button>
        ) : undefined}
        moreActions={canEdit ? [
          { label: t('rename'), icon: Pencil, disabled: busy, onSelect: () => setRenaming(true) },
          sequence.status === 'active'
            ? { label: t('pause'), icon: Pause, disabled: busy, onSelect: () => void run(() => sequenceApi.update(id, { status: 'paused' })) }
            : { label: t('resume'), icon: Play, disabled: busy, onSelect: () => void run(() => sequenceApi.update(id, { status: 'active' })) },
          { label: t('remove'), icon: Trash2, destructive: true, disabled: busy, onSelect: () => void removeSequence() },
        ] : undefined}
      >
        {canEdit && (
          <ChannelControl t={t} value={sequence.channel} locked={sequence.items.length > 0} disabled={busy}
            onChange={(channel) => void run(async () => {
              const next = await sequenceApi.update(id, { channel });
              router.replace(sequencePath(next.channel, id));
              return next;
            })} />
        )}
      </PageHeader>

      <div className="border-border bg-muted/40 text-muted-foreground flex gap-2 rounded-lg border p-3 text-sm" role="note">
        <TriangleAlert className="mt-0.5 size-4 shrink-0" />
        <div className="space-y-1">
          <p>{whatsapp ? t('whatsapp.windowNote') : t('windowWarning')}</p>
          <p>{t('howToJoin')}</p>
          {!canEdit && <p>{t('readOnly')}</p>}
        </div>
      </div>

      <ol className="space-y-3" aria-label={t('messages')}>
        {sequence.items.length === 0 && <li className="text-muted-foreground text-sm">{t('emptyMessages')}</li>}
        {sequence.items.map((item, index) => (
          <MessageRow key={item.id} t={t} item={item} index={index} count={ids.length} canEdit={canEdit} busy={busy}
            whatsapp={whatsapp} onEditStep={() => setStepSheet(item.id)}
            onMove={(offset) => reorder(moveItem(ids, index, offset))}
            onDrop={(fromId) => {
              const from = ids.indexOf(fromId);
              if (from < 0 || from === index) return;
              const order = ids.filter((x) => x !== fromId);
              order.splice(index, 0, fromId);
              reorder(order);
            }}
            onPatch={(patch) => run(() => sequenceApi.updateMessage(id, item.id, patch))}
            onRemove={() => void removeMessage(item, index + 1)} />
        ))}
      </ol>

      {stepSheet && (
        <WhatsAppStepSheet key={stepSheet} t={t} open busy={busy} initial={stepFromItem(sheetItem)}
          initialDelay={sheetItem ? { delay_amount: sheetItem.delay_amount, delay_unit: sheetItem.delay_unit } : newStepDelay}
          first={sheetItem ? sheetItem.position === 0 : sequence.items.length === 0}
          onOpenChange={(open) => { if (!open) setStepSheet(null); }} onSave={saveStep} />
      )}
      {adding && (
        <AddMessageSheet t={t} sequence={sequence} busy={busy} onClose={() => setAdding(false)}
          onAddNew={(name) => run(() => sequenceApi.addNew(id, name))}
          onAddExisting={(flowId) => run(() => sequenceApi.addExisting(id, flowId))} />
      )}
      {renaming && (
        <RenameSheet t={t} name={sequence.name} busy={busy} onClose={() => setRenaming(false)}
          onSave={(name) => run(() => sequenceApi.update(id, { name }))} />
      )}

      <ExitWhenSection t={t} settings={exitSettings} canEdit={canEdit} busy={busy}
        onChange={(patch) => void run(() => sequenceApi.update(id, patch))} />

      <Subscribers t={t} id={id} canEdit={canEdit} reloadKey={subscribersKey}
        onChanged={() => { setSubscribersKey((k) => k + 1); void load(); }} />
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

function stepSummary(t: T, item: SequenceMessageView): string {
  return item.wa_text || (item.wa_media_type ? t(`whatsapp.mediaType.${item.wa_media_type}`) : t('whatsapp.empty'));
}

function MessageRow({ t, item, index, count, canEdit, busy, whatsapp, onEditStep, onMove, onDrop, onPatch, onRemove }: {
  t: T; item: SequenceMessageView; index: number; count: number; canEdit: boolean; busy: boolean;
  whatsapp: boolean; onEditStep: () => void;
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
          // A WhatsApp step's timing is edited in its sheet, with the rest of the step.
          <Button type="button" variant="ghost" size="icon" className="size-11" aria-label={t('editSchedule', { number })}
            onClick={() => {
              if (whatsapp) { onEditStep(); return; }
              setAmount(String(item.delay_amount)); setUnit(item.delay_unit); setEditing(true);
            }}>
            <Pencil className="size-3.5" />
          </Button>
        )}
        {!whatsapp && windowWarning(item.delay_amount, item.delay_unit) && (
          <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
            <TriangleAlert className="size-3" />
            {t('windowShort')}
          </span>
        )}
      </div>
      {editing && !whatsapp && (
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
          <Button type="submit" className="min-h-11 sm:min-h-8" disabled={busy || !delay}>{t('save')}</Button>
          <Button type="button" variant="ghost" className="min-h-11 sm:min-h-8" onClick={() => setEditing(false)}>{t('cancel')}</Button>
          {!delay && <p className="text-destructive w-full text-xs">{t('delayInvalid')}</p>}
          {delay && windowWarning(delay.amount, delay.unit) && <p className="w-full text-xs text-amber-600 dark:text-amber-400">{t('windowWarning')}</p>}
        </form>
      )}
      <Card className={dragOver ? 'ring-primary ring-2' : undefined}>
        <CardContent className="flex flex-wrap items-center gap-3 py-3">
          {canEdit && (
            <span draggable aria-label={t('dragHandle', { number })} role="img"
              className="text-muted-foreground -ml-2 flex size-11 cursor-grab items-center justify-center"
              onDragStart={(e) => { e.dataTransfer.setData('text/x-sequence-message', item.id); e.dataTransfer.effectAllowed = 'move'; }}>
              <GripVertical className="size-4" />
            </span>
          )}
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="text-foreground text-sm font-medium">{t('messageLabel', { number })}</p>
            {whatsapp ? (
              <>
                {canEdit ? (
                  <button type="button" onClick={onEditStep} aria-label={t('whatsapp.editStep', { number })}
                    className="text-foreground hover:text-primary block min-h-11 max-w-full truncate text-left text-sm sm:min-h-0">
                    {stepSummary(t, item)}
                  </button>
                ) : (
                  <p className="text-foreground truncate text-sm">{stepSummary(t, item)}</p>
                )}
                <p className="text-muted-foreground text-xs">
                  {item.template_name ? t('whatsapp.templateSummary', { name: item.template_name }) : t('whatsapp.noTemplateSummary')}
                </p>
                {item.skipped_no_template > 0 && (
                  <p className="text-xs text-amber-600 dark:text-amber-400">{t('whatsapp.skippedCount', { count: item.skipped_no_template })}</p>
                )}
              </>
            ) : item.flow_id ? (
              <Link href={channelPath('instagram', 'flows', item.flow_id)} className="text-primary text-sm hover:underline">
                {item.flow_name ?? t('openMessage')} · {t('openMessage')}
              </Link>
            ) : (
              <p className="text-destructive text-sm">{t('missing')}</p>
            )}
            {!whatsapp && item.flow_id && item.flow_status !== 'active' && <p className="text-muted-foreground text-xs">{t('notLive')}</p>}
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
            <span className="flex min-h-11 items-center">
              <Switch id={`active-${item.id}`} aria-label={t('activeLabel', { number })} checked={item.active}
                disabled={!canEdit || busy} onCheckedChange={(checked) => void onPatch({ active: checked })} />
            </span>
            {canEdit && (
              <>
                <Button type="button" variant="ghost" size="icon" className="size-11" aria-label={t('moveUp', { number })} disabled={busy || index === 0}
                  onClick={() => onMove(-1)}><ArrowUp className="size-4" /></Button>
                <Button type="button" variant="ghost" size="icon" className="size-11" aria-label={t('moveDown', { number })} disabled={busy || index === count - 1}
                  onClick={() => onMove(1)}><ArrowDown className="size-4" /></Button>
                <Button type="button" variant="ghost" size="icon" aria-label={t('removeMessage', { number })} disabled={busy}
                  className="text-destructive size-11" onClick={onRemove}><Trash2 className="size-4" /></Button>
              </>
            )}
          </div>
        </CardContent>
      </Card>
    </li>
  );
}

/** Instagram: add a message, as a new draft automation or an existing one. */
function AddMessageSheet({ t, sequence, busy, onClose, onAddNew, onAddExisting }: {
  t: T; sequence: SequenceDetail; busy: boolean; onClose: () => void;
  onAddNew: (name: string) => Promise<boolean>; onAddExisting: (flowId: string) => Promise<boolean>;
}) {
  const { flows } = useInstagramFlows();
  const defaultName = t('newMessageDefault', { sequence: sequence.name, number: sequence.items.length + 1 })
    .slice(0, STAGE5_LIMITS.sequenceNameChars);
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [name, setName] = useState(defaultName);
  const [flowId, setFlowId] = useState('');
  const choices = (flows ?? []).filter((f) => f.status !== 'archived');
  const flowLabel = choices.find((f) => f.id === flowId)?.name;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const ok = mode === 'new' ? await onAddNew(name.trim() || defaultName) : flowId ? await onAddExisting(flowId) : false;
    if (ok) onClose();
  };

  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent side="right" size="md" className="overflow-y-auto">
        <form onSubmit={(e) => void submit(e)} className="flex h-full flex-col">
          <SheetHeader>
            <SheetTitle>{t('addMessageButton')}</SheetTitle>
            <SheetDescription>{t('addMessageDescription')}</SheetDescription>
          </SheetHeader>
          <div className="flex-1 space-y-5 px-4">
            <SegmentedControl aria-label={t('addMessageButton')} value={mode} onValueChange={setMode}
              options={[{ value: 'new', label: t('createNew') }, { value: 'existing', label: t('selectExisting') }]} />
            {mode === 'new' ? (
              <div className="space-y-1.5">
                <Label htmlFor="sequence-new-message">{t('newMessageName')}</Label>
                <Input id="sequence-new-message" autoFocus value={name} maxLength={STAGE5_LIMITS.sequenceNameChars}
                  onChange={(e) => setName(e.target.value)} />
              </div>
            ) : (
              <div className="space-y-1.5">
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
          </div>
          <SheetFooter className="flex-row justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>{t('cancel')}</Button>
            <Button type="submit" disabled={busy || (mode === 'existing' && !flowId)}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              {t('add')}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function RenameSheet({ t, name, busy, onClose, onSave }: {
  t: T; name: string; busy: boolean; onClose: () => void; onSave: (name: string) => Promise<boolean>;
}) {
  const [value, setValue] = useState(name);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = value.trim();
    if (trimmed && (await onSave(trimmed))) onClose();
  };
  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent side="right" size="sm">
        <form onSubmit={(e) => void submit(e)} className="flex h-full flex-col">
          <SheetHeader>
            <SheetTitle>{t('rename')}</SheetTitle>
          </SheetHeader>
          <div className="flex-1 space-y-1.5 px-4">
            <Label htmlFor="sequence-rename">{t('name')}</Label>
            <Input id="sequence-rename" autoFocus value={value} maxLength={STAGE5_LIMITS.sequenceNameChars}
              onChange={(e) => setValue(e.target.value)} />
          </div>
          <SheetFooter className="flex-row justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>{t('cancel')}</Button>
            <Button type="submit" disabled={busy || !value.trim()}>{t('save')}</Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
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
    <section className="space-y-2" aria-labelledby="sequence-subscribers-title">
      <h2 id="sequence-subscribers-title" className="text-foreground text-base font-semibold">{t('subscribersTitle')}</h2>
        {failed && <InlineError message={t('loadFailed')} onRetry={() => void load()} className="py-4" />}
        {!rows && !failed && <PageLoading rows={2} />}
        {rows?.length === 0 && <p className="text-muted-foreground text-sm">{t('noSubscribers')}</p>}
        {!!rows?.length && (
          <GroupedList>
            {rows.map((row) => {
              const running = row.status === 'active' || row.status === 'sending';
              return (
                <div key={row.contact_id}
                  className="not-first:border-separator flex min-h-11 flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm not-first:border-t">
                  <div className="min-w-0">
                    <p className="text-foreground truncate font-medium">{row.name || t('unnamedContact')}</p>
                    <p className="text-muted-foreground text-xs">
                      {t(`subscriberStatus.${row.status}`)}
                      {row.exit_reason && ` · ${t(`exitReason.${row.exit_reason}`)}`}
                      {running && ' · '}
                      {running && (row.next_due_at
                        ? t('nextDue', { time: format.dateTime(new Date(row.next_due_at), { dateStyle: 'medium', timeStyle: 'short' }) })
                        : t('waiting'))}
                    </p>
                  </div>
                  {canEdit && running && (
                    <Button type="button" variant="outline" className="min-h-11 sm:min-h-8" disabled={busy === row.contact_id}
                      onClick={() => void unsubscribe(row.contact_id)}>
                      {t('unsubscribe')}
                    </Button>
                  )}
                </div>
              );
            })}
          </GroupedList>
        )}
    </section>
  );
}
