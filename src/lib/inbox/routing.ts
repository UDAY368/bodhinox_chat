import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { teamExists, teamMemberIds } from '@/lib/teams/teams';

/**
 * Routing rules (routing_rules): when a customer message leaves a conversation
 * unassigned and not handled by a bot, the first enabled rule (by position)
 * whose conditions all match assigns it, to one member or round robin over a
 * list. A rule with reassign_after_minutes hands a still-unanswered
 * conversation to the next member on its list after that long (the
 * inbox.reassign job, see src/lib/inbox/jobs.ts).
 *
 * Admins manage rules through /api/inbox/routing-rules as themselves (RLS
 * admin write). The worker only reads rules and advances the round-robin
 * position. Only owners, admins and agents can receive conversations; a member
 * who left or became a viewer is skipped.
 */

import {
  MAX_KEYWORD_LENGTH, MAX_KEYWORDS, MAX_REASSIGN_MINUTES, MAX_ROUND_ROBIN_MEMBERS, MAX_ROUTING_RULES, MAX_RULE_NAME, MAX_TAG_CONDITIONS,
  type AssignTo, type RoutingConditions, type RoutingRule, type RoutingRuleInput,
} from './routing-contract';

export * from './routing-contract';

export type RoutingErrorCode =
  | 'invalid_name' | 'invalid_conditions' | 'invalid_assignee' | 'invalid_reassign' | 'invalid_order'
  | 'unknown_tag' | 'unknown_member' | 'unknown_number' | 'unknown_team' | 'limit' | 'not_found';

export class RoutingRuleError extends Error {
  constructor(readonly code: RoutingErrorCode, readonly status: 400 | 404 | 409 = 400) {
    super(code);
    this.name = 'RoutingRuleError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function uuidList(value: unknown, max: number): string[] | null {
  if (!Array.isArray(value) || value.length > max || !value.every(isUuid)) return null;
  return [...new Set(value.map((id) => id.toLowerCase()))];
}

/** Lower-cased, NFKC-normalised, whitespace-collapsed text for keyword matching. */
export function normalizeKeywordText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function parseConditions(value: unknown): RoutingConditions | null {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) return null;
  const allowed = new Set(['tags_any', 'keywords_any', 'whatsapp_config_id', 'within_working_hours']);
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;
  const out: RoutingConditions = {};
  if (value.tags_any !== undefined) {
    const tags = uuidList(value.tags_any, MAX_TAG_CONDITIONS);
    if (!tags) return null;
    if (tags.length) out.tags_any = tags;
  }
  if (value.keywords_any !== undefined) {
    if (!Array.isArray(value.keywords_any) || value.keywords_any.length > MAX_KEYWORDS) return null;
    const keywords: string[] = [];
    for (const keyword of value.keywords_any) {
      if (typeof keyword !== 'string') return null;
      const normalized = normalizeKeywordText(keyword);
      if (normalized.length > MAX_KEYWORD_LENGTH) return null;
      if (normalized && !keywords.includes(normalized)) keywords.push(normalized);
    }
    if (keywords.length) out.keywords_any = keywords;
  }
  if (value.whatsapp_config_id !== undefined && value.whatsapp_config_id !== null) {
    if (!isUuid(value.whatsapp_config_id)) return null;
    out.whatsapp_config_id = value.whatsapp_config_id.toLowerCase();
  }
  if (value.within_working_hours !== undefined && value.within_working_hours !== null) {
    if (typeof value.within_working_hours !== 'boolean') return null;
    out.within_working_hours = value.within_working_hours;
  }
  return out;
}

export function parseAssignTo(value: unknown): AssignTo | null {
  if (!isObject(value)) return null;
  if (value.mode === 'member') return isUuid(value.user_id) ? { mode: 'member', user_id: value.user_id.toLowerCase() } : null;
  if (value.mode === 'round_robin') {
    const ids = uuidList(value.user_ids, MAX_ROUND_ROBIN_MEMBERS);
    return ids && ids.length ? { mode: 'round_robin', user_ids: ids } : null;
  }
  if (value.mode === 'team') return isUuid(value.team_id) ? { mode: 'team', team_id: value.team_id.toLowerCase() } : null;
  return null;
}

/** Validate a create/update body. Throws RoutingRuleError with a field code. */
export function parseRoutingRuleInput(body: unknown): RoutingRuleInput {
  if (!isObject(body)) throw new RoutingRuleError('invalid_name');
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > MAX_RULE_NAME) throw new RoutingRuleError('invalid_name');
  const conditions = parseConditions(body.conditions);
  if (!conditions) throw new RoutingRuleError('invalid_conditions');
  const assignTo = parseAssignTo(body.assign_to);
  if (!assignTo) throw new RoutingRuleError('invalid_assignee');
  const reassign = body.reassign_after_minutes ?? null;
  if (reassign !== null && (!Number.isInteger(reassign) || (reassign as number) < 1 || (reassign as number) > MAX_REASSIGN_MINUTES))
    throw new RoutingRuleError('invalid_reassign');
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new RoutingRuleError('invalid_conditions');
  return { name, enabled: body.enabled !== false, conditions, assign_to: assignTo, reassign_after_minutes: reassign as number | null };
}

/** Rule rows read from the database: anything malformed matches nothing. */
export function readRule(row: { conditions: unknown; assign_to: unknown }): { conditions: RoutingConditions; assignTo: AssignTo } | null {
  const conditions = parseConditions(row.conditions);
  const assignTo = parseAssignTo(row.assign_to);
  return conditions && assignTo ? { conditions, assignTo } : null;
}

export interface RoutingContext {
  tagIds: ReadonlySet<string>;
  text: string;
  whatsappConfigId: string | null;
  withinWorkingHours: boolean;
}

/** Every condition present must hold; a rule without conditions matches everything. */
export function ruleMatches(conditions: RoutingConditions, context: RoutingContext): boolean {
  if (conditions.tags_any?.length && !conditions.tags_any.some((id) => context.tagIds.has(id))) return false;
  if (conditions.keywords_any?.length) {
    const text = normalizeKeywordText(context.text);
    if (!conditions.keywords_any.some((keyword) => text.includes(keyword))) return false;
  }
  if (conditions.whatsapp_config_id && conditions.whatsapp_config_id !== context.whatsappConfigId?.toLowerCase()) return false;
  if (conditions.within_working_hours !== undefined && conditions.within_working_hours !== context.withinWorkingHours) return false;
  return true;
}

/** Members named directly by the rule; a team rule names none until resolved (resolveAssignTo). */
export function ruleMembers(assignTo: AssignTo): string[] {
  if (assignTo.mode === 'team') return [];
  return assignTo.mode === 'member' ? [assignTo.user_id] : assignTo.user_ids;
}

/** A team target becomes a round robin over the team's current members; other targets are unchanged. */
export async function resolveAssignTo(tx: TenantTransaction, accountId: string, assignTo: AssignTo): Promise<AssignTo> {
  if (assignTo.mode !== 'team') return assignTo;
  return { mode: 'round_robin', user_ids: await teamMemberIds(tx, accountId, assignTo.team_id) };
}

/**
 * The next member to receive a conversation: the eligible member after
 * `last` in list order (wrapping), or the first eligible one.
 */
export function pickAssignee(assignTo: AssignTo, eligible: ReadonlySet<string>, last: string | null): string | null {
  const list = ruleMembers(assignTo).filter((id) => eligible.has(id));
  if (!list.length) return null;
  if (assignTo.mode !== 'round_robin') return list[0];
  const all = assignTo.user_ids;
  const start = last ? all.indexOf(last.toLowerCase()) : -1;
  for (let step = 1; step <= all.length; step++) {
    const candidate = all[(start + step + all.length) % all.length];
    if (eligible.has(candidate)) return candidate;
  }
  return list[0];
}

/** The member after `current` for a reassignment; never `current` itself. */
export function nextReassignee(assignTo: AssignTo, eligible: ReadonlySet<string>, current: string): string | null {
  const all = ruleMembers(assignTo);
  const start = all.indexOf(current.toLowerCase());
  for (let step = 1; step <= all.length; step++) {
    const candidate = all[(start + step + all.length) % all.length];
    if (candidate !== current.toLowerCase() && eligible.has(candidate)) return candidate;
  }
  return null;
}

/** Members who can own conversations (owner/admin/agent), among `ids`. */
export async function eligibleMembers(tx: TenantTransaction, accountId: string, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await tx.$queryRaw<{ user_id: string }[]>`SELECT user_id::text AS user_id FROM account_memberships
    WHERE account_id=${accountId}::uuid AND user_id=ANY(${ids}::uuid[]) AND role IN ('owner','admin','agent')`;
  return new Set(rows.map((row) => row.user_id.toLowerCase()));
}

// ---------------------------------------------------------------- admin CRUD

type RuleRow = {
  id: string; name: string; position: number; enabled: boolean; conditions: unknown; assign_to: unknown;
  reassign_after_minutes: number | null; created_at: Date; updated_at: Date;
};

function toRule(row: RuleRow): RoutingRule {
  return {
    id: row.id,
    name: row.name,
    position: row.position,
    enabled: row.enabled,
    conditions: parseConditions(row.conditions) ?? {},
    assign_to: parseAssignTo(row.assign_to) ?? { mode: 'round_robin', user_ids: [] },
    reassign_after_minutes: row.reassign_after_minutes,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

async function selectRules(tx: TenantTransaction, accountId: string): Promise<RuleRow[]> {
  return tx.$queryRaw<RuleRow[]>`SELECT id::text AS id,name,position,enabled,conditions,assign_to,reassign_after_minutes,created_at,updated_at
    FROM routing_rules WHERE account_id=${accountId}::uuid ORDER BY position,created_at,id`;
}

/** Tags, numbers and members a rule names must belong to this workspace. */
async function assertReferences(tx: TenantTransaction, accountId: string, input: RoutingRuleInput): Promise<void> {
  const tags = input.conditions.tags_any ?? [];
  if (tags.length) {
    const found = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM tags
      WHERE account_id=${accountId}::uuid AND id=ANY(${tags}::uuid[])`;
    if (found[0]?.n !== tags.length) throw new RoutingRuleError('unknown_tag');
  }
  if (input.conditions.whatsapp_config_id) {
    const found = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM whatsapp_config
      WHERE account_id=${accountId}::uuid AND id=${input.conditions.whatsapp_config_id}::uuid`;
    if (!found.length) throw new RoutingRuleError('unknown_number');
  }
  if (input.assign_to.mode === 'team') {
    if (!(await teamExists(tx, accountId, input.assign_to.team_id))) throw new RoutingRuleError('unknown_team');
    return;
  }
  const members = ruleMembers(input.assign_to);
  if ((await eligibleMembers(tx, accountId, members)).size !== members.length) throw new RoutingRuleError('unknown_member');
}

export async function listRoutingRules(tenant: TenantContext): Promise<RoutingRule[]> {
  return (await withTenant(tenant, (tx) => selectRules(tx, tenant.accountId))).map(toRule);
}

export async function createRoutingRule(tenant: TenantContext, input: RoutingRuleInput): Promise<RoutingRule> {
  return withTenant(tenant, async (tx) => {
    // Serialises concurrent creates so the count and the next position hold.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`routing_rules:${tenant.accountId}`}, 0))`;
    const existing = await tx.$queryRaw<{ n: number; next: number }[]>`SELECT count(*)::int AS n, COALESCE(max(position)+1,0)::int AS next
      FROM routing_rules WHERE account_id=${tenant.accountId}::uuid`;
    if ((existing[0]?.n ?? 0) >= MAX_ROUTING_RULES) throw new RoutingRuleError('limit', 409);
    await assertReferences(tx, tenant.accountId, input);
    const rows = await tx.$queryRaw<RuleRow[]>`INSERT INTO routing_rules(account_id,name,position,enabled,conditions,assign_to,reassign_after_minutes)
      VALUES(${tenant.accountId}::uuid,${input.name},${existing[0]?.next ?? 0},${input.enabled},${JSON.stringify(input.conditions)}::jsonb,
        ${JSON.stringify(input.assign_to)}::jsonb,${input.reassign_after_minutes})
      RETURNING id::text AS id,name,position,enabled,conditions,assign_to,reassign_after_minutes,created_at,updated_at`;
    return toRule(rows[0]);
  });
}

export async function updateRoutingRule(tenant: TenantContext, id: string, input: RoutingRuleInput): Promise<RoutingRule> {
  if (!isUuid(id)) throw new RoutingRuleError('not_found', 404);
  return withTenant(tenant, async (tx) => {
    await assertReferences(tx, tenant.accountId, input);
    const rows = await tx.$queryRaw<RuleRow[]>`UPDATE routing_rules SET name=${input.name},enabled=${input.enabled},
        conditions=${JSON.stringify(input.conditions)}::jsonb,assign_to=${JSON.stringify(input.assign_to)}::jsonb,
        reassign_after_minutes=${input.reassign_after_minutes}
      WHERE account_id=${tenant.accountId}::uuid AND id=${id}::uuid
      RETURNING id::text AS id,name,position,enabled,conditions,assign_to,reassign_after_minutes,created_at,updated_at`;
    if (!rows.length) throw new RoutingRuleError('not_found', 404);
    return toRule(rows[0]);
  });
}

export async function deleteRoutingRule(tenant: TenantContext, id: string): Promise<void> {
  if (!isUuid(id)) throw new RoutingRuleError('not_found', 404);
  const deleted = await withTenant(tenant, (tx) => tx.$executeRaw`DELETE FROM routing_rules
    WHERE account_id=${tenant.accountId}::uuid AND id=${id}::uuid`);
  if (!deleted) throw new RoutingRuleError('not_found', 404);
}

export function parseRuleOrder(body: unknown): string[] {
  const ids = isObject(body) ? uuidList(body.ids, MAX_ROUTING_RULES) : null;
  if (!ids || !ids.length || ids.length !== (body as { ids: unknown[] }).ids.length) throw new RoutingRuleError('invalid_order');
  return ids;
}

/** Sets positions 0..n-1 in the given order; the list must name every rule exactly once. */
export async function reorderRoutingRules(tenant: TenantContext, ids: string[]): Promise<RoutingRule[]> {
  return withTenant(tenant, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`routing_rules:${tenant.accountId}`}, 0))`;
    const current = await selectRules(tx, tenant.accountId);
    const known = new Set(current.map((row) => row.id.toLowerCase()));
    if (ids.length !== known.size || !ids.every((id) => known.has(id))) throw new RoutingRuleError('invalid_order');
    await tx.$executeRaw`UPDATE routing_rules r SET position=o.ord-1
      FROM unnest(${ids}::uuid[]) WITH ORDINALITY AS o(id,ord)
      WHERE r.account_id=${tenant.accountId}::uuid AND r.id=o.id AND r.position<>o.ord-1`;
    return (await selectRules(tx, tenant.accountId)).map(toRule);
  });
}

// ---------------------------------------------------------------- worker routing

export interface RouteResult {
  ruleId: string;
  assignee: string;
  reassignAfterMinutes: number | null;
}

/**
 * Picks an assignee for an unassigned conversation from the enabled rules in
 * position order. Runs in the worker's tenant transaction; the caller writes
 * the assignment. Locks the winning rule row so concurrent inbounds advance a
 * round robin one step each.
 */
export async function pickRoutingRule(
  tx: TenantTransaction,
  accountId: string,
  context: RoutingContext,
): Promise<RouteResult | null> {
  const rules = await tx.$queryRaw<{ id: string; conditions: unknown; assign_to: unknown; reassign_after_minutes: number | null }[]>`
    SELECT id::text AS id,conditions,assign_to,reassign_after_minutes FROM routing_rules
    WHERE account_id=${accountId}::uuid AND enabled ORDER BY position,created_at,id LIMIT ${MAX_ROUTING_RULES}`;
  for (const rule of rules) {
    const parsed = readRule(rule);
    if (!parsed || !ruleMatches(parsed.conditions, context)) continue;
    const locked = await tx.$queryRaw<{ last: string | null }[]>`SELECT round_robin_last_user_id::text AS last FROM routing_rules
      WHERE account_id=${accountId}::uuid AND id=${rule.id}::uuid AND enabled FOR UPDATE`;
    if (!locked.length) continue;
    const assignTo = await resolveAssignTo(tx, accountId, parsed.assignTo);
    const eligible = await eligibleMembers(tx, accountId, ruleMembers(assignTo));
    const assignee = pickAssignee(assignTo, eligible, locked[0].last);
    // A matching rule whose members all left (or whose team is empty or gone) falls through to the next rule.
    if (!assignee) continue;
    if (assignTo.mode === 'round_robin')
      await tx.$executeRaw`UPDATE routing_rules SET round_robin_last_user_id=${assignee}::uuid
        WHERE account_id=${accountId}::uuid AND id=${rule.id}::uuid`;
    return { ruleId: rule.id, assignee, reassignAfterMinutes: rule.reassign_after_minutes };
  }
  return null;
}

// ---------------------------------------------------------------- reassignment

export const REASSIGN_JOB = 'inbox.reassign';
/** Hand-offs per conversation cycle before it stays with the last member. */
export const MAX_REASSIGNS = 10;

export interface ReassignPayload {
  conversationId: string;
  ruleId: string;
  /** The member it was given to; the job does nothing if that changed. */
  assignee: string;
  /** conversations.reopened_count when it was assigned. */
  cycle: number;
  attempt: number;
  /** When it was given to `assignee` (database clock, ISO): a member's reply from then on answers it. */
  assignedAt: string;
}

/**
 * Queue the check that hands the conversation on if it is still unanswered at
 * `runAt`. Inserted in the caller's worker transaction, so it commits with the
 * assignment; the dedupe key makes a replay a no-op.
 */
export async function queueReassign(tx: TenantTransaction, input: ReassignPayload & { accountId: string; runAt: Date }): Promise<void> {
  const payload: ReassignPayload = {
    conversationId: input.conversationId, ruleId: input.ruleId, assignee: input.assignee, cycle: input.cycle, attempt: input.attempt,
    assignedAt: input.assignedAt,
  };
  // Per assignment: a later routing in the same cycle (after an unassign) queues its own check.
  const dedupeKey = `inbox-reassign:${input.conversationId}:${input.cycle}:${input.attempt}:${Date.parse(input.assignedAt)}`;
  await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,run_at,max_attempts)
    VALUES(${REASSIGN_JOB},${input.accountId}::uuid,${JSON.stringify(payload)}::jsonb,${dedupeKey},${input.runAt},3)
    ON CONFLICT(dedupe_key) DO NOTHING`;
}

export function parseReassignPayload(payload: Record<string, unknown>): ReassignPayload {
  const { conversationId, ruleId, assignee, cycle, attempt, assignedAt } = payload;
  if (!isUuid(conversationId) || !isUuid(ruleId) || !isUuid(assignee) || !Number.isInteger(cycle) || (cycle as number) < 0
    || !Number.isInteger(attempt) || (attempt as number) < 0 || typeof assignedAt !== 'string' || assignedAt.length > 40
    || !Number.isFinite(Date.parse(assignedAt))) throw new Error('Invalid reassign job contract');
  return {
    conversationId, ruleId, assignee: assignee.toLowerCase(), cycle: cycle as number, attempt: attempt as number,
    assignedAt: new Date(assignedAt).toISOString(),
  };
}

export type ReassignOutcome = 'reassigned' | 'stale' | 'rule_off' | 'no_member';

/**
 * Worker: if the conversation is still with `assignee`, open, in the same
 * cycle and no member has replied since it was assigned, give it to the next
 * eligible member on the rule (the assignment trigger notifies them) and queue
 * the next check. A reply from before the assignment (an earlier hand-off in
 * the same cycle) does not count, so first_responded_at is not the test.
 */
export async function runReassign(accountId: string, raw: Record<string, unknown>, now: Date = new Date()): Promise<ReassignOutcome> {
  const job = parseReassignPayload(raw);
  return withTenant({ accountId, role: 'owner' }, async (tx) => {
    const conversation = await tx.$queryRaw<{ status: string; assigned_agent_id: string | null; reopened_count: number; answered: boolean }[]>`
      SELECT c.status,c.assigned_agent_id::text AS assigned_agent_id,c.reopened_count,
        EXISTS(SELECT 1 FROM messages m WHERE m.account_id=c.account_id AND m.conversation_id=c.id
          AND m.sender_type='agent' AND m.created_at >= ${new Date(job.assignedAt)}) AS answered
      FROM conversations c
      WHERE c.account_id=${accountId}::uuid AND c.id=${job.conversationId}::uuid FOR UPDATE OF c`;
    const row = conversation[0];
    if (!row || row.status === 'closed' || row.answered || row.reopened_count !== job.cycle
      || row.assigned_agent_id?.toLowerCase() !== job.assignee) return 'stale';
    const rules = await tx.$queryRaw<{ conditions: unknown; assign_to: unknown; enabled: boolean; reassign_after_minutes: number | null }[]>`
      SELECT conditions,assign_to,enabled,reassign_after_minutes FROM routing_rules
      WHERE account_id=${accountId}::uuid AND id=${job.ruleId}::uuid`;
    const rule = rules[0];
    const parsed = rule ? readRule(rule) : null;
    if (!rule || !parsed || !rule.enabled || !rule.reassign_after_minutes) return 'rule_off';
    const assignTo = await resolveAssignTo(tx, accountId, parsed.assignTo);
    const eligible = await eligibleMembers(tx, accountId, ruleMembers(assignTo));
    const next = nextReassignee(assignTo, eligible, job.assignee);
    if (!next) return 'no_member';
    const assigned = await tx.$queryRaw<{ at: Date }[]>`UPDATE conversations SET assigned_agent_id=${next}::uuid
      WHERE account_id=${accountId}::uuid AND id=${job.conversationId}::uuid RETURNING now() AS at`;
    if (job.attempt + 1 < MAX_REASSIGNS)
      await queueReassign(tx, {
        accountId, conversationId: job.conversationId, ruleId: job.ruleId, assignee: next, cycle: job.cycle, attempt: job.attempt + 1,
        assignedAt: assigned[0].at.toISOString(),
        runAt: new Date(now.getTime() + rule.reassign_after_minutes * 60_000),
      });
    return 'reassigned';
  }, getWorkerPrisma());
}
