'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { BellRing, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { useAuth } from '@/hooks/use-auth';
import { authFetch } from '@/lib/auth/client';
import type { NotificationPreference } from '@/lib/notifications/preferences';
import { currentPushSubscription, disablePush, enablePush, pushSupported, type PushStatus } from '@/lib/notifications/push-client';
import { QUIET_HOURS_EVENT } from '@/lib/notifications/quiet-hours-store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { BrowserNotificationsCard } from './browser-notifications-card';
import { SettingsPanelHead } from './settings-panel-head';
import { SettingsPanel, SettingsSwitchRow } from './settings-row';
import { useSettingsDraft } from './settings-draft';

const ENDPOINT = '/api/notifications/preferences';
type Channel = 'in_app' | 'email' | 'push';
const CHANNELS: Channel[] = ['in_app', 'email', 'push'];

interface QuietView {
  enabled: boolean;
  start: string;
  end: string;
  time_zone: string;
  allow_mentions: boolean;
}
interface Draft {
  preferences: NotificationPreference[];
  quiet: QuietView;
}
interface Loaded extends Draft {
  email_available: boolean;
  push_available: boolean;
}

const browserZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

/** The quiet-hours field error for a draft, or null (pure). */
export function quietHoursError(quiet: QuietView): 'sameTimes' | null {
  return quiet.enabled && (!quiet.start || !quiet.end || quiet.start === quiet.end) ? 'sameTimes' : null;
}

/**
 * Settings › Notifications: per event, in-app, email digest and browser push;
 * quiet hours (email and push pause, in-app still collects, mentions can pass);
 * this browser's push and a test. The grid and quiet hours are one draft saved
 * from the shared Unsaved changes bar. Any member manages their own; the email
 * column is off limits without email delivery, the push column without VAPID keys.
 */
export function NotificationPreferences({ className }: { className?: string }) {
  const t = useTranslations('NotificationPreferences');
  const tr = useTranslations('SettingsRedesign.notifications');
  const events = useTranslations('NotificationEvents');
  const { accountId } = useAuth();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [retry, setRetry] = useState(0);
  const [showErrors, setShowErrors] = useState(false);
  const [push, setPush] = useState<PushStatus | null>(null);
  const [thisBrowser, setThisBrowser] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [testing, setTesting] = useState(false);

  const apply = useCallback((data: Loaded) => {
    setLoaded(data);
    setDraft({ preferences: data.preferences, quiet: data.quiet });
    window.dispatchEvent(new CustomEvent(QUIET_HOURS_EVENT, { detail: data.quiet }));
  }, []);

  useEffect(() => {
    if (!accountId) return;
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      setError(false);
      try {
        const response = await authFetch(ENDPOINT, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('load');
        const data = (await response.json()) as { preferences: NotificationPreference[]; email_available: boolean; push_available: boolean; quiet_hours: QuietView };
        if (!controller.signal.aborted)
          apply({ preferences: data.preferences, quiet: data.quiet_hours, email_available: data.email_available, push_available: data.push_available });
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [accountId, retry, apply]);

  useEffect(() => {
    if (!accountId) return;
    let live = true;
    void authFetch('/api/notifications/push-subscriptions', { cache: 'no-store' })
      .then(async (r) => (r.ok ? ((await r.json()) as PushStatus) : null))
      .then((status) => { if (live) setPush(status); })
      .catch(() => undefined);
    void currentPushSubscription().then((sub) => { if (live) setThisBrowser(Boolean(sub)); }).catch(() => undefined);
    return () => { live = false; };
  }, [accountId]);

  const dirty = Boolean(loaded && draft) && JSON.stringify({ p: draft!.preferences, q: draft!.quiet }) !== JSON.stringify({ p: loaded!.preferences, q: loaded!.quiet });

  const save = useCallback(async () => {
    if (!draft) return false;
    if (quietHoursError(draft.quiet)) {
      setShowErrors(true);
      toast.error(tr('checkFields'));
      return false;
    }
    // Switched off, the (hidden) times are not checked on screen; keep the stored ones if they are not valid.
    const timesValid = Boolean(draft.quiet.start && draft.quiet.end && draft.quiet.start !== draft.quiet.end);
    const quiet = timesValid || !loaded ? draft.quiet : { ...draft.quiet, start: loaded.quiet.start, end: loaded.quiet.end };
    setSaving(true);
    try {
      const response = await authFetch(ENDPOINT, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferences: draft.preferences, quiet_hours: { ...quiet, time_zone: browserZone() } }),
      });
      if (!response.ok) throw new Error('save');
      const data = (await response.json()) as { preferences: NotificationPreference[]; email_available: boolean; push_available: boolean; quiet_hours: QuietView };
      apply({ preferences: data.preferences, quiet: data.quiet_hours, email_available: data.email_available, push_available: data.push_available });
      setShowErrors(false);
      toast.success(tr('saved'));
      return true;
    } catch {
      toast.error(t('saveFailed'));
      return false;
    } finally {
      setSaving(false);
    }
  }, [draft, loaded, apply, t, tr]);

  const discard = useCallback(() => {
    if (loaded) setDraft({ preferences: loaded.preferences, quiet: loaded.quiet });
    setShowErrors(false);
  }, [loaded]);

  useSettingsDraft('notifications', { dirty, saving, save, discard });

  const toggle = (event: NotificationPreference['event'], channel: Channel, value: boolean) =>
    setDraft((d) => (d ? { ...d, preferences: d.preferences.map((p) => (p.event === event ? { ...p, [channel]: value } : p)) } : d));
  const setQuiet = (patch: Partial<QuietView>) =>
    setDraft((d) => (d ? { ...d, quiet: { ...d.quiet, ...patch } } : d));

  const turnOnPush = async () => {
    if (!push?.public_key) return;
    setPushBusy(true);
    const result = await enablePush(push.public_key, { title: tr('pushTitle'), body: tr('pushBody') });
    setPushBusy(false);
    if (result === 'enabled') {
      setThisBrowser(true);
      setPush((p) => (p ? { ...p, devices: p.devices + (thisBrowser ? 0 : 1) } : p));
      toast.success(tr('pushOn'));
    } else toast.error(tr(result === 'denied' ? 'pushDenied' : result === 'unsupported' ? 'pushUnsupported' : 'pushFailed'));
  };
  const turnOffPush = async () => {
    setPushBusy(true);
    await disablePush();
    setPushBusy(false);
    setThisBrowser(false);
    setPush((p) => (p ? { ...p, devices: Math.max(0, p.devices - 1) } : p));
    toast.success(tr('pushOff'));
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      if (loaded?.push_available && thisBrowser) {
        const response = await authFetch('/api/notifications/push-test', { method: 'POST' });
        const body = (await response.json().catch(() => ({}))) as { sent?: number };
        if (!response.ok || !body.sent) throw new Error('push');
        toast.success(tr('testSent'));
      } else if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification(tr('pushTitle'), { body: tr('testBody'), tag: 'bodhinox-test' });
        toast.success(tr('testShown'));
      } else {
        toast.error(tr('testNeedsPermission'));
      }
    } catch {
      toast.error(tr('testFailed'));
    } finally {
      setTesting(false);
    }
  };

  const columnLabel = (channel: Channel) => (channel === 'in_app' ? events('inApp') : channel === 'email' ? events('email') : tr('push'));
  const quietErr = showErrors && draft ? quietHoursError(draft.quiet) : null;

  return (
    <section className={cn('max-w-3xl space-y-8', className)}>
      <SettingsPanelHead title={t('title')} description={t('description')} className="mb-0" />
      {loading ? (
        <div className="rounded-xl border border-border bg-card px-4 py-6">
          <p role="status" className="text-sm text-muted-foreground">{t('loading')}</p>
        </div>
      ) : error || !draft || !loaded ? (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-border bg-card px-4 py-5">
          <p role="alert" className="text-sm text-destructive">{t('loadFailed')}</p>
          <Button variant="outline" size="sm" onClick={() => setRetry((v) => v + 1)}>{t('retry')}</Button>
        </div>
      ) : (
        <>
          <div className="space-y-3">
            {!loaded.email_available && <p className="px-0.5 text-[13px] text-muted-foreground">{t('emailUnavailable')}</p>}
            {!loaded.push_available && <p className="px-0.5 text-[13px] text-muted-foreground">{tr('pushUnavailable')}</p>}
            <div role="table" aria-label={t('title')} className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
              <div role="row" className="flex min-h-[38px] items-center gap-2 bg-muted/60 px-3 text-xs font-semibold text-muted-foreground sm:gap-3 sm:px-4">
                <span role="columnheader" className="min-w-0 flex-1">{t('event')}</span>
                {CHANNELS.map((channel) => (
                  <span key={channel} role="columnheader" className="w-12 shrink-0 text-center sm:w-16">{columnLabel(channel)}</span>
                ))}
              </div>
              {draft.preferences.map((pref) => {
                const label = events(`${pref.event}.label`);
                return (
                  <div role="row" key={pref.event} className="flex min-h-14 items-center gap-2 px-3 py-2.5 sm:gap-3 sm:px-4">
                    <div role="cell" className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-foreground">{label}</p>
                      <p className="text-xs text-muted-foreground">{events(`${pref.event}.description`)}</p>
                    </div>
                    <div role="cell" className="flex w-12 shrink-0 justify-center sm:w-16">
                      <Switch checked={pref.in_app} disabled={saving} aria-label={t('inAppFor', { event: label })}
                        onCheckedChange={(value) => toggle(pref.event, 'in_app', value)} />
                    </div>
                    <div role="cell" className="flex w-12 shrink-0 justify-center sm:w-16">
                      <Switch checked={pref.email} disabled={saving || (!loaded.email_available && !pref.email)} aria-label={t('emailFor', { event: label })}
                        onCheckedChange={(value) => toggle(pref.event, 'email', value)} />
                    </div>
                    <div role="cell" className="flex w-12 shrink-0 justify-center sm:w-16">
                      <Switch checked={pref.push} disabled={saving || (!loaded.push_available && !pref.push)} aria-label={tr('pushFor', { event: label })}
                        onCheckedChange={(value) => toggle(pref.event, 'push', value)} />
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="px-0.5 text-xs text-muted-foreground">{t('digestHint')}</p>
          </div>

          <section aria-labelledby="quiet-hours-title" className="space-y-3">
            <h3 id="quiet-hours-title" className="text-base font-semibold text-foreground">{tr('quietTitle')}</h3>
            <SettingsPanel>
              <SettingsSwitchRow title={tr('quietPause')} description={tr('quietPauseHint')}
                control={<Switch checked={draft.quiet.enabled} disabled={saving} aria-label={tr('quietTitle')} onCheckedChange={(enabled) => setQuiet({ enabled })} />} />
              {draft.quiet.enabled && (
                <>
                  <div className="grid grid-cols-1 gap-2 px-4 py-3.5 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)] sm:items-center sm:gap-6">
                    <div>
                      <p className="text-sm font-medium text-foreground">{tr('quietBetween')}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{tr('quietZone', { zone: browserZone() })}</p>
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Input type="time" className="w-32 bg-muted" aria-label={tr('quietStart')} value={draft.quiet.start} disabled={saving}
                          onChange={(e) => setQuiet({ start: e.target.value })} />
                        <span className="text-xs text-muted-foreground">{tr('and')}</span>
                        <Input type="time" className="w-32 bg-muted" aria-label={tr('quietEnd')} value={draft.quiet.end} disabled={saving}
                          aria-invalid={Boolean(quietErr)} aria-describedby={quietErr ? 'quiet-error' : undefined}
                          onChange={(e) => setQuiet({ end: e.target.value })} />
                      </div>
                      {quietErr && <p id="quiet-error" role="alert" className="mt-1.5 text-xs text-destructive">{tr('sameTimes')}</p>}
                    </div>
                  </div>
                  <SettingsSwitchRow title={tr('quietMentions')} description={tr('quietMentionsHint')}
                    control={<Switch checked={draft.quiet.allow_mentions} disabled={saving} aria-label={tr('quietMentions')}
                      onCheckedChange={(allow_mentions) => setQuiet({ allow_mentions })} />} />
                </>
              )}
            </SettingsPanel>
          </section>

          <section aria-labelledby="push-device-title" className="space-y-3">
            <h3 id="push-device-title" className="text-base font-semibold text-foreground">{tr('deviceTitle')}</h3>
            <SettingsPanel>
              <SettingsSwitchRow
                title={tr('thisBrowser')}
                description={
                  !loaded.push_available ? tr('pushUnavailable')
                    : !pushSupported() ? tr('pushUnsupported')
                    : thisBrowser ? tr('thisBrowserOn', { count: push?.devices ?? 1 }) : tr('thisBrowserOff')
                }
                control={loaded.push_available && pushSupported() ? (
                  thisBrowser ? (
                    <Button type="button" variant="outline" size="sm" disabled={pushBusy} onClick={() => void turnOffPush()}>
                      {pushBusy && <Loader2 className="size-3.5 animate-spin" />} {tr('turnOff')}
                    </Button>
                  ) : (
                    <Button type="button" size="sm" disabled={pushBusy} onClick={() => void turnOnPush()}>
                      {pushBusy && <Loader2 className="size-3.5 animate-spin" />} {tr('turnOn')}
                    </Button>
                  )
                ) : null}
              />
              <SettingsSwitchRow
                title={tr('tryIt')}
                description={tr('tryItHint')}
                control={
                  <Button type="button" variant="outline" size="sm" disabled={testing} onClick={() => void sendTest()}>
                    {testing ? <Loader2 className="size-3.5 animate-spin" /> : <BellRing className="size-3.5" />} {tr('sendTest')}
                  </Button>
                }
              />
            </SettingsPanel>
          </section>

          <BrowserNotificationsCard />
        </>
      )}
    </section>
  );
}
