'use client';

// Settings -> Privacy & access -> Delete workspace (owner). Requests deletion:
// sending stops at once, nothing is deleted during the 30-day grace period and
// the owner can cancel. Other members see the pending request (read-only).

import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StepUpFields, sendJson, useActionError, useMfaState } from './step-up';

/** Type-to-confirm: the typed name matches a workspace name that has loaded (never two empty strings). */
export function deletionNameConfirmed(typed: string, workspaceName: string): boolean {
  return workspaceName.trim() !== '' && typed.trim() === workspaceName.trim();
}

export interface LifecycleState {
  status: 'active' | 'admin_suspended' | 'closing';
  deletionRequestedAt: string | null;
  purgeAfter: string | null;
}

export function DeleteWorkspaceCard({
  workspaceName,
  isOwner,
  lifecycle,
  onChange,
}: {
  workspaceName: string;
  isOwner: boolean;
  lifecycle: LifecycleState | null;
  onChange: (next: LifecycleState) => void;
}) {
  const t = useTranslations('Settings.privacy.deleteWorkspace');
  const format = useFormatter();
  const errorText = useActionError();
  const mfa = useMfaState();
  const [open, setOpen] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const closing = lifecycle?.status === 'closing';

  const submit = async () => {
    setBusy(true);
    setError(null);
    const result = await sendJson<{ lifecycle: LifecycleState; billingCancel: string }>('/api/account/deletion', 'POST', {
      ...(password ? { currentPassword: password } : {}),
      ...(code ? { mfaCode: code } : {}),
    });
    setBusy(false);
    if (!result.ok || !result.data) {
      setError(errorText(result));
      return;
    }
    setOpen(false);
    setPassword('');
    setCode('');
    setConfirmName('');
    setNotice(t(`billing.${result.data.billingCancel}`));
    onChange(result.data.lifecycle);
  };

  const cancel = async () => {
    setBusy(true);
    setError(null);
    const result = await sendJson<{ lifecycle: LifecycleState }>('/api/account/deletion', 'DELETE');
    setBusy(false);
    if (!result.ok || !result.data) {
      setError(errorText(result));
      return;
    }
    setNotice(t('cancelled'));
    onChange(result.data.lifecycle);
  };

  return (
    <Card className="border-destructive/30">
      <CardHeader>
        <CardTitle className="text-foreground">{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {closing ? (
          <div role="status" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-foreground">
            {t('pending', {
              date: lifecycle?.purgeAfter ? format.dateTime(new Date(lifecycle.purgeAfter), { dateStyle: 'long' }) : '-',
            })}
          </div>
        ) : null}
        {notice ? <p className="text-sm text-muted-foreground">{notice}</p> : null}
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        {!isOwner ? (
          <p className="text-sm text-muted-foreground">{t('ownerOnly')}</p>
        ) : closing ? (
          <Button variant="outline" onClick={cancel} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            {t('cancel')}
          </Button>
        ) : lifecycle?.status === 'admin_suspended' ? (
          <p className="text-sm text-muted-foreground">{t('adminSuspended')}</p>
        ) : !open ? (
          <Button variant="destructive" onClick={() => setOpen(true)}>{t('start')}</Button>
        ) : (
          <div className="space-y-3">
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              <li>{t('effects.sending')}</li>
              <li>{t('effects.grace')}</li>
              <li>{t('effects.billing')}</li>
              <li>{t('effects.export')}</li>
            </ul>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="delete-workspace-name">{t('typeName', { name: workspaceName })}</Label>
              <Input id="delete-workspace-name" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} autoComplete="off" />
            </div>
            <StepUpFields
              idPrefix="delete-workspace"
              mfa={mfa}
              identity
              password={password}
              onPassword={setPassword}
              code={code}
              onCode={setCode}
            />
            <div className="flex gap-2">
              <Button variant="destructive" onClick={submit} disabled={busy || !deletionNameConfirmed(confirmName, workspaceName)}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                {t('confirm')}
              </Button>
              <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>{t('back')}</Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
