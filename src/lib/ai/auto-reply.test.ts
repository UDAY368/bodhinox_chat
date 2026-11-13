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
  reserveAi: vi.fn(),
  settleAi: vi.fn(),
  failAi: vi.fn(),
  recordReplyEvent: vi.fn(),
  enqueueJob: vi.fn(),
  /** Stand-in for the inbound stage checkpoint: a stage runs once, then replays its result. */
  stages: new Map<string, unknown>(),
  stageCalls: [] as { accountId: string; messageId: string; stage: string }[],
  state: {
    /** A photo/voice note/location newer than the latest readable message, or null. */
    newerMediaId: null as string | null,
    messageTypeFilters: [] as unknown[][],
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
// No ai_agents rows: the legacy single agent answers (auto-reply-agent.test.ts covers agent selection).
vi.mock('./agents', async (importOriginal) => ({ ...(await importOriginal<typeof import('./agents')>()), pickAgent: async () => ({ kind: 'legacy' as const }) }))
vi.mock('./reply-events', () => ({ recordReplyEvent: h.recordReplyEvent }))
vi.mock('./budget', () => ({ reserveAi: h.reserveAi, settleAi: h.settleAi, failAi: h.failAi, chatTokenEstimate: () => 100 }))
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => ({ worker: true }) }))
vi.mock('@/lib/jobs/queue', () => ({ enqueueJob: h.enqueueJob }))
vi.mock('@/lib/whatsapp/ingest', () => ({
  runInboundStage: async (accountId: string, messageId: string, stage: string, action: () => Promise<unknown>, assertLease: () => void) => {
    assertLease()
    h.stageCalls.push({ accountId, messageId, stage })
    const key = `${messageId}:${stage}`
    if (h.stages.has(key)) return h.stages.get(key)
    const result = await action(); h.stages.set(key, result); return result
  },
}))
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
        let types: unknown[] | null = null
        const chain = { select: () => chain, eq: () => chain, order: (column: string) => { h.state.messageOrders.push(column); return chain }, limit: () => chain,
          in: (column: string, values: unknown[]) => { if (column === 'content_type') { types = values; h.state.messageTypeFilters.push(values) } return chain },
          // The newest customer message; a newer media message counts only when the query does not filter it out.
          maybeSingle: async () => ({ data: { message_id: h.state.newerMediaId && !(types && !types.includes('image')) ? h.state.newerMediaId : h.state.latestMessageId }, error: null }) }
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

import { dispatchInboundToAiReply, handleAutoReplyRetryJob, MAX_RATE_LIMIT_RETRIES, recordUnreadableInbound } from './auto-reply'

const RESERVATION = { reservation: true }
const ROW_ID = '44444444-4444-4444-8444-444444444444'
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
  h.reserveAi.mockReset().mockResolvedValue(RESERVATION)
  h.settleAi.mockReset().mockResolvedValue(undefined)
  h.failAi.mockReset().mockResolvedValue(undefined)
  h.recordReplyEvent.mockReset().mockResolvedValue(undefined)
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
  h.state.newerMediaId = null
  h.state.messageTypeFilters = []
  h.enqueueJob.mockReset().mockResolvedValue('job-1')
  h.stages.clear()
  h.stageCalls = []
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

  it('meters one AI message per inbound message (its id is the source key) and settles once', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.reserveAi).toHaveBeenCalledWith('acct-1', `inbound:${ARGS.inboundMessageId}`, { message: true, tokens: 100 }, { worker: true })
    expect(h.settleAi).toHaveBeenCalledTimes(1)
    expect(h.settleAi).toHaveBeenCalledWith(RESERVATION, expect.objectContaining({ log: expect.objectContaining({ mode: 'auto_reply', conversationId: 'conv-1' }) }))
  })

  it('hands a failed generation to failAi and sends nothing', async () => {
    h.generateReply.mockRejectedValueOnce(new Error('provider down'))
    await dispatchInboundToAiReply(ARGS)
    expect(h.failAi).toHaveBeenCalledWith(RESERVATION, expect.any(Error), expect.any(Number))
    expect(h.settleAi).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('stands down without calling the model when the plan has no AI messages left', async () => {
    const { PlanLimitError } = await import('@/lib/billing/entitlements')
    h.reserveAi.mockRejectedValueOnce(new PlanLimitError('used up'))
    await dispatchInboundToAiReply({ ...ARGS, requireHandoffOnUnavailable: true })
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.settleAi).not.toHaveBeenCalled()
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

it('still answers a text when a photo or voice note arrives during generation (audit 27)', async () => {
  h.generateReply.mockImplementationOnce(async () => {
    h.state.newerMediaId = 'wamid.photo'
    h.state.conv!.last_customer_message_at = new Date(Date.now() + 1000).toISOString()
    return { text: 'It costs 499.', handoff: false }
  })
  await dispatchInboundToAiReply(ARGS)
  expect(h.state.messageTypeFilters.length).toBeGreaterThan(0)
  for (const types of h.state.messageTypeFilters) {
    expect(types).toEqual(expect.arrayContaining(['text', 'interactive']))
    for (const media of ['image', 'audio', 'video', 'document', 'location']) expect(types).not.toContain(media)
  }
  expect(h.engineSendText).toHaveBeenCalledWith(expect.objectContaining({ text: 'It costs 499.' }))
})

it('reads the knowledge base with every customer turn since the last reply, not only the last one (audit 29)', async () => {
  h.buildConversationContext.mockResolvedValue([
    { role: 'user', content: 'What are your store hours?' },
    { role: 'assistant', content: '9 to 6.' },
    { role: 'user', content: 'Do you deliver to Pune?' },
    { role: 'user', content: 'and how much?' },
  ])
  await dispatchInboundToAiReply(ARGS)
  // A question already answered is left out, so its matches cannot lift the new question's confidence.
  expect(h.retrieveKnowledge.mock.calls[0][3]).toBe('Do you deliver to Pune?\nand how much?')
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

describe('dispatchInboundToAiReply — Phase 13 safety guards', () => {
  beforeEach(async () => (await import('@/lib/rate-limit')).__resetRateLimitForTests())

  it('hands a health question to staff before any model call', async () => {
    h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'I have chest pain and fever, what should I take?' }])
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.reserveAi).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toMatchObject({ bot_paused: true, ai_autoreply_disabled: true })
    expect(String(h.state.updatePayload?.ai_handoff_summary)).toContain('route to qualified staff')
  })

  it('routes a burst to staff: a health question followed at once by "hello??"', async () => {
    h.buildConversationContext.mockResolvedValue([
      { role: 'user', content: 'I have chest pain since morning, what should I take' },
      { role: 'user', content: 'hello??' },
    ])
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toMatchObject({ bot_paused: true, ai_autoreply_disabled: true })
  })

  it.each([
    'Your payment has been received and confirmed.',
    'Your refund has been processed.',
    'Your order has been delivered.',
    'This sounds like a viral infection. Take 500 mg of paracetamol three times a day.',
  ])('never sends a reply that asserts a status or gives medical advice: %s', async (text) => {
    h.generateReply.mockResolvedValue({ text, handoff: false })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.state.updatePayload).toMatchObject({ bot_paused: true })
    expect(String(h.state.updatePayload?.ai_handoff_summary)).toContain('safety check')
  })

  it('sends conditional status wording', async () => {
    h.generateReply.mockResolvedValue({ text: 'Once your payment is confirmed we will ship it.', handoff: false })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(expect.objectContaining({ text: 'Once your payment is confirmed we will ship it.' }))
  })

  it('strips links that are not allowed and masks personal data sent to the provider', async () => {
    h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'hi, my email is ravi@example.com' }])
    h.generateReply.mockResolvedValue({ text: 'Hello! Pay at https://evil.example.net/pay?x=1 now.', handoff: false })
    await dispatchInboundToAiReply(ARGS)
    const sentToModel = JSON.stringify(h.generateReply.mock.calls[0][0].messages)
    expect(sentToModel).not.toContain('ravi@example.com')
    const sent = h.engineSendText.mock.calls[0][0].text as string
    expect(sent).not.toContain('evil.example')
    expect(sent).toContain('Hello!')
  })

  it('retrieves customer-facing knowledge only', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.retrieveKnowledge).toHaveBeenCalledWith(expect.anything(), 'acct-1', expect.anything(), 'hi', 5, 'customer')
  })

  it('never logs the account id or customer text on the rate-limit path', async () => {
    const { __resetRateLimitForTests } = await import('@/lib/rate-limit')
    __resetRateLimitForTests()
    const logs = [vi.spyOn(console, 'info'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')].map((s) => s.mockImplementation(() => {}))
    for (let i = 0; i < 70; i++) await dispatchInboundToAiReply(ARGS)
    const logged = JSON.stringify(logs.flatMap((s) => s.mock.calls))
    expect(logged).toContain('rate_limited')
    expect(logged).not.toContain('acct-1')
    logs.forEach((s) => s.mockRestore())
    __resetRateLimitForTests()
  })
})

describe('dispatchInboundToAiReply — AI activity log', () => {
  beforeEach(async () => (await import('@/lib/rate-limit')).__resetRateLimitForTests())

  /** The one recorded event (fails when there were none or several). */
  const recorded = () => {
    expect(h.recordReplyEvent).toHaveBeenCalledTimes(1)
    return h.recordReplyEvent.mock.calls[0][0] as Record<string, unknown>
  }

  it('records one replied row with the question, reply, model and timing', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(recorded()).toMatchObject({
      accountId: 'acct-1', conversationId: 'conv-1', contactId: 'contact-1', inboundMessageId: 'wamid.inbound-1',
      outcome: 'replied', reason: 'answered', customerText: 'hi', replyText: 'Hello!', provider: 'openai', model: 'gpt-test',
      latencyMs: expect.any(Number),
    })
  })

  it.each([
    ['AI is off', () => { h.loadAiConfig.mockResolvedValue(null) }],
    ['auto-reply is disabled for the account', () => { h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false })) }],
    ['a human is assigned', () => { h.state.conv!.assigned_agent_id = 'agent-9' }],
    ['the thread was paused', () => { h.state.conv!.bot_paused = true }],
    ['an automation is active on a thread a human owns', () => { h.state.autoResponders = [{ id: 'a' }]; h.state.conv!.assigned_agent_id = 'agent-9' }],
  ])('records nothing when %s', async (_label, arrange) => {
    arrange()
    await dispatchInboundToAiReply(ARGS)
    expect(h.recordReplyEvent).not.toHaveBeenCalled()
  })

  it.each([
    ['automation_active', () => { h.state.autoResponders = [{ id: 'a' }] }],
    ['number_disconnected', () => { h.conversationNumberDisconnected.mockResolvedValue(true) }],
    ['reply_cap', () => { h.state.conv!.ai_reply_count = 3 }],
    ['no_messages', () => { h.buildConversationContext.mockResolvedValue([]) }],
    ['slot_lost', () => { h.state.claim = false }],
    ['stale', () => { h.generateReply.mockImplementationOnce(async () => { h.state.latestMessageId = 'wamid.newer'; return { text: 'x', handoff: false } }) }],
    ['stale', () => { h.state.afterClaim = () => { h.state.conv!.assigned_agent_id = 'human-1' } }],
  ])('records skipped / %s', async (reason, arrange) => {
    arrange()
    await dispatchInboundToAiReply(ARGS)
    expect(recorded()).toMatchObject({ outcome: 'skipped', reason })
  })

  it('records skipped / plan_ai_limit when the plan has no AI messages left', async () => {
    const { PlanLimitError } = await import('@/lib/billing/entitlements')
    h.reserveAi.mockRejectedValueOnce(new PlanLimitError('used up'))
    await dispatchInboundToAiReply(ARGS)
    expect(recorded()).toMatchObject({ outcome: 'skipped', reason: 'plan_ai_limit', customerText: 'hi' })
  })

  it("records skipped / stale when ownership changes at the sender's last check", async () => {
    h.engineSendText.mockImplementationOnce(async (args: { beforeSend: () => Promise<void> }) => {
      h.state.conv!.assigned_agent_id = 'human-1'
      await args.beforeSend()
    })
    await dispatchInboundToAiReply(ARGS)
    expect(recorded()).toMatchObject({ outcome: 'skipped', reason: 'stale' })
  })

  it('records skipped / stale when an agent pauses the bot while the sender runs', async () => {
    const { BotRepliesPausedError } = await import('@/lib/whatsapp/bot-pause-error')
    h.engineSendText.mockRejectedValueOnce(new BotRepliesPausedError())
    await dispatchInboundToAiReply(ARGS)
    expect(recorded()).toMatchObject({ outcome: 'skipped', reason: 'stale' })
  })

  it('records replied with the text when Meta accepted the reply but saving it locally failed', async () => {
    h.engineSendText.mockImplementationOnce(async (args: { onSent?: () => void }) => {
      args.onSent?.()
      throw new Error('Failed to save message: insert refused')
    })
    await dispatchInboundToAiReply(ARGS)
    const row = recorded()
    expect(row).toMatchObject({ outcome: 'replied', reason: 'answered', replyText: 'Hello!' })
    expect(JSON.stringify(row)).not.toContain('insert refused')
  })

  it('records handed_off / sensitive_topic before any model call', async () => {
    h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'I have chest pain and fever, what should I take?' }])
    await dispatchInboundToAiReply(ARGS)
    const row = recorded()
    expect(row).toMatchObject({ outcome: 'handed_off', reason: 'sensitive_topic' })
    expect(row.provider).toBeUndefined()
  })

  it('records handed_off / guard_blocked with the guard flags, never the blocked reply', async () => {
    h.generateReply.mockResolvedValue({ text: 'Your refund has been processed.', handoff: false })
    await dispatchInboundToAiReply(ARGS)
    const row = recorded()
    expect(row).toMatchObject({ outcome: 'handed_off', reason: 'guard_blocked' })
    expect((row.guardFlags as string[]).length).toBeGreaterThan(0)
    expect(row.replyText).toBeUndefined()
  })

  it('records handed_off / model_handoff when the model asks for a human', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(recorded()).toMatchObject({ outcome: 'handed_off', reason: 'model_handoff', confidence: 0 })
  })

  it('records error / dispatch_failed without the error message', async () => {
    h.generateReply.mockRejectedValueOnce(new Error('provider down: hi'))
    await dispatchInboundToAiReply(ARGS)
    const row = recorded()
    expect(row).toMatchObject({ outcome: 'error', reason: 'dispatch_failed', provider: 'openai' })
    expect(JSON.stringify(row)).not.toContain('provider down')
  })

  const quietly = async (run: () => Promise<void>) => {
    const quiet = [vi.spyOn(console, 'info'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')].map((s) => s.mockImplementation(() => {}))
    try { await run() } finally { quiet.forEach((s) => s.mockRestore()) }
  }
  const fillLimit = async () => { for (let i = 0; i < 30; i++) await dispatchInboundToAiReply(ARGS) ; h.recordReplyEvent.mockClear(); h.engineSendText.mockClear(); h.generateReply.mockClear() }

  it('defers an inbound over the account throttle to a delayed retry job, without calling the model (audit 28)', async () => {
    await quietly(async () => {
      await fillLimit()
      await dispatchInboundToAiReply({ ...ARGS, inboundRowId: ROW_ID, requireHandoffOnUnavailable: true })
    })
    expect(recorded()).toMatchObject({ outcome: 'skipped', reason: 'rate_limited_retry' })
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toBeNull() // a deferred inbound is not handed off yet
    expect(h.enqueueJob).toHaveBeenCalledTimes(1)
    const [type, payload, options] = h.enqueueJob.mock.calls[0] as [string, Record<string, unknown>, { tenantId: string; runAt: Date; dedupeKey: string }]
    expect(type).toBe('ai.auto_reply_retry')
    expect(payload).toEqual({
      conversationId: 'conv-1', contactId: 'contact-1', configOwnerUserId: 'user-1',
      inboundMessageId: 'wamid.inbound-1', messageId: ROW_ID, requireHandoffOnUnavailable: true, attempt: 1,
    })
    expect(options.tenantId).toBe('acct-1')
    expect(options.dedupeKey).toBe('ai-autoreply-retry:wamid.inbound-1:1')
    expect(options.runAt.getTime()).toBeGreaterThan(Date.now())
  })

  it('gives up after the last retry and records skipped / rate_limited, handing an opted-in flow to a person', async () => {
    await quietly(async () => {
      await fillLimit()
      await dispatchInboundToAiReply({ ...ARGS, inboundRowId: ROW_ID, requireHandoffOnUnavailable: true, retryAttempt: MAX_RATE_LIMIT_RETRIES })
    })
    expect(recorded()).toMatchObject({ outcome: 'skipped', reason: 'rate_limited' })
    expect(h.enqueueJob).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true, bot_paused: true })
  })

  it('records skipped / rate_limited when the retry cannot be queued', async () => {
    h.enqueueJob.mockRejectedValue(new Error('db down'))
    await quietly(async () => {
      await fillLimit()
      await dispatchInboundToAiReply({ ...ARGS, inboundRowId: ROW_ID })
    })
    expect(recorded()).toMatchObject({ outcome: 'skipped', reason: 'rate_limited' })
  })

  it('does not defer an inbound without its message row, since the retry could not be checkpointed', async () => {
    await quietly(async () => {
      await fillLimit()
      await dispatchInboundToAiReply(ARGS)
    })
    expect(h.enqueueJob).not.toHaveBeenCalled()
    expect(recorded()).toMatchObject({ outcome: 'skipped', reason: 'rate_limited' })
  })
})

describe('handleAutoReplyRetryJob', () => {
  const ids = { conversationId: '11111111-1111-4111-8111-111111111111', contactId: '22222222-2222-4222-8222-222222222222', configOwnerUserId: '33333333-3333-4333-8333-333333333333' }
  beforeEach(async () => {
    (await import('@/lib/rate-limit')).__resetRateLimitForTests()
    Object.assign(h.state.conv!, { id: ids.conversationId, contact_id: ids.contactId })
  })

  it('re-runs the dispatch for the deferred inbound under its stage checkpoint and replies when it is still current', async () => {
    const lease = vi.fn()
    await handleAutoReplyRetryJob('acct-1', { ...ids, messageId: ROW_ID, inboundMessageId: 'wamid.inbound-1', attempt: 2 }, lease)
    expect(h.engineSendText).toHaveBeenCalledWith(expect.objectContaining({ conversationId: ids.conversationId, text: 'Hello!' }))
    expect(h.stageCalls).toEqual([{ accountId: 'acct-1', messageId: ROW_ID, stage: 'ai_reply_retry:2' }])
    expect(lease).toHaveBeenCalled()
  })

  it('never sends twice when the same retry job is leased again', async () => {
    const job = { ...ids, messageId: ROW_ID, inboundMessageId: 'wamid.inbound-1', attempt: 1 }
    await handleAutoReplyRetryJob('acct-1', job)
    await handleAutoReplyRetryJob('acct-1', job)
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })

  it('stands down when a newer customer message superseded it', async () => {
    h.state.latestMessageId = 'wamid.newer'
    await handleAutoReplyRetryJob('acct-1', { ...ids, messageId: ROW_ID, inboundMessageId: 'wamid.inbound-1', attempt: 1 })
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it.each([
    [{ ...ids, messageId: ROW_ID, inboundMessageId: 'wamid.inbound-1', attempt: 0 }],
    [{ ...ids, messageId: ROW_ID, inboundMessageId: 'wamid.inbound-1', attempt: MAX_RATE_LIMIT_RETRIES + 1 }],
    [{ ...ids, messageId: ROW_ID, inboundMessageId: '', attempt: 1 }],
    [{ ...ids, inboundMessageId: 'wamid.inbound-1', attempt: 1 }],
    [{ ...ids, messageId: 'row-1', inboundMessageId: 'wamid.inbound-1', attempt: 1 }],
    [{ ...ids, conversationId: 'conv-1', messageId: ROW_ID, inboundMessageId: 'wamid.inbound-1', attempt: 1 }],
  ])('rejects a malformed payload', async (payload) => {
    await expect(handleAutoReplyRetryJob('acct-1', payload)).rejects.toThrow('Invalid AI auto-reply retry payload')
    expect(h.generateReply).not.toHaveBeenCalled()
  })
})

describe('recordUnreadableInbound (audit 27)', () => {
  const MEDIA = { ...ARGS, inboundMessageId: 'wamid.photo' }

  it('logs skipped / media_only for a photo in a conversation the agent would answer, without sending or handing off', async () => {
    await recordUnreadableInbound(MEDIA)
    expect(h.recordReplyEvent).toHaveBeenCalledTimes(1)
    expect(h.recordReplyEvent.mock.calls[0][0]).toEqual({
      accountId: 'acct-1', conversationId: 'conv-1', contactId: 'contact-1', inboundMessageId: 'wamid.photo', outcome: 'skipped', reason: 'media_only',
    })
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toBeNull()
  })

  it.each([
    ['auto-reply is off', () => { h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false })) }],
    ['a person owns the thread', () => { h.state.conv!.assigned_agent_id = 'agent-1' }],
    ['the bot is paused', () => { h.state.conv!.bot_paused = true }],
  ])('logs nothing when %s', async (_label, arrange) => {
    arrange()
    await recordUnreadableInbound(MEDIA)
    expect(h.recordReplyEvent).not.toHaveBeenCalled()
  })

  it('never throws', async () => {
    h.loadAiConfig.mockRejectedValue(new Error('db down'))
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    try { await expect(recordUnreadableInbound(MEDIA)).resolves.toBeUndefined() } finally { quiet.mockRestore() }
  })
})
