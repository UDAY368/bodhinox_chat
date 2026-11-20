'use client';

/**
 * Booking sheet parts (Batch 3): the payment state with a link to Payments and,
 * for a cancelled paid booking, "Refund this payment" — the existing payments
 * RefundDialog (admins with commerce.refunds; the server checks again). The
 * cancel and the refund are two separate recorded actions; nothing is refunded
 * automatically. And the deal link: show, link (the customer's open deals,
 * paged search) and unlink.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { GroupedList, GroupedListRow } from '@/components/ui/grouped-list';
import { Input } from '@/components/ui/input';
import { RefundDialog } from '@/components/commerce/payments/refund-dialog';
import type { CustomerPaymentItem } from '@/components/commerce/payments/customer-payments-api';
import { useCan } from '@/hooks/use-can';
import { formatMoney } from '@/lib/format/money';
import { apiRequest, paymentStateKey, refundOffered, useFailureText, type Abilities } from './shared';

export function PaymentSection({
  appointment, abilities, locale, onChanged,
}: {
  appointment: { id: string; status: string; payment_status?: string | null };
  abilities: Abilities;
  locale: string;
  onChanged: () => void;
}) {
  const t = useTranslations('Appointments.payment');
  const failureText = useFailureText();
  const canRefund = useCan('edit-settings');
  const [payments, setPayments] = useState<CustomerPaymentItem[] | null>(null);
  const [refunding, setRefunding] = useState<CustomerPaymentItem | null>(null);
  const state = paymentStateKey(appointment.payment_status);

  const load = useCallback(async () => {
    // Payments are read by agents and above; a viewer sees the state words only.
    if (!abilities.manage || !state) return;
    const r = await apiRequest<{ payments: CustomerPaymentItem[] }>(`/api/payments/customer-payments?appointment_id=${appointment.id}&limit=5`);
    setPayments(r.ok ? r.data.payments ?? [] : []);
  }, [abilities.manage, appointment.id, state]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load, appointment.status, appointment.payment_status]);

  if (!state) return null;
  const payment = payments?.find((p) => p.status === 'captured') ?? null;
  const offer = refundOffered(appointment, payment, canRefund);

  async function recorded(refundId: string) {
    const r = await apiRequest(`/api/appointments/${appointment.id}`, { method: 'PATCH', body: { action: 'refund_requested', refund_id: refundId } });
    if (!r.ok) toast.error(failureText(r));
    void load();
    onChanged();
  }

  return (
    <section className="space-y-2" data-testid="appointment-payment">
      <GroupedList header={t('title')}>
        <GroupedListRow title={t(state)}
          subtitle={payment ? formatMoney(payment.amount_minor, payment.currency, { locale }) : undefined}
          trailing={abilities.manage ? <Link className="text-primary hover:underline" href="/commerce/payments">{t('open')}</Link> : undefined} />
      </GroupedList>
      {offer && payment && (
        <div className="space-y-2 rounded-group border border-separator p-3">
          <p className="text-footnote text-muted-foreground">{t('refundHelp')}</p>
          <Button type="button" size="sm" variant="outline" onClick={() => setRefunding(payment)}>{t('refundThis')}</Button>
        </div>
      )}
      <RefundDialog payment={refunding} open={!!refunding} onOpenChange={(v) => { if (!v) setRefunding(null); }}
        onRequested={(id) => void recorded(id)} />
    </section>
  );
}

interface DealOption { id: string; title: string; status: string | null; stage_name: string | null }

export function DealSection({
  appointmentId, deal, canManage, onChanged,
}: {
  appointmentId: string;
  deal: DealOption | null;
  canManage: boolean;
  onChanged: () => void;
}) {
  const t = useTranslations('Appointments.deal');
  const tA = useTranslations('Appointments');
  const failureText = useFailureText();
  const confirm = useConfirm();
  const [picking, setPicking] = useState(false);
  const [q, setQ] = useState('');
  const [options, setOptions] = useState<DealOption[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const search = useCallback(async (term: string, after: string | null) => {
    const params = new URLSearchParams();
    if (term.trim()) params.set('q', term.trim());
    if (after) params.set('after', after);
    const r = await apiRequest<{ deals: DealOption[]; next: string | null }>(`/api/appointments/${appointmentId}/deals?${params}`);
    if (!r.ok) return void toast.error(failureText(r));
    setOptions((prev) => (after ? [...(prev ?? []), ...r.data.deals] : r.data.deals));
    setNext(r.data.next);
  }, [appointmentId, failureText]);

  useEffect(() => {
    if (!picking) return;
    const timer = setTimeout(() => void search(q, null), 250);
    return () => clearTimeout(timer);
  }, [picking, q, search]);

  async function set(dealId: string | null) {
    if (dealId === null && !(await confirm({ title: t('unlinkConfirm'), confirmLabel: t('unlink'), destructive: true }))) return;
    setBusy(true);
    const r = await apiRequest(`/api/appointments/${appointmentId}`, { method: 'PATCH', body: { action: 'deal', deal_id: dealId } });
    setBusy(false);
    if (!r.ok) return void toast.error(failureText(r));
    toast.success(dealId ? t('linked') : t('unlinked'));
    setPicking(false);
    onChanged();
  }

  return (
    <section className="space-y-2" data-testid="appointment-deal">
      <GroupedList header={t('title')}>
        {deal
          ? <GroupedListRow title={deal.title} subtitle={deal.stage_name ?? undefined} href="/pipelines" />
          : <GroupedListRow title={<span className="text-muted-foreground">{t('none')}</span>} />}
      </GroupedList>
      {canManage && !picking && (
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setPicking(true)}>{t('link')}</Button>
          {deal && <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void set(null)}>{t('unlink')}</Button>}
        </div>
      )}
      {picking && (
        <div className="space-y-2">
          <Input aria-label={t('search')} placeholder={t('search')} value={q} maxLength={100} onChange={(e) => setQ(e.target.value)} />
          {options && options.length === 0 && <p className="text-footnote text-muted-foreground">{t('empty')}</p>}
          {options && options.length > 0 && (
            <GroupedList>
              {options.map((d) => (
                <GroupedListRow key={d.id} title={d.title} subtitle={d.stage_name ?? undefined} selected={d.id === deal?.id}
                  onClick={() => { if (!busy) void set(d.id); }} />
              ))}
            </GroupedList>
          )}
          <div className="flex gap-2">
            {next && <Button type="button" size="sm" variant="ghost" onClick={() => void search(q, next)}>{t('loadMore')}</Button>}
            <Button type="button" size="sm" variant="ghost" onClick={() => setPicking(false)}>{tA('sheet.close')}</Button>
          </div>
        </div>
      )}
    </section>
  );
}
