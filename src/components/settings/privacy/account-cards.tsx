'use client';

// Settings -> Privacy & access: leave this workspace (non-owners), create another
// workspace, and delete my account. Leaving and creating move the session to the
// other workspace and reload the app there; deleting the account signs out.

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StepUpFields, sendJson, useActionError, useMfaState } from './step-up';

const reloadInto = (path: string) => window.location.assign(path);

export function LeaveWorkspaceCard({ workspaceName }: { workspaceName: string }) {
  const t = useTranslations('Settings.privacy.leave');
  const errorText = useActionError();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const leave = async () => {
    setBusy(true);
    setError(null);
    const result = await sendJson('/api/account/leave', 'POST', {});
    if (!result.ok) {
      setBusy(false);
      setError(errorText(result));
      return;
    }
    reloadInto('/dashboard');
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground">{t('title')}</CardTitle>
        <CardDescription>{t('description', { name: workspaceName })}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        {confirming ? (
          <div className="flex gap-2">
            <Button variant="destructive" onClick={leave} disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {t('confirm')}
            </Button>
            <Button variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>{t('back')}</Button>
          </div>
        ) : (
          <Button variant="outline" onClick={() => setConfirming(true)}>{t('start')}</Button>
        )}
      </CardContent>
    </Card>
  );
}

export function CreateWorkspaceCard() {
  const t = useTranslations('Settings.privacy.create');
  const errorText = useActionError();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    const result = await sendJson('/api/account/workspaces', 'POST', { name });
    if (!result.ok) {
      setBusy(false);
      setError(errorText(result));
      return;
    }
    reloadInto('/dashboard');
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground">{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="create-workspace-name">{t('name')}</Label>
          <Input id="create-workspace-name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
        </div>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <Button onClick={create} disabled={busy || !name.trim()}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : null}
          {t('submit')}
        </Button>
      </CardContent>
    </Card>
  );
}

export function DeleteAccountCard() {
  const t = useTranslations('Settings.privacy.deleteAccount');
  const errorText = useActionError();
  const mfa = useMfaState();
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyword = t('keyword');

  const submit = async () => {
    setBusy(true);
    setError(null);
    const result = await sendJson('/api/auth/account-delete', 'POST', {
      ...(password ? { currentPassword: password } : {}),
      ...(code ? { mfaCode: code } : {}),
    });
    if (!result.ok) {
      setBusy(false);
      setError(errorText(result));
      return;
    }
    reloadInto('/login');
  };

  return (
    <Card className="border-destructive/30">
      <CardHeader>
        <CardTitle className="text-foreground">{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        {!open ? (
          <Button variant="destructive" onClick={() => setOpen(true)}>{t('start')}</Button>
        ) : (
          <div className="space-y-3">
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              <li>{t('effects.ownership')}</li>
              <li>{t('effects.soleWorkspaces')}</li>
              <li>{t('effects.identity')}</li>
            </ul>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="delete-account-confirm">{t('typeKeyword', { keyword })}</Label>
              <Input id="delete-account-confirm" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" />
            </div>
            <StepUpFields
              idPrefix="delete-account"
              mfa={mfa}
              identity
              password={password}
              onPassword={setPassword}
              code={code}
              onCode={setCode}
            />
            <div className="flex gap-2">
              <Button variant="destructive" onClick={submit} disabled={busy || confirmText.trim() !== keyword}>
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
