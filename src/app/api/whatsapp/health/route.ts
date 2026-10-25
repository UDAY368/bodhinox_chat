import { NextResponse } from 'next/server';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { decrypt } from '@/lib/whatsapp/encryption';
import { getPhoneNumberHealth } from '@/lib/whatsapp/meta-api';
import { parseMessagingLimit, parseQualityRating, type PhoneHealth } from '@/lib/whatsapp/phone-health';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

const empty = { displayPhoneNumber: null, quality: 'UNKNOWN', limit: null } as const;
const reply = (body: PhoneHealth) => NextResponse.json(body, { headers: { 'Cache-Control': 'private, max-age=300' } });
export async function GET() {
  try {
    const { db, accountId, userId } = await getCurrentAccount();
    const limit = checkRateLimit(`whatsapp:health:${accountId}:${userId}`, { limit: 12, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);
    const { data: config, error } = await db.from('whatsapp_config').select('phone_number_id,access_token,status').eq('account_id', accountId).maybeSingle();
    if (error) throw error;
    if (!config?.phone_number_id || !config.access_token || config.status !== 'connected') return reply({ state: 'disconnected', ...empty });
    try {
      const info = await getPhoneNumberHealth({ phoneNumberId: config.phone_number_id, accessToken: decrypt(config.access_token) });
      return reply({ state: 'connected', displayPhoneNumber: info.display_phone_number ?? null, quality: parseQualityRating(info.quality_rating), limit: parseMessagingLimit(info.whatsapp_business_manager_messaging_limit) });
    } catch { return reply({ state: 'unavailable', ...empty }); }
  } catch (error) { return toErrorResponse(error); }
}
