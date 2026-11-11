'use client';

/**
 * Settings -> Connections: the Google Sheets card (Stage 5, 5G). States: not
 * available on this server (GOOGLE_SHEETS_ENABLED or the OAuth client
 * missing), not connected (Connect), connected (the Google account's email,
 * Disconnect) and needs attention (the grant was withdrawn). Members see the
 * status; admins connect and disconnect. No token ever reaches the browser.
 */

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { FileSpreadsheet, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { authFetch } from '@/lib/auth/client';
import type { SheetsConnectionDto } from '@/lib/integrations/google-sheets/connection';

/** ?google_sheets=<outcome> values the callback can send, and refusal codes of the routes. */
export const SHEETS_OUTCOMES = [
  'denied', 'signed_out', 'forbidden', 'save_failed', 'not_enabled', 'invalid_state', 'auth', 'missing_scopes',
  'no_refresh_token', 'no_email', 'provider_unreachable',
] as const;

export function GoogleSheetsCard({ canEdit }: { canEdit: boolean }) {
  const t = useTranslations('Integrations.googleSheets');
  const searchParams = useSearchParams();
  const [state, setState] = useState<SheetsConnectionDto | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const errorText = useCallback((code: unknown) => typeof code === 'string' && (SHEETS_OUTCOMES as readonly string[]).includes(code)
    ? t(`errors.${code}`) : t('errors.generic'), [t]);

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      const res = await authFetch('/api/integrations/google-sheets', { cache: 'no-store' });
      if (!res.ok) throw new Error();
      setState(await res.json());
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const outcome = searchParams.get('google_sheets');
  useEffect(() => {
    if (!outcome) return;
    if (outcome === 'connected') toast.success(t('connected'));
    else if ((SHEETS_OUTCOMES as readonly string[]).includes(outcome)) toast.error(t(`errors.${outcome}`));
  }, [outcome, t]);

  const connect = async () => {
    setBusy(true);
    try {
      const res = await authFetch('/api/integrations/google-sheets/connect', { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || typeof json.url !== 'string') throw new Error(errorText(json.code));
      window.location.assign(json.url);
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t('errors.generic'));
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!window.confirm(t('disconnectConfirm'))) return;
    setBusy(true);
    try {
      const res = await authFetch('/api/integrations/google-sheets', { method: 'DELETE' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(errorText(json.code));
      setState(json);
      toast.success(t('disconnected'));
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t('errors.generic'));
    } finally {
      setBusy(false);
    }
  };

  const needsAttention = state?.status === 'error' || state?.status === 'revoked';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileSpreadsheet className="size-4" aria-hidden="true" /> {t('title')}
          {state?.connected && <Badge variant="secondary">{t('statusConnected')}</Badge>}
          {needsAttention && <Badge variant="outline">{t('statusAttention')}</Badge>}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {loadFailed && (
          <div className="flex items-center gap-3">
            <p className="text-destructive">{t('loadFailed')}</p>
            <Button type="button" size="sm" variant="outline" onClick={() => void load()}>{t('retry')}</Button>
          </div>
        )}
        {!state && !loadFailed && <Loader2 className="text-muted-foreground size-4 animate-spin" aria-label={t('loading')} />}
        {state && !state.available && <p className="text-muted-foreground">{t('notEnabled')}</p>}
        {state && state.available && (
          <>
            {state.connected && state.google_email && <p>{t('connectedAs', { email: state.google_email })}</p>}
            {needsAttention && <p className="text-destructive">{t('error')}</p>}
            {!canEdit && <p className="text-muted-foreground">{t('readOnly')}</p>}
            {canEdit && (
              <div className="flex flex-wrap gap-2">
                {!state.connected && (
                  <Button type="button" onClick={() => void connect()} disabled={busy}>
                    {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
                    {t('connect')}
                  </Button>
                )}
                {(state.connected || needsAttention) && (
                  <Button type="button" variant="outline" onClick={() => void disconnect()} disabled={busy}>{t('disconnect')}</Button>
                )}
              </div>
            )}
          </>
        )}
        {/* A connection stored while the integration was switched off can still be removed. */}
        {state && !state.available && state.status && canEdit && (
          <Button type="button" variant="outline" size="sm" onClick={() => void disconnect()} disabled={busy}>{t('disconnect')}</Button>
        )}
      </CardContent>
    </Card>
  );
}
