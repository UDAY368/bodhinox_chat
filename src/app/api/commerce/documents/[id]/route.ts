// GET /api/commerce/documents/[id] — a receipt / tax invoice or credit note as printable HTML
//   (agents and above; another account's id is a 404). Served with a CSP that allows no scripts,
//   no network and inline styles only; every value is escaped by the renderer.

import { NextResponse } from 'next/server';

import { getCommerceDocument, renderCommerceDocumentHtml, type DocumentLabels } from '@/lib/commerce/documents';
import { getT } from '@/lib/i18n/translate';
import { lifecycleErrorResponse, staffContext } from '../../orders/_lib/http';

type Context = { params: Promise<{ id: string }> };

const LABEL_KEYS: (keyof DocumentLabels)[] = [
  'receipt', 'taxInvoice', 'creditNote', 'number', 'date', 'seller', 'gstin', 'billTo', 'shipTo', 'item', 'hsn', 'qty',
  'price', 'discount', 'tax', 'amount', 'subtotal', 'shipping', 'cgst', 'sgst', 'igst', 'total', 'taxIncluded',
];

function appLocale(): string {
  const env = process.env.NEXT_PUBLIC_APP_LOCALE ?? '';
  return ['en', 'pt', 'es', 'ko'].includes(env) ? env : 'en';
}

export async function GET(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const ctx = await staffContext();
    const doc = await getCommerceDocument(ctx, id);
    if (!doc) return NextResponse.json({ error: 'Document not found', code: 'not_found' }, { status: 404 });
    const t = getT('Commerce.documents.print');
    const labels = Object.fromEntries(LABEL_KEYS.map((k) => [k, t(k)])) as unknown as DocumentLabels;
    return new NextResponse(renderCommerceDocumentHtml(doc, labels, appLocale()), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'private, no-store',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    return lifecycleErrorResponse(error);
  }
}
