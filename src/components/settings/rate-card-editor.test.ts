// Phase 14 review (deploy F3 / api-ui F2): a platform admin whose MFA check is
// stale steps up inline from the rate card editor, then the save is retried.
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth/client', () => ({ authFetch: vi.fn() }));

import { saveRateCardChanges } from './rate-card-editor';

const changes = [{ category: 'marketing' as const, country_code: 'IN', currency: 'USD', price_minor: 1 }];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('saveRateCardChanges', () => {
  it('asks for a code on mfa_step_up_required and a separate set-up on mfa_enrollment_required', async () => {
    expect(await saveRateCardChanges(changes, null, vi.fn(async () => json(403, { code: 'mfa_step_up_required' })))).toBe('step_up');
    expect(await saveRateCardChanges(changes, null, vi.fn(async () => json(403, { code: 'mfa_enrollment_required' })))).toBe('enroll');
    expect(await saveRateCardChanges(changes, null, vi.fn(async () => json(500, {})))).toBe('failed');
  });

  it('steps up with the code, then saves', async () => {
    const fetcher = vi.fn(async (url: string) => (url === '/api/auth/mfa-step-up' ? json(200, { ok: true }) : json(200, { updated: 1 })));
    expect(await saveRateCardChanges(changes, ' 123456 ', fetcher as never)).toBe('saved');
    expect(fetcher.mock.calls.map((c) => c[0])).toEqual(['/api/auth/mfa-step-up', '/api/analytics/rate-card']);
    expect(JSON.parse(String((fetcher.mock.calls[0] as unknown[])[1] && ((fetcher.mock.calls[0] as unknown[])[1] as RequestInit).body))).toEqual({ code: '123456' });
  });

  it('does not save when the code is refused', async () => {
    const fetcher = vi.fn(async () => json(400, { code: 'mfa_invalid' }));
    expect(await saveRateCardChanges(changes, '000000', fetcher)).toBe('invalid_code');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
