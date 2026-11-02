// Sequential tax-invoice numbers per Indian financial year (April to March, in
// India time): BX/2026-27/000001, BX/2026-27/000002, ...
//
// Race-safe and gapless: the counter is one row per financial year, bumped by a
// single upsert that row-locks it, so concurrent issuers serialise on that row
// and each gets a distinct number. Call it in the same transaction that inserts
// the invoice: if that transaction rolls back, the number is released with it.
// Runs as the worker role (invoice_sequences and invoices are worker-written).

import type { Prisma } from '@prisma/client';

export const INVOICE_PREFIX = 'BX';
const TIME_ZONE = 'Asia/Kolkata';

/** '2026-27' for any date from 1 April 2026 to 31 March 2027, India time. */
export function financialYear(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new Error('Invalid invoice date');
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit' }).formatToParts(date);
  const year = Number(parts.find((p) => p.type === 'year')?.value);
  const month = Number(parts.find((p) => p.type === 'month')?.value);
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

export function formatInvoiceNumber(fy: string, sequence: number): string {
  return `${INVOICE_PREFIX}/${fy}/${String(sequence).padStart(6, '0')}`;
}

/** Reserves the next invoice number for `date`'s financial year inside `tx`. */
export async function nextInvoiceNumber(tx: Prisma.TransactionClient, date: Date = new Date()): Promise<string> {
  const fy = financialYear(date);
  const [row] = await tx.$queryRaw<{ last_value: bigint }[]>`
    INSERT INTO invoice_sequences AS s (financial_year, last_value) VALUES (${fy}, 1)
    ON CONFLICT (financial_year) DO UPDATE SET last_value = s.last_value + 1
    RETURNING s.last_value`;
  return formatInvoiceNumber(fy, Number(row.last_value));
}
