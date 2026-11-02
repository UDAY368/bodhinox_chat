import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openInNewTab } from './open-tab';

type Tab = { opener: unknown; closed: boolean; close: ReturnType<typeof vi.fn>; location: { href: string } };
let tab: Tab | null;
const open = vi.fn(() => tab);

beforeEach(() => {
  tab = { opener: {}, closed: false, close: vi.fn(), location: { href: 'about:blank' } };
  vi.stubGlobal('window', { open, location: { origin: 'https://app.example' } });
});
afterEach(() => vi.unstubAllGlobals());

describe('openInNewTab', () => {
  it('opens the tab before awaiting, then navigates it with the opener cut', async () => {
    const result = await openInNewTab(async () => {
      expect(open).toHaveBeenCalledWith('', '_blank');
      return 'https://rzp.io/i/abc';
    });
    expect(result).toEqual({ opened: true, url: 'https://rzp.io/i/abc' });
    expect(tab!.opener).toBeNull();
    expect(tab!.location.href).toBe('https://rzp.io/i/abc');
  });

  it('returns the URL to show as a link when the browser blocked the tab', async () => {
    tab = null;
    await expect(openInNewTab(async () => 'https://rzp.io/i/abc')).resolves.toEqual({ opened: false, url: 'https://rzp.io/i/abc' });
  });

  it('closes the blank tab when the request fails', async () => {
    await expect(openInNewTab(async () => { throw new Error('Payment failed'); })).rejects.toThrow('Payment failed');
    expect(tab!.close).toHaveBeenCalled();
    expect(tab!.location.href).toBe('about:blank');
  });

  it('never loads a non-web URL and closes the tab instead', async () => {
    await expect(openInNewTab(async () => 'javascript:alert(1)')).rejects.toThrow();
    await expect(openInNewTab(async () => 'http://evil.example/pay')).rejects.toThrow();
    expect(tab!.close).toHaveBeenCalledTimes(2);
    expect(tab!.location.href).toBe('about:blank');
  });

  it('resolves same-origin paths against this site', async () => {
    await openInNewTab(async () => '/api/billing/invoices/inv_1?format=html');
    expect(tab!.location.href).toBe('https://app.example/api/billing/invoices/inv_1?format=html');
  });
});
