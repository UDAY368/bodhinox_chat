'use client';

// Console: one workspace. Subscription, lifecycle, members by role, stored
// usage and support grants; suspend / reactivate / block manual replies
// (reason required, both audit trails, tenant notified); ask the workspace for
// diagnostics access. No customer content is shown or reachable from here.

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { PlatformTenantDetail } from '@/types/platform';
import { errorCode, platformApi, PlatformApiError } from '../../../_components/platform-api';

const LIFECYCLE_ERRORS = ['invalid', 'reason_required', 'unknown_account', 'lifecycle_closing', 'invalid_lifecycle_status'] as const;
/** Admin-suspended, or a closing workspace an admin holds (the suspend fields set). */
const held = (tenant: PlatformTenantDetail) => tenant.lifecycle.status === 'admin_suspended'
  || (tenant.lifecycle.status === 'closing' && tenant.lifecycle.suspend_reason !== null);

const SUPPORT_ERRORS = ['invalid', 'reason_required', 'unknown_account', 'invalid_duration', 'support_request_open'] as const;

export default function PlatformTenantPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations('Platform.tenant');
  const format = useFormatter();
  const [tenant, setTenant] = useState<PlatformTenantDetail | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'failed'>('loading');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lifecycleReason, setLifecycleReason] = useState('');
  const [blockManual, setBlockManual] = useState(false);
  const [supportReason, setSupportReason] = useState('');
  const [supportMinutes, setSupportMinutes] = useState('60');

  const load = useCallback(async () => {
    try {
      const { tenant: detail } = await platformApi<{ tenant: PlatformTenantDetail }>(`/api/platform/tenants/${encodeURIComponent(id)}`);
      setTenant(detail);
      setBlockManual(detail.lifecycle.block_manual);
      setState('ready');
    } catch (error) {
      setState(error instanceof PlatformApiError && error.status === 404 ? 'missing' : 'failed');
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  async function setLifecycle(status: 'active' | 'admin_suspended') {
    setBusy(true);
    setMessage(null);
    try {
      await platformApi('/api/platform/lifecycle', {
        // The checkbox is sent as is: suspending never turns the manual block on by itself.
        body: { accountId: id, status, blockManual, reason: lifecycleReason.trim() },
      });
      setLifecycleReason('');
      setMessage(t('lifecycleSaved'));
      await load();
    } catch (error) {
      setMessage(t(`errors.${errorCode(error, LIFECYCLE_ERRORS)}`));
    } finally {
      setBusy(false);
    }
  }

  async function saveManualBlock() {
    if (!tenant) return;
    setBusy(true);
    setMessage(null);
    try {
      await platformApi('/api/platform/lifecycle', {
        body: { accountId: id, status: held(tenant) ? 'admin_suspended' : 'active', blockManual, reason: lifecycleReason.trim() },
      });
      setLifecycleReason('');
      setMessage(t('lifecycleSaved'));
      await load();
    } catch (error) {
      setMessage(t(`errors.${errorCode(error, LIFECYCLE_ERRORS)}`));
    } finally {
      setBusy(false);
    }
  }

  async function requestSupport(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await platformApi('/api/platform/support', { body: { accountId: id, reason: supportReason.trim(), minutes: Number(supportMinutes) } });
      setSupportReason('');
      setMessage(t('supportRequested'));
      await load();
    } catch (error) {
      setMessage(t(`errors.${errorCode(error, SUPPORT_ERRORS)}`));
    } finally {
      setBusy(false);
    }
  }

  if (state === 'loading') return <p className="text-muted-foreground text-sm">{t('loading')}</p>;
  if (state === 'missing') return <p className="text-sm">{t('notFound')}</p>;
  if (state === 'failed' || !tenant) return <p role="status" className="text-sm">{t('loadFailed')}</p>;

  const when = (value: string | null) => (value ? format.dateTime(new Date(value), { dateStyle: 'medium', timeStyle: 'short' }) : '-');
  const closing = tenant.lifecycle.status === 'closing';
  const isHeld = held(tenant);
  const reasonOk = lifecycleReason.trim().length >= 10;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{tenant.name}</h1>
        <Badge variant={tenant.lifecycle.status === 'active' ? 'secondary' : 'destructive'}>{t(`lifecycle.${tenant.lifecycle.status}`)}</Badge>
        {tenant.lifecycle.block_manual && <Badge variant="destructive">{t('manualBlocked')}</Badge>}
        <Link href={`/platform/audit?accountId=${tenant.account_id}`} className="text-muted-foreground ml-auto text-sm hover:underline">
          {t('auditLink')}
        </Link>
      </div>
      <p className="text-muted-foreground font-mono text-xs">{tenant.account_id}</p>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>{t('summary')}</CardTitle></CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">{t('owner')}</dt><dd>{tenant.owner_email ?? '-'}</dd>
              <dt className="text-muted-foreground">{t('created')}</dt><dd>{when(tenant.created_at)}</dd>
              <dt className="text-muted-foreground">{t('plan')}</dt>
              <dd>{tenant.plan_id}{tenant.plan_version !== null && ` v${tenant.plan_version}`}</dd>
              <dt className="text-muted-foreground">{t('subscription')}</dt>
              <dd>{tenant.subscription ? `${tenant.subscription.status}${tenant.subscription.interval ? ` · ${tenant.subscription.interval}` : ''}` : t('noSubscription')}</dd>
              {tenant.subscription?.current_period_end && (<><dt className="text-muted-foreground">{t('periodEnd')}</dt><dd>{when(tenant.subscription.current_period_end)}</dd></>)}
              <dt className="text-muted-foreground">{t('members')}</dt>
              <dd>{Object.entries(tenant.members).map(([role, n]) => `${role} ${n}`).join(' · ') || '0'}</dd>
              <dt className="text-muted-foreground">{t('openReconciliation')}</dt><dd>{tenant.open_reconciliation_items}</dd>
              {tenant.lifecycle.purge_after && (<><dt className="text-muted-foreground">{t('purgeAfter')}</dt><dd>{when(tenant.lifecycle.purge_after)}</dd></>)}
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>{t('usage')}</CardTitle></CardHeader>
          <CardContent>
            {Object.keys(tenant.usage).length === 0 ? (
              <p className="text-muted-foreground text-sm">{t('noUsage')}</p>
            ) : (
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                {Object.entries(tenant.usage).map(([metric, value]) => (
                  <div key={metric} className="contents"><dt className="text-muted-foreground">{metric}</dt><dd>{format.number(Number(value))}</dd></div>
                ))}
              </dl>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>{t('lifecycleTitle')}</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3">
          {isHeld && (
            <p className="text-sm">{t('suspendedBy', { email: tenant.lifecycle.suspended_by_email ?? '-', when: when(tenant.lifecycle.suspended_at) })}</p>
          )}
          {closing && <p className="text-sm">{t('closingNote')}</p>}
          <p className="text-muted-foreground text-xs">{t('lifecycleHelp')}</p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="lifecycle-reason">{t('reason')}</Label>
            <Textarea id="lifecycle-reason" maxLength={1000} value={lifecycleReason} onChange={(e) => setLifecycleReason(e.target.value)} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={blockManual} onCheckedChange={(v) => setBlockManual(v === true)} />
            {t('blockManual')}
          </label>
          <div className="flex flex-wrap gap-2">
            {isHeld ? (
              <Button type="button" disabled={busy || !reasonOk} onClick={() => void setLifecycle('active')}>{t('reactivate')}</Button>
            ) : (
              <Button type="button" variant="destructive" disabled={busy || !reasonOk} onClick={() => void setLifecycle('admin_suspended')}>
                {t('suspend')}
              </Button>
            )}
            <Button type="button" variant="outline" disabled={busy || !reasonOk || blockManual === tenant.lifecycle.block_manual}
              onClick={() => void saveManualBlock()}>
              {t('saveManualBlock')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('supportTitle')}</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-muted-foreground text-xs">{t('supportHelp')}</p>
          {tenant.support_grants.length > 0 && (
            <ul className="divide-border divide-y text-sm">
              {tenant.support_grants.map((g) => (
                <li key={g.id} className="flex flex-wrap gap-x-3 py-1.5">
                  <span>{g.requested_by_email}</span>
                  <Badge variant="outline">{t(`grantStatus.${g.status}`)}</Badge>
                  <span className="text-muted-foreground">{when(g.requested_at)}</span>
                </li>
              ))}
            </ul>
          )}
          <form onSubmit={requestSupport} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="support-reason">{t('reason')}</Label>
              <Textarea id="support-reason" required minLength={10} maxLength={1000} value={supportReason} onChange={(e) => setSupportReason(e.target.value)} />
            </div>
            <div className="flex max-w-xs flex-col gap-1.5">
              <Label htmlFor="support-minutes">{t('minutes')}</Label>
              <Input id="support-minutes" type="number" min={15} max={1440} step={15} value={supportMinutes} onChange={(e) => setSupportMinutes(e.target.value)} />
            </div>
            <Button type="submit" className="self-start" disabled={busy || supportReason.trim().length < 10}>{t('requestSupport')}</Button>
          </form>
        </CardContent>
      </Card>

      {message && <p role="status" className="text-sm">{message}</p>}
    </div>
  );
}
