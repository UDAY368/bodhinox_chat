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
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import type { TenantSupportGrant } from '@/lib/platform/support';
import { SETTINGS_ROW_HAIRLINE, SettingsBlock, SettingsGroup, SettingsRow } from '../settings-row';

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
  const [sheetOpen, setSheetOpen] = useState(false);

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
        setSheetOpen(false);
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
  const note = (text: string, role?: 'status') => (
    <SettingsBlock className="py-3"><p role={role} className="text-sm text-muted-foreground">{text}</p></SettingsBlock>
  );
  return (
    <SettingsGroup
      title={t('title')}
      footer={t('description')}
      action={
        <Button type="button" size="sm" className="min-h-11 sm:min-h-8" onClick={() => setSheetOpen(true)}>
          {t('grant.submit')}
        </Button>
      }
    >
      {grants === null && !message && (
        <div className={cn(SETTINGS_ROW_HAIRLINE, 'space-y-2 px-4 py-3')} aria-busy="true" aria-label={t('loading')}>
          <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
          <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
        </div>
      )}
      {grants !== null && grants.length === 0 && note(t('empty'))}
      {grants?.map((grant) => (
        <div key={grant.id} className={cn(SETTINGS_ROW_HAIRLINE, 'flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4')}>
          <div className="min-w-0 flex-1 space-y-1">
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
          </div>
          {(grant.actionable || grant.status === 'approved') && (
            <div className="flex shrink-0 gap-2">
              {grant.actionable && (
                <>
                  <Button type="button" size="sm" variant="outline" className="min-h-11 sm:min-h-8" disabled={busy !== null} onClick={() => decide(grant, 'deny')}>
                    {t('deny')}
                  </Button>
                  <Button type="button" size="sm" className="min-h-11 sm:min-h-8" disabled={busy !== null} onClick={() => decide(grant, 'approve')}>
                    {t('approve')}
                  </Button>
                </>
              )}
              {grant.status === 'approved' && (
                <Button type="button" size="sm" variant="destructive" className="min-h-11 sm:min-h-8" disabled={busy !== null} onClick={() => decide(grant, 'revoke')}>
                  {t('revoke')}
                </Button>
              )}
            </div>
          )}
        </div>
      ))}
      {message && note(message, 'status')}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent size="md" className="gap-4 overflow-y-auto">
          <form onSubmit={grantAccess} className="flex min-h-full flex-col gap-4">
            <SheetHeader className="pr-12">
              <SheetTitle>{t('grant.title')}</SheetTitle>
              <SheetDescription>{t('grant.help')}</SheetDescription>
            </SheetHeader>
            <div className="px-4">
              <SettingsGroup>
                <SettingsRow label={t('grant.email')} htmlFor="support-grant-email">
                  <Input id="support-grant-email" type="email" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />
                </SettingsRow>
                <SettingsRow label={t('grant.reason')} htmlFor="support-grant-reason">
                  <Textarea id="support-grant-reason" required minLength={10} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
                </SettingsRow>
                <SettingsRow label={t('grant.duration')}>
                  <SegmentedControl
                    aria-label={t('grant.duration')}
                    value={String(minutes)}
                    onValueChange={(v) => setMinutes(Number(v))}
                    options={DURATIONS.map((value) => ({ value: String(value), label: t(`grant.durations.${value}`) }))}
                  />
                </SettingsRow>
              </SettingsGroup>
              {message && sheetOpen ? <p role="status" className="mt-3 px-4 text-sm">{message}</p> : null}
            </div>
            <SheetFooter>
              <Button type="submit" className="min-h-11" disabled={busy !== null || reason.trim().length < 10 || !email.includes('@')}>
                {t('grant.submit')}
              </Button>
            </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>
    </SettingsGroup>
  );
}
