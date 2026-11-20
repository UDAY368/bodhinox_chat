import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ appointments: true }));
vi.mock('@/lib/billing/entitlements', async (orig) => ({
  ...(await orig<typeof import('@/lib/billing/entitlements')>()),
  getEntitlements: async () => ({ features: { appointments: h.appointments } }),
}));

import { AI_CONTEXT_MAX_CHARS, clampContext, customerBookingContext } from './ai-context';

describe('clampContext', () => {
  it('is null with nothing to say', () => {
    expect(clampContext([])).toBeNull();
  });

  it('keeps whole lines within the limit', () => {
    expect(clampContext(['a'.repeat(300), 'b'.repeat(298)])).toBe(`${'a'.repeat(300)}\n${'b'.repeat(298)}`);
    expect(clampContext(['a'.repeat(300), 'b'.repeat(300)])).toBe('a'.repeat(300));
  });

  it('cuts a single overlong line to the limit', () => {
    const out = clampContext(['x'.repeat(2000)])!;
    expect(out.length).toBe(AI_CONTEXT_MAX_CHARS);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('customerBookingContext', () => {
  it('is null without the appointments plan feature, before reading any booking', async () => {
    h.appointments = false;
    const tx = { $queryRaw: () => { throw new Error('must not query'); } };
    expect(await customerBookingContext(tx as never, 'acct', 'contact')).toBeNull();
  });
});
