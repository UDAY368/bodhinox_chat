'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2, KeyRound } from 'lucide-react';

import { createClient } from '@/lib/data/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { PasswordRequirements } from '@/components/auth/password-requirements';
import { MIN_PASSWORD_LENGTH, meetsPasswordRequirements } from '@/lib/auth/password-policy';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { SettingsGroup, SettingsRow } from './settings-row';

const MIN_PASSWORD = MIN_PASSWORD_LENGTH;

export function PasswordForm() {
  const t = useTranslations('Settings.profile');
  const { profile } = useAuth();
  const db = createClient();
  const router = useRouter();

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile?.email) {
      toast.error(t('cannotChangeNoEmail'));
      return;
    }
    if (!meetsPasswordRequirements(next)) {
      setConfirmError(t('passwordTooShort', { min: MIN_PASSWORD }));
      return;
    }
    if (next !== confirm) {
      setConfirmError(t('passwordMismatch'));
      return;
    }
    setConfirmError(null);
    setSaving(true);

    try {
      const { error: updateError } = await db.auth.updateUser({
        password: next,
        currentPassword: current,
        mfaCode: mfaCode.trim() || undefined,
      });
      if (updateError) {
        toast.error(t('passwordUpdateFailed', { message: updateError.message }));
        return;
      }

      setCurrent('');
      setNext('');
      setConfirm('');
      toast.success(t('passwordUpdated'));
      router.replace('/login');
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('unknownError');
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={onSubmit}>
      <SettingsGroup
        title={<><KeyRound className="size-4 text-primary" />{t('passwordTitle')}</>}
        footer={<><p>{t('passwordDesc', { min: MIN_PASSWORD })}</p><PasswordRequirements id="password-requirements" /></>}
        action={
          <Button type="submit" size="sm" className="min-h-11 sm:min-h-8" disabled={saving || !current || !next || !confirm}>
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t('updating')}
              </>
            ) : (
              t('updatePassword')
            )}
          </Button>
        }
      >
        <SettingsRow label={t('currentPassword')} htmlFor="current-password">
          <PasswordInput
            id="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
            disabled={saving}
            required
          />
        </SettingsRow>
        <SettingsRow label="Authenticator or recovery code (if enabled)" htmlFor="password-mfa">
          <Input id="password-mfa" value={mfaCode} onChange={event => setMfaCode(event.target.value)} autoComplete="one-time-code" disabled={saving} />
        </SettingsRow>
        <SettingsRow label={t('newPassword')} htmlFor="new-password">
          <PasswordInput
            id="new-password"
            aria-describedby="password-requirements"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
            minLength={MIN_PASSWORD}
            disabled={saving}
            required
          />
        </SettingsRow>
        <SettingsRow label={t('confirmPassword')} htmlFor="confirm-password" error={confirmError} errorId="confirm-password-error">
          <PasswordInput
            id="confirm-password"
            aria-describedby={confirmError ? 'confirm-password-error' : undefined}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            minLength={MIN_PASSWORD}
            disabled={saving}
            required
          />
        </SettingsRow>
      </SettingsGroup>
    </form>
  );
}
