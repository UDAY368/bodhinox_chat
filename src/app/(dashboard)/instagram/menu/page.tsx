'use client';

// Instagram › Menu (Stage 3, 3D): each connected Instagram account's
// persistent menu, up to 20 items that each start an Instagram flow or open a
// link. Admins edit and publish it to Instagram; members see it read-only. An
// account without the messages permission links to Settings › Instagram.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { InstagramStatus } from '@/components/instagram/comment-accounts';
import { instagramCall } from '@/components/instagram/comment-rules-editor';
import { PersistentMenuEditor } from '@/components/instagram/persistent-menu-editor';
import { useInstagramFlows } from '@/components/instagram/use-instagram-flows';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { channelSettingsPath } from '@/lib/channels/routes';

const linkClass = 'text-primary font-medium underline-offset-2 hover:underline';

export default function InstagramMenuPage() {
  const t = useTranslations('Instagram.menu');
  const ts = useTranslations('Instagram.starters');
  const tSettings = useTranslations('Settings.instagram');
  const tChannels = useTranslations('Channels.settings');
  const { accountId } = useAuth();
  const canEdit = useCan('edit-settings');
  const [status, setStatus] = useState<InstagramStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const { flows, failed: flowsFailed, reload: reloadFlows } = useInstagramFlows();
  const usableFlows = flows?.filter((f) => f.status !== 'archived') ?? null;

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const { ok, json } = await instagramCall('/api/instagram/status');
      if (!ok) throw new Error('load');
      setStatus(json as unknown as InstagramStatus);
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
  const retry = () => { void load(); void reloadFlows(); };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-foreground text-2xl font-bold tracking-tight">{t('title')}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{t('description')}</p>
      </div>
      {(failed || flowsFailed) && (
        <div className="flex items-center gap-3 text-sm">
          <p className="text-destructive">{tSettings('loadFailed')}</p>
          <Button type="button" variant="outline" size="sm" onClick={retry}>{tSettings('retry')}</Button>
        </div>
      )}
      {(!status || !usableFlows) && !failed && !flowsFailed && (
        <Loader2 className="text-muted-foreground size-4 animate-spin" aria-label={tSettings('loading')} />
      )}
      {status && !status.enabled && (
        <p className="text-muted-foreground text-sm">
          {status.reason === 'not_configured' ? tSettings('reasonNotConfigured') : tSettings('reasonFlagOff')}
        </p>
      )}
      {status?.enabled && accounts.length === 0 && (
        <p className="text-muted-foreground text-sm">
          {ts('notConnected')}
          {canEdit && <>{' '}<Link href={channelSettingsPath('instagram')} className={linkClass}>{tSettings('connect')}</Link></>}
        </p>
      )}
      {usableFlows && accounts.map((account) => {
        const handle = account.username ? `@${account.username}` : account.name ?? account.igUserId;
        const dmReady = account.missingScopes.dm.length === 0;
        return (
          <Card key={account.id} data-instagram-account={account.id}>
            <CardHeader>
              <CardTitle className="text-base">{handle}</CardTitle>
            </CardHeader>
            <CardContent>
              {dmReady ? (
                <PersistentMenuEditor accountId={account.id} flows={usableFlows} canEdit={canEdit} />
              ) : (
                <p className="text-muted-foreground text-sm">
                  {tSettings('badgePermission')}
                  {canEdit && <>{' · '}<Link href={channelSettingsPath('instagram')} className={linkClass}>{tChannels('manage')}</Link></>}
                </p>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
