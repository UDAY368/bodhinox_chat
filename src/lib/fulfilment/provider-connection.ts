// Delhivery and Shipway connections (store Phase 5, more couriers). Server only.
//
// Both adapters are NOT TESTED AGAINST THE LIVE API YET (providers/delhivery.ts, providers/shipway.ts).
//
// An admin with commerce.shipments enters the workspace's own credentials: for Delhivery the client name and the API
// token, for Shipway the username and the licence key. The credentials are checked with the courier before anything
// is saved. The secret is stored encrypted in courier_connections.api_password_enc exactly like the Shiprocket
// password (the app role cannot SELECT it) and is never returned: the browser gets a masked hint only. Writes go
// through the worker client inside the member's checked session. Every save and disconnect writes audit_logs (ids and
// flags only). Credentials are never logged.
import { Prisma } from '@prisma/client';
import { requireIntegrationRoom } from '@/lib/billing/limits';
import { requireFeature } from '@/lib/billing/entitlements';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { auditTx } from '@/lib/payments/ledger';
import { decrypt, encrypt } from '@/lib/whatsapp/encryption';
import { asWorker, requireManager, validDims } from './connection';
import { getCourierProvider } from './providers';
import type { ProviderSecrets } from './providers/delhivery';
import { CourierError, type CourierProviderId, type SecretCourierId } from './providers/types';
import { ShipmentError, type CourierConnectionStatus, type FulfilmentActor, type ShipmentDims } from './types';

const LABEL_MAX = 120;
const SECRET_MIN = 8;
const SECRET_MAX = 200;
const PICKUP_MAX = 100;

export interface ProviderConnectionInput {
  /** Delhivery: client / account name. Shipway: username. */
  label: string;
  /** Blank keeps the stored secret (same label only). */
  secret?: string | null;
  /** Delhivery: the registered warehouse (pickup location) name, exactly as in Delhivery. Not used for Shipway. */
  pickup_location?: string | null;
  defaults?: Partial<ShipmentDims>;
}

/** What the browser may see of a Delhivery or Shipway connection (never the secret). */
export interface ProviderConnectionDto {
  provider: SecretCourierId;
  /** The deployment has not switched this courier off. */
  available: boolean;
  /** Always false for the two adapters written from public docs only; the admin UI says so. */
  tested_live: false;
  connected: boolean;
  status: CourierConnectionStatus | null;
  label: string | null;
  /** "••••" plus the last characters of the secret, or null. */
  secret_hint: string | null;
  pickup_location: string | null;
  default_length_cm: number | null;
  default_breadth_cm: number | null;
  default_height_cm: number | null;
  default_weight_grams: number | null;
  last_error_code: string | null;
  connected_at: string | null;
}

interface Row {
  id: string;
  provider: SecretCourierId;
  status: CourierConnectionStatus;
  api_email: string;
  secret_hint: string | null;
  pickup_location: string | null;
  default_length_cm: Prisma.Decimal | number | null;
  default_breadth_cm: Prisma.Decimal | number | null;
  default_height_cm: Prisma.Decimal | number | null;
  default_weight_grams: number | null;
  last_error_code: string | null;
  connected_at: Date;
}

const SELECT = Prisma.sql`id::text AS id, provider, status, api_email, secret_hint, pickup_location, default_length_cm,
  default_breadth_cm, default_height_cm, default_weight_grams, last_error_code, connected_at`;
const num = (v: Prisma.Decimal | number | null): number | null => (v === null || v === undefined ? null : Number(v));

function toDto(provider: SecretCourierId, row: Row | undefined): ProviderConnectionDto {
  const available = !getCourierProvider(provider).disabled();
  if (!row) {
    return {
      provider, available, tested_live: false, connected: false, status: null, label: null, secret_hint: null, pickup_location: null,
      default_length_cm: null, default_breadth_cm: null, default_height_cm: null, default_weight_grams: null, last_error_code: null,
      connected_at: null,
    };
  }
  return {
    provider, available, tested_live: false, connected: true, status: row.status, label: row.api_email, secret_hint: row.secret_hint,
    pickup_location: row.pickup_location, default_length_cm: num(row.default_length_cm), default_breadth_cm: num(row.default_breadth_cm),
    default_height_cm: num(row.default_height_cm), default_weight_grams: row.default_weight_grams, last_error_code: row.last_error_code,
    connected_at: new Date(row.connected_at).toISOString(),
  };
}

/** The workspace's Delhivery and Shipway connections as members may see them (a viewer reads nothing: "not connected"). */
export async function getProviderConnections(tx: TenantTransaction, accountId: string): Promise<ProviderConnectionDto[]> {
  const rows = await tx.$queryRaw<Row[]>`SELECT ${SELECT} FROM courier_connections
    WHERE account_id=${accountId}::uuid AND provider IN ('delhivery','shipway') AND status<>'disconnected'`;
  return (['delhivery', 'shipway'] as const).map((p) => toDto(p, rows.find((r) => r.provider === p)));
}

export async function getProviderConnection(tx: TenantTransaction, accountId: string, provider: SecretCourierId): Promise<ProviderConnectionDto> {
  return (await getProviderConnections(tx, accountId)).find((c) => c.provider === provider)!;
}

async function requireAvailable(ctx: FulfilmentActor, provider: SecretCourierId): Promise<void> {
  if (getCourierProvider(provider).disabled()) throw new ShipmentError('not_configured');
  await withTenant(ctx, (tx) => requireFeature(tx, ctx.accountId, 'courier_shipping'));
}

const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max && !/[\u0000-\u001f]/.test(v) ? v.trim() : null);

/** A provider refusal during a member's action, as a code the UI translates (the secret and the provider's message are never forwarded). */
function failure(error: unknown): never {
  if (error instanceof CourierError) {
    if (error.kind === 'auth') throw new ShipmentError('auth');
    if (error.kind === 'throttled') throw new ShipmentError('throttled');
    throw new ShipmentError('provider_unreachable');
  }
  throw error;
}

const hintOf = (secret: string): string => `••••${secret.length >= 12 ? secret.slice(-3) : ''}`;

/** Worker-only: the decrypted secret of the live connection (never return or log it). */
export async function loadProviderSecrets(accountId: string, provider: CourierProviderId): Promise<ProviderSecrets> {
  const rows = await asWorker({ accountId }, (tx) => tx.$queryRaw<{ status: CourierConnectionStatus; api_email: string; enc: string | null; pickup: string | null }[]>`
    SELECT status, api_email, api_password_enc AS enc, pickup_location AS pickup FROM courier_connections
    WHERE account_id=${accountId}::uuid AND provider=${provider} AND status<>'disconnected' LIMIT 1`);
  const row = rows[0];
  if (!row) throw new ShipmentError('not_connected');
  let secret: string | null = null;
  try { secret = row.enc ? decrypt(row.enc) : null; } catch { secret = null; }
  if (!secret || row.status !== 'active') throw new CourierError('auth', null, 'token_invalid', provider);
  return { label: row.api_email, secret, pickup: row.pickup };
}

async function storedSecret(accountId: string, provider: SecretCourierId, label: string): Promise<string | null> {
  try {
    const s = await loadProviderSecrets(accountId, provider);
    return s.label.toLowerCase() === label.toLowerCase() ? s.secret : null;
  } catch {
    return null;
  }
}

/** Checks the credentials with the courier and saves them (bad details 400 auth; unreachable 502). */
export async function saveProviderConnection(
  ctx: FulfilmentActor, provider: SecretCourierId, input: ProviderConnectionInput,
): Promise<ProviderConnectionDto> {
  await requireManager(ctx);
  await requireAvailable(ctx, provider);
  const adapter = getCourierProvider(provider);
  const label = text(input.label, LABEL_MAX);
  if (!label) throw new ShipmentError('invalid');
  let pickup: string | null = null;
  if (adapter.requiresPickup) {
    pickup = text(input.pickup_location, PICKUP_MAX);
    if (!pickup) throw new ShipmentError('invalid');
  }
  const defaults = validDims(input.defaults ?? {}, false);
  let secret = typeof input.secret === 'string' && input.secret.length > 0 ? input.secret : null;
  if (secret && (secret.length < SECRET_MIN || secret.length > SECRET_MAX || secret !== secret.trim())) throw new ShipmentError('invalid');
  const secretChanged = secret !== null;
  if (!secret) {
    secret = await storedSecret(ctx.accountId, provider, label);
    if (!secret) throw new ShipmentError('auth');
  }
  try {
    await adapter.testConnection({ label, secret });
  } catch (error) {
    return failure(error);
  }

  const enc = encrypt(secret);
  const hint = hintOf(secret);
  const row = await asWorker(ctx, async (tx) => {
    const updated = await tx.$queryRaw<Row[]>`UPDATE courier_connections SET status='active', api_email=${label}, api_password_enc=${enc},
        secret_hint=${hint}, token_enc=NULL, token_expires_at=NULL, pickup_location=${pickup},
        default_length_cm=${defaults.length_cm ?? null}, default_breadth_cm=${defaults.breadth_cm ?? null},
        default_height_cm=${defaults.height_cm ?? null}, default_weight_grams=${defaults.weight_grams ?? null}, last_error_code=NULL
      WHERE account_id=${ctx.accountId}::uuid AND provider=${provider} AND status<>'disconnected'
      RETURNING ${SELECT}`;
    let saved = updated[0];
    if (!saved) {
      // A new connection takes a slot of the plan's integrations (updating the live one never checks).
      await requireIntegrationRoom(tx, ctx.accountId);
      const inserted = await tx.$queryRaw<Row[]>`INSERT INTO courier_connections(account_id, provider, api_email, api_password_enc, secret_hint,
          pickup_location, default_length_cm, default_breadth_cm, default_height_cm, default_weight_grams, connected_by)
        VALUES(${ctx.accountId}::uuid, ${provider}, ${label}, ${enc}, ${hint}, ${pickup}, ${defaults.length_cm ?? null},
          ${defaults.breadth_cm ?? null}, ${defaults.height_cm ?? null}, ${defaults.weight_grams ?? null}, ${ctx.userId}::uuid)
        ON CONFLICT (account_id, provider) WHERE status <> 'disconnected' DO NOTHING
        RETURNING ${SELECT}`;
      if (!inserted[0]) throw new ShipmentError('conflict');
      saved = inserted[0];
    }
    await auditTx(tx, ctx.accountId, ctx.userId, updated[0] ? `integrations.${provider}_update` : `integrations.${provider}_connect`,
      saved.id, { secretChanged });
    return saved;
  });
  return toDto(provider, row);
}

/** The "Test connection" button: checks the given (or the stored) credentials with the courier. Nothing is saved. */
export async function testProviderConnection(
  ctx: FulfilmentActor, provider: SecretCourierId, credentials: { label?: string | null; secret?: string | null },
): Promise<void> {
  await requireManager(ctx);
  await requireAvailable(ctx, provider);
  const label = text(credentials.label, LABEL_MAX);
  if (!label) throw new ShipmentError('invalid');
  let secret = typeof credentials.secret === 'string' && credentials.secret.length > 0 ? credentials.secret : null;
  if (secret && (secret.length < SECRET_MIN || secret.length > SECRET_MAX)) throw new ShipmentError('invalid');
  if (!secret) {
    secret = await storedSecret(ctx.accountId, provider, label);
    if (!secret) throw new ShipmentError('auth');
  }
  try {
    await getCourierProvider(provider).testConnection({ label, secret });
  } catch (error) {
    failure(error);
  }
}

/**
 * Clears the stored secret and marks the connection disconnected. No courier call; works while the courier is
 * switched off, so an admin can always clear stored secrets. Existing shipments keep their rows.
 */
export async function disconnectProvider(ctx: FulfilmentActor, provider: SecretCourierId): Promise<void> {
  await requireManager(ctx);
  await asWorker(ctx, async (tx) => {
    const [row] = await tx.$queryRaw<{ id: string }[]>`UPDATE courier_connections SET status='disconnected', api_password_enc=NULL,
        token_enc=NULL, token_expires_at=NULL, secret_hint=NULL, disconnected_at=now()
      WHERE account_id=${ctx.accountId}::uuid AND provider=${provider} AND status<>'disconnected'
      RETURNING id::text AS id`;
    if (row) await auditTx(tx, ctx.accountId, ctx.userId, `integrations.${provider}_disconnect`, row.id);
  });
}
