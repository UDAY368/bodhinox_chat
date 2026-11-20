// Deal actions shared by rules (automations/engine.ts create_deal, move_deal_stage) and flows
// (the Actions step, flows/nodes/actions.ts). Each runs in one tenant transaction on the worker
// connection; the deals_closed_state trigger sets closed_at when a move marks a deal won or lost
// (the same rule the pipeline board relies on), and the deals event trigger records
// deal.stage_changed for a stage move.
import { Prisma } from '@prisma/client';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DEAL_TITLE_MAX = 200;

export type CreateDealOutcome = 'created' | 'exists' | 'stage_invalid';

/**
 * Creates an open deal in the pipeline's stage, in the workspace's default currency. Skipped
 * ('exists') when the contact already has an open deal in that pipeline: a per-contact and
 * pipeline advisory lock makes two concurrent runs create one deal. 'stage_invalid' when the
 * stage is not this workspace's stage of that pipeline.
 */
export async function createDeal(input: {
  accountId: string; userId: string; contactId: string | null;
  pipelineId: string; stageId: string; title: string; value?: number | null;
}): Promise<CreateDealOutcome> {
  if (!UUID.test(input.pipelineId) || !UUID.test(input.stageId)) return 'stage_invalid';
  const value = Number.isFinite(input.value) ? Number(input.value) : 0;
  return withTenant({ accountId: input.accountId, role: 'owner' }, async (tx) => {
    if (input.contactId) {
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`deal:${input.accountId}:${input.contactId}:${input.pipelineId}`}, 0))`);
      const [open] = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id::text FROM deals WHERE account_id=${input.accountId}::uuid
        AND contact_id=${input.contactId}::uuid AND pipeline_id=${input.pipelineId}::uuid AND status='open' LIMIT 1`);
      if (open) return 'exists' as const;
    }
    const inserted = await tx.$executeRaw(Prisma.sql`INSERT INTO deals(account_id, user_id, pipeline_id, stage_id, contact_id, title, value, currency, status)
      SELECT ${input.accountId}::uuid, ${input.userId}::uuid, ${input.pipelineId}::uuid, s.id, ${input.contactId}::uuid,
        ${input.title.slice(0, DEAL_TITLE_MAX)}, ${value},
        COALESCE((SELECT a.default_currency FROM accounts a WHERE a.id=${input.accountId}::uuid), 'USD'), 'open'
      FROM pipeline_stages s WHERE s.account_id=${input.accountId}::uuid AND s.id=${input.stageId}::uuid AND s.pipeline_id=${input.pipelineId}::uuid`);
    return inserted > 0 ? 'created' as const : 'stage_invalid' as const;
  }, getWorkerPrisma());
}

export type MoveDealOutcome = 'moved' | 'unchanged' | 'no_deal' | 'stage_invalid' | 'loop';
export type DealCloseStatus = 'won' | 'lost';

/**
 * Moves the contact's newest open deal in the pipeline to `stageId`, and marks it won or lost
 * when `status` says so (closed_at then comes from the deals_closed_state trigger).
 *
 * Loop guard: a stage move records deal.stage_changed, which can start rules and flows. A move
 * to the stage the deal is already in changes nothing ('unchanged', so no event), and a run that
 * a move of this same deal started (`startedByDealId`) never moves it again ('loop'), so two
 * automations cannot bounce a deal between stages forever.
 */
export async function moveDealStage(input: {
  accountId: string; contactId: string | null; pipelineId: string; stageId: string;
  status?: DealCloseStatus | null; startedByDealId?: string | null;
}): Promise<MoveDealOutcome> {
  if (!input.contactId) return 'no_deal';
  if (!UUID.test(input.pipelineId) || !UUID.test(input.stageId)) return 'stage_invalid';
  const status = input.status === 'won' || input.status === 'lost' ? input.status : null;
  return withTenant({ accountId: input.accountId, role: 'owner' }, async (tx) => {
    const [stage] = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id::text FROM pipeline_stages
      WHERE account_id=${input.accountId}::uuid AND id=${input.stageId}::uuid AND pipeline_id=${input.pipelineId}::uuid`);
    if (!stage) return 'stage_invalid' as const;
    const [deal] = await tx.$queryRaw<{ id: string; stage_id: string }[]>(Prisma.sql`SELECT id::text, stage_id::text FROM deals
      WHERE account_id=${input.accountId}::uuid AND contact_id=${input.contactId}::uuid AND pipeline_id=${input.pipelineId}::uuid
        AND status='open' ORDER BY created_at DESC, id DESC LIMIT 1 FOR UPDATE`);
    if (!deal) return 'no_deal' as const;
    if (input.startedByDealId && deal.id === input.startedByDealId) return 'loop' as const;
    if (deal.stage_id === input.stageId && !status) return 'unchanged' as const;
    await tx.$executeRaw(Prisma.sql`UPDATE deals SET stage_id=${input.stageId}::uuid,
        status=COALESCE(${status}::text, status), updated_at=now()
      WHERE account_id=${input.accountId}::uuid AND id=${deal.id}::uuid`);
    return 'moved' as const;
  }, getWorkerPrisma());
}

/** The deal whose stage move started a run (deal.stage_changed), from the run's event or variables. */
export function dealThatStartedRun(source: { event?: { type: string; data: Record<string, unknown> } | null; vars?: Record<string, unknown> | null }): string | null {
  if (source.event?.type === 'deal.stage_changed' && typeof source.event.data.deal_id === 'string') return source.event.data.deal_id;
  // Flow runs carry the event as variables (src/lib/events/vars.ts): only deal.stage_changed has a deal id.
  const fromVars = source.vars?.event_deal_id;
  return typeof fromVars === 'string' && UUID.test(fromVars) ? fromVars : null;
}
