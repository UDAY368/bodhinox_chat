import { afterEach, expect, it, vi } from 'vitest';
import { openCheckout } from './razorpay-checkout';

afterEach(() => vi.unstubAllGlobals());

it('returns the hosted page instead of opening a tab when the Checkout script cannot load', async () => {
  const open = vi.fn();
  vi.stubGlobal('window', { open });
  vi.stubGlobal('document', {
    createElement: () => ({}),
    head: { appendChild: (script: { onerror?: () => void }) => queueMicrotask(() => script.onerror?.()) },
  });
  const session = { subscription_id: 'sub_1', short_url: 'https://rzp.io/i/abc', key_id: 'rzp_test', prefill: { name: '', email: '' } };
  await expect(openCheckout(session, { name: 'n', description: 'd' })).resolves.toEqual({ redirect: 'https://rzp.io/i/abc' });
  expect(open).not.toHaveBeenCalled();
  await expect(openCheckout({ ...session, short_url: 'http://rzp.io/x' }, { name: 'n', description: 'd' })).rejects.toThrow('Checkout unavailable');
});
