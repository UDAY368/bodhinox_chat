import { describe, expect, it } from 'vitest'
import { filterAgents, formFrom, formToBody, solvedPct, type AgentView } from './agents/agent-view'
import { parseLimit, usedPct } from './features/features-view'
import { applyVote, type QualityView } from './quality/quality-view'
import { filterSources, kindKey, sourceGroup, syncProgress } from './knowledge/source-view'

const view = (over: Partial<AgentView>): AgentView => ({
  id: 'a', name: 'Sales', role: 'sales', instructions: 'Sell shoes', tone: 'friendly', channels: ['whatsapp'],
  hours: { mode: 'always', from: null, to: null },
  handoff_rules: { keywords: [], on_low_confidence: true, confidence_threshold: 0.5, max_turns_before_handoff: 6 },
  enabled: true, is_default: false, position: 0, stats: null, ...over,
})

describe('agents tab', () => {
  const agents = [view({ id: 'a' }), view({ id: 'b', name: 'Help desk', role: 'support', instructions: 'Fix', enabled: false })]
  const label = (r: string) => (r === 'support' ? 'Customer support' : r)

  it('filters by on/off and searches name, role label and goal', () => {
    expect(filterAgents(agents, 'on', '', label).map((a) => a.id)).toEqual(['a'])
    expect(filterAgents(agents, 'off', '', label).map((a) => a.id)).toEqual(['b'])
    expect(filterAgents(agents, 'all', 'customer', label).map((a) => a.id)).toEqual(['b'])
    expect(filterAgents(agents, 'all', 'shoes', label).map((a) => a.id)).toEqual(['a'])
  })

  it('shows a solved share only with handled conversations', () => {
    expect(solvedPct(null)).toBeNull()
    expect(solvedPct({ handled: 0, solved: 0 })).toBeNull()
    expect(solvedPct({ handled: 4, solved: 3 })).toBe(75)
    expect(solvedPct({ handled: 2, solved: 5 })).toBe(100)
  })

  it('builds a request body from the editor', () => {
    const form = { ...formFrom(null), name: ' New  agent ', instructions: 'Book tables', keywords: 'refund, , human', channels: ['instagram', 'whatsapp'] as const }
    const result = formToBody({ ...form, channels: [...form.channels], mode: 'during', from: '09:00', to: '17:00' }, { isDefault: false, takenNames: [] })
    expect(result).toEqual({ ok: true, body: expect.objectContaining({
      name: 'New agent', channels: ['whatsapp', 'instagram'], hours: { mode: 'during', from: '09:00', to: '17:00' },
      handoff_rules: { keywords: ['refund', 'human'], max_turns_before_handoff: 6, on_low_confidence: true },
    }) })
  })

  it('reports every invalid field', () => {
    const result = formToBody({ ...formFrom(null), name: 'sales', channels: [], maxTurns: '-1', mode: 'outside', from: '18:00', to: '09:00' },
      { isDefault: false, takenNames: ['Sales'] })
    expect(result).toEqual({ ok: false, errors: { name: true, goal: true, channels: true, maxTurns: true, hours: true } })
  })

  it('lets the default agent keep empty instructions', () => {
    expect(formToBody(formFrom(view({ is_default: true, instructions: null })), { isDefault: true, takenNames: [] }).ok).toBe(true)
  })
})

describe('budget card', () => {
  it('parses typed limits with separators and bounds', () => {
    expect(parseLimit('2,000,000')).toEqual({ ok: true, value: 2_000_000 })
    expect(parseLimit('abc')).toEqual({ ok: false, error: 'invalid' })
    expect(parseLimit('5000')).toEqual({ ok: false, error: 'min' })
    expect(parseLimit('9'.repeat(20))).toEqual({ ok: false, error: 'max' })
  })

  it('shows percent used, also above 100', () => {
    expect(usedPct(500, 1000)).toBe(50)
    expect(usedPct(1500, 1000)).toBe(150)
    expect(usedPct(10, null)).toBe(0)
  })
})

describe('quality ratings', () => {
  const base: QualityView = {
    window_days: 30, outcomes: { accepted: 0, edited: 0, rejected: 0, unused: 0 }, daily: [], safety: [],
    ratings: { up: 3, down: 1 },
    replies: [{ kind: 'agent', id: 'r1', created_at: '', conversation_id: null, contact_id: null, contact_name: null, question: null,
      answer: null, outcome: 'sent', by: null, source: null, my_vote: 'down', up: 0, down: 1 }],
  }

  it('moves the reply and team counts together', () => {
    const up = applyVote(base, 'r1', 'up')
    expect(up.ratings).toEqual({ up: 4, down: 0 })
    expect(up.replies[0]).toMatchObject({ my_vote: 'up', up: 1, down: 0 })
    const cleared = applyVote(up, 'r1', null)
    expect(cleared.ratings).toEqual({ up: 3, down: 0 })
    expect(cleared.replies[0]).toMatchObject({ my_vote: null, up: 0, down: 0 })
  })

  it('leaves other replies alone', () => {
    expect(applyVote(base, 'other', 'up')).toEqual({ ...base, replies: base.replies })
  })
})

describe('knowledge sources table', () => {
  const sources = [
    { kind: 'website' as const, qa: false, title: 'Main site', url: 'https://shop.example' },
    { kind: 'file' as const, qa: false, title: 'Menu.pdf', url: null },
    { kind: 'text' as const, qa: true, title: 'Do you deliver?', url: null },
    { kind: 'learning' as const, qa: false, title: 'Opening hours', url: null },
  ]

  it('groups websites, documents and Q&A', () => {
    expect(sources.map(sourceGroup)).toEqual(['website', 'document', 'qa', 'qa'])
    expect(kindKey(sources[2])).toBe('qa')
    expect(kindKey(sources[1])).toBe('file')
  })

  it('filters by group and searches title and address', () => {
    expect(filterSources(sources, 'qa', '').map((s) => s.title)).toEqual(['Do you deliver?', 'Opening hours'])
    expect(filterSources(sources, 'all', 'shop.example').map((s) => s.title)).toEqual(['Main site'])
  })

  it('shows sync progress only while a crawl runs', () => {
    expect(syncProgress({ kind: 'website', status: 'crawling', pages_indexed: 5, page_limit: 10 })).toBe(50)
    expect(syncProgress({ kind: 'website', status: 'crawling', pages_indexed: 0, page_limit: 10 })).toBe(4)
    expect(syncProgress({ kind: 'website', status: 'ready', pages_indexed: 5, page_limit: 10 })).toBeNull()
    expect(syncProgress({ kind: 'file', status: 'queued', pages_indexed: 0, page_limit: 1 })).toBeNull()
  })
})
