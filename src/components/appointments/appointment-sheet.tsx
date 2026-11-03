'use client';

/**
 * One appointment: details, reschedule, cancel, outcome (staff-recorded),
 * staff note and feedback score, tasks, history and the customer-message log
 * with "mark resolved" for blocked or uncertain sends. Every change sends the
 * version it was based on; a 409 asks the user to reload instead of guessing.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import type {
  AppointmentEventKind, AppointmentMessageKind, AppointmentMessageStatus, AppointmentStatus, Slot, TaskKind, TaskStatus,
} from '@/lib/appointments/types';
import { zoneLabel } from '@/lib/appointments/time';
import { AppointmentStatusBadge } from './appointment-status-badge';
import { SlotSelector } from './slot-selector';
import {
  apiRequest, dueAtFromDay, formatDateTime, formatPrice, formatTime, selectClass, useFailureText, type Abilities, type AppointmentConfig, type ApiFailure,
} from './shared';

export interface AppointmentDetailDto {
  appointment: {
    id: string; status: AppointmentStatus; version: number; start_at: string; end_at: string; timezone: string;
    service_id: string; service_name: string; staff_id: string | null; location_id: string; contact_id: string | null;
    contact_name: string | null; conversation_id: string | null; source: 'staff' | 'public' | 'flow';
    price_minor: number | null; currency: string | null; meeting_url: string | null; cancel_reason: string | null;
    /** Present only for members with appointments.manage. */
    outcome_note?: string | null;
    feedback_score: number | null;
  };
  events: { id: string; kind: AppointmentEventKind; actor: 'staff' | 'customer' | 'system'; old_start_at: string | null; new_start_at: string | null; created_at: string }[];
  messages: { id: string; kind: AppointmentMessageKind; status: AppointmentMessageStatus; reason: string | null; resolved_at: string | null; created_at: string }[];
  tasks: { id: string; kind: TaskKind; title: string; due_at: string | null; status: TaskStatus }[];
}

const MESSAGE_REASONS = new Set([
  'stale_version', 'contact_missing', 'past_due', 'disabled', 'contact_blocked', 'opted_out', 'workspace_suspended',
  'number_unavailable', 'no_address', 'no_template', 'category', 'template_refused', 'provider_rejected', 'uncertain',
  'template_not_found', 'template_not_approved', 'template_wrong_number', 'feedback_recorded',
  'hold_expired', 'window_closed', 'not_connected', 'link_unknown', 'link_not_ready', 'already_paid', 'conversation_not_found',
]);
/** The translation key for a stored reason code (codes only; unknown ones read "Not sent"). */
export function messageReasonKey(reason: string | null): string {
  if (!reason) return 'other';
  if (MESSAGE_REASONS.has(reason)) return reason;
  return reason.startsWith('past_due') ? 'past_due' : 'other';
}
const RESOLVABLE: AppointmentMessageStatus[] = ['blocked', 'failed', 'outcome_unknown'];

export function AppointmentSheet({
  id, config, abilities, onClose, onChanged,
}: {
  id: string | null;
  config: AppointmentConfig;
  abilities: Abilities;
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = useTranslations('Appointments');
  const locale = useLocale();
  const failureText = useFailureText();
  const [detail, setDetail] = useState<AppointmentDetailDto | null>(null);
  const [failed, setFailed] = useState(false);
  /** When the detail was loaded: "has it started" is judged against this, not the render clock. */
  const [loadedAt, setLoadedAt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'view' | 'reschedule' | 'cancel'>('view');
  const [slot, setSlot] = useState<Slot | null>(null);
  const [newStaff, setNewStaff] = useState('');
  const [cancelReason, setCancelReason] = useState<'staff' | 'customer' | 'other'>('staff');
  const [note, setNote] = useState('');
  const [score, setScore] = useState('');
  const [taskTitle, setTaskTitle] = useState('');
  const [taskDue, setTaskDue] = useState('');

  const load = useCallback(async () => {
    if (!id) return;
    setFailed(false);
    const r = await apiRequest<AppointmentDetailDto>(`/api/appointments/${id}`);
    if (!r.ok) {
      setFailed(true);
      return;
    }
    setLoadedAt(Date.now());
    setDetail(r.data);
    setNote(r.data.appointment.outcome_note ?? '');
    setScore(r.data.appointment.feedback_score ? String(r.data.appointment.feedback_score) : '');
  }, [id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDetail(null);
    setMode('view');
    setSlot(null);
    void load();
  }, [load]);

  const a = detail?.appointment;
  const staffOptions = useMemo(() => {
    if (!a) return [];
    const ids = new Set(config.offerings.filter((o) => o.service_id === a.service_id && o.location_id === a.location_id && o.staff_id)
      .map((o) => o.staff_id as string));
    return config.staff.filter((s) => ids.has(s.id) && !s.archived_at);
  }, [a, config]);

  async function act(body: Record<string, unknown>, after?: () => void) {
    if (!a) return;
    setBusy(true);
    const r = await apiRequest(`/api/appointments/${a.id}`, { method: 'PATCH', body });
    setBusy(false);
    if (!r.ok) {
      toast.error(failureText(r));
      if ((r as ApiFailure).code === 'conflict') void load();
      return;
    }
    toast.success(t('sheet.saved'));
    after?.();
    setMode('view');
    onChanged();
    void load();
  }

  async function addTask() {
    if (!a || !taskTitle.trim()) return;
    setBusy(true);
    const r = await apiRequest('/api/appointments/tasks', {
      method: 'POST',
      body: { title: taskTitle.trim(), kind: 'next_step', appointment_id: a.id, due_at: dueAtFromDay(taskDue) },
    });
    setBusy(false);
    if (!r.ok) return void toast.error(failureText(r));
    setTaskTitle('');
    setTaskDue('');
    void load();
  }

  async function taskDone(taskId: string) {
    const r = await apiRequest(`/api/appointments/tasks/${taskId}`, { method: 'PATCH', body: { status: 'done' } });
    if (!r.ok) return void toast.error(failureText(r));
    void load();
  }

  async function resolve(messageId: string) {
    const r = await apiRequest(`/api/appointments/messages/${messageId}/resolve`, { method: 'POST', body: {} });
    if (!r.ok) return void toast.error(failureText(r));
    void load();
  }

  const staffName = a?.staff_id ? config.staff.find((s) => s.id === a.staff_id)?.display_name : null;
  const location = a ? config.locations.find((l) => l.id === a.location_id) : null;
  const started = a ? new Date(a.start_at).getTime() <= loadedAt : false;
  const fmt = (iso: string) => (a ? formatDateTime(iso, a.timezone, locale) : '');
  const price = a ? formatPrice(a.price_minor, a.currency, locale) : null;

  return (
    <Sheet open={!!id} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{a?.service_name ?? t('sheet.title')}</SheetTitle>
          {a && <SheetDescription>{fmt(a.start_at)} ({zoneLabel(new Date(a.start_at), a.timezone, locale)})</SheetDescription>}
        </SheetHeader>

        <div className="space-y-5 px-4 pb-6 text-sm">
          {!detail && !failed && <Loader2 className="h-5 w-5 animate-spin text-primary" />}
          {failed && (
            <div className="flex items-center gap-2 text-destructive">
              {t('loadFailed')}
              <Button type="button" size="sm" variant="outline" onClick={() => void load()}>{t('retry')}</Button>
            </div>
          )}

          {a && (
            <>
              <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1.5">
                <dt className="text-muted-foreground">{t('sheet.status')}</dt>
                <dd><AppointmentStatusBadge status={a.status} /></dd>
                <dt className="text-muted-foreground">{t('sheet.contact')}</dt>
                <dd>
                  {a.contact_id
                    ? (<>
                      {a.contact_name || '—'}
                      {a.conversation_id && (
                        <Link className="ml-2 text-primary hover:underline" href={`/inbox?c=${a.conversation_id}`}>{t('sheet.openInbox')}</Link>
                      )}
                    </>)
                    : <span className="text-muted-foreground">{t('schedule.awaitingContact')}</span>}
                </dd>
                <dt className="text-muted-foreground">{t('sheet.practitioner')}</dt>
                <dd>{staffName ?? t('schedule.pool')}</dd>
                <dt className="text-muted-foreground">{t('sheet.location')}</dt>
                <dd>{location?.name ?? '—'}{location?.address ? ` · ${location.address}` : ''}</dd>
                <dt className="text-muted-foreground">{t('sheet.when')}</dt>
                <dd>{fmt(a.start_at)} – {formatTime(a.end_at, a.timezone, locale)}</dd>
                <dt className="text-muted-foreground">{t('sheet.source')}</dt>
                <dd>{t(`source.${a.source}`)}</dd>
                {price && (<><dt className="text-muted-foreground">{t('services.price')}</dt><dd>{price}</dd></>)}
                {a.meeting_url && (<><dt className="text-muted-foreground">{t('services.meetingUrl')}</dt>
                  <dd className="truncate"><a className="text-primary hover:underline" href={a.meeting_url} target="_blank" rel="noopener noreferrer">{a.meeting_url}</a></dd></>)}
                {a.cancel_reason && (<><dt className="text-muted-foreground">{t('sheet.cancelReason')}</dt><dd>{t(`cancelReasons.${a.cancel_reason as 'staff'}`)}</dd></>)}
              </dl>

              {a.status === 'held' && <p className="rounded-md bg-muted p-2 text-xs text-muted-foreground">{t('sheet.confirmHoldHelp')}</p>}

              {abilities.manage && a.status === 'confirmed' && mode === 'view' && (
                <div className="flex flex-wrap gap-2">
                  {!started && <Button type="button" size="sm" variant="outline" onClick={() => { setNewStaff(a.staff_id ?? ''); setMode('reschedule'); }}>{t('sheet.reschedule')}</Button>}
                  <Button type="button" size="sm" variant="outline" onClick={() => setMode('cancel')}>{t('sheet.cancel')}</Button>
                  {started && (<>
                    <Button type="button" size="sm" disabled={busy} onClick={() => void act({ action: 'outcome', outcome: 'completed', expected_version: a.version, note: note || null })}>{t('sheet.markCompleted')}</Button>
                    <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void act({ action: 'outcome', outcome: 'no_show', expected_version: a.version, note: note || null })}>{t('sheet.markNoShow')}</Button>
                  </>)}
                </div>
              )}

              {mode === 'reschedule' && (
                <div className="space-y-3 rounded-lg border border-border p-3">
                  <div className="font-medium">{t('sheet.reschedule')}</div>
                  {a.staff_id && staffOptions.length > 1 && (
                    <div className="space-y-1">
                      <Label htmlFor="appt-new-staff">{t('sheet.practitioner')}</Label>
                      <select id="appt-new-staff" className={selectClass} value={newStaff} onChange={(e) => { setNewStaff(e.target.value); setSlot(null); }}>
                        {staffOptions.map((s) => <option key={s.id} value={s.id}>{s.display_name}</option>)}
                      </select>
                    </div>
                  )}
                  <SlotSelector
                    query={{ serviceId: a.service_id, locationId: a.location_id, staffId: newStaff, exclude: a.id }}
                    value={slot} onChange={setSlot} disabled={busy} />
                  <div className="flex gap-2">
                    <Button type="button" size="sm" disabled={!slot || busy}
                      onClick={() => slot && void act({ action: 'reschedule', expected_version: a.version, start_at: slot.startAt, staff_id: newStaff || undefined })}>
                      {t('sheet.reschedule')}
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setMode('view')}>{t('sheet.close')}</Button>
                  </div>
                </div>
              )}

              {mode === 'cancel' && (
                <div className="space-y-3 rounded-lg border border-destructive/40 p-3">
                  <p>{t('sheet.cancelConfirm')}</p>
                  <div className="space-y-1">
                    <Label htmlFor="appt-cancel-reason">{t('sheet.cancelReason')}</Label>
                    <select id="appt-cancel-reason" className={selectClass} value={cancelReason}
                      onChange={(e) => setCancelReason(e.target.value as typeof cancelReason)}>
                      {(['staff', 'customer', 'other'] as const).map((r) => <option key={r} value={r}>{t(`cancelReasons.${r}`)}</option>)}
                    </select>
                  </div>
                  <div className="flex gap-2">
                    <Button type="button" size="sm" variant="destructive" disabled={busy}
                      onClick={() => void act({ action: 'cancel', expected_version: a.version, reason: cancelReason })}>{t('sheet.cancel')}</Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setMode('view')}>{t('sheet.close')}</Button>
                  </div>
                </div>
              )}

              {'outcome_note' in a && (
                <div className="space-y-2">
                  <Label htmlFor="appt-note">{t('sheet.outcomeNote')}</Label>
                  <Textarea id="appt-note" maxLength={1000} rows={3} value={note} disabled={!abilities.manage || busy} onChange={(e) => setNote(e.target.value)} />
                  <p className="text-xs text-amber-600 dark:text-amber-400">{t('sheet.outcomeNoteWarning')}</p>
                  <div className="flex flex-wrap items-end gap-2">
                    <div className="space-y-1">
                      <Label htmlFor="appt-score">{t('sheet.feedbackScore')}</Label>
                      <select id="appt-score" className={`${selectClass} w-24`} value={score} disabled={!abilities.manage || busy} onChange={(e) => setScore(e.target.value)}>
                        <option value="">—</option>
                        {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
                      </select>
                    </div>
                    {abilities.manage && (
                      <Button type="button" size="sm" variant="outline" disabled={busy}
                        onClick={() => void act({ action: 'details', outcome_note: note.trim() || null, feedback_score: score ? Number(score) : null })}>
                        {t('sheet.save')}
                      </Button>
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground">{t('sheet.staffRecorded')}</p>
                </div>
              )}

              <section className="space-y-2">
                <h4 className="font-semibold">{t('tasks.title')}</h4>
                {detail.tasks.length === 0 && <p className="text-xs text-muted-foreground">{t('tasks.empty')}</p>}
                <ul className="space-y-1">
                  {detail.tasks.map((task) => (
                    <li key={task.id} className="flex items-center gap-2">
                      <span className="flex-1 truncate">{task.title}</span>
                      <span className="text-xs text-muted-foreground">{t(`tasks.statuses.${task.status}`)}</span>
                      {abilities.manage && task.status === 'open' && (
                        <Button type="button" size="sm" variant="ghost" onClick={() => void taskDone(task.id)}>{t('tasks.markDone')}</Button>
                      )}
                    </li>
                  ))}
                </ul>
                {abilities.manage && (
                  <div className="flex flex-wrap items-end gap-2">
                    <Input aria-label={t('tasks.titleLabel')} placeholder={t('tasks.titleLabel')} maxLength={200} className="h-8 flex-1"
                      value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} />
                    <Input aria-label={t('tasks.due')} type="date" className="h-8 w-36" value={taskDue} onChange={(e) => setTaskDue(e.target.value)} />
                    <Button type="button" size="sm" variant="outline" disabled={busy || !taskTitle.trim()} onClick={() => void addTask()}>{t('sheet.createTask')}</Button>
                  </div>
                )}
              </section>

              <section className="space-y-2">
                <h4 className="font-semibold">{t('sheet.messages')}</h4>
                {detail.messages.length === 0 && <p className="text-xs text-muted-foreground">{t('sheet.noMessages')}</p>}
                <ul className="space-y-1.5">
                  {detail.messages.map((m) => (
                    <li key={m.id} className="rounded-md border border-border p-2" data-message-status={m.status}>
                      <div className="flex items-center gap-2">
                        <span className="flex-1">{t(`messageKinds.${m.kind}`)}</span>
                        <span className="text-xs font-medium">{t(`messageStatuses.${m.status}`)}</span>
                      </div>
                      {m.status !== 'sent' && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          {t(`messageReasons.${(m.status === 'outcome_unknown' ? 'uncertain' : messageReasonKey(m.reason)) as 'other'}`)}
                        </p>
                      )}
                      {RESOLVABLE.includes(m.status) && (
                        m.resolved_at
                          ? <p className="mt-1 text-xs text-emerald-600">{t('sheet.resolved')}</p>
                          : abilities.resolve && (
                            <Button type="button" size="sm" variant="ghost" className="mt-1" onClick={() => void resolve(m.id)}>{t('sheet.markResolved')}</Button>
                          )
                      )}
                    </li>
                  ))}
                </ul>
              </section>

              <section className="space-y-2">
                <h4 className="font-semibold">{t('sheet.history')}</h4>
                {detail.events.length === 0 && <p className="text-xs text-muted-foreground">{t('sheet.noHistory')}</p>}
                <ol className="space-y-1 text-xs">
                  {detail.events.map((e) => (
                    <li key={e.id} className="flex gap-2">
                      <span className="w-36 shrink-0 text-muted-foreground">{fmt(e.created_at)}</span>
                      <span className="flex-1">
                        {e.kind === 'rescheduled' && e.old_start_at && e.new_start_at
                          ? t('events.rescheduled', { from: fmt(e.old_start_at), to: fmt(e.new_start_at) })
                          : t(`events.${e.kind}`)}
                        <span className="text-muted-foreground"> · {t(`actors.${e.actor}`)}</span>
                      </span>
                    </li>
                  ))}
                </ol>
              </section>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
