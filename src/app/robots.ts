// robots.txt (store Batch 6). The marketing pages and published shops (/s/<handle>) may be crawled; the app itself, its APIs,
// token links and a shop's private pages (cart, checkout, buyer account, order tracking) may not. The signed-in pages also carry
// noindex; this keeps crawlers from asking for them at all.
//
// No Sitemap line: each shop has its own /s/<handle>/sitemap.xml, but listing every published shop here would need a cross-shop
// enumeration of handles, and resolve_public_shop (one handle at a time) stays the only cross-tenant shop lookup. Batch 1 merges its
// metadataBase / app sitemap here; keep these rules when it does.

import type { MetadataRoute } from 'next';

/** Top-level paths of the signed-in app and its one-time links. */
const PRIVATE = [
  '/api/', '/shop/', '/r/', '/join/', '/my-booking/', '/unsubscribe/', '/book/',
  '/login', '/signup', '/forgot-password', '/reset-password', '/verify-email', '/mfa', '/platform',
  '/ads', '/agents', '/analytics', '/appointments', '/automation', '/automations', '/broadcasts', '/commerce', '/contacts',
  '/dashboard', '/flows', '/forms', '/inbox', '/instagram', '/notifications', '/pipelines', '/reports', '/settings',
  '/templates', '/whatsapp',
];
/** A shop's own private pages. */
const SHOP_PRIVATE = ['/s/*/cart', '/s/*/checkout', '/s/*/account', '/s/*/track'];

export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: '*', allow: '/', disallow: [...PRIVATE, ...SHOP_PRIVATE] } };
}
