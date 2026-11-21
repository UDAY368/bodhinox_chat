import { describe, expect, it, vi } from 'vitest';

describe('browser catalogue stand-in', () => {
  it('a translator taken at load time, before the catalogue arrives, translates once it has', async () => {
    vi.resetModules();
    vi.doMock('@app-messages', async () => import('./browser-messages'));
    const { getT } = await import('@/lib/i18n/translate');
    const { registerBrowserMessages, default: messages } = await import('./browser-messages');
    const t = getT('Api');
    expect(t('hello')).toBe('Api.hello');
    registerBrowserMessages({ Api: { hello: 'Hello {name}' } });
    expect(messages).toEqual({ Api: { hello: 'Hello {name}' } });
    expect(t('hello', { name: 'Ana' })).toBe('Hello Ana');
    vi.doUnmock('@app-messages');
  });
});
