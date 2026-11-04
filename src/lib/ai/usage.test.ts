import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DataClient } from '@/lib/data/types'

const t = vi.hoisted(() => ({
  incrementUsage: vi.fn(),
  withTenant: vi.fn(),
}))
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => ({ worker: true }) }))
vi.mock('@/lib/db/tenant', () => ({ withTenant: t.withTenant }))
vi.mock('@/lib/billing/usage', () => ({ incrementUsage: t.incrementUsage }))

import { logAiUsage, estimateUsage } from './usage'

beforeEach(() => {
  t.incrementUsage.mockReset().mockResolvedValue(1)
  t.withTenant.mockReset().mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => Promise<unknown>) => fn({ tx: true }))
})

function fakeDb() {
  const insert = vi.fn().mockResolvedValue({ error: null })
  const db = { from: vi.fn(() => ({ insert })) }
  return { db: db as unknown as DataClient, insert, from: db.from }
}

describe('logAiUsage', () => {
  it('inserts a row mapping normalized usage to the log columns', async () => {
    const { db, insert, from } = fakeDb()
    await logAiUsage(db, {
      accountId: 'acct-1',
      conversationId: 'conv-1',
      mode: 'auto_reply',
      provider: 'anthropic',
      model: 'claude-x',
      usage: { promptTokens: 30, completionTokens: 6, totalTokens: 36 },
      estimate: { promptChars: 0, outputChars: 0 },
    })
    expect(from).toHaveBeenCalledWith('ai_usage_log')
    expect(insert).toHaveBeenCalledWith({
      account_id: 'acct-1',
      conversation_id: 'conv-1',
      mode: 'auto_reply',
      provider: 'anthropic',
      model: 'claude-x',
      prompt_tokens: 30,
      completion_tokens: 6,
      total_tokens: 36,
    })
  })

  it('meters an older path (draft) from its estimate when the provider reported no usage', async () => {
    const { db, insert } = fakeDb()
    await logAiUsage(db, {
      accountId: 'acct-1',
      conversationId: null,
      mode: 'draft',
      provider: 'openai',
      model: 'gpt-x',
      usage: null,
      estimate: { promptChars: 800, outputChars: 120 },
    })
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ mode: 'draft', prompt_tokens: 200, completion_tokens: 30, total_tokens: 230 }))
    expect(t.incrementUsage).toHaveBeenCalledWith({ tx: true }, 'ai_tokens', 230)
  })

  it('never throws when the insert errors', async () => {
    const insert = vi.fn().mockResolvedValue({ error: { message: 'boom' } })
    const db = { from: vi.fn(() => ({ insert })) } as unknown as DataClient
    await expect(
      logAiUsage(db, {
        accountId: 'acct-1',
        conversationId: 'conv-1',
        mode: 'draft',
        provider: 'openai',
        model: 'gpt-x',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        estimate: { promptChars: 0, outputChars: 0 },
      }),
    ).resolves.toBeUndefined()
  })
})

describe('logAiUsage token counting (phase 13)', () => {
  const db = () => ({ from: vi.fn(() => ({ insert: vi.fn().mockResolvedValue({ error: null }) })) } as unknown as DataClient)

  it('adds the total tokens to the ai_tokens meter on the worker, in the workspace scope', async () => {
    await logAiUsage(db(), {
      accountId: '11111111-1111-4111-8111-111111111111', conversationId: null, mode: 'summary',
      provider: 'openai', model: 'gpt-x', usage: { promptTokens: 30, completionTokens: 6, totalTokens: 36 }, estimate: { promptChars: 0, outputChars: 0 },
    })
    expect(t.withTenant).toHaveBeenCalledWith({ accountId: '11111111-1111-4111-8111-111111111111' }, expect.any(Function), { worker: true })
    expect(t.incrementUsage).toHaveBeenCalledWith({ tx: true }, 'ai_tokens', 36)
  })

  it('estimates characters / 4 when the provider reported no usage', async () => {
    expect(estimateUsage({ promptChars: 400, outputChars: 41 })).toEqual({ promptTokens: 100, completionTokens: 11, totalTokens: 111 })
    const client = db()
    await logAiUsage(client, {
      accountId: 'acct-1', conversationId: null, mode: 'suggest', provider: 'gemini', model: 'g',
      usage: null, estimate: { promptChars: 400, outputChars: 41 },
    })
    expect(client.from).toHaveBeenCalledWith('ai_usage_log')
    expect(t.incrementUsage).toHaveBeenCalledWith({ tx: true }, 'ai_tokens', 111)
  })

  it('counts nothing for a zero-token call and never throws when counting fails', async () => {
    await logAiUsage(db(), { accountId: 'a', conversationId: null, mode: 'draft', provider: 'openai', model: 'm', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, estimate: { promptChars: 0, outputChars: 0 } })
    expect(t.incrementUsage).not.toHaveBeenCalled()
    t.withTenant.mockRejectedValueOnce(new Error('connection refused: secret row value'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(logAiUsage(db(), { accountId: 'a', conversationId: null, mode: 'draft', provider: 'openai', model: 'm', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, estimate: { promptChars: 0, outputChars: 0 } })).resolves.toBeUndefined()
    expect(JSON.stringify(error.mock.calls)).not.toContain('secret row value')
    error.mockRestore()
  })
})
