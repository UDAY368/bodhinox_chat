'use client';

// Shared pieces of the Privacy & access cards: the re-confirmation fields
// (password and/or authenticator code, shown only when they apply) and a JSON
// request helper that returns the server's error code for translation.

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { authFetch } from '@/lib/auth/client';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { SettingsBlock, SettingsRow } from '../settings-row';

export interface MfaState {
  /** The user has a verified authenticator (a code is required). */
  enabled: boolean;
  /** The user has a password of their own (false for a Google-only account). */
  passwordSet: boolean;
}

/** The caller's MFA and password state; null while loading or when it could not be read. */
export function useMfaState(): MfaState | null {
  const [state, setState] = useState<MfaState | null>(null);
  useEffect(() => {
    let live = true;
    authFetch('/api/auth/mfa', { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<{ enabled?: unknown; passwordSet?: unknown }>) : null))
      .then((body) => {
        if (live && body) setState({ enabled: body.enabled === true, passwordSet: body.passwordSet !== false });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return state;
}

export interface ActionResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  code: string | null;
  message: string | null;
}

/** A same-origin JSON request with CSRF headers; never throws. */
export async function sendJson<T = Record<string, unknown>>(url: string, method: string, body?: unknown): Promise<ActionResult<T>> {
  try {
    const response = await authFetch(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await response.json().catch(() => null)) as (T & { error?: unknown; code?: unknown }) | null;
    if (response.ok) return { ok: true, status: response.status, data, code: null, message: null };
    const error = data?.error as unknown;
    const nested = error && typeof error === 'object' ? (error as { code?: unknown; message?: unknown }) : null;
    const code = typeof data?.code === 'string' ? data.code : typeof nested?.code === 'string' ? nested.code : null;
    const message = typeof error === 'string' ? error : typeof nested?.message === 'string' ? nested.message : null;
    return { ok: false, status: response.status, data: null, code, message };
  } catch {
    return { ok: false, status: 0, data: null, code: 'network', message: null };
  }
}

/** An error line inside a group. */
export function GroupError({ error }: { error: string | null }) {
  return error ? <SettingsBlock className="py-3"><p role="alert" className="text-sm text-destructive">{error}</p></SettingsBlock> : null;
}

/** The translated text for a failed action (falls back to the server's message, then a generic one). */
export function useActionError() {
  const t = useTranslations('Settings.privacy.errors');
  return (result: Pick<ActionResult<unknown>, 'code' | 'message'>): string => {
    if (result.code && t.has(result.code)) return t(result.code);
    return result.message ?? t('generic');
  };
}

/**
 * Password (when `identity` and the user has one) and authenticator code (when the
 * user has MFA) inputs. Google-only accounts re-confirm by signing in with Google
 * again; the server answers google_reauth_required and the card shows that text.
 * Renders settings rows, so place it directly inside a SettingsGroup.
 */
export function StepUpFields({
  idPrefix,
  mfa,
  identity,
  password,
  onPassword,
  code,
  onCode,
}: {
  idPrefix: string;
  mfa: MfaState | null;
  identity: boolean;
  password: string;
  onPassword: (value: string) => void;
  code: string;
  onCode: (value: string) => void;
}) {
  const t = useTranslations('Settings.privacy.stepUp');
  const showPassword = identity && (mfa?.passwordSet ?? true);
  return (
    <>
      {showPassword ? (
        <SettingsRow label={t('password')} htmlFor={`${idPrefix}-password`}>
          <PasswordInput
            id={`${idPrefix}-password`}
            autoComplete="current-password"
            value={password}
            onChange={(e) => onPassword(e.target.value)}
          />
        </SettingsRow>
      ) : null}
      {mfa?.enabled ? (
        <SettingsRow label={t('code')} htmlFor={`${idPrefix}-code`}>
          <Input
            id={`${idPrefix}-code`}
            inputMode="text"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => onCode(e.target.value.trim())}
            placeholder={t('codePlaceholder')}
          />
        </SettingsRow>
      ) : null}
      {identity && mfa && !mfa.passwordSet ? (
        <SettingsBlock className="py-3 text-xs text-muted-foreground">{t('googleHint')}</SettingsBlock>
      ) : null}
    </>
  );
}
