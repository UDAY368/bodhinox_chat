'use client';

/**
 * Campaign cost from the platform rate card (/api/broadcasts/estimate):
 * CampaignCostEstimate in the wizard's summary, CampaignCostCard on the
 * campaign page (estimated vs actual by country). Always labelled as an
 * estimate; countries without a configured rate are shown, not priced.
 */

import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { authFetch } from '@/lib/auth/client';
import type { AudienceCostEstimate, CampaignCostComparison } from '@/lib/analytics/campaign-cost';
import type { AudienceConfig } from '@/lib/broadcast-audience';

/** A price in minor units (fractions allowed) shown in the currency's major unit. */
export function formatMinor(minor: number, currency: string, locale: string): string {
  try {
    const fmt = new Intl.NumberFormat(locale, { style: 'currency', currency });
    const digits = fmt.resolvedOptions().maximumFractionDigits ?? 2;
    const major = minor / 10 ** digits;
    // Per-message rates are often fractions of the minor unit; keep up to 4 extra places.
    return new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: Math.min(20, digits + 4) }).format(major);
  } catch {
    return `${minor} ${currency}`;
  }
}

function useCountryName() {
  const locale = useLocale();
  const t = useTranslations('Analytics.cost');
  let names: Intl.DisplayNames | null = null;
  try { names = new Intl.DisplayNames([locale], { type: 'region' }); } catch { names = null; }
  return (code: string) => (code === 'ZZ' ? t('unknownCountry') : names?.of(code) ?? code);
}

/** The wizard audience as the server's audience schema; CSV rows carry only phones. */
function audienceBody(audience: AudienceConfig) {
  return {
    type: audience.type,
    tagIds: audience.tagIds,
    customField: audience.customField,
    csvContacts: audience.type === 'csv' ? audience.csvContacts?.map(({ phone }) => ({ phone })) : undefined,
    excludeTagIds: audience.excludeTagIds,
    segmentId: audience.segmentId,
    listId: audience.listId,
    ...(audience.type === 'csv' && audience.allowDuplicates ? { allowDuplicates: true } : {}),
  };
}

export function CampaignCostEstimate({ templateId, audience }: { templateId: string; audience: AudienceConfig }) {
  const t = useTranslations('Analytics.cost');
  // null lets the server choose (INR when priced, else the first currency).
  const [currency, setCurrency] = useState<string | null>(null);
  const body = useMemo(
    () => JSON.stringify({ templateId, audience: audienceBody(audience), ...(currency ? { currency } : {}) }),
    [templateId, audience, currency],
  );
  // The answer for one request body; a different body means its answer is loading.
  const [result, setResult] = useState<{ body: string; estimate: AudienceCostEstimate | null } | null>(null);

  useEffect(() => {
    let live = true;
    authFetch('/api/broadcasts/estimate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
      .then(async (res) => {
        if (!res.ok) throw new Error('estimate failed');
        const estimate = (await res.json()) as AudienceCostEstimate;
        if (live) setResult({ body, estimate });
      })
      .catch(() => { if (live) setResult({ body, estimate: null }); });
    return () => { live = false; };
  }, [body]);

  const state = result?.body !== body ? 'loading' : result.estimate ? 'ready' : 'error';

  return (
    <div className="border-t border-border pt-3 text-sm" data-testid="campaign-cost-estimate">
      <p className="text-xs text-muted-foreground">{t('estimatedCost')}</p>
      {state === 'loading' && <Loader2 className="mt-1 h-3 w-3 animate-spin text-primary" />}
      {state === 'error' && <p className="text-muted-foreground">{t('unavailable')}</p>}
      {state === 'ready' && result?.estimate && <EstimateSummary estimate={result.estimate} onCurrency={setCurrency} />}
    </div>
  );
}

/** The wizard's priced estimate: total, currency choice, unpriced countries and the campaign-size limit. */
export function EstimateSummary({ estimate, onCurrency }: { estimate: AudienceCostEstimate; onCurrency: (currency: string) => void }) {
  const t = useTranslations('Analytics.cost');
  const locale = useLocale();
  const countryName = useCountryName();
  const priced = !!estimate.currency && estimate.byCountry.length > 0;
  const several = estimate.currencies.length > 1;
  // A capped estimate counts limit + 1 recipients (AudienceCostEstimate.recipients).
  const limit = estimate.recipients - 1;
  return (
    <>
      {estimate.capped && (
        <p role="alert" className="text-xs text-amber-600 dark:text-amber-400">
          {t('overLimit', { limit: limit.toLocaleString(locale) })}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {estimate.capped ? null : priced ? (
          <p className="font-medium text-foreground">{formatMinor(estimate.total, estimate.currency!, locale)}</p>
        ) : (
          <p className="text-foreground">{several && estimate.currency ? t('noCurrencyRate', { currency: estimate.currency }) : t('rateNotConfigured')}</p>
        )}
        {several && (
          <select
            aria-label={t('currency')}
            className="rounded-md border border-border bg-muted px-2 py-1 text-xs text-foreground"
            value={estimate.currency ?? ''}
            onChange={(e) => onCurrency(e.target.value)}
          >
            {estimate.currencies.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
      </div>
      {!estimate.capped && estimate.missingCountries.length > 0 && estimate.byCountry.length > 0 && (
        <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
          {t(several ? 'missingCountriesInCurrency' : 'missingCountries', {
            count: estimate.missingCountries.reduce((n, c) => n + c.recipients, 0),
            countries: estimate.missingCountries.map((c) => countryName(c.countryCode)).join(', '),
            currency: estimate.currency ?? '',
          })}
        </p>
      )}
      <p className="mt-1 text-xs text-muted-foreground">{t('estimateNote')}</p>
    </>
  );
}

export function CampaignCostCard({ broadcastId }: { broadcastId: string }) {
  const t = useTranslations('Analytics.cost');
  const locale = useLocale();
  const countryName = useCountryName();
  const [currency, setCurrency] = useState<string | null>(null);
  const [data, setData] = useState<CampaignCostComparison | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    const query = new URLSearchParams({ broadcastId, ...(currency ? { currency } : {}) });
    authFetch(`/api/broadcasts/estimate?${query}`, { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error('cost failed');
        const body = (await res.json()) as CampaignCostComparison;
        if (live) { setData(body); setFailed(false); }
      })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [broadcastId, currency]);

  if (failed) return null;
  if (!data) return null;
  const cur = data.currency;
  const money = (minor: number | null) => (minor === null || !cur ? t('rateNotConfigured') : formatMinor(minor, cur, locale));

  return (
    <div className="rounded-xl border border-border bg-card" data-testid="campaign-cost-card">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border p-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('estimateNote')}</p>
        </div>
        <div className="flex items-center gap-4 text-sm">
          {data.currencies.length > 1 && (
            <select
              aria-label={t('currency')}
              className="rounded-md border border-border bg-muted px-2 py-1 text-xs text-foreground"
              value={cur ?? ''}
              onChange={(e) => setCurrency(e.target.value)}
            >
              {data.currencies.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
          {cur && (
            <>
              <div>
                <p className="text-xs text-muted-foreground">{t('estimated')}</p>
                <p className="font-medium text-foreground">{formatMinor(data.estimatedTotal, cur, locale)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{t('actual')}</p>
                <p className="font-medium text-foreground">{formatMinor(data.actualTotal, cur, locale)}</p>
              </div>
            </>
          )}
        </div>
      </div>
      {data.countries.length > 0 && (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('country')}</TableHead>
                <TableHead className="text-right">{t('recipients')}</TableHead>
                <TableHead className="text-right">{t('sent')}</TableHead>
                <TableHead className="text-right">{t('delivered')}</TableHead>
                <TableHead className="text-right">{t('rate')}</TableHead>
                <TableHead className="text-right">{t('estimated')}</TableHead>
                <TableHead className="text-right">{t('actual')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.countries.map((c) => (
                <TableRow key={c.countryCode}>
                  <TableCell>{countryName(c.countryCode)}</TableCell>
                  <TableCell className="text-right tabular-nums">{c.recipients.toLocaleString(locale)}</TableCell>
                  <TableCell className="text-right tabular-nums">{c.sent.toLocaleString(locale)}</TableCell>
                  <TableCell className="text-right tabular-nums">{c.delivered.toLocaleString(locale)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(c.unitPriceMinor)}</TableCell>
                  <TableCell className="text-right tabular-nums">{c.unitPriceMinor === null ? '—' : money(c.estimatedMinor)}</TableCell>
                  <TableCell className="text-right tabular-nums">{c.unitPriceMinor === null ? '—' : money(c.actualMinor)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <p className="p-4 pt-2 text-xs text-muted-foreground">{t('actualNote')}</p>
    </div>
  );
}
