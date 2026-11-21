'use client';

// Instagram › Ref links (Stage 3): the https://ig.me/m/<username>?ref=<key>
// links of the workspace's ref link flows, to copy and share. A link is made by
// creating an "ig_ref" flow (its trigger lists the keys); the list is read from
// GET /api/instagram/ref-links. The Instagram section layout already explains a
// channel that is off or not available; connection stays in Settings.
// Apple's way (b7): one large title with "New link" top right, a grouped
// list, the shared loading, empty and failed states.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Copy, Link2, Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { createInstagramFlow } from '@/components/instagram/use-instagram-flows';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { GroupedList } from '@/components/ui/grouped-list';
import { InlineError } from '@/components/ui/inline-error';
import { PageHeader } from '@/components/ui/page-header';
import { PageLoading } from '@/components/ui/page-loading';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { authFetch } from '@/lib/auth/client';
import { channelPath } from '@/lib/channels/routes';
import type { RefLinkRow } from '@/lib/instagram/ref-link-list';

export default function InstagramRefLinksPage() {
  const t = useTranslations('Instagram.refLinks');
  const tSettings = useTranslations('Settings.instagram');
  const router = useRouter();
  const { accountId } = useAuth();
  const canCreate = useCan('send-messages');
  const [links, setLinks] = useState<RefLinkRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const res = await authFetch('/api/instagram/ref-links', { cache: 'no-store' });
      if (!res.ok) throw new Error('load');
      const json = (await res.json()) as { links?: RefLinkRow[] };
      setLinks(json.links ?? []);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    if (!accountId) return;
    setLinks(null);
    void load();
  }, [accountId, load]);

  const newLink = async () => {
    if (creating) return;
    setCreating(true);
    try {
      // The keys are typed in the flow's trigger; a new flow starts with none.
      const id = await createInstagramFlow(t('newLink'), 'ig_ref', { refs: [] });
      if (!id) {
        toast.error(tSettings('errors.generic'));
        return;
      }
      router.push(channelPath('instagram', 'flows', id));
    } catch {
      toast.error(tSettings('errors.generic'));
    } finally {
      setCreating(false);
    }
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t('copied'));
    } catch {
      toast.error(t('copyFailed'));
    }
  };

  return (
    <div>
      <PageHeader
        title={t('title')}
        subtitle={t('description')}
        primaryAction={canCreate ? (
          <Button type="button" onClick={() => void newLink()} disabled={creating}>
            {creating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            {t('newLink')}
          </Button>
        ) : undefined}
      />
      {failed && <InlineError message={t('loadFailed')} onRetry={() => void load()} />}
      {!links && !failed && <PageLoading rows={3} />}
      {links?.length === 0 && <EmptyState icon={Link2} title={t('empty')} />}
      {!!links?.length && (
        <GroupedList header={t('link')}>
              {links.map((row) => (
                <div key={`${row.flowId}:${row.instagramAccountId}:${row.key}`}
                  className="not-first:border-separator space-y-1 px-4 py-3 text-sm not-first:border-t">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Link href={channelPath('instagram', 'flows', row.flowId)}
                      className="text-foreground inline-flex min-h-11 min-w-0 items-center truncate font-medium hover:underline sm:min-h-0">
                      {row.flowName}
                    </Link>
                    {row.flowStatus === 'draft' && <Badge variant="secondary">{t('draft')}</Badge>}
                  </div>
                  <p className="text-muted-foreground text-xs">
                    {t('key')}: <span className="text-foreground font-mono">{row.key}</span>
                    {row.username ? <> · {t('account')}: @{row.username}</> : null}
                  </p>
                  {row.url ? (
                    <div className="flex items-center gap-2">
                      <code className="bg-muted min-w-0 flex-1 truncate rounded px-2 py-1 text-xs">{row.url}</code>
                      <Button type="button" variant="outline" className="min-h-11 sm:min-h-8" onClick={() => void copy(row.url!)}>
                        <Copy className="size-3.5" />
                        {t('copy')}
                      </Button>
                    </div>
                  ) : (
                    <p className="text-muted-foreground text-xs">{t('noUsername')}</p>
                  )}
                </div>
              ))}
        </GroupedList>
      )}
    </div>
  );
}
