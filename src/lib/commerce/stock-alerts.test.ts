import { describe, expect, it } from 'vitest';
import { CART_CODE, newCartCode } from './public-shop';
import { NOTICE_TEMPLATE_CATEGORY, NOTICE_TEMPLATE_KINDS } from './order-followup';
import { BACK_IN_STOCK_BATCH, parseStockAlertMessage, stockAlertMessage } from './stock-alerts';

describe('parseStockAlertMessage', () => {
  it('reads the code at the end of the message, in any case and spacing', () => {
    expect(parseStockAlertMessage('Notify me when Brahmi oil (100ml) is back. NOTIFY ABCD23')).toBe('ABCD23');
    expect(parseStockAlertMessage('notify   abcd23')).toBe('ABCD23');
    expect(parseStockAlertMessage('  NOTIFY ABCD23  \n')).toBe('ABCD23');
    expect(parseStockAlertMessage('NOTIFY ABCD23')).toBe('ABCD23');
  });

  it('takes only a code of our alphabet at the very end', () => {
    for (const text of ['NOTIFY ABCD2', 'NOTIFY ABCD234', 'NOTIFY ABCDI2', 'NOTIFY ABCDO2', 'NOTIFY ABCD20', 'NOTIFY ABCD21',
      'NOTIFY ABCD23 thanks', 'XNOTIFY ABCD23', 'ORDER ABCD23', 'NOTIFY', '', 'notify me']) expect(parseStockAlertMessage(text)).toBeNull();
    expect(parseStockAlertMessage(null)).toBeNull();
    expect(parseStockAlertMessage(undefined)).toBeNull();
  });

  it('ignores a text over 2000 characters', () => {
    expect(parseStockAlertMessage(`${'a '.repeat(1000)}NOTIFY ABCD23`)).toBeNull();
    expect(parseStockAlertMessage(`${'a'.repeat(1900)} NOTIFY ABCD23`)).toBe('ABCD23');
  });

  it('round-trips the message the page builds, and shares the alphabet of the cart codes', () => {
    for (let i = 0; i < 50; i++) {
      const code = newCartCode();
      expect(CART_CODE.test(code)).toBe(true);
      expect(parseStockAlertMessage(stockAlertMessage('Notify me when Tulsi drops (60ml) is back.', code))).toBe(code);
    }
    // A long product name is cut so the code is never lost.
    expect(parseStockAlertMessage(stockAlertMessage('x'.repeat(5000), 'ABCD23'))).toBe('ABCD23');
  });
});

describe('back_in_stock notice kind', () => {
  it('is a marketing template kind and runs in batches', () => {
    expect(NOTICE_TEMPLATE_KINDS).toContain('back_in_stock');
    expect(NOTICE_TEMPLATE_CATEGORY.back_in_stock).toBe('MARKETING');
    expect(BACK_IN_STOCK_BATCH).toBe(200);
  });
});
