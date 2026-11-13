// Pure helpers for the AI page's Agents tab (unit-tested; no React, no fetch).

export const AGENT_ROLES = ['sales', 'support', 'bookings', 'orders', 'general'] as const
export type AgentRole = (typeof AGENT_ROLES)[number]
export const AGENT_TONES = ['friendly', 'professional', 'concise', 'enthusiastic', 'formal'] as const
export type AgentTone = (typeof AGENT_TONES)[number]
export const AGENT_CHANNELS = ['whatsapp', 'instagram'] as const
export type AgentChannel = (typeof AGENT_CHANNELS)[number]
export type HoursMode = 'always' | 'during' | 'outside'

export interface AgentView {
  id: string
  name: string
  role: AgentRole
  instructions: string | null
  tone: AgentTone | null
  channels: AgentChannel[]
  hours: { mode: HoursMode; from: string | null; to: string | null }
  handoff_rules: { keywords: string[]; on_low_confidence: boolean; confidence_threshold: number; max_turns_before_handoff: number }
  enabled: boolean
  is_default: boolean
  position: number
  stats: { handled: number; solved: number } | null
}

export type AgentFilter = 'all' | 'on' | 'off'

/** Agents matching the On/Off filter and a search over name, role and instructions. */
export function filterAgents(agents: readonly AgentView[], filter: AgentFilter, query: string, roleLabel: (role: AgentRole) => string): AgentView[] {
  const q = query.trim().toLowerCase()
  return agents.filter((a) => (filter === 'all' || (filter === 'on') === a.enabled)
    && (!q || `${a.name} ${roleLabel(a.role)} ${a.instructions ?? ''}`.toLowerCase().includes(q)))
}

/** Share of handled conversations solved without a person (0..100), or null with none handled. */
export function solvedPct(stats: AgentView['stats']): number | null {
  if (!stats || stats.handled <= 0) return null
  return Math.round((Math.min(stats.solved, stats.handled) / stats.handled) * 100)
}

export interface AgentForm {
  name: string
  role: AgentRole
  instructions: string
  tone: AgentTone | null
  channels: AgentChannel[]
  keywords: string
  maxTurns: string
  unsure: boolean
  mode: HoursMode
  from: string
  to: string
}

export type AgentFormErrors = Partial<Record<'name' | 'goal' | 'channels' | 'maxTurns' | 'hours', true>>

export function formFrom(agent: AgentView | null): AgentForm {
  return {
    name: agent?.name ?? '',
    role: agent?.role ?? 'sales',
    instructions: agent?.instructions ?? '',
    tone: agent ? agent.tone : 'friendly',
    channels: agent ? [...agent.channels] : ['whatsapp'],
    keywords: (agent?.handoff_rules.keywords ?? []).join(', '),
    maxTurns: String(agent?.handoff_rules.max_turns_before_handoff ?? 6),
    unsure: agent?.handoff_rules.on_low_confidence ?? true,
    mode: agent?.hours.mode ?? 'always',
    from: agent?.hours.from ?? '09:00',
    to: agent?.hours.to ?? '19:00',
  }
}

/**
 * Validates the editor and builds the request body. The default agent's
 * instructions may be empty (the workspace profile keeps its own).
 */
export function formToBody(form: AgentForm, opts: { isDefault: boolean; takenNames: readonly string[] }):
  { ok: true; body: Record<string, unknown> } | { ok: false; errors: AgentFormErrors } {
  const errors: AgentFormErrors = {}
  const name = form.name.replace(/\s+/g, ' ').trim()
  if (!name || name.length > 60 || opts.takenNames.some((n) => n.toLowerCase() === name.toLowerCase())) errors.name = true
  if (!opts.isDefault && !form.instructions.trim()) errors.goal = true
  if (!form.channels.length) errors.channels = true
  const turns = Number(form.maxTurns)
  if (!/^\d+$/.test(form.maxTurns.trim()) || !Number.isInteger(turns) || turns < 0 || turns > 50) errors.maxTurns = true
  if (form.mode !== 'always' && (!/^\d\d:\d\d$/.test(form.from) || !/^\d\d:\d\d$/.test(form.to) || form.from >= form.to)) errors.hours = true
  if (Object.keys(errors).length) return { ok: false, errors }
  return {
    ok: true,
    body: {
      name,
      role: form.role,
      instructions: form.instructions.trim() || null,
      tone: form.tone,
      channels: AGENT_CHANNELS.filter((c) => form.channels.includes(c)),
      hours: form.mode === 'always' ? { mode: 'always' } : { mode: form.mode, from: form.from, to: form.to },
      handoff_rules: {
        keywords: form.keywords.split(',').map((k) => k.trim()).filter(Boolean).slice(0, 50),
        max_turns_before_handoff: turns,
        on_low_confidence: form.unsure,
      },
    },
  }
}

/** Starter messages for the test chat, per role (translation keys under AiStudio.test.starters). */
export const STARTER_KEYS: Record<AgentRole, readonly string[]> = {
  sales: ['sales1', 'sales2', 'sales3'],
  support: ['support1', 'support2', 'support3'],
  bookings: ['bookings1', 'bookings2', 'bookings3'],
  orders: ['orders1', 'orders2', 'orders3'],
  general: ['general1', 'general2', 'general3'],
}
