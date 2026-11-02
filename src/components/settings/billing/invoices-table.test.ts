import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ session: null as unknown }));
vi.mock('@/lib/auth/client', () => ({ createAuthClient: () => ({ getSession: async () => ({ data: { session: h.session }, error: null }) }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('next-intl', () => ({ useTranslations: () => (k: string) => k, useLocale: () => 'en' }));
import { viewInvoice } from './invoices-table';

let tab: { opener: unknown; closed: boolean; close: ReturnType<typeof vi.fn>; location: { href: string } } | null;
const assign = vi.fn();
beforeEach(() => {
  tab = { opener: {}, closed: false, close: vi.fn(), location: { href: 'about:blank' } };
  vi.stubGlobal('window', { open: vi.fn(() => tab), location: { origin: 'https://app.example', assign } });
});
afterEach(() => vi.unstubAllGlobals());

it('refreshes the session before loading the invoice, so an expired access cookie does not 401', async () => {
  h.session = { user: { id: 'u' } };
  await expect(viewInvoice('inv 1')).resolves.toBe('opened');
  expect(tab!.location.href).toBe('https://app.example/api/billing/invoices/inv%201?format=html');
});

it('closes the tab and reports sign-out when the session cannot be refreshed', async () => {
  h.session = null;
  await expect(viewInvoice('inv_1')).resolves.toBe('signed_out');
  expect(tab!.close).toHaveBeenCalled();
});

it('opens the invoice in this tab when the browser blocked the new one', async () => {
  h.session = { user: { id: 'u' } };
  tab = null;
  await expect(viewInvoice('inv_1')).resolves.toBe('same_tab');
  expect(assign).toHaveBeenCalledWith('/api/billing/invoices/inv_1?format=html');
});
