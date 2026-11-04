// Instagram comment-to-private-reply rules (Phase 11, design sections 3.5 and 4). Owner: T2.
//
// Settings-level rules: when someone comments on a post (one post, or any post
// of the account) and the comment holds one of the keywords (or any comment
// when there are none), the private-reply job sends reply_text once. Admins
// manage them; every read and write runs as the member (app role, RLS
// admin_write) inside withTenant. A rule needs the plan's instagram feature,
// a connected account and the comments permission on its grant, otherwise
// instagram_permission_missing. No Instagram call is made here.
import { requireFeature } from '@/lib/billing/entitlements';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { hasMinRole } from '@/lib/auth/roles';
import { auditTx } from '@/lib/payments/ledger';
import { instagramConfig, missingScopes } from './config';
import { InstagramError } from './errors';
import { utf8Bytes } from './graph-limits';
import type { InstagramActor } from './connection';

export const MAX_RULES_PER_ACCOUNT = 50;
export const MAX_KEYWORDS = 20;
export const MAX_KEYWORD_LENGTH = 50;
export const MAX_REPLY_BYTES = 1000;

export interface CommentRuleView {
  id: string;
  instagramAccountId: string;
  mediaId: string | null;
  keywords: string[];
  replyText: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CommentRuleInput {
  mediaId: string | null;
  keywords: string[];
  replyText: string;
  active: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MEDIA_ID = /^\d{1,32}$/;

/** Trims, lower-cases, de-duplicates; refuses empty, over-long or too many keywords. */
export function normaliseKeywords(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const value of raw) {
    const keyword = value.normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!keyword) continue;
    if ([...keyword].length > MAX_KEYWORD_LENGTH) throw new InstagramError('invalid_request');
    seen.add(keyword);
  }
  if (seen.size > MAX_KEYWORDS) throw new InstagramError('invalid_request');
  return [...seen];
}

/** Validates and normalises a full rule (the route's zod already checked the shape). */
export function normaliseRule(input: CommentRuleInput): CommentRuleInput {
  const replyText = input.replyText.trim();
  if (!replyText || utf8Bytes(replyText) > MAX_REPLY_BYTES) throw new InstagramError('invalid_request');
  const mediaId = input.mediaId?.trim() || null;
  if (mediaId !== null && !MEDIA_ID.test(mediaId)) throw new InstagramError('invalid_request');
  return { mediaId, keywords: normaliseKeywords(input.keywords), replyText, active: input.active };
}

interface RuleRow {
  id: string;
  instagram_account_id: string;
  media_id: string | null;
  keywords: string[];
  reply_text: string;
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

const toView = (row: RuleRow): CommentRuleView => ({
  id: row.id,
  instagramAccountId: row.instagram_account_id,
  mediaId: row.media_id,
  keywords: [...(row.keywords ?? [])],
  replyText: row.reply_text,
  active: row.active,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

/**
 * Off -> instagram_not_enabled; not an admin -> forbidden; plan without the
 * feature -> PlanLimitError (answered with the plan's message); unknown or
 * other-workspace account -> not_found; disconnected -> instagram_account_disconnected;
 * comments permission not granted -> instagram_permission_missing.
 */
async function guardTx(tx: TenantTransaction, actor: InstagramActor, instagramAccountId: string): Promise<void> {
  await requireFeature(tx, actor.accountId, 'instagram');
  const [account] = await tx.$queryRaw<{ status: string; scopes: string[] }[]>`
    SELECT status, scopes FROM instagram_accounts WHERE account_id=${actor.accountId}::uuid AND id=${instagramAccountId}::uuid`;
  if (!account) throw new InstagramError('not_found');
  if (account.status === 'disconnected') throw new InstagramError('instagram_account_disconnected');
  if (missingScopes(account.scopes ?? [], 'comments').length) throw new InstagramError('instagram_permission_missing');
}

function precheck(actor: InstagramActor, instagramAccountId: string, ruleId?: string): void {
  if (!instagramConfig()) throw new InstagramError('instagram_not_enabled');
  if (!hasMinRole(actor.role, 'admin')) throw new InstagramError('forbidden');
  if (!UUID.test(instagramAccountId) || (ruleId !== undefined && !UUID.test(ruleId))) throw new InstagramError('not_found');
}

const SELECT_COLUMNS = 'id::text AS id, instagram_account_id::text AS instagram_account_id, media_id, keywords, reply_text, active, created_at, updated_at';

async function selectRules(tx: TenantTransaction, accountId: string, instagramAccountId: string, ruleId: string | null = null) {
  const rows = await tx.$queryRawUnsafe<RuleRow[]>(
    `SELECT ${SELECT_COLUMNS} FROM instagram_comment_rules
     WHERE account_id=$1::uuid AND instagram_account_id=$2::uuid AND ($3::uuid IS NULL OR id=$3::uuid)
     ORDER BY created_at, id LIMIT ${MAX_RULES_PER_ACCOUNT}`,
    accountId, instagramAccountId, ruleId);
  return rows.map(toView);
}

export async function listCommentRules(actor: InstagramActor, instagramAccountId: string): Promise<CommentRuleView[]> {
  precheck(actor, instagramAccountId);
  return withTenant(actor, async (tx) => {
    await guardTx(tx, actor, instagramAccountId);
    return selectRules(tx, actor.accountId, instagramAccountId);
  });
}

export async function createCommentRule(actor: InstagramActor, instagramAccountId: string,
  input: CommentRuleInput): Promise<CommentRuleView> {
  precheck(actor, instagramAccountId);
  const rule = normaliseRule(input);
  return withTenant(actor, async (tx) => {
    await guardTx(tx, actor, instagramAccountId);
    // Serialise creates for one Instagram account so the cap cannot be raced past.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`ig-rules:${instagramAccountId}`}, 0))`;
    const [count] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM instagram_comment_rules
      WHERE account_id=${actor.accountId}::uuid AND instagram_account_id=${instagramAccountId}::uuid`;
    if ((count?.n ?? 0) >= MAX_RULES_PER_ACCOUNT) throw new InstagramError('limit_reached');
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO instagram_comment_rules(account_id, instagram_account_id, media_id, keywords, reply_text, active, created_by_user_id)
      VALUES(${actor.accountId}::uuid, ${instagramAccountId}::uuid, ${rule.mediaId}, ${rule.keywords}::text[], ${rule.replyText},
        ${rule.active}, ${actor.userId}::uuid)
      RETURNING id::text AS id`;
    await auditTx(tx, actor.accountId, actor.userId, 'instagram.comment_rule.create', row.id,
      { instagram_account_id: instagramAccountId, active: rule.active });
    const [view] = await selectRules(tx, actor.accountId, instagramAccountId, row.id);
    return view;
  });
}

export async function updateCommentRule(actor: InstagramActor, instagramAccountId: string, ruleId: string,
  patch: Partial<CommentRuleInput>): Promise<CommentRuleView> {
  precheck(actor, instagramAccountId, ruleId);
  return withTenant(actor, async (tx) => {
    await guardTx(tx, actor, instagramAccountId);
    const [current] = await selectRulesForUpdate(tx, actor.accountId, instagramAccountId, ruleId);
    if (!current) throw new InstagramError('not_found');
    const next = normaliseRule({
      mediaId: patch.mediaId !== undefined ? patch.mediaId : current.mediaId,
      keywords: patch.keywords ?? current.keywords,
      replyText: patch.replyText ?? current.replyText,
      active: patch.active ?? current.active,
    });
    await tx.$executeRaw`UPDATE instagram_comment_rules SET media_id=${next.mediaId}, keywords=${next.keywords}::text[],
        reply_text=${next.replyText}, active=${next.active}
      WHERE account_id=${actor.accountId}::uuid AND instagram_account_id=${instagramAccountId}::uuid AND id=${ruleId}::uuid`;
    await auditTx(tx, actor.accountId, actor.userId, 'instagram.comment_rule.update', ruleId,
      { instagram_account_id: instagramAccountId, active: next.active });
    const [view] = await selectRules(tx, actor.accountId, instagramAccountId, ruleId);
    return view;
  });
}

async function selectRulesForUpdate(tx: TenantTransaction, accountId: string, instagramAccountId: string, ruleId: string) {
  const rows = await tx.$queryRawUnsafe<RuleRow[]>(
    `SELECT ${SELECT_COLUMNS} FROM instagram_comment_rules
     WHERE account_id=$1::uuid AND instagram_account_id=$2::uuid AND id=$3::uuid FOR UPDATE`,
    accountId, instagramAccountId, ruleId);
  return rows.map(toView);
}

/**
 * Deletes a rule. Comment events that matched it keep their status; the FK
 * sets their rule_id to NULL, and a queued reply whose rule is gone is not sent
 * (the private-reply job reads the rule).
 */
export async function deleteCommentRule(actor: InstagramActor, instagramAccountId: string, ruleId: string): Promise<void> {
  precheck(actor, instagramAccountId, ruleId);
  await withTenant(actor, async (tx) => {
    await guardTx(tx, actor, instagramAccountId).catch((error) => {
      // A rule can still be removed after the permission was withdrawn or the account disconnected.
      if (error instanceof InstagramError && (error.code === 'instagram_permission_missing'
        || error.code === 'instagram_account_disconnected')) return;
      throw error;
    });
    const deleted = await tx.$executeRaw`DELETE FROM instagram_comment_rules
      WHERE account_id=${actor.accountId}::uuid AND instagram_account_id=${instagramAccountId}::uuid AND id=${ruleId}::uuid`;
    if (!deleted) throw new InstagramError('not_found');
    await auditTx(tx, actor.accountId, actor.userId, 'instagram.comment_rule.delete', ruleId,
      { instagram_account_id: instagramAccountId });
  });
}
