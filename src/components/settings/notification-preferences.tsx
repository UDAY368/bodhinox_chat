'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { useAuth } from '@/hooks/use-auth';
import { authFetch } from '@/lib/auth/client';
import type { NotificationPreference } from '@/lib/notifications/preferences';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { SettingsPanelHead } from './settings-panel-head';

const ENDPOINT = '/api/notifications/preferences';
type Channel = 'in_app' | 'email';

/**
 * The signed-in member's own notification preferences: an in-app and an
 * email-digest switch per event. Each switch saves on change and reverts if
 * the save fails. Any member can manage their own; the email column is off
 * limits while the workspace has no email delivery configured.
 */
export function NotificationPreferences({ className }: { className?: string }) {
  const t = useTranslations('NotificationPreferences');
  const events = useTranslations('NotificationEvents');
  const { accountId } = useAuth();
  const [preferences, setPreferences] = useState<NotificationPreference[] | null>(null);
  const [emailAvailable, setEmailAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!accountId) return;
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      setError(false);
      try {
        const response = await authFetch(ENDPOINT, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('load');
        const data = (await response.json()) as { preferences: NotificationPreference[]; email_available: boolean };
        if (!controller.signal.aborted) {
          setPreferences(data.preferences);
          setEmailAvailable(data.email_available);
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

  async function toggle(event: NotificationPreference['event'], channel: Channel, value: boolean) {
    if (!preferences || saving) return;
    const current = preferences.find((p) => p.event === event);
    if (!current) return;
    const next = { ...current, [channel]: value };
    const previous = preferences;
    setPreferences(preferences.map((p) => (p.event === event ? next : p)));
    setSaving(`${event}:${channel}`);
    try {
      const response = await authFetch(ENDPOINT, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferences: [next] }),
      });
      if (!response.ok) throw new Error('save');
      const data = (await response.json()) as { preferences: NotificationPreference[]; email_available: boolean };
      setPreferences(data.preferences);
      setEmailAvailable(data.email_available);
    } catch {
      setPreferences(previous);
      toast.error(t('saveFailed'));
    } finally {
      setSaving(null);
    }
  }

  return (
    <section className={cn('max-w-2xl', className)}>
      <SettingsPanelHead title={t('title')} description={t('description')} />
      <Card>
        <CardContent className="space-y-4">
          {loading ? (
            <p role="status">{t('loading')}</p>
          ) : error || !preferences ? (
            <div className="space-y-3">
              <p role="alert" className="text-destructive">
                {t('loadFailed')}
              </p>
              <Button onClick={() => setRetry((v) => v + 1)}>{t('retry')}</Button>
            </div>
          ) : (
            <>
              {!emailAvailable && (
                <p className="text-muted-foreground text-sm">{t('emailUnavailable')}</p>
              )}
              <div role="table" aria-label={t('title')} className="divide-y">
                <div role="row" className="text-muted-foreground flex items-center gap-4 pb-2 text-xs font-medium">
                  <span role="columnheader" className="flex-1">
                    {t('event')}
                  </span>
                  <span role="columnheader" className="w-16 text-center">
                    {events('inApp')}
                  </span>
                  <span role="columnheader" className="w-16 text-center">
                    {events('email')}
                  </span>
                </div>
                {preferences.map((pref) => {
                  const label = events(`${pref.event}.label`);
                  return (
                    <div role="row" key={pref.event} className="flex items-center gap-4 py-3">
                      <div role="cell" className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{label}</p>
                        <p className="text-muted-foreground text-xs">{events(`${pref.event}.description`)}</p>
                      </div>
                      <div role="cell" className="flex w-16 justify-center">
                        <Switch
                          checked={pref.in_app}
                          disabled={saving !== null}
                          aria-label={t('inAppFor', { event: label })}
                          onCheckedChange={(value) => void toggle(pref.event, 'in_app', value)}
                        />
                      </div>
                      <div role="cell" className="flex w-16 justify-center">
                        <Switch
                          checked={pref.email}
                          disabled={saving !== null || (!emailAvailable && !pref.email)}
                          aria-label={t('emailFor', { event: label })}
                          onCheckedChange={(value) => void toggle(pref.event, 'email', value)}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="text-muted-foreground text-xs">{t('digestHint')}</p>
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
