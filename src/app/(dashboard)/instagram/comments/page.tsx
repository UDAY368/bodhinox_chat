'use client';

// Instagram › Comments (Stage 1): the comment-reply rules of each connected
// Instagram account, moved here from Settings › Instagram with the same data
// and API. The Instagram section layout already explains a channel that is
// off or not available. Rules are admin-only on the server; members see the
// accounts and a read-only note. Connection and health stay in Settings.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { CommentRulesEditor, instagramCall } from '@/components/instagram/comment-rules-editor';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { channelSettingsPath } from '@/lib/channels/routes';
import type { InstagramAccountView } from '@/lib/instagram/connection';

type Status =
  | { enabled: false; reason: 'flag_off' | 'not_configured'; accounts: [] }
  | { enabled: true; accounts: InstagramAccountView[] };

const linkClass = 'text-primary font-medium underline-offset-2 hover:underline';

export default function InstagramCommentsPage() {
  const t = useTranslations('Settings.instagram');
  const tRules = useTranslations('Settings.instagram.commentRules');
  const tChannels = useTranslations('Channels.settings');
  const { accountId } = useAuth();
  const canEdit = useCan('edit-settings');
  const [status, setStatus] = useState<Status | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const { ok, json } = await instagramCall('/api/instagram/status');
      if (!ok) throw new Error('load');
      setStatus(json as unknown as Status);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    if (!accountId) return;
    setStatus(null);
    void load();
  }, [accountId, load]);

  const accounts = status?.enabled ? status.accounts.filter((a) => a.status !== 'disconnected') : [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-foreground text-2xl font-bold tracking-tight">{tRules('title')}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{tRules('help')}</p>
      </div>

      {failed && (
        <div className="flex items-center gap-3 text-sm">
          <p className="text-destructive">{t('loadFailed')}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => void load()}>{t('retry')}</Button>
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
    </div>
  );
}
