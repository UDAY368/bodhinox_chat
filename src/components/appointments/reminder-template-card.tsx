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
    setBusy(true);
    setSubmitError(null);
    try {
      const res = await authFetch('/api/whatsapp/templates/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(libraryTemplatePayload(preset, templateLanguageForAppLocale())),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
        setSubmitError(typeof body?.error === 'string' ? body.error : t('submitFailed'));
      }
    } catch {
      setSubmitError(t('submitFailed'));
    }
    setBusy(false);
    await load();
  }

  const state = rows ? reminderTemplateState(rows) : null;
  const reason = rows?.find((r) => r.rejection_reason)?.rejection_reason ?? null;

  return (
    <section className="space-y-3 rounded-xl border border-border bg-card p-4" aria-labelledby="reminder-buttons-title">
      <div className="flex items-start gap-3">
        <MessageSquareReply className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />
        <div className="space-y-1">
          <h3 id="reminder-buttons-title" className="font-semibold">{t('title')}</h3>
          <p className="text-sm text-muted-foreground">{t('description')}</p>
        </div>
      </div>

      {loadFailed ? (
        <div className="space-y-2 text-sm" role="alert">
          <p className="text-destructive">{t('loadFailed')}</p>
          <Button type="button" variant="outline" size="sm" className="min-h-11" onClick={() => void load()}>{t('retry')}</Button>
        </div>
      ) : !state ? (
        <div className="h-11 animate-pulse rounded-lg bg-muted" aria-label={t('title')} />
      ) : (
        <div className="space-y-3 text-sm">
          <p className="flex items-center gap-2" role="status">
            {state === 'approved' ? <CheckCircle2 className="h-4 w-4 text-green-600" aria-hidden />
              : state === 'rejected' ? <XCircle className="h-4 w-4 text-destructive" aria-hidden />
                : <Clock className="h-4 w-4 text-muted-foreground" aria-hidden />}
            <span>{t(`state.${state}`)}</span>
          </p>
          {state === 'rejected' && reason ? <p className="text-muted-foreground">{t('rejectedReason', { reason })}</p> : null}
          {state !== 'approved' ? <p className="text-muted-foreground">{t('fallback')}</p> : null}
          {canEdit && (state === 'none' || state === 'draft') ? (
            <Button type="button" className="min-h-11" disabled={busy} onClick={() => void submit()}>
              {busy ? t('submitting') : t('submit')}
            </Button>
          ) : null}
          {!canEdit && (state === 'none' || state === 'draft') ? <p className="text-muted-foreground">{t('adminOnly')}</p> : null}
          {submitError ? <p className="text-destructive" role="alert">{submitError}</p> : null}
        </div>
      )}
    </section>
  );
}
