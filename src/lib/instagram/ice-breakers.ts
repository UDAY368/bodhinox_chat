// Instagram conversation starters (ice breakers, Stage 2 item 7). Owner: 2E.
//
// Up to 4 questions an Instagram account shows when someone opens a chat with
// it; each one starts a Bodhinox Instagram flow. A tap reaches the webhook as
// a postback with the payload `ib:<flow id>` (postback-payloads.ts); the 2C
// engine starts the flow after iceBreakerFlowTx confirms the flow is one of
// this account's current starters.
//
// Storage: instagram_accounts.ice_breakers = [{ question, flow_id }] is the
// list Bodhinox last synced to Meta (null: never set by Bodhinox, so the
// starters on Meta are not ours to show). The app role reads it through a
// column grant; only the worker writes instagram_accounts.
//
// A save is: member transaction (role, plan, account, permission, every flow
// is an Instagram flow of this workspace) -> Meta (messenger_profile; replaces
// the whole list, so a retry after an ambiguous outcome is safe) -> worker
// transaction that stores the list only if nobody else saved meanwhile. No
// network call runs inside a transaction. Needs live capture: the
// messenger_profile shape on an Instagram Login app (see graph.ts), so the
// whole feature stays behind INSTAGRAM_ENABLED. Questions are business
// content, never customer content, but the audit row still keeps only counts.
import { Prisma } from '@prisma/client';
import { hasMinRole } from '@/lib/auth/roles';
import { requireFeature } from '@/lib/billing/entitlements';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { auditTx } from '@/lib/payments/ledger';
import { instagramConfig, missingScopes } from './config';
import { asWorker, loadAccountSecretTx, readToken, type InstagramActor } from './connection';
import { InstagramError } from './errors';
import {
  INSTAGRAM_LIMITS, InstagramGraphInputError, isMetaThrottle, isMetaTokenInvalid, setIceBreakers, type IceBreaker,
} from './graph';
import { charLength } from './graph-limits';
import { encodePostback } from './postback-payloads';

export const MAX_STARTERS = INSTAGRAM_LIMITS.iceBreakers;
export const MAX_QUESTION_CHARS = INSTAGRAM_LIMITS.iceBreakerQuestionChars;

export interface ConversationStarter {
  question: string;
  flowId: string;
}

export interface ConversationStarterView extends ConversationStarter {
  /** The linked flow's name, or null when it no longer exists. */
  flowName: string | null;
  flowStatus: string | null;
  /** False when the flow was deleted, archived or is not an Instagram flow (a tap then starts nothing). */
  flowUsable: boolean;
}

export interface ConversationStartersView {
  instagramAccountId: string;
  /** False until Bodhinox has set the starters once (starters set elsewhere are not shown). */
  managed: boolean;
  syncedAt: string | null;
  starters: ConversationStarterView[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Trims each question and lower-cases each flow id; refuses more than 4, an
 * empty or over-long question, a repeated question (case-insensitive) or a
 * malformed flow id (invalid_request).
 */
export function normaliseStarters(input: readonly { question: string; flowId: string }[]): ConversationStarter[] {
  if (input.length > MAX_STARTERS) throw new InstagramError('invalid_request');
  const seen = new Set<string>();
  return input.map(({ question: raw, flowId: rawFlow }) => {
    const question = String(raw ?? '').normalize('NFC').trim().replace(/\s+/g, ' ');
    const flowId = String(rawFlow ?? '').toLowerCase();
    if (!question || charLength(question) > MAX_QUESTION_CHARS || !UUID.test(flowId)) throw new InstagramError('invalid_request');
    const key = question.toLowerCase();
    if (seen.has(key)) throw new InstagramError('invalid_request');
    seen.add(key);
    return { question, flowId };
  });
}

/** The stored jsonb list, read leniently (anything malformed is skipped, never trusted). */
export function storedStarters(raw: unknown): ConversationStarter[] {
  if (!Array.isArray(raw)) return [];
  const starters: ConversationStarter[] = [];
  for (const item of raw.slice(0, MAX_STARTERS)) {
    const question = (item as { question?: unknown } | null)?.question;
    const flowId = (item as { flow_id?: unknown } | null)?.flow_id;
    if (typeof question === 'string' && question.trim() && typeof flowId === 'string' && UUID.test(flowId)) {
      starters.push({ question, flowId: flowId.toLowerCase() });
    }
  }
  return starters;
}

/** What Meta receives: each question with the payload a tap posts back (`ib:<flow id>`). */
export function iceBreakerItems(starters: readonly ConversationStarter[]): IceBreaker[] {
  return starters.map((s) => ({ question: s.question, payload: encodePostback({ kind: 'ice_breaker', flowId: s.flowId }) }));
}

const toStored = (starters: readonly ConversationStarter[]) => starters.map((s) => ({ question: s.question, flow_id: s.flowId }));

function precheck(actor: InstagramActor, instagramAccountId: string, write: boolean): void {
  if (!instagramConfig()) throw new InstagramError('instagram_not_enabled');
  if (write && !hasMinRole(actor.role, 'admin')) throw new InstagramError('forbidden');
  if (!UUID.test(instagramAccountId)) throw new InstagramError('not_found');
}

/**
 * The last save's version: profile_synced_at in whole microseconds, as text
 * (independent of each connection's TimeZone and DateStyle; a JS Date would
 * drop the microseconds).
 */
const SYNC_VERSION = Prisma.sql`(extract(epoch FROM profile_synced_at) * 1000000)::bigint::text`;

interface AccountState { status: string; scopes: string[]; ice_breakers: unknown; synced_at: Date | null; version: string | null }

/** Plan feature, then the account in this workspace (not_found otherwise, also another workspace's id), not disconnected. */
async function accountTx(tx: TenantTransaction, actor: InstagramActor, instagramAccountId: string): Promise<AccountState> {
  await requireFeature(tx, actor.accountId, 'instagram');
  const [account] = await tx.$queryRaw<AccountState[]>`
    SELECT status, scopes, ice_breakers, profile_synced_at AS synced_at, ${SYNC_VERSION} AS version
    FROM instagram_accounts WHERE account_id=${actor.accountId}::uuid AND id=${instagramAccountId}::uuid`;
  if (!account) throw new InstagramError('not_found');
  if (account.status === 'disconnected') throw new InstagramError('instagram_account_disconnected');
  return account;
}

interface FlowFacts { id: string; name: string; status: string; channel_scope: string }

const usable = (flow: FlowFacts | undefined): boolean =>
  !!flow && (flow.channel_scope === 'instagram' || flow.channel_scope === 'any') && flow.status !== 'archived';

/** The workspace's flows among `ids` (RLS and the explicit account filter both keep other workspaces out). */
async function flowsTx(tx: TenantTransaction, accountId: string, ids: readonly string[]): Promise<Map<string, FlowFacts>> {
  if (!ids.length) return new Map();
  const rows = await tx.$queryRaw<FlowFacts[]>`SELECT id::text AS id, name, status, channel_scope FROM flows
    WHERE account_id=${accountId}::uuid AND id = ANY(${[...new Set(ids)]}::uuid[])`;
  return new Map(rows.map((row) => [row.id, row]));
}

/** Any member: the account's starters as Bodhinox last synced them, with each linked flow's state. */
export async function getConversationStarters(actor: InstagramActor, instagramAccountId: string): Promise<ConversationStartersView> {
  precheck(actor, instagramAccountId, false);
  return withTenant(actor, async (tx) => {
    const account = await accountTx(tx, actor, instagramAccountId);
    const starters = storedStarters(account.ice_breakers);
    const flows = await flowsTx(tx, actor.accountId, starters.map((s) => s.flowId));
    return {
      instagramAccountId,
      managed: account.ice_breakers !== null,
      syncedAt: account.synced_at ? account.synced_at.toISOString() : null,
      starters: starters.map((s) => {
        const flow = flows.get(s.flowId);
        return { ...s, flowName: flow?.name ?? null, flowStatus: flow?.status ?? null, flowUsable: usable(flow) };
      }),
    };
  });
}

/**
 * Admin: replace the account's starters on Meta, then store them. An empty
 * list removes them. Refusals: not an admin -> forbidden; invalid list or a
 * flow that is missing, archived, another workspace's or not an Instagram
 * flow -> invalid_request; messages permission not granted ->
 * instagram_permission_missing; token rejected -> instagram_token_invalid;
 * Meta throttled, or another admin saved meanwhile -> rate_limited (save
 * again; the list on Meta is whichever save reached it last); anything else
 * from Meta -> meta_error (nothing stored).
 */
export async function setConversationStarters(actor: InstagramActor, instagramAccountId: string,
  input: readonly { question: string; flowId: string }[]): Promise<ConversationStartersView> {
  precheck(actor, instagramAccountId, true);
  const starters = normaliseStarters(input);
  const version = await withTenant(actor, async (tx) => {
    const account = await accountTx(tx, actor, instagramAccountId);
    if (account.status === 'token_invalid') throw new InstagramError('instagram_token_invalid');
    if (missingScopes(account.scopes ?? [], 'dm').length) throw new InstagramError('instagram_permission_missing');
    const flows = await flowsTx(tx, actor.accountId, starters.map((s) => s.flowId));
    if (!starters.every((s) => usable(flows.get(s.flowId)))) throw new InstagramError('invalid_request');
    return account.version;
  });

  const secret = await asWorker(actor.accountId, (tx) => loadAccountSecretTx(tx, actor.accountId, instagramAccountId));
  if (!secret || secret.status === 'disconnected') throw new InstagramError('instagram_account_disconnected');
  const token = readToken(secret);
  if (!token) throw new InstagramError('instagram_token_invalid');
  try {
    await setIceBreakers(secret.ig_user_id, token, iceBreakerItems(starters));
  } catch (error) {
    if (error instanceof InstagramGraphInputError) throw new InstagramError('invalid_request');
    if (isMetaTokenInvalid(error)) throw new InstagramError('instagram_token_invalid');
    if (isMetaThrottle(error)) throw new InstagramError('rate_limited');
    throw new InstagramError('meta_error');
  }

  await asWorker(actor.accountId, async (tx) => {
    // Stored only on the row Meta was told about (same Instagram user, still
    // connected) and only if no other save landed since this one read it.
    const stored = await tx.$executeRaw`UPDATE instagram_accounts
      SET ice_breakers=${JSON.stringify(toStored(starters))}::jsonb, profile_synced_at=now()
      WHERE account_id=${actor.accountId}::uuid AND id=${instagramAccountId}::uuid AND ig_user_id=${secret.ig_user_id}
        AND status<>'disconnected' AND ${SYNC_VERSION} IS NOT DISTINCT FROM ${version}`;
    if (!stored) {
      const [row] = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM instagram_accounts
        WHERE account_id=${actor.accountId}::uuid AND id=${instagramAccountId}::uuid AND ig_user_id=${secret.ig_user_id}`;
      throw new InstagramError(!row || row.status === 'disconnected' ? 'instagram_account_disconnected' : 'rate_limited');
    }
    await auditTx(tx, actor.accountId, actor.userId, 'instagram.ice_breakers.update', instagramAccountId,
      { starters: starters.length });
  });
  return getConversationStarters(actor, instagramAccountId);
}

/**
 * For the engine (2C), inside its own tenant transaction: true when `flowId`
 * is one of this Instagram account's current starters, so a decoded `ib:`
 * payload is only acted on for a starter Bodhinox set on this account. The
 * engine still loads the flow under withTenant and checks its channel.
 */
export async function iceBreakerFlowTx(tx: TenantTransaction, accountId: string, instagramAccountId: string,
  flowId: string): Promise<boolean> {
  if (!UUID.test(instagramAccountId) || !UUID.test(flowId)) return false;
  const [row] = await tx.$queryRaw<{ ice_breakers: unknown }[]>`SELECT ice_breakers FROM instagram_accounts
    WHERE account_id=${accountId}::uuid AND id=${instagramAccountId}::uuid AND status<>'disconnected'`;
  return !!row && storedStarters(row.ice_breakers).some((s) => s.flowId === flowId.toLowerCase());
}
