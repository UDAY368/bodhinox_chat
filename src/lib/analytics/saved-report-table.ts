// Builds a saved report's rows from the grouped metrics engine (insights.ts):
// for the preview in the app (labelled rows), and as a CSV/PDF table for an
// export or a scheduled run (English column headers, like the other report
// kinds). Callers run it inside withTenant with a statement timeout.

import { Prisma } from '@prisma/client';
import type { TenantTransaction } from '@/lib/db/tenant';
import { bucketKeys, type AnalyticsRange } from './range';
import { fillRows, groupedMetrics, type GroupRow, type MetricGroup } from './insights';
import type { SavedMetric, SavedReportSnapshot } from './saved-report-shape';

export interface SavedReportRow {
  /** Day or week start (YYYY-MM-DD), channel, member id, label id or 'none'. */
  key: string;
  /** Member or label name; null for days, weeks and channels (the UI names them). */
  name: string | null;
  values: Partial<Record<SavedMetric, number | null>>;
}

export interface SavedReportData {
  group: SavedReportSnapshot['group'];
  metrics: SavedMetric[];
  rows: SavedReportRow[];
}

const METRIC_VALUE: Record<SavedMetric, (r: GroupRow) => number | null> = {
  new: (r) => r.newC,
  resolved: (r) => r.resolved,
  first_response: (r) => r.frtMedian,
  resolution: (r) => r.resMedian,
  messages: (r) => r.msgs,
  failed: (r) => r.failed,
};

export const METRIC_HEADERS: Record<SavedMetric, string> = {
  new: 'new_conversations',
  resolved: 'resolved',
  first_response: 'median_first_response_seconds',
  resolution: 'median_resolution_seconds',
  messages: 'messages_sent',
  failed: 'failed_messages',
};

/** The rows of a saved report for one range. */
export async function savedReportData(tx: TenantTransaction, accountId: string, report: SavedReportSnapshot,
  range: AnalyticsRange): Promise<SavedReportData> {
  const filters = { channel: report.channel === 'all' ? null : report.channel };
  const group: MetricGroup = report.group;
  const rows = await groupedMetrics(tx, accountId, range, group, filters);
  let filled: { row: GroupRow; name: string | null }[];
  if (report.group === 'day' || report.group === 'week') {
    filled = fillRows(bucketKeys({ ...range, bucket: report.group }), rows).map((row) => ({ row, name: null }));
  } else if (report.group === 'channel') {
    filled = fillRows(report.channel === 'all' ? ['whatsapp', 'instagram'] : [report.channel], rows).map((row) => ({ row, name: null }));
  } else if (report.group === 'agent') {
    // Current members (idle ones with zeros), then anyone else credited in the range (a former member).
    const members = await tx.$queryRaw<{ id: string; name: string | null }[]>(Prisma.sql`
      SELECT am.user_id::text AS id, p.full_name AS name FROM account_memberships am LEFT JOIN profiles p ON p.user_id=am.user_id
      WHERE am.account_id=${accountId}::uuid ORDER BY p.full_name NULLS LAST, am.user_id`);
    const known = new Set(members.map((m) => m.id.toLowerCase()));
    const former = rows.filter((r) => !known.has(r.key.toLowerCase())).map((r) => r.key);
    const names = new Map(members.map((m) => [m.id.toLowerCase(), m.name]));
    if (former.length) {
      const extra = await tx.$queryRaw<{ id: string; name: string | null }[]>`SELECT user_id::text AS id, full_name AS name
        FROM profiles WHERE user_id = ANY(${former}::uuid[])`;
      for (const e of extra) names.set(e.id.toLowerCase(), e.name);
    }
    filled = fillRows([...members.map((m) => m.id), ...former], rows).map((row) => ({ row, name: names.get(row.key.toLowerCase()) ?? null }));
  } else {
    const labels = await tx.$queryRaw<{ id: string; name: string }[]>(Prisma.sql`SELECT id::text AS id, name FROM conversation_labels
      WHERE account_id=${accountId}::uuid ORDER BY name, id`);
    filled = fillRows([...labels.map((l) => l.id), 'none'], rows)
      .map((row) => ({ row, name: labels.find((l) => l.id === row.key)?.name ?? null }));
  }
  return {
    group: report.group,
    metrics: report.metrics,
    rows: filled.map(({ row, name }) => ({
      key: row.key,
      name,
      values: Object.fromEntries(report.metrics.map((m) => [m, METRIC_VALUE[m](row)])),
    })),
  };
}

export interface SavedReportColumn {
  header: string;
  value: (row: SavedReportRow) => unknown;
}

const CHANNEL_NAMES: Record<string, string> = { whatsapp: 'WhatsApp', instagram: 'Instagram' };

/** CSV/PDF columns for a saved report's rows (English headers; times local to `timezone`). */
export function savedReportColumns(data: SavedReportData, timezone: string): SavedReportColumn[] {
  const first: SavedReportColumn =
    data.group === 'day' ? { header: `day (${timezone})`, value: (r) => r.key }
      : data.group === 'week' ? { header: `week_starting (${timezone})`, value: (r) => r.key }
        : data.group === 'channel' ? { header: 'channel', value: (r) => CHANNEL_NAMES[r.key] ?? r.key }
          : data.group === 'agent' ? { header: 'agent', value: (r) => r.name ?? 'former member' }
            : { header: 'label', value: (r) => (r.key === 'none' ? 'no label' : r.name ?? r.key) };
  return [first, ...data.metrics.map((m) => ({ header: METRIC_HEADERS[m], value: (r: SavedReportRow) => r.values[m] ?? '' }))];
}
