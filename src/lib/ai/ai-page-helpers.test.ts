import { describe, expect, it } from 'vitest'
import { labelSystemPrompt, matchLabels, MAX_AUTO_LABELS } from './auto-label'
import { parseRating, parseReplyFilter, safetyGroup, share } from './quality-dashboard'
import { ASK_MAX_CHARS, parseAskQuestion } from './knowledge-ask'
import { budgetState } from './budget-view'

const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`

describe('auto-labelling', () => {
  const labels = [{ id: id(1), name: 'Pricing' }, { id: id(2), name: 'Refund ' }, { id: id(3), name: 'Booking' }]

  it('lists only the workspace label names in the prompt', () => {
    const prompt = labelSystemPrompt(['Pricing', 'Booking'])
    expect(prompt).toContain('["Pricing","Booking"]')
    expect(prompt).toContain(`at most ${MAX_AUTO_LABELS}`)
  })

  it('matches exact names case-insensitively, without duplicates, capped', () => {
    expect(matchLabels(['pricing', 'PRICING', 'refund'], labels)).toEqual([id(1), id(2)])
    expect(matchLabels(['Pricing', 'Refund', 'Booking'], labels)).toHaveLength(MAX_AUTO_LABELS)
  })

  it('ignores names the model made up', () => {
    expect(matchLabels(['Urgent', 'VIP'], labels)).toEqual([])
  })
})

describe('quality dashboard', () => {
  it('accepts only a known reply kind, a uuid and up/down/null', () => {
    expect(parseRating({ kind: 'agent', id: id(1).toUpperCase(), vote: 'up' })).toEqual({ kind: 'agent', id: id(1), vote: 'up' })
    expect(parseRating({ kind: 'suggestion', id: id(1), vote: null })).toEqual({ kind: 'suggestion', id: id(1), vote: null })
    expect(parseRating({ kind: 'note', id: id(1), vote: 'up' })).toBeNull()
    expect(parseRating({ kind: 'agent', id: '1; DROP TABLE x', vote: 'up' })).toBeNull()
    expect(parseRating({ kind: 'agent', id: id(1), vote: 'meh' })).toBeNull()
    expect(parseRating({ kind: 'agent', id: id(1) })).toBeNull()
    expect(parseRating(null)).toBeNull()
  })

  it('falls back to all replies for an unknown filter', () => {
    expect(parseReplyFilter('down')).toBe('down')
    expect(parseReplyFilter('everything')).toBe('all')
    expect(parseReplyFilter(null)).toBe('all')
  })

  it('groups the guard flags the app records', () => {
    expect(safetyGroup('sensitive_topic')).toBe('sensitive_routed')
    expect(safetyGroup('claim_price')).toBe('claims')
    expect(safetyGroup('pii_redacted')).toBe('personal_data')
    expect(safetyGroup('url_stripped')).toBe('links')
    expect(safetyGroup('injection_marker')).toBe('injection')
    expect(safetyGroup('something_else')).toBeNull()
  })

  it('computes shares without dividing by zero', () => {
    expect(share(1, 3)).toBe(33)
    expect(share(5, 0)).toBe(0)
  })
})

describe('ask the knowledge base', () => {
  it('trims the question and bounds its length', () => {
    expect(parseAskQuestion({ question: '  do you   deliver? ' })).toBe('do you deliver?')
    expect(parseAskQuestion({ question: '   ' })).toBeNull()
    expect(parseAskQuestion({ question: 'x'.repeat(ASK_MAX_CHARS + 1) })).toBeNull()
    expect(parseAskQuestion({ question: 42 })).toBeNull()
    expect(parseAskQuestion(null)).toBeNull()
  })
})

describe('token budget state', () => {
  it('is on track, running low from 80 % and used up at 100 %', () => {
    expect(budgetState(10, null)).toBe('none')
    expect(budgetState(10, 0)).toBe('none')
    expect(budgetState(79, 100)).toBe('ok')
    expect(budgetState(80, 100)).toBe('warn')
    expect(budgetState(100, 100)).toBe('over')
  })
})
