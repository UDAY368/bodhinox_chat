// A campaign route's JSON body, refused past CAMPAIGN_LIMITS.bodyBytes (413); null when it is not JSON.
import { AuthError } from '@/lib/auth/errors';
import { CAMPAIGN_LIMITS } from './create-campaign';

export async function readBoundedJson(request: Request): Promise<unknown> {
  if (Number(request.headers.get('content-length') ?? 0) > CAMPAIGN_LIMITS.bodyBytes) throw new AuthError('Request is too large', 413);
  const text = await request.text();
  if (text.length > CAMPAIGN_LIMITS.bodyBytes) throw new AuthError('Request is too large', 413);
  try { return JSON.parse(text); } catch { return null; }
}
