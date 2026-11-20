'use client';

// Settings › Needs review (admins and owners): sends whose outcome is uncertain, from
// GET /api/needs-review. Each row says what it was and links to its contact and chat; the admin
// checks the chat and picks "Was sent" or "Send again" (POST /api/needs-review/[id]/resolve).
// "Send again" asks first: if the first message did arrive, the customer gets it twice.
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { CircleCheck } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { GroupedList, GroupedListRow } from '@/components/ui/grouped-list';
import { InlineError } from '@/components/ui/inline-error';
import { PageLoading } from '@/components/ui/page-loading';
import { authFetch } from '@/lib/auth/client';
import { formatDate } from '@/lib/format/date';
import type { NeedsReviewItem, NeedsReviewPage } from '@/lib/needs-review/review';
import { SettingsPanelHead } from './settings-panel-head';

export function NeedsReviewPanel({ onCountChange }: { onCountChange?: (count: number) => void }) {
  const t = useTranslations('NeedsReview');
  const locale = useLocale();
  const confirm = useConfirm();
  const [items, setItems] = useState<NeedsReviewItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (target: number) => {
    setFailed(false);
    try {
      const res = await authFetch(`/api/needs-review?page=${target}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as NeedsReviewPage;
      // A later page is merged by id: rows resolved meanwhile shift the pages.
      setItems((current) => {
        if (target === 0 || !current) return data.items;
        const seen = new Set(current.map((row) => row.id));
        return [...current, ...data.items.filter((row) => !seen.has(row.id))];
      });
      setTotal(data.total);
      setPageSize(data.page_size);
      onCountChange?.(data.total);
    } catch {
      setFailed(true);
    }
  }, [onCountChange]);

  useEffect(() => {
    // Fetches on mount; state is set after the response arrives.
    void load(0);
  }, [load]);

  async function resolve(item: NeedsReviewItem, action: 'was_sent' | 'send_again') {
    if (action === 'send_again') {
      const ok = await confirm(item.can_send_again
        ? { title: t('confirmSendTitle'), body: t('confirmSendBody'), confirmLabel: t('sendAgain'), destructive: true }
        : { title: t('confirmNotSentTitle'), body: t('confirmNotSentBody'), confirmLabel: t('markNotSent'), destructive: true });
      if (!ok) return;
    }
    setBusy(item.id);
    try {
      const res = await authFetch(`/api/needs-review/${encodeURIComponent(item.id)}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (res.status === 404 || res.status === 409) toast.info(t('gone'));
      else if (!res.ok) throw new Error(String(res.status));
      else {
        const result = (await res.json()) as { requeued: boolean };
        toast.success(action === 'was_sent' ? t('doneSent')
          : item.kind === 'campaign' ? t('doneCampaign')
            : result.requeued ? t('doneQueued') : t('doneCleared'));
      }
      // Off the list either way (resolved now, or by someone else).
      setItems((current) => current?.filter((row) => row.id !== item.id) ?? current);
      setTotal((n) => {
        const next = Math.max(0, n - 1);
        onCountChange?.(next);
        return next;
      });
    } catch {
      toast.error(t('actionFailed'));
    } finally {
      setBusy(null);
    }
  }

  const next = () => void load(Math.floor((items?.length ?? 0) / pageSize));
  const head = <SettingsPanelHead title={t('title')} description={t('subtitle')} />;
  if (failed && !items) return <div>{head}<InlineError message={t('failed')} onRetry={() => void load(0)} /></div>;
  if (!items) return <div>{head}<PageLoading rows={4} /></div>;
  if (!items.length) return <div>{head}<EmptyState icon={CircleCheck} title={t('empty')} body={t('emptyBody')} /></div>;

  return (
    <div>
      {head}
      <GroupedList header={t('count', { count: total })}>
        {items.map((item) => (
          <GroupedListRow
            key={item.id}
            title={t(`kinds.${item.kind}`)}
            subtitle={
              <span className="flex flex-wrap items-center gap-x-2">
                <span>{t(`reasons.${item.reason}`)}</span>
                <span aria-hidden>·</span>
                <span>{formatDate(item.created_at, { style: 'datetime', locale })}</span>
                {item.contact ? (
                  <>
                    <span aria-hidden>·</span>
                    <Link className="text-primary hover:underline" href={`/contacts/${encodeURIComponent(item.contact.id)}`}>
                      {item.contact.name || t('unnamed')}
                    </Link>
                  </>
                ) : null}
                {item.conversation_id ? (
                  <>
                    <span aria-hidden>·</span>
                    <Link className="text-primary hover:underline" href={`/inbox?c=${encodeURIComponent(item.conversation_id)}`}>
                      {t('openChat')}
                    </Link>
                  </>
                ) : null}
              </span>
            }
            trailing={
              <span className="flex shrink-0 items-center gap-2">
                <Button size="sm" variant="outline" disabled={busy === item.id} onClick={() => void resolve(item, 'send_again')}>
                  {item.can_send_again ? t('sendAgain') : t('markNotSent')}
                </Button>
                <Button size="sm" disabled={busy === item.id} onClick={() => void resolve(item, 'was_sent')}>
                  {t('wasSent')}
                </Button>
              </span>
            }
          />
        ))}
      </GroupedList>
      {items.length < total && (
        <div className="mt-4 flex justify-center">
          {failed ? (
            <InlineError message={t('failed')} onRetry={next} />
          ) : (
            <Button variant="ghost" onClick={next}>{t('loadMore')}</Button>
          )}
        </div>
      )}
    </div>
  );
}
