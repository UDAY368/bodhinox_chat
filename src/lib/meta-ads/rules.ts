// Automated ad rules (ads gaps, phase 3): "pause (or tell me about) any active
// ad set whose cost per result is above X over the last N days, once it has
// spent at least Y". Admins manage rules; the worker checks them hourly
// against stored insights (meta_ad_insights, refreshed hourly), so a check
// makes no Meta call. Each object is acted on at most once per rule per day.
//
// A pause goes through the existing change pipeline (requestAdChange: budget
// cap, one open change per field, one outbound intent, read-back), as the
// admin who made the rule, and only while they are still an admin. Alerts use
// the automation-notice preference. Thresholds are in each ad account's own
// currency (major units, like the reports).
import { Prisma } from '@prisma/client';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { hasMinRole } from '@/lib/auth/roles';
import { notifyAdsAlert } from '@/lib/notifications/emit';
import { metaAdsConfig, metaAdsManageEnabled } from './config';
import { MetaAdsError, type MetaAdsActor } from './connection';
import { requestAdChange } from './manage';

export const MAX_RULES = 20;
/** Objects one rule may act on per run (a runaway rule cannot pause a whole account at once). */
export const MAX_ACTIONS_PER_RUN = 20;
export const RULE_LEVELS = ['campaign', 'adset', 'ad'] as const;
export const RULE_METRICS = ['cost_per_result', 'spend', 'ctr', 'cpm'] as const;
export const RULE_WINDOWS = [1, 3, 7] as const;
export type RuleLevel = (typeof RULE_LEVELS)[number];
export type RuleMetric = (typeof RULE_METRICS)[number];
export type RuleAction = 'pause' | 'notify';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AdRuleInput {
  name: string;
  level: RuleLevel;
  metric: RuleMetric;
  operator: 'gt' | 'lt';
  threshold: number;
  windowDays: number;
  minSpend: number;
  action: RuleAction;
}

export interface AdRuleDto extends AdRuleInput {
  id: string;
  enabled: boolean;
  lastRunAt: string | null;
  createdAt: string;
}

export interface AdRuleActionDto {
  id: string;
  ruleId: string;
  objectId: string;
  objectName: string | null;
  action: RuleAction;
  outcome: 'queued' | 'notified' | 'skipped';
  value: number | null;
  createdAt: string;
}

interface RuleRow {
  id: string; name: string; level: RuleLevel; metric: RuleMetric; operator: 'gt' | 'lt'; threshold: Prisma.Decimal;
  window_days: number; min_spend: Prisma.Decimal; action: RuleAction; enabled: boolean; last_run_at: Date | null;
  created_by: string; created_at: Date;
}

const RULE_COLUMNS = Prisma.sql`id::text AS id, name, level, metric, operator, threshold, window_days, min_spend, action, enabled,
  last_run_at, created_by::text AS created_by, created_at`;

const dto = (r: RuleRow): AdRuleDto => ({
  id: r.id, name: r.name, level: r.level, metric: r.metric, operator: r.operator, threshold: Number(r.threshold),
  windowDays: r.window_days, minSpend: Number(r.min_spend), action: r.action, enabled: r.enabled,
  lastRunAt: r.last_run_at?.toISOString() ?? null, createdAt: r.created_at.toISOString(),
});

const worker = <T>(accountId: string, work: (tx: TenantTransaction) => Promise<T>, userId?: string) =>
  withTenant({ accountId, userId, role: 'owner' }, work, getWorkerPrisma());

const audit = (tx: TenantTransaction, actor: MetaAdsActor, action: string, resourceId: string, metadata: Record<string, unknown>) =>
  tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
    VALUES(${actor.accountId}::uuid,${actor.userId}::uuid,${action},${resourceId},${JSON.stringify(metadata)}::jsonb)`;

function requireAdmin(actor: MetaAdsActor, action?: RuleAction): void {
  if (!metaAdsConfig()) throw new MetaAdsError('meta_ads_not_enabled');
  if (action === 'pause' && !metaAdsManageEnabled()) throw new MetaAdsError('manage_not_enabled');
  if (!hasMinRole(actor.role, 'admin')) throw new MetaAdsError('forbidden');
}

const amount = (value: unknown, max: number): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? Math.round(value * 10_000) / 10_000 : null;

export function parseAdRuleInput(body: unknown): AdRuleInput | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.trim().replace(/\s+/g, ' ') : '';
  if (!name || name.length > 120) return null;
  if (!RULE_LEVELS.includes(b.level as RuleLevel) || !RULE_METRICS.includes(b.metric as RuleMetric)) return null;
  if (b.operator !== 'gt' && b.operator !== 'lt') return null;
  if (b.action !== 'pause' && b.action !== 'notify') return null;
  if (!RULE_WINDOWS.includes(b.windowDays as 1 | 3 | 7)) return null;
  const threshold = amount(b.threshold, 999_999_999_999);
  const minSpend = b.minSpend === undefined ? 0 : amount(b.minSpend, 999_999_999_999);
  if (threshold === null || minSpend === null) return null;
  // A CTR is a percentage.
  if (b.metric === 'ctr' && threshold > 100) return null;
  return {
    name, level: b.level as RuleLevel, metric: b.metric as RuleMetric, operator: b.operator, threshold,
    windowDays: b.windowDays as number, minSpend, action: b.action,
  };
}

/** The value of a rule's metric for one object's window, or null when it cannot be measured yet. */
export function ruleValue(metric: RuleMetric, totals: { spend: number; impressions: number; clicks: number; results: number }): number | null {
  switch (metric) {
    case 'spend': return totals.spend;
    case 'ctr': return totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : null;
    case 'cpm': return totals.impressions > 0 ? (totals.spend / totals.impressions) * 1000 : null;
    // Spending with no result at all is the worst cost per result.
    case 'cost_per_result': return totals.results > 0 ? totals.spend / totals.results : totals.spend > 0 ? Number.POSITIVE_INFINITY : null;
  }
}

export const ruleMatches = (rule: Pick<AdRuleInput, 'operator' | 'threshold' | 'minSpend'>, spend: number, value: number | null) =>
  value !== null && spend >= rule.minSpend && (rule.operator === 'gt' ? value > rule.threshold : value < rule.threshold);

// ---------------------------------------------------------------------------
// Admin actions

export async function listAdRules(actor: MetaAdsActor): Promise<{ rules: AdRuleDto[]; actions: AdRuleActionDto[] }> {
  return withTenant({ accountId: actor.accountId, userId: actor.userId, role: actor.role }, async (tx) => {
    const rules = await tx.$queryRaw<RuleRow[]>`SELECT ${RULE_COLUMNS} FROM meta_ad_rules
      WHERE account_id=${actor.accountId}::uuid ORDER BY created_at DESC LIMIT ${MAX_RULES}`;
    const actions = await tx.$queryRaw<{ id: string; rule_id: string; object_id: string; object_name: string | null; action: RuleAction;
      outcome: AdRuleActionDto['outcome']; value: Prisma.Decimal | null; created_at: Date }[]>`
      SELECT id::text AS id, rule_id::text AS rule_id, object_id, object_name, action, outcome, value, created_at
      FROM meta_ad_rule_actions WHERE account_id=${actor.accountId}::uuid ORDER BY created_at DESC LIMIT 20`;
    return {
      rules: rules.map(dto),
      actions: actions.map((a) => ({
        id: a.id, ruleId: a.rule_id, objectId: a.object_id, objectName: a.object_name, action: a.action, outcome: a.outcome,
        value: a.value === null ? null : Number(a.value), createdAt: a.created_at.toISOString(),
      })),
    };
  });
}

export async function createAdRule(actor: MetaAdsActor, input: AdRuleInput): Promise<AdRuleDto> {
  requireAdmin(actor, input.action);
  return worker(actor.accountId, async (tx) => {
    const [count] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM meta_ad_rules WHERE account_id=${actor.accountId}::uuid`;
    if ((count?.n ?? 0) >= MAX_RULES) throw new MetaAdsError('limit_reached');
    const [row] = await tx.$queryRaw<RuleRow[]>`INSERT INTO meta_ad_rules(account_id, name, level, metric, operator, threshold,
        window_days, min_spend, action, created_by)
      VALUES(${actor.accountId}::uuid, ${input.name}, ${input.level}, ${input.metric}, ${input.operator}, ${input.threshold},
        ${input.windowDays}, ${input.minSpend}, ${input.action}, ${actor.userId}::uuid)
      RETURNING ${RULE_COLUMNS}`;
    await audit(tx, actor, 'meta_ads.rule_create', row.id, { ...input });
    return dto(row);
  }, actor.userId);
}

export async function setAdRuleEnabled(actor: MetaAdsActor, ruleId: string, enabled: boolean): Promise<AdRuleDto> {
  requireAdmin(actor);
  if (!UUID.test(ruleId)) throw new MetaAdsError('not_found');
  return worker(actor.accountId, async (tx) => {
    const [row] = await tx.$queryRaw<RuleRow[]>`UPDATE meta_ad_rules SET enabled=${enabled}, updated_at=now()
      WHERE account_id=${actor.accountId}::uuid AND id=${ruleId}::uuid RETURNING ${RULE_COLUMNS}`;
    if (!row) throw new MetaAdsError('not_found');
    if (enabled && row.action === 'pause' && !metaAdsManageEnabled()) throw new MetaAdsError('manage_not_enabled');
    await audit(tx, actor, 'meta_ads.rule_update', ruleId, { enabled });
    return dto(row);
  }, actor.userId);
}

export async function deleteAdRule(actor: MetaAdsActor, ruleId: string): Promise<void> {
  requireAdmin(actor);
  if (!UUID.test(ruleId)) throw new MetaAdsError('not_found');
  await worker(actor.accountId, async (tx) => {
    const deleted = await tx.$executeRaw`DELETE FROM meta_ad_rules WHERE account_id=${actor.accountId}::uuid AND id=${ruleId}::uuid`;
    if (!deleted) throw new MetaAdsError('not_found');
    await audit(tx, actor, 'meta_ads.rule_delete', ruleId, {});
  }, actor.userId);
}

// ---------------------------------------------------------------------------
// The hourly check (worker)

const METRIC_LABEL: Record<RuleMetric, string> = { cost_per_result: 'cost per result', spend: 'spend', ctr: 'CTR', cpm: 'CPM' };
const LEVEL_LABEL: Record<RuleLevel, string> = { campaign: 'campaign', adset: 'ad set', ad: 'ad' };
const shown = (metric: RuleMetric, value: number) => (Number.isFinite(value) ? (metric === 'ctr' ? `${value.toFixed(2)}%` : value.toFixed(2)) : 'no results');

/** meta.ad_rules: checks every enabled rule of the workspace once. */
export async function handleAdRulesJob(accountId: string, now: number = Date.now()): Promise<void> {
  if (!metaAdsConfig()) return;
  const day = new Date(now).toISOString().slice(0, 10);
  const rules = await worker(accountId, (tx) => tx.$queryRaw<RuleRow[]>`SELECT ${RULE_COLUMNS} FROM meta_ad_rules
    WHERE account_id=${accountId}::uuid AND enabled ORDER BY created_at LIMIT ${MAX_RULES}`);
  for (const rule of rules) {
    const r = dto(rule);
    const candidates = await worker(accountId, async (tx) => {
      const rows = await tx.$queryRaw<{ object_id: string; name: string | null; spend: Prisma.Decimal | null; impressions: bigint | null;
        clicks: bigint | null; results: bigint | null; acted: boolean }[]>`
        SELECT i.object_id, max(o.name) AS name, sum(i.spend) AS spend, sum(i.impressions) AS impressions, sum(i.clicks) AS clicks,
          sum(COALESCE(i.conversations_started,0) + COALESCE(i.leads,0) + COALESCE(i.purchases,0)) AS results,
          EXISTS (SELECT 1 FROM meta_ad_rule_actions a WHERE a.account_id=${accountId}::uuid AND a.rule_id=${rule.id}::uuid
            AND a.object_id=i.object_id AND a.day=${day}::date) AS acted
        FROM meta_ad_insights i
        JOIN meta_ad_objects o ON o.account_id=i.account_id AND o.object_id=i.object_id AND o.effective_status='ACTIVE'
        WHERE i.account_id=${accountId}::uuid AND i.level=${rule.level}
          AND i.day > (${day}::date - ${rule.window_days}::int)
        GROUP BY i.object_id`;
      await tx.$executeRaw`UPDATE meta_ad_rules SET last_run_at=now() WHERE account_id=${accountId}::uuid AND id=${rule.id}::uuid`;
      return rows;
    });
    const due = candidates.flatMap((c) => {
      if (c.acted) return [];
      const totals = { spend: Number(c.spend ?? 0), impressions: Number(c.impressions ?? 0), clicks: Number(c.clicks ?? 0), results: Number(c.results ?? 0) };
      const value = ruleValue(r.metric, totals);
      return ruleMatches(r, totals.spend, value) ? [{ objectId: c.object_id, name: c.name, value: value! }] : [];
    }).slice(0, MAX_ACTIONS_PER_RUN);

    for (const target of due) {
      let outcome: AdRuleActionDto['outcome'] = 'notified';
      if (r.action === 'pause') {
        outcome = 'skipped';
        const isAdmin = await worker(accountId, async (tx) => (await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n
          FROM account_memberships WHERE account_id=${accountId}::uuid AND user_id=${rule.created_by}::uuid AND role IN ('owner','admin')`)[0]?.n > 0);
        if (isAdmin && metaAdsManageEnabled()) {
          try {
            await requestAdChange({ accountId, userId: rule.created_by, role: 'admin' }, { objectId: target.objectId, field: 'status', value: 'PAUSED' }, now);
            outcome = 'queued';
          } catch (error) {
            // Already paused, a change still open, or the connection is gone: nothing more to do today.
            if (!(error instanceof MetaAdsError)) throw error;
          }
        }
      }
      await worker(accountId, async (tx) => {
        const inserted = await tx.$executeRaw`INSERT INTO meta_ad_rule_actions(account_id, rule_id, object_id, object_name, action, outcome, value, day)
          VALUES(${accountId}::uuid, ${rule.id}::uuid, ${target.objectId}, ${target.name?.slice(0, 400) ?? null}, ${r.action}, ${outcome},
            ${Number.isFinite(target.value) ? target.value : null}, ${day}::date)
          ON CONFLICT (rule_id, object_id, day) DO NOTHING`;
        if (!inserted) return;
        const what = `${LEVEL_LABEL[r.level]} "${(target.name ?? target.objectId).slice(0, 100)}"`;
        await notifyAdsAlert(tx, accountId, {
          title: outcome === 'queued' ? `Rule "${r.name}" paused the ${what}`
            : outcome === 'skipped' ? `Rule "${r.name}" could not pause the ${what}`
            : `Rule "${r.name}": the ${what} needs a look`,
          body: `${METRIC_LABEL[r.metric]} ${shown(r.metric, target.value)} over the last ${r.windowDays} day${r.windowDays === 1 ? '' : 's'}.`,
          dedupeKey: `ad-rule:${rule.id}:${target.objectId}:${day}`,
        });
      });
    }
  }
}

