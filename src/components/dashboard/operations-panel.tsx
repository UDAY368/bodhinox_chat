'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { useAuth } from '@/hooks/use-auth';
import { authFetch } from '@/lib/auth/client';
import type { DashboardOperations } from '@/lib/dashboard/operations-types';
import type { PhoneHealth } from '@/lib/whatsapp/phone-health';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

export function OperationsPanel({
  onReplyTarget,
}: {
  onReplyTarget?: (minutes: number) => void;
}) {
  const t = useTranslations('Dashboard.operations');
  const { accountId } = useAuth();
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [result, setResult] = useState<{
    accountId: string;
    days: number;
    data: DashboardOperations;
  } | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const data =
    result?.accountId === accountId && result.days === days
      ? result.data
      : null;

  useEffect(() => {
    if (!accountId) return;
    const controller = new AbortController();
    let running = false;
    async function load() {
      if (running || document.visibilityState === 'hidden') return;
      running = true;
      try {
        const response = await authFetch(
          `/api/dashboard/operations?days=${days}`,
          { cache: 'no-store', signal: controller.signal }
        );
        if (!response.ok) throw new Error('operations');
        const next: DashboardOperations = await response.json();
        if (!controller.signal.aborted) {
          setResult({ accountId: accountId!, days, data: next });
          setError(false);
          onReplyTarget?.(next.replyTargetMinutes);
        }
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        running = false;
      }
    }
    void load();
    const interval = setInterval(() => void load(), 60_000);
    const visible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      controller.abort();
      clearInterval(interval);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [accountId, days, retry, onReplyTarget]);

  return (
    <section className="space-y-4" aria-label={t('title')}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{t('title')}</h2>
          <p className="text-muted-foreground text-sm">{t('description')}</p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          {t('range')}
          <select
            className="border-border bg-card rounded-lg border px-3 py-2"
            value={days}
            onChange={(event) => {
              setError(false);
              setDays(Number(event.target.value) as 7 | 30 | 90);
            }}
          >
            {[7, 30, 90].map((value) => (
              <option key={value} value={value}>
                {t('days', { count: value })}
              </option>
            ))}
          </select>
        </label>
      </div>
      <WhatsAppHealth key={accountId} />
      {error && (
        <div
          role="alert"
          className="border-destructive/30 flex items-center gap-3 rounded-xl border p-4 text-sm"
        >
          <span>{t('error')}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRetry((value) => value + 1)}
          >
            {t('retry')}
          </Button>
        </div>
      )}
      {!data && !error && (
        <p
          role="status"
          className="border-border bg-card text-muted-foreground rounded-xl border p-6 text-sm"
        >
          {t('loading')}
        </p>
      )}
      {data && <OperationsContent data={data} />}
    </section>
  );
}

function WhatsAppHealth() {
  const { accountId } = useAuth();
  const [health, setHealth] = useState<PhoneHealth | null>(null);
  const [retry, setRetry] = useState(0);
  const [failed, setFailed] = useState(false);
  const t = useTranslations('Dashboard.operations.health');
  useEffect(() => {
    if (!accountId) return;
    const controller = new AbortController();
    let running = false;
    async function load() {
      if (running || document.visibilityState === 'hidden') return;
      running = true;
      try {
        const response = await authFetch('/api/whatsapp/health', {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('health');
        const next: PhoneHealth = await response.json();
        if (!controller.signal.aborted) {
          setHealth(next);
          setFailed(false);
        }
      } catch {
        if (!controller.signal.aborted) {
          setHealth(null);
          setFailed(true);
        }
      } finally {
        running = false;
      }
    }
    void load();
    const interval = setInterval(() => void load(), 300_000);
    const visible = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', visible);
    return () => {
      controller.abort();
      clearInterval(interval);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [accountId, retry]);
  return (
    <div className="border-border bg-card text-muted-foreground flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3 text-xs">
      <span className="text-foreground font-medium">WhatsApp</span>
      <span>{t(health?.state ?? (failed ? 'unavailable' : 'loading'))}</span>
      {health?.displayPhoneNumber && <span>{health.displayPhoneNumber}</span>}
      <span>
        {t('quality', { value: t(`ratings.${health?.quality ?? 'UNKNOWN'}`) })}
      </span>
      <span>
        {t('limit', {
          value:
            health?.limit?.kind === 'tier'
              ? t('perDay', { count: health.limit.perDay })
              : t(
                  health?.limit?.kind === 'unlimited' ? 'unlimited' : 'unknown'
                ),
        })}
      </span>
      <Link href="/settings?tab=whatsapp" className="text-primary underline">
        {t('settings')}
      </Link>
      {(failed || health?.state === 'unavailable') && (
        <button
          type="button"
          className="text-primary underline"
          onClick={() => setRetry((value) => value + 1)}
        >
          {t('retry')}
        </button>
      )}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <CardContent className="space-y-3">
        <h3 className="font-semibold">{title}</h3>
        {children}
      </CardContent>
    </Card>
  );
}

export function OperationsContent({ data }: { data: DashboardOperations }) {
  const t = useTranslations('Dashboard.operations');
  const format = useFormatter();
  const [pipelineId, setPipelineId] = useState('');
  const selected =
    data.pipelines.find((item) => item.id === pipelineId) ?? data.pipelines[0];
  const minutes = (value: number | null) =>
    value === null ? '—' : t('minutes', { count: Math.round(value * 10) / 10 });
  const timestamp = (value: string) =>
    format.dateTime(new Date(value), {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  const cards = [
    {
      key: 'waiting',
      value: data.attention.waiting,
      href: '/inbox?filter=waiting',
    },
    {
      key: 'overTarget',
      value: data.attention.overTarget,
      href: '/inbox?filter=waiting',
    },
    {
      key: 'unassigned',
      value: data.attention.unassigned,
      href: '/inbox?filter=unassigned',
    },
    {
      key: 'expiring',
      value: data.attention.expiring,
      href: '/inbox?filter=expiring-soon',
    },
  ] as const;
  const setupLinks = {
    whatsapp: '/settings?tab=whatsapp',
    contacts: '/contacts',
    template: '/settings?tab=templates',
    teammate: '/settings?tab=members',
    conversation: '/inbox',
  };
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {cards.map((card) => (
          <Link
            key={card.key}
            href={card.href}
            className="border-border bg-card hover:bg-muted rounded-xl border p-4 transition-colors"
          >
            <p className="text-muted-foreground text-sm">{t(card.key)}</p>
            <p className="mt-2 text-2xl font-semibold tabular-nums">
              {card.value}
            </p>
          </Link>
        ))}
        <a
          href="#operations-failures"
          className="border-border bg-card hover:bg-muted rounded-xl border p-4"
        >
          <p className="text-muted-foreground text-sm">{t('failed')}</p>
          <p className="mt-2 text-2xl font-semibold tabular-nums">
            {data.attention.failed}
          </p>
        </a>
      </div>
      <p className="text-muted-foreground text-xs">
        {t('target', { count: data.replyTargetMinutes })}{' '}
        <Link href="/settings?tab=inbox" className="text-primary underline">
          {t('editTarget')}
        </Link>
      </p>
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Panel title={t('queue')}>
          {!data.queue.length ? (
            <p className="text-muted-foreground text-sm">{t('queueEmpty')}</p>
          ) : (
            <ul className="divide-border divide-y">
              {data.queue.map((item) => (
                <li key={item.id} className="py-3">
                  <Link
                    className="text-primary font-medium hover:underline"
                    href={`/inbox?c=${encodeURIComponent(item.id)}`}
                  >
                    {item.name}
                  </Link>
                  <p className="text-muted-foreground mt-1 text-xs">
                    {t('waitingSince', { time: timestamp(item.waitingSince) })}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {t('closesAt', { time: timestamp(item.closesAt) })}
                  </p>
                  {(!item.assigned || item.handedOff) && (
                    <p className="text-primary mt-1 text-xs">
                      {!item.assigned && t('unassigned')}
                      {!item.assigned && item.handedOff ? ' · ' : ''}
                      {item.handedOff && t('handedOff')}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <div id="operations-failures" className="scroll-mt-4">
          <Panel title={t('failures')}>
            <p className="text-muted-foreground text-xs">{t('failuresHint')}</p>
            {!data.failedMessages.length ? (
              <p className="text-muted-foreground text-sm">
                {t('failuresEmpty')}
              </p>
            ) : (
              <ul className="divide-border divide-y">
                {data.failedMessages.map((item) => (
                  <li key={item.id} className="py-3">
                    <Link
                      href={`/inbox?c=${encodeURIComponent(item.conversationId)}`}
                      className="text-primary font-medium hover:underline"
                    >
                      {item.name}
                    </Link>
                    <p className="mt-1 line-clamp-2 text-sm break-words">
                      {item.preview || t('mediaMessage')}
                    </p>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {timestamp(item.at)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
        <Panel title={t('team')}>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-muted-foreground text-xs">
                <tr>
                  <th className="pb-2">{t('member')}</th>
                  <th>{t('open')}</th>
                  <th>{t('replies')}</th>
                  <th>{t('median')}</th>
                </tr>
              </thead>
              <tbody>
                {data.team.map((member) => (
                  <tr key={member.id} className="border-border border-t">
                    <th className="py-3 font-medium">{member.name}</th>
                    <td>{member.open}</td>
                    <td>{member.replies}</td>
                    <td>{minutes(member.medianMinutes)}</td>
                  </tr>
                ))}
                <tr className="border-border border-t">
                  <th className="py-3 font-medium">{t('automated')}</th>
                  <td>—</td>
                  <td>{data.automated.replies}</td>
                  <td>{minutes(data.automated.medianMinutes)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          {!data.team.length && (
            <p className="text-muted-foreground text-xs">{t('teamEmpty')}</p>
          )}
        </Panel>
        <Panel title={t('pipelines')}>
          {selected ? (
            <>
              <label className="block text-sm">
                {t('pipeline')}
                <select
                  className="border-border bg-card mt-1 w-full rounded-lg border p-2"
                  value={selected.id}
                  onChange={(event) => setPipelineId(event.target.value)}
                >
                  {data.pipelines.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <dl className="grid grid-cols-2 gap-3 text-sm">
                {(['open', 'won', 'lost', 'idle'] as const).map((key) => (
                  <div key={key}>
                    <dt className="text-muted-foreground">{t(key)}</dt>
                    <dd className="text-xl font-semibold">{selected[key]}</dd>
                  </div>
                ))}
              </dl>
              <p className="text-muted-foreground text-xs">
                {t('avgDaysToWin', {
                  value:
                    selected.avgDaysToWin === null
                      ? '—'
                      : Math.round(selected.avgDaysToWin * 10) / 10,
                })}
              </p>
              <Link
                href="/pipelines"
                className="text-primary text-sm underline"
              >
                {t('openPipelines')}
              </Link>
            </>
          ) : (
            <p className="text-muted-foreground text-sm">
              {t('pipelinesEmpty')}
            </p>
          )}
        </Panel>
        <Panel title={t('campaigns')}>
          <dl className="space-y-2 text-sm">
            {(
              [
                'automationRuns',
                'automationFailed',
                'flowFailed',
                'templatesApproved',
                'templatesRejected',
              ] as const
            ).map((key) => (
              <div key={key} className="flex justify-between gap-3">
                <dt className="text-muted-foreground">{t(key)}</dt>
                <dd className="font-medium">{data.campaigns[key]}</dd>
              </div>
            ))}
          </dl>
          {data.campaigns.topFailingFlow && (
            <p className="text-sm">
              {t('topFailingFlow', { name: data.campaigns.topFailingFlow })}
            </p>
          )}
          <div className="text-primary flex gap-4 text-sm">
            <Link href="/automations" className="underline">
              {t('automations')}
            </Link>
            <Link href="/flows" className="underline">
              {t('flows')}
            </Link>
          </div>
          <h4 className="border-border border-t pt-3 text-sm font-medium">
            {t('latestBroadcast')}
          </h4>
          {data.latestBroadcast ? (
            <>
              <Link href="/broadcasts" className="text-primary underline">
                {data.latestBroadcast.name}
              </Link>
              <dl className="grid grid-cols-2 gap-2 text-sm">
                {(['delivered', 'read', 'replied', 'failed'] as const).map(
                  (key) => (
                    <div key={key}>
                      <dt className="text-muted-foreground">{t(key)}</dt>
                      <dd>{data.latestBroadcast![key]}</dd>
                    </div>
                  )
                )}
              </dl>
            </>
          ) : (
            <p className="text-muted-foreground text-sm">
              {t('broadcastEmpty')}
            </p>
          )}
        </Panel>
        <Panel title={t('setup')}>
          <p className="text-muted-foreground text-xs">{t('setupHint')}</p>
          <ul className="space-y-3 text-sm">
            {(Object.keys(setupLinks) as (keyof typeof setupLinks)[]).map(
              (key) => (
                <li key={key} className="flex justify-between gap-3">
                  <Link
                    href={setupLinks[key]}
                    className="text-primary hover:underline"
                  >
                    {t(`setupItems.${key}`)}
                  </Link>
                  <span
                    className={
                      data.setup[key] ? 'text-primary' : 'text-muted-foreground'
                    }
                  >
                    {t(data.setup[key] ? 'done' : 'pending')}
                  </span>
                </li>
              )
            )}
          </ul>
        </Panel>
      </div>
    </>
  );
}
