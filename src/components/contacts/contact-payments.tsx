'use client';

// The contact profile's Payments card: money this contact paid (through their
// orders, payment links or appointments), newest first, ten per page from
// GET /api/contacts/[id]/payments. Agents and above (the page leaves it out
// for a viewer). A payment opens its order, else the payments list.
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { TablePagination } from '@/components/ui/table-pagination';
import { authFetch } from '@/lib/auth/client';
import { formatMoney } from '@/lib/format/money';
import type { SummaryPayment } from '@/lib/contacts/commerce-summary';
import { cn } from '@/lib/utils';
import { formatDay } from './format';

interface PaymentsPage {
  total: number;
  pageSize: number;
  payments: SummaryPayment[];
}

export function ContactPayments({ contactId, className, titleClassName }: { contactId: string; className?: string; titleClassName?: string }) {
  const t = useTranslations('Contacts.redesign.profile');
  const tp = useTranslations('Contacts.page');
  const tPay = useTranslations('Payments.customer.statuses');
  const locale = useLocale();
  const [page, setPage] = useState(0);
  const [result, setResult] = useState<PaymentsPage | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async (target: number) => {
    setFailed(false);
    try {
      const res = await authFetch(`/api/contacts/${encodeURIComponent(contactId)}/payments?page=${target}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      setResult((await res.json()) as PaymentsPage);
    } catch {
      setFailed(true);
    }
  }, [contactId]);

  useEffect(() => {
    // Fetches on page change; state is set after the response arrives.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(page);
  }, [load, page]);

  const money = (minor: number, currency: string) => {
    return formatMoney(minor, currency, { locale });
  };
  const totalPages = result ? Math.max(1, Math.ceil(result.total / result.pageSize)) : 1;

  return (
    <section className={className} aria-labelledby="ct-payments">
      <h2 id="ct-payments" className={cn(titleClassName, 'mb-2')}>{t('payments')}</h2>
      {failed ? (
        <div role="alert" className="text-[13px] text-muted-foreground">
          {t('paymentsFailed')}{' '}
          <Button variant="link" size="sm" className="h-auto p-0" onClick={() => void load(page)}>{t('retry')}</Button>
        </div>
      ) : !result ? (
        <div aria-hidden className="space-y-2">
          <div className="h-10 animate-pulse rounded-lg bg-muted" />
          <div className="h-10 animate-pulse rounded-lg bg-muted" />
        </div>
      ) : result.total === 0 ? (
        <p className="text-[13px] text-muted-foreground">{t('noPayments')}</p>
      ) : (
        <>
          <ul className="-mx-2 flex flex-col gap-0.5">
            {result.payments.map((p) => (
              <li key={p.id}>
                <Link
                  href={p.order_id ? `/commerce/orders/${encodeURIComponent(p.order_id)}` : '/commerce/payments'}
                  className="flex min-h-11 items-center gap-2.5 rounded-lg p-2 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <span className="min-w-0 flex-1">
                    <strong className="block truncate text-[13px] font-semibold text-foreground">{tPay.has(p.status) ? tPay(p.status) : p.status}</strong>
                    <small className="block text-xs text-muted-foreground">{formatDay(p.created_at, locale)}</small>
                  </span>
                  <b className="shrink-0 text-[13px] font-semibold tabular-nums text-foreground">{money(p.amount_minor, p.currency)}</b>
                </Link>
              </li>
            ))}
          </ul>
          {totalPages > 1 && (
            <TablePagination
              className="-mx-4 mt-2 border-t border-border sm:-mx-5"
              page={page}
              totalPages={totalPages}
              onPageChange={setPage}
              summary={tp('showingPagination', {
                start: page * result.pageSize + 1,
                end: Math.min((page + 1) * result.pageSize, result.total),
                total: result.total,
              })}
              labels={{
                nav: tp('paginationLabel'),
                previous: tp('previousPage'),
                next: tp('nextPage'),
                page: (n) => tp('goToPage', { page: n }),
              }}
            />
          )}
        </>
      )}
    </section>
  );
}
