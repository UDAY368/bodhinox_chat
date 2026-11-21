'use client';

// The body of Instagram › Comments (/instagram/comments): each live Instagram
// account with its comment-reply rules. Admins edit the rules of an account
// that has the comments permission; members see a read-only note; an account
// without the permission links to Settings › Instagram. Pure rendering from
// GET /api/instagram/status, so the page and its tests share it.
// Apple's way (b7): each account is a titled section (no card around the
// rules' grouped list); loading, empty and failed use the shared states.

import Link from 'next/link';
import { AtSign } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { CommentRulesEditor } from '@/components/instagram/comment-rules-editor';
import { buttonVariants } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { InlineError } from '@/components/ui/inline-error';
import { PageLoading } from '@/components/ui/page-loading';
import { channelSettingsPath } from '@/lib/channels/routes';
import type { InstagramAccountView } from '@/lib/instagram/connection';

/** GET /api/instagram/status. */
export type InstagramStatus =
  | { enabled: false; reason: 'flag_off' | 'not_configured'; accounts: [] }
  | { enabled: true; accounts: InstagramAccountView[] };

const linkClass = 'text-primary font-medium underline-offset-2 hover:underline';

/** An account's display handle: @username, else its name, else its Instagram id. */
export const accountHandle = (account: InstagramAccountView): string =>
  account.username ? `@${account.username}` : account.name ?? account.igUserId;

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
      {failed && <InlineError message={t('loadFailed')} onRetry={onRetry} />}
      {!status && !failed && <PageLoading rows={3} />}
      {status && !status.enabled && (
        <p className="text-muted-foreground text-sm">
          {status.reason === 'not_configured' ? t('reasonNotConfigured') : t('reasonFlagOff')}
        </p>
      )}
      {status?.enabled && accounts.length === 0 && (
        <EmptyState icon={AtSign} title={t('noAccounts')}
          action={canEdit ? <Link href={channelSettingsPath('instagram')} className={buttonVariants({ className: 'min-h-11 sm:min-h-8' })}>{t('connect')}</Link> : undefined} />
      )}
      {status?.enabled && accounts.length > 0 && !canEdit && (
        <p className="text-muted-foreground text-xs">{t('memberReadOnly')}</p>
      )}

      {accounts.map((account) => {
        const commentsReady = account.missingScopes.comments.length === 0;
        return (
          <section key={account.id} data-instagram-account={account.id} className="space-y-2" aria-label={accountHandle(account)}>
            <h3 className="text-foreground px-1 text-sm font-semibold">{accountHandle(account)}</h3>
            {!commentsReady ? (
              <p className="text-muted-foreground px-1 text-sm">
                {t('commentsNotEnabled')}
                {canEdit && <>{' · '}<Link href={channelSettingsPath('instagram')} className={linkClass}>{tChannels('manage')}</Link></>}
              </p>
            ) : canEdit ? (
              <CommentRulesEditor accountId={account.id} />
            ) : (
              <p className="text-muted-foreground px-1 text-sm">{t('commentsAvailable')}</p>
            )}
          </section>
        );
      })}
    </>
  );
}
