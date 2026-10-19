'use client';

import { PasswordForm } from './password-form';
import { SessionsCard } from './sessions-card';
import { SettingsPanelHead } from './settings-panel-head';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { useAuth } from '@/hooks/use-auth';
import { authFetch } from '@/lib/auth/client';
import { Button } from '@/components/ui/button';

/**
 * "Login & security" section — groups the former Profile-tab password
 * and active-sessions cards into their own dedicated home.
 */
export function SecurityPanel() {
  const t = useTranslations('Settings.security');
  const emailText = useTranslations('PasswordInput');
  const { accountRole } = useAuth();
  const [testingEmail, setTestingEmail] = useState(false);
  const [emailResult, setEmailResult] = useState('');
  return (
    <section className="max-w-2xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
      />
      <div className="space-y-4">
        <PasswordForm />
        <SessionsCard />
        {accountRole === 'owner' && <div className="space-y-2 rounded-lg border p-4">
          <p className="text-sm text-muted-foreground">{emailText('deliveryHint')}</p>
          <Button variant="outline" disabled={testingEmail} onClick={async () => {
            setTestingEmail(true);
            setEmailResult('');
            try {
              const response = await authFetch('/api/auth/email-test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
              const result = await response.json();
              setEmailResult(response.ok ? emailText('deliveryAccepted') : result.error?.message ?? emailText('deliveryFailed'));
            } catch { setEmailResult(emailText('deliveryFailed')); }
            finally { setTestingEmail(false); }
          }}>{testingEmail ? emailText('deliveryTesting') : emailText('deliveryTest')}</Button>
          {emailResult && <p role="status" className="text-sm">{emailResult}</p>}
        </div>}
        <Link href="/mfa" className="inline-flex rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted">Manage two-step verification and recovery codes</Link>
      </div>
    </section>
  );
}
