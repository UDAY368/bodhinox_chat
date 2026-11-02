vi.mock('@/lib/auth/session', () => ({ requireSession: async () => ({ userId: 'user-1', accountId: 'acct-1', role: callerRole, sessionId: 'session-1' }) }));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const claimOnAgentReply = vi.hoisted(() => vi.fn(async () => true))
vi.mock('@/lib/inbox/lifecycle', () => ({ claimOnAgentReply }))

// ---------------------------------------------------------------------------
// Tests for the `contact_id` send path (issue #296): sending an approved
// template to a single contact from the Contact detail view. The route must
// find-or-create the contact's conversation server-side, then run the normal
// send + persistence path — no inbound message required to bootstrap a thread.
// ---------------------------------------------------------------------------

// Records of what the route wrote, so we can assert the right rows landed.
const conversationInserts: Array<Record<string, unknown>> = []
const messageInserts: Array<Record<string, unknown>> = []

// Toggles for the per-test scenario.
let existingConversation: Record<string, unknown> | null = null
let contactRow: Record<string, unknown> | null = null
// The caller's role, as `requireRole` reads it off the profile. Sending
// requires 'agent'; 'viewer' must be refused before anything reaches Meta.
let callerRole: string = 'admin'
// A conversation created during the request becomes retrievable by id —
// the shared send core re-loads the conversation (with its contact) from
// just the id, so the mock must model insert-then-select-by-id.
let createdConversation: Record<string, unknown> | null = null
// Multi-number scenario: when set, the workspace's numbers and the contact's
// conversations are listed (one conversation per contact and number).
let numberList: Record<string, unknown>[] | null = null
let conversationList: Record<string, unknown>[] | null = null

const CONTACT = {
  id: 'contact-1',
  account_id: 'acct-1',
  phone: '+15551234567',
}

// Chainable Supabase mock. A fresh builder per `.from()` call tracks whether
// `.insert()` ran so the terminal resolves to the inserted row for creates
// and the canned select row otherwise.
function makeSupabaseMock() {
  function builder(table: string) {
    let didInsert = false
    const filters: Record<string, unknown> = {}

    const selectResult = () => {
      if (table === 'whatsapp_config' && numberList) {
        const matching = numberList.filter((row) => Object.entries(filters).every(([field, value]) => row[field] === value))
        return { data: 'id' in filters ? matching[0] ?? null : matching, error: null }
      }
      if (table === 'conversations' && conversationList) {
        if ('id' in filters) {
          const row = [...conversationList, ...(createdConversation ? [createdConversation] : [])].find((c) => c.id === filters.id)
          return { data: row ? { ...row, contact: CONTACT } : null, error: null }
        }
        return { data: conversationList, error: null }
      }
      switch (table) {
        case 'profiles':
          return {
            data: { account_id: 'acct-1', account_role: callerRole },
            error: null,
          }
        case 'accounts':
          return { data: { id: 'acct-1', name: 'Acme' }, error: null }
        case 'contacts':
          return { data: contactRow, error: null }
        case 'conversations':
          // Once created this request, a by-id reload returns it (with
          // its contact); otherwise fall back to the canned existing row.
          return { data: createdConversation ?? existingConversation, error: null }
        case 'whatsapp_config':
          return {
            data: {
              id: 'cfg-1',
              account_id: 'acct-1',
              phone_number_id: 'PNID-1',
              access_token: 'enc-token',
            },
            error: null,
          }
        case 'message_templates':
          return { data: null, error: null }
        default:
          return { data: null, error: null }
      }
    }

    const insertResult = () => {
      switch (table) {
        case 'conversations':
          return {
            data: {
              id: 'conv-new',
              account_id: 'acct-1',
              contact_id: 'contact-1',
              contact: CONTACT,
            },
            error: null,
          }
        case 'messages':
          return { data: { id: 'msg-1' }, error: null }
        default:
          return { data: null, error: null }
      }
    }

    const terminal = () =>
      Promise.resolve(didInsert ? insertResult() : selectResult())

    const b: Record<string, unknown> = {}
    const chain = () => b
    for (const m of ['select', 'in', 'order', 'limit', 'update', 'delete']) {
      b[m] = vi.fn(chain)
    }
    b.eq = vi.fn((field: string, value: unknown) => {
      filters[field] = value
      return b
    })
    b.insert = vi.fn((payload: Record<string, unknown>) => {
      didInsert = true
      if (table === 'conversations') {
        conversationInserts.push(payload)
        createdConversation = {
          id: 'conv-new',
          account_id: 'acct-1',
          contact_id: 'contact-1',
          // The single-number fixture's 'cfg-1' is not a UUID; only the
          // multi-number scenario reloads the conversation's number.
          ...(numberList ? { whatsapp_config_id: payload.whatsapp_config_id ?? null } : {}),
          contact: CONTACT,
        }
      }
      if (table === 'messages') messageInserts.push(payload)
      return b
    })
    b.single = vi.fn(terminal)
    b.maybeSingle = vi.fn(terminal)
    b.then = (resolve: (v: unknown) => unknown) =>
      resolve(didInsert ? insertResult() : selectResult())
    return b
  }

  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: 'user-1' } },
        error: null,
      })),
    },
    from: vi.fn((table: string) => builder(table)),
  }
}

let supabaseMock = makeSupabaseMock()

vi.mock('@/lib/data/server', () => ({
  createClient: vi.fn(async () => supabaseMock),
}))

vi.mock('@/lib/flows/admin-client', () => ({
  databaseAdmin: () => ({
    from: () => {
      const b: Record<string, unknown> = {}
      const chain = () => b
      for (const m of ['update', 'eq', 'select']) b[m] = vi.fn(chain)
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: null, error: null })
      return b
    },
  }),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn(() => 'plaintext-token'),
  encrypt: vi.fn(() => 'enc-token'),
  isLegacyFormat: vi.fn(() => false),
}))

const { sendTemplateMessage } = vi.hoisted(() => ({
  sendTemplateMessage: vi.fn(async () => ({ messageId: 'wamid-1' })),
}))
vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTemplateMessage,
  sendTextMessage: vi.fn(),
  sendMediaMessage: vi.fn(),
}))

import { POST } from './route'

function postContactTemplate(overrides: Record<string, unknown> = {}) {
  return POST(
    new Request('http://localhost/api/whatsapp/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contact_id: 'contact-1',
        message_type: 'template',
        template_name: 'order_update',
        template_language: 'en_US',
        template_message_params: { body: ['Acme', '#1234'] },
        template_params: ['Acme', '#1234'],
        ...overrides,
      }),
    }),
  )
}

describe('POST /api/whatsapp/send — contact_id template path', () => {
  beforeEach(() => {
    conversationInserts.length = 0
    messageInserts.length = 0
    existingConversation = null
    createdConversation = null
    numberList = null
    conversationList = null
    contactRow = CONTACT
    callerRole = 'admin'
    supabaseMock = makeSupabaseMock()
    sendTemplateMessage.mockClear()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('creates a conversation for a contact with none, then sends the template', async () => {
    const res = await postContactTemplate()
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
    expect(json.whatsapp_message_id).toBe('wamid-1')

    // A conversation was created for this contact.
    expect(conversationInserts).toHaveLength(1)
    expect(conversationInserts[0]).toMatchObject({
      account_id: 'acct-1',
      contact_id: 'contact-1',
    })

    // The template was sent to the contact's number.
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1)
    const args = (sendTemplateMessage.mock.calls[0] as unknown[])[0] as Record<
      string,
      unknown
    >
    // Meta wants the bare E.164 digits — sanitizePhoneForMeta strips the '+'.
    expect(args.to).toBe('15551234567')
    expect(args.templateName).toBe('order_update')

    // The outbound message was persisted under the new conversation.
    expect(messageInserts).toHaveLength(1)
    expect(messageInserts[0]).toMatchObject({
      conversation_id: 'conv-new',
      content_type: 'template',
      template_name: 'order_update',
      sender_type: 'agent',
    })
  })

  it('reuses an existing conversation instead of creating a duplicate', async () => {
    existingConversation = {
      id: 'conv-existing',
      account_id: 'acct-1',
      contact_id: 'contact-1',
      contact: CONTACT,
    }

    const res = await postContactTemplate()
    expect(res.status).toBe(200)

    expect(conversationInserts).toHaveLength(0)
    expect(messageInserts[0]).toMatchObject({ conversation_id: 'conv-existing' })
  })

  it('404s when the contact is not in the caller account', async () => {
    contactRow = null

    const res = await postContactTemplate()
    const json = await res.json()

    expect(res.status).toBe(404)
    expect(json.error).toMatch(/contact not found/i)
    expect(sendTemplateMessage).not.toHaveBeenCalled()
  })

  it('400s when neither conversation_id nor contact_id is provided', async () => {
    const res = await POST(
      new Request('http://localhost/api/whatsapp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message_type: 'template', template_name: 'x' }),
      }),
    )
    expect(res.status).toBe(400)
  })
})

describe('POST /api/whatsapp/send — role enforcement', () => {
  beforeEach(() => {
    conversationInserts.length = 0
    messageInserts.length = 0
    existingConversation = {
      id: 'conv-existing',
      account_id: 'acct-1',
      contact_id: 'contact-1',
      contact: CONTACT,
    }
    createdConversation = null
    numberList = null
    conversationList = null
    contactRow = CONTACT
    callerRole = 'admin'
    supabaseMock = makeSupabaseMock()
    sendTemplateMessage.mockClear()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('refuses a viewer with 403 and never reaches Meta', async () => {
    // A viewer is read-only (`canSendMessages`). The route used to resolve
    // account_id straight off the profile with no role check: RLS blocked
    // the message INSERT, but the send core calls Meta first, so the
    // customer still received a real WhatsApp message that RLS could not
    // un-send. The gate has to come before any outbound call.
    callerRole = 'viewer'

    const res = await postContactTemplate()

    expect(res.status).toBe(403)
    expect(sendTemplateMessage).not.toHaveBeenCalled()
    expect(messageInserts).toHaveLength(0)
  })

  it('allows an agent through', async () => {
    callerRole = 'agent'

    const res = await postContactTemplate()

    expect(res.status).toBe(200)
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1)
    // The replying agent claims the conversation as themselves.
    expect(claimOnAgentReply).toHaveBeenCalledWith({ accountId: 'acct-1', userId: 'user-1', role: 'agent' }, 'conv-existing')
  })

  it('still reports the send when claiming the conversation fails', async () => {
    callerRole = 'agent'
    claimOnAgentReply.mockRejectedValueOnce(new Error('db down'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await postContactTemplate()

    expect(res.status).toBe(200)
    expect(error).toHaveBeenCalledWith('[send] conversation claim failed')
    error.mockRestore()
  })
})

describe('POST /api/whatsapp/send — contact_id with two numbers', () => {
  const NUMBER_A = '00000000-0000-4000-8000-00000000000a'
  const NUMBER_B = '00000000-0000-4000-8000-00000000000b'

  beforeEach(() => {
    conversationInserts.length = 0
    messageInserts.length = 0
    existingConversation = null
    createdConversation = null
    contactRow = CONTACT
    callerRole = 'admin'
    numberList = [
      { id: NUMBER_A, account_id: 'acct-1', phone_number_id: 'PNID-A', access_token: 'enc-a', is_default: true, created_at: '2026-01-01T00:00:00Z' },
      { id: NUMBER_B, account_id: 'acct-1', phone_number_id: 'PNID-B', access_token: 'enc-b', is_default: false, created_at: '2026-02-01T00:00:00Z' },
    ]
    conversationList = [
      { id: 'conv-a', account_id: 'acct-1', contact_id: 'contact-1', whatsapp_config_id: NUMBER_A },
      { id: 'conv-b', account_id: 'acct-1', contact_id: 'contact-1', whatsapp_config_id: NUMBER_B },
    ]
    supabaseMock = makeSupabaseMock()
    sendTemplateMessage.mockClear()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it("uses the default number's conversation instead of failing on two", async () => {
    const res = await postContactTemplate()
    expect(res.status).toBe(200)
    expect(conversationInserts).toHaveLength(0)
    expect(messageInserts[0]).toMatchObject({ conversation_id: 'conv-a' })
    expect((sendTemplateMessage.mock.calls[0] as unknown[])[0]).toMatchObject({ phoneNumberId: 'PNID-A' })
  })

  it("uses the chosen number's conversation", async () => {
    const res = await postContactTemplate({ whatsapp_config_id: NUMBER_B })
    expect(res.status).toBe(200)
    expect(conversationInserts).toHaveLength(0)
    expect(messageInserts[0]).toMatchObject({ conversation_id: 'conv-b' })
    expect((sendTemplateMessage.mock.calls[0] as unknown[])[0]).toMatchObject({ phoneNumberId: 'PNID-B' })
  })

  it('opens a conversation on the chosen number when the contact has none there', async () => {
    conversationList = [conversationList![0]]
    const res = await postContactTemplate({ whatsapp_config_id: NUMBER_B })
    expect(res.status).toBe(200)
    expect(conversationInserts).toEqual([expect.objectContaining({ contact_id: 'contact-1', whatsapp_config_id: NUMBER_B })])
  })

  it('does not reuse an unnumbered conversation for a non-default number', async () => {
    conversationList = [{ id: 'conv-legacy', account_id: 'acct-1', contact_id: 'contact-1', whatsapp_config_id: null }]
    expect((await postContactTemplate({ whatsapp_config_id: NUMBER_B })).status).toBe(200)
    expect(conversationInserts).toHaveLength(1)
    conversationInserts.length = 0
    createdConversation = null
    expect((await postContactTemplate()).status).toBe(200)
    expect(conversationInserts).toHaveLength(0)
    expect(messageInserts.at(-1)).toMatchObject({ conversation_id: 'conv-legacy' })
  })

  it('refuses a number outside the workspace before anything is created or sent', async () => {
    const res = await postContactTemplate({ whatsapp_config_id: '00000000-0000-4000-8000-0000000000ff' })
    expect(res.status).toBe(404)
    expect(conversationInserts).toHaveLength(0)
    expect(sendTemplateMessage).not.toHaveBeenCalled()
  })

  it('refuses a disconnected number with 409 before anything is created or sent', async () => {
    numberList = numberList!.map((row) => row.id === NUMBER_B ? { ...row, status: 'disconnected', access_token: '' } : row)
    const res = await postContactTemplate({ whatsapp_config_id: NUMBER_B })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'whatsapp_number_disconnected', error: expect.any(String) })
    expect(conversationInserts).toHaveLength(0)
    expect(sendTemplateMessage).not.toHaveBeenCalled()
  })

  it('never treats a disconnected number as the only one when reusing an unnumbered conversation', async () => {
    // A was disconnected (no longer default); B is the only connected number.
    numberList = [
      { ...numberList![0], is_default: false, status: 'disconnected', access_token: '' },
      { ...numberList![1], status: 'connected' },
    ]
    conversationList = [{ id: 'conv-legacy', account_id: 'acct-1', contact_id: 'contact-1', whatsapp_config_id: null }]
    expect((await postContactTemplate({ whatsapp_config_id: NUMBER_B })).status).toBe(200)
    expect(conversationInserts).toHaveLength(0)
    expect(messageInserts.at(-1)).toMatchObject({ conversation_id: 'conv-legacy' })
  })

  it('still counts a failed-registration number (status disconnected, token kept) as connected', async () => {
    numberList = [
      { ...numberList![0], is_default: false, status: 'disconnected' },
      { ...numberList![1], status: 'connected' },
    ]
    conversationList = [{ id: 'conv-legacy', account_id: 'acct-1', contact_id: 'contact-1', whatsapp_config_id: null }]
    expect((await postContactTemplate({ whatsapp_config_id: NUMBER_B })).status).toBe(200)
    expect(conversationInserts).toHaveLength(1)
  })

  it('asks for a number when there are several and no default', async () => {
    numberList = numberList!.map((row) => ({ ...row, is_default: false }))
    const res = await postContactTemplate()
    expect(res.status).toBe(400)
    expect(sendTemplateMessage).not.toHaveBeenCalled()
  })
})

