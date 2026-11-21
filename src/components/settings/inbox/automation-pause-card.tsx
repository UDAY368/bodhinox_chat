'use client';

// Settings › Inbox (Stage 5, 5D): how long automated replies stay paused after
// someone on the team replies (workspace_inbox_settings.agent_reply_pause_minutes
// through PUT /api/inbox/settings). "Only when someone resumes them" (null) is
// the behaviour before Stage 5 and the default. Every member can read it; only
// admins and owners save. The save re-reads the stored settings first and sends
// only this setting's change, so it never reverts another card's edit.
import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { authFetch } from '@/lib/auth/client';
import { PAUSE_MINUTES_CHOICES } from '@/lib/flows/types';
import type { WorkspaceInboxSettings } from '@/lib/inbox/inbox-settings';
import { INBOX_BEHAVIOUR_KEYS } from '@/types';
import { cn } from '@/lib/utils';
import { SETTINGS_ROW_HAIRLINE, SettingsGroup, SettingsRow } from '../settings-row';

const NEVER = 'never';
const toValue = (minutes: number | null) => (minutes === null ? NEVER : String(minutes));

async function readSettings(): Promise<WorkspaceInboxSettings> {
  const res = await authFetch('/api/inbox/settings', { cache: 'no-store' });
  if (!res.ok) throw new Error('load failed');
  return ((await res.json()) as { settings: WorkspaceInboxSettings }).settings;
}

/** The PUT body: the stored settings without the other Stage 5 settings (kept as stored), plus this one. */
export function pauseSettingsBody(stored: WorkspaceInboxSettings, minutes: number | null): Record<string, unknown> {
  const body: Record<string, unknown> = { ...stored };
  for (const key of INBOX_BEHAVIOUR_KEYS) delete body[key];
  return { ...body, agent_reply_pause_minutes: minutes };
}

export function AutomationPauseCard({ canEdit }: { canEdit: boolean }) {
  const t = useTranslations('inboxSettings.pause');
  const tCommon = useTranslations('inboxSettings');
  const tChoice = useTranslations('Inbox.pause.choices');
  const [minutes, setMinutes] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    readSettings()
      .then((settings) => { if (live) setMinutes(settings.agent_reply_pause_minutes ?? null); })
      .catch(() => { if (live) setFailed(true); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  const label = (value: number | null) => {
    if (value === null) return t('never');
    const preset = (PAUSE_MINUTES_CHOICES as readonly (number | null)[]).includes(value);
    return t('after', { duration: preset ? tChoice(String(value)) : `${value} min` });
  };
  const options: (number | null)[] = [null, ...(PAUSE_MINUTES_CHOICES as readonly (number | null)[]).filter((m) => m !== null)];
  if (minutes !== null && !options.includes(minutes)) options.push(minutes);

  const save = async () => {
    setSaving(true);
    try {
      const stored = await readSettings();
      const res = await authFetch('/api/inbox/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(pauseSettingsBody(stored, minutes)),
      });
      if (!res.ok) throw new Error('save failed');
      const json = (await res.json()) as { settings: WorkspaceInboxSettings };
      setMinutes(json.settings.agent_reply_pause_minutes ?? null);
      toast.success(t('saved'));
    } catch {
      toast.error(tCommon('error'));
    } finally {
      setSaving(false);
    }
  };

  const ready = !loading && !failed;

  return (
    <SettingsGroup
      title={t('title')}
      footer={<>{t('description')}{ready && !canEdit ? <> {tCommon('readOnly')}</> : null}</>}
      action={ready && canEdit ? (
        <Button size="sm" className="min-h-11 sm:min-h-8" onClick={save} disabled={saving}>
          {saving && <Loader2 className="size-4 animate-spin" aria-hidden />}
          {t('save')}
        </Button>
      ) : undefined}
    >
        {loading ? (
          <div className={cn(SETTINGS_ROW_HAIRLINE, 'flex min-h-11 items-center gap-4 px-4 py-3')} role="status" aria-label={tCommon('loading')}>
            <div className="h-4 flex-1 animate-pulse rounded bg-muted motion-reduce:animate-none" />
            <div className="h-9 w-40 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
          </div>
        ) : failed ? (
          <div className={cn(SETTINGS_ROW_HAIRLINE, 'px-4 py-3')}><p className="text-destructive text-sm" role="alert">{tCommon('error')}</p></div>
        ) : (
          <SettingsRow label={t('label')} htmlFor="agent-reply-pause">
            <Select value={toValue(minutes)} disabled={!canEdit || saving}
              onValueChange={(value) => setMinutes(value === NEVER || value === null ? null : Number(value))}>
              <SelectTrigger id="agent-reply-pause" className="w-full">
                <SelectValue>{label(minutes)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {options.map((value) => (
                  <SelectItem key={toValue(value)} value={toValue(value)}>{label(value)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRow>
        )}
    </SettingsGroup>
  );
}
