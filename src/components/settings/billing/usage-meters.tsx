'use client';

// Plan limits and how much of each is used, with what happens at each limit
// (LIMIT_POLICY) and a short "How limits work" note. Monthly meters (AI
// messages and tokens, active contacts, messages sent) reset at the start of
// each month, India time; storage is shown in KB/MB/GB. Display only: the
// server enforces every limit.

import { useFormatter, useTranslations } from 'next-intl';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LIMIT_POLICY, LIMITS, MONTHLY_LIMITS, type LimitKey } from '@/lib/billing/entitlements-catalogue';
import type { PlanView } from '@/lib/billing/client';

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
const HOW_ITEMS = ['hard', 'inbound', 'monthly', 'warnings', 'expiry'] as const;

/** 1536 -> { value: 1.5, unit: 'KB' } (binary units, as plans define storage). */
export function splitBytes(bytes: number): { value: number; unit: (typeof UNITS)[number] } {
  let value = Math.max(0, bytes);
  let i = 0;
  while (value >= 1024 && i < UNITS.length - 1) {
    value /= 1024;
    i += 1;
  }
  return { value: i === 0 ? value : Math.round(value * 10) / 10, unit: UNITS[i] };
}

/** Percent of a limit used, 0–100 (0 when unlimited or unknown). */
export function usedPercent(used: number | undefined, limit: number | null): number {
  if (limit === null || used === undefined) return 0;
  if (limit <= 0) return used > 0 ? 100 : 0;
  return Math.min(100, Math.round((used / limit) * 100));
}

export function UsageMeters({ plan }: { plan: PlanView }) {
  const t = useTranslations('Settings.plan');
  const tIg = useTranslations('Billing.instagram');
  const format = useFormatter();
  const amount = (key: LimitKey, n: number) => {
    if (key !== 'storage_bytes') return format.number(n);
    const { value, unit } = splitBytes(n);
    return `${format.number(value)} ${unit}`;
  };

  return (
    <Card data-testid="usage-meters">
      <CardHeader>
        <CardTitle className="text-foreground">{t('limitsTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {LIMITS.map((key) => {
          const limit = plan.limits[key];
          const used = plan.usage[key];
          const pct = usedPercent(used, limit);
          return (
            <div key={key} className="space-y-1" data-testid={`meter-${key}`}>
              <div className="flex justify-between gap-3 text-sm">
                <span className="text-foreground">
                  {key === 'storage_bytes' ? t('meters.storage') : t(`limits.${key}`)}
                  {MONTHLY_LIMITS.includes(key) && <span className="ml-1 text-xs text-muted-foreground">{t('meters.monthly')}</span>}
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {used !== undefined ? `${amount(key, used)} / ` : ''}
                  {limit === null ? t('unlimited') : amount(key, limit)}
                </span>
              </div>
              {limit !== null && used !== undefined && (
                <div className="h-1.5 rounded-full bg-muted" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}
                  aria-label={key === 'storage_bytes' ? t('meters.storage') : t(`limits.${key}`)}>
                  <div className={`h-1.5 rounded-full ${pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-primary'}`} style={{ width: `${pct}%` }} />
                </div>
              )}
              {limit !== null && used !== undefined && pct >= 100 && (
                <p className="text-xs text-red-600 dark:text-red-400">{t('meters.reached')}</p>
              )}
              {key === 'monthly_active_contacts' && (
                <p className="text-xs text-muted-foreground">{tIg('activeContactsNote')}</p>
              )}
              {limit !== null && (
                <p className="text-xs text-muted-foreground" data-testid={`policy-${key}`}>{t(`policies.${LIMIT_POLICY[key]}`)}</p>
              )}
            </div>
          );
        })}
        <details className="rounded-md border border-border p-3 text-sm" data-testid="how-limits-work">
          <summary className="cursor-pointer font-medium text-foreground">{t('meters.howTitle')}</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
            {HOW_ITEMS.map((item) => <li key={item}>{t(`meters.how.${item}`)}</li>)}
          </ul>
        </details>
      </CardContent>
    </Card>
  );
}
