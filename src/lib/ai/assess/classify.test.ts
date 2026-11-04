import { describe, expect, it } from 'vitest'
import { classifyDeterministic, computeLeadScore, qualificationFlags, type TranscriptMessage } from './classify'

let n = 0
const msg = (text: string, sender: TranscriptMessage['sender'] = 'customer'): TranscriptMessage => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, sender, text, createdAt: new Date(2026, 10, 1, 10, n).toISOString(),
})

describe('classifyDeterministic', () => {
  it.each([
    ['How much is the facial package?', 'pricing'],
    ['¿Cuánto cuesta el corte de pelo?', 'pricing'],
    ['Quanto custa a consulta?', 'pricing'],
    ['이 제품 가격이 얼마예요?', 'pricing'],
    ['bhaiya iska kitne ka hai', 'pricing'],
    ['I want to order two of the blue mugs', 'purchase'],
    ['Quiero pedir uno de esos', 'purchase'],
    ['Can I book an appointment for Saturday?', 'booking'],
    ['Quero agendar uma consulta', 'booking'],
    ['예약하고 싶어요', 'booking'],
    ['Where is my order? It has not arrived', 'order_status'],
    ['Meu pedido não chegou ainda', 'order_status'],
    ['The product arrived damaged, I want a refund', 'complaint'],
    ['paisa wapas karo, bakwas product', 'complaint'],
    ['The app is not working, can you help?', 'support'],
    ['Hello there', 'other'],
  ])('%s -> %s', (text, intent) => {
    expect(classifyDeterministic([msg(text)]).intent).toBe(intent)
  })

  it('routes a health topic to staff ahead of any commercial intent', () => {
    const result = classifyDeterministic([msg('What is the price?'), msg('I have fever and a rash, which medicine should I take?')])
    expect(result.intent).toBe('sensitive_health')
    expect(result.sensitiveCategories).toEqual(expect.arrayContaining(['medical_symptom_or_diagnosis', 'treatment_or_dosage']))
    expect(result.confidence).toBe(90)
  })

  it('does not treat salon or shop wording as medical', () => {
    expect(classifyDeterministic([msg('How much is the keratin hair treatment?')]).intent).toBe('pricing')
    expect(classifyDeterministic([msg('Do you have baby clothes in stock?')]).intent).toBe('purchase')
  })

  it('uses the newest matching customer turn and ignores staff text', () => {
    const first = msg('How much is it?')
    const staff = msg('Our refund policy is 7 days', 'agent')
    const latest = msg('ok thanks')
    const result = classifyDeterministic([first, staff, latest])
    expect(result.intent).toBe('pricing')
    expect(result.evidenceIds).toEqual([first.id])
  })

  it('is unknown without customer text', () => {
    expect(classifyDeterministic([msg('Hi, how can we help?', 'agent')])).toMatchObject({ intent: 'unknown', confidence: 0 })
    expect(classifyDeterministic([]).intent).toBe('unknown')
  })
})

describe('qualificationFlags', () => {
  it('reads timeline, budget and buying signals from customer turns', () => {
    expect(qualificationFlags(['Need 20 pieces for my shop by Friday, budget under 5000', 'what is the price?'])).toEqual({
      asked_price: true, purchase_intent: false, booking_intent: false, timeline_mentioned: true,
      budget_mentioned: true, decision_maker: true, complaint: false,
    })
  })
})

describe('computeLeadScore', () => {
  const none = { asked_price: false, purchase_intent: false, booking_intent: false, timeline_mentioned: false, budget_mentioned: false, decision_maker: false, complaint: false }
  const now = Date.parse('2026-11-04T12:00:00Z')
  const facts = { openDeal: false, customerMessages: 1, lastInboundAt: null }

  it('starts low without signals and stays within 0..100', () => {
    expect(computeLeadScore(none, 'other', facts, now)).toBe(10)
    const all = { ...none, asked_price: true, purchase_intent: true, booking_intent: true, timeline_mentioned: true, budget_mentioned: true, decision_maker: true }
    expect(computeLeadScore(all, 'purchase', { openDeal: true, customerMessages: 40, lastInboundAt: new Date(now) }, now)).toBe(100)
  })

  it('rises with buying signals, recency and an open deal; falls for complaints', () => {
    const buying = { ...none, purchase_intent: true, asked_price: true }
    const recent = computeLeadScore(buying, 'purchase', { openDeal: true, customerMessages: 6, lastInboundAt: new Date(now - 3_600_000) }, now)
    const stale = computeLeadScore(buying, 'purchase', { openDeal: false, customerMessages: 1, lastInboundAt: new Date(now - 30 * 86_400_000) }, now)
    expect(recent).toBe(10 + 25 + 15 + 10 + 10 + 5)
    expect(stale).toBe(50)
    expect(computeLeadScore({ ...buying, complaint: true }, 'complaint', facts, now)).toBe(35)
    expect(computeLeadScore(none, 'complaint', facts, now)).toBe(0)
  })
})
