'use client';

// Settings -> Privacy & access: leave this workspace (non-owners), create another
// workspace, and delete my account. Leaving and creating move the session to the
// other workspace and reload the app there; deleting the account signs out.

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { GroupedListRow } from '@/components/ui/grouped-list';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { GroupError, StepUpFields, sendJson, useActionError, useMfaState } from './step-up';
import { SettingsGroup, SettingsRow } from '../settings-row';

const reloadInto = (path: string) => window.location.assign(path);

export function LeaveWorkspaceCard({ workspaceName }: { workspaceName: string }) {
  const t = useTranslations('Settings.privacy.leave');
  const errorText = useActionError();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const leave = async () => {
    const ok = await confirm({
      title: t('title'),
      body: t('description', { name: workspaceName }),
      confirmLabel: t('confirm'),
      cancelLabel: t('back'),
      destructive: true,
    });
    if (!ok) return;
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
    <SettingsGroup title={t('title')} footer={t('description', { name: workspaceName })}>
      <GroupedListRow
        destructive
        title={t('start')}
        trailing={busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : undefined}
        onClick={busy ? undefined : () => void leave()}
      />
      <GroupError error={error} />
    </SettingsGroup>
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
    <SettingsGroup
      title={t('title')}
      footer={t('description')}
      action={
        <Button size="sm" className="min-h-11 sm:min-h-8" onClick={create} disabled={busy || !name.trim()}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : null}
          {t('submit')}
        </Button>
      }
    >
      <SettingsRow label={t('name')} htmlFor="create-workspace-name" error={error}>
        <Input id="create-workspace-name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
      </SettingsRow>
    </SettingsGroup>
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
    <SettingsGroup title={t('title')} footer={t('description')}>
      <GroupedListRow destructive title={t('start')} onClick={() => setOpen(true)} />
      {!open ? <GroupError error={error} /> : null}
      <Sheet open={open} onOpenChange={(next) => { if (!busy) setOpen(next); }}>
        <SheetContent size="md" className="gap-4 overflow-y-auto">
          <SheetHeader className="pr-12">
            <SheetTitle>{t('title')}</SheetTitle>
            <SheetDescription>{t('description')}</SheetDescription>
          </SheetHeader>
          <div className="space-y-4 px-4">
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              <li>{t('effects.ownership')}</li>
              <li>{t('effects.soleWorkspaces')}</li>
              <li>{t('effects.identity')}</li>
            </ul>
            <SettingsGroup>
              <SettingsRow label={t('typeKeyword', { keyword })} htmlFor="delete-account-confirm">
                <Input id="delete-account-confirm" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" />
              </SettingsRow>
              <StepUpFields
                idPrefix="delete-account"
                mfa={mfa}
                identity
                password={password}
                onPassword={setPassword}
                code={code}
                onCode={setCode}
              />
              <GroupError error={error} />
            </SettingsGroup>
          </div>
          <SheetFooter>
            <Button variant="destructive" className="min-h-11" onClick={submit} disabled={busy || confirmText.trim() !== keyword}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {t('confirm')}
            </Button>
            <Button variant="ghost" className="min-h-11" onClick={() => setOpen(false)} disabled={busy}>{t('back')}</Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </SettingsGroup>
  );
}
