'use client';

/** Follow-up tasks (next steps after a no-show, rebooking reminders, manual tasks). */
import { ListChecks } from 'lucide-react';
import { EmptyState } from '@/components/ui/empty-state';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { OptionSelect } from '@/components/contacts/option-select';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { TaskKind, TaskStatus } from '@/lib/appointments/types';
import { TASK_STATUSES } from '@/lib/appointments/types';
import { apiRequest, dueAtFromDay, formatDueDate, memberLabel, useFailureText, useMembers } from './shared';

export interface TaskDto {
  id: string; kind: TaskKind; title: string; due_at: string | null; assigned_to: string | null; status: TaskStatus;
  appointment_id: string | null;
}

export function TasksPanel({ canManage, onOpenAppointment }: { canManage: boolean; onOpenAppointment: (id: string) => void }) {
  const t = useTranslations('Appointments');
  const locale = useLocale();
  const failureText = useFailureText();
  const members = useMembers();
  const [status, setStatus] = useState<TaskStatus>('open');
  const [tasks, setTasks] = useState<TaskDto[] | null>(null);
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [assignee, setAssignee] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await apiRequest<{ tasks: TaskDto[] }>(`/api/appointments/tasks?status=${status}`);
    setTasks(r.ok ? r.data.tasks ?? [] : []);
  }, [status]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function add() {
    setBusy(true);
    const r = await apiRequest('/api/appointments/tasks', {
      method: 'POST', body: { title: title.trim(), kind: 'manual', due_at: dueAtFromDay(due), assigned_to: assignee || null },
    });
    setBusy(false);
    if (!r.ok) return void toast.error(failureText(r));
    setTitle('');
    setDue('');
    void load();
  }

  async function update(id: string, body: Record<string, unknown>) {
    const r = await apiRequest(`/api/appointments/tasks/${id}`, { method: 'PATCH', body });
    if (!r.ok) return void toast.error(failureText(r));
    void load();
  }

  const name = (id: string | null) => {
    const m = id ? members.find((x) => x.user_id === id) : null;
    return m ? memberLabel(m) : t('tasks.unassigned');
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold tracking-tight">{t('tasks.title')}</h2>
        <SegmentedControl<TaskStatus> aria-label={t('schedule.filterStatus')} className="ml-auto" value={status} onValueChange={setStatus}
          options={TASK_STATUSES.map((s) => ({ value: s, label: t(`tasks.statuses.${s}`) }))} />
      </div>
      {tasks && tasks.length === 0 && <EmptyState icon={ListChecks} title={t('tasks.empty')} />}
      {!!tasks?.length && <ul className="divide-y divide-separator rounded-group border border-separator bg-grouped-surface text-sm">
        {(tasks ?? []).map((task) => (
          <li key={task.id} className="flex flex-wrap items-center gap-2 p-3">
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">{t(`tasks.kinds.${task.kind}`)}</span>
            {task.appointment_id
              ? <button type="button" className="min-w-0 flex-1 truncate text-left hover:underline" onClick={() => onOpenAppointment(task.appointment_id as string)}>{task.title}</button>
              : <span className="min-w-0 flex-1 truncate">{task.title}</span>}
            <span className="text-xs text-muted-foreground">
              {task.due_at ? `${t('tasks.due')}: ${formatDueDate(task.due_at, locale)} · ` : ''}{name(task.assigned_to)}
            </span>
            {canManage && task.status === 'open' && (
              <>
                <Button type="button" size="sm" variant="ghost" onClick={() => void update(task.id, { status: 'done' })}>{t('tasks.markDone')}</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => void update(task.id, { status: 'cancelled' })}>{t('tasks.cancel')}</Button>
              </>
            )}
          </li>
        ))}
      </ul>}
      {canManage && (
        <div className="flex flex-wrap items-end gap-2">
          <Input aria-label={t('tasks.titleLabel')} placeholder={t('tasks.titleLabel')} maxLength={200} className="flex-1" value={title} onChange={(e) => setTitle(e.target.value)} />
          <Input aria-label={t('tasks.due')} type="date" className="w-40" value={due} onChange={(e) => setDue(e.target.value)} />
          <OptionSelect aria-label={t('tasks.assignee')} className="w-44" value={assignee} onValueChange={setAssignee}
            options={[{ value: '', label: t('tasks.unassigned') }, ...members.map((m) => ({ value: m.user_id, label: memberLabel(m) }))]} />
          <Button type="button" disabled={busy || !title.trim()} onClick={() => void add()}>{t('tasks.add')}</Button>
        </div>
      )}
    </div>
  );
}
