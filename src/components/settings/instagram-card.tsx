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
import { AtSign, Loader2, RefreshCw, Unplug } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { instagramCall, jsonInit } from '@/components/instagram/comment-rules-editor';
import { InstagramPageLogin } from '@/components/settings/instagram-page-login';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { InlineError } from '@/components/ui/inline-error';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/hooks/use-auth';
import { hasMinRole } from '@/lib/auth/roles';
import { channelPath } from '@/lib/channels/routes';
import type { InstagramAccountView } from '@/lib/instagram/connection';
import { GroupedListRow } from '@/components/ui/grouped-list';
import { PageLoading } from '@/components/ui/page-loading';
import { cn } from '@/lib/utils';
import { SETTINGS_ROW_HAIRLINE, SettingsBlock, SettingsGroup, SettingsMoreMenu, SettingsSwitchRow } from './settings-row';

type Status =
  | { enabled: false; reason: 'flag_off' | 'not_configured'; accounts: [] }
  | { enabled: true; appId: string; humanAgentEnabled: boolean; pageLoginAvailable?: boolean; accounts: InstagramAccountView[] };

/** ?code= values the callback can send (kept in step with CALLBACK_ERROR_CODES). */
const CALLBACK_CODES = new Set([
  'instagram_not_enabled', 'signed_out', 'forbidden', 'denied', 'state_mismatch', 'invalid_request', 'account_in_use',
  'limit_reached', 'feature_unavailable', 'instagram_token_invalid', 'meta_error', 'save_failed',
]);
const AUTHORIZE_PREFIX = 'https://www.instagram.com/oauth/authorize';
const call = instagramCall;

export function InstagramCard() {
  const t = useTranslations('Settings.instagram');
  const confirm = useConfirm();
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
    if (!(await confirm({ title: t('disconnectConfirm', { username: account.username ?? account.igUserId }), confirmLabel: t('disconnect'), destructive: true }))) return;
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
    <SettingsGroup
      title={<><AtSign className="size-4" aria-hidden="true" /> {t('title')}</>}
      footer={status?.enabled && !canEdit ? <>{t('description')} {t('memberReadOnly')}</> : t('description')}
      action={status?.enabled && canEdit ? (
        <Button type="button" size="sm" className="min-h-11 sm:min-h-8" onClick={() => void connect()} disabled={!!busy}>
          {busy === 'connect' && <Loader2 className="size-3.5 animate-spin" />}
          {busy === 'connect' ? t('connecting') : live.length ? t('connectAnother') : t('connect')}
        </Button>
      ) : undefined}
    >
      {loadFailed && <SettingsBlock><InlineError message={t('loadFailed')} onRetry={() => void load()} /></SettingsBlock>}
      {!status && !loadFailed && <SettingsBlock><PageLoading rows={2} /></SettingsBlock>}

      {status && !status.enabled && (
        <GroupedListRow
          title={t('notEnabled')}
          subtitle={status.reason === 'not_configured' ? t('reasonNotConfigured') : t('reasonFlagOff')}
          className="[&_.truncate]:whitespace-normal"
        />
      )}

      {status?.enabled && (
        <>
          {accounts.length === 0 && <GroupedListRow title={<span className="text-muted-foreground">{t('noAccounts')}</span>} />}
          {accounts.map((account) => (
            <AccountRow key={account.id} account={account} canEdit={canEdit} busy={busy}
              onReconnect={connect} onDisconnect={disconnect} onCheck={checkNow} />
          ))}
          {canEdit && (
            <SettingsSwitchRow
              title={t('includeComments')}
              description={t('includeCommentsHelp')}
              control={<Switch checked={withComments} onCheckedChange={(v: boolean) => setWithComments(v)} disabled={!!busy} aria-label={t('includeComments')} />}
            />
          )}
          {status.pageLoginAvailable && (
            // The Facebook Page login lays out its own form.
            <SettingsBlock><InstagramPageLogin canEdit={canEdit} onConnected={() => void load()} /></SettingsBlock>
          )}
        </>
      )}
    </SettingsGroup>
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
  const tPage = useTranslations('Instagram.pageLogin');
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
    <div className={cn(SETTINGS_ROW_HAIRLINE, 'space-y-3 px-4 py-3')}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-foreground font-medium">{handle}</span>
        {badge}
        {canEdit && (
          // Reconnect is the one primary action; Check now and Disconnect sit in the more menu.
          <div className="ml-auto flex flex-wrap items-center gap-1">
            {busy === `health:${account.id}` && <Loader2 className="text-muted-foreground size-3.5 animate-spin" />}
            {(account.status === 'token_invalid' || account.status === 'permission_missing' || disconnected) && (
              <Button type="button" size="sm" className="min-h-11 sm:min-h-8" onClick={() => void onReconnect()} disabled={!!busy}>
                {disconnected ? t('connect') : t('reconnect')}
              </Button>
            )}
            <SettingsMoreMenu actions={[
              { label: t('checkNow'), icon: RefreshCw, hidden: disconnected, disabled: !!busy, onSelect: () => void onCheck(account) },
              { label: t('disconnect'), icon: Unplug, destructive: true, hidden: disconnected, disabled: !!busy, onSelect: () => void onDisconnect(account) },
            ]} />
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
        {!disconnected && account.connectionKind === 'facebook_page' && (
          <li>{tPage('kindLabel')}: {tPage('kindFacebookPage', { page: account.facebookPageId ?? '' })}</li>
        )}
        {!disconnected && account.connectionKind !== 'facebook_page' && account.accessExpiresAt && <li>{t('tokenExpires', { date: date(account.accessExpiresAt) })}</li>}
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
