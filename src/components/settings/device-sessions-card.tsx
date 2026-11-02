'use client';

import { useCallback, useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Laptop, Smartphone, Tablet, MonitorSmartphone } from 'lucide-react';
import { authFetch } from '@/lib/auth/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type DeviceSession = {
  id: string;
  current: boolean;
  browser: string | null;
  os: string | null;
  device: 'desktop' | 'mobile' | 'tablet' | 'unknown';
  createdAt: string;
  lastUsedAt: string;
};
const ICONS = { desktop: Laptop, mobile: Smartphone, tablet: Tablet, unknown: MonitorSmartphone };

/** Active sessions for the signed-in user, with per-device and "all other devices" sign-out. */
export function DeviceSessionsCard() {
  const t = useTranslations('Settings.security.devices');
  const format = useFormatter();
  const [sessions, setSessions] = useState<DeviceSession[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await authFetch('/api/auth/sessions');
    if (!response.ok) throw new Error('load failed');
    setSessions((await response.json()).sessions);
  }, []);
  useEffect(() => {
    load().catch(() => setMessage(t('loadFailed')));
  }, [load, t]);

  async function revoke(query: string, key: string) {
    setBusy(key);
    setMessage(null);
    try {
      const response = await authFetch(`/api/auth/sessions?${query}`, { method: 'DELETE' });
      if (!response.ok) {
        const result = await response.json().catch(() => null);
        setMessage(result?.error?.message ?? t('revokeFailed'));
      }
      await load();
    } catch {
      setMessage(t('revokeFailed'));
    } finally {
      setBusy(null);
    }
  }

  const others = sessions?.filter((session) => !session.current).length ?? 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground">{t('title')}</CardTitle>
        <CardDescription className="text-muted-foreground">{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {sessions === null && !message && <p className="text-muted-foreground text-sm">{t('loading')}</p>}
        <ul className="divide-border divide-y">
          {sessions?.map((session) => {
            const Icon = ICONS[session.device] ?? MonitorSmartphone;
            const name = [session.browser ?? t('unknownBrowser'), session.os ?? t('unknownOs')].join(' · ');
            return (
              <li key={session.id} className="flex items-center gap-3 py-2">
                <Icon className="text-muted-foreground size-5 shrink-0" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {name}
                    {session.current && <span className="text-primary ml-2 text-xs">{t('thisDevice')}</span>}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {t('activity', {
                      lastUsed: format.relativeTime(new Date(session.lastUsedAt)),
                      signedIn: format.dateTime(new Date(session.createdAt), { dateStyle: 'medium' }),
                    })}
                  </p>
                </div>
                {!session.current && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => revoke(`id=${encodeURIComponent(session.id)}`, session.id)}
                  >
                    {t('signOut')}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
        {message && (
          <p role="status" className="text-sm">
            {message}
          </p>
        )}
        {others > 0 && (
          <Button
            type="button"
            variant="outline"
            className="self-start"
            disabled={busy !== null}
            onClick={() => revoke('scope=others', 'others')}
          >
            {t('signOutOthers', { count: others })}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
