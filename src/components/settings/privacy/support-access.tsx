'use client';

// Settings -> Privacy & access -> Support access. Owners and admins see
// Bodhinox support's diagnostics requests and grants, approve, deny or
// revoke them, or grant access proactively to a named support email. Support
// sees statuses, counts and error codes only, never messages or contacts.

import { useCallback, useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { authFetch } from '@/lib/auth/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { TenantSupportGrant } from '@/lib/platform/support';

const DURATIONS = [60, 240, 1440] as const;
const ERROR_CODES = ['invalid', 'not_found', 'grant_open', 'not_pending', 'not_active', 'request_expired'];

export function SupportAccess(): React.ReactElement | null {
  const t = useTranslations('Settings.privacy.supportAccess');
  const format = useFormatter();
  const [grants, setGrants] = useState<TenantSupportGrant[] | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState<number>(60);

  const load = useCallback(async () => {
    const response = await authFetch('/api/account/support-grants');
    if (response.status === 403) {
      setForbidden(true);
      return;
    }
    if (!response.ok) throw new Error('load failed');
    setGrants((await response.json()).grants);
  }, []);
  useEffect(() => {
    load().catch(() => setMessage(t('errors.loadFailed')));
  }, [load, t]);

  const errorText = async (response: Response) => {
    const body = await response.json().catch(() => null);
    const code = typeof body?.code === 'string' ? body.code : '';
    return ERROR_CODES.includes(code) ? t(`errors.${code}`) : t('errors.failed');
  };

  async function decide(grant: TenantSupportGrant, action: 'approve' | 'deny' | 'revoke') {
    setBusy(grant.id);
    setMessage(null);
    try {
      const response = await authFetch(`/api/account/support-grants/${encodeURIComponent(grant.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      setMessage(response.ok ? t(`done.${action}`) : await errorText(response));
      await load();
    } catch {
      setMessage(t('errors.failed'));
    } finally {
      setBusy(null);
    }
  }

  async function grantAccess(event: React.FormEvent) {
    event.preventDefault();
    setBusy('new');
    setMessage(null);
    try {
      const response = await authFetch('/api/account/support-grants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), reason: reason.trim(), minutes }),
      });
      if (response.ok) {
        setEmail('');
        setReason('');
        setMessage(t('done.granted'));
      } else {
        setMessage(await errorText(response));
      }
      await load();
    } catch {
      setMessage(t('errors.failed'));
    } finally {
      setBusy(null);
    }
  }

  if (forbidden) return null;
  const date = (value: string) => format.dateTime(new Date(value), { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground">{t('title')}</CardTitle>
        <CardDescription className="text-muted-foreground">{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {grants === null && !message && <p className="text-muted-foreground text-sm">{t('loading')}</p>}
        {grants !== null && grants.length === 0 && <p className="text-muted-foreground text-sm">{t('empty')}</p>}
        {grants !== null && grants.length > 0 && (
          <ul className="divide-border divide-y">
            {grants.map((grant) => (
              <li key={grant.id} className="flex flex-col gap-1 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{grant.requestedByEmail}</span>
                  <Badge variant={grant.status === 'approved' ? 'default' : grant.status === 'requested' ? 'secondary' : 'outline'}>
                    {t(`status.${grant.status}`)}
                  </Badge>
                </div>
                <p className="text-sm break-words">{grant.reason}</p>
                <p className="text-muted-foreground text-xs">
                  {t('requested', { when: date(grant.requestedAt), minutes: grant.requestedMinutes })}
                  {grant.status === 'approved' && grant.expiresAt && <> · {t('expires', { when: date(grant.expiresAt) })}</>}
                </p>
                <div className="flex gap-2 pt-1">
                  {grant.actionable && (
                    <>
                      <Button type="button" size="sm" disabled={busy !== null} onClick={() => decide(grant, 'approve')}>
                        {t('approve')}
                      </Button>
                      <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => decide(grant, 'deny')}>
                        {t('deny')}
                      </Button>
                    </>
                  )}
                  {grant.status === 'approved' && (
                    <Button type="button" size="sm" variant="destructive" disabled={busy !== null} onClick={() => decide(grant, 'revoke')}>
                      {t('revoke')}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={grantAccess} className="border-border flex flex-col gap-3 border-t pt-4">
          <p className="text-sm font-medium">{t('grant.title')}</p>
          <p className="text-muted-foreground text-xs">{t('grant.help')}</p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="support-grant-email">{t('grant.email')}</Label>
            <Input id="support-grant-email" type="email" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="support-grant-reason">{t('grant.reason')}</Label>
            <Textarea id="support-grant-reason" required minLength={10} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="support-grant-minutes">{t('grant.duration')}</Label>
            <select
              id="support-grant-minutes"
              className="border-input bg-background h-9 rounded-md border px-2 text-sm"
              value={minutes}
              onChange={(e) => setMinutes(Number(e.target.value))}
            >
              {DURATIONS.map((value) => (
                <option key={value} value={value}>
                  {t(`grant.durations.${value}`)}
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" className="self-start" disabled={busy !== null || reason.trim().length < 10 || !email.includes('@')}>
            {t('grant.submit')}
          </Button>
        </form>
        {message && (
          <p role="status" className="text-sm">
            {message}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
