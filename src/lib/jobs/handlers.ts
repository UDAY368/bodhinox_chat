import { payloadRange, scheduledSlotsBetween, scheduleRange } from './schedule';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { createAdminClient } from '@/lib/data/admin';
import {
  processWebhook,
  processInboundActions,
  retryProviderStatus,
  type InboundActionsPayload,
} from '@/lib/whatsapp/process-webhook';
import {
  expireAwaitingReplies,
  resumePendingExecution,
} from '@/lib/automations/engine';
import {
  executeScheduledOccurrence,
  queueScheduledOccurrence,
  recordSkippedOccurrence,
  ScheduledAudienceError,
} from './scheduled-audience';
import { resolveFallbackPolicy } from '@/lib/flows/fallback';
import { handleFlowReplay, handleFlowTimer, staleSince } from '@/lib/flows/engine';
import { withTenant } from '@/lib/db/tenant';
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
  prepareFailedRetry,
  unlockBroadcastDelivery,
} from '@/lib/broadcasts/schedule';
import { broadcastHalted } from '@/lib/broadcasts/pause';
import { broadcastChannel, deliverInstagramBroadcast } from '@/lib/broadcasts/instagram';
import { NUMBER_DISCONNECTED_REASON } from '@/lib/whatsapp/number-admin';
import { withJobScope } from './scope';
import { enqueueJob, type Job } from './queue';
import { deliverQueuedWebhook } from '@/lib/webhooks/deliver';
import { HEALTH_SYNC_JOB, scheduleHealthSync, syncNumberHealth } from '@/lib/whatsapp/health-sync';
import { COMMERCE_EVENT_JOB, handleCommerceEventJob } from '@/lib/commerce/event-rules';
import { handleInboxJob, isInboxJob, scheduleInboxSweeps } from '@/lib/inbox/jobs';
import { isAppointmentJobType } from '@/lib/appointments/types';
import { NOTIFICATION_DIGEST_JOB, scheduleNotificationDigests, sendNotificationDigest } from '@/lib/notifications/digest';

const uuid = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value))
    throw new Error('Invalid job identifier');
  return value;
};
/** A job's attempt/version counter: a positive integer, else the contract is invalid. */
const counter = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('Invalid job counter');
  return value as number;
};
/** A version number: a positive integer. */
const positive = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error('Invalid job counter');
  return value as number;
};
export async function scheduleWork() {
  const prisma = getWorkerPrisma();
  const accounts = await prisma.$queryRaw<
    { account_id: string }[]
  >`SELECT * FROM crm_accounts_for_scheduling()`;
  const now = Date.now();
  const window = Math.floor(now / 30_000);
  // Cron minutes since the last one queued, so a busy, restarting or deploying worker misses none
  // (bounded; slots are deduplicated, so an overlap never fires twice).
  // Unreadable (e.g. code running before its migration): the current minute alone, as before.
  const last = await prisma.$queryRaw<{ last_minute: Date }[]>`
    SELECT last_minute FROM worker_schedule_state WHERE name='automation.schedule'`
    .catch(() => { console.error('[worker] schedule state unavailable; scheduling the current minute only'); return null; });
  const range = scheduleRange(last?.[0]?.last_minute ?? null, now);
  if (range.missed > 0)
    console.error('[worker] automation schedule gap longer than the catch-up window', { skippedMinutes: range.missed });
  for (const { account_id } of accounts)
    await enqueueJob(
      'automation.schedule',
      { minute: range.to.toISOString(), from: range.from.toISOString() },
      { tenantId: account_id, dedupeKey: `schedule:${account_id}:${window}` }
    );
  // Advanced only after every workspace's job is queued; a failure re-covers the range next time.
  if (last)
    await prisma.$executeRaw`INSERT INTO worker_schedule_state(name,last_minute) VALUES('automation.schedule',${range.to})
      ON CONFLICT(name) DO UPDATE SET last_minute=GREATEST(worker_schedule_state.last_minute,EXCLUDED.last_minute),updated_at=NOW()`;
  // Number health every six hours; its failure must not stop automation scheduling.
  await scheduleHealthSync().catch(() => console.error('[worker] health sync scheduling failed'));
  // Inbox SLA and auto-resolve sweeps; likewise independent.
  await scheduleInboxSweeps().catch(() => console.error('[worker] inbox sweep scheduling failed'));
  // Due reminders and scheduled replies (Stage 4): one job per workspace with something due.
  await import('@/lib/inbox/follow-up-jobs').then((m) => m.scheduleFollowUpSweeps())
    .catch(() => console.error('[worker] inbox follow-up scheduling failed'));
  // Notification email digests every 30 minutes per workspace; nothing while SMTP is not configured.
  await scheduleNotificationDigests().catch(() => console.error('[worker] notification digest scheduling failed'));
  // Billing grace expiry, trial ends, scheduled changes and unconfirmed provider calls; nothing while billing is off.
  await import('@/lib/billing/subscriptions').then((m) => m.scheduleBillingSweeps())
    .catch(() => console.error('[worker] billing sweep scheduling failed'));
  // Hourly expiry of 30-day-old report files.
  await import('@/lib/analytics/reports').then((m) => m.scheduleReportSweeps())
    .catch(() => console.error('[worker] report sweep scheduling failed'));
  // Scheduled report delivery: every 5 minutes, one job per workspace with a due schedule.
  await import('@/lib/analytics/report-schedules').then((m) => m.scheduleReportSchedules())
    .catch(() => console.error('[worker] report schedule scheduling failed'));
  // Meta ads insights and lead backfill; nothing while META_ADS_ENABLED is off or unconfigured.
  await import('@/lib/meta-ads/schedule').then((m) => m.scheduleMetaAds())
    .catch(() => console.error('[worker] meta ads scheduling failed'));
  // Customer payments: every 10 minutes per workspace, reconcile unknown links and refunds (never re-sends).
  await import('@/lib/payments/reconcile-sweep').then((m) => m.scheduleReconcileSweeps())
    .catch(() => console.error('[worker] payment reconcile scheduling failed'));
  // Zoom meetings and Shiprocket shipments: every 30 minutes, only for workspaces with a live connection and open work.
  await import('@/lib/fulfilment/sweep').then((m) => m.scheduleFulfilmentSweeps())
    .catch(() => console.error('[worker] fulfilment sweep scheduling failed'));
  // Instagram token refresh and health, daily per workspace with a live account; nothing while INSTAGRAM_ENABLED is off.
  await import('@/lib/instagram/token-sweep').then((m) => m.scheduleInstagramSweeps())
    .catch(() => console.error('[worker] instagram sweep scheduling failed'));
  // Stage 3: subscribe accounts connected earlier to live_comments, once per workspace; nothing while the flag is off.
  await import('@/lib/instagram/resubscribe').then((m) => m.scheduleInstagramResubscribe())
    .catch(() => console.error('[worker] instagram resubscribe scheduling failed'));
  // Instagram AI comment replies: every 5 minutes per workspace with AI comment work; nothing while Instagram or AI is off.
  await import('@/lib/instagram/ai-comments').then((m) => m.scheduleAiCommentSweeps())
    .catch(() => console.error('[worker] instagram ai comment scheduling failed'));
  // Sequences (Stage 5): every 30 seconds, one job per workspace with a due message; nothing while Instagram is off.
  await import('@/lib/sequences/jobs').then((m) => m.scheduleSequenceSweeps())
    .catch(() => console.error('[worker] sequence scheduling failed'));
  // AI assistant data retention: daily per workspace with something due.
  await import('@/lib/ai/retention').then((m) => m.scheduleAiRetention())
    .catch(() => console.error('[worker] ai retention scheduling failed'));
  // SaaS billing: daily provider-state comparison per subscribed workspace (opens reconciliation
  // items, changes nothing); nothing while billing is off.
  await import('@/lib/billing/reconciliation').then((m) => m.scheduleBillingReconcile())
    .catch(() => console.error('[worker] billing reconcile scheduling failed'));
  // Usage ledger housekeeping (settled/released rows older than 13 months); independent of billing keys.
  await import('@/lib/jobs/usage-housekeeping').then((m) => m.scheduleUsageHousekeeping())
    .catch(() => console.error('[worker] usage housekeeping scheduling failed'));
  // Workspace exports: expire ready files after 7 days and fail stuck exports.
  await import('@/lib/jobs/workspace-export').then((m) => m.scheduleWorkspaceExportSweeps())
    .catch(() => console.error('[worker] workspace export sweep scheduling failed'));
  // Hourly retention: done/failed jobs, processed webhook receipts and old realtime events.
  await import('@/lib/jobs/data-retention').then((m) => m.scheduleDataRetention())
    .catch(() => console.error('[worker] data retention scheduling failed'));
  // Closed workspaces past their grace period: a dry run unless WORKSPACE_PURGE_ENABLED=true.
  await import('@/lib/privacy/workspace-purge').then((m) => m.scheduleWorkspacePurges())
    .catch(() => console.error('[worker] workspace purge scheduling failed'));
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
  if (job.type === 'billing.event')
    // One verified billing webhook event; the workspace is resolved from its subscription.
    return (await import('@/lib/billing/subscriptions')).handleBillingEventJob(job.payload);
  if (job.type === 'meta.page_webhook')
    // One verified Page webhook delivery; each leadgen change is resolved to its workspace by Page id.
    return (await import('@/lib/meta-ads/jobs')).handleMetaPageWebhookJob(job.payload, assertLease);
  if (job.type === 'instagram.webhook')
    // One verified Instagram webhook delivery; each entry is resolved to its workspace by entry[].id.
    return (await import('@/lib/instagram/jobs')).handleInstagramWebhookJob(job.payload, assertLease);
  if (job.type === 'data.retention_sweep') {
    await (await import('@/lib/jobs/data-retention')).runDataRetentionSweep();
    return;
  }
  if (job.type === 'workspace.purge_storage')
    // Stored files of an already purged workspace (its row, and so its tenant, is gone).
    return (await import('@/lib/privacy/workspace-purge')).runWorkspacePurgeStorage(job.payload);
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
    } else if (job.type === 'whatsapp.status_retry') {
      await retryProviderStatus(accountId, job.payload);
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
        // A member's Pause is read between recipients; a paused pass leaves the rest pending.
        const shouldStop = () => broadcastHalted(accountId, broadcastId);
        if ((await broadcastChannel(accountId, broadcastId)) === 'instagram') {
          // Instagram: free text inside each recipient's 24-hour window (lib/broadcasts/instagram).
          if (!(await claimBroadcastStart(accountId, broadcastId))) return;
          const pass = await deliverInstagramBroadcast(accountId, broadcastId, scope, { assertLease, shouldStop });
          if (pass.stopped) return;
          if (pass.remaining > 0 && scope === 'pending')
            await enqueueJob('broadcast.dispatch', { broadcastId, scope: 'pending' }, {
              tenantId: accountId,
              requeueCompleted: true,
              dedupeKey: `broadcast:${broadcastId}:next:${job.id}`,
            });
          await finalizeBroadcastStatus(db, broadcastId);
          return;
        }
        // One "Retry failed" request: rows Meta failed after accepting them get a new send.
        if (scope !== 'pending' && job.payload.retryId !== undefined)
          await prepareFailedRetry(accountId, broadcastId, uuid(job.payload.retryId));
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
          shouldStop,
        });
        // Paused by a member: the rest stays pending until Resume queues the next pass.
        if (result.stopped) return;
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
          // This request's retry generation is already applied: the follow-up pass must not
          // apply it again after a newer "Retry failed" request has run in the meantime.
          const { retryId: _applied, ...followUp } = job.payload;
          void _applied;
          await enqueueJob(
            'broadcast.dispatch',
            { ...followUp, scope, throttles: next },
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
        if (
          error instanceof BroadcastError &&
          error.code === NUMBER_DISCONNECTED_REASON
        ) {
          // Held, not failed: its number was disconnected. Planning failed before the
          // start claim, so the status is unchanged and no recipient was touched; no
          // retry is burnt and nothing moves to another number. Resume once reconnected.
          console.warn('[worker] broadcast held', { broadcastId, reason: NUMBER_DISCONNECTED_REASON });
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
      // Gated on the status: a row the contacts consent trigger expired since the read stays expired.
      const update = await db
        .from('automation_pending_executions')
        .update({ status: 'running' })
        .eq('id', id)
        .in('status', ['pending', 'running'])
        .select('id');
      if (update.error) throw new Error('Could not claim pending automation');
      if (!update.data?.length) return;
      await resumePendingExecution(pending);
    } else if (job.type === 'automation.schedule') {
      await expireAwaitingReplies();
      const { data: schedules, error: scheduleError } = await db
        .from('automations')
        .select('id,user_id,name,trigger_config,created_at')
        .eq('trigger_type', 'time_based')
        .eq('is_active', true);
      if (scheduleError) throw new Error('Automation schedule lookup failed');
      // Every minute this pass covers: the payload's minute, plus any the scheduler caught up.
      const { from, to } = payloadRange(job.payload);
      const current = to.toISOString();
      // One automation's failure must not cost the others their occurrence,
      // nor the wait-step resumes and flow sweep below.
      let retryable: unknown = null;
      for (const automation of schedules ?? []) {
        const config = automation.trigger_config ?? {};
        if (typeof config.schedule !== 'string') continue;
        // A caught-up minute from before the automation existed never fires it; the payload's own
        // minute is evaluated as before.
        const created = Date.parse(automation.created_at ?? '');
        const createdMinute = Number.isNaN(created) ? 0 : Math.floor(created / 60_000) * 60_000;
        const slots = scheduledSlotsBetween(
          config.schedule,
          config.timezone || process.env.AUTOMATION_TIMEZONE || 'UTC',
          from,
          to
        ).filter((slot) => slot === current || Date.parse(slot) >= createdMinute);
        for (const slot of slots) {
          try {
            await queueScheduledOccurrence(db, accountId, automation, slot, assertLease);
          } catch (error) {
            if (error instanceof ScheduledAudienceError)
              await recordSkippedOccurrence(db, accountId, automation, slot, error.message);
            else {
              // Transient: the job retries this range; queued triggers dedupe per contact and slot.
              console.error('[automations] scheduled occurrence failed', { automationId: automation.id });
              retryable ??= error;
            }
          }
        }
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
      await sweepFlows(db, accountId);
      if (retryable) throw retryable;
    } else if (job.type === 'flow.sweep') await sweepFlows(db, accountId);
    else if (job.type === 'flow.timer') {
      const { nodeKey, seq, kind } = job.payload;
      if (typeof nodeKey !== 'string' || !Number.isInteger(seq) || (kind !== 'delay' && kind !== 'timeout'))
        throw new Error('Invalid flow timer contract');
      await handleFlowTimer({ accountId, runId: uuid(job.payload.runId), nodeKey, seq: seq as number, kind });
    }
    else if (job.type === 'flow.replay') {
      // A member-approved replay of a failed run's node (queued with the run's seq bump); stale replays are no-ops.
      const { seq, nodeKey } = job.payload;
      if ((job.payload.accountId !== undefined && job.payload.accountId !== accountId)
        || (seq !== undefined && !Number.isSafeInteger(seq)) || (nodeKey !== undefined && typeof nodeKey !== 'string'))
        throw new Error('Invalid flow replay contract');
      await handleFlowReplay({ accountId, runId: uuid(job.payload.runId), seq: seq as number | undefined, nodeKey: nodeKey as string | undefined });
    }
    else if (job.type === 'webhook.delivery')
      await deliverQueuedWebhook(db, accountId, job.payload, job.attempts);
    else if (job.type === HEALTH_SYNC_JOB)
      // Meta failures are recorded on the number and retried next cycle, not thrown.
      await syncNumberHealth({ accountId, configId: uuid(job.payload.configId) });
    else if (job.type === COMMERCE_EVENT_JOB)
      // One template send per store event; an ambiguous outcome waits for reconciliation.
      await handleCommerceEventJob(accountId, job.payload);
    else if (isInboxJob(job.type))
      // SLA breach alerts, auto-resolve and unanswered-conversation reassignment.
      await handleInboxJob(accountId, job.type, job.payload);
    else if (job.type === 'commerce.catalog_sync') await (await import('@/lib/commerce/catalog-sync')).handleCatalogSyncJob(accountId, job.payload);
    else if (job.type === 'commerce.catalog_push')
      // Price and availability of linked variants to the Meta catalogue (queued by stock / price triggers and after each sync).
      await (await import('@/lib/commerce/catalog-push')).handleCatalogPushJob(accountId);
    else if (job.type === NOTIFICATION_DIGEST_JOB)
      // Entries are claimed before sending; only a provably undelivered email is retried.
      await sendNotificationDigest(accountId);
    else if (job.type === 'payments.razorpay_event')
      // One verified Razorpay delivery: link status; a paid link is settled only after an authoritative fetch.
      await (await import('@/lib/payments/links')).handlePaymentEventJob(accountId, job.payload);
    else if (job.type === 'payments.cancel_link')
      // Cancels the Razorpay link a flow run left unpaid when it ended (queued by the flow_runs trigger).
      await (await import('@/lib/payments/links')).handleCancelLinkJob(accountId, job.payload);
    else if (job.type === 'billing.lifecycle_sweep')
      await (await import('@/lib/billing/subscriptions')).runLifecycleSweep(accountId);
    else if (job.type === 'billing.email')
      await (await import('@/lib/billing/billing-notify')).sendBillingEmail(accountId, job.payload);
    else if (job.type === 'ai.crawl_source')
      // One time-boxed slice of a knowledge-source crawl or re-index; queues its own continuation.
      await (await import('@/lib/ai/knowledge-sources')).handleCrawlSourceJob(accountId, job.payload);
    else if (job.type === 'analytics.report' || job.type === 'analytics.report_sweep')
      // Builds one CSV or PDF report into private storage, or expires old report files.
      await (await import('@/lib/analytics/reports')).handleReportJob(accountId, job.type, job.payload, { attempts: job.attempts, maxAttempts: job.max_attempts });
    else if (job.type === 'analytics.report_schedules')
      // Due report schedules: rechecks the creator, inserts one run per period (idempotent) and queues its build.
      await (await import('@/lib/analytics/report-schedules')).runReportSchedules(accountId);
    else if (job.type === 'commerce.prepare_whatsapp_order')
      // Reprice a WhatsApp cart from the Bodhinox catalogue and send its checkout link once.
      await (await import('@/lib/commerce/checkout')).prepareWhatsAppOrderJob(accountId, { orderId: uuid(job.payload.orderId) });
    else if (job.type === 'commerce.create_checkout_link')
      // The placed order's payment link (skipped unless still awaiting payment without a live link).
      await (await import('@/lib/commerce/checkout')).createCheckoutLinkJob(accountId,
        { orderId: uuid(job.payload.orderId), attempt: counter(job.payload.attempt) });
    else if (job.type === 'commerce.reservation_expiry')
      // Release the stock and coupon of an unpaid order whose hold ended, then cancel its link.
      await (await import('@/lib/commerce/checkout')).expireReservation(accountId,
        { orderId: uuid(job.payload.orderId), attempt: counter(job.payload.attempt) });
    else if (job.type === 'commerce.issue_receipt')
      await (await import('@/lib/commerce/documents')).handleIssueReceiptJob(accountId, { paymentId: uuid(job.payload.paymentId) });
    else if (job.type === 'commerce.issue_credit_note')
      await (await import('@/lib/commerce/documents')).handleIssueCreditNoteJob(accountId, { refundId: uuid(job.payload.refundId) });
    else if (job.type === 'commerce.order_followup') {
      // Every kind the follow-up module declares (Phase 9 adds repeat_purchase there).
      const followup = await import('@/lib/commerce/order-followup');
      const kind = job.payload.kind;
      if (typeof kind !== 'string' || !(followup.ORDER_FOLLOWUP_KINDS as readonly string[]).includes(kind))
        throw new Error('Invalid order follow-up kind');
      await followup.handleOrderFollowupJob(accountId,
        { orderId: uuid(job.payload.orderId), kind: kind as (typeof followup.ORDER_FOLLOWUP_KINDS)[number] },
        { attempts: job.attempts, maxAttempts: job.max_attempts });
    }
    else if (job.type === 'appointments.meeting_sync')
      // Zoom meeting create/update/delete for one appointment version; claimed, an ambiguous create is reconciled, never repeated.
      await (await import('@/lib/meetings/sync')).handleMeetingSyncJob(accountId,
        { appointmentId: uuid(job.payload.appointmentId), version: positive(job.payload.version) },
        { attempts: job.attempts, maxAttempts: job.max_attempts });
    else if (job.type === 'meetings.zoom_event')
      // One verified, minimised Zoom event: attendance evidence only, never an appointment status.
      await (await import('@/lib/meetings/attendance')).handleZoomEventJob(accountId, job.payload);
    else if (job.type === 'commerce.create_shipment')
      // Staff-requested Shiprocket shipment (spends the wallet); claimed, an ambiguous create or AWB is reconciled, never repeated.
      await (await import('@/lib/fulfilment/shipments')).handleCreateShipmentJob(accountId,
        { shipmentId: uuid(job.payload.shipmentId) }, { attempts: job.attempts, maxAttempts: job.max_attempts });
    else if (job.type === 'commerce.shipment_track')
      // Re-fetches tracking with the workspace's own token; only re-fetched data changes state.
      await (await import('@/lib/fulfilment/tracking-job')).handleShipmentTrackJob(accountId, { shipmentId: uuid(job.payload.shipmentId) });
    else if (job.type === 'fulfilment.sweep')
      await (await import('@/lib/fulfilment/sweep')).runFulfilmentSweep(accountId);
    else if (job.type === 'payments.refund')
      // One refund send, claimed requested -> sending first; an ambiguous outcome is reconciled, never re-sent.
      await (await import('@/lib/payments/refunds')).handleRefundJob(accountId,
        { refundId: uuid(job.payload.refundId), attempt: counter(job.payload.attempt) });
    else if (job.type === 'payments.reconcile_sweep')
      await (await import('@/lib/payments/reconcile-sweep')).runReconcileSweep(accountId);
    else if (job.type === 'appointments.payment_link')
      // A paid public hold's payment link (created and sent once); confirmation waits for settlement.
      await (await import('@/lib/appointments/paid')).handleAppointmentPaymentLinkJob(accountId,
        { appointmentId: uuid(job.payload.appointmentId), version: counter(job.payload.version) },
        { attempts: job.attempts, maxAttempts: job.max_attempts });
    else if (isAppointmentJobType(job.type))
      // Reminders, customer notices, staff/automation/webhook fan-out, hold expiry and follow-up.
      // Each re-checks the appointment version, so a superseded job is a no-op.
      await (await import('@/lib/appointments/job-handlers')).handleAppointmentJob(accountId, job.type, job.payload, { attempts: job.attempts, maxAttempts: job.max_attempts });
    else if (job.type === 'ai.assess_conversation')
      // Advisory intent and lead assessment; writes only ai_assessments, never sends.
      await (await import('@/lib/ai/assess/job')).handleAssessConversationJob(accountId, job.payload, { attempts: job.attempts, maxAttempts: job.max_attempts, jobId: job.id });
    else if (job.type === 'ai.auto_reply_retry')
      // An inbound text the account-wide AI rate limit deferred; the dispatch re-checks
      // that it is still the newest readable message and that no person took over,
      // under the inbound's stage checkpoint so a re-leased job never sends twice.
      await (await import('@/lib/ai/auto-reply')).handleAutoReplyRetryJob(accountId, job.payload, assertLease);
    else if (job.type === 'ai.auto_label')
      // Adds up to two of the workspace's labels to a new conversation; never sends.
      await (await import('@/lib/ai/auto-label')).handleAutoLabelJob(accountId, job.payload);
    else if (job.type === 'ai.insight_run')
      // One insight run from a fixed reporting query; skipped (not failed) when AI is unavailable.
      await (await import('@/lib/ai/insights/job')).handleInsightRunJob(accountId, job.payload, { attempts: job.attempts, maxAttempts: job.max_attempts });
    else if (job.type === 'ai.retention_sweep')
      await (await import('@/lib/ai/retention')).runAiRetentionSweep(accountId);
    else if (job.type === 'billing.reconcile')
      // Compares the provider's subscription state with the stored row; a difference opens a
      // state_mismatch reconciliation item. Never writes the subscription, never closes an intent.
      await (await import('@/lib/billing/reconciliation')).runBillingReconcile(accountId);
    else if (job.type === 'usage.housekeeping')
      await (await import('@/lib/jobs/usage-housekeeping')).runUsageHousekeeping(accountId);
    else if (job.type === 'workspace.export' || job.type === 'workspace.export_sweep')
      // One streamed workspace export into private storage, or the 7-day expiry sweep.
      await (await import('@/lib/jobs/workspace-export')).handleWorkspaceExportJob(accountId, job.type, job.payload, { attempts: job.attempts, maxAttempts: job.max_attempts });
    else if (job.type === 'workspace.purge')
      // Re-checked under row locks; deletes nothing unless WORKSPACE_PURGE_ENABLED=true.
      await (await import('@/lib/privacy/workspace-purge')).runWorkspacePurge(accountId);
    else if (job.type === 'contact.erase')
      // Per-contact erasure requested by an admin; every step is idempotent.
      await (await import('@/lib/privacy/contact-erasure')).runContactErasure(accountId, job.payload, job.id);
    else if (job.type === 'api.start_flow')
      // Public API start-flow request (Stage 5): ids re-checked in the tenant; the request id makes a retry a duplicate, never a second run.
      await (await import('@/lib/api/v1/start-flow')).handleApiStartFlowJob(accountId, job.payload);
    else if (job.type === 'sequences.due')
      // Due sequence messages (Stage 5): claimed per subscription, 24-hour window re-checked before each send.
      await (await import('@/lib/sequences/jobs')).handleSequenceJob(accountId);
    else if (job.type.startsWith('instagram.'))
      // Token sweep, profile fetch and comment private replies; each returns early while Instagram is off.
      await (await import('@/lib/instagram/jobs')).handleInstagramJob(accountId, job.type, job.payload, { attempts: job.attempts, maxAttempts: job.max_attempts });
    else if (job.type.startsWith('meta.'))
      // Click-to-WhatsApp ads: lead fetch/backfill, insights sync and Conversions API sends.
      await (await import('@/lib/meta-ads/jobs')).handleMetaAdsJob(accountId, job.type, job.payload, { attempts: job.attempts, maxAttempts: job.max_attempts });
    else throw new Error('Unsupported job type');
  });
}
async function sweepFlows(db: ReturnType<typeof createAdminClient>, accountId: string) {
  const { data: runs, error } = await db
    .from('flow_runs')
    .select('id,last_advanced_at,delay_until,wait_until,flow_version_id,flows(fallback_policy)')
    .eq('status', 'active')
    .limit(500);
  if (error) throw new Error('Flow sweep failed');
  // A run pinned to a published version times out by that version's policy (COALESCE with the live flow's for unpinned runs).
  const versionIds = [...new Set((runs ?? []).map((r) => r.flow_version_id).filter((v): v is string => typeof v === 'string'))];
  const versionPolicy = new Map<string, unknown>();
  if (versionIds.length)
    for (const v of await withTenant({ accountId, role: 'owner' }, (tx) => tx.$queryRaw<{ id: string; fallback_policy: unknown }[]>`
      SELECT id::text AS id, fallback_policy FROM flow_versions WHERE account_id=${accountId}::uuid AND id = ANY(${versionIds}::uuid[])`,
    getWorkerPrisma()))
      versionPolicy.set(v.id, v.fallback_policy);
  for (const run of runs ?? []) {
    const flow = Array.isArray(run.flows) ? run.flows[0] : run.flows;
    const policy = (run.flow_version_id && versionPolicy.get(run.flow_version_id)) ?? flow?.fallback_policy;
    if (
      Date.now() - Date.parse(staleSince(run)) <
      resolveFallbackPolicy(policy).on_timeout_hours * 3_600_000
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
