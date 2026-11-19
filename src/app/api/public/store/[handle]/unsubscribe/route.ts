// POST /api/public/store/<handle>/unsubscribe  { token }
// The unsubscribe page's button: records that the contact the token names does not want marketing email, for good. The token is the
// one in the email's link (an HMAC the server made; it names the workspace, so the handle in the path is only a path). 200 { ok: true };
// 400 { code: 'invalid' } for a token that is not ours. Idempotent. Origin, size and burst checks come from shopPost.

import { unsubscribeByToken } from '@/lib/commerce/email-jobs';
import { StoreError } from '@/lib/commerce/store-settings';
import { shopPost, type HandleParams } from '../../_lib/shop';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST(request: Request, context: HandleParams) {
  return shopPost(request, context, 'unsubscribe', async (_handle, body) => {
    if (!(await unsubscribeByToken(body.token))) throw new StoreError('invalid');
    return { ok: true };
  });
}
