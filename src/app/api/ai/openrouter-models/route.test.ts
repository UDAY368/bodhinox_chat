import { afterEach, expect, it, vi } from 'vitest'
const auth = vi.hoisted(() => ({ requireRole: vi.fn() }))
vi.mock('@/lib/auth/account', () => ({ requireRole: auth.requireRole, toErrorResponse: () => new Response(null, { status: 403 }) }))
import { GET } from './route'
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })
it('requires admin access before fetching the fixed public catalogue', async () => {
  auth.requireRole.mockRejectedValue(new Error('forbidden'))
  const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
  expect((await GET()).status).toBe(403)
  expect(fetchMock).not.toHaveBeenCalled()
})
it('fetches public metadata without transmitting account credentials', async () => {
  auth.requireRole.mockResolvedValue({ accountId: 'account' })
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ data: [] })); vi.stubGlobal('fetch', fetchMock)
  const response = await GET()
  expect((await response.json()).models[0].id).toBe('openrouter/free')
  expect(fetchMock.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/models')
  expect(fetchMock.mock.calls[0][1].headers).toBeUndefined()
  expect(auth.requireRole).toHaveBeenCalledWith('admin')
})
it('keeps the free router usable if the catalogue is unavailable', async () => {
  auth.requireRole.mockResolvedValue({ accountId: 'account' })
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
  expect(await (await GET()).json()).toMatchObject({ available: false, models: [{ id: 'openrouter/free' }] })
})
it('makes no outbound request while the AI kill switch is off', async () => {
  vi.stubEnv('AI_ENABLED', 'false')
  auth.requireRole.mockResolvedValue({ accountId: 'account' })
  const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
  expect(await (await GET()).json()).toEqual({ models: [], available: false, disabled: true })
  expect(fetchMock).not.toHaveBeenCalled()
  vi.unstubAllEnvs()
})
