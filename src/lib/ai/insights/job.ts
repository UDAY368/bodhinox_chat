// 'ai.insight_run': computes one insight run (ai_insight_runs) from a fixed
// reporting query, then a model or template narrative grounded in the
// numbers. Enqueued by POST /api/ai/insights in the same transaction as the
// run row (dedupe 'ai-insight:<run_id>', max_attempts 2).
//
// Steps:
//   1. claim the run (queued or running -> running; anything else ends the job);
//   2. recheck the requester's CURRENT membership: role at least the insight's
//      minimum and agent, 'ai.insights' not restricted, and the workspace's
//      insights switch still on. Otherwise the run ends 'skipped' with
//      error_code no_permission / feature_off and the job returns normally;
//   3. run the fixed query on the worker role, compute coverage, caveats and
//      uncertainty deterministically;
//   4. ask the model for a narrative through runAiTask (deployment switch,
//      config, switch, budget all checked there; numbers JSON only, agent
//      names replaced by "Agent 1..n"). Its text is used only when every
//      number in it is in the data; otherwise, or when the model is
//      unavailable or fails, the template narrative is used and error_code
//      records why. The run is still 'done': it is useful with AI off;
//   5. store everything in one UPDATE.
// Only database errors fail the job; they are retried, and the run is marked
// 'failed' (job_failed) on the last attempt. Nothing here sends anything to a
// customer or writes outside ai_insight_runs.

import type { PrismaClient } from '@prisma/client';
import { can } from '@/lib/auth/permissions';
import { isAccountRole, type AccountRole } from '@/lib/auth/roles';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { ANALYTICS_STATEMENT_TIMEOUT_MS } from '@/lib/analytics/queries';
import { localDay, parseRange, workspaceTimezone } from '@/lib/analytics/range';
import { logAiEvent } from '../log';
import { readAiSettings } from '../settings';
import { runAiTask } from '../task';
import {
  cleanNarrative, groundedNumbers, INSIGHT_PROMPT_VERSION, INSIGHT_SYSTEM_PROMPT, modelInput, restoreNames, templateNarrative,
} from './narrative';
import {
  accountCreatedDay, computeInsight, INSIGHT_SOURCE_LINK, insightAllowed, insightCaveats, insightCoverage, insightUncertainty,
  isInsightKey, type InsightData, type InsightKey,
} from './registry';

export const AI_INSIGHT_JOB = 'ai.insight_run';

export interface InsightJobPayload {
  runId: string;
}

export const insightJobDedupeKey = (runId: string): string => `ai-insight:${runId}`;

export interface InsightJobDeps {
  prisma?: PrismaClient;
  /** The model call (tests pass a fake; production uses runAiTask). */
  runTask?: typeof runAiTask;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FLAGS = 16;

type Claimed = { insight_key: string; range_from: string; range_to: string; requested_by: string };

export async function handleInsightRunJob(
  accountId: string,
  payload: Record<string, unknown>,
  meta: { attempts: number; maxAttempts: number } = { attempts: 1, maxAttempts: 1 },
  deps: InsightJobDeps = {},
): Promise<void> {
  const runId = typeof payload.runId === 'string' && UUID.test(payload.runId) ? payload.runId : null;
  if (!runId) {
    // No retry can fix a malformed payload, and there is no run to mark.
    logAiEvent({ feature: 'insights', reason: 'invalid_payload', accountId });
    return;
  }
  const prisma = deps.prisma ?? getWorkerPrisma();
  const worker = { accountId, role: 'owner' as const };

  // Queued or running only: a run that already finished (or was expired as stale) is never redone.
  const finish = (status: 'skipped' | 'failed', errorCode: string) => withTenant(worker, (tx) => tx.$executeRaw`
    UPDATE ai_insight_runs SET status=${status}, error_code=${errorCode}, completed_at=now()
    WHERE account_id=${accountId}::uuid AND id=${runId}::uuid AND status IN ('queued','running')`, prisma);

  try {
    // 1. Claim (inside the try, so a failed claim on the last attempt still marks the run failed).
    const claimed = (await withTenant(worker, (tx) => tx.$queryRaw<Claimed[]>`
      UPDATE ai_insight_runs SET status='running'
      WHERE account_id=${accountId}::uuid AND id=${runId}::uuid AND status IN ('queued','running')
      RETURNING insight_key, range_from::text AS range_from, range_to::text AS range_to, requested_by::text AS requested_by`, prisma))[0];
    if (!claimed) return; // Finished, skipped, failed or gone.

    // 2. The requester's live membership, permission and the workspace switch.
    const access = await withTenant(worker, async (tx) => {
      const key = claimed.insight_key;
      const member = await tx.$queryRaw<{ role: string }[]>`SELECT role FROM account_memberships
        WHERE account_id=${accountId}::uuid AND user_id=${claimed.requested_by}::uuid`;
      const role = member[0]?.role;
      if (!isInsightKey(key) || !isAccountRole(role) || !insightAllowed(role, key)) return { ok: false as const, reason: 'no_permission' };
      if (!(await can(tx, { accountId, role }, 'ai.insights'))) return { ok: false as const, reason: 'no_permission' };
      if (!(await readAiSettings(tx, accountId)).insights_enabled) return { ok: false as const, reason: 'feature_off' };
      return { ok: true as const, key, role };
    }, prisma);
    if (!access.ok) {
      await finish('skipped', access.reason);
      logAiEvent({ feature: 'insights', reason: `skipped_${access.reason}`, accountId });
      return;
    }
    const key: InsightKey = access.key;
    const role: AccountRole = access.role;

    // 3. The fixed query, on the worker role, with the analytics statement timeout.
    const computed = await withTenant(worker, async (tx) => {
      await tx.$queryRaw`SELECT set_config('statement_timeout', ${String(ANALYTICS_STATEMENT_TIMEOUT_MS)}, true)`;
      const timezone = await workspaceTimezone(tx, accountId);
      const range = parseRange({ preset: 'custom', from: claimed.range_from, to: claimed.range_to, bucket: 'day' }, timezone);
      const createdDay = await accountCreatedDay(tx, accountId, timezone);
      const result = await computeInsight(tx, accountId, key, range);
      return { range, createdDay, today: localDay(new Date(), timezone), result };
    }, prisma);
    const { range, createdDay, today, result } = computed;
    const coverage = insightCoverage(range, createdDay, today);
    const data: InsightData = {
      ...result,
      dataFrom: createdDay > range.startDay && createdDay <= range.endDay ? createdDay : range.startDay,
      dataTo: range.endDay,
      asOf: new Date().toISOString(),
    };
    const caveats = insightCaveats(key, range, data.rowCount, coverage);
    const uncertainty = insightUncertainty(data.rowCount, coverage, caveats);

    // 4. Narrative: the model's when it is available and grounded, else the template.
    let narrative = templateNarrative(key, data);
    let narrativeSource: 'model' | 'template' = 'template';
    let errorCode: string | null = null;
    const flags = new Set<string>();
    const outcome = await (deps.runTask ?? runAiTask)({
      accountId, userId: claimed.requested_by, role, feature: 'insights', promptVersion: INSIGHT_PROMPT_VERSION,
      system: INSIGHT_SYSTEM_PROMPT,
      untrusted: [{ source: 'crm', label: 'metrics', text: modelInput(key, data, caveats, uncertainty) }],
      audience: 'staff', db: prisma,
    });
    for (const f of outcome.guardFlags) flags.add(f);
    if (outcome.ok) {
      const text = cleanNarrative(typeof outcome.value === 'string' ? outcome.value : '');
      if (text && groundedNumbers(text, data)) {
        narrative = cleanNarrative(restoreNames(text, data));
        narrativeSource = 'model';
      } else {
        flags.add('ungrounded_number');
        errorCode = 'ungrounded_number';
      }
    } else {
      errorCode = outcome.reason;
    }

    // 5. Store.
    const links = [{ key, href: INSIGHT_SOURCE_LINK[key] }];
    await withTenant(worker, (tx) => tx.$executeRaw`
      UPDATE ai_insight_runs SET status='done', data=${JSON.stringify(data)}::jsonb, coverage=${JSON.stringify(coverage)}::jsonb,
        caveats=${caveats}::text[], uncertainty=${uncertainty}, narrative=${narrative}, narrative_source=${narrativeSource},
        guard_flags=${[...flags].slice(0, MAX_FLAGS)}::text[], source_links=${JSON.stringify(links)}::jsonb,
        error_code=${errorCode}, completed_at=now()
      WHERE account_id=${accountId}::uuid AND id=${runId}::uuid AND status='running'`, prisma);
    logAiEvent({ feature: 'insights', reason: narrativeSource === 'model' ? 'ok' : `template_${errorCode ?? 'none'}`, accountId, flags: [...flags] });
  } catch (error) {
    logAiEvent({ feature: 'insights', reason: 'job_failed', accountId, error });
    if (meta.attempts >= meta.maxAttempts) await finish('failed', 'job_failed').catch(() => undefined);
    throw error;
  }
}
