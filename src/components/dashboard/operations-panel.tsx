'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { AlertTriangle, ChevronRight, Clock, Inbox, Timer, UserX } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { useWorkspaceChannels } from '@/hooks/use-workspace-channels';
import { authFetch } from '@/lib/auth/client';
import type { DashboardOperations } from '@/lib/dashboard/operations-types';
import type { PhoneHealth } from '@/lib/whatsapp/phone-health';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { segmentedItem, segmentedTrack } from './segmented';

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
  // A workspace without WhatsApp (Stage 1) gets no WhatsApp health strip or
  // WhatsApp setup steps. Until the channel state loads, WhatsApp shows as before.
  const { data: channels } = useWorkspaceChannels();
  const whatsapp = channels ? channels.enabled.includes('whatsapp') : true;
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
    <section className="space-y-3.5" aria-label={t('title')}>
      <div className="flex flex-wrap items-end justify-between gap-3 pt-2">
        <div className="min-w-0">
          <h2 className="text-foreground text-[17px] font-semibold tracking-tight">{t('title')}</h2>
          <p className="text-muted-foreground mt-0.5 text-[13px]">{t('description')}</p>
        </div>
        <div role="group" aria-label={t('range')} className={segmentedTrack}>
          {([7, 30, 90] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={days === value}
              className={segmentedItem(days === value)}
              onClick={() => {
                setError(false);
                setDays(value);
              }}
            >
              {t('days', { count: value })}
            </button>
          ))}
        </div>
      </div>
      {whatsapp && <WhatsAppHealth key={accountId} />}
      {error && (
        <div
          role="alert"
          className="border-destructive/30 bg-destructive/5 flex flex-wrap items-center gap-3 rounded-xl border p-4 text-sm"
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
          className="border-border bg-card text-muted-foreground animate-pulse rounded-xl border p-6 text-center text-sm"
        >
          {t('loading')}
        </p>
      )}
      {data && <OperationsContent data={data} whatsapp={whatsapp} />}
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
    <div className="border-border bg-card text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border px-4 py-2.5 text-xs">
      <span className="text-foreground inline-flex items-center gap-2 font-semibold">
        <span
          aria-hidden
          className={cn(
            'size-2 rounded-full',
            health?.state === 'connected' ? 'bg-emerald-500' : health?.state === 'disconnected' || failed ? 'bg-red-500' : 'bg-muted-foreground/50',
          )}
        />
        WhatsApp
      </span>
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
      <Link href="/settings?tab=whatsapp" className="text-primary ml-auto font-medium hover:underline">
        {t('settings')}
      </Link>
      {(failed || health?.state === 'unavailable') && (
        <button
          type="button"
          className="text-primary font-medium hover:underline"
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
    <Card className="h-full">
      <CardContent className="space-y-3">
        <h3 className="text-foreground text-[15px] font-semibold tracking-tight">{title}</h3>
        {children}
      </CardContent>
    </Card>
  );
}

/** The WhatsApp-only setup steps, left out when the workspace does not use WhatsApp. */
const WHATSAPP_SETUP = new Set(['whatsapp', 'template']);

export function OperationsContent({ data, whatsapp = true }: {
  data: DashboardOperations;
  /** The workspace uses WhatsApp (default: as before Stage 1). */
  whatsapp?: boolean;
}) {
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
      icon: Inbox,
      tone: 'accent',
    },
    {
      key: 'overTarget',
      value: data.attention.overTarget,
      href: '/inbox?filter=waiting',
      icon: Clock,
      tone: 'warn',
    },
    {
      key: 'unassigned',
      value: data.attention.unassigned,
      href: '/inbox?filter=unassigned',
      icon: UserX,
      tone: 'warn',
    },
    {
      key: 'expiring',
      value: data.attention.expiring,
      href: '/inbox?filter=expiring-soon',
      icon: Timer,
      tone: 'warn',
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
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-5">
        {cards.map((card) => (
          <Link key={card.key} href={card.href} className={ATTENTION_ROW}>
            <AttentionIcon icon={card.icon} tone={card.value > 0 ? card.tone : 'none'} />
            <span className="min-w-0 flex-1">
              <span className="text-foreground block text-xl leading-tight font-bold tabular-nums">
                {card.value}
              </span>
              <span className="text-muted-foreground block truncate text-xs">{t(card.key)}</span>
            </span>
            <ChevronRight aria-hidden className={ATTENTION_CHEVRON} />
          </Link>
        ))}
        <a href="#operations-failures" className={ATTENTION_ROW}>
          <AttentionIcon icon={AlertTriangle} tone={data.attention.failed > 0 ? 'bad' : 'none'} />
          <span className="min-w-0 flex-1">
            <span className="text-foreground block text-xl leading-tight font-bold tabular-nums">
              {data.attention.failed}
            </span>
            <span className="text-muted-foreground block truncate text-xs">{t('failed')}</span>
          </span>
          <ChevronRight aria-hidden className={ATTENTION_CHEVRON} />
        </a>
      </div>
      <p className="text-muted-foreground text-xs">
        {t('target', { count: data.replyTargetMinutes })}{' '}
        <Link href="/settings?tab=inbox" className="text-primary font-medium hover:underline">
          {t('editTarget')}
        </Link>
      </p>
      <div className="grid items-stretch gap-3.5 lg:grid-cols-2">
        <Panel title={t('queue')}>
          {!data.queue.length ? (
            <p className="text-muted-foreground text-sm">{t('queueEmpty')}</p>
          ) : (
            <ul className="divide-border divide-y">
              {data.queue.map((item) => (
                <li key={item.id} className="py-2.5">
                  <Link
                    className="text-foreground hover:text-primary font-medium transition-colors duration-150"
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
                    <p className="mt-1.5 flex flex-wrap gap-1 text-xs">
                      {!item.assigned && <span className={SOFT_PILL}>{t('unassigned')}</span>}
                      {item.handedOff && <span className={SOFT_PILL}>{t('handedOff')}</span>}
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
                  <li key={item.id} className="py-2.5">
                    <Link
                      href={`/inbox?c=${encodeURIComponent(item.conversationId)}`}
                      className="text-foreground hover:text-primary font-medium transition-colors duration-150"
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
            <table className="border-border w-full overflow-hidden rounded-lg border text-left text-sm [border-collapse:separate] [border-spacing:0]">
              <thead className="bg-muted text-muted-foreground text-xs">
                <tr>
                  <th className="px-3 py-2 font-semibold">{t('member')}</th>
                  <th className="px-3 py-2 text-right font-semibold">{t('open')}</th>
                  <th className="px-3 py-2 text-right font-semibold">{t('replies')}</th>
                  <th className="px-3 py-2 text-right font-semibold">{t('median')}</th>
                </tr>
              </thead>
              <tbody>
                {data.team.map((member) => (
                  <tr key={member.id} className="hover:bg-muted/50 transition-colors duration-150">
                    <th className="border-border border-t px-3 py-2.5 font-medium">{member.name}</th>
                    <td className="border-border border-t px-3 py-2.5 text-right tabular-nums">{member.open}</td>
                    <td className="border-border border-t px-3 py-2.5 text-right tabular-nums">{member.replies}</td>
                    <td className="border-border border-t px-3 py-2.5 text-right tabular-nums">{minutes(member.medianMinutes)}</td>
                  </tr>
                ))}
                <tr className="hover:bg-muted/50 transition-colors duration-150">
                  <th className="border-border border-t px-3 py-2.5 font-medium">{t('automated')}</th>
                  <td className="border-border border-t px-3 py-2.5 text-right tabular-nums">—</td>
                  <td className="border-border border-t px-3 py-2.5 text-right tabular-nums">{data.automated.replies}</td>
                  <td className="border-border border-t px-3 py-2.5 text-right tabular-nums">{minutes(data.automated.medianMinutes)}</td>
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
                  className="border-border bg-card mt-1 h-9 w-full rounded-lg border px-2.5 text-[13px]"
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
                    <dd className="text-xl font-bold tabular-nums">{selected[key]}</dd>
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
                className="text-primary text-sm font-medium hover:underline"
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
                <dd className="font-semibold tabular-nums">{data.campaigns[key]}</dd>
              </div>
            ))}
          </dl>
          {data.campaigns.topFailingFlow && (
            <p className="text-sm">
              {t('topFailingFlow', { name: data.campaigns.topFailingFlow })}
            </p>
          )}
          <div className="text-primary flex gap-4 text-sm font-medium">
            <Link href="/automations" className="hover:underline">
              {t('automations')}
            </Link>
            <Link href="/flows" className="hover:underline">
              {t('flows')}
            </Link>
          </div>
          <h4 className="border-border border-t pt-3 text-sm font-medium">
            {t('latestBroadcast')}
          </h4>
          {data.latestBroadcast ? (
            <>
              <Link href="/broadcasts" className="text-primary font-medium hover:underline">
                {data.latestBroadcast.name}
              </Link>
              <dl className="grid grid-cols-2 gap-2 text-sm">
                {(['delivered', 'read', 'replied', 'failed'] as const).map(
                  (key) => (
                    <div key={key}>
                      <dt className="text-muted-foreground">{t(key)}</dt>
                      <dd className="font-semibold tabular-nums">{data.latestBroadcast![key]}</dd>
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
            {(Object.keys(setupLinks) as (keyof typeof setupLinks)[]).filter((key) => whatsapp || !WHATSAPP_SETUP.has(key)).map(
              (key) => (
                <li key={key} className="flex justify-between gap-3">
                  <Link
                    href={setupLinks[key]}
                    className="text-foreground hover:text-primary transition-colors duration-150"
                  >
                    {t(`setupItems.${key}`)}
                  </Link>
                  <span
                    className={cn(
                      SOFT_PILL,
                      data.setup[key] && 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-400',
                    )}
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

const ATTENTION_ROW =
  'group border-border bg-card hover:bg-muted/60 flex items-center gap-3 rounded-xl border p-3 transition-colors duration-150';
const ATTENTION_CHEVRON =
  'text-muted-foreground size-4 shrink-0 transition-transform duration-150 group-hover:translate-x-0.5';
const SOFT_PILL = 'bg-muted text-muted-foreground inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium';

const ATTENTION_TONE = {
  accent: 'bg-primary/10 text-primary',
  warn: 'bg-amber-500/12 text-amber-700 dark:text-amber-400',
  bad: 'bg-red-500/12 text-red-600 dark:text-red-400',
  none: 'bg-muted text-muted-foreground',
} as const;

function AttentionIcon({
  icon: Icon,
  tone,
}: {
  icon: typeof Inbox;
  tone: keyof typeof ATTENTION_TONE;
}) {
  return (
    <span
      aria-hidden
      className={cn('flex size-9 shrink-0 items-center justify-center rounded-[10px]', ATTENTION_TONE[tone])}
    >
      <Icon className="size-4" />
    </span>
  );
}
