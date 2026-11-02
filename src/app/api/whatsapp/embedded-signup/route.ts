// POST /api/whatsapp/embedded-signup (admin), one of:
//   { code, waba_id, phone_number_id, pin? }  connect the number the admin picked in
//       Meta's Embedded Signup popup. pin is the number's existing 6-digit two-step
//       PIN, if it has one; without it a fresh PIN is set and returned once.
//   { config_id, pin }  retry registration of that saved number with the admin's PIN
//       and its stored token, after 'pinMismatch' / 'pinLocked' (no new signup code).
// The code is exchanged server side; the token is stored encrypted and never
// returned; the PIN is never logged. Safe to retry: the row is keyed on
// phone_number_id and finished steps are skipped (see lib/whatsapp/embedded-signup-connect).
//
// 200 { number, created, pin }   pin is a PIN generated now, shown once (null if unchanged or admin-supplied)
// 4xx/5xx { error, code, step, meta?, pin?, config_id? }   config_id on pinMismatch / pinLocked
// 503 when NEXT_PUBLIC_META_APP_ID / NEXT_PUBLIC_META_EMBEDDED_SIGNUP_CONFIG_ID / the app secret are missing.

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { getT } from '@/lib/i18n/translate';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { parseEmbeddedSignupRequest } from '@/lib/whatsapp/embedded-signup';
import {
  connectEmbeddedSignup,
  embeddedSignupConfigured,
  isTwoStepPin,
  retryEmbeddedSignupRegistration,
} from '@/lib/whatsapp/embedded-signup-connect';

const t = getT('Api.embeddedSignup');
/** Each attempt spends a signup code and may set a new PIN; a few per hour per workspace is plenty. */
const ACCOUNT_LIMIT = { limit: 10, windowMs: 60 * 60_000 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    await assertMutation(request, await requireSession(request));
    if (!embeddedSignupConfigured()) {
      return NextResponse.json({ error: t('notConfigured'), code: 'notConfigured' }, { status: 503 });
    }
    const userLimit = checkRateLimit(`embeddedSignup:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!userLimit.success) return rateLimitResponse(userLimit);
    const accountLimit = checkRateLimit(`embeddedSignupAccount:${ctx.accountId}`, ACCOUNT_LIMIT);
    if (!accountLimit.success) return rateLimitResponse(accountLimit);

    const body: unknown = await request.json().catch(() => null);
    const fields = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const pin = fields.pin === undefined || fields.pin === null || fields.pin === '' ? null : fields.pin;
    if (pin !== null && !isTwoStepPin(pin)) {
      return NextResponse.json({ error: t('invalidPin'), code: 'invalidPin' }, { status: 400 });
    }
    const tenant = { accountId: ctx.accountId, userId: ctx.userId, role: ctx.role };

    let result;
    if (fields.config_id !== undefined) {
      if (typeof fields.config_id !== 'string' || !UUID.test(fields.config_id) || pin === null) {
        return NextResponse.json({ error: t('invalidPin'), code: 'invalidPin' }, { status: 400 });
      }
      result = await retryEmbeddedSignupRegistration(tenant, { config_id: fields.config_id, pin });
    } else {
      const input = parseEmbeddedSignupRequest(body);
      if (!input) return NextResponse.json({ error: t('invalidRequest'), code: 'invalidRequest' }, { status: 400 });
      result = await connectEmbeddedSignup(tenant, input, { pin });
    }
    const headers = { 'Cache-Control': 'private, no-store' };
    if (!result.ok) {
      return NextResponse.json(
        {
          error: t(result.code),
          code: result.code,
          step: result.step,
          ...(result.meta ? { meta: result.meta } : {}),
          ...(result.pin ? { pin: result.pin } : {}),
          ...(result.config_id ? { config_id: result.config_id } : {}),
        },
        { status: result.status, headers }
      );
    }
    return NextResponse.json({ number: result.number, created: result.created, pin: result.pin }, { headers });
  } catch (error) {
    return toErrorResponse(error);
  }
}
