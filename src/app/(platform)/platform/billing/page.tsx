'use client';

// Console: SaaS billing reconciliation. Items are opened by the worker (a
// webhook event that could not be applied, a provider call still unconfirmed
// after a day, an invoice that could not be issued, a daily provider fetch
// that disagrees with the stored subscription, a workspace using the platform
// Razorpay key for commerce). "Re-fetch from provider" queues the existing
// billing sweep for that workspace (fetch, then apply: safe to repeat); "Mark
// resolved" needs a note. Neither edits a subscription or an intent directly.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { PlatformReconciliationItem } from '@/types/platform';
import { errorCode, platformApi } from '../../_components/platform-api';

const FILTERS = ['open', 'resolved', 'all'] as const;
type Filter = (typeof FILTERS)[number];
const ERRORS = ['note_required', 'not_found', 'no_provider_subscription', 'billing_not_configured', 'invalid_request'] as const;

export default function PlatformBillingPage() {
  const t = useTranslations('Platform.billing');
  const format = useFormatter();
  const [filter, setFilter] = useState<Filter>('open');
  const [items, setItems] = useState<PlatformReconciliationItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback((status: Filter, after: string | null = null) => {
    const query = new URLSearchParams({ status, ...(after ? { cursor: after } : {}) });
    return platformApi<{ items: PlatformReconciliationItem[]; nextCursor: string | null }>(`/api/platform/billing/reconciliation?${query}`).then(
      (page) => {
        setFailed(false);
        setItems((prev) => (after && prev ? [...prev, ...page.items] : page.items));
        setCursor(page.nextCursor);
      },
      () => setFailed(true),
    );
  }, []);
  useEffect(() => {
    void load(filter);
  }, [filter, load]);

  const done = async (text: string) => {
    setMessage(text);
    await load(filter);
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('intro')}</p>
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label={t('filterLabel')}>
        {FILTERS.map((f) => (
          <Button key={f} type="button" size="sm" variant={f === filter ? 'default' : 'outline'} aria-pressed={f === filter} onClick={() => setFilter(f)}>
            {t(`filters.${f}`)}
          </Button>
        ))}
      </div>
      {failed && <p role="status" className="text-sm">{t('loadFailed')}</p>}
      {message && <p role="status" className="text-sm">{message}</p>}
      {items !== null && items.length === 0 && <p className="text-muted-foreground text-sm">{t('empty')}</p>}
      {items !== null && items.length > 0 && (
        <ul className="divide-border divide-y" data-testid="platform-reconciliation">
          {items.map((item) => (
            <ReconciliationRow key={item.id} item={item} when={(v) => format.dateTime(new Date(v), { dateStyle: 'medium', timeStyle: 'short' })}
              onDone={done} onError={(e) => setMessage(t(`errors.${errorCode(e, ERRORS)}`))} />
          ))}
        </ul>
      )}
      {cursor && (
        <div>
          <Button type="button" size="sm" variant="outline" onClick={() => void load(filter, cursor)}>{t('more')}</Button>
        </div>
      )}
    </div>
  );
}

/** Flat key=value text of an item's detail (ids, statuses and amounts only). */
function detailText(detail: Record<string, unknown>): string {
  const flat = (prefix: string, value: unknown): string[] =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => flat(prefix ? `${prefix}.${k}` : k, v))
      : [`${prefix}=${Array.isArray(value) ? value.join(',') : String(value)}`];
  return flat('', detail).join(' ');
}

function ReconciliationRow({ item, when, onDone, onError }: {
  item: PlatformReconciliationItem;
  when: (iso: string) => string;
  onDone: (message: string) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const t = useTranslations('Platform.billing');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  async function act(run: () => Promise<unknown>, success: string) {
    setBusy(true);
    try {
      await run();
      await onDone(success);
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-col gap-2 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Badge variant={item.status === 'open' ? 'default' : 'outline'}>{t(`status.${item.status}`)}</Badge>
        <span className="font-medium">{t(`kinds.${item.kind}`)}</span>
        {item.accountId
          ? <Link href={`/platform/tenants/${item.accountId}`} className="hover:underline">{item.accountName ?? item.accountId}</Link>
          : <span className="text-muted-foreground">{t('noWorkspace')}</span>}
        <span className="text-muted-foreground font-mono text-xs">{item.sourceRef}</span>
        <span className="text-muted-foreground ml-auto text-xs">{t('openedAt', { when: when(item.openedAt) })}</span>
      </div>
      <p className="text-muted-foreground font-mono text-xs break-all">{detailText(item.detail)}</p>
      {item.status === 'resolved' ? (
        <p className="text-muted-foreground text-xs">
          {t('resolvedBy', { email: item.resolvedByEmail ?? '-', when: item.resolvedAt ? when(item.resolvedAt) : '-' })}
          {item.resolutionNote && ` · ${item.resolutionNote}`}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Input aria-label={t('note')} placeholder={t('note')} maxLength={1000} value={note} className="max-w-md" onChange={(e) => setNote(e.target.value)} />
          <Button type="button" size="sm" disabled={busy || note.trim().length < 3}
            onClick={() => void act(() => platformApi(`/api/platform/billing/reconciliation/${item.id}/resolve`, { body: { note: note.trim() } }), t('resolved'))}>
            {t('resolve')}
          </Button>
          {item.accountId && item.kind !== 'shared_razorpay_key' && (
            <Button type="button" size="sm" variant="outline" disabled={busy}
              onClick={() => void act(() => platformApi('/api/platform/billing/refetch', { body: { accountId: item.accountId, reason: `reconciliation ${item.id}` } }),
                t('refetchQueued'))}>
              {t('refetch')}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}
