import { scheduledSlot } from './schedule';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { createAdminClient } from '@/lib/data/admin';
import {
  processWebhook,
  processInboundActions,
  type InboundActionsPayload,
} from '@/lib/whatsapp/process-webhook';
import {
  expireAwaitingReplies,
  resumePendingExecution,
} from '@/lib/automations/engine';
import {
  executeScheduledOccurrence,
  queueScheduledOccurrence,
} from './scheduled-audience';
import { resolveFallbackPolicy } from '@/lib/flows/fallback';
import { handleFlowTimer, staleSince } from '@/lib/flows/engine';
import {
  deliverBroadcast,
  finalizeBroadcastStatus,
  BroadcastError,
  MAX_THROTTLE_RETRIES,
  throttleDelayMs,
} from '@/lib/whatsapp/broadcast-core';
import {
  planBroadcastResume,
  type ResumeScope,
} from '@/lib/whatsapp/broadcast-resume';
import {
  broadcastDispatchable,
  claimBroadcastStart,
  lockBroadcastDelivery,
  unlockBroadcastDelivery,
} from '@/lib/broadcasts/schedule';
import { withJobScope } from './scope';
import { enqueueJob, type Job } from './queue';
import { deliverQueuedWebhook } from '@/lib/webhooks/deliver';

const uuid = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value))
    throw new Error('Invalid job identifier');
  return value;
};
export async function scheduleWork() {
  const accounts = await getWorkerPrisma().$queryRaw<
    { account_id: string }[]
  >`SELECT * FROM crm_accounts_for_scheduling()`;
  const window = Math.floor(Date.now() / 30_000);
  for (const { account_id } of accounts)
    await enqueueJob(
      'automation.schedule',
      {
        minute: new Date(
          Math.floor(Date.now() / 60_000) * 60_000
        ).toISOString(),
      },
      { tenantId: account_id, dedupeKey: `schedule:${account_id}:${window}` }
    );
}
export async function handleJob(job: Job, assertLease: () => void = () => {}) {
  assertLease();
  if (job.type === 'whatsapp.webhook') {
    const id = uuid(job.payload.receiptId);
    const rows = await getWorkerPrisma().$queryRaw<
      { payload: Parameters<typeof processWebhook>[0]; status: string }[]
    >`SELECT payload,status FROM webhook_receipts WHERE id=${id}::uuid`;
    if (!rows[0] || rows[0].status === 'processed') return;
    await processWebhook(rows[0].payload, assertLease);
    await getWorkerPrisma()
      .$executeRaw`UPDATE webhook_receipts SET status='processed' WHERE id=${id}::uuid`;
    return;
  }
  const accountId = uuid(job.tenant_id);
  return withJobScope({ accountId, role: 'owner' }, async () => {
    const db = createAdminClient({ accountId, role: 'owner' });
    if (job.type === 'inbound.actions') {
      if (job.payload.accountId !== accountId)
        throw new Error('Inbound job tenant mismatch');
      await processInboundActions(
        job.payload as unknown as InboundActionsPayload,
        assertLease
      );
    } else if (job.type === 'broadcast.dispatch') {
      const broadcastId = uuid(job.payload.broadcastId);
      const scope: ResumeScope =
        job.payload.scope === 'failed' || job.payload.scope === 'all'
          ? job.payload.scope
          : 'pending';
      // Consecutive throttled passes so far; drives backoff and the retry cap.
      const throttles = Number.isInteger(job.payload.throttles) ? (job.payload.throttles as number) : 0;
      // A cancelled campaign, or one scheduled for later, sends nothing.
      if (!(await broadcastDispatchable(accountId, broadcastId))) return;
      if (!(await lockBroadcastDelivery(accountId, broadcastId))) {
        // Another pass is running; try again shortly instead of sending in parallel.
        await enqueueJob('broadcast.dispatch', job.payload, {
          tenantId: accountId,
          runAt: new Date(Date.now() + 60_000),
          dedupeKey: `broadcast:${broadcastId}:wait:${job.id}`,
        });
        return;
      }
      try {
        const { plan, remaining } = await planBroadcastResume(
          db,
          accountId,
          broadcastId,
          scope
        );
        // Claimed only once the plan succeeded, so a planning error leaves the status as it was.
        if (!(await claimBroadcastStart(accountId, broadcastId))) return;
        const result = await deliverBroadcast(db, plan, {
          accountId,
          assertLease,
          headerMediaUrl:
            typeof job.payload.headerMediaUrl === 'string'
              ? job.payload.headerMediaUrl
              : undefined,
          attemptId: job.id,
          // Only intents Meta definitively refused (4xx, e.g. throttled) are re-sent;
          // an uncertain outcome still waits for reconciliation.
          retryRejected: true,
        });
        if (result.throttled) {
          const next = result.sent > 0 ? 1 : throttles + 1;
          // Still throttled after about an hour with no progress: stop and leave the rest
          // pending, so the campaign shows as stalled and an agent can resume it.
          if (next > MAX_THROTTLE_RETRIES) {
            console.error('[worker] broadcast paused after repeated throttling', { broadcastId });
            // Stays 'sending' while recipients are pending (shown as stalled); otherwise settles.
            await finalizeBroadcastStatus(db, broadcastId);
            return;
          }
          await enqueueJob(
            'broadcast.dispatch',
            { ...job.payload, scope, throttles: next },
            {
              tenantId: accountId,
              runAt: new Date(Date.now() + throttleDelayMs(next)),
              dedupeKey: `broadcast:${broadcastId}:throttled:${job.id}`,
            }
          );
          return;
        }
        if (remaining > 0)
          await enqueueJob(
            'broadcast.dispatch',
            { ...job.payload, scope: 'pending', throttles: 0 },
            {
              tenantId: accountId,
              requeueCompleted: true,
              dedupeKey: `broadcast:${broadcastId}:next:${job.id}`,
            }
          );
      } catch (error) {
        if (
          error instanceof BroadcastError &&
          error.code === 'nothing_to_resume'
        ) {
          await finalizeBroadcastStatus(db, broadcastId);
          return;
        }
        throw error;
      } finally {
        await unlockBroadcastDelivery(accountId, broadcastId);
      }
    } else if (job.type === 'automation.trigger') {
      await executeScheduledOccurrence(
        db,
        accountId,
        uuid(job.payload.automationId),
        String(job.payload.slot),
        job.payload.contactId === undefined
          ? undefined
          : uuid(job.payload.contactId),
        assertLease
      );
    } else if (job.type === 'automation.resume') {
      const id = uuid(job.payload.pendingId);
      const { data: pending, error } = await db
        .from('automation_pending_executions')
        .select('*')
        .eq('id', id)
        .single();
      if (error) throw new Error('Could not load pending automation');
      if (!pending || !['pending', 'running'].includes(pending.status)) return;
      const update = await db
        .from('automation_pending_executions')
        .update({ status: 'running' })
        .eq('id', id);
      if (update.error) throw new Error('Could not claim pending automation');
      await resumePendingExecution(pending);
    } else if (job.type === 'automation.schedule') {
      await expireAwaitingReplies();
      const { data: schedules, error: scheduleError } = await db
        .from('automations')
        .select('id,trigger_config')
        .eq('trigger_type', 'time_based')
        .eq('is_active', true);
      if (scheduleError) throw new Error('Automation schedule lookup failed');
      const minute =
        typeof job.payload.minute === 'string'
          ? new Date(job.payload.minute)
          : new Date();
      for (const automation of schedules ?? []) {
        const config = automation.trigger_config ?? {};
        const slot =
          typeof config.schedule === 'string'
            ? scheduledSlot(
                config.schedule,
                config.timezone || process.env.AUTOMATION_TIMEZONE || 'UTC',
                minute
              )
            : null;
        if (slot)
          await queueScheduledOccurrence(
            db,
            accountId,
            automation,
            slot,
            assertLease
          );
      }
      const { data: due, error } = await db
        .from('automation_pending_executions')
        .select('id')
        .eq('status', 'pending')
        .lte('run_at', new Date().toISOString())
        .limit(100);
      if (error) throw new Error('Scheduling read failed');
      for (const row of due ?? [])
        await enqueueJob(
          'automation.resume',
          { pendingId: row.id },
          { tenantId: accountId, dedupeKey: `automation:${row.id}` }
        );
      await sweepFlows(db);
    } else if (job.type === 'flow.sweep') await sweepFlows(db);
    else if (job.type === 'flow.timer') {
      const { nodeKey, seq, kind } = job.payload;
      if (typeof nodeKey !== 'string' || !Number.isInteger(seq) || (kind !== 'delay' && kind !== 'timeout'))
        throw new Error('Invalid flow timer contract');
      await handleFlowTimer({ accountId, runId: uuid(job.payload.runId), nodeKey, seq: seq as number, kind });
    }
    else if (job.type === 'webhook.delivery')
      await deliverQueuedWebhook(db, accountId, job.payload);
    else throw new Error('Unsupported job type');
  });
}
async function sweepFlows(db: ReturnType<typeof createAdminClient>) {
  const { data: runs, error } = await db
    .from('flow_runs')
    .select('id,last_advanced_at,delay_until,flows(fallback_policy)')
    .eq('status', 'active')
    .limit(500);
  if (error) throw new Error('Flow sweep failed');
  for (const run of runs ?? []) {
    const flow = Array.isArray(run.flows) ? run.flows[0] : run.flows;
    if (
      Date.now() - Date.parse(staleSince(run)) <
      resolveFallbackPolicy(flow?.fallback_policy).on_timeout_hours * 3_600_000
    )
      continue;
    const { data: updated, error: updateError } = await db
      .from('flow_runs')
      .update({
        status: 'timed_out',
        ended_at: new Date().toISOString(),
        end_reason: 'stale_sweep',
      })
      .eq('id', run.id)
      .eq('status', 'active')
      .select('id');
    if (updateError) throw new Error('Flow timeout update failed');
    if (updated?.length)
      await db
        .from('flow_run_events')
        .insert({
          flow_run_id: run.id,
          event_type: 'timeout',
          payload: { reason: 'stale_sweep' },
        });
  }
}
