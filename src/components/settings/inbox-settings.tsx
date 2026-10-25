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
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { SettingsPanelHead } from './settings-panel-head';

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

  return (
    <section className="max-w-2xl">
      <SettingsPanelHead title={t('title')} description={t('description')} />
      <Card>
        <CardContent className="space-y-4">
          {loading || profileLoading ? (
            <p role="status">{t('loading')}</p>
          ) : (
            <>
              {error && (
                <p role="alert" className="text-destructive">
                  {t('error')}
                </p>
              )}
              {saved === null ? (
                <Button onClick={() => setRetry((v) => v + 1)}>
                  {t('retry')}
                </Button>
              ) : (
                <>
                  <div className="grid max-w-sm gap-2">
                    <Label htmlFor="reply-target">{t('label')}</Label>
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
                    <p
                      id="reply-target-help"
                      className="text-muted-foreground text-sm"
                    >
                      {t('help')}
                    </p>
                    {parsed === null && (
                      <p role="alert" className="text-destructive text-sm">
                        {t('invalid')}
                      </p>
                    )}
                  </div>
                  {!canEditSettings && (
                    <p className="text-muted-foreground text-sm">
                      {t('readOnly')}
                    </p>
                  )}
                  {canEditSettings && (
                    <Button
                      disabled={saving || parsed === null || parsed === saved}
                      onClick={() => void save()}
                    >
                      {t(saving ? 'saving' : 'save')}
                    </Button>
                  )}
                  {success && (
                    <p role="status" className="text-primary text-sm">
                      {t('saved')}
                    </p>
                  )}
                </>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
