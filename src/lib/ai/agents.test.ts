import { describe, expect, it } from 'vitest'
import {
  AgentError, AGENT_NAME_MAX, agentProfileFor, chooseAgent, copyName, isAgentId, legacyAgent, LEGACY_AGENT_ID, localMinutes, parseAgentInput, withinHours,
  type AgentChoice,
} from './agents'
import type { AgentProfile } from './agent-profile'

const agent = (id: string, over: Partial<AgentChoice> = {}): AgentChoice => ({
  id, enabled: true, channels: ['whatsapp'], hours: { mode: 'always', from: null, to: null }, ...over,
})

describe('parseAgentInput', () => {
  it('needs a name and instructions to create', () => {
    expect(() => parseAgentInput({ name: 'Sales' }, true)).toThrow(AgentError)
    expect(parseAgentInput({ name: '  Sales   desk ', instructions: 'Sell' }, true)).toMatchObject({ name: 'Sales desk', instructions: 'Sell' })
  })

  it('rejects unknown fields, an empty edit and bad channels', () => {
    expect(() => parseAgentInput({ name: 'A', instructions: 'x', is_default: true }, true)).toThrow(AgentError)
    expect(() => parseAgentInput({}, false)).toThrow(AgentError)
    expect(() => parseAgentInput({ channels: [] }, false)).toThrow(AgentError)
    expect(() => parseAgentInput({ channels: ['sms'] }, false)).toThrow(AgentError)
    expect(() => parseAgentInput({ name: 'x'.repeat(AGENT_NAME_MAX + 1) }, false)).toThrow(AgentError)
  })

  it('keeps channels in a fixed order and normalises hours', () => {
    expect(parseAgentInput({ channels: ['instagram', 'whatsapp'] }, false).channels).toEqual(['whatsapp', 'instagram'])
    expect(parseAgentInput({ hours: { mode: 'always', from: '09:00', to: '10:00' } }, false).hours).toEqual({ mode: 'always', from: null, to: null })
    expect(parseAgentInput({ hours: { mode: 'during', from: '09:00', to: '18:30' } }, false).hours).toEqual({ mode: 'during', from: '09:00', to: '18:30' })
  })

  it('refuses hours without times or with the end before the start', () => {
    expect(() => parseAgentInput({ hours: { mode: 'during' } }, false)).toThrow(AgentError)
    expect(() => parseAgentInput({ hours: { mode: 'outside', from: '18:00', to: '09:00' } }, false)).toThrow(AgentError)
    expect(() => parseAgentInput({ hours: { mode: 'during', from: '24:00', to: '25:00' } }, false)).toThrow(AgentError)
  })
})

describe('working hours', () => {
  const day = { mode: 'during' as const, from: '09:00', to: '18:00' }
  it('covers from inclusive, to exclusive', () => {
    expect(withinHours(day, 9 * 60)).toBe(true)
    expect(withinHours(day, 18 * 60)).toBe(false)
    expect(withinHours({ ...day, mode: 'outside' }, 18 * 60)).toBe(true)
    expect(withinHours({ ...day, mode: 'outside' }, 12 * 60)).toBe(false)
    expect(withinHours({ mode: 'always', from: null, to: null }, 3)).toBe(true)
  })

  it('reads local minutes in the workspace time zone and falls back to UTC', () => {
    const at = new Date('2026-11-13T10:15:00Z')
    expect(localMinutes(at, 'UTC')).toBe(10 * 60 + 15)
    expect(localMinutes(at, 'Asia/Kolkata')).toBe(15 * 60 + 45)
    expect(localMinutes(at, 'Not/AZone')).toBe(10 * 60 + 15)
  })
})

describe('chooseAgent', () => {
  it('picks exactly one agent: the first eligible in order', () => {
    const list = [agent('a', { enabled: false }), agent('b', { channels: ['instagram'] }), agent('c'), agent('d')]
    expect(chooseAgent(list, 'whatsapp', 600, null)?.id).toBe('c')
    expect(chooseAgent(list, 'instagram', 600, null)?.id).toBe('b')
  })

  it('keeps the previous agent while it is still eligible', () => {
    const list = [agent('a'), agent('b')]
    expect(chooseAgent(list, 'whatsapp', 600, 'b')?.id).toBe('b')
    expect(chooseAgent([agent('a'), agent('b', { enabled: false })], 'whatsapp', 600, 'b')?.id).toBe('a')
  })

  it('hands over between a daytime and an after-hours agent', () => {
    const list = [
      agent('day', { hours: { mode: 'during', from: '09:00', to: '18:00' } }),
      agent('night', { hours: { mode: 'outside', from: '09:00', to: '18:00' } }),
    ]
    expect(chooseAgent(list, 'whatsapp', 10 * 60, 'night')?.id).toBe('day')
    expect(chooseAgent(list, 'whatsapp', 20 * 60, 'day')?.id).toBe('night')
  })

  it('returns null when no agent is on for the channel and hour', () => {
    expect(chooseAgent([agent('a', { enabled: false })], 'whatsapp', 600, null)).toBeNull()
    expect(chooseAgent([], 'whatsapp', 600, null)).toBeNull()
  })
})

describe('agentProfileFor', () => {
  const rules = { keywords: ['refund'], on_low_confidence: false, confidence_threshold: 0.5, max_turns_before_handoff: 3 }
  const profile = { business_name: 'Shop', instructions: 'Workspace', tone: 'formal', handoff_rules: rules } as unknown as AgentProfile

  it('gives the default agent the workspace profile unchanged', () => {
    expect(agentProfileFor(profile, { is_default: true, instructions: 'x', tone: 'concise', handoff_rules: rules })).toBe(profile)
    expect(agentProfileFor(null, { is_default: true, instructions: 'x', tone: null, handoff_rules: rules })).toBeNull()
  })

  it('shows the legacy agent before any row exists as a read-only default on every channel and hour', () => {
    const legacy = legacyAgent(profile, new Date('2026-11-13T00:00:00Z'))
    expect(legacy).toMatchObject({
      id: LEGACY_AGENT_ID, synthetic: true, is_default: true, enabled: true, channels: ['whatsapp', 'instagram'],
      hours: { mode: 'always', from: null, to: null }, instructions: 'Workspace', tone: 'formal', handoff_rules: rules,
    })
    // No agent route accepts its id, so it can never be edited, switched or deleted by mistake.
    expect(isAgentId(legacy.id)).toBe(false)
    expect(legacyAgent(null)).toMatchObject({ instructions: null, tone: null })
  })

  it('keeps business details and swaps instructions, tone and rules for other agents', () => {
    const own = { ...rules, keywords: ['human'] }
    const merged = agentProfileFor(profile, { is_default: false, instructions: 'Bookings only', tone: 'concise', handoff_rules: own })
    expect(merged).toMatchObject({ business_name: 'Shop', instructions: 'Bookings only', tone: 'concise', handoff_rules: own })
    expect(agentProfileFor(null, { is_default: false, instructions: 'Hi', tone: null, handoff_rules: own })).toMatchObject({ business_name: null, instructions: 'Hi' })
  })
})

describe('copyName', () => {
  it('finds the first free copy name, case-insensitively', () => {
    expect(copyName('Sales', ['Sales'])).toBe('Sales copy')
    expect(copyName('Sales', ['Sales', 'sales COPY'])).toBe('Sales copy 2')
  })

  it('stays within the name limit', () => {
    const long = 'x'.repeat(AGENT_NAME_MAX)
    expect(copyName(long, []).length).toBeLessThanOrEqual(AGENT_NAME_MAX)
  })
})
