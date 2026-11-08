import { describe, expect, it } from 'vitest';
import {
  commerceMessageFromNode,
  commerceMessageFromRequest,
  commerceMessageRefusal,
  commerceRejectionKey,
  commerceMessageText,
  conversationRefusal,
  messageProductRefs,
  type CommerceMessage,
} from './catalog-send';

describe('commerceRejectionKey', () => {
  it('names the window, product and recipient refusals and falls back to a plain rejection', () => {
    expect(commerceRejectionKey({ code: 131047 })).toBe('rejected_window');
    for (const code of [131009, 131008, 100]) expect(commerceRejectionKey({ code })).toBe('rejected_product');
    expect(commerceRejectionKey({ code: 131026 })).toBe('rejected_recipient');
    for (const code of [131000, 190, null]) expect(commerceRejectionKey({ code })).toBe('rejected');
  });
});

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const ids = (n: number) => Array.from({ length: n }, (_, i) => ({ retailerId: `sku-${i}` }));

describe('commerceMessageRefusal', () => {
  it('accepts the three kinds within Meta limits', () => {
    expect(commerceMessageRefusal({ kind: 'product', product: { id: P1 } })).toBeNull();
    expect(commerceMessageRefusal({ kind: 'catalog', body: 'Browse', thumbnail: { retailerId: 'sku-1' } })).toBeNull();
    expect(commerceMessageRefusal({ kind: 'product_list', header: 'New', body: 'Pick', sections: [{ title: '', products: ids(30) }] })).toBeNull();
    expect(commerceMessageRefusal({ kind: 'product_list', header: 'New', body: 'Pick',
      sections: [{ title: 'A', products: ids(1) }, { title: 'B', products: [{ retailerId: 'other' }] }] })).toBeNull();
  });

  it('refuses shapes Meta would reject, before anything is sent', () => {
    const bad: CommerceMessage[] = [
      { kind: 'product', product: { id: 'not-a-uuid' } },
      { kind: 'product', product: { retailerId: ' ' } },
      { kind: 'product', product: { id: P1 }, footer: 'f'.repeat(61) },
      { kind: 'catalog', body: '  ' },
      { kind: 'catalog', body: 'b'.repeat(1025) },
      { kind: 'product_list', header: '', body: 'Pick', sections: [{ title: '', products: ids(1) }] },
      { kind: 'product_list', header: 'h'.repeat(61), body: 'Pick', sections: [{ title: '', products: ids(1) }] },
      { kind: 'product_list', header: 'New', body: 'Pick', sections: [] },
      { kind: 'product_list', header: 'New', body: 'Pick', sections: [{ title: '', products: ids(31) }] },
      { kind: 'product_list', header: 'New', body: 'Pick', sections: [{ title: 'A', products: ids(1) }, { title: '', products: [{ retailerId: 'x' }] }] },
      { kind: 'product_list', header: 'New', body: 'Pick', sections: [{ title: 't'.repeat(25), products: ids(1) }] },
      { kind: 'product_list', header: 'New', body: 'Pick', sections: [{ title: 'A', products: ids(1) }, { title: 'B', products: ids(1) }] },
      { kind: 'product_list', header: 'New', body: 'Pick', sections: Array.from({ length: 11 }, (_, i) => ({ title: `S${i}`, products: [{ retailerId: `r${i}` }] })) },
      { kind: 'bogus' } as unknown as CommerceMessage,
    ];
    for (const message of bad) expect(commerceMessageRefusal(message)).toBe('invalid_message');
  });
});

describe('conversationRefusal', () => {
  const now = Date.UTC(2026, 10, 2, 12);
  const contact = { phone: '+919800000001', wa_user_id: null, blocked_at: null };
  it('needs an open 24-hour window, an address and an unblocked contact', () => {
    expect(conversationRefusal({ contact, lastCustomerMessageAt: new Date(now - 60_000) }, now)).toBeNull();
    expect(conversationRefusal({ contact, lastCustomerMessageAt: new Date(now - 24 * 3600_000) }, now)).toBe('window_closed');
    expect(conversationRefusal({ contact, lastCustomerMessageAt: null }, now)).toBe('window_closed');
    expect(conversationRefusal({ contact: { ...contact, blocked_at: new Date() }, lastCustomerMessageAt: new Date(now) }, now)).toBe('contact_blocked');
    expect(conversationRefusal({ contact: { phone: null, wa_user_id: null, blocked_at: null }, lastCustomerMessageAt: new Date(now) }, now)).toBe('no_address');
    expect(conversationRefusal({ contact: null, lastCustomerMessageAt: null }, now)).toBe('conversation_not_found');
  });
});

describe('commerceMessageFromRequest', () => {
  it('maps the inbox body to a message by product row id', () => {
    expect(commerceMessageFromRequest({ kind: 'product', product_id: P1, body: 'Hi', footer: 3 })).toEqual({
      kind: 'product', product: { id: P1 }, body: 'Hi', footer: undefined,
    });
    expect(commerceMessageFromRequest({ kind: 'product_list', header: 'H', body: 'B', sections: [{ title: 'S', product_ids: [P1, 7] }] })).toEqual({
      kind: 'product_list', header: 'H', body: 'B', footer: undefined, sections: [{ title: 'S', products: [{ id: P1 }, { id: '' }] }],
    });
    expect(commerceMessageFromRequest({ kind: 'catalog', body: 'B', thumbnail_product_id: P2 })).toMatchObject({ thumbnail: { id: P2 } });
    expect(commerceMessageFromRequest({ kind: 'text' })).toBeNull();
  });

  it('caps oversized lists so they are refused, not processed', () => {
    const many = commerceMessageFromRequest({ kind: 'product_list', header: 'H', body: 'B',
      sections: Array.from({ length: 50 }, () => ({ title: 'x', product_ids: Array.from({ length: 100 }, () => P1) })) });
    expect(many && many.kind === 'product_list' && many.sections.length).toBe(11);
    expect(commerceMessageRefusal(many!)).toBe('invalid_message');
  });
});

describe('commerceMessageFromNode', () => {
  it('builds each flow step with retailer ids and filled texts', () => {
    const fill = (s: string) => s.replace('{{vars.name}}', 'Asha');
    expect(commerceMessageFromNode('send_product', { product_retailer_id: 'SKU', body_text: 'For {{vars.name}}', next_node_key: 'n' }, fill))
      .toEqual({ kind: 'product', product: { retailerId: 'SKU' }, body: 'For Asha', footer: undefined });
    expect(commerceMessageFromNode('send_catalog', { body_text: 'Shop', footer_text: 'Bye' }))
      .toEqual({ kind: 'catalog', body: 'Shop', footer: 'Bye', thumbnail: undefined });
    const list = commerceMessageFromNode('send_product_list', { header_text: 'H', body_text: 'B', sections: [{ title: 'S', product_retailer_ids: ['a', 'b'] }] });
    expect(messageProductRefs(list)).toEqual([{ retailerId: 'a' }, { retailerId: 'b' }]);
  });
});

it('shows the products by name in the inbox copy', () => {
  const products = new Map([[`id:${P1}`, { id: P1, retailer_id: 'a', name: 'Shoe' }], ['rid:b', { id: P2, retailer_id: 'b', name: 'Bag' }]]);
  expect(commerceMessageText({ kind: 'product_list', header: 'New', body: 'Pick one', footer: 'Thanks',
    sections: [{ title: 'S', products: [{ id: P1 }, { retailerId: 'b' }] }] }, products)).toBe('New\nPick one\n[Shoe, Bag]\nThanks');
  expect(commerceMessageText({ kind: 'product', product: { id: P1 } }, products)).toBe('[Shoe]');
});
