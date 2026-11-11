'use client';

// Instagram › Ref links (Stage 3): the https://ig.me/m/<username>?ref=<key>
// links of the workspace's ref link flows, to copy and share. A link is made by
// creating an "ig_ref" flow (its trigger lists the keys); the list is read from
// GET /api/instagram/ref-links. The Instagram section layout already explains a
// channel that is off or not available; connection stays in Settings.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Copy, Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { createInstagramFlow } from '@/components/instagram/use-instagram-flows';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
    <div className="space-y-6">
      <div>
        <h1 className="text-foreground text-2xl font-bold tracking-tight">{t('title')}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{t('description')}</p>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
          <CardTitle className="text-base">{t('link')}</CardTitle>
          {canCreate && (
            <Button type="button" size="sm" onClick={() => void newLink()} disabled={creating}>
              {creating ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
              {t('newLink')}
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-2">
          {failed && (
            <div className="flex items-center gap-3 text-sm">
              <p className="text-destructive">{t('loadFailed')}</p>
              <Button type="button" variant="outline" size="sm" onClick={() => void load()}>{tSettings('retry')}</Button>
            </div>
          )}
          {!links && !failed && <Loader2 className="text-muted-foreground size-4 animate-spin" aria-label={tSettings('loading')} />}
          {links?.length === 0 && <p className="text-muted-foreground text-sm">{t('empty')}</p>}
          {!!links?.length && (
            <ul className="divide-y">
              {links.map((row) => (
                <li key={`${row.flowId}:${row.instagramAccountId}:${row.key}`} className="space-y-1 py-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Link href={channelPath('instagram', 'flows', row.flowId)} className="text-foreground min-w-0 truncate font-medium hover:underline">
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
                      <Button type="button" variant="outline" size="sm" onClick={() => void copy(row.url!)}>
                        <Copy className="size-3.5" />
                        {t('copy')}
                      </Button>
                    </div>
                  ) : (
                    <p className="text-muted-foreground text-xs">{t('noUsername')}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
