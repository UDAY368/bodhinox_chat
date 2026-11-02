'use client';

// Settings → Plan & usage → Billing: subscription status, plan picker with
// Razorpay Checkout, add-ons, GST billing profile and invoices. When a
// scheduled downgrade (or a cancellation to Free) would not fit what the
// workspace uses, admins are asked what stays active (DowngradeDialog). The server decides
// everything (role, plan, payment state); this only shows it and sends requests.
// Hidden behind a message while platform billing is not configured.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { authFetch } from '@/lib/auth/client';
import { invalidatePlan } from '@/lib/billing/client';
import { AddOnsCard } from './add-ons-card';
import { BillingProfileForm } from './billing-profile-form';
import { DowngradeDialog, type DowngradeOverviewView } from './downgrade-dialog';
import { InvoicesTable } from './invoices-table';
import { openInNewTab } from './open-tab';
import { PlanPicker } from './plan-picker';
import { openCheckout, type CheckoutSession } from './razorpay-checkout';
import { SubscriptionCard } from './subscription-card';
import type { BillingOverview, BillingProfileView, Interval, InvoiceRow, PlanPrice } from './types';

const POLL_MS = 3_000;
const POLL_LIMIT = 20;

async function getJson<T>(url: string): Promise<T> {
  const res = await authFetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(String(res.status));
  return res.json() as Promise<T>;
}

async function post(url: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await authFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

export function BillingSection() {
  const t = useTranslations('Billing');
  const [overview, setOverview] = useState<BillingOverview | null>(null);
  const [prices, setPrices] = useState<PlanPrice[]>([]);
  const [profile, setProfile] = useState<BillingProfileView | null>(null);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [failed, setFailed] = useState(false);
  const [busyPlan, setBusyPlan] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<'cancel' | 'pay' | null>(null);
  const [confirming, setConfirming] = useState(false);
  /** The plan a scheduled change moves to, when what the workspace uses exceeds its limits. */
  const [overLimit, setOverLimit] = useState<{ planName: string; chosen: boolean } | null>(null);
  const [downgradeOpen, setDowngradeOpen] = useState(false);
  /** The provider's payment page, shown as a link when the browser blocked the tab (or Checkout could not load). */
  const [payLink, setPayLink] = useState<string | null>(null);
  const live = useRef(true);

  /** Asks the server whether a scheduled downgrade exceeds the target plan; opens the dialog when `open` and it does. */
  const checkDowngrade = useCallback(async (o: BillingOverview, open = false) => {
    const sub = o.subscription;
    if (!o.can_manage || !sub || (!sub.scheduledPlan && !sub.cancelAtPeriodEnd)) {
      if (live.current) setOverLimit(null);
      return;
    }
    const view = await getJson<DowngradeOverviewView>('/api/billing/downgrade-plan').catch(() => null);
    if (!live.current) return;
    const exceeds = !!view?.pending && view.kinds.some((k) => k.limit !== null && k.excess > 0);
    setOverLimit(exceeds && view ? { planName: view.plan.name, chosen: view.selection !== null } : null);
    if (exceeds && open && !view?.selection) setDowngradeOpen(true);
  }, []);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const o = await getJson<BillingOverview>('/api/billing/subscription');
      const [p, prof, inv] = o.configured ? await Promise.all([
        getJson<{ prices: PlanPrice[] }>('/api/billing/prices'),
        o.can_manage ? getJson<{ profile: BillingProfileView | null }>('/api/billing/profile') : Promise.resolve({ profile: null }),
        o.can_manage ? getJson<{ invoices: InvoiceRow[] }>('/api/billing/invoices') : Promise.resolve({ invoices: [] }),
      ]) : [{ prices: [] }, { profile: null }, { invoices: [] }];
      if (!live.current) return;
      // Set together, so the profile form mounts with the saved profile.
      setPrices(p.prices);
      setProfile(prof.profile);
      setInvoices(inv.invoices);
      setOverview(o);
      return o;
    } catch {
      if (live.current) setFailed(true);
      return null;
    }
  }, []);

  useEffect(() => {
    live.current = true;
    void load().then((o) => { if (o) void checkDowngrade(o); });
    return () => { live.current = false; };
  }, [load, checkDowngrade]);

  /** After Checkout: the plan changes only when the provider's webhook arrives, so poll for it. */
  const awaitConfirmation = async (plan: string) => {
    setConfirming(true);
    for (let i = 0; i < POLL_LIMIT && live.current; i++) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const o = await getJson<BillingOverview>('/api/billing/subscription').catch(() => null);
      if (o?.subscription?.managed && o.subscription.plan === plan && ['active', 'trialing'].includes(o.subscription.status)) {
        toast.success(t('toasts.activated'));
        // Entitlements are cached per page; reload so every panel shows the new plan.
        window.location.reload();
        return;
      }
    }
    if (live.current) {
      setConfirming(false);
      toast.message(t('toasts.confirmingLater'));
      void load();
    }
  };

  const choose = async (plan: string, interval: Interval, mode: 'subscribe' | 'change') => {
    if (mode === 'subscribe' && !profile) {
      toast.error(t('toasts.profileFirst'));
      document.getElementById('billing-profile')?.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    setBusyPlan(`${plan}:${interval}`);
    try {
      if (mode === 'change') {
        const { status, json } = await post('/api/billing/subscription', { action: 'change_plan', plan, interval });
        if (status >= 400) throw new Error(typeof json.error === 'string' ? json.error : t('toasts.failed'));
        toast.success(json.state === 'scheduled' ? t('toasts.scheduled') : json.state === 'pending' ? t('toasts.pending') : t('toasts.changed'));
        if (json.state === 'done') window.location.reload();
        else {
          const o = await load();
          // A downgrade was scheduled: ask now what stays active if the new plan is smaller than what is in use.
          if (o && json.state === 'scheduled') await checkDowngrade(o, true);
        }
        return;
      }
      const { status, json } = await post('/api/billing/checkout', { plan, interval });
      if (status >= 400) throw new Error(typeof json.error === 'string' ? json.error : t('toasts.failed'));
      if (json.state === 'pending') {
        toast.message(t('toasts.pending'));
        await load();
        return;
      }
      const outcome = await openCheckout(json as unknown as CheckoutSession, { name: t('checkout.name'), description: t('checkout.description') });
      if (outcome === 'dismissed') return;
      if (typeof outcome === 'object') {
        setPayLink(outcome.redirect);
        toast.message(t('payLink.checkoutFallback'));
      }
      await awaitConfirmation(plan);
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t('toasts.failed'));
    } finally {
      setBusyPlan(null);
    }
  };

  const cancel = async () => {
    if (!window.confirm(t('confirmCancel'))) return;
    setBusyAction('cancel');
    try {
      const { status, json } = await post('/api/billing/subscription', { action: 'cancel' });
      if (status >= 400) throw new Error(typeof json.error === 'string' ? json.error : t('toasts.failed'));
      toast.success(json.state === 'pending' ? t('toasts.pending') : t('toasts.cancelled'));
      // Cancelled at once (e.g. while past due): the plan above shows Free now.
      if (json.state === 'done') invalidatePlan();
      const o = await load();
      if (o && json.state === 'scheduled') await checkDowngrade(o, true);
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t('toasts.failed'));
    } finally {
      setBusyAction(null);
    }
  };

  /** Runs inside the click: the tab opens before the request, so popup blockers allow it. */
  const pay = async () => {
    setBusyAction('pay');
    setPayLink(null);
    try {
      const { opened, url } = await openInNewTab(async () => {
        const { status, json } = await post('/api/billing/subscription', { action: 'resume' });
        if (status >= 400 || typeof json.short_url !== 'string' || !json.short_url.startsWith('https://'))
          throw new Error(typeof json.error === 'string' ? json.error : t('toasts.failed'));
        return json.short_url;
      });
      if (!opened) {
        setPayLink(url);
        toast.message(t('payLink.blocked'));
      }
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t('toasts.failed'));
    } finally {
      setBusyAction(null);
    }
  };

  if (failed)
    return (
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        {t('loadFailed')}
        <Button variant="outline" size="sm" onClick={() => void load()}>{t('retry')}</Button>
      </div>
    );
  if (!overview) return <Loader2 className="size-5 animate-spin text-primary" />;
  if (!overview.configured)
    return (
      <Card data-testid="billing-unavailable">
        <CardContent className="py-4 text-sm text-muted-foreground">{t('notConfigured')}</CardContent>
      </Card>
    );

  return (
    <div className="space-y-4" data-testid="billing-section">
      <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
      <SubscriptionCard overview={overview} busy={busyAction} onCancel={cancel} onPay={pay} />
      {payLink && (
        <Card data-testid="billing-pay-link">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4 text-sm">
            <span className="text-foreground">{t('payLink.hint')}</span>
            <a className="font-medium text-primary hover:underline" href={payLink} target="_blank" rel="noopener noreferrer">{t('payLink.open')}</a>
          </CardContent>
        </Card>
      )}
      {overview.can_manage && overLimit && (
        <Card data-testid="downgrade-notice" className="border-amber-500/30 bg-amber-500/5">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4 text-sm">
            <span className="text-foreground">{t(overLimit.chosen ? 'downgrade.chosen' : 'downgrade.notice', { plan: overLimit.planName })}</span>
            <Button variant="outline" size="sm" onClick={() => setDowngradeOpen(true)}>{t(overLimit.chosen ? 'downgrade.change' : 'downgrade.choose')}</Button>
          </CardContent>
        </Card>
      )}
      {confirming && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="size-4 animate-spin" />{t('confirming')}
        </div>
      )}
      <PlanPicker prices={prices} subscription={overview.subscription} canManage={overview.can_manage} busyPlan={busyPlan} onChoose={choose} />
      {overview.can_manage && (
        <>
          <AddOnsCard onChanged={() => { invalidatePlan(); void load(); }} />
          <div id="billing-profile"><BillingProfileForm profile={profile} onSaved={setProfile} /></div>
          <InvoicesTable invoices={invoices} />
          <DowngradeDialog open={downgradeOpen} onOpenChange={setDowngradeOpen} onSaved={() => { if (overview) void checkDowngrade(overview); }} />
        </>
      )}
    </div>
  );
}
