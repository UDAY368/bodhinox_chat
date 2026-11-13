'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, Sparkles } from 'lucide-react';

import { authFetch } from '@/lib/auth/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Panel, useDuration } from '@/components/analytics/shared';
import { rangeParams, type RangeValue } from '@/components/analytics/range-picker';
import {
  formatMetric, isPending, knownCaveats, reasonKey, shouldPollInsights, templateParams, uncertaintyVariant,
  type InsightKey, type InsightRunView, type MetricFormatters,
} from './insight-view';

const POLL_MS = 3_000;
const selectClass = 'h-9 rounded-lg border border-border bg-card px-2.5 text-[13px] text-foreground transition-colors duration-150 hover:bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

/**
 * Business insights from fixed reporting queries: the numbers, their range,
 * coverage, caveats and uncertainty, with a short narrative. The narrative is
 * written by AI only when the workspace has it available; otherwise it is a
 * summary built from the numbers. Output is shown as plain text.
 */
export function AiInsightsPanel({ range }: { range: RangeValue }) {
  const t = useTranslations('AiInsights');
  const format = useFormatter();
  const duration = useDuration();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [keys, setKeys] = useState<InsightKey[]>([]);
  const [runs, setRuns] = useState<InsightRunView[]>([]);
  const [key, setKey] = useState<InsightKey>('conversation_volume');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (quiet = false) => {
    try {
      const res = await authFetch('/api/ai/insights', { cache: 'no-store' });
      if (res.status === 403) { setForbidden(true); return; }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { if (!quiet) toast.error(data.error ?? t('loadFailed')); return; }
      setEnabled(data.enabled === true);
      setKeys(Array.isArray(data.keys) ? data.keys : []);
      setRuns(Array.isArray(data.runs) ? data.runs : []);
    } catch {
      if (!quiet) toast.error(t('loadFailed'));
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  const polling = shouldPollInsights(runs);
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => { void load(true); }, POLL_MS);
    return () => clearInterval(timer);
  }, [polling, load]);

  const request = async () => {
    setBusy(true);
    try {
      const res = await authFetch('/api/ai/insights', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, ...rangeParams(range) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(data.error ?? t('requestFailed')); return; }
      setRuns((list) => [data.run, ...list.filter((r) => r.id !== data.run.id)]);
    } catch {
      toast.error(t('requestFailed'));
    } finally {
      setBusy(false);
    }
  };

  const formatters: MetricFormatters = useMemo(() => ({
    duration: (s) => duration(s),
    percent: (v) => format.number(v / 100, { style: 'percent', maximumFractionDigits: 1 }),
    money: (v, currency) => format.number(v, { style: 'currency', currency }),
    count: (v) => format.number(v),
    missing: '–',
  }), [duration, format]);

  if (forbidden) return null;

  return (
    <Panel title={t('title')} description={t('description')}>
      {enabled === null ? (
        <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin" aria-label={t('loading')} /></div>
      ) : !enabled ? (
        <p role="status" className="text-sm text-muted-foreground">{t('notEnabled')}</p>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {t('chooseInsight')}
              <select className={selectClass} value={key} onChange={(e) => setKey(e.target.value as InsightKey)}>
                {keys.map((k) => <option key={k} value={k}>{t(`keys.${k}`)}</option>)}
              </select>
            </label>
            <Button type="button" onClick={request} disabled={busy || keys.length === 0}>
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : <Sparkles className="mr-2 h-4 w-4" aria-hidden />}
              {t('generate')}
            </Button>
            <p className="text-xs text-muted-foreground">{t('rangeHint')}</p>
          </div>

          {runs.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('empty')}</p>
          ) : (
            <ul className="space-y-4">
              {runs.map((run) => <InsightRun key={run.id} run={run} formatters={formatters} />)}
            </ul>
          )}
        </div>
      )}
    </Panel>
  );
}

function InsightRun({ run, formatters }: { run: InsightRunView; formatters: MetricFormatters }) {
  const t = useTranslations('AiInsights');
  const format = useFormatter();
  const reason = reasonKey(run.errorCode);
  const data = run.data;
  return (
    <li className="space-y-3 rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-foreground">{t(`keys.${run.key}`)}</span>
        <span className="text-xs text-muted-foreground">{t('range', { from: run.from, to: run.to })}</span>
        <Badge variant={run.status === 'failed' ? 'destructive' : run.status === 'done' ? 'default' : 'secondary'}>
          {isPending(run) && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
          {t(`statuses.${run.status}`)}
        </Badge>
        {run.uncertainty && (
          <Badge variant={uncertaintyVariant(run.uncertainty)}>{t(`uncertainty.${run.uncertainty}`)}</Badge>
        )}
      </div>

      {run.status === 'done' && data && (
        <>
          <div className="space-y-1">
            <Badge variant="outline">{t(run.narrativeSource === 'model' ? 'narrativeModel' : 'narrativeTemplate')}</Badge>
            {/* Rendered as text, never HTML or markdown. */}
            <p className="whitespace-pre-line text-sm text-foreground">
              {run.narrativeSource === 'model' ? run.narrative : t(`templates.${run.key}`, templateParams(data, formatters))}
            </p>
            {run.narrativeSource !== 'model' && reason && <p className="text-xs text-muted-foreground">{t(`reasons.${reason}`)}</p>}
            {run.narrativeSource === 'model' && <p className="text-xs text-muted-foreground">{t('modelNote')}</p>}
          </div>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3 lg:grid-cols-4">
            {Object.entries(data.metrics).map(([name, value]) => (
              <div key={name}>
                <dt className="text-xs text-muted-foreground">{t(`metrics.${name}`)}</dt>
                <dd className="font-medium tabular-nums">{formatMetric(name, value, data.currency, formatters)}</dd>
              </div>
            ))}
          </dl>

          {data.rows && data.rows.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="bg-muted text-muted-foreground">
                    <th className="px-3 py-1.5 font-semibold">{t('rowLabel')}</th>
                    {Object.keys(data.rows[0].values).map((name) => <th key={name} className="px-3 py-1.5 font-semibold">{t(`metrics.${name}`)}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => (
                    <tr key={row.label} className="border-t border-border">
                      <td className="px-3 py-1.5">{row.name ?? row.label}</td>
                      {Object.entries(row.values).map(([name, value]) => (
                        <td key={name} className="px-3 py-1.5 tabular-nums">
                          {formatMetric(name, value, run.key === 'commerce_sales' ? row.label : data.currency, formatters)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            {t('dataNote', {
              from: data.dataFrom, to: data.dataTo, records: format.number(data.rowCount),
              asOf: format.dateTime(new Date(data.asOf), { dateStyle: 'medium', timeStyle: 'short' }),
            })}
            {run.coverage && ` · ${t('coverage', { percent: format.number(run.coverage.ratio, { style: 'percent' }) })}`}
          </p>
          {knownCaveats(run.caveats).length > 0 && (
            <ul className="list-disc space-y-0.5 pl-5 text-xs text-amber-700 dark:text-amber-400">
              {knownCaveats(run.caveats).map((c) => <li key={c}>{t(`caveats.${c}`)}</li>)}
            </ul>
          )}
          {run.sourceLinks.length > 0 && (
            <div className="flex flex-wrap gap-3 text-xs">
              {run.sourceLinks.map((l) => (
                <Link key={l.href + l.key} href={l.href} className="text-primary underline-offset-2 hover:underline">{t('sourceLink')}</Link>
              ))}
            </div>
          )}
        </>
      )}

      {(run.status === 'skipped' || run.status === 'failed') && (
        <p className="text-sm text-muted-foreground">{t(`reasons.${reason ?? 'unknown'}`)}</p>
      )}
    </li>
  );
}
