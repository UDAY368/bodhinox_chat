/**
 * CSV export of orders (admins only). Every cell is quoted and a leading = + - @ tab or CR is neutralised
 * with a single quote so a spreadsheet never runs it. The customer's number follows the member's phone
 * masking. Internal notes are never exported. Reads at most EXPORT_MAX_ROWS orders, newest first.
 */

import type { TenantContext } from '@/lib/db/tenant';
import { maskContactIdentifier, resolvePhoneMask } from '@/lib/inbox/masking-apply';
import { csvCell as quoteCell } from '@/lib/audience/csv-cell';
import { minorToDecimalString } from './money';
import { customExtrasText } from './checkout-extras';
import { listOrders, type OrderFilters, type OrderListItem } from './orders';

export const EXPORT_MAX_ROWS = 5000;
const PAGE = 500;

/** Quoted, with every formula trigger (including a leading + on a phone number) defused by a single quote. */
export const csvCell = (value: string | number | null | undefined): string =>
  quoteCell(typeof value === 'string' && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value);

export const csvRow = (cells: ReadonlyArray<string | number | null | undefined>): string => cells.map(csvCell).join(',');

export const EXPORT_HEADER = ['order', 'date', 'status', 'source', 'payment', 'customer', 'phone', 'items', 'currency', 'total',
  'amount_paid', 'refund', 'tags', 'risk', 'order_note', 'gift_message', 'delivery_date', 'delivery_slot', 'custom_fields'] as const;

export function orderCsvRow(o: OrderListItem, maskPhone: boolean): string {
  const phone = o.contact?.phone ?? '';
  return csvRow([
    o.external_id ? `#${o.external_id}` : o.id.slice(0, 8).toUpperCase(), o.created_at, o.status, o.source, o.payment_method,
    o.contact?.name ?? '', maskPhone ? String(maskContactIdentifier(phone)) : phone, o.item_count, o.currency,
    minorToDecimalString(o.total_minor ?? o.subtotal_minor, o.currency), o.paid_at ?? '', o.refund_state, o.tags.join(' '), o.risk.level,
    // What the buyer typed at checkout: free text, so every cell goes through the formula guard.
    o.extras?.note ?? '', o.extras?.gift_message ?? '', o.extras?.delivery_date ?? '', o.extras?.delivery_slot ?? '', customExtrasText(o.extras),
  ]);
}

/** The CSV text and whether more orders matched than the cap allows. Filters: the same as the list (parseOrderFilters). */
export async function exportOrdersCsv(ctx: TenantContext, filters: OrderFilters): Promise<{ csv: string; rows: number; truncated: boolean }> {
  const mask = await resolvePhoneMask(ctx);
  const lines = [csvRow(EXPORT_HEADER)];
  let cursor: string | null = null;
  let rows = 0;
  let truncated = false;
  do {
    const page = await listOrders(ctx, { ...filters, limit: Math.min(PAGE, EXPORT_MAX_ROWS + 1 - rows), ...(cursor ? { cursor } : {}) });
    for (const o of page.orders) {
      if (rows === EXPORT_MAX_ROWS) { truncated = true; break; }
      lines.push(orderCsvRow(o, mask));
      rows++;
    }
    cursor = truncated ? null : page.next_cursor;
  } while (cursor);
  return { csv: `\uFEFF${lines.join('\r\n')}\r\n`, rows, truncated };
}
