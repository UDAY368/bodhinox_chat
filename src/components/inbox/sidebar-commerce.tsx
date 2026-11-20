'use client';

// The chat side panel's Orders, Payments and Deals: the newest few of each with
// a count and "See all" (the contact's profile), every row opening its record.
// Data comes from GET /api/contacts/[id]/summary in one round trip; orders and
// payments are null for a viewer, and their blocks are then left out.
import { orderRef } from '@/lib/commerce/order-state';
import Link from 'next/link';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { ChevronRight } from 'lucide-react';

import { formatMoney } from '@/lib/commerce/money';
import type { ContactCommerceSummary } from '@/lib/contacts/commerce-summary';
import { authFetch } from '@/lib/auth/client';

export async function loadContactSummary(contactId: string): Promise<ContactCommerceSummary> {
  const res = await authFetch(`/api/contacts/${encodeURIComponent(contactId)}/summary`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`summary ${res.status}`);
  return (await res.json()) as ContactCommerceSummary;
}

const ROW = 'hover:bg-muted flex min-h-11 items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50';
const SUMMARY = 'studio-sec-summary flex h-9 cursor-pointer list-none items-center gap-2 text-[13px] font-semibold';
const COUNT = 'bg-muted text-muted-foreground rounded-full px-1.5 text-[11px] font-semibold tabular-nums';

function Section({ title, count, empty, seeAll, children }: {
  title: string; count: number; empty: string; seeAll: string; children: React.ReactNode;
}) {
  const t = useTranslations('Inbox.sidebar');
  return (
    <details open={count > 0}>
      <summary className={SUMMARY}>
        <h3>{title}</h3>
        <span className={COUNT}>{count}</span>
      </summary>
      {count > 0 ? (
        <ul className="mt-1 space-y-0.5">
          {children}
          {/* The panel shows the newest few; the profile lists them all. */}
          <li>
            <Link href={seeAll} className="text-primary inline-flex min-h-11 items-center gap-1 px-2 text-[12px] font-semibold hover:underline">
              {t('seeAll', { count })}
            </Link>
          </li>
        </ul>
      ) : (
        <p className="text-muted-foreground mt-1 text-xs">{empty}</p>
      )}
    </details>
  );
}

export function SidebarCommerce({ contactId, summary }: { contactId: string; summary: ContactCommerceSummary }) {
  const t = useTranslations('Inbox.sidebar');
  const tOrder = useTranslations('Commerce.orders.statuses');
  const tPay = useTranslations('Payments.customer.statuses');
  const tDeal = useTranslations('Pipelines.card');
  const locale = useLocale();
  const format = useFormatter();
  const profile = `/contacts/${encodeURIComponent(contactId)}`;
  const money = (minor: number, currency: string) => {
    try {
      return formatMoney(minor, currency, locale);
    } catch {
      return `${currency} ${minor}`;
    }
  };
  const dealValue = (value: number, currency: string | null) => {
    try {
      return currency ? format.number(value, { style: 'currency', currency }) : format.number(value);
    } catch {
      return `${currency ?? ''} ${value}`.trim();
    }
  };
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium' });
  return (
    <>
      {summary.orders && (
        <Section title={t('orders')} count={summary.orders.count} empty={t('noOrders')} seeAll={`${profile}#ct-orders`}>
          {summary.orders.items.map((o) => (
            <li key={o.id}>
              <Link href={`/commerce/orders/${encodeURIComponent(o.id)}`} className={ROW}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{t('orderRef', { ref: orderRef(o) })}</span>
                  <span className="text-muted-foreground block truncate text-[11px]">
                    {[tOrder.has(o.status) ? tOrder(o.status) : o.status, date(o.created_at)].join(' · ')}
                  </span>
                </span>
                <b className="shrink-0 font-semibold tabular-nums">{money(o.total_minor, o.currency)}</b>
                <ChevronRight className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
              </Link>
            </li>
          ))}
        </Section>
      )}
      {summary.payments && (
        <Section title={t('payments')} count={summary.payments.count} empty={t('noPayments')} seeAll={`${profile}#ct-payments`}>
          {summary.payments.items.map((p) => (
            <li key={p.id}>
              {/* A payment has no page of its own: it opens its order, else the payments list. */}
              <Link href={p.order_id ? `/commerce/orders/${encodeURIComponent(p.order_id)}` : '/commerce/payments'} className={ROW}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{tPay.has(p.status) ? tPay(p.status) : p.status}</span>
                  <span className="text-muted-foreground block truncate text-[11px]">{date(p.created_at)}</span>
                </span>
                <b className="shrink-0 font-semibold tabular-nums">{money(p.amount_minor, p.currency)}</b>
                <ChevronRight className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
              </Link>
            </li>
          ))}
        </Section>
      )}
      <Section title={t('deals')} count={summary.deals.count} empty={t('noDeals')} seeAll={`${profile}#ct-deals`}>
        {summary.deals.items.map((d) => (
          <li key={d.id}>
            <Link href={`/pipelines?deal=${encodeURIComponent(d.id)}`} className={ROW}>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{d.title}</span>
                <span className="text-muted-foreground block truncate text-[11px]">
                  {d.status === 'won' || d.status === 'lost' ? tDeal(d.status) : d.stage_name}
                </span>
              </span>
              <b className="shrink-0 font-semibold tabular-nums">{dealValue(d.value, d.currency)}</b>
              <ChevronRight className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
            </Link>
          </li>
        ))}
      </Section>
    </>
  );
}
