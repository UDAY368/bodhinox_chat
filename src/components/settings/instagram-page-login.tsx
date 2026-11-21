'use client';

/**
 * Settings > Instagram > "Connect through a Facebook Page" (Stage 4, 4E). Shown only
 * when the status says pageLoginAvailable (INSTAGRAM_PAGE_LOGIN_ENABLED and the
 * Facebook app configured). Admins press Continue with Facebook, come back from the
 * callback with ?instagram_pl=select, pick one of the Instagram accounts their Pages
 * link (one row each), and connect it. Its own settings group: Continue with Facebook,
 * then Connect, is the group's one primary action. Disconnecting a connected account
 * lives in the Instagram group's account rows. Everything with a token happens on the
 * server: this card only ever sees ids, usernames and Page names.
 */

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { instagramCall, jsonInit } from '@/components/instagram/comment-rules-editor';
import { Button } from '@/components/ui/button';
import { GroupedListRow } from '@/components/ui/grouped-list';
import { PageLoading } from '@/components/ui/page-loading';
import { SettingsBlock, SettingsGroup } from './settings-row';

const FACEBOOK_PREFIX = 'https://www.facebook.com/';

/** Callback / API error code -> Instagram.pageLogin.errors key (anything else is a generic failure). */
export const PAGE_LOGIN_ERROR_KEYS: Record<string, 'cancelled' | 'expired' | 'failed' | 'permissionMissing' | 'alreadyConnected' | 'planLimit'> = {
  denied: 'cancelled',
  state_mismatch: 'expired',
  signed_out: 'expired',
  instagram_permission_missing: 'permissionMissing',
  account_in_use: 'alreadyConnected',
  limit_reached: 'planLimit',
  feature_unavailable: 'planLimit',
};
export const pageLoginErrorKey = (code: string | null | undefined) => PAGE_LOGIN_ERROR_KEYS[code ?? ''] ?? 'failed';

interface Choice { instagramUserId: string; username: string | null; pageId: string; pageName: string | null }

export function InstagramPageLogin({ canEdit, onConnected }: { canEdit: boolean; onConnected: () => void }) {
  const t = useTranslations('Instagram.pageLogin');
  const searchParams = useSearchParams();
  const [busy, setBusy] = useState<string | null>(null);
  const [choices, setChoices] = useState<Choice[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  const fail = useCallback((code: unknown) => toast.error(t(`errors.${pageLoginErrorKey(typeof code === 'string' ? code : null)}`)), [t]);

  const outcome = searchParams.get('instagram_pl');
  const outcomeCode = searchParams.get('code');
  useEffect(() => {
    if (outcome === 'error') fail(outcomeCode);
  }, [outcome, outcomeCode, fail]);

  const loadChoices = useCallback(async () => {
    setBusy('pages');
    try {
      const { ok, json } = await instagramCall('/api/instagram/page-login/pages', jsonInit('POST', {}));
      if (!ok) return fail(json.error);
      const accounts = Array.isArray(json.accounts) ? (json.accounts as Choice[]) : [];
      setChoices(accounts);
      setPicked(accounts[0]?.instagramUserId ?? null);
    } catch {
      fail(null);
    } finally {
      setBusy(null);
    }
  }, [fail]);

  useEffect(() => {
    if (outcome === 'select' && canEdit) void loadChoices();
  }, [outcome, canEdit, loadChoices]);

  const start = async () => {
    setBusy('start');
    try {
      const { ok, json } = await instagramCall('/api/instagram/page-login/start', jsonInit('POST', {}));
      if (!ok) {
        fail(json.error);
        setBusy(null);
        return;
      }
      if (typeof json.url !== 'string' || !json.url.startsWith(FACEBOOK_PREFIX)) throw new Error('url');
      window.location.assign(json.url);
    } catch {
      fail(null);
      setBusy(null);
    }
  };

  const connect = async (choice: Choice) => {
    setBusy(`connect:${choice.instagramUserId}`);
    try {
      const { ok, json } = await instagramCall('/api/instagram/page-login/connect', jsonInit('POST', { instagramUserId: choice.instagramUserId }));
      if (!ok) return fail(json.error);
      toast.success(t('connected'));
      setChoices(null);
      onConnected();
    } catch {
      fail(null);
    } finally {
      setBusy(null);
    }
  };

  const chosen = choices?.find((c) => c.instagramUserId === picked) ?? null;
  const action = !canEdit ? undefined : choices === null ? (
    <Button type="button" size="sm" className="min-h-11 sm:min-h-8" onClick={() => void start()} disabled={!!busy}>
      {busy === 'start' && <Loader2 className="size-3.5 animate-spin" />}
      {t('button')}
    </Button>
  ) : chosen ? (
    <Button type="button" size="sm" className="min-h-11 sm:min-h-8" onClick={() => void connect(chosen)} disabled={!!busy}>
      {busy === `connect:${chosen.instagramUserId}` && <Loader2 className="size-3.5 animate-spin" />}
      {t('connect')}
    </Button>
  ) : undefined;

  return (
    <SettingsGroup title={t('title')} footer={t('tokenNote')} action={action}>
      {canEdit && choices !== null ? (
        <GroupedListRow title={t('selectTitle')} subtitle={t('selectHelp')} className="[&_.truncate]:whitespace-normal" />
      ) : (
        <GroupedListRow
          title={t('description')}
          subtitle={canEdit ? undefined : t('adminOnly')}
          className="text-subhead [&_.truncate]:whitespace-normal"
        />
      )}
      {canEdit && busy === 'pages' && <SettingsBlock><PageLoading rows={2} /></SettingsBlock>}
      {canEdit && choices?.length === 0 && (
        <GroupedListRow title={<span className="text-muted-foreground">{t('noPages')}</span>} className="[&_.truncate]:whitespace-normal" />
      )}
      {canEdit && choices?.map((choice) => (
        <GroupedListRow
          key={choice.instagramUserId}
          title={t('pageOption', { username: choice.username ? `@${choice.username}` : choice.instagramUserId, page: choice.pageName ?? choice.pageId })}
          selected={choice.instagramUserId === picked}
          onClick={() => setPicked(choice.instagramUserId)}
        />
      ))}
    </SettingsGroup>
  );
}
