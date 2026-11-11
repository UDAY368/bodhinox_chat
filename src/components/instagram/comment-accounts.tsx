'use client';

// The body of Instagram › Comments (/instagram/comments): each live Instagram
// account with its comment-reply rules. Admins edit the rules of an account
// that has the comments permission; members see a read-only note; an account
// without the permission links to Settings › Instagram. Pure rendering from
// GET /api/instagram/status, so the page and its tests share it.

import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { CommentRulesEditor } from '@/components/instagram/comment-rules-editor';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { channelSettingsPath } from '@/lib/channels/routes';
import type { InstagramAccountView } from '@/lib/instagram/connection';

/** GET /api/instagram/status. */
export type InstagramStatus =
  | { enabled: false; reason: 'flag_off' | 'not_configured'; accounts: [] }
  | { enabled: true; accounts: InstagramAccountView[] };

const linkClass = 'text-primary font-medium underline-offset-2 hover:underline';

export function InstagramCommentAccounts({ status, failed, canEdit, onRetry }: {
  status: InstagramStatus | null;
  failed: boolean;
  canEdit: boolean;
  onRetry: () => void;
}) {
  const t = useTranslations('Settings.instagram');
  const tChannels = useTranslations('Channels.settings');
  const accounts = status?.enabled ? status.accounts.filter((a) => a.status !== 'disconnected') : [];

  return (
    <>
      {failed && (
        <div className="flex items-center gap-3 text-sm">
          <p className="text-destructive">{t('loadFailed')}</p>
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>{t('retry')}</Button>
        </div>
      )}
      {!status && !failed && <Loader2 className="text-muted-foreground size-4 animate-spin" aria-label={t('loading')} />}
      {status && !status.enabled && (
        <p className="text-muted-foreground text-sm">
          {status.reason === 'not_configured' ? t('reasonNotConfigured') : t('reasonFlagOff')}
        </p>
      )}
      {status?.enabled && accounts.length === 0 && (
        <p className="text-muted-foreground text-sm">
          {t('noAccounts')}
          {canEdit && <>{' '}<Link href={channelSettingsPath('instagram')} className={linkClass}>{t('connect')}</Link></>}
        </p>
      )}
      {status?.enabled && accounts.length > 0 && !canEdit && (
        <p className="text-muted-foreground text-xs">{t('memberReadOnly')}</p>
      )}

      {accounts.map((account) => {
        const commentsReady = account.missingScopes.comments.length === 0;
        const handle = account.username ? `@${account.username}` : account.name ?? account.igUserId;
        return (
          <Card key={account.id} data-instagram-account={account.id}>
            <CardHeader>
              <CardTitle className="text-base">{handle}</CardTitle>
            </CardHeader>
            <CardContent>
              {!commentsReady ? (
                <p className="text-muted-foreground text-sm">
                  {t('commentsNotEnabled')}
                  {canEdit && <>{' · '}<Link href={channelSettingsPath('instagram')} className={linkClass}>{tChannels('manage')}</Link></>}
                </p>
              ) : canEdit ? (
                <CommentRulesEditor accountId={account.id} />
              ) : (
                <p className="text-muted-foreground text-sm">{t('commentsAvailable')}</p>
              )}
            </CardContent>
          </Card>
        );
      })}
    </>
  );
}
