import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createFlow,
  deleteFlow,
  deprecateFlow,
  getFlow,
  MetaApiError,
  publishFlow,
  sendFlowMessage,
  setBusinessEncryptionKey,
  updateFlowMetadata,
  uploadFlowJson,
} from './meta-api'

const BASE = 'https://graph.facebook.com/v21.0'
let calls: Array<{ url: string; init: RequestInit }> = []
let reply: () => Response = () => new Response(JSON.stringify({ success: true }), { status: 200 })

beforeEach(() => {
  calls = []
  reply = () => new Response(JSON.stringify({ success: true }), { status: 200 })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return reply()
  }))
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const last = () => calls[calls.length - 1]
const jsonBody = () => JSON.parse(String(last().init.body))
const headers = () => last().init.headers as Record<string, string>

describe('WhatsApp Flows API', () => {
  it('creates a flow on the WABA', async () => {
    reply = () => new Response(JSON.stringify({ id: '9001' }), { status: 200 })
    await expect(createFlow({ wabaId: 'waba-1', accessToken: 'tok', name: 'Lead form', categories: ['LEAD_GENERATION'] }))
      .resolves.toEqual({ id: '9001' })
    expect(last().url).toBe(`${BASE}/waba-1/flows`)
    expect(last().init.method).toBe('POST')
    expect(headers()).toMatchObject({ Authorization: 'Bearer tok', 'Content-Type': 'application/json' })
    expect(jsonBody()).toEqual({ name: 'Lead form', categories: ['LEAD_GENERATION'] })

    await createFlow({ wabaId: 'waba-1', accessToken: 'tok', name: 'E', categories: ['OTHER'], endpointUri: 'https://x.test/f' })
    expect(jsonBody()).toEqual({ name: 'E', categories: ['OTHER'], endpoint_uri: 'https://x.test/f' })
  })

  it('fails a create that returns no id', async () => {
    reply = () => new Response('{}', { status: 200 })
    await expect(createFlow({ wabaId: 'w', accessToken: 't', name: 'n', categories: ['OTHER'] })).rejects.toThrow(/no id/)
  })

  it('updates only the metadata it is given', async () => {
    await updateFlowMetadata({ flowId: 'f1', accessToken: 'tok', name: 'Renamed' })
    expect(last().url).toBe(`${BASE}/f1`)
    expect(last().init.method).toBe('POST')
    expect(jsonBody()).toEqual({ name: 'Renamed' })
    await updateFlowMetadata({ flowId: 'f1', accessToken: 'tok', categories: ['SURVEY'], endpointUri: 'https://x.test/e' })
    expect(jsonBody()).toEqual({ categories: ['SURVEY'], endpoint_uri: 'https://x.test/e' })
  })

  it('uploads Flow JSON as a multipart flow.json asset and returns validation errors', async () => {
    reply = () => new Response(JSON.stringify({ success: true, validation_errors: [{ error: 'INVALID', message: 'bad' }] }), { status: 200 })
    const result = await uploadFlowJson({ flowId: 'f1', accessToken: 'tok', flowJson: { version: '6.3', screens: [] } })
    expect(result).toEqual({ validation_errors: [{ error: 'INVALID', message: 'bad' }] })
    expect(last().url).toBe(`${BASE}/f1/assets`)
    expect(last().init.method).toBe('POST')
    expect(headers()).toEqual({ Authorization: 'Bearer tok' })
    const form = last().init.body as FormData
    expect(form.get('name')).toBe('flow.json')
    expect(form.get('asset_type')).toBe('FLOW_JSON')
    const file = form.get('file') as File
    expect(file.name).toBe('flow.json')
    expect(JSON.parse(await file.text())).toEqual({ version: '6.3', screens: [] })
  })

  it('publishes, deprecates and deletes', async () => {
    await publishFlow({ flowId: 'f1', accessToken: 'tok' })
    expect([last().url, last().init.method]).toEqual([`${BASE}/f1/publish`, 'POST'])
    await deprecateFlow({ flowId: 'f1', accessToken: 'tok' })
    expect([last().url, last().init.method]).toEqual([`${BASE}/f1/deprecate`, 'POST'])
    await deleteFlow({ flowId: 'f1', accessToken: 'tok' })
    expect([last().url, last().init.method]).toEqual([`${BASE}/f1`, 'DELETE'])
    reply = () => new Response('{}', { status: 404 })
    await expect(deleteFlow({ flowId: 'gone', accessToken: 'tok' })).resolves.toBeUndefined()
  })

  it('reads status, validation errors and the preview url', async () => {
    reply = () => new Response(JSON.stringify({
      id: 'f1', status: 'PUBLISHED', validation_errors: [], preview: { preview_url: 'https://business.facebook.com/wa/manage/flows/f1/preview/?token=x' },
    }), { status: 200 })
    await expect(getFlow({ flowId: 'f1', accessToken: 'tok' })).resolves.toEqual({
      status: 'PUBLISHED', validation_errors: [], preview_url: 'https://business.facebook.com/wa/manage/flows/f1/preview/?token=x',
    })
    const url = new URL(last().url)
    expect(`${url.origin}${url.pathname}`).toBe(`${BASE}/f1`)
    expect(url.searchParams.get('fields')).toBe('status,validation_errors,preview.invalidate(false)')
    expect(last().init.method).toBe('GET')
  })

  it('sends an interactive flow message', async () => {
    reply = () => new Response(JSON.stringify({ messages: [{ id: 'wamid.F1' }] }), { status: 200 })
    const result = await sendFlowMessage({
      phoneNumberId: 'pn-1', accessToken: 'tok', to: '15551234567', flowId: 'f1', flowToken: 'tkn',
      cta: 'Open form', body: 'Please fill this in', header: 'Booking', footer: 'Takes a minute', screen: 'ABOUT',
    })
    expect(result).toEqual({ whatsapp_message_id: 'wamid.F1' })
    expect(last().url).toBe(`${BASE}/pn-1/messages`)
    expect(jsonBody()).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '15551234567',
      type: 'interactive',
      interactive: {
        type: 'flow',
        header: { type: 'text', text: 'Booking' },
        body: { text: 'Please fill this in' },
        footer: { text: 'Takes a minute' },
        action: {
          name: 'flow',
          parameters: {
            flow_message_version: '3', flow_token: 'tkn', flow_id: 'f1', flow_cta: 'Open form',
            flow_action: 'navigate', flow_action_payload: { screen: 'ABOUT' },
          },
        },
      },
    })
  })

  it('sends draft mode and initial data only when asked', async () => {
    reply = () => new Response(JSON.stringify({ messages: [{ id: 'wamid.F2' }] }), { status: 200 })
    await sendFlowMessage({
      phoneNumberId: 'pn-1', accessToken: 'tok', to: '15551234567', flowId: 'f1', flowToken: 'tkn',
      cta: 'Open', body: 'Hi', screen: 'A', data: { name: 'Ana' }, mode: 'draft',
    })
    const { interactive } = jsonBody()
    expect(interactive.header).toBeUndefined()
    expect(interactive.footer).toBeUndefined()
    expect(interactive.action.parameters).toMatchObject({ mode: 'draft', flow_action_payload: { screen: 'A', data: { name: 'Ana' } } })
  })

  it('validates the CTA and body before calling Meta', async () => {
    const base = { phoneNumberId: 'p', accessToken: 't', to: '1555', flowId: 'f', flowToken: 'k', body: 'Hi', screen: 'A' }
    await expect(sendFlowMessage({ ...base, cta: 'x'.repeat(31) })).rejects.toThrow()
    await expect(sendFlowMessage({ ...base, cta: '  ' })).rejects.toThrow()
    await expect(sendFlowMessage({ ...base, cta: 'Go', body: '' })).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })

  it('registers the business public key as a form field', async () => {
    const pem = '-----BEGIN PUBLIC KEY-----\nABC\n-----END PUBLIC KEY-----'
    await setBusinessEncryptionKey({ phoneNumberId: 'pn-1', accessToken: 'tok', publicKeyPem: pem })
    expect(last().url).toBe(`${BASE}/pn-1/whatsapp_business_encryption`)
    expect(last().init.method).toBe('POST')
    expect((last().init.body as URLSearchParams).get('business_public_key')).toBe(pem)
  })

  it('surfaces Meta errors as MetaApiError without the token', async () => {
    reply = () => new Response(JSON.stringify({ error: { message: 'Invalid flow', code: 100, fbtrace_id: 'tr' } }), { status: 400 })
    const err = await publishFlow({ flowId: 'f1', accessToken: 'secret-token' }).catch((e) => e)
    expect(err).toBeInstanceOf(MetaApiError)
    expect(err.message).toBe('Invalid flow')
    expect(err.code).toBe(100)
    expect(JSON.stringify({ ...err, message: err.message })).not.toContain('secret-token')
  })
})
