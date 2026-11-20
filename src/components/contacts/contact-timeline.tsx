'use client';

// A contact's activity from the event feed: orders, payments, bookings, form answers and deal
// moves, newest first, 30 at a time from GET /api/contacts/[id]/timeline (a viewer gets no order
// or payment events). One line per event with its time; "Show more" follows the cursor. It
// re-reads its first page when the chat's + menu records something for this contact.
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import {
  CalendarCheck, CalendarClock, CalendarX, ClipboardCheck, CreditCard, GitBranch, PackageCheck, ShoppingBag,
  ShoppingCart, Truck, Undo2, UserX, type LucideIcon,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { authFetch } from '@/lib/auth/client';
import type { DomainEventType } from '@/lib/events/types';
import type { TimelineItem, TimelinePage } from '@/lib/events/timeline';
import { formatMajor, formatMoney } from '@/lib/format/money';
import { CONTACT_RECORDS_CHANGED } from '@/lib/inbox/panel-reload';
import { cn } from '@/lib/utils';
import { formatWhen } from './format';

const ICONS: Record<DomainEventType, LucideIcon> = {
  'order.created': ShoppingBag,
  'order.paid': CreditCard,
  'order.shipped': Truck,
  'order.delivered': PackageCheck,
  'order.returned': Undo2,
  'payment.received': CreditCard,
  'form.submitted': ClipboardCheck,
  'deal.stage_changed': GitBranch,
  'cart.abandoned': ShoppingCart,
  'appointment.booked': CalendarCheck,
  'appointment.cancelled': CalendarX,
  'appointment.rescheduled': CalendarClock,
  'appointment.completed': CalendarCheck,
  'appointment.no_show': UserX,
};

const text = (value: unknown) => (typeof value === 'string' ? value : '');
const num = (value: unknown) => (typeof value === 'number' ? value : null);

export function ContactTimeline({ contactId, className, titleClassName }: { contactId: string; className?: string; titleClassName?: string }) {
  const t = useTranslations('Contacts.activity');
  const tDates = useTranslations('Contacts.redesign');
  const locale = useLocale();
  const [events, setEvents] = useState<TimelineItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async (after: string | null) => {
    setFailed(false);
    if (after) setLoadingMore(true);
    try {
      const query = after ? `?cursor=${encodeURIComponent(after)}` : '';
      const res = await authFetch(`/api/contacts/${encodeURIComponent(contactId)}/timeline${query}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const page = (await res.json()) as TimelinePage;
      setEvents((current) => (after && current ? [...current, ...page.events] : page.events));
      setCursor(page.next_cursor);
    } catch {
      setFailed(true);
    } finally {
      setLoadingMore(false);
    }
  }, [contactId]);

  useEffect(() => {
    // Fetches on mount; state is set after the response arrives.
    void load(null);
    const onChanged = (event: Event) => {
      if ((event as CustomEvent<{ contactId?: string }>).detail?.contactId === contactId) void load(null);
    };
    window.addEventListener(CONTACT_RECORDS_CHANGED, onChanged);
    return () => window.removeEventListener(CONTACT_RECORDS_CHANGED, onChanged);
  }, [load, contactId]);

  /** One line for an event, from its type and its ids-and-amounts data. */
  function describe(event: TimelineItem): string {
    const d = event.data;
    switch (event.type) {
      case 'payment.received': {
        const amount = formatMoney(num(d.amount_minor), text(d.currency));
        return amount ? t('events.payment_received_amount', { amount }) : t('events.payment_received');
      }
      case 'order.created': {
        const amount = formatMoney(num(d.total_minor), text(d.currency));
        return amount ? t('events.order_created_amount', { amount }) : t('events.order_created');
      }
      case 'deal.stage_changed': {
        const stage = text(d.stage_name);
        const value = formatMajor(num(d.value), text(d.currency));
        if (stage && value) return t('events.deal_stage_changed_value', { stage, value });
        return stage ? t('events.deal_stage_changed_named', { stage }) : t('events.deal_stage_changed');
      }
      case 'appointment.booked':
      case 'appointment.cancelled':
      case 'appointment.rescheduled':
      case 'appointment.completed':
      case 'appointment.no_show': {
        const service = text(d.service_name);
        const key = event.type.replace('.', '_');
        return service ? t(`events.${key}_named`, { service }) : t(`events.${key}`);
      }
      default:
        return t(`events.${event.type.replace('.', '_')}`);
    }
  }

  const orderHref = (event: TimelineItem) => {
    const orderId = text(event.data.order_id);
    return event.type.startsWith('order.') && orderId ? `/commerce/orders/${encodeURIComponent(orderId)}` : null;
  };

  return (
    <section className={className} aria-labelledby="ct-activity">
      <h2 id="ct-activity" className={cn(titleClassName, 'mb-3')}>{t('title')}</h2>
      {failed && !events ? (
        <div role="alert" className="text-[13px] text-muted-foreground">
          {t('failed')}{' '}
          <Button variant="link" size="sm" className="h-auto p-0" onClick={() => void load(null)}>{t('retry')}</Button>
        </div>
      ) : !events ? (
        <div aria-hidden className="space-y-3">
          <div className="h-9 animate-pulse rounded-lg bg-muted" />
          <div className="h-9 animate-pulse rounded-lg bg-muted" />
        </div>
      ) : events.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">{t('empty')}</p>
      ) : (
        <>
          <ul className="flex flex-col gap-3">
            {events.map((event) => {
              const Icon = ICONS[event.type] ?? ShoppingBag;
              const href = orderHref(event);
              const line = describe(event);
              return (
                <li key={event.id} className="flex items-start gap-2.5">
                  <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                    <Icon className="size-3.5" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-[13px] text-foreground [overflow-wrap:anywhere]">
                      {href ? <Link href={href} className="hover:underline">{line}</Link> : line}
                    </p>
                    <small className="text-xs text-muted-foreground">{formatWhen(event.occurred_at, locale, tDates)}</small>
                  </div>
                </li>
              );
            })}
          </ul>
          {failed && (
            <div role="alert" className="mt-3 text-[13px] text-muted-foreground">
              {t('failed')}{' '}
              <Button variant="link" size="sm" className="h-auto p-0" onClick={() => void load(cursor)}>{t('retry')}</Button>
            </div>
          )}
          {cursor && !failed && (
            <button type="button" disabled={loadingMore} onClick={() => void load(cursor)}
              className="mt-3 min-h-11 rounded-md text-[13px] font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60 sm:min-h-0">
              {t('loadMore')}
            </button>
          )}
        </>
      )}
    </section>
  );
}
