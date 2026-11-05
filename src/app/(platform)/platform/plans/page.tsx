'use client';

// Console: plans and prices. A plan edit is previewed (which tightened limits
// would put workspaces over), then published as the plan's next version;
// subscribers stay on the version they are pinned to until an admin moves
// them (audited, archives extras, never deletes). 'enterprise' is the legacy
// fallback of every workspace without a subscription: no finite limit and no
// feature turned off. Prices (monthly and yearly, GST-inclusive, history kept)
// are saved through PUT /api/billing/admin/prices.

import { useCallback, useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FEATURES, LIMITS } from '@/lib/billing/entitlements-catalogue';
import type { PlanPreview, PlatformPlanPrice, PlatformPlanRow, PlatformPlanVersion } from '@/types/platform';
import { errorCode, platformApi } from '../../_components/platform-api';

const PLAN_ERRORS = ['invalid_plan_terms', 'plan_locked', 'unknown_plan', 'invalid_request', 'reason_required', 'stale_version', 'preview_mismatch'] as const;
const PRICE_ERRORS = ['invalidPrice'] as const;

interface Catalogue {
  plans: PlatformPlanRow[];
  prices: PlatformPlanPrice[];
  billingConfigured: boolean;
}

export default function PlatformPlansPage() {
  const t = useTranslations('Platform.plans');
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(
    () => platformApi<Catalogue>('/api/platform/plans').then((c) => { setCatalogue(c); setFailed(false); }, () => setFailed(true)),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('intro')}</p>
      </div>
      {failed && <p role="status" className="text-sm">{t('loadFailed')}</p>}
      {catalogue?.plans.map((plan) => <PlanEditor key={`${plan.id}:${plan.currentVersion}`} plan={plan} onChanged={load} />)}
      {catalogue && <Prices catalogue={catalogue} onChanged={load} />}
    </div>
  );
}

type Draft = { features: Record<string, boolean>; limits: Record<string, string> };

const toDraft = (plan: PlatformPlanRow): Draft => ({
  features: Object.fromEntries(FEATURES.map((f) => [f, plan.features[f] === true])),
  limits: Object.fromEntries(LIMITS.map((k) => [k, typeof plan.limits[k] === 'number' ? String(plan.limits[k]) : ''])),
});

/** The request body, or null when a limit is not a non-negative whole number. */
function toBody(draft: Draft): { features: Record<string, boolean>; limits: Record<string, number | null> } | null {
  const limits: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(draft.limits)) {
    const trimmed = v.trim();
    if (trimmed === '') { limits[k] = null; continue; }
    const n = Number(trimmed);
    if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(n)) return null;
    limits[k] = n;
  }
  return { features: draft.features, limits };
}

function PlanEditor({ plan, onChanged }: { plan: PlatformPlanRow; onChanged: () => Promise<void> }) {
  const t = useTranslations('Platform.plans');
  const format = useFormatter();
  const locked = plan.id === 'enterprise';
  const [draft, setDraft] = useState<Draft>(() => toDraft(plan));
  const [preview, setPreview] = useState<{ body: string; data: PlanPreview } | null>(null);
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<'preview' | 'publish' | 'move' | 'versions' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [versions, setVersions] = useState<PlatformPlanVersion[] | null>(null);

  const body = toBody(draft);
  const bodyKey = body ? JSON.stringify(body) : null;
  const previewCurrent = preview !== null && preview.body === bodyKey;
  const fail = (error: unknown) => setMessage(t(`errors.${errorCode(error, PLAN_ERRORS)}`));

  async function runPreview() {
    if (!body) return setMessage(t('errors.invalid_plan_terms'));
    setBusy('preview');
    setMessage(null);
    try {
      setPreview({ body: bodyKey!, data: await platformApi<PlanPreview>(`/api/platform/plans/${plan.id}/preview`, { body }) });
    } catch (error) {
      setPreview(null);
      fail(error);
    } finally {
      setBusy(null);
    }
  }

  async function publish() {
    if (!body || !previewCurrent) return;
    setBusy('publish');
    setMessage(null);
    try {
      const { version } = await platformApi<{ version: number }>(`/api/platform/plans/${plan.id}/publish`,
        { body: { ...body, note: note.trim() || null, previewHash: preview.data.preview_hash } });
      setMessage(t('published', { version }));
      await onChanged();
    } catch (error) {
      setPreview(null);
      fail(error);
    } finally {
      setBusy(null);
    }
  }

  async function move() {
    setBusy('move');
    setMessage(null);
    try {
      const r = await platformApi<{ moved: number; archivedWorkspaces: number; failedAccounts: string[] }>(`/api/platform/plans/${plan.id}/move`,
        { body: { reason: reason.trim(), version: plan.currentVersion } });
      setMessage(t('moved', { moved: r.moved, archived: r.archivedWorkspaces, failed: r.failedAccounts.length }));
      setReason('');
      await onChanged();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(null);
    }
  }

  async function toggleVersions() {
    if (versions) return setVersions(null);
    setBusy('versions');
    try {
      setVersions((await platformApi<{ versions: PlatformPlanVersion[] }>(`/api/platform/plans/${plan.id}`)).versions);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card data-testid={`platform-plan-${plan.id}`}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          {plan.name}
          <span className="text-muted-foreground font-mono text-xs">{plan.id}</span>
          <Badge variant="secondary">{t('version', { version: plan.currentVersion })}</Badge>
          <Badge variant="outline">{t('subscribers', { count: plan.subscribers })}</Badge>
          {plan.pinnedOld > 0 && <Badge variant="outline">{t('pinnedOld', { count: plan.pinnedOld })}</Badge>}
        </CardTitle>
        {locked && <p className="text-muted-foreground text-xs">{t('enterpriseLocked')}</p>}
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        <fieldset className="flex flex-col gap-2">
          <legend className="font-medium">{t('features')}</legend>
          <div className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <label key={f} className="flex items-center gap-2">
                <input type="checkbox" checked={draft.features[f]} disabled={locked && plan.features[f] === true}
                  onChange={(e) => setDraft((d) => ({ ...d, features: { ...d.features, [f]: e.target.checked } }))} />
                <span className="font-mono text-xs">{f}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="flex flex-col gap-2">
          <legend className="font-medium">{t('limits')}</legend>
          <p className="text-muted-foreground text-xs">{t('limitsHint')}</p>
          <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
            {LIMITS.map((k) => (
              <div key={k} className="flex items-center gap-2">
                <Label htmlFor={`${plan.id}-${k}`} className="w-44 shrink-0 font-mono text-xs">{k}</Label>
                <Input id={`${plan.id}-${k}`} inputMode="numeric" value={draft.limits[k]} disabled={locked} placeholder={t('unlimited')}
                  onChange={(e) => setDraft((d) => ({ ...d, limits: { ...d.limits, [k]: e.target.value } }))} />
              </div>
            ))}
          </div>
        </fieldset>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => void runPreview()}>{t('preview')}</Button>
          <Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={() => { setDraft(toDraft(plan)); setPreview(null); }}>
            {t('reset')}
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={() => void toggleVersions()}>
            {versions ? t('hideVersions') : t('showVersions')}
          </Button>
        </div>
        {previewCurrent && (
          <div className="flex flex-col gap-2 rounded-md border p-3" data-testid="platform-plan-preview">
            <p>{t('affected', { count: preview.data.affected_workspaces })}</p>
            {preview.data.tightened.length === 0 ? <p className="text-muted-foreground">{t('noTightening')}</p> : (
              <ul className="list-disc pl-5">
                {preview.data.tightened.map((x) => (
                  <li key={x.key}>
                    <span className="font-mono text-xs">{x.key}</span>{' '}
                    {t('tightened', { from: x.current === null ? t('unlimited') : String(x.current), to: x.next })}{' '}
                    {x.over === null ? t('overSoft') : t('over', { count: x.over })}
                  </li>
                ))}
              </ul>
            )}
            <p className="text-muted-foreground text-xs">{t('pinnedStay')}</p>
            <Label htmlFor={`${plan.id}-note`}>{t('note')}</Label>
            <Input id={`${plan.id}-note`} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
            <div>
              <Button type="button" size="sm" disabled={busy !== null} onClick={() => void publish()}>
                {t('publish', { version: plan.currentVersion + 1 })}
              </Button>
            </div>
          </div>
        )}
        {plan.pinnedOld > 0 && (
          <div className="flex flex-col gap-2 rounded-md border p-3">
            <p>{t('moveIntro', { count: plan.pinnedOld, version: plan.currentVersion })}</p>
            <Label htmlFor={`${plan.id}-reason`}>{t('reason')}</Label>
            <Input id={`${plan.id}-reason`} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
            <div>
              <Button type="button" size="sm" variant="destructive" disabled={busy !== null || reason.trim().length < 10} onClick={() => void move()}>
                {t('move', { version: plan.currentVersion })}
              </Button>
            </div>
          </div>
        )}
        {message && <p role="status" className="text-sm">{message}</p>}
        {versions && (
          <ul className="divide-border divide-y text-xs" data-testid="platform-plan-versions">
            {versions.map((v) => (
              <li key={v.id} className="flex flex-col gap-1 py-2">
                <span className="font-medium">
                  {t('version', { version: v.version })} · {format.dateTime(new Date(v.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}
                  {v.createdByEmail && ` · ${v.createdByEmail}`}
                </span>
                {v.note && <span className="text-muted-foreground">{v.note}</span>}
                <span className="text-muted-foreground font-mono break-all">
                  {Object.entries(v.limits).filter(([, x]) => x !== null).map(([k, x]) => `${k}=${String(x)}`).join(' ') || t('allUnlimited')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function Prices({ catalogue, onChanged }: { catalogue: Catalogue; onChanged: () => Promise<void> }) {
  const t = useTranslations('Platform.plans.prices');
  const format = useFormatter();
  const [plan, setPlan] = useState(catalogue.plans.find((p) => p.id !== 'enterprise' && p.id !== 'free')?.id ?? catalogue.plans[0]?.id ?? '');
  const [interval, setBillingInterval] = useState<'month' | 'year'>('month');
  const [rupees, setRupees] = useState('');
  const [providerPlanId, setProviderPlanId] = useState('');
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const amount = Math.round(Number(rupees) * 100);
    if (!Number.isSafeInteger(amount) || amount <= 0) return setMessage(t('errors.invalidPrice'));
    setBusy(true);
    setMessage(null);
    try {
      await platformApi('/api/billing/admin/prices', { method: 'PUT', body: { plan, interval, amount_minor: amount, provider_plan_id: providerPlanId.trim(), active } });
      setMessage(t('saved'));
      setRupees('');
      setProviderPlanId('');
      await onChanged();
    } catch (error) {
      setMessage(t(`errors.${errorCode(error, PRICE_ERRORS)}`));
    } finally {
      setBusy(false);
    }
  }

  const money = (minor: number, currency: string) => format.number(minor / 100, { style: 'currency', currency });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
        <p className="text-muted-foreground text-xs">{t('intro')}</p>
        {!catalogue.billingConfigured && <p className="text-muted-foreground text-xs">{t('notConfigured')}</p>}
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        {catalogue.prices.length === 0 ? <p className="text-muted-foreground">{t('empty')}</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3">{t('plan')}</th><th className="py-1 pr-3">{t('interval')}</th><th className="py-1 pr-3">{t('amount')}</th>
                  <th className="py-1 pr-3">{t('providerPlan')}</th><th className="py-1 pr-3">{t('state')}</th><th className="py-1">{t('updated')}</th>
                </tr>
              </thead>
              <tbody>
                {catalogue.prices.map((p) => (
                  <tr key={p.providerPlanId} className="border-border border-t">
                    <td className="py-1 pr-3 font-mono">{p.plan}</td>
                    <td className="py-1 pr-3">{t(`intervals.${p.interval}`)}</td>
                    <td className="py-1 pr-3">{money(p.amountMinor, p.currency)}</td>
                    <td className="py-1 pr-3 font-mono">{p.providerPlanId}</td>
                    <td className="py-1 pr-3">{p.active ? <Badge variant="secondary">{t('active')}</Badge> : <Badge variant="outline">{t('retired')}</Badge>}</td>
                    <td className="py-1">{format.dateTime(new Date(p.updatedAt), { dateStyle: 'medium' })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <form onSubmit={save} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="price-plan">{t('plan')}</Label>
            <select id="price-plan" className="border-input bg-background h-9 rounded-md border px-2" value={plan} onChange={(e) => setPlan(e.target.value)}>
              {catalogue.plans.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.id})</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="price-interval">{t('interval')}</Label>
            <select id="price-interval" className="border-input bg-background h-9 rounded-md border px-2" value={interval}
              onChange={(e) => setBillingInterval(e.target.value === 'year' ? 'year' : 'month')}>
              <option value="month">{t('intervals.month')}</option>
              <option value="year">{t('intervals.year')}</option>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="price-amount">{t('amountInr')}</Label>
            <Input id="price-amount" inputMode="decimal" required value={rupees} onChange={(e) => setRupees(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="price-provider">{t('providerPlan')}</Label>
            <Input id="price-provider" required placeholder="plan_..." value={providerPlanId} onChange={(e) => setProviderPlanId(e.target.value)} />
          </div>
          <label className="flex items-center gap-2 self-end pb-2">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            {t('activeLabel')}
          </label>
          <div className="self-end">
            <Button type="submit" size="sm" disabled={busy}>{t('save')}</Button>
          </div>
        </form>
        <p className="text-muted-foreground text-xs">{t('history')}</p>
        {message && <p role="status" className="text-sm">{message}</p>}
      </CardContent>
    </Card>
  );
}
