'use client';

/**
 * Settings > Instagram (Phase 11, design section 4). Owner: T2.
 *
 * While Instagram is off on this deployment the card only says so, with the
 * reason, and nothing here contacts Instagram. When it is on, each connected
 * account shows its status with the matching action (connected, access
 * expired -> Reconnect, permission missing -> names the feature and scopes,
 * disconnected -> Connect), when a message last arrived, when access expires,
 * whether comment replies are available, how many unsupported events arrived,
 * and (admins, comments granted) a link to the account's comment-reply rules,
 * which live at Instagram › Comments since Stage 1. Members see everything
 * read-only. No token ever reaches the browser.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { AtSign, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { instagramCall, jsonInit } from '@/components/instagram/comment-rules-editor';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/hooks/use-auth';
import { hasMinRole } from '@/lib/auth/roles';
import { channelPath } from '@/lib/channels/routes';
import type { InstagramAccountView } from '@/lib/instagram/connection';

type Status =
  | { enabled: false; reason: 'flag_off' | 'not_configured'; accounts: [] }
  | { enabled: true; appId: string; humanAgentEnabled: boolean; accounts: InstagramAccountView[] };

/** ?code= values the callback can send (kept in step with CALLBACK_ERROR_CODES). */
const CALLBACK_CODES = new Set([
  'instagram_not_enabled', 'signed_out', 'forbidden', 'denied', 'state_mismatch', 'invalid_request', 'account_in_use',
  'limit_reached', 'feature_unavailable', 'instagram_token_invalid', 'meta_error', 'save_failed',
]);
const AUTHORIZE_PREFIX = 'https://www.instagram.com/oauth/authorize';
const call = instagramCall;

export function InstagramCard() {
  const t = useTranslations('Settings.instagram');
  const { accountRole } = useAuth();
  const canEdit = !!accountRole && hasMinRole(accountRole, 'admin');
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<Status | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [withComments, setWithComments] = useState(true);

  const failure = useCallback((json: Record<string, unknown>): void => {
    toast.error(typeof json.message === 'string' ? json.message : t('errors.generic'));
  }, [t]);

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      const { ok, json } = await call('/api/instagram/status');
      if (!ok) throw new Error('load');
      setStatus(json as unknown as Status);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const outcome = searchParams.get('instagram');
  const outcomeCode = searchParams.get('code');
  useEffect(() => {
    if (outcome === 'connected') toast.success(t('connected'));
    else if (outcome === 'error')
      toast.error(outcomeCode && CALLBACK_CODES.has(outcomeCode) ? t(`callbackErrors.${outcomeCode}`) : t('connectFailed'));
  }, [outcome, outcomeCode, t]);

  const connect = async () => {
    setBusy('connect');
    try {
      const { ok, json } = await call('/api/instagram/connect', jsonInit('POST', { comments: withComments }));
      if (!ok) {
        failure(json);
        setBusy(null);
        return;
      }
      if (typeof json.url !== 'string' || !json.url.startsWith(AUTHORIZE_PREFIX)) throw new Error('url');
      window.location.assign(json.url);
    } catch {
      toast.error(t('connectFailed'));
      setBusy(null);
    }
  };

  const replaceAccount = (account: InstagramAccountView) =>
    setStatus((current) => current?.enabled
      ? { ...current, accounts: current.accounts.map((a) => (a.id === account.id ? account : a)) }
      : current);

  const disconnect = async (account: InstagramAccountView) => {
    if (!window.confirm(t('disconnectConfirm', { username: account.username ?? account.igUserId }))) return;
    setBusy(`disconnect:${account.id}`);
    try {
      const { ok, json } = await call(`/api/instagram/accounts/${account.id}`, jsonInit('DELETE'));
      if (!ok) return failure(json);
      replaceAccount(json.account as InstagramAccountView);
      toast.success(t('disconnected'));
    } catch {
      toast.error(t('errors.generic'));
    } finally {
      setBusy(null);
    }
  };

  const checkNow = async (account: InstagramAccountView) => {
    setBusy(`health:${account.id}`);
    try {
      const { ok, json } = await call(`/api/instagram/accounts/${account.id}/health`, jsonInit('POST'));
      if (!ok) return failure(json);
      replaceAccount(json.account as InstagramAccountView);
      toast.success(t('healthChecked'));
    } catch {
      toast.error(t('errors.generic'));
    } finally {
      setBusy(null);
    }
  };

  const accounts = status?.enabled ? status.accounts : [];
  const live = accounts.filter((a) => a.status !== 'disconnected');

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AtSign className="size-4" aria-hidden="true" /> {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {loadFailed && (
          <div className="flex items-center gap-3 text-sm">
            <p className="text-destructive">{t('loadFailed')}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => void load()}>{t('retry')}</Button>
          </div>
        )}
        {!status && !loadFailed && <Loader2 className="text-muted-foreground size-4 animate-spin" aria-label={t('loading')} />}

        {status && !status.enabled && (
          <div className="space-y-1 text-sm">
            <p className="text-foreground font-medium">{t('notEnabled')}</p>
            <p className="text-muted-foreground">
              {status.reason === 'not_configured' ? t('reasonNotConfigured') : t('reasonFlagOff')}
            </p>
          </div>
        )}

        {status?.enabled && (
          <>
            {accounts.length === 0 && <p className="text-muted-foreground text-sm">{t('noAccounts')}</p>}
            {accounts.map((account) => (
              <AccountRow key={account.id} account={account} canEdit={canEdit} busy={busy}
                onReconnect={connect} onDisconnect={disconnect} onCheck={checkNow} />
            ))}
            {!canEdit && <p className="text-muted-foreground text-xs">{t('memberReadOnly')}</p>}
            {canEdit && (
              <div className="space-y-3 border-t pt-4">
                <label className="flex items-start gap-3 text-sm">
                  <Switch checked={withComments} onCheckedChange={(v: boolean) => setWithComments(v)} disabled={!!busy} />
                  <span>
                    <span className="text-foreground block font-medium">{t('includeComments')}</span>
                    <span className="text-muted-foreground block text-xs">{t('includeCommentsHelp')}</span>
                  </span>
                </label>
                <Button type="button" onClick={() => void connect()} disabled={!!busy}>
                  {busy === 'connect' && <Loader2 className="size-3.5 animate-spin" />}
                  {busy === 'connect' ? t('connecting') : live.length ? t('connectAnother') : t('connect')}
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function AccountRow({ account, canEdit, busy, onReconnect, onDisconnect, onCheck }: {
  account: InstagramAccountView;
  canEdit: boolean;
  busy: string | null;
  onReconnect: () => Promise<void>;
  onDisconnect: (account: InstagramAccountView) => Promise<void>;
  onCheck: (account: InstagramAccountView) => Promise<void>;
}) {
  const t = useTranslations('Settings.instagram');
  const tChannels = useTranslations('Channels.settings');
  const handle = account.username ? `@${account.username}` : account.name ?? account.igUserId;
  const disconnected = account.status === 'disconnected';
  const commentsReady = !disconnected && account.missingScopes.comments.length === 0;
  const featureGap = account.missingScopes.dm.length
    ? { feature: t('features.dm'), scopes: account.missingScopes.dm.join(', ') }
    : null;
  const date = (iso: string) => new Date(iso).toLocaleString();

  const badge = account.status === 'active' ? <Badge variant="secondary">{t('statusActive')}</Badge>
    : account.status === 'disconnected' ? <Badge variant="outline">{t('statusDisconnected')}</Badge>
    : <Badge variant="destructive">{account.status === 'token_invalid' ? t('badgeReconnect') : t('badgePermission')}</Badge>;

  return (
    <div className="border-border space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-foreground font-medium">{handle}</span>
        {badge}
        {canEdit && (
          <div className="ml-auto flex flex-wrap gap-2">
            {!disconnected && (
              <Button type="button" variant="outline" size="sm" onClick={() => void onCheck(account)} disabled={!!busy}>
                {busy === `health:${account.id}` && <Loader2 className="size-3.5 animate-spin" />}
                {t('checkNow')}
              </Button>
            )}
            {(account.status === 'token_invalid' || account.status === 'permission_missing' || disconnected) && (
              <Button type="button" size="sm" onClick={() => void onReconnect()} disabled={!!busy}>
                {disconnected ? t('connect') : t('reconnect')}
              </Button>
            )}
            {!disconnected && (
              <Button type="button" variant="outline" size="sm" onClick={() => void onDisconnect(account)} disabled={!!busy}>
                {t('disconnect')}
              </Button>
            )}
          </div>
        )}
      </div>

      <ul className="text-muted-foreground space-y-1 text-sm">
        {account.status === 'token_invalid' && <li className="text-destructive">{t('statusTokenInvalid')}</li>}
        {account.status === 'permission_missing' && featureGap && (
          <li className="text-destructive">{t('statusPermissionMissing', featureGap)}</li>
        )}
        {disconnected && <li>{t('disconnectedHelp')}</li>}
        {!disconnected && (
          <li>{account.lastWebhookAt ? t('lastWebhook', { date: date(account.lastWebhookAt) }) : t('neverReceived')}</li>
        )}
        {!disconnected && account.accessExpiresAt && <li>{t('tokenExpires', { date: date(account.accessExpiresAt) })}</li>}
        {!disconnected && (
          <li>
            {commentsReady ? t('commentsAvailable') : t('commentsNotEnabled')}
            {canEdit && commentsReady && (
              <>
                {' · '}
                <Link href={channelPath('instagram', 'comments')} className="text-primary font-medium underline-offset-2 hover:underline">
                  {tChannels('manage')}
                </Link>
              </>
            )}
          </li>
        )}
        {account.unsupportedEventCount > 0 && <li>{t('unsupportedEvents', { count: account.unsupportedEventCount })}</li>}
      </ul>
    </div>
  );
}
