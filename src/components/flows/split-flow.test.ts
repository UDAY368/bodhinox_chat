import { describe, expect, it, vi } from 'vitest';
import { splitFlow } from './split-flow';

const ok = (id: string) => Response.json({ flow: { id } }, { status: 201 });

describe('splitFlow', () => {
  it('makes one copy per channel through duplicate and returns their ids', async () => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) =>
      ok(JSON.parse(String(init?.body)).channel_scope === 'whatsapp' ? 'wa-copy' : 'ig-copy'));
    expect(await splitFlow('flow-1', fetcher as never)).toEqual({ whatsapp: 'wa-copy', instagram: 'ig-copy' });
    expect(fetcher.mock.calls.map(([url, init]) => [url, init?.method, JSON.parse(String(init?.body))])).toEqual([
      ['/api/flows/flow-1/duplicate', 'POST', { channel_scope: 'whatsapp' }],
      ['/api/flows/flow-1/duplicate', 'POST', { channel_scope: 'instagram' }],
    ]);
  });

  it('stops and resolves null when a copy is refused or the request fails', async () => {
    const refused = vi.fn(async () => Response.json({ error: 'no' }, { status: 403 }));
    expect(await splitFlow('flow-1', refused as never)).toBeNull();
    expect(refused).toHaveBeenCalledTimes(1);
    const offline = vi.fn().mockResolvedValueOnce(ok('wa-copy')).mockRejectedValueOnce(new TypeError('offline'));
    expect(await splitFlow('flow-1', offline as never)).toBeNull();
  });
});
