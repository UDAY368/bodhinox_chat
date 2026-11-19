import { notFound, permanentRedirect, redirect } from 'next/navigation';
import { resolveShopRedirect } from './shop-redirects';

/**
 * A shop page that has nothing to show: follow the admin's redirect for this path if there is one (Next answers 308 for a permanent rule
 * and 307 for a temporary one: the same meaning as 301/302 for a page request), otherwise the plain 404. `path` is relative to
 * /s/<handle>, e.g. "/p/<id>". A lookup failure is a plain 404, never an error page.
 */
export async function notFoundOrRedirect(handle: string, path: string): Promise<never> {
  const hit = await resolveShopRedirect(handle, path).catch(() => null);
  if (hit) {
    if (hit.permanent) permanentRedirect(hit.location);
    redirect(hit.location);
  }
  notFound();
}
