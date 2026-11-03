/**
 * Server half of Embedded Signup: turn { code, waba_id, phone_number_id } from
 * the signup popup into a connected whatsapp_config row.
 *
 * Steps, each recorded on the row so a retry (with a fresh code) skips what is
 * already done and never creates a second row (idempotent on phone_number_id):
 *   1. exchange the code for a token (server side, app secret never leaves here)
 *   2. prove the token reaches the number and the number is in that WABA
 *   3. refuse a number another workspace has connected
 *   4. checkpoint: create or update the row (encrypted token, display_name from
 *      Meta's verified_name), status 'disconnected' until the steps finish
 *   5. subscribe the app to the WABA            -> subscribed_apps_at
 *   6. register the number -> registered_at. With the admin's existing two-step
 *      PIN when they gave one; otherwise with a fresh 6-digit PIN, which the
 *      house does not store, so it is returned once to the admin.
 *      A wrong PIN (Meta 133005/136025) answers 'pinMismatch' with the row id;
 *      retryEmbeddedSignupRegistration then finishes steps 5-7 with the stored
 *      token and the admin's PIN, without a new signup code.
 *   7. mark connected
 *
 * The code, token and PIN are never logged; the token is never returned.
 */
import { randomInt } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PlanLimitError, requireWhatsAppNumberRoom } from '@/lib/billing/entitlements';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { resolveWhatsAppAccount } from '@/lib/repositories/routing';
import { isNumberDisconnected } from '@/lib/whatsapp/numbers';
import { decrypt, encrypt } from '@/lib/whatsapp/encryption';
import { explainMetaError, metaErrorPayload, type MetaConnectStep } from '@/lib/whatsapp/meta-error-explain';
import {
  MetaApiError,
  exchangeEmbeddedSignupCode,
  listWabaPhoneNumbers,
  registerPhoneNumber,
  subscribeWabaToApp,
  verifyPhoneNumber,
} from '@/lib/whatsapp/meta-api';
import { phoneNumberBelongsToWaba } from '@/lib/whatsapp/waba-pairing';
import { parseAppSecrets } from '@/lib/whatsapp/webhook-signature';
import { embeddedSignupPublicConfig, type EmbeddedSignupRequest } from './embedded-signup';

export type EmbeddedSignupStep = 'exchange_code' | MetaConnectStep | 'save';

export type EmbeddedSignupErrorCode =
  | 'notConfigured'
  | 'codeExchangeFailed'
  | 'numberNotAccessible'
  | 'wabaMismatch'
  | 'numberLinkedElsewhere'
  | 'subscribeFailed'
  | 'registerFailed'
  | 'pinMismatch'
  | 'pinLocked'
  | 'notFound'
  | 'saveFailed';

export interface EmbeddedSignupNumber {
  id: string;
  phone_number_id: string;
  waba_id: string | null;
  display_name: string | null;
  status: string;
  is_default: boolean;
}

export type EmbeddedSignupResult =
  | {
      ok: true;
      number: EmbeddedSignupNumber;
      /** True when this request created the row (false on a retry or a reconnect). */
      created: boolean;
      /** The two-step PIN set by this request, shown once; null when registration was already done. */
      pin: string | null;
    }
  | {
      ok: false;
      status: number;
      code: EmbeddedSignupErrorCode;
      step: EmbeddedSignupStep | null;
      meta?: ReturnType<typeof metaErrorPayload>;
      /** Set only when Meta accepted a generated PIN but saving that fact failed: the admin must keep it. */
      pin?: string;
      /** The saved row, on pinMismatch/pinLocked, for retryEmbeddedSignupRegistration. */
      config_id?: string;
    };

export interface EmbeddedSignupOptions {
  /** The number's existing two-step PIN (6 digits), when the admin knows one is set. */
  pin?: string | null;
}

/** An admin-entered two-step PIN: exactly 6 digits. */
export function isTwoStepPin(value: unknown): value is string {
  return typeof value === 'string' && /^\d{6}$/.test(value);
}

/** App secret for the code exchange: META_APP_SECRET_PRIMARY, else the first META_APP_SECRET value. */
export function codeExchangeSecret(env: Record<string, string | undefined> = process.env): string | null {
  const primary = env.META_APP_SECRET_PRIMARY?.trim();
  if (primary) return primary;
  return parseAppSecrets(env.META_APP_SECRET)[0] ?? null;
}

export function embeddedSignupConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return embeddedSignupPublicConfig() !== null && codeExchangeSecret(env) !== null;
}

/** A uniformly random 6-digit PIN (leading zeros allowed). */
export function generateTwoStepPin(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

const numberSelect = {
  id: true,
  phone_number_id: true,
  waba_id: true,
  display_name: true,
  status: true,
  is_default: true,
  registered_at: true,
  subscribed_apps_at: true,
} as const;

function fail(status: number, code: EmbeddedSignupErrorCode, step: EmbeddedSignupStep | null, extra: Partial<Extract<EmbeddedSignupResult, { ok: false }>> = {}): EmbeddedSignupResult {
  return { ok: false, status, code, step, ...extra };
}

function metaFail(err: unknown, code: EmbeddedSignupErrorCode, step: MetaConnectStep, input: { phone_number_id: string; waba_id: string }): EmbeddedSignupResult {
  const explained = explainMetaError(err, step, { phoneNumberId: input.phone_number_id, wabaId: input.waba_id });
  // Meta's code and trace id only: never the token, code or customer content.
  console.error(`[embedded-signup] ${step} failed`, { code: explained.code, subcode: explained.subcode, fbtrace_id: explained.fbtraceId });
  return fail(explained.httpStatus, code, step, { meta: metaErrorPayload(explained) });
}

export async function connectEmbeddedSignup(
  tenant: TenantContext & { userId: string },
  input: EmbeddedSignupRequest,
  options: EmbeddedSignupOptions = {}
): Promise<EmbeddedSignupResult> {
  const publicConfig = embeddedSignupPublicConfig();
  const secret = codeExchangeSecret();
  if (!publicConfig || !secret) return fail(503, 'notConfigured', null);

  // 1. Code -> token.
  let accessToken: string;
  try {
    ({ accessToken } = await exchangeEmbeddedSignupCode({ appId: publicConfig.appId, appSecret: secret, code: input.code }));
  } catch (err) {
    const status = err instanceof MetaApiError && err.httpStatus < 500 ? 400 : 502;
    console.error('[embedded-signup] exchange_code failed', {
      code: err instanceof MetaApiError ? err.code : null,
      fbtrace_id: err instanceof MetaApiError ? err.fbtraceId : null,
    });
    return fail(status, 'codeExchangeFailed', 'exchange_code');
  }

  // 2. The token must reach the number, and the number must be in the WABA.
  let verifiedName: string | null;
  let qualityRating: string | null;
  try {
    const info = await verifyPhoneNumber({ phoneNumberId: input.phone_number_id, accessToken });
    verifiedName = info.verified_name?.trim() || null;
    qualityRating = info.quality_rating ?? null;
  } catch (err) {
    return metaFail(err, 'numberNotAccessible', 'verify_number', input);
  }
  try {
    const numbers = await listWabaPhoneNumbers({ wabaId: input.waba_id, accessToken });
    if (!phoneNumberBelongsToWaba(numbers, input.phone_number_id)) return fail(400, 'wabaMismatch', 'waba_phone_numbers');
  } catch (err) {
    return metaFail(err, 'numberNotAccessible', 'waba_phone_numbers', input);
  }

  // 3. A number another workspace holds connected stays theirs. One it only
  //    disconnected (row kept, token cleared) may be connected here; the partial
  //    unique index on connected rows backs this check against races.
  const owner = await resolveWhatsAppAccount(input.phone_number_id);
  if (owner && owner !== tenant.accountId) return fail(409, 'numberLinkedElsewhere', null);

  // 4. Checkpoint the row before any step that changes Meta state.
  const encryptedToken = encrypt(accessToken);
  let row: RowState;
  try {
    row = await upsertRow(tenant, input, encryptedToken, verifiedName, qualityRating).catch((err) => {
      // A concurrent request in this workspace created the row first: update it instead.
      if (isUniqueViolation(err)) return upsertRow(tenant, input, encryptedToken, verifiedName, qualityRating);
      throw err;
    });
  } catch (err) {
    // Over the plan's WhatsApp numbers: the route answers 402 (plan_limit); nothing was written.
    if (err instanceof PlanLimitError) throw err;
    // Still conflicting: another workspace holds the number connected (also
    // when reconnecting this workspace's disconnected row).
    if (isUniqueViolation(err)) return fail(409, 'numberLinkedElsewhere', null);
    console.error('[embedded-signup] save failed', err instanceof Error ? err.name : 'unknown');
    return fail(500, 'saveFailed', 'save');
  }
  return finishConnection(tenant, row, { phone_number_id: input.phone_number_id, waba_id: input.waba_id }, accessToken, options.pin ?? null);
}

/**
 * Finish a number whose registration failed (e.g. a wrong two-step PIN) with the
 * token already stored on its row, so the admin does not spend another signup
 * code. Same steps 5-7 and checkpoints as connectEmbeddedSignup.
 */
export async function retryEmbeddedSignupRegistration(
  tenant: TenantContext & { userId: string },
  input: { config_id: string; pin: string }
): Promise<EmbeddedSignupResult> {
  let row: {
    id: string;
    phone_number_id: string;
    waba_id: string | null;
    access_token: string | null;
    registered_at: Date | null;
    subscribed_apps_at: Date | null;
  } | null;
  try {
    row = await withTenant(tenant, (tx) =>
      tx.whatsapp_config.findFirst({
        where: { account_id: tenant.accountId, id: input.config_id },
        select: { id: true, phone_number_id: true, waba_id: true, access_token: true, registered_at: true, subscribed_apps_at: true },
      })
    );
  } catch {
    return fail(500, 'saveFailed', 'save');
  }
  if (!row || !row.waba_id || !row.access_token) return fail(404, 'notFound', null);
  let accessToken: string;
  try {
    accessToken = decrypt(row.access_token);
  } catch {
    return fail(404, 'notFound', null);
  }
  return finishConnection(
    tenant,
    { id: row.id, registered_at: row.registered_at, subscribed_apps_at: row.subscribed_apps_at, created: false },
    { phone_number_id: row.phone_number_id, waba_id: row.waba_id },
    accessToken,
    input.pin
  );
}

/** Wrong PIN, or Meta's lockout after too many wrong PINs: the admin can retry with the right one. */
function pinErrorCode(err: unknown): 'pinMismatch' | 'pinLocked' | null {
  const code = err instanceof MetaApiError ? err.code : null;
  if (code === 133005 || code === 136025) return 'pinMismatch';
  if (code === 133008 || code === 133009) return 'pinLocked';
  return null;
}

/** Steps 5-7 on a checkpointed row. `adminPin` is the number's existing PIN, if the admin gave it. */
async function finishConnection(
  tenant: TenantContext & { userId: string },
  row: RowState,
  ids: { phone_number_id: string; waba_id: string },
  accessToken: string,
  adminPin: string | null
): Promise<EmbeddedSignupResult> {
  const configId = row.id;

  // 5. Subscribe the app to the WABA (skipped once recorded for this WABA).
  if (!row.subscribed_apps_at) {
    try {
      await subscribeWabaToApp({ wabaId: ids.waba_id, accessToken });
    } catch (err) {
      return metaFail(err, 'subscribeFailed', 'subscribe_waba', ids);
    }
    try {
      await update(tenant, configId, { subscribed_apps_at: new Date() });
    } catch {
      // Meta's subscribe is idempotent: the retry simply calls it again.
      return fail(500, 'saveFailed', 'save');
    }
  }

  // 6. Register unless already registered: the admin's PIN, else a fresh one.
  let pin: string | null = null;
  if (!row.registered_at) {
    const candidate = adminPin ?? generateTwoStepPin();
    let alreadyRegistered: boolean;
    try {
      ({ alreadyRegistered } = await registerPhoneNumber({ phoneNumberId: ids.phone_number_id, accessToken, pin: candidate }));
    } catch (err) {
      const pinCode = pinErrorCode(err);
      const result = metaFail(err, pinCode ?? 'registerFailed', 'register', ids);
      const summary = explainMetaError(err, 'register', { phoneNumberId: ids.phone_number_id, wabaId: ids.waba_id }).summary;
      await update(tenant, configId, { last_registration_error: summary }).catch(() => undefined);
      return pinCode && !result.ok ? { ...result, config_id: configId } : result;
    }
    // Only a PIN this request generated is shown back; the admin already knows their own.
    pin = alreadyRegistered || adminPin ? null : candidate;
    try {
      await update(tenant, configId, { registered_at: new Date(), last_registration_error: null });
    } catch {
      // Meta now holds this PIN; a retry would try a different one, so the admin must keep it.
      return fail(500, 'saveFailed', 'save', pin ? { pin } : {});
    }
  }

  // 7. Connected.
  let final: EmbeddedSignupNumber;
  try {
    final = await withTenant(tenant, async (tx) => {
      await tx.whatsapp_config.updateMany({
        where: { account_id: tenant.accountId, id: configId, connected_at: null },
        data: { connected_at: new Date() },
      });
      await tx.whatsapp_config.updateMany({
        where: { account_id: tenant.accountId, id: configId },
        data: { status: 'connected', last_registration_error: null, updated_at: new Date() },
      });
      const saved = await tx.whatsapp_config.findFirstOrThrow({ where: { account_id: tenant.accountId, id: configId }, select: numberSelect });
      return publicNumber(saved);
    });
  } catch {
    return fail(500, 'saveFailed', 'save', pin ? { pin } : {});
  }
  return { ok: true, number: final, created: row.created, pin };
}

type RowState = { id: string; registered_at: Date | null; subscribed_apps_at: Date | null; created: boolean };

/** Create or update this workspace's row for the number. */
async function upsertRow(
  tenant: TenantContext & { userId: string },
  input: EmbeddedSignupRequest,
  encryptedToken: string,
  verifiedName: string | null,
  qualityRating: string | null
): Promise<RowState> {
  return withTenant(tenant, async (tx) => {
    const now = new Date();
    const existing = await tx.whatsapp_config.findFirst({
      where: { account_id: tenant.accountId, phone_number_id: input.phone_number_id },
      select: { ...numberSelect, access_token: true },
    });
    if (existing) {
      // Reviving a number an admin removed takes a slot again, so it must fit the plan too.
      if (isNumberDisconnected(existing)) await requireWhatsAppNumberRoom(tx, tenant.accountId);
      const wabaChanged = existing.waba_id !== input.waba_id;
      await tx.whatsapp_config.updateMany({
        where: { account_id: tenant.accountId, id: existing.id },
        data: {
          access_token: encryptedToken,
          waba_id: input.waba_id,
          ...(verifiedName ? { display_name: verifiedName } : {}),
          ...(qualityRating ? { quality_rating: qualityRating } : {}),
          ...(wabaChanged ? { subscribed_apps_at: null } : {}),
          updated_at: now,
        },
      });
      return {
        id: existing.id,
        registered_at: existing.registered_at,
        subscribed_apps_at: wabaChanged ? null : existing.subscribed_apps_at,
        created: false,
      };
    }
    // An additional number must fit the plan; checked before any Meta state changes.
    await requireWhatsAppNumberRoom(tx, tenant.accountId);
    const created = await tx.whatsapp_config.create({
      data: {
        account_id: tenant.accountId,
        user_id: tenant.userId,
        phone_number_id: input.phone_number_id,
        waba_id: input.waba_id,
        access_token: encryptedToken,
        display_name: verifiedName,
        quality_rating: qualityRating,
        status: 'disconnected',
      },
      select: { id: true },
    });
    return { id: created.id, registered_at: null, subscribed_apps_at: null, created: true };
  });
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

async function update(tenant: TenantContext, configId: string, data: Prisma.whatsapp_configUpdateManyMutationInput): Promise<void> {
  await withTenant(tenant, (tx) =>
    tx.whatsapp_config.updateMany({ where: { account_id: tenant.accountId, id: configId }, data: { ...data, updated_at: new Date() } })
  );
}

function publicNumber(row: { id: string; phone_number_id: string; waba_id: string | null; display_name: string | null; status: string; is_default: boolean }): EmbeddedSignupNumber {
  return {
    id: row.id,
    phone_number_id: row.phone_number_id,
    waba_id: row.waba_id,
    display_name: row.display_name,
    status: row.status,
    is_default: row.is_default,
  };
}
