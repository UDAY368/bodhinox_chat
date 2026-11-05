// Phase 14 review (api-ui F3): the export download refreshes an expired
// session before the browser navigates to the zip.
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth/client', () => ({ authFetch: vi.fn() }));

import { openExportDownload } from './workspace-export-card';

describe('openExportDownload', () => {
  it('makes one authenticated request (which refreshes on a 401) before navigating', async () => {
    const order: string[] = [];
    const fetcher = vi.fn(async (url: string) => { order.push(`fetch ${url}`); return new Response('{}'); });
    await openExportDownload('11111111-1111-4111-8111-111111111111', (url) => order.push(`go ${url}`), fetcher as never);
    expect(order).toEqual(['fetch /api/account/export', 'go /api/account/export/11111111-1111-4111-8111-111111111111/download']);
  });

  it('still navigates when the check fails (the route answers for itself)', async () => {
    const go = vi.fn();
    await openExportDownload('x', go, vi.fn(async () => { throw new Error('offline'); }) as never);
    expect(go).toHaveBeenCalledWith('/api/account/export/x/download');
  });
});
