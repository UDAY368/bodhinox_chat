// ============================================================
// AI agents (ai_agents): several named agents per workspace, each with a
// role, its own instructions, tone and handoff rules, the channels it
// answers on and its working hours.
//
// Exactly one agent answers a customer message (pickAgentTx): the agent that
// already replied in the conversation if it is still eligible, otherwise the
// first enabled agent (by position, then age) whose channel and hours match.
// None eligible: nobody answers and the message waits for a person.
//
// The default agent (is_default) is the workspace's original single agent:
// its instructions, tone and handoff rules live in ai_agent_profiles (the
// setup wizard edits them), so a workspace keeps answering exactly as before.
// A workspace with no ai_agents rows at all still runs the legacy single
// agent (every channel, every hour); an admin opening the list creates the
// default row, enabled on both channels at every hour, which is the same.
//
// RLS: every member reads; admins write (checked here first); the worker reads.
// Every query runs inside withTenant with an explicit account_id.
// ============================================================

import { z } from 'zod'
import { hasMinRole } from '@/lib/auth/roles'
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant'
import { getWorkerPrisma } from '@/lib/db/prisma'
import { dataError } from '@/lib/data/errors'
import {
  AGENT_TONES, DEFAULT_HANDOFF_RULES, handoffRulesSchema, loadAgentProfileTx, parseHandoffRules, saveAgentProfileTx,
  type AgentProfile, type AgentTone, type HandoffRules,
} from './agent-profile'

export const AGENT_ROLES = ['sales', 'support', 'bookings', 'orders', 'general'] as const
export type AgentRole = (typeof AGENT_ROLES)[number]
export const AGENT_CHANNELS = ['whatsapp', 'instagram'] as const
export type AgentChannel = (typeof AGENT_CHANNELS)[number]
export const HOURS_MODES = ['always', 'during', 'outside'] as const
export type HoursMode = (typeof HOURS_MODES)[number]

export const MAX_AGENTS = 20
export const AGENT_NAME_MAX = 60
export const AGENT_INSTRUCTIONS_MAX = 4000
/** Window of the per-agent numbers on the agent cards. */
export const AGENT_STATS_DAYS = 30
/** The default agent's name when it is first created. */
export const DEFAULT_AGENT_NAME = 'Assistant'

export interface AgentHours {
  mode: HoursMode
  /** 'HH:MM' (24-hour) in the workspace's inbox time zone; null when mode is 'always'. */
  from: string | null
  to: string | null
}

export interface AiAgent {
  id: string
  name: string
  role: AgentRole
  instructions: string | null
  tone: AgentTone | null
  channels: AgentChannel[]
  hours: AgentHours
  handoff_rules: HandoffRules
  enabled: boolean
  is_default: boolean
  position: number
  created_at: string
  updated_at: string
}

export interface AgentStats {
  /** Conversations the agent replied in or handed off, last AGENT_STATS_DAYS days. */
  handled: number
  /** Of those, conversations it replied in and never handed to a person. */
  solved: number
}

export type AgentErrorCode = 'forbidden' | 'invalid_input' | 'not_found' | 'name_taken' | 'limit_reached' | 'default_agent'
const STATUS: Record<AgentErrorCode, number> = {
  forbidden: 403, invalid_input: 400, not_found: 404, name_taken: 409, limit_reached: 409, default_agent: 409,
}

export class AgentError extends Error {
  readonly status: number
  constructor(readonly code: AgentErrorCode) {
    super(`AI agent request refused: ${code}`)
    this.name = 'AgentError'
    this.status = STATUS[code]
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/
export const isAgentId = (value: unknown): value is string => typeof value === 'string' && UUID.test(value)

const hoursSchema = z.object({
  mode: z.enum(HOURS_MODES),
  from: z.string().regex(TIME).nullable().optional(),
  to: z.string().regex(TIME).nullable().optional(),
}).strict().transform((h, ctx): AgentHours => {
  if (h.mode === 'always') return { mode: 'always', from: null, to: null }
  if (!h.from || !h.to || h.from >= h.to) {
    ctx.addIssue({ code: 'custom', message: 'The start time must be before the end time' })
    return z.NEVER
  }
  return { mode: h.mode, from: h.from, to: h.to }
})

export const agentInputSchema = z.object({
  name: z.string().transform((v) => v.normalize('NFC').replace(/\s+/g, ' ').trim())
    .pipe(z.string().min(1).max(AGENT_NAME_MAX)),
  role: z.enum(AGENT_ROLES),
  instructions: z.union([z.string(), z.null()]).transform((v) => (v ?? '').trim() || null)
    .pipe(z.string().max(AGENT_INSTRUCTIONS_MAX).nullable()),
  tone: z.enum(AGENT_TONES).nullable(),
  channels: z.array(z.enum(AGENT_CHANNELS)).min(1).max(2).transform((list) => AGENT_CHANNELS.filter((c) => list.includes(c))),
  hours: hoursSchema,
  handoff_rules: handoffRulesSchema,
  enabled: z.boolean(),
}).partial().strict()

export type AgentInput = z.infer<typeof agentInputSchema>

/** A create or edit body; throws invalid_input. A new agent needs a name and instructions. */
export function parseAgentInput(body: unknown, creating: boolean): AgentInput {
  const parsed = agentInputSchema.safeParse(body)
  if (!parsed.success) throw new AgentError('invalid_input')
  if (creating && (!parsed.data.name || !parsed.data.instructions)) throw new AgentError('invalid_input')
  if (!creating && Object.keys(parsed.data).length === 0) throw new AgentError('invalid_input')
  return parsed.data
}

// ------------------------------------------------------------ hours and selection (pure)

/** Minutes since local midnight of `at` in `timeZone` (UTC when the zone is unknown). */
export function localMinutes(at: Date, timeZone: string): number {
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at)
  } catch {
    parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at)
  }
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return (get('hour') % 24) * 60 + get('minute')
}

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))

/** Whether the agent's hours cover `minutes` (from inclusive, to exclusive). */
export function withinHours(hours: AgentHours, minutes: number): boolean {
  if (hours.mode === 'always' || !hours.from || !hours.to) return true
  const inside = minutes >= minutesOf(hours.from) && minutes < minutesOf(hours.to)
  return hours.mode === 'during' ? inside : !inside
}

export type AgentChoice = Pick<AiAgent, 'id' | 'enabled' | 'channels' | 'hours'>

/**
 * The one agent that answers: the previous agent of the conversation when it
 * is still eligible, otherwise the first eligible agent in list order.
 */
export function chooseAgent<T extends AgentChoice>(agents: readonly T[], channel: AgentChannel, minutes: number, previousAgentId: string | null): T | null {
  const eligible = (a: T) => a.enabled && a.channels.includes(channel) && withinHours(a.hours, minutes)
  const previous = previousAgentId ? agents.find((a) => a.id === previousAgentId) : undefined
  if (previous && eligible(previous)) return previous
  return agents.find(eligible) ?? null
}

/**
 * The profile an agent replies with. The default agent uses the workspace
 * profile unchanged (null stays null: the legacy prompt). Any other agent
 * keeps the business details and replaces instructions, tone and rules.
 */
export function agentProfileFor(profile: AgentProfile | null, agent: Pick<AiAgent, 'is_default' | 'instructions' | 'tone' | 'handoff_rules'>): AgentProfile | null {
  if (agent.is_default) return profile
  const base: AgentProfile = profile ?? {
    business_name: null, business_type: null, website_url: null, instructions: null, greeting: null, tone: null,
    handoff_rules: { ...DEFAULT_HANDOFF_RULES }, setup_completed_at: null, updated_at: null,
  }
  return { ...base, instructions: agent.instructions, tone: agent.tone, handoff_rules: agent.handoff_rules }
}

// ------------------------------------------------------------ rows

const COLUMNS = `id::text, name, role, instructions, tone, channels, hours_mode, to_char(hours_from, 'HH24:MI') AS hours_from,
  to_char(hours_to, 'HH24:MI') AS hours_to, handoff_rules, enabled, is_default, position, created_at, updated_at`

interface AgentRow {
  id: string; name: string; role: string; instructions: string | null; tone: string | null; channels: string[]
  hours_mode: string; hours_from: string | null; hours_to: string | null; handoff_rules: unknown
  enabled: boolean; is_default: boolean; position: number; created_at: Date; updated_at: Date
}

function toAgent(r: AgentRow, profile: AgentProfile | null): AiAgent {
  const mode = (HOURS_MODES as readonly string[]).includes(r.hours_mode) ? (r.hours_mode as HoursMode) : 'always'
  const own = {
    instructions: r.instructions,
    tone: (AGENT_TONES as readonly string[]).includes(r.tone ?? '') ? (r.tone as AgentTone) : null,
    handoff_rules: parseHandoffRules(r.handoff_rules),
  }
  // The default agent shows (and replies with) the workspace profile's fields.
  const fromProfile = r.is_default
    ? { instructions: profile?.instructions ?? null, tone: profile?.tone ?? null, handoff_rules: profile?.handoff_rules ?? { ...DEFAULT_HANDOFF_RULES } }
    : own
  return {
    id: r.id, name: r.name,
    role: (AGENT_ROLES as readonly string[]).includes(r.role) ? (r.role as AgentRole) : 'general',
    ...fromProfile,
    channels: AGENT_CHANNELS.filter((c) => (r.channels ?? []).includes(c)),
    hours: mode === 'always' ? { mode, from: null, to: null } : { mode, from: r.hours_from, to: r.hours_to },
    enabled: r.enabled, is_default: r.is_default, position: r.position,
    created_at: r.created_at.toISOString(), updated_at: r.updated_at.toISOString(),
  }
}

async function selectAgents(tx: TenantTransaction, accountId: string): Promise<AgentRow[]> {
  return tx.$queryRawUnsafe<AgentRow[]>(
    `SELECT ${COLUMNS} FROM ai_agents WHERE account_id=$1::uuid ORDER BY position, created_at, id LIMIT ${MAX_AGENTS + 5}`, accountId)
}

async function selectAgent(tx: TenantTransaction, accountId: string, id: string, lock = false): Promise<AgentRow | null> {
  const rows = await tx.$queryRawUnsafe<AgentRow[]>(
    `SELECT ${COLUMNS} FROM ai_agents WHERE account_id=$1::uuid AND id=$2::uuid${lock ? ' FOR UPDATE' : ''}`, accountId, id)
  return rows[0] ?? null
}

/** Creates the default agent when the workspace has no agents yet (admin transaction). */
async function ensureDefaultAgent(tx: TenantTransaction, accountId: string, userId: string | null): Promise<void> {
  await tx.$executeRaw`INSERT INTO ai_agents(account_id, name, role, enabled, is_default, position, created_by)
    SELECT ${accountId}::uuid, ${DEFAULT_AGENT_NAME}, 'general', true, true, 0, ${userId}::uuid
    WHERE NOT EXISTS (SELECT 1 FROM ai_agents WHERE account_id=${accountId}::uuid)
    ON CONFLICT DO NOTHING`
}

/** Per-agent numbers from the AI activity log (admins only: the log holds customer text, so RLS hides it below admin). */
async function agentStats(tx: TenantTransaction, accountId: string, defaultId: string | null): Promise<Map<string, AgentStats>> {
  const rows = await tx.$queryRaw<{ agent_id: string | null; handled: number; solved: number }[]>`
    SELECT agent_id, count(*)::int AS handled, count(*) FILTER (WHERE replied AND NOT handed)::int AS solved FROM (
      SELECT agent_id::text AS agent_id, conversation_id, bool_or(outcome='replied') AS replied, bool_or(outcome='handed_off') AS handed
      FROM ai_reply_events
      WHERE account_id=${accountId}::uuid AND conversation_id IS NOT NULL AND outcome IN ('replied','handed_off')
        AND created_at >= now() - make_interval(days => ${AGENT_STATS_DAYS}::int)
      GROUP BY agent_id, conversation_id) c
    GROUP BY agent_id`
  const out = new Map<string, AgentStats>()
  for (const r of rows) {
    // Events from before agents existed were the single (now default) agent's.
    const id = r.agent_id ?? defaultId
    if (!id) continue
    const prev = out.get(id) ?? { handled: 0, solved: 0 }
    out.set(id, { handled: prev.handled + Number(r.handled), solved: prev.solved + Number(r.solved) })
  }
  return out
}

const isAdmin = (ctx: TenantContext) => !!ctx.role && hasMinRole(ctx.role, 'admin')
function assertAdmin(ctx: TenantContext): void {
  if (!isAdmin(ctx)) throw new AgentError('forbidden')
}

export interface AgentListView {
  agents: (AiAgent & { stats: AgentStats | null })[]
  /** The workspace saved its agent profile (setup wizard) at least once. */
  profile_saved: boolean
}

/** Every agent in list order (any member); an admin's first visit creates the default agent. */
export async function listAgents(ctx: TenantContext): Promise<AgentListView> {
  if (!ctx.role) throw new AgentError('forbidden')
  return withTenant(ctx, async (tx) => {
    if (isAdmin(ctx)) await ensureDefaultAgent(tx, ctx.accountId, ctx.userId ?? null)
    const profile = await loadAgentProfileTx(tx, ctx.accountId)
    const rows = await selectAgents(tx, ctx.accountId)
    const defaultId = rows.find((r) => r.is_default)?.id ?? null
    const stats = isAdmin(ctx) ? await agentStats(tx, ctx.accountId, defaultId) : null
    return {
      agents: rows.map((r) => ({ ...toAgent(r, profile), stats: stats ? stats.get(r.id) ?? { handled: 0, solved: 0 } : null })),
      profile_saved: profile !== null,
    }
  })
}

/** One agent of this workspace (any member), or null. */
export async function getAgent(ctx: TenantContext, id: string): Promise<AiAgent | null> {
  if (!isAgentId(id)) return null
  return withTenant(ctx, async (tx) => {
    const row = await selectAgent(tx, ctx.accountId, id)
    return row ? toAgent(row, await loadAgentProfileTx(tx, ctx.accountId)) : null
  })
}

const audit = (tx: TenantTransaction, ctx: TenantContext, action: string, id: string, metadata: Record<string, unknown>) => tx.$executeRaw`
  INSERT INTO audit_logs(account_id, user_id, action, resource_id, metadata)
  VALUES (${ctx.accountId}::uuid, ${ctx.userId ?? null}::uuid, ${action}, ${id}, ${JSON.stringify(metadata)}::jsonb)`

async function assertNameFree(tx: TenantTransaction, accountId: string, name: string, exceptId: string | null): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id::text FROM ai_agents
    WHERE account_id=${accountId}::uuid AND lower(name)=lower(${name}) AND (${exceptId}::uuid IS NULL OR id <> ${exceptId}::uuid)`
  if (rows.length) throw new AgentError('name_taken')
}

/** Maps a unique-name race to name_taken. */
function rethrow(error: unknown): never {
  if (!(error instanceof AgentError) && dataError(error).code === '23505') throw new AgentError('name_taken')
  throw error
}

/** Adds an agent at the end of the list, switched off until an admin turns it on (admin). */
export async function createAgent(ctx: TenantContext, input: AgentInput): Promise<AiAgent> {
  assertAdmin(ctx)
  if (!input.name) throw new AgentError('invalid_input')
  const name = input.name
  try {
    return await withTenant(ctx, async (tx) => {
      await ensureDefaultAgent(tx, ctx.accountId, ctx.userId ?? null)
      const [{ n, next }] = await tx.$queryRaw<{ n: number; next: number }[]>`
        SELECT count(*)::int AS n, COALESCE(max(position) + 1, 0)::int AS next FROM ai_agents WHERE account_id=${ctx.accountId}::uuid`
      if (n >= MAX_AGENTS) throw new AgentError('limit_reached')
      await assertNameFree(tx, ctx.accountId, name, null)
      const hours = input.hours ?? { mode: 'always', from: null, to: null }
      const rules = parseHandoffRules(input.handoff_rules ?? {})
      const rows = await tx.$queryRawUnsafe<AgentRow[]>(
        `INSERT INTO ai_agents(account_id, name, role, instructions, tone, channels, hours_mode, hours_from, hours_to,
           handoff_rules, enabled, is_default, position, created_by)
         VALUES ($1::uuid, $2, $3, $4, $5, $6::text[], $7, $8::time, $9::time, $10::jsonb, $11, false, $12, $13::uuid)
         RETURNING ${COLUMNS}`,
        ctx.accountId, name, input.role ?? 'general', input.instructions, input.tone ?? null,
        input.channels ?? [...AGENT_CHANNELS], hours.mode, hours.from, hours.to, JSON.stringify(rules),
        input.enabled ?? false, Math.min(1000, next), ctx.userId ?? null,
      )
      await audit(tx, ctx, 'ai.agent_created', rows[0].id, { role: rows[0].role, channels: rows[0].channels, enabled: rows[0].enabled })
      return toAgent(rows[0], null)
    })
  } catch (error) {
    rethrow(error)
  }
}

/**
 * Edits an agent (admin). For the default agent, instructions, tone and
 * handoff rules are saved to the workspace profile in the same transaction.
 * `move` swaps the agent with its neighbour in the list (the answering order).
 */
export async function updateAgent(ctx: TenantContext, id: string, input: AgentInput & { move?: 'up' | 'down' }): Promise<AiAgent> {
  assertAdmin(ctx)
  if (!isAgentId(id)) throw new AgentError('not_found')
  try {
    return await withTenant(ctx, async (tx) => {
      const current = await selectAgent(tx, ctx.accountId, id, true)
      if (!current) throw new AgentError('not_found')
      if (input.name !== undefined) await assertNameFree(tx, ctx.accountId, input.name, id)
      if (input.move) await moveAgent(tx, ctx.accountId, current, input.move)
      let profile = await loadAgentProfileTx(tx, ctx.accountId)
      const profileFields = current.is_default
        && (input.instructions !== undefined || input.tone !== undefined || input.handoff_rules !== undefined)
      if (profileFields) {
        profile = await saveAgentProfileTx(tx, ctx.accountId, {
          ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
          ...(input.tone !== undefined ? { tone: input.tone } : {}),
          ...(input.handoff_rules !== undefined ? { handoff_rules: input.handoff_rules } : {}),
        })
      }
      const own = !current.is_default
      const hours = input.hours
      const rules = own && input.handoff_rules !== undefined
        ? parseHandoffRules({ ...parseHandoffRules(current.handoff_rules), ...stripUndefined(input.handoff_rules) })
        : null
      const rows = await tx.$queryRawUnsafe<AgentRow[]>(
        `UPDATE ai_agents SET
           name=COALESCE($3, name), role=COALESCE($4, role),
           instructions=CASE WHEN $5::boolean THEN $6 ELSE instructions END,
           tone=CASE WHEN $7::boolean THEN $8 ELSE tone END,
           channels=COALESCE($9::text[], channels),
           hours_mode=COALESCE($10, hours_mode),
           hours_from=CASE WHEN $10::text IS NULL THEN hours_from ELSE $11::time END,
           hours_to=CASE WHEN $10::text IS NULL THEN hours_to ELSE $12::time END,
           handoff_rules=COALESCE($13::jsonb, handoff_rules),
           enabled=COALESCE($14, enabled)
         WHERE account_id=$1::uuid AND id=$2::uuid RETURNING ${COLUMNS}`,
        ctx.accountId, id, input.name ?? null, input.role ?? null,
        own && input.instructions !== undefined, input.instructions ?? null,
        own && input.tone !== undefined, input.tone ?? null,
        input.channels ?? null, hours?.mode ?? null, hours?.from ?? null, hours?.to ?? null,
        rules ? JSON.stringify(rules) : null, input.enabled ?? null,
      )
      const changed = Object.keys(input).filter((k) => k !== 'instructions' && k !== 'name')
      await audit(tx, ctx, 'ai.agent_updated', id, {
        fields: Object.keys(input), ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(changed.includes('channels') ? { channels: rows[0].channels } : {}),
      })
      return toAgent(rows[0], profile)
    })
  } catch (error) {
    rethrow(error)
  }
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>
}

/** Swaps positions with the neighbour above or below (list order decides who answers first). */
async function moveAgent(tx: TenantTransaction, accountId: string, current: AgentRow, direction: 'up' | 'down'): Promise<void> {
  const rows = await selectAgents(tx, accountId)
  // Normalise positions first so equal positions still move.
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].position !== i) await tx.$executeRaw`UPDATE ai_agents SET position=${i} WHERE account_id=${accountId}::uuid AND id=${rows[i].id}::uuid`
  }
  const index = rows.findIndex((r) => r.id === current.id)
  const other = rows[direction === 'up' ? index - 1 : index + 1]
  if (index < 0 || !other) return
  const otherIndex = direction === 'up' ? index - 1 : index + 1
  await tx.$executeRaw`UPDATE ai_agents SET position=${otherIndex} WHERE account_id=${accountId}::uuid AND id=${current.id}::uuid`
  await tx.$executeRaw`UPDATE ai_agents SET position=${index} WHERE account_id=${accountId}::uuid AND id=${other.id}::uuid`
}

/** Deletes an agent (admin). The default agent cannot be deleted; its activity rows keep a null agent. */
export async function deleteAgent(ctx: TenantContext, id: string): Promise<void> {
  assertAdmin(ctx)
  if (!isAgentId(id)) throw new AgentError('not_found')
  await withTenant(ctx, async (tx) => {
    const current = await selectAgent(tx, ctx.accountId, id, true)
    if (!current) throw new AgentError('not_found')
    if (current.is_default) throw new AgentError('default_agent')
    await tx.$executeRaw`DELETE FROM ai_agents WHERE account_id=${ctx.accountId}::uuid AND id=${id}::uuid`
    await audit(tx, ctx, 'ai.agent_deleted', id, { was_enabled: current.enabled })
  })
}

/** The first free "<name> copy", "<name> copy 2", ... within the name limit. */
export function copyName(name: string, taken: readonly string[]): string {
  const used = new Set(taken.map((n) => n.toLowerCase()))
  for (let n = 1; n < 1000; n++) {
    const suffix = n === 1 ? ' copy' : ` copy ${n}`
    const candidate = `${name.slice(0, AGENT_NAME_MAX - suffix.length).trim()}${suffix}`
    if (!used.has(candidate.toLowerCase())) return candidate
  }
  throw new AgentError('name_taken')
}

/** Copies an agent (admin): same settings, a free "copy" name, switched off, never the default. */
export async function duplicateAgent(ctx: TenantContext, id: string): Promise<AiAgent> {
  assertAdmin(ctx)
  if (!isAgentId(id)) throw new AgentError('not_found')
  const source = await withTenant(ctx, async (tx) => {
    const row = await selectAgent(tx, ctx.accountId, id)
    if (!row) return null
    const agent = toAgent(row, await loadAgentProfileTx(tx, ctx.accountId))
    const names = (await selectAgents(tx, ctx.accountId)).map((r) => r.name)
    return { agent, name: copyName(agent.name, names) }
  })
  if (!source) throw new AgentError('not_found')
  const a = source.agent
  return createAgent(ctx, {
    name: source.name, role: a.role, instructions: a.instructions, tone: a.tone, channels: a.channels,
    hours: a.hours, handoff_rules: a.handoff_rules, enabled: false,
  })
}

// ------------------------------------------------------------ worker

export type AgentPick =
  | { kind: 'legacy' }
  | { kind: 'agent'; agent: AiAgent }
  | { kind: 'none' }

/**
 * The agent that answers this conversation now (worker transaction).
 * 'legacy': the workspace has no agents (the single legacy agent answers);
 * 'none': agents exist but none is on for this channel at this hour.
 */
export async function pickAgentTx(tx: TenantTransaction, accountId: string, channel: AgentChannel, conversationId: string, now: Date = new Date()): Promise<AgentPick> {
  const rows = await selectAgents(tx, accountId)
  if (!rows.length) return { kind: 'legacy' }
  const [zone] = await tx.$queryRaw<{ timezone: string }[]>`
    SELECT timezone FROM workspace_inbox_settings WHERE account_id=${accountId}::uuid`
  const [previous] = await tx.$queryRaw<{ agent_id: string | null }[]>`
    SELECT agent_id::text AS agent_id FROM ai_reply_events
    WHERE account_id=${accountId}::uuid AND conversation_id=${conversationId}::uuid AND agent_id IS NOT NULL AND outcome='replied'
    ORDER BY created_at DESC LIMIT 1`
  const profile = await loadAgentProfileTx(tx, accountId)
  const agents = rows.map((r) => toAgent(r, profile))
  const chosen = chooseAgent(agents, channel, localMinutes(now, zone?.timezone || 'UTC'), previous?.agent_id ?? null)
  return chosen ? { kind: 'agent', agent: chosen } : { kind: 'none' }
}

/** pickAgentTx on the worker role (the auto-reply path). Throws on a database failure (fail closed). */
export async function pickAgent(accountId: string, channel: AgentChannel, conversationId: string): Promise<AgentPick> {
  return withTenant({ accountId, role: 'owner' }, (tx) => pickAgentTx(tx, accountId, channel, conversationId), getWorkerPrisma())
}
