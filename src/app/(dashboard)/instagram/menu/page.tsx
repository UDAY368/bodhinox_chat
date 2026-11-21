'use client';

// Instagram › Menu (Stage 3, 3D): each connected Instagram account's
// persistent menu, up to 20 items that each start an Instagram flow or open a
// link. Admins edit and publish it to Instagram; members see it read-only. An
// account without the messages permission links to Settings › Instagram.
// Apple's way (b7): one large title, each account a titled section (no card
// around the grouped list), the shared loading, empty and failed states.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AtSign } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { accountHandle, type InstagramStatus } from '@/components/instagram/comment-accounts';
import { instagramCall } from '@/components/instagram/comment-rules-editor';
import { PersistentMenuEditor } from '@/components/instagram/persistent-menu-editor';
import { useInstagramFlows } from '@/components/instagram/use-instagram-flows';
import { buttonVariants } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { InlineError } from '@/components/ui/inline-error';
import { PageHeader } from '@/components/ui/page-header';
import { PageLoading } from '@/components/ui/page-loading';
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
    <div>
      <PageHeader title={t('title')} subtitle={t('description')} />
      <div className="space-y-8">
        {(failed || flowsFailed) && <InlineError message={tSettings('loadFailed')} onRetry={retry} />}
        {(!status || !usableFlows) && !failed && !flowsFailed && <PageLoading rows={3} />}
        {status && !status.enabled && (
          <p className="text-muted-foreground text-sm">
            {status.reason === 'not_configured' ? tSettings('reasonNotConfigured') : tSettings('reasonFlagOff')}
          </p>
        )}
        {status?.enabled && accounts.length === 0 && (
          <EmptyState icon={AtSign} title={ts('notConnected')}
            action={canEdit ? <Link href={channelSettingsPath('instagram')} className={buttonVariants({ className: 'min-h-11 sm:min-h-8' })}>{tSettings('connect')}</Link> : undefined} />
        )}
        {usableFlows && accounts.map((account) => {
          const dmReady = account.missingScopes.dm.length === 0;
          return (
            <section key={account.id} data-instagram-account={account.id} className="space-y-2" aria-label={accountHandle(account)}>
              <h2 className="text-foreground px-1 text-base font-semibold">{accountHandle(account)}</h2>
              {dmReady ? (
                <PersistentMenuEditor accountId={account.id} flows={usableFlows} canEdit={canEdit} />
              ) : (
                <p className="text-muted-foreground px-1 text-sm">
                  {tSettings('badgePermission')}
                  {canEdit && <>{' · '}<Link href={channelSettingsPath('instagram')} className={linkClass}>{tChannels('manage')}</Link></>}
                </p>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
