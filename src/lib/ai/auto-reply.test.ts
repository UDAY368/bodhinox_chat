import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AiConfig } from './types'

// Shared, hoisted mock state so the module mocks can close over it.
const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  generateReply: vi.fn(),
  engineSendText: vi.fn(),
  loadAccountMetaCredentials: vi.fn(),
  conversationNumberDisconnected: vi.fn(),
  sendTypingIndicator: vi.fn(),
  requireAiMessageRoom: vi.fn(),
  recordAiMessage: vi.fn(),
  state: {
    conv: null as Record<string, unknown> | null,
    autoResponders: [] as { id: string }[],
    latestMessageId: 'wamid.inbound-1',
    messageOrders: [] as string[],
    claim: true as boolean,
    afterClaim: null as (() => void) | null,
    beforeUpdate: null as (() => void) | null,
    reads: [] as Record<string, unknown>[],
    updatePayload: null as Record<string, unknown> | null,
    rpcCalls: [] as { name: string; args: unknown }[],
  },
}))

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('./context', () => ({ buildConversationContext: h.buildConversationContext }))
// The tests keep handing back excerpts; the scored search wraps them.
vi.mock('./knowledge', () => ({
  retrieveKnowledgeScored: async (...args: unknown[]) => {
    const excerpts = ((await h.retrieveKnowledge(...args)) ?? []) as string[]
    return {
      chunks: excerpts.map((content, i) => ({ id: `c${i}`, content, document_id: null, title: null, source_url: null })),
      retrieval: null,
    }
  },
}))
vi.mock('./generate', () => ({ generateReply: h.generateReply }))
vi.mock('@/lib/billing/limits', () => ({ requireAiMessageRoom: h.requireAiMessageRoom, recordAiMessage: h.recordAiMessage }))
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => ({ worker: true }) }))
vi.mock('@/lib/flows/meta-send', () => ({
  engineSendText: h.engineSendText,
  loadAccountMetaCredentials: h.loadAccountMetaCredentials,
  conversationNumberDisconnected: h.conversationNumberDisconnected,
}))
vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTypingIndicator: h.sendTypingIndicator,
}))
vi.mock('./admin-client', () => ({
  databaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'messages') {
        const chain = { select: () => chain, eq: () => chain, order: (column: string) => { h.state.messageOrders.push(column); return chain }, limit: () => chain,
          maybeSingle: async () => ({ data: { message_id: h.state.latestMessageId }, error: null }) }
        return chain
      }
      if (table === 'automations') {
        // .select().eq().eq().in().limit() → active auto-responders
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          limit: () =>
            Promise.resolve({ data: h.state.autoResponders, error: null }),
        }
        return chain
      }
      const filters: [string, unknown][] = []
      let payload: Record<string, unknown> | undefined
      const chain = {
        select: () => chain,
        eq: (key: string, value: unknown) => { filters.push([key, value]); return chain },
        is: (key: string, value: unknown) => { filters.push([key, value]); return chain },
        gt: (key: string, value: unknown) => { filters.push([key, { gt: value }]); return chain },
        maybeSingle: () => {
          h.state.reads.push(Object.fromEntries(filters))
          const matches = h.state.conv && filters.every(([key, value]) => h.state.conv![key] === value)
          return Promise.resolve({ data: matches ? { ...h.state.conv } : null, error: null })
        },
        update: (value: Record<string, unknown>) => { payload = value; h.state.beforeUpdate?.(); return chain },
        then: (resolve: (value: unknown) => unknown) => {
          const matches = h.state.conv && filters.every(([key, value]) => {
            if (value && typeof value === 'object' && 'gt' in value) return Date.parse(String(h.state.conv![key])) > Date.parse(String(value.gt))
            return h.state.conv![key] === value
          })
          if (matches) h.state.updatePayload = payload ?? null
          return Promise.resolve({ error: null }).then(resolve)
        },
      }
      return chain
    },
    rpc: (name: string, args: unknown) => {
      h.state.rpcCalls.push({ name, args })
      h.state.afterClaim?.()
      return Promise.resolve({ data: h.state.claim, error: null })
    },
  }),
}))

import { dispatchInboundToAiReply } from './auto-reply'

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
  inboundMessageId: 'wamid.inbound-1',
}

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    baseUrl: null,
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    ...overrides,
  }
}

beforeEach(() => {
  h.state.conv = {
    id: 'conv-1',
    account_id: 'acct-1',
    contact_id: 'contact-1',
    last_customer_message_at: new Date().toISOString(),
    bot_paused: false,
    assigned_agent_id: null,
    ai_autoreply_disabled: false,
    ai_reply_count: 0,
  }
  h.state.autoResponders = []
  h.state.latestMessageId = 'wamid.inbound-1'
  h.state.messageOrders = []
  h.state.claim = true
  h.state.afterClaim = null
  h.state.beforeUpdate = null
  h.state.reads = []
  h.state.updatePayload = null
  h.state.rpcCalls = []
  h.loadAiConfig.mockResolvedValue(aiConfig())
  h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'hi' }])
  h.retrieveKnowledge.mockResolvedValue([])
  h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false })
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' })
  h.conversationNumberDisconnected.mockResolvedValue(false)
  h.loadAccountMetaCredentials.mockResolvedValue({
    phoneNumberId: 'pn-1',
    accessToken: 'tok',
  })
  h.sendTypingIndicator.mockResolvedValue(undefined)
})

describe('dispatchInboundToAiReply — eligibility gates', () => {
  it('claims a slot and sends on the happy path', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toEqual([
      {
        name: 'claim_ai_reply_slot',
        args: { conversation_id: 'conv-1', max_replies: 3 },
      },
    ])
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' }),
    )
  })

  it('counts one AI message per generation against the workspace plan', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.requireAiMessageRoom).toHaveBeenCalledWith('acct-1', { worker: true })
    expect(h.recordAiMessage).toHaveBeenCalledTimes(1)
    expect(h.recordAiMessage).toHaveBeenCalledWith('acct-1', { worker: true })
  })

  it('stands down without calling the model when the plan has no AI messages left', async () => {
    const { PlanLimitError } = await import('@/lib/billing/entitlements')
    h.requireAiMessageRoom.mockRejectedValueOnce(new PlanLimitError('used up'))
    await dispatchInboundToAiReply({ ...ARGS, requireHandoffOnUnavailable: true })
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.recordAiMessage).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toMatchObject({ bot_paused: true })
  })

  it('grounds the reply in retrieved knowledge', async () => {
    h.retrieveKnowledge.mockResolvedValue(['Returns accepted within 30 days.'])
    await dispatchInboundToAiReply(ARGS)
    expect(h.retrieveKnowledge).toHaveBeenCalled()
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('Returns accepted within 30 days.')
  })

  it('stands down when an active message-level automation exists', async () => {
    h.state.autoResponders = [{ id: 'auto-1' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
  })

  it('does not send when the atomic slot claim loses the race', async () => {
    h.state.claim = false
    await dispatchInboundToAiReply(ARGS)
    // It still attempts the claim, but the send is skipped.
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when AI is off / not configured', async () => {
    h.loadAiConfig.mockResolvedValue(null)
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply is disabled for the account', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when a human agent is assigned', async () => {
    h.state.conv = {
      ...h.state.conv,
      assigned_agent_id: 'agent-9',
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
  })

  it('skips when auto-reply was disabled on this conversation', async () => {
    h.state.conv = {
      ...h.state.conv,
      assigned_agent_id: null,
      ai_autoreply_disabled: true,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when the per-conversation cap is reached', async () => {
    h.state.conv = {
      ...h.state.conv,
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it("stands down quietly when the thread's number was disconnected", async () => {
    h.conversationNumberDisconnected.mockResolvedValue(true)
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    await dispatchInboundToAiReply({ ...ARGS, requireHandoffOnUnavailable: true })
    // No LLM call, no send from another number, and no handoff note either.
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toBeNull()
    expect(h.conversationNumberDisconnected).toHaveBeenCalledWith(expect.anything(), ARGS.accountId, ARGS.conversationId)
    // Only a reason code is logged, never content.
    expect(info).toHaveBeenCalledWith('[ai auto-reply] skipped', { reason: 'whatsapp_number_disconnected' })
    info.mockRestore()
  })

  it('skips when there is nothing to reply to', async () => {
    h.buildConversationContext.mockResolvedValue([])
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — typing indicator (#527)', () => {
  it('shows "typing…" on the inbound wamid before calling the LLM', async () => {
    await dispatchInboundToAiReply(ARGS)
    // From the number the inbound arrived on (the conversation's number).
    expect(h.loadAccountMetaCredentials).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      'conv-1',
    )
    expect(h.sendTypingIndicator).toHaveBeenCalledTimes(1)
    expect(h.sendTypingIndicator).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      accessToken: 'tok',
      messageId: 'wamid.inbound-1',
    })
    // Ordering: the indicator goes out while the customer waits on the
    // model, not after the reply is already generated.
    const typingOrder = h.sendTypingIndicator.mock.invocationCallOrder[0]
    const llmOrder = h.generateReply.mock.invocationCallOrder[0]
    expect(typingOrder).toBeLessThan(llmOrder)
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })

  it('still sends the reply when the indicator request fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.sendTypingIndicator.mockRejectedValue(new Error('Meta API error: 400'))
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).toHaveBeenCalledTimes(1)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' }),
    )
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('typing indicator failed'),
      { error: 'Error' },
    )
    warn.mockRestore()
  })

  it('still sends the reply when the WhatsApp credentials cannot be loaded', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.loadAccountMetaCredentials.mockRejectedValue(
      new Error('WhatsApp not configured for this account'),
    )
    await dispatchInboundToAiReply(ARGS)
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('skips the indicator when no inbound wamid is supplied', async () => {
    const { inboundMessageId: _omit, ...legacyArgs } = ARGS
    void _omit
    await dispatchInboundToAiReply(legacyArgs)
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
    expect(h.loadAccountMetaCredentials).not.toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })

  it('does not fire when a gate short-circuits before the LLM', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
    expect(h.loadAccountMetaCredentials).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — handoff', () => {
  it('withholds provider commentary before any WhatsApp send and pauses for a human', async () => {
    const actual = await vi.importActual<typeof import('./generate')>('./generate')
    h.generateReply.mockImplementationOnce(actual.generateReply)
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      choices: [{ message: { content: '*Response:*\nHello!\n\nNote: The user appears to be switching languages. I should respond casually.' } }],
      usage: { prompt_tokens: 20, completion_tokens: 30 },
    }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      await dispatchInboundToAiReply(ARGS)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(h.engineSendText).not.toHaveBeenCalled()
      expect(h.state.rpcCalls).toHaveLength(0)
      expect(h.state.updatePayload).toMatchObject({ bot_paused: true, ai_autoreply_disabled: true })
      expect(JSON.stringify(h.state.updatePayload)).not.toContain('switching languages')
    } finally { vi.unstubAllGlobals() }
  })
  it('disables auto-reply, writes a summary, and does not send on handoff', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain(
      'AI agent handed off',
    )
    // Analytics counts the handoff by this time.
    expect(Date.parse(String(h.state.updatePayload?.ai_handoff_at))).not.toBeNaN()
    // No handoff target configured → conversation left unassigned.
    expect(h.state.updatePayload).not.toHaveProperty('assigned_agent_id')
  })

  it('routes to the configured handoff agent on handoff', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      assigned_agent_id: 'agent-7',
    })
  })
})


describe('dispatchInboundToAiReply — current conversation safeguards', () => {
  it.each([null, 'invalid', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()])('does not generate or send outside a customer session: %s', async (timestamp) => {
    h.state.conv!.last_customer_message_at = timestamp
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it.each(['account_id', 'contact_id'])('rejects a conversation with a different %s', async (field) => {
    h.state.conv![field] = 'other'
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.reads[0]).toMatchObject({ account_id: 'acct-1', contact_id: 'contact-1' })
  })

  it.each(['bot_paused', 'ai_autoreply_disabled', 'assigned_agent_id', 'last_customer_message_at'])('does not claim or send when %s changes during generation', async (field) => {
    h.generateReply.mockImplementationOnce(async () => {
      h.state.conv![field] = field === 'assigned_agent_id' ? 'human-1' : field === 'last_customer_message_at' ? '2020-01-01T00:00:00Z' : true
      return { text: 'Late reply', handoff: false }
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('does not overwrite an agent who takes ownership during a handoff decision', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.generateReply.mockImplementationOnce(async () => {
      h.state.conv!.assigned_agent_id = 'human-1'
      return { text: '', handoff: true }
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toBeNull()
    expect(h.state.conv!.assigned_agent_id).toBe('human-1')
  })

  it('rechecks ownership after a successful slot claim before sending', async () => {
    h.state.afterClaim = () => { h.state.conv!.bot_paused = true }
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })
})


it('skips an old inbound job superseded by another customer message', async () => {
  h.state.latestMessageId = 'wamid.newer'
  await dispatchInboundToAiReply(ARGS)
  expect(h.generateReply).not.toHaveBeenCalled()
  expect(h.engineSendText).not.toHaveBeenCalled()
})

it('skips a draft when a newer customer message arrives during generation', async () => {
  h.generateReply.mockImplementationOnce(async () => {
    h.state.latestMessageId = 'wamid.newer'
    return { text: 'stale', handoff: false }
  })
  await dispatchInboundToAiReply(ARGS)
  expect(h.state.rpcCalls).toHaveLength(0)
  expect(h.engineSendText).not.toHaveBeenCalled()
})

it('uses the worker routing decision instead of unrelated account automations', async () => {
  h.state.autoResponders = [{ id: 'unrelated-automation' }]
  await dispatchInboundToAiReply({ ...ARGS, routingChecked: true })
  expect(h.engineSendText).toHaveBeenCalledTimes(1)
})

it('hands an opted-in flow to a human when AI is unavailable', async () => {
  h.loadAiConfig.mockResolvedValue(null)
  await dispatchInboundToAiReply({ ...ARGS, requireHandoffOnUnavailable: true })
  expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true, bot_paused: true })
  expect(h.engineSendText).not.toHaveBeenCalled()
})

it('keeps human ownership when opted-in fallback is unavailable', async () => {
  h.state.conv!.assigned_agent_id = 'human-1'
  h.loadAiConfig.mockResolvedValue(null)
  await dispatchInboundToAiReply({ ...ARGS, requireHandoffOnUnavailable: true })
  expect(h.state.updatePayload).toBeNull()
})


it('atomically preserves ownership acquired between the handoff check and update', async () => {
  h.generateReply.mockResolvedValue({ text: '', handoff: true })
  h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
  h.state.beforeUpdate = () => { h.state.conv!.assigned_agent_id = 'human-1' }
  await dispatchInboundToAiReply(ARGS)
  expect(h.state.updatePayload).toBeNull()
  expect(h.state.conv!.assigned_agent_id).toBe('human-1')
})


it('does not hand off a draft after its customer session expires during generation', async () => {
  h.generateReply.mockImplementationOnce(async () => {
    h.state.conv!.last_customer_message_at = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    return { text: '', handoff: true }
  })
  await dispatchInboundToAiReply(ARGS)
  expect(h.state.updatePayload).toBeNull()
  expect(h.engineSendText).not.toHaveBeenCalled()
})

it('preserves a newer inbound that arrives between handoff eligibility and the write', async () => {
  h.generateReply.mockResolvedValue({ text: '', handoff: true })
  h.state.beforeUpdate = () => { h.state.conv!.last_customer_message_at = new Date(Date.now() + 1000).toISOString() }
  await dispatchInboundToAiReply(ARGS)
  expect(h.state.updatePayload).toBeNull()
})

it('breaks provider timestamp ties using persisted arrival order', async () => {
  await dispatchInboundToAiReply(ARGS)
  expect(h.state.messageOrders.slice(0, 2)).toEqual(['created_at', 'arrival_sequence'])
})
