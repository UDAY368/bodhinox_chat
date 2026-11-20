'use client';

/**
 * Reminder buttons (batch 3, A5): the appointment_reminder_actions template that
 * lets a reminder outside the 24-hour window carry Confirm / Reschedule /
 * Cancel. Shows its Meta review state and, for an admin, submits the library
 * preset through the existing template submit route (which checks the role,
 * permission and CSRF). Until it is approved, reminders use the settings
 * reminder template (manage-link button). Mounted in Appointments settings by WP-D1.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CheckCircle2, Clock, MessageSquareReply, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { GroupedList, GroupedListRow } from '@/components/ui/grouped-list';
import { InlineError } from '@/components/ui/inline-error';
import { PageLoading } from '@/components/ui/page-loading';
import { authFetch } from '@/lib/auth/client';
import { createClient } from '@/lib/data/client';
import { REMINDER_ACTIONS_TEMPLATE } from '@/lib/appointments/reminder-actions-id';
import { getLibraryTemplate, libraryTemplatePayload } from '@/lib/whatsapp/template-library';
import { templateLanguageForAppLocale } from '@/lib/whatsapp/template-languages';

export type ReminderTemplateState = 'none' | 'draft' | 'pending' | 'approved' | 'rejected';

interface Row { status: string | null; rejection_reason: string | null }

/** The card's state from the template rows of that name (pure; tested). Any approved language wins. */
export function reminderTemplateState(rows: Row[]): ReminderTemplateState {
  const statuses = rows.map((r) => String(r.status ?? '').toUpperCase());
  if (statuses.includes('APPROVED')) return 'approved';
  if (statuses.some((s) => s === 'PENDING' || s === 'IN_APPEAL')) return 'pending';
  if (statuses.some((s) => s === 'REJECTED' || s === 'PAUSED' || s === 'DISABLED')) return 'rejected';
  return rows.length ? 'draft' : 'none';
}

export function ReminderTemplateCard({ canEdit }: { canEdit: boolean }) {
  const t = useTranslations('Appointments.settings.reminderButtons');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const confirm = useConfirm();

  const load = useCallback(async () => {
    setLoadFailed(false);
    const { data, error } = await createClient().from('message_templates')
      .select('status,rejection_reason').eq('name', REMINDER_ACTIONS_TEMPLATE).limit(20);
    if (error) return setLoadFailed(true);
    setRows((data as Row[] | null) ?? []);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function submit() {
    const preset = getLibraryTemplate(REMINDER_ACTIONS_TEMPLATE);
    if (!preset) return;
    if (!(await confirm({ title: t('confirmTitle'), body: t('confirmBody'), confirmLabel: t('submit') }))) return;
    setBusy(true);
    setSubmitError(null);
    try {
      const res = await authFetch('/api/whatsapp/templates/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(libraryTemplatePayload(preset, templateLanguageForAppLocale())),
      });
      // Our own sentence, never the server's text (it can carry Meta's internal detail).
      if (!res.ok) setSubmitError(res.status === 409 ? t('nameTaken') : t('submitFailed'));
    } catch {
      setSubmitError(t('submitFailed'));
    }
    setBusy(false);
    await load();
  }

  const state = rows ? reminderTemplateState(rows) : null;
  const reason = rows?.find((r) => r.rejection_reason)?.rejection_reason ?? null;

  const icon = state === 'approved' ? <CheckCircle2 className="h-5 w-5 text-green-600" aria-hidden />
    : state === 'rejected' ? <XCircle className="h-5 w-5 text-destructive" aria-hidden />
      : <Clock className="h-5 w-5 text-muted-foreground" aria-hidden />;
  const canSubmit = canEdit && (state === 'none' || state === 'draft');

  return (
    <GroupedList
      header={<span className="flex items-center gap-2"><MessageSquareReply className="h-4 w-4" aria-hidden />{t('title')}</span>}
      footer={state === 'approved' ? t('description') : `${t('description')} ${t('fallback')}`}
    >
      {loadFailed ? (
        <InlineError message={t('loadFailed')} onRetry={() => void load()} />
      ) : !state ? (
        <PageLoading rows={1} />
      ) : (
        <>
          <GroupedListRow
            leading={icon}
            title={<span role="status">{t(`state.${state}`)}</span>}
            subtitle={state === 'rejected' && reason ? t('rejectedReason', { reason })
              : !canEdit && (state === 'none' || state === 'draft') ? t('adminOnly') : undefined}
            trailing={canSubmit ? (
              <Button type="button" size="sm" disabled={busy} onClick={() => void submit()}>
                {busy ? t('submitting') : t('submit')}
              </Button>
            ) : undefined}
          />
          {submitError ? <InlineError message={submitError} onRetry={canSubmit ? () => void submit() : undefined} /> : null}
        </>
      )}
    </GroupedList>
  );
}
