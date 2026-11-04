// Shiprocket connection (Phase 9, design §3, D3, D15). Owner: T4.
//
// An admin with commerce.shipments connects the workspace's own Shiprocket API
// user. The login is tested and the pickup locations listed before anything is
// saved; the password and the cached login token are stored encrypted and the
// app role cannot SELECT them (column grants). Writes run through the worker
// client inside the member's checked session (as meta-ads/connection.ts).
//
// The webhook token is generated here, shown once and stored only as
// sha256(token): we never need it back, only to compare a push's x-api-key.
// Every save, disconnect and token rotation writes audit_logs (ids and codes).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { appOrigin } from '@/lib/auth/csrf';
import { ForbiddenError } from '@/lib/auth/errors';
import { requirePermission } from '@/lib/auth/permissions';
import { hasMinRole } from '@/lib/auth/roles';
import { requireFeature } from '@/lib/billing/entitlements';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { auditTx } from '@/lib/payments/ledger';
import { decrypt, encrypt } from '@/lib/whatsapp/encryption';
import { shiprocketDisabled, ShiprocketError, shiprocketLogin, shiprocketRequest } from './shiprocket-client';
import {
  ShipmentError, type CourierConnectionDto, type CourierConnectionStatus, type FulfilmentActor, type ShipmentDims,
} from './types';

export interface CourierConnectionInput {
  email: string;
  /** Blank keeps the stored password (as savePaymentProvider). */
  password?: string | null;
  pickup_location: string;
  defaults: Partial<ShipmentDims>;
}

const EMAIL = /^[^\s@]{1,128}@[^\s@]{1,125}\.[^\s@]{1,60}$/;
const PASSWORD_MAX = 200;
const TOKEN_MAX = 256;

interface ConnectionRow {
  id: string;
  status: CourierConnectionStatus;
  api_email: string;
  pickup_location: string | null;
  default_length_cm: Prisma.Decimal | number | null;
  default_breadth_cm: Prisma.Decimal | number | null;
  default_height_cm: Prisma.Decimal | number | null;
  default_weight_grams: number | null;
  last_error_code: string | null;
  connected_at: Date;
}

const num = (v: Prisma.Decimal | number | null): number | null => (v === null || v === undefined ? null : Number(v));

function webhookUrl(accountId: string): string {
  let origin = 'http://localhost:3000';
  try { origin = appOrigin(); } catch { /* unset in some local setups */ }
  return `${origin}/api/fulfilment/tracking/${accountId}`;
}

const EMPTY: CourierConnectionDto = {
  connected: false, status: null, api_email: null, pickup_location: null, default_length_cm: null, default_breadth_cm: null,
  default_height_cm: null, default_weight_grams: null, last_error_code: null, connected_at: null, webhook_token_set: false, webhook_url: null,
};

function toDto(accountId: string, row: ConnectionRow | null, webhookTokenSet: boolean): CourierConnectionDto {
  if (!row) return EMPTY;
  return {
    connected: true,
    status: row.status,
    api_email: row.api_email,
    pickup_location: row.pickup_location,
    default_length_cm: num(row.default_length_cm),
    default_breadth_cm: num(row.default_breadth_cm),
    default_height_cm: num(row.default_height_cm),
    default_weight_grams: row.default_weight_grams,
    last_error_code: row.last_error_code,
    connected_at: new Date(row.connected_at).toISOString(),
    webhook_token_set: webhookTokenSet,
    webhook_url: webhookUrl(accountId),
  };
}

const PUBLIC_SELECT = Prisma.sql`id::text AS id, status, api_email, pickup_location, default_length_cm, default_breadth_cm,
  default_height_cm, default_weight_grams, last_error_code, connected_at`;

/** Worker transaction in the actor's workspace (app.user_id = the member, for audit). */
const asWorker = <T>(ctx: { accountId: string; userId?: string }, work: (tx: TenantTransaction) => Promise<T>) =>
  withTenant({ accountId: ctx.accountId, userId: ctx.userId, role: 'owner' }, work, getWorkerPrisma());

async function webhookTokenSet(accountId: string): Promise<boolean> {
  const rows = await asWorker({ accountId }, (tx) => tx.$queryRaw<{ set: boolean }[]>`
    SELECT webhook_token_hash IS NOT NULL AS set FROM courier_connections
    WHERE account_id=${accountId}::uuid AND status<>'disconnected' LIMIT 1`);
  return rows[0]?.set === true;
}

/**
 * The live connection as members may see it (no secret, no token). `tx` is the
 * member's app-role transaction: a viewer reads nothing and gets "not connected".
 */
export async function getCourierConnection(tx: TenantTransaction, accountId: string): Promise<CourierConnectionDto> {
  const rows = await tx.$queryRaw<ConnectionRow[]>`SELECT ${PUBLIC_SELECT} FROM courier_connections
    WHERE account_id=${accountId}::uuid AND status<>'disconnected' LIMIT 1`;
  if (!rows[0]) return EMPTY;
  return toDto(accountId, rows[0], await webhookTokenSet(accountId));
}

/** Admin with commerce.shipments, on a plan with courier shipping, on a deployment with Shiprocket on. */
async function requireManager(ctx: FulfilmentActor): Promise<void> {
  if (!ctx.role || !hasMinRole(ctx.role, 'admin')) throw new ForbiddenError('Insufficient workspace role');
  await requirePermission(ctx, 'commerce.shipments');
}

async function requireAvailable(ctx: FulfilmentActor): Promise<void> {
  if (shiprocketDisabled()) throw new ShipmentError('not_configured');
  await withTenant(ctx, (tx) => requireFeature(tx, ctx.accountId, 'courier_shipping'));
}

/** Validated package defaults (cm with one decimal, grams); undefined fields stay unset. */
export function validDims(input: Partial<ShipmentDims>, required: boolean): Partial<ShipmentDims> {
  const out: Partial<ShipmentDims> = {};
  for (const key of ['length_cm', 'breadth_cm', 'height_cm'] as const) {
    const v = input[key];
    if (v === undefined || v === null) { if (required) throw new ShipmentError('invalid'); continue; }
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 300) throw new ShipmentError('invalid');
    out[key] = Math.round(v * 10) / 10;
    if (out[key]! <= 0) throw new ShipmentError('invalid');
  }
  const w = input.weight_grams;
  if (w === undefined || w === null) { if (required) throw new ShipmentError('invalid'); }
  else if (typeof w !== 'number' || !Number.isInteger(w) || w < 1 || w > 100_000) throw new ShipmentError('invalid');
  else out.weight_grams = w;
  return out;
}

/** Maps a provider failure during a member's action to a code the UI translates. */
function providerFailure(error: unknown): never {
  if (error instanceof ShiprocketError) {
    if (error.kind === 'auth') throw new ShipmentError('auth');
    if (error.kind === 'throttled') throw new ShipmentError('throttled');
    throw new ShipmentError('provider_unreachable');
  }
  throw error;
}

/** Pickup location names from GET /settings/company/pickup (unverified shape: data.shipping_address[].pickup_location). */
export function parsePickupLocations(body: unknown): string[] {
  const data = (body as { data?: { shipping_address?: unknown } } | null)?.data;
  const list = Array.isArray(data?.shipping_address) ? data.shipping_address : [];
  const names = list
    .map((entry) => (entry && typeof entry === 'object' ? (entry as { pickup_location?: unknown }).pickup_location : null))
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 100);
  return [...new Set(names)].slice(0, 100);
}

async function storedPassword(accountId: string): Promise<{ email: string; password: string } | null> {
  const secrets = await loadCourierSecrets(accountId);
  return secrets?.password ? { email: secrets.email, password: secrets.password } : null;
}

async function loginAndList(email: string, password: string): Promise<{ token: string; expiresAt: Date; locations: string[] }> {
  try {
    const login = await shiprocketLogin(email, password);
    const locations = parsePickupLocations(await shiprocketRequest(login.token, 'GET', '/settings/company/pickup'));
    return { ...login, locations };
  } catch (error) {
    return providerFailure(error);
  }
}

/** Tests the login, lists pickup locations, then saves (bad credentials 400 auth; unreachable 502). */
export async function saveCourierConnection(ctx: FulfilmentActor, input: CourierConnectionInput): Promise<CourierConnectionDto> {
  await requireManager(ctx);
  await requireAvailable(ctx);
  const email = typeof input.email === 'string' ? input.email.trim() : '';
  if (!EMAIL.test(email) || email.length > 254) throw new ShipmentError('invalid');
  const pickup = typeof input.pickup_location === 'string' ? input.pickup_location.trim() : '';
  if (!pickup || pickup.length > 100) throw new ShipmentError('invalid');
  const defaults = validDims(input.defaults ?? {}, false);
  let password = typeof input.password === 'string' && input.password.length > 0 ? input.password : null;
  if (password && password.length > PASSWORD_MAX) throw new ShipmentError('invalid');
  const passwordChanged = password !== null;
  if (!password) {
    // A blank password keeps the stored one, for the same API user only.
    const stored = await storedPassword(ctx.accountId);
    if (!stored || stored.email.toLowerCase() !== email.toLowerCase()) throw new ShipmentError('auth');
    password = stored.password;
  }

  const { token, expiresAt, locations } = await loginAndList(email, password);
  if (!locations.includes(pickup)) throw new ShipmentError('invalid');

  const passwordEnc = encrypt(password);
  const tokenEnc = encrypt(token);
  const row = await asWorker(ctx, async (tx) => {
    const updated = await tx.$queryRaw<ConnectionRow[]>`UPDATE courier_connections SET
        status='active', api_email=${email}, api_password_enc=${passwordEnc}, token_enc=${tokenEnc}, token_expires_at=${expiresAt},
        pickup_location=${pickup}, default_length_cm=${defaults.length_cm ?? null}, default_breadth_cm=${defaults.breadth_cm ?? null},
        default_height_cm=${defaults.height_cm ?? null}, default_weight_grams=${defaults.weight_grams ?? null}, last_error_code=NULL
      WHERE account_id=${ctx.accountId}::uuid AND status<>'disconnected'
      RETURNING ${PUBLIC_SELECT}`;
    let saved = updated[0];
    if (!saved) {
      const inserted = await tx.$queryRaw<ConnectionRow[]>`INSERT INTO courier_connections(account_id, api_email, api_password_enc,
          token_enc, token_expires_at, pickup_location, default_length_cm, default_breadth_cm, default_height_cm, default_weight_grams, connected_by)
        VALUES(${ctx.accountId}::uuid, ${email}, ${passwordEnc}, ${tokenEnc}, ${expiresAt}, ${pickup}, ${defaults.length_cm ?? null},
          ${defaults.breadth_cm ?? null}, ${defaults.height_cm ?? null}, ${defaults.weight_grams ?? null}, ${ctx.userId}::uuid)
        ON CONFLICT (account_id) WHERE status <> 'disconnected' DO NOTHING
        RETURNING ${PUBLIC_SELECT}`;
      if (!inserted[0]) throw new ShipmentError('conflict');
      saved = inserted[0];
    }
    await auditTx(tx, ctx.accountId, ctx.userId, updated[0] ? 'integrations.shiprocket_update' : 'integrations.shiprocket_connect',
      saved.id, { passwordChanged });
    return saved;
  });
  return toDto(ctx.accountId, row, await webhookTokenSet(ctx.accountId));
}

/**
 * The pickup locations of the given credentials, or of the stored ones when no
 * password is given (the Settings form's "Test" button). Nothing is saved.
 */
export async function listPickupLocations(ctx: FulfilmentActor, credentials?: { email?: string | null; password?: string | null }): Promise<string[]> {
  await requireManager(ctx);
  await requireAvailable(ctx);
  const email = credentials?.email?.trim() || null;
  const given = credentials?.password || null;
  if (given && given.length > PASSWORD_MAX) throw new ShipmentError('invalid');
  if (given) {
    if (!email || !EMAIL.test(email)) throw new ShipmentError('invalid');
    return (await loginAndList(email, given)).locations;
  }
  const stored = await storedPassword(ctx.accountId);
  if (!stored) throw new ShipmentError('not_connected');
  if (email && email.toLowerCase() !== stored.email.toLowerCase()) throw new ShipmentError('auth');
  return (await loginAndList(stored.email, stored.password)).locations;
}

const digest = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

/** Generates a new webhook token: returned once, stored only as its sha256 digest. */
export async function rotateWebhookToken(ctx: FulfilmentActor): Promise<{ token: string }> {
  await requireManager(ctx);
  const token = randomBytes(32).toString('base64url');
  const hash = digest(token);
  const id = await asWorker(ctx, async (tx) => {
    const [row] = await tx.$queryRaw<{ id: string; had: boolean }[]>`SELECT id::text AS id, webhook_token_hash IS NOT NULL AS had
      FROM courier_connections WHERE account_id=${ctx.accountId}::uuid AND status<>'disconnected' LIMIT 1 FOR UPDATE`;
    if (!row) return null;
    await tx.$executeRaw`UPDATE courier_connections SET webhook_token_hash=${hash}
      WHERE account_id=${ctx.accountId}::uuid AND id=${row.id}::uuid`;
    await auditTx(tx, ctx.accountId, ctx.userId, 'integrations.shiprocket_webhook_token', row.id, { replaced: row.had });
    return row.id;
  });
  if (!id) throw new ShipmentError('not_connected');
  return { token };
}

/**
 * Clears the stored password, login token and webhook digest and marks the
 * connection disconnected. No Shiprocket call (an API user cannot be revoked
 * by API); works while Shiprocket is switched off, so an admin can always
 * clear the stored secrets. Existing shipments keep their rows; jobs for them
 * stop calling Shiprocket because the connection is no longer live.
 */
export async function disconnectCourier(ctx: FulfilmentActor): Promise<void> {
  await requireManager(ctx);
  await asWorker(ctx, async (tx) => {
    const [row] = await tx.$queryRaw<{ id: string; status: string }[]>`UPDATE courier_connections SET status='disconnected',
        api_password_enc=NULL, token_enc=NULL, token_expires_at=NULL, webhook_token_hash=NULL, disconnected_at=now()
      WHERE account_id=${ctx.accountId}::uuid AND status<>'disconnected'
      RETURNING id::text AS id, status`;
    if (row) await auditTx(tx, ctx.accountId, ctx.userId, 'integrations.shiprocket_disconnect', row.id);
  });
}

/** Worker-only: the decrypted secrets of the live connection, or null when not connected. */
export interface CourierSecrets {
  connectionId: string;
  status: CourierConnectionStatus;
  email: string;
  password: string | null;
  token: string | null;
  tokenExpiresAt: Date | null;
  pickupLocation: string | null;
  defaults: Partial<ShipmentDims>;
}

/** Never return or log the result. */
export async function loadCourierSecrets(accountId: string): Promise<CourierSecrets | null> {
  const rows = await asWorker({ accountId }, (tx) => tx.$queryRaw<(ConnectionRow & {
    api_password_enc: string | null; token_enc: string | null; token_expires_at: Date | null;
  })[]>`SELECT ${PUBLIC_SELECT}, api_password_enc, token_enc, token_expires_at FROM courier_connections
    WHERE account_id=${accountId}::uuid AND status<>'disconnected' LIMIT 1`);
  const row = rows[0];
  if (!row) return null;
  const dec = (v: string | null): string | null => {
    if (!v) return null;
    try { return decrypt(v); } catch { return null; }
  };
  const defaults: Partial<ShipmentDims> = {};
  if (row.default_length_cm !== null) defaults.length_cm = Number(row.default_length_cm);
  if (row.default_breadth_cm !== null) defaults.breadth_cm = Number(row.default_breadth_cm);
  if (row.default_height_cm !== null) defaults.height_cm = Number(row.default_height_cm);
  if (row.default_weight_grams !== null) defaults.weight_grams = row.default_weight_grams;
  return {
    connectionId: row.id,
    status: row.status,
    email: row.api_email,
    password: dec(row.api_password_enc),
    token: dec(row.token_enc),
    tokenExpiresAt: row.token_expires_at ? new Date(row.token_expires_at) : null,
    pickupLocation: row.pickup_location,
    defaults,
  };
}

/** Worker-only (shiprocketCall): caches a fresh login token on the live connection. */
export async function storeCourierToken(accountId: string, connectionId: string, token: string, expiresAt: Date): Promise<void> {
  await asWorker({ accountId }, (tx) => tx.$executeRaw`UPDATE courier_connections SET token_enc=${encrypt(token)},
      token_expires_at=${expiresAt}, last_error_code=NULL
    WHERE account_id=${accountId}::uuid AND id=${connectionId}::uuid AND status='active'`);
}

/** Worker-only (shiprocketCall): the stored API user was refused; the card asks the admin to reconnect. */
export async function markCourierAuthFailed(accountId: string, connectionId: string): Promise<void> {
  await asWorker({ accountId }, (tx) => tx.$executeRaw`UPDATE courier_connections SET status='token_invalid',
      token_enc=NULL, token_expires_at=NULL, last_error_code='auth'
    WHERE account_id=${accountId}::uuid AND id=${connectionId}::uuid AND status='active'`);
}

/**
 * The tracking webhook's x-api-key check (T5 route): constant-time comparison of
 * sha256(token) with the live connection's digest. false when not connected.
 */
export async function courierWebhookTokenMatches(accountId: string, token: string): Promise<boolean> {
  if (typeof token !== 'string' || token.length < 16 || token.length > TOKEN_MAX) return false;
  const rows = await asWorker({ accountId }, (tx) => tx.$queryRaw<{ hash: string | null }[]>`
    SELECT webhook_token_hash AS hash FROM courier_connections
    WHERE account_id=${accountId}::uuid AND status<>'disconnected' LIMIT 1`);
  const stored = rows[0]?.hash;
  if (!stored) return false;
  return timingSafeEqual(Buffer.from(digest(token), 'hex'), Buffer.from(stored, 'hex'));
}
