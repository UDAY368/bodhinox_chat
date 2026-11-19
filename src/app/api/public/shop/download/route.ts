// GET /api/public/shop/download?a=<account>&o=<order>&e=<expiry ms>&s=<signature>[&p=<product>]
// The signed, expiring download link of a digital product (store plan Phase 8, batch 3). The signature,
// the expiry and the order being paid (and not fully refunded) are checked before anything is read; the
// answer is a redirect to the product's https URL, the file streamed as an attachment, or (for an order
// with several digital products and no `p`) a short page listing a signed link for each. No storage path,
// bucket or credential is ever sent. A bad link is the plain 404 and an expired one is 410.

import { NextResponse } from 'next/server';
import { checkDownload, downloadQuery, DOWNLOAD_LINK_TTL_MS } from '@/lib/commerce/selling-tokens';
import { DOWNLOAD_PATH, resolveDownload } from '@/lib/commerce/digital-delivery';
import { getT } from '@/lib/i18n/translate';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { getMedia } from '@/lib/storage/server';
import { burstAllowed, json, notFound, publicError, tooMany, NO_STORE } from '../_lib/public';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const esc = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const safeType = (value: string | null | undefined) => (value && /^[\w.+-]+\/[\w.+-]+$/.test(value) ? value : 'application/octet-stream');
const fileName = (name: string) => name.replace(/[^\w. -]+/g, '_').slice(0, 80) || 'download';

export async function GET(request: Request) {
  if (!burstAllowed('read', request)) return tooMany();
  try {
    const params = new URL(request.url).searchParams;
    const accountId = params.get('a'), orderId = params.get('o');
    const verdict = checkDownload({ accountId, orderId, expires: params.get('e'), signature: params.get('s') }, new Date());
    if (verdict === 'invalid' || !accountId || !orderId) return notFound();
    if (verdict === 'expired') return json({ code: 'link_expired' }, 410);
    const target = await resolveDownload(accountId, orderId, params.get('p'));
    if (!target) return notFound();
    if (target.kind === 'url')
      return new Response(null, { status: 302, headers: { Location: target.url, ...NO_STORE } });
    if (target.kind === 'list') {
      const expires = Number(params.get('e'));
      const t = getT('ShopPublic.download');
      const items = target.items.map((item) => {
        const query = `${downloadQuery({ accountId, orderId }, new Date(Math.min(expires, Date.now() + DOWNLOAD_LINK_TTL_MS)))}&p=${item.productId}`;
        return `<li><a href="${DOWNLOAD_PATH}?${esc(query)}">${esc(item.name)}</a></li>`;
      }).join('');
      return new NextResponse(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
        + `<meta name="robots" content="noindex"><title>${esc(t('title'))}</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem">`
        + `<h1 style="font-size:1.25rem">${esc(t('title'))}</h1><ul style="line-height:2">${items}</ul></body></html>`,
      { headers: { 'Content-Type': 'text/html; charset=utf-8', ...NO_STORE, 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" } });
    }
    const [media] = await withTenant({ accountId, role: 'owner' }, (tx) => tx.$queryRaw<{ bucket: string; object_key: string; content_type: string | null }[]>`
      SELECT bucket, object_key, content_type FROM media_objects
      WHERE account_id=${accountId}::uuid AND id=${target.mediaId}::uuid AND deleted_at IS NULL`, getWorkerPrisma());
    if (!media) return notFound();
    const { object } = await getMedia({ accountId, role: 'owner' }, media.bucket, media.object_key);
    if (!object.Body) return notFound();
    return new Response(object.Body.transformToWebStream() as ReadableStream<Uint8Array>, {
      headers: {
        'Content-Type': safeType(media.content_type), 'Content-Disposition': `attachment; filename="${fileName(target.name)}"`,
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", ...NO_STORE,
      },
    });
  } catch (error) {
    return publicError(error, 'shop:download');
  }
}
