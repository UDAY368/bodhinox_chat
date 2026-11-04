// Checks run when an automation is saved, beyond the pure config validation
// in validate.ts: they read the workspace (other automations, secrets,
// segments) or the network (the webhook destination).

import { NextResponse } from 'next/server';
import type { DataClient } from '@/lib/data/types';
import { toErrorResponse, type AccountContext } from '@/lib/auth/account';
import { requirePermission } from '@/lib/auth/permissions';
import { tenantOf } from '@/lib/audience/http';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { canonicalJson } from '@/lib/flows/api-request';
import { secretAttributeKeys } from '@/lib/workspace/attributes';
import { isDeliverableUrl } from '@/lib/webhooks/ssrf';
import { loadSegmentFilter } from '@/lib/audience/segments';
import { AudienceFilterError } from '@/lib/audience/filter';
import { getT } from '@/lib/i18n/translate';
import {
  allSteps,
  findAutomationCycles,
  webhookStepUsesSecrets,
  type LoopCandidate,
  type ValidationIssue,
} from './validate';

const t = getT('Validation.automations');

interface CheckedStep {
  id?: string;
  step_type: string;
  step_config: Record<string, unknown>;
  branches?: { yes?: CheckedStep[]; no?: CheckedStep[] };
}

/**
 * The tag_added loop the candidate would close with the workspace's other
 * active automations, as automation names (first = last = the candidate), or
 * null. Only automations that add a tag can start one, so others are read
 * only then.
 */
export async function automationLoopChain(
  db: DataClient,
  accountId: string,
  candidate: LoopCandidate
): Promise<string[] | null> {
  const adds = allSteps(candidate.steps).some((s) => s.step_type === 'add_tag');
  if (!adds) return null;
  const { data: rows, error } = await db
    .from('automations')
    .select('id,name,trigger_type,trigger_config')
    .eq('account_id', accountId)
    .eq('is_active', true);
  if (error) throw new Error('Automation loop check failed');
  const others = ((rows ?? []) as { id: string; name: string; trigger_type: string; trigger_config: unknown }[])
    .filter((row) => row.id !== candidate.id);
  if (!others.length) return findAutomationCycles(candidate, []);
  const { data: steps, error: stepsError } = await db
    .from('automation_steps')
    .select('automation_id,step_type,step_config')
    .in('automation_id', others.map((o) => o.id))
    .eq('step_type', 'add_tag');
  if (stepsError) throw new Error('Automation loop check failed');
  const byAutomation = new Map<string, CheckedStep[]>();
  for (const step of (steps ?? []) as (CheckedStep & { automation_id: string })[]) {
    byAutomation.set(step.automation_id, [...(byAutomation.get(step.automation_id) ?? []), step]);
  }
  return findAutomationCycles(
    candidate,
    others.map((o) => ({ ...o, steps: byAutomation.get(o.id) ?? [] }))
  );
}

/**
 * Whether `steps` add or change a send_webhook step that uses a secret
 * workspace value, compared with the stored steps. A non-admin may keep an
 * admin's step but not add or edit one: it could send the secret anywhere.
 * Mirrors the flow API step rule.
 */
export async function addsSecretWebhook(
  accountId: string,
  steps: readonly CheckedStep[],
  stored: readonly CheckedStep[]
): Promise<boolean> {
  if (!allSteps(steps).some((s) => s.step_type === 'send_webhook')) return false;
  const secrets = await secretAttributeKeys(accountId);
  if (!secrets.size) return false;
  const key = (s: CheckedStep) => JSON.stringify([s.id ?? null, canonicalJson(s.step_config ?? {})]);
  const kept = new Set(allSteps(stored).filter((s) => webhookStepUsesSecrets(s, secrets)).map(key));
  return allSteps(steps).some((s) => webhookStepUsesSecrets(s, secrets) && !kept.has(key(s)));
}

/** Webhook destinations that resolve to a private or reserved address, checked on the literal URL. */
export async function webhookDestinationIssues(steps: readonly CheckedStep[]): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  for (const step of allSteps(steps)) {
    const url = step.step_config?.url;
    if (step.step_type !== 'send_webhook' || typeof url !== 'string' || !url.trim()) continue;
    if (!(await isDeliverableUrl(url))) issues.push({ path: 'steps.send_webhook.url', message: t('webhookUrlNotAllowed') });
  }
  return issues;
}

/** A scheduled segment audience must name a segment of this workspace that the plan has not archived. */
export async function segmentAudienceIssues(
  tenant: TenantContext,
  triggerType: string,
  triggerConfig: unknown
): Promise<ValidationIssue[]> {
  const audience = (triggerConfig as { audience?: { type?: unknown; segmentId?: unknown } } | null)?.audience;
  if (triggerType !== 'time_based' || audience?.type !== 'segment' || typeof audience.segmentId !== 'string') return [];
  try {
    // lock: also refuses a segment the plan archived, which every occurrence would refuse.
    await withTenant(tenant, (tx) => loadSegmentFilter(tx, tenant.accountId, audience.segmentId as string, { lock: true }));
    return [];
  } catch (error) {
    if (!(error instanceof AudienceFilterError)) throw error;
    return [{ path: 'trigger.audience', message: t('segmentUnavailable') }];
  }
}

const tApi = getT('Api');

/** The 422 for a save that would close a tag_added loop. */
export function loopRefusal(chain: readonly string[]): NextResponse {
  const message = tApi('automations.automationLoop', { chain: chain.join(' → ') });
  return NextResponse.json({ error: message, issues: [{ path: 'steps', message }] }, { status: 422 });
}

/**
 * Checks for a save that leaves the automation active (create and PATCH):
 * the automations.publish permission, deliverable webhook destinations, a
 * segment audience of this workspace, and no tag_added loop with the other
 * active automations. Returns the refusal (403, 400 or 422), or null.
 */
export async function publishChecks(
  ctx: AccountContext,
  accountId: string,
  candidate: LoopCandidate & { steps: readonly CheckedStep[] }
): Promise<NextResponse | null> {
  try {
    await requirePermission(tenantOf(ctx), 'automations.publish');
    const issues = [
      ...(await webhookDestinationIssues(candidate.steps)),
      ...(await segmentAudienceIssues(tenantOf(ctx), candidate.trigger_type, candidate.trigger_config)),
    ];
    if (issues.length > 0) {
      return NextResponse.json({ error: tApi('automations.invalidActivateConfig'), issues }, { status: 400 });
    }
    const chain = await automationLoopChain(ctx.db, accountId, candidate);
    if (chain) return loopRefusal(chain);
    return null;
  } catch (err) {
    return toErrorResponse(err);
  }
}
