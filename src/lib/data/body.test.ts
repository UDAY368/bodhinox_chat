import { expect, it } from 'vitest';
import { readJsonBody } from './body';
it('rejects streamed oversized bodies before buffering them completely', async () => {
  const request = new Request('https://example.test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"text":"oversize"}',
  });
  await expect(readJsonBody(request, 5)).rejects.toMatchObject({
    code: 'BODY_TOO_LARGE',
    status: 413,
  });
});
it('decodes JSON and rejects unsupported media types', async () => {
  await expect(
    readJsonBody(
      new Request('https://example.test', { method: 'POST', body: '{}' })
    )
  ).rejects.toMatchObject({ status: 415 });
  expect(
    await readJsonBody(
      new Request('https://example.test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"name":"Ada"}',
      })
    )
  ).toEqual({ name: 'Ada' });
});
