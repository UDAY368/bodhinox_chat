import { describe, expect, it } from 'vitest'
import { parseGeneration } from './generate'
import { buildSystemPrompt } from './defaults'

describe('customer-facing AI output', () => {
  it('withholds the screenshot response and its language-selection commentary', () => {
    const raw = '*Response:*\n\nAalo! Mova telusa? 😅\n\n---\n\nNote: The user appears to be switching between Telugu and possibly asking for help in Telugu. Given the informal nature and mixed language, I’m responding in a friendly manner while acknowledging the language mix.'
    const usage = { promptTokens: 40, completionTokens: 50, totalTokens: 90 }
    expect(parseGeneration(raw, usage)).toEqual({ text: '', handoff: true, usage })
  })

  it.each([
    '<think>I should answer in Telugu.</think>Namaste!',
    '<analysis>We need to interpret the customer.\nHello!',
    '[analysis]The user needs help.\n[final]Hello!',
    'Hello!\n\n**Note:** The customer seems to be asking about our service.',
    'The user is asking for help in Telugu, so I should respond accordingly.',
    'Reasoning:\nI should reply politely.\n\nFinal answer: Hello!',
    '*Response:* Note: The user appears to be switching languages. I should respond casually.',
    'Hello!\n\n## Analysis\nThe customer needs reassurance.\n\n## Final answer\nHello!',
  ])('does not forward model commentary: %s', raw => {
    expect(parseGeneration(raw)).toMatchObject({ text: '', handoff: true })
  })

  it.each([
    'Note: Our support team is available from 10 AM to 7 PM.',
    'The user manual is available on our website.',
    'I will reply once our team confirms the appointment.',
    'నమస్తే! మా సేవల గురించి మీకు ఎలా సహాయం చేయగలను?',
    'Hi! How can I help you with our services?',
  ])('preserves normal business replies: %s', raw => {
    expect(parseGeneration(raw)).toMatchObject({ text: raw, handoff: false })
  })

  it('removes a response label without changing a safe message', () => {
    expect(parseGeneration('*Response:*\n\nHello! How can I help with our services?')).toMatchObject({
      text: 'Hello! How can I help with our services?', handoff: false,
    })
  })

  it('explicitly forbids internal notes for every generation mode', () => {
    for (const mode of ['draft', 'auto_reply'] as const) {
      expect(buildSystemPrompt({ userPrompt: null, mode })).toContain('Never include internal notes')
    }
  })
})
