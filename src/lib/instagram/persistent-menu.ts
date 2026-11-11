// Instagram persistent menu (Stage 3, 3D): up to 20 items an Instagram account
// shows in every chat with it; an item either starts a Bodhinox Instagram flow
// (a postback with the payload `menu:<flow id>`, postback-payloads.ts) or opens
// an https link.
//
// Storage: instagram_accounts.persistent_menu = [{ type, title, flow_id | url }]
// is the menu Bodhinox last synced to Meta (null: never set by Bodhinox, so a
// menu set elsewhere is not ours to show or overwrite). The app role reads it
// through a column grant; only the worker writes instagram_accounts.
//
// A save mirrors ice-breakers.ts: member transaction (role, plan, account,
// permission, every flow is a usable Instagram flow of this workspace) -> Meta
// (messenger_profile; replaces the whole menu, so a retry after an ambiguous
// outcome is safe) -> worker transaction that stores the menu only if nobody
// else saved meanwhile. No network call runs inside a transaction. Needs live
// capture: the persistent_menu shape on an Instagram Login app (see graph.ts),
// so the whole feature stays behind INSTAGRAM_ENABLED. Titles are business
// content; the audit row keeps only counts.
import { Prisma } from '@prisma/client';
import { hasMinRole } from '@/lib/auth/roles';
import { requireFeature } from '@/lib/billing/entitlements';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { auditTx } from '@/lib/payments/ledger';
import { instagramConfig, missingScopes } from './config';
import { asWorker, loadAccountSecretTx, readToken, type InstagramActor } from './connection';
import { InstagramError } from './errors';
import {
  INSTAGRAM_LIMITS, InstagramGraphInputError, isMetaThrottle, isMetaTokenInvalid, setPersistentMenu, type PersistentMenuItem,
} from './graph';
import { charLength, validHttpsUrl } from './graph-limits';
import { flowsTx, usable } from './ice-breakers';
import { encodePostback } from './postback-payloads';

export const MAX_MENU_ITEMS = INSTAGRAM_LIMITS.persistentMenuItems;
export const MAX_MENU_TITLE_CHARS = INSTAGRAM_LIMITS.persistentMenuTitleChars;

export type MenuItem =
  | { type: 'postback'; title: string; flowId: string }
  | { type: 'web_url'; title: string; url: string };

export type MenuItemView = MenuItem & {
  /** For a flow item: the linked flow's name, or null when it no longer exists. */
  flowName: string | null;
  /** False when the flow was deleted, archived or is not an Instagram flow (a tap then starts nothing). */
  flowUsable: boolean;
};

export interface PersistentMenuView {
  instagramAccountId: string;
  /** False until Bodhinox has set the menu once (a menu set elsewhere is not shown). */
  managed: boolean;
  syncedAt: string | null;
  items: MenuItemView[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clean = (raw: unknown): string => String(raw ?? '').normalize('NFC').trim().replace(/\s+/g, ' ');

/**
 * Trims each title and lower-cases each flow id; refuses more than 20 items,
 * an empty or over-long title, a repeated title (case-insensitive), a link
 * that is not https, a malformed flow id or an unknown type (invalid_request).
 */
export function normaliseMenu(input: readonly { type: string; title: string; flowId?: string; url?: string }[]): MenuItem[] {
  if (!Array.isArray(input) || input.length > MAX_MENU_ITEMS) throw new InstagramError('invalid_request');
  const seen = new Set<string>();
  return input.map((raw) => {
    const title = clean(raw?.title);
    if (!title || charLength(title) > MAX_MENU_TITLE_CHARS) throw new InstagramError('invalid_request');
    const key = title.toLowerCase();
    if (seen.has(key)) throw new InstagramError('invalid_request');
    seen.add(key);
    if (raw.type === 'postback') {
      const flowId = String(raw.flowId ?? '').toLowerCase();
      if (!UUID.test(flowId)) throw new InstagramError('invalid_request');
      return { type: 'postback', title, flowId };
    }
    if (raw.type === 'web_url') {
      const url = String(raw.url ?? '').trim();
      if (!validHttpsUrl(url)) throw new InstagramError('invalid_request');
      return { type: 'web_url', title, url };
    }
    throw new InstagramError('invalid_request');
  });
}

/** The stored jsonb list, read leniently (anything malformed is skipped, never trusted). */
export function storedMenu(raw: unknown): MenuItem[] {
  if (!Array.isArray(raw)) return [];
  const items: MenuItem[] = [];
  for (const item of raw.slice(0, MAX_MENU_ITEMS)) {
    const { type, title, flow_id: flowId, url } = (item ?? {}) as Record<string, unknown>;
    if (typeof title !== 'string' || !title.trim()) continue;
    if (type === 'postback' && typeof flowId === 'string' && UUID.test(flowId)) items.push({ type, title, flowId: flowId.toLowerCase() });
    else if (type === 'web_url' && validHttpsUrl(url)) items.push({ type, title, url });
  }
  return items;
}

/** What Meta receives: a flow item posts back `menu:<flow id>`, a link item opens its URL. */
export function menuItemsForMeta(items: readonly MenuItem[]): PersistentMenuItem[] {
  return items.map((item) => item.type === 'web_url'
    ? { type: 'web_url', title: item.title, url: item.url }
    : { type: 'postback', title: item.title, payload: encodePostback({ kind: 'menu', flowId: item.flowId }) });
}

const toStored = (items: readonly MenuItem[]) => items.map((item) => item.type === 'web_url'
  ? { type: 'web_url', title: item.title, url: item.url }
  : { type: 'postback', title: item.title, flow_id: item.flowId });

function precheck(actor: InstagramActor, instagramAccountId: string, write: boolean): void {
  if (!instagramConfig()) throw new InstagramError('instagram_not_enabled');
  if (write && !hasMinRole(actor.role, 'admin')) throw new InstagramError('forbidden');
  if (!UUID.test(instagramAccountId)) throw new InstagramError('not_found');
}

/** The last save's version: persistent_menu_synced_at in whole microseconds, as text (a JS Date would drop them). */
const SYNC_VERSION = Prisma.sql`(extract(epoch FROM persistent_menu_synced_at) * 1000000)::bigint::text`;

interface AccountState { status: string; scopes: string[]; menu: unknown; synced_at: Date | null; version: string | null }

async function accountTx(tx: TenantTransaction, actor: InstagramActor, instagramAccountId: string): Promise<AccountState> {
  await requireFeature(tx, actor.accountId, 'instagram');
  const [account] = await tx.$queryRaw<AccountState[]>`
    SELECT status, scopes, persistent_menu AS menu, persistent_menu_synced_at AS synced_at, ${SYNC_VERSION} AS version
    FROM instagram_accounts WHERE account_id=${actor.accountId}::uuid AND id=${instagramAccountId}::uuid`;
  if (!account) throw new InstagramError('not_found');
  if (account.status === 'disconnected') throw new InstagramError('instagram_account_disconnected');
  return account;
}

/** Any member: the account's menu as Bodhinox last synced it, with each linked flow's state. */
export async function getPersistentMenu(actor: InstagramActor, instagramAccountId: string): Promise<PersistentMenuView> {
  precheck(actor, instagramAccountId, false);
  return withTenant(actor, async (tx) => {
    const account = await accountTx(tx, actor, instagramAccountId);
    const items = storedMenu(account.menu);
    const flows = await flowsTx(tx, actor.accountId, items.flatMap((i) => (i.type === 'postback' ? [i.flowId] : [])));
    return {
      instagramAccountId,
      managed: account.menu !== null,
      syncedAt: account.synced_at ? account.synced_at.toISOString() : null,
      items: items.map((item) => {
        if (item.type === 'web_url') return { ...item, flowName: null, flowUsable: true };
        const flow = flows.get(item.flowId);
        return { ...item, flowName: flow?.name ?? null, flowUsable: usable(flow) };
      }),
    };
  });
}

/**
 * Admin: replace the account's persistent menu on Meta, then store it. An
 * empty list removes it. Refusals: not an admin -> forbidden; invalid list or
 * a flow that is missing, archived, another workspace's or not an Instagram
 * flow -> invalid_request; messages permission not granted ->
 * instagram_permission_missing; token rejected -> instagram_token_invalid;
 * Meta throttled, or another admin saved meanwhile -> rate_limited (save
 * again; the menu on Meta is whichever save reached it last); anything else
 * from Meta -> meta_error (nothing stored).
 */
export async function setPersistentMenuItems(actor: InstagramActor, instagramAccountId: string,
  input: readonly { type: string; title: string; flowId?: string; url?: string }[]): Promise<PersistentMenuView> {
  precheck(actor, instagramAccountId, true);
  const items = normaliseMenu(input);
  const version = await withTenant(actor, async (tx) => {
    const account = await accountTx(tx, actor, instagramAccountId);
    if (account.status === 'token_invalid') throw new InstagramError('instagram_token_invalid');
    if (missingScopes(account.scopes ?? [], 'dm').length) throw new InstagramError('instagram_permission_missing');
    const flowIds = items.flatMap((i) => (i.type === 'postback' ? [i.flowId] : []));
    const flows = await flowsTx(tx, actor.accountId, flowIds);
    if (!flowIds.every((id) => usable(flows.get(id)))) throw new InstagramError('invalid_request');
    return account.version;
  });

  const secret = await asWorker(actor.accountId, (tx) => loadAccountSecretTx(tx, actor.accountId, instagramAccountId));
  if (!secret || secret.status === 'disconnected') throw new InstagramError('instagram_account_disconnected');
  const token = readToken(secret);
  if (!token) throw new InstagramError('instagram_token_invalid');
  try {
    await setPersistentMenu(secret.ig_user_id, token, menuItemsForMeta(items));
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
      SET persistent_menu=${JSON.stringify(toStored(items))}::jsonb, persistent_menu_synced_at=now()
      WHERE account_id=${actor.accountId}::uuid AND id=${instagramAccountId}::uuid AND ig_user_id=${secret.ig_user_id}
        AND status<>'disconnected' AND ${SYNC_VERSION} IS NOT DISTINCT FROM ${version}`;
    if (!stored) {
      const [row] = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM instagram_accounts
        WHERE account_id=${actor.accountId}::uuid AND id=${instagramAccountId}::uuid AND ig_user_id=${secret.ig_user_id}`;
      throw new InstagramError(!row || row.status === 'disconnected' ? 'instagram_account_disconnected' : 'rate_limited');
    }
    await auditTx(tx, actor.accountId, actor.userId, 'instagram.persistent_menu.update', instagramAccountId, { items: items.length });
  });
  return getPersistentMenu(actor, instagramAccountId);
}
