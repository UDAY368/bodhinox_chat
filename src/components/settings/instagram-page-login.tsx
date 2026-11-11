'use client';

/**
 * Settings > Instagram > "Connect through a Facebook Page" (Stage 4, 4E). Shown only
 * when the status says pageLoginAvailable (INSTAGRAM_PAGE_LOGIN_ENABLED and the
 * Facebook app configured). Admins press Continue with Facebook, come back from the
 * callback with ?instagram_pl=select, pick one of the Instagram accounts their Pages
 * link, and connect it. Everything with a token happens on the server: this card
 * only ever sees ids, usernames and Page names.
 */

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { instagramCall, jsonInit } from '@/components/instagram/comment-rules-editor';
import { Button } from '@/components/ui/button';

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
      setChoices(Array.isArray(json.accounts) ? (json.accounts as Choice[]) : []);
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

  return (
    <div className="space-y-3 border-t pt-4">
      <div className="space-y-1">
        <p className="text-foreground text-sm font-medium">{t('title')}</p>
        <p className="text-muted-foreground text-xs">{t('description')}</p>
      </div>
      {!canEdit && <p className="text-muted-foreground text-xs">{t('adminOnly')}</p>}
      {canEdit && choices === null && (
        <Button type="button" variant="outline" onClick={() => void start()} disabled={!!busy}>
          {busy === 'start' && <Loader2 className="size-3.5 animate-spin" />}
          {t('button')}
        </Button>
      )}
      {canEdit && busy === 'pages' && <Loader2 className="text-muted-foreground size-4 animate-spin" aria-hidden="true" />}
      {canEdit && choices !== null && (
        <div className="space-y-2">
          <p className="text-foreground text-sm font-medium">{t('selectTitle')}</p>
          <p className="text-muted-foreground text-xs">{t('selectHelp')}</p>
          {choices.length === 0 && <p className="text-muted-foreground text-sm">{t('noPages')}</p>}
          {choices.map((choice) => (
            <div key={choice.instagramUserId} className="border-border flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm">
              <span className="text-foreground">
                {t('pageOption', { username: choice.username ? `@${choice.username}` : choice.instagramUserId, page: choice.pageName ?? choice.pageId })}
              </span>
              <Button type="button" size="sm" className="ml-auto" onClick={() => void connect(choice)} disabled={!!busy}>
                {busy === `connect:${choice.instagramUserId}` && <Loader2 className="size-3.5 animate-spin" />}
                {t('connect')}
              </Button>
            </div>
          ))}
        </div>
      )}
      <p className="text-muted-foreground text-xs">{t('tokenNote')}</p>
    </div>
  );
}
