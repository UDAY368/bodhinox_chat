// Which channels a workspace uses (Stage 1). The one place that decides a
// channel's effective state, read by GET/PUT /api/account/channels, the
// channel layouts, the nav and the legacy-URL redirects.
//
// A channel is `available` (WhatsApp always; Instagram when the platform flag
// is on and the plan includes it), `enabled` (an explicit workspace_channels
// row, else the default: WhatsApp on, Instagram on only while an Instagram
// account is connected) and has a `connection` (none, live or attention).
// The no-row default reproduces the app before Stage 1, so existing
// workspaces need no backfill and see no change.
//
// Every function takes a tenant transaction (withTenant); the queries also
// filter by account_id. Nothing here returns tokens or customer content.
import { Prisma } from '@prisma/client';
import { getEntitlements } from '@/lib/billing/entitlements';
import type { TenantTransaction } from '@/lib/db/tenant';
import { instagramEnabled } from '@/lib/instagram/config';
import type { Channel } from '@/types';
import { CHANNELS, isChannel } from './capabilities';

export type ChannelConnection = 'none' | 'live' | 'attention';
/** What the UI shows: off, enabled but not connected (setup), live, needs attention, or not available. */
export type ChannelState = 'off' | 'setup' | 'live' | 'attention' | 'unavailable';
export type ChannelUnavailableReason = 'platform_off' | 'plan';

export interface WorkspaceChannel {
  channel: Channel;
  available: boolean;
  /** Why the channel is not available; null when it is. */
  unavailableReason: ChannelUnavailableReason | null;
  /** Effective: turned on (row or default) and available. Gates the channel's section. */
  enabled: boolean;
  /** An admin or a connect path wrote a row for this channel. */
  explicit: boolean;
  connection: ChannelConnection;
  state: ChannelState;
}

export interface WorkspaceChannels {
  channels: Record<Channel, WorkspaceChannel>;
  /** Enabled channels, WhatsApp first. */
  enabled: Channel[];
  /** Any workspace_channels row exists (the onboarding picker shows only while false and nothing is connected). */
  chosen: boolean;
}

/** The raw inputs the effective state is computed from. */
export interface ChannelFacts {
  /** workspace_channels rows: channel -> enabled. */
  rows: Partial<Record<Channel, boolean>>;
  connections: Record<Channel, ChannelConnection>;
  /** INSTAGRAM_ENABLED is on. */
  instagramPlatform: boolean;
  /** The plan includes the 'instagram' feature. */
  instagramPlan: boolean;
}

function unavailableReason(channel: Channel, facts: ChannelFacts): ChannelUnavailableReason | null {
  if (channel === 'whatsapp') return null;
  if (!facts.instagramPlatform) return 'platform_off';
  if (!facts.instagramPlan) return 'plan';
  return null;
}

/** Configured on/off before availability: the row, else the default. */
function configured(channel: Channel, facts: ChannelFacts): boolean {
  const row = facts.rows[channel];
  if (row !== undefined) return row;
  return channel === 'whatsapp' ? true : facts.connections.instagram !== 'none';
}

/**
 * Pure: the effective per-channel state from its facts. Connected implies
 * enabled here too, not only in the connect paths: a channel with a number or
 * account still attached stays visible even if its row says off (a connect path
 * that missed ensureChannelEnabled, or a row written before the connection), so
 * a live channel's inbox never disappears while its messages keep arriving.
 */
export function effectiveChannels(facts: ChannelFacts): WorkspaceChannels {
  const channels = Object.fromEntries(CHANNELS.map((channel) => {
    const reason = unavailableReason(channel, facts);
    const available = reason === null;
    const connection = facts.connections[channel];
    const enabled = available && (configured(channel, facts) || connection !== 'none');
    const state: ChannelState = !available ? 'unavailable'
      : !enabled ? 'off'
      : connection === 'none' ? 'setup'
      : connection;
    return [channel, {
      channel, available, unavailableReason: reason, enabled,
      explicit: facts.rows[channel] !== undefined, connection, state,
    } satisfies WorkspaceChannel];
  })) as Record<Channel, WorkspaceChannel>;
  return {
    channels,
    enabled: CHANNELS.filter((c) => channels[c].enabled),
    chosen: CHANNELS.some((c) => facts.rows[c] !== undefined),
  };
}

/** Reads the facts for one workspace inside its tenant transaction. */
export async function readChannelFacts(tx: TenantTransaction, accountId: string,
  env: Record<string, string | undefined> = process.env): Promise<ChannelFacts> {
  const rows = await tx.$queryRaw<{ channel: string; enabled: boolean }[]>(Prisma.sql`
    SELECT channel, enabled FROM workspace_channels WHERE account_id=${accountId}::uuid`);
  // A number counts once it is not admin-removed (status 'disconnected' with its token cleared).
  // It needs attention when it is not connected (registration failed) or Meta rejected its token.
  const [wa] = await tx.$queryRaw<{ usable: number; attention: number }[]>(Prisma.sql`
    SELECT count(*)::int AS usable,
      count(*) FILTER (WHERE status <> 'connected' OR health_error = 'token')::int AS attention
    FROM whatsapp_config
    WHERE account_id=${accountId}::uuid AND NOT (status = 'disconnected' AND access_token = '')`);
  const [ig] = await tx.$queryRaw<{ live: number; attention: number }[]>(Prisma.sql`
    SELECT count(*) FILTER (WHERE status = 'active')::int AS live,
      count(*) FILTER (WHERE status IN ('token_invalid','permission_missing'))::int AS attention
    FROM instagram_accounts
    WHERE account_id=${accountId}::uuid AND status <> 'disconnected'`);
  const instagramPlatform = instagramEnabled(env);
  const instagramPlan = (await getEntitlements(tx, accountId)).features.instagram === true;
  const explicit: Partial<Record<Channel, boolean>> = {};
  for (const row of rows) if (isChannel(row.channel)) explicit[row.channel] = row.enabled;
  return {
    rows: explicit,
    connections: {
      whatsapp: (wa?.attention ?? 0) > 0 ? 'attention' : (wa?.usable ?? 0) > 0 ? 'live' : 'none',
      instagram: (ig?.attention ?? 0) > 0 ? 'attention' : (ig?.live ?? 0) > 0 ? 'live' : 'none',
    },
    instagramPlatform,
    instagramPlan,
  };
}

/** The workspace's effective channel state. Any member may read it. */
export async function getWorkspaceChannels(tx: TenantTransaction, accountId: string): Promise<WorkspaceChannels> {
  return effectiveChannels(await readChannelFacts(tx, accountId));
}

export type ChannelSettingsErrorCode = 'invalid_request' | 'channel_connected' | 'last_channel' | 'plan_required' | 'platform_off';

const ERROR_STATUS: Record<ChannelSettingsErrorCode, number> = {
  invalid_request: 400,
  channel_connected: 409,
  last_channel: 409,
  plan_required: 402,
  platform_off: 503,
};

export class ChannelSettingsError extends Error {
  readonly status: number;
  constructor(readonly code: ChannelSettingsErrorCode, readonly channel?: Channel) {
    super(code);
    this.name = 'ChannelSettingsError';
    this.status = ERROR_STATUS[code];
  }
}

export type ChannelChanges = Partial<Record<Channel, boolean>>;

/** A PUT body: `{ channels: { whatsapp?: boolean, instagram?: boolean } }` with at least one channel. */
export function parseChannelChanges(body: unknown): ChannelChanges {
  const fail = () => new ChannelSettingsError('invalid_request');
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail();
  const outer = body as Record<string, unknown>;
  if (Object.keys(outer).some((key) => key !== 'channels')) throw fail();
  const input = outer.channels;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail();
  const changes: ChannelChanges = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!isChannel(key) || typeof value !== 'boolean') throw fail();
    changes[key] = value;
  }
  if (!Object.keys(changes).length) throw fail();
  return changes;
}

/**
 * Checks the channel rules for a change against the current facts. Throws the
 * first broken rule: turning Instagram on needs it available (402 plan / 503
 * platform); a connected channel cannot be turned off (409, disconnect first,
 * so inbound is never dropped); at least one channel stays enabled (409).
 */
export function assertChannelChange(facts: ChannelFacts, changes: ChannelChanges): ChannelFacts {
  const before = effectiveChannels(facts);
  for (const channel of CHANNELS) {
    const next = changes[channel];
    if (next === true && !before.channels[channel].available)
      throw new ChannelSettingsError(before.channels[channel].unavailableReason === 'plan' ? 'plan_required' : 'platform_off', channel);
    if (next === false && before.channels[channel].connection !== 'none')
      throw new ChannelSettingsError('channel_connected', channel);
  }
  const after: ChannelFacts = { ...facts, rows: { ...facts.rows, ...changes } };
  if (!effectiveChannels(after).enabled.length) throw new ChannelSettingsError('last_channel');
  return after;
}

const upsertRow = (tx: TenantTransaction, accountId: string, channel: Channel, enabled: boolean, userId: string | null) =>
  tx.$executeRaw(Prisma.sql`
    INSERT INTO workspace_channels(account_id, channel, enabled, enabled_at, updated_by_user_id)
    VALUES(${accountId}::uuid, ${channel}, ${enabled}, CASE WHEN ${enabled}::boolean THEN now() END, ${userId}::uuid)
    ON CONFLICT (account_id, channel) DO UPDATE SET enabled = EXCLUDED.enabled,
      enabled_at = CASE WHEN NOT EXCLUDED.enabled THEN NULL
        WHEN workspace_channels.enabled THEN workspace_channels.enabled_at ELSE now() END,
      updated_by_user_id = EXCLUDED.updated_by_user_id`);

/** One writer per workspace at a time, so two saves cannot both pass the one-channel rule. */
const lockChannels = (tx: TenantTransaction, accountId: string) =>
  tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`${accountId}:workspace_channels`}))`);

/**
 * An admin's change (PUT /api/account/channels): checks the rules under a
 * per-workspace lock, writes a row per channel named in `changes`, records an
 * audit row (channel names and on/off only) and returns the new state.
 */
export async function setWorkspaceChannels(tx: TenantTransaction, ctx: { accountId: string; userId: string },
  changes: ChannelChanges): Promise<WorkspaceChannels> {
  await lockChannels(tx, ctx.accountId);
  const facts = await readChannelFacts(tx, ctx.accountId);
  assertChannelChange(facts, changes);
  const changed: ChannelChanges = {};
  for (const channel of CHANNELS) {
    const next = changes[channel];
    if (next === undefined) continue;
    await upsertRow(tx, ctx.accountId, channel, next, ctx.userId);
    if (facts.rows[channel] !== next) changed[channel] = next;
  }
  if (Object.keys(changed).length)
    await tx.$executeRaw(Prisma.sql`INSERT INTO audit_logs(account_id, user_id, action, resource_id, metadata)
      VALUES(${ctx.accountId}::uuid, ${ctx.userId}::uuid, 'channels.updated', ${ctx.accountId}, ${JSON.stringify(changed)}::jsonb)`);
  return getWorkspaceChannels(tx, ctx.accountId);
}

/**
 * Connected implies enabled: a connect path calls this in the same
 * transaction that stores the new number or Instagram account. A worker
 * transaction passes no user. Leaves an already-enabled row untouched.
 */
export async function ensureChannelEnabled(tx: TenantTransaction, accountId: string, channel: Channel,
  userId: string | null = null): Promise<void> {
  await lockChannels(tx, accountId);
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO workspace_channels(account_id, channel, enabled, enabled_at, updated_by_user_id)
    VALUES(${accountId}::uuid, ${channel}, true, now(), ${userId}::uuid)
    ON CONFLICT (account_id, channel) DO UPDATE SET enabled = true, enabled_at = now(),
      updated_by_user_id = EXCLUDED.updated_by_user_id
    WHERE NOT workspace_channels.enabled`);
}
