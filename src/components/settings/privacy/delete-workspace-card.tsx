'use client';

// Settings -> Privacy & access -> Delete workspace (owner). Requests deletion:
// sending stops at once, nothing is deleted during the 30-day grace period and
// the owner can cancel. Other members see the pending request (read-only).

import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { GroupedListRow } from '@/components/ui/grouped-list';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { GroupError, StepUpFields, sendJson, useActionError, useMfaState } from './step-up';
import { SettingsBlock, SettingsGroup, SettingsRow } from '../settings-row';

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
    <SettingsGroup title={t('title')} footer={t('description')}>
      {closing ? (
        <SettingsBlock className="py-3">
          <p role="status" className="text-sm text-destructive">
            {t('pending', {
              date: lifecycle?.purgeAfter ? format.dateTime(new Date(lifecycle.purgeAfter), { dateStyle: 'long' }) : '-',
            })}
          </p>
        </SettingsBlock>
      ) : null}
      {notice ? <SettingsBlock className="py-3"><p className="text-sm text-muted-foreground">{notice}</p></SettingsBlock> : null}
      {!open ? <GroupError error={error} /> : null}
      {!isOwner ? (
        <SettingsBlock className="py-3"><p className="text-sm text-muted-foreground">{t('ownerOnly')}</p></SettingsBlock>
      ) : closing ? (
        <GroupedListRow
          title={<span className="text-primary">{t('cancel')}</span>}
          trailing={busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : undefined}
          onClick={busy ? undefined : () => void cancel()}
        />
      ) : lifecycle?.status === 'admin_suspended' ? (
        <SettingsBlock className="py-3"><p className="text-sm text-muted-foreground">{t('adminSuspended')}</p></SettingsBlock>
      ) : (
        <GroupedListRow destructive title={t('start')} onClick={() => setOpen(true)} />
      )}
      <Sheet open={open} onOpenChange={(next) => { if (!busy) setOpen(next); }}>
        <SheetContent size="md" className="gap-4 overflow-y-auto">
          <SheetHeader className="pr-12">
            <SheetTitle>{t('title')}</SheetTitle>
            <SheetDescription>{t('description')}</SheetDescription>
          </SheetHeader>
          <div className="space-y-4 px-4">
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              <li>{t('effects.sending')}</li>
              <li>{t('effects.grace')}</li>
              <li>{t('effects.billing')}</li>
              <li>{t('effects.export')}</li>
            </ul>
            <SettingsGroup>
              <SettingsRow label={t('typeName', { name: workspaceName })} htmlFor="delete-workspace-name">
                <Input id="delete-workspace-name" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} autoComplete="off" />
              </SettingsRow>
              <StepUpFields
                idPrefix="delete-workspace"
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
            <Button variant="destructive" className="min-h-11" onClick={submit} disabled={busy || !deletionNameConfirmed(confirmName, workspaceName)}>
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
