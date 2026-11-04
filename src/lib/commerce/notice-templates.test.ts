import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/i18n/translate', () => ({ getT: () => (key: string) => key }));
vi.mock('@/lib/db/tenant', () => ({ withTenant: vi.fn() }));
vi.mock('@/lib/auth/account', () => ({ toErrorResponse: vi.fn() }));

import { isNoticeTemplateKind, parseNoticeTemplateInput } from './notice-templates';

describe('parseNoticeTemplateInput', () => {
  it('accepts a kind with a template, or a kind alone to clear it', () => {
    expect(parseNoticeTemplateInput({ kind: 'delivered', template_name: ' order_update ', language: 'en' }))
      .toEqual({ kind: 'delivered', template: { name: 'order_update', language: 'en' } });
    expect(parseNoticeTemplateInput({ kind: 'repeat_purchase', template_name: null, language: null }))
      .toEqual({ kind: 'repeat_purchase', template: null });
  });
  it('refuses an unknown kind, a missing language and a non-object body', () => {
    for (const body of [null, [], 'x', { kind: 'product_follow_up', template_name: 'a', language: 'en' },
      { kind: 'delivered', template_name: 'a' }, { kind: 'delivered', template_name: 'a', language: 'e' },
      { kind: 'delivered', template_name: 'x'.repeat(513), language: 'en' }]) {
      expect(() => parseNoticeTemplateInput(body)).toThrow(expect.objectContaining({ code: 'invalid' }));
    }
  });
  it('knows the four notice kinds only', () => {
    expect(['dispatched', 'delivered', 'feedback', 'repeat_purchase'].every(isNoticeTemplateKind)).toBe(true);
    expect(isNoticeTemplateKind('product_follow_up')).toBe(false);
  });
});
