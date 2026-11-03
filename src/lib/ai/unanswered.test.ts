import { describe, expect, it } from 'vitest'
import {
  UnansweredError,
  answerUnanswered,
  dismissUnanswered,
  learnedDocumentContent,
  listUnanswered,
  normalizeQuestion,
  promoteToKnowledge,
} from './unanswered'
import type { DataClient } from '@/lib/data/types'

const accountId = '00000000-0000-4000-8000-000000000000'
const id = '00000000-0000-4000-8000-000000000001'

describe('normalizeQuestion', () => {
  it('groups case, punctuation, spacing and numbers', () => {
    expect(normalizeQuestion('  Where is ORDER #1234?? ')).toBe('where is order #')
    expect(normalizeQuestion('where is order 98765')).toBe('where is order #')
    expect(normalizeQuestion('Do you deliver to\nhttps://maps.example/x  Pune!')).toBe('do you deliver to pune')
  })

  it('keeps letters of every script and folds compatibility forms', () => {
    expect(normalizeQuestion('क्या आप रविवार को खुले हैं?')).toBe('क्या आप रविवार को खुले हैं')
    expect(normalizeQuestion('ＡＢＣ　ｄｅｆ')).toBe('abc def')
  })

  it('is empty for emoji and punctuation only', () => {
    expect(normalizeQuestion('👍🙏 ?!')).toBe('')
  })
})

describe('role checks', () => {
  it('refuses viewers and non-admin promotion before touching the database', async () => {
    const viewer = { accountId, role: 'viewer' as const }
    await expect(listUnanswered(viewer)).rejects.toBeInstanceOf(UnansweredError)
    await expect(answerUnanswered(viewer, id, { answer: 'x' })).rejects.toBeInstanceOf(UnansweredError)
    await expect(dismissUnanswered(viewer, id)).rejects.toBeInstanceOf(UnansweredError)
    await expect(promoteToKnowledge({ accountId, role: 'agent' }, id, {} as DataClient, 'x')).rejects.toMatchObject({ status: 403 })
  })

  it('validates answers and ids', async () => {
    const agent = { accountId, role: 'agent' as const }
    await expect(answerUnanswered(agent, id, { answer: '  ' })).rejects.toThrow('Enter an answer')
    await expect(answerUnanswered(agent, id, { answer: 'x'.repeat(4001) })).rejects.toBeInstanceOf(UnansweredError)
    expect(await answerUnanswered(agent, 'not-a-uuid', { answer: 'x' })).toBeNull()
    expect(await dismissUnanswered(agent, 'nope')).toBe(false)
    await expect(listUnanswered(agent, { limit: 1000 })).rejects.toBeInstanceOf(UnansweredError)
  })

  it('needs the reviewed answer to promote', async () => {
    const admin = { accountId, role: 'admin' as const }
    await expect(promoteToKnowledge(admin, id, {} as DataClient, undefined)).rejects.toMatchObject({ status: 400 })
    await expect(promoteToKnowledge(admin, id, {} as DataClient, '  ')).rejects.toMatchObject({ status: 400 })
  })
})

it('formats a learned answer as a question and answer pair', () => {
  expect(learnedDocumentContent(' Open on Sunday? ', ' Yes, 10 to 6. ')).toBe('Question: Open on Sunday?\nAnswer: Yes, 10 to 6.')
})
