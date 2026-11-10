// Flows per channel (Stage 1): the server rules that keep a flow in its
// channel's section. A published flow's channel is fixed (409 channel_locked;
// the user duplicates it to use it elsewhere) and a flow cannot go live on a
// channel the workspace has turned off (409 channel_disabled). Both checks run
// inside the caller's tenant transaction (withTenant) and lock the flow row the
// way publishFlow and saveDraft do, so a concurrent publish or save cannot
// slip between the check and the write.
import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { scopeChannels, isChannel } from '@/lib/channels/capabilities';
import { getWorkspaceChannels } from '@/lib/channels/workspace';
import type { TenantTransaction } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import type { Channel } from '@/types';
import type { FlowChannelScope } from './types';
import { lockAccountPublishing } from './versions';

export type FlowChannelErrorCode = 'channel_locked' | 'channel_disabled';

export class FlowChannelError extends Error {
  readonly status = 409;
  constructor(readonly code: FlowChannelErrorCode, readonly channel: Channel | null = null) {
    super(code);
    this.name = 'FlowChannelError';
  }
}

type ScopeRow = { channel_scope: FlowChannelScope | null; published_version_id: string | null };

/** The flow's scope and live version under its row lock; null when it is not the account's. */
async function lockScope(tx: TenantTransaction, accountId: string, flowId: string): Promise<ScopeRow | null> {
  const rows = await tx.$queryRaw<ScopeRow[]>(Prisma.sql`SELECT channel_scope, published_version_id::text AS published_version_id
    FROM flows WHERE account_id=${accountId}::uuid AND id=${flowId}::uuid FOR UPDATE`);
  return rows[0] ?? null;
}

/** Pure: may a flow move from `current` to `next`? Only a never-published flow may. */
export function scopeChangeAllowed(current: FlowChannelScope | null | undefined, next: FlowChannelScope,
  publishedVersionId: string | null | undefined): boolean {
  return (current ?? 'whatsapp') === next || !publishedVersionId;
}

/**
 * Refuses (channel_locked) changing the channel of a flow that has a published
 * version. Call it before saveDraft in the same transaction, after any account
 * publish lock the save takes (the same lock order as publishFlow).
 */
export async function assertScopeChangeAllowed(tx: TenantTransaction, accountId: string, flowId: string,
  next: FlowChannelScope): Promise<void> {
  const row = await lockScope(tx, accountId, flowId);
  if (!row) return; // saveDraft answers not_found
  if (!scopeChangeAllowed(row.channel_scope, next, row.published_version_id))
    throw new FlowChannelError('channel_locked', isChannel(row.channel_scope) ? row.channel_scope : null);
}

/** Pure: is at least one channel the scope runs on enabled? A legacy 'any' flow needs only one. */
export function scopeOpen(scope: FlowChannelScope | null | undefined, enabled: readonly Channel[]): boolean {
  return scopeChannels(scope).some((channel) => enabled.includes(channel));
}

/**
 * Refuses (channel_disabled) publishing or resuming a flow whose channel is
 * turned off for the workspace. Takes the account publish lock and the flow
 * row lock in publishFlow's order (both re-entrant in the same transaction),
 * so the scope it checks is the one publishFlow then publishes.
 */
export async function assertFlowChannelOpen(tx: TenantTransaction, accountId: string, flowId: string): Promise<void> {
  await lockAccountPublishing(tx, accountId);
  const row = await lockScope(tx, accountId, flowId);
  if (!row) return; // publishFlow answers not_found
  const { enabled } = await getWorkspaceChannels(tx, accountId);
  if (!scopeOpen(row.channel_scope, enabled)) throw new FlowChannelError('channel_disabled', scopeChannels(row.channel_scope)[0] ?? null);
}

/** The 409 for a FlowChannelError (fixed, translated text and its code), or null for any other error. */
export function flowChannelErrorResponse(err: unknown): NextResponse | null {
  if (!(err instanceof FlowChannelError)) return null;
  const t = getT('Flows.channelSection');
  const channel = err.channel ? getT('Channels.names')(err.channel) : '';
  const message = err.code === 'channel_locked' ? t('locked') : t('disabled', { channel });
  return NextResponse.json({ error: message, code: err.code, channel: err.channel }, { status: err.status });
}
