// GST tax invoice of an order (agents and above; another workspace's order is a 404).
//   GET  -> 200 { tax_invoice: { buyer_gstin, buyer_legal_name, seller_gstin_configured, document_id } }
//   PUT  { gstin: string | null, legal_name?: string | null } -> sets or clears the buyer GSTIN (400 invalid_gstin;
//        409 invoice_issued once the invoice exists)
//   POST -> issues the invoice (or returns the existing one): 200 { document_id }; 409 seller_gstin_missing |
//        buyer_gstin_missing | bad_transition

import { NextResponse } from 'next/server';

import { getOrderTaxInvoiceState, requestOrderTaxInvoice, setOrderBuyerTax } from '@/lib/commerce/tax-invoice-orders';
import { jsonBody, lifecycleErrorResponse, NO_STORE, staffContext, writeLimit } from '../../_lib/http';

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const ctx = await staffContext();
    return NextResponse.json({ tax_invoice: await getOrderTaxInvoiceState(ctx, id) }, { headers: NO_STORE });
  } catch (error) {
    return lifecycleErrorResponse(error);
  }
}

export async function PUT(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const ctx = await staffContext();
    const limited = await writeLimit(ctx);
    if (limited) return limited;
    const body = await jsonBody(request);
    await setOrderBuyerTax(ctx, id, { gstin: body.gstin, legal_name: body.legal_name });
    return NextResponse.json({ tax_invoice: await getOrderTaxInvoiceState(ctx, id) }, { headers: NO_STORE });
  } catch (error) {
    return lifecycleErrorResponse(error);
  }
}

export async function POST(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const ctx = await staffContext();
    const limited = await writeLimit(ctx);
    if (limited) return limited;
    return NextResponse.json({ document_id: await requestOrderTaxInvoice(ctx, id) }, { headers: NO_STORE });
  } catch (error) {
    return lifecycleErrorResponse(error);
  }
}
