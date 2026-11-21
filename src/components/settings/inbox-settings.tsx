'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/hooks/use-auth';
import { authFetch } from '@/lib/auth/client';
import {
  parseReplyTarget,
  REPLY_TARGET_MIN,
  REPLY_TARGET_MAX,
} from '@/lib/settings/reply-target';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { InlineError } from '@/components/ui/inline-error';
import { cn } from '@/lib/utils';
import { SettingsPanelHead } from './settings-panel-head';
import { SETTINGS_ROW_HAIRLINE, SettingsGroup, SettingsRow } from './settings-row';

export function InboxSettings() {
  const t = useTranslations('inboxSettings');
  const { accountId, canEditSettings, profileLoading } = useAuth();
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const [success, setSuccess] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!accountId) return;
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      setSaved(null);
      setError(false);
      setSuccess(false);
      try {
        const response = await authFetch('/api/account/inbox', {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('load');
        const data = await response.json();
        if (!controller.signal.aborted) {
          setSaved(data.reply_target_minutes);
          setValue(String(data.reply_target_minutes));
        }
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [accountId, retry]);

  const parsed = parseReplyTarget(value);
  async function save() {
    if (!canEditSettings || parsed === null || saving) return;
    setSaving(true);
    setError(false);
    setSuccess(false);
    try {
      const response = await authFetch('/api/account/inbox', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reply_target_minutes: parsed }),
      });
      if (!response.ok) throw new Error('save');
      const data = await response.json();
      setSaved(data.reply_target_minutes);
      setValue(String(data.reply_target_minutes));
      setSuccess(true);
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  }

  const ready = !(loading || profileLoading) && saved !== null;

  return (
    <section className="max-w-2xl">
      <SettingsPanelHead title={t('title')} description={t('description')} />
      <SettingsGroup
        footer={ready && !canEditSettings ? t('readOnly') : undefined}
        action={ready && canEditSettings ? (
          <Button
            size="sm"
            className="min-h-11 sm:min-h-8"
            disabled={saving || parsed === null || parsed === saved}
            onClick={() => void save()}
          >
            {t(saving ? 'saving' : 'save')}
          </Button>
        ) : undefined}
      >
        {loading || profileLoading ? (
          <div className={cn(SETTINGS_ROW_HAIRLINE, 'flex min-h-11 items-center gap-4 px-4 py-3')} role="status" aria-label={t('loading')}>
            <div className="h-4 flex-1 animate-pulse rounded bg-muted motion-reduce:animate-none" />
            <div className="h-9 w-32 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
          </div>
        ) : saved === null ? (
          <InlineError message={t('error')} onRetry={() => setRetry((v) => v + 1)} />
        ) : (
          <>
            {error && (
              <div className={cn(SETTINGS_ROW_HAIRLINE, 'px-4 py-3')}>
                <p role="alert" className="text-destructive text-sm">{t('error')}</p>
              </div>
            )}
            <SettingsRow
              label={t('label')}
              htmlFor="reply-target"
              hint={<span id="reply-target-help">{t('help')}</span>}
              error={parsed === null ? t('invalid') : null}
            >
              <Input
                id="reply-target"
                type="number"
                min={REPLY_TARGET_MIN}
                max={REPLY_TARGET_MAX}
                step={1}
                value={value}
                disabled={!canEditSettings || saving}
                aria-describedby="reply-target-help"
                aria-invalid={parsed === null}
                onChange={(event) => {
                  setValue(event.target.value);
                  setSuccess(false);
                }}
              />
            </SettingsRow>
            {success && (
              <div className={cn(SETTINGS_ROW_HAIRLINE, 'px-4 py-3')}>
                <p role="status" className="text-primary text-sm">{t('saved')}</p>
              </div>
            )}
          </>
        )}
      </SettingsGroup>
    </section>
  );
}
