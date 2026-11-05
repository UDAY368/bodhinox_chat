// /pricing: active plan prices, monthly and annual, inclusive of GST (the charged
// amount is the invoice total; invoices split the GST out). "Contact us" when
// online billing is not configured or no price is active.

import type { Metadata } from 'next';
import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';

import { loadPublicPlans } from './load';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Marketing.pricing');
  return { title: t('title') };
}

export default async function PricingPage() {
  const t = await getTranslations('Marketing.pricing');
  const format = await getFormatter();
  const plans = await loadPublicPlans();
  const money = (minor: number, currency: string) =>
    format.number(minor / 100, { style: 'currency', currency, maximumFractionDigits: minor % 100 === 0 ? 0 : 2 });
  return (
    <div className="mx-auto max-w-5xl px-4 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">{t('title')}</h1>
      <p className="mt-3 text-muted-foreground">{t('subtitle')}</p>
      {plans.length === 0 ? (
        <div className="mt-10 rounded-xl border border-border bg-card p-6">
          <h2 className="text-lg font-semibold">{t('contactTitle')}</h2>
          <p className="mt-2 text-sm text-muted-foreground">{t('contactBody')}</p>
          <Link href="/signup" className="mt-4 inline-block rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
            {t('contactCta')}
          </Link>
        </div>
      ) : (
        <>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {plans.map((plan) => (
              <div key={plan.id} className="flex flex-col rounded-xl border border-border bg-card p-6" data-testid={`price-${plan.id}`}>
                <h2 className="text-lg font-semibold">{plan.name}</h2>
                {plan.month !== null ? (
                  <p className="mt-3 text-2xl font-semibold">
                    {money(plan.month, plan.currency)}
                    <span className="text-sm font-normal text-muted-foreground"> {t('perMonth')}</span>
                  </p>
                ) : null}
                {plan.year !== null ? (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t('annual', { price: money(plan.year, plan.currency) })}
                  </p>
                ) : null}
                <Link href="/signup" className="mt-6 rounded-lg border border-border px-4 py-2 text-center text-sm font-medium hover:bg-muted">
                  {t('cta')}
                </Link>
              </div>
            ))}
          </div>
          <p className="mt-6 text-sm text-muted-foreground">{t('gstNote')}</p>
        </>
      )}
      <p className="mt-4 text-sm text-muted-foreground">
        {t.rich('limitsNote', { link: (chunks) => <Link href="/help#billing" className="text-primary underline">{chunks}</Link> })}
      </p>
    </div>
  );
}
