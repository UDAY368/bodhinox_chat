import { expect, it } from 'vitest'
import { readBoundedBody } from './bounded-body'
it('bounds streamed bodies even when the declared length is missing or false', async () => {
  const request = new Request('http://localhost/upload', { method: 'POST', headers: { 'content-length': '1' }, body: 'too much content' })
  await expect(readBoundedBody(request, 4)).rejects.toMatchObject({ status: 413 })
})
it('returns exact bytes for an accepted body', async () => {
  const request = new Request('http://localhost/upload', { method: 'POST', body: 'data' })
  expect(new TextDecoder().decode(await readBoundedBody(request, 4))).toBe('data')
})
