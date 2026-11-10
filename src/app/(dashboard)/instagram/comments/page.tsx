'use client';

// Instagram › Comments (Stage 1): the comment-reply rules of each connected
// Instagram account, moved here from Settings › Instagram with the same data
// and API. The Instagram section layout already explains a channel that is
// off or not available. Rules are admin-only on the server; members see the
// accounts and a read-only note. Connection and health stay in Settings.

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { InstagramCommentAccounts, type InstagramStatus } from '@/components/instagram/comment-accounts';
import { instagramCall } from '@/components/instagram/comment-rules-editor';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';

export default function InstagramCommentsPage() {
  const tRules = useTranslations('Settings.instagram.commentRules');
  const { accountId } = useAuth();
  const canEdit = useCan('edit-settings');
  const [status, setStatus] = useState<InstagramStatus | null>(null);
  const [failed, setFailed] = useState(false);

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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-foreground text-2xl font-bold tracking-tight">{tRules('title')}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{tRules('help')}</p>
      </div>
      <InstagramCommentAccounts status={status} failed={failed} canEdit={canEdit} onRetry={() => void load()} />
    </div>
  );
}
