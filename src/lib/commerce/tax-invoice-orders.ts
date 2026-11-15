/**
 * Staff side of GST tax invoices (Store Phase 5): read an order's buyer tax
 * details and invoice state, set or clear the buyer GSTIN before an invoice
 * exists, and ask for the invoice. Agents and above, as every order write
 * (feedback, dispatch); a viewer is refused. The invoice itself is issued by
 * documents.issueTaxInvoiceTx.
 */
import { withTenant } from '@/lib/db/tenant';
import { orderEventTx } from '@/lib/payments/ledger';
import { DocumentError, issueTaxInvoiceTx } from './documents';
import { asStaff, assertStaff, auditOrder, lockOrder, type StaffContext } from './order-lifecycle';
import { OrderError } from './orders';
import { parseBuyerTaxIdentity } from './tax-invoice';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface OrderTaxInvoiceState {
  buyer_gstin: string | null;
  buyer_legal_name: string | null;
  /** False: the workspace has no GSTIN in its store settings, so no tax invoice can be issued. */
  seller_gstin_configured: boolean;
  /** The issued tax invoice, or null. The buyer details are locked once it exists. */
  document_id: string | null;
}

export async function getOrderTaxInvoiceState(ctx: StaffContext, orderId: string): Promise<OrderTaxInvoiceState> {
  assertStaff(ctx);
  if (!UUID.test(orderId)) throw new OrderError(404, 'not_found', 'Order not found');
  return withTenant(ctx, async (tx) => {
    const [order] = await tx.$queryRaw<{ buyer_gstin: string | null; buyer_legal_name: string | null }[]>`
      SELECT buyer_gstin, buyer_legal_name FROM orders WHERE account_id=${ctx.accountId}::uuid AND id=${orderId}::uuid`;
    if (!order) throw new OrderError(404, 'not_found', 'Order not found');
    const [doc] = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM commerce_documents
      WHERE account_id=${ctx.accountId}::uuid AND order_id=${orderId}::uuid AND kind='tax_invoice'`;
    const [settings] = await tx.$queryRaw<{ gstin: string | null }[]>`SELECT gstin FROM commerce_settings WHERE account_id=${ctx.accountId}::uuid`;
    return { ...order, seller_gstin_configured: Boolean(settings?.gstin), document_id: doc?.id ?? null };
  });
}

/** Set (or, with an empty GSTIN, clear) the buyer's GSTIN and legal name. Refused once the tax invoice is issued. */
export async function setOrderBuyerTax(ctx: StaffContext, orderId: string, input: { gstin: unknown; legal_name: unknown }): Promise<void> {
  assertStaff(ctx);
  if (!UUID.test(orderId)) throw new OrderError(404, 'not_found', 'Order not found');
  const buyer = parseBuyerTaxIdentity(input.gstin, input.legal_name);
  if (!buyer) throw new OrderError(400, 'invalid_gstin', 'Invalid GSTIN');
  await asStaff(ctx, async (tx) => {
    await lockOrder(tx, ctx.accountId, orderId);
    const [doc] = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM commerce_documents
      WHERE account_id=${ctx.accountId}::uuid AND order_id=${orderId}::uuid AND kind='tax_invoice'`;
    if (doc) throw new OrderError(409, 'invoice_issued', 'The tax invoice is already issued');
    await tx.$executeRaw`UPDATE orders SET buyer_gstin=${buyer.gstin}, buyer_legal_name=${buyer.legal_name}, updated_at=now()
      WHERE account_id=${ctx.accountId}::uuid AND id=${orderId}::uuid`;
    await orderEventTx(tx, ctx.accountId, orderId, 'buyer_tax_updated', { actorUserId: ctx.userId, detail: buyer.gstin ? 'set' : 'cleared' });
    await auditOrder(tx, ctx, 'order.buyer_tax_updated', orderId, { cleared: buyer.gstin === null });
  });
}

/** Issue (or return the existing) tax invoice on staff request. Returns the document id. */
export async function requestOrderTaxInvoice(ctx: StaffContext, orderId: string): Promise<string> {
  assertStaff(ctx);
  if (!UUID.test(orderId)) throw new OrderError(404, 'not_found', 'Order not found');
  try {
    return await asStaff(ctx, (tx) => issueTaxInvoiceTx(tx, ctx.accountId, orderId));
  } catch (error) {
    if (!(error instanceof DocumentError)) throw error;
    if (error.code === 'not_found') throw new OrderError(404, 'not_found', 'Order not found');
    if (error.code === 'seller_gstin_missing' || error.code === 'buyer_gstin_missing')
      throw new OrderError(409, error.code, error.code === 'seller_gstin_missing' ? 'Add your GSTIN in store settings first' : 'Add the buyer GSTIN first');
    throw new OrderError(409, 'bad_transition', 'A tax invoice cannot be issued for this order yet');
  }
}
