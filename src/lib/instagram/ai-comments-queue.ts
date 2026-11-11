// The AI comment approval queue as the browser sees it (Stage 3, 3C): the
// /api/instagram/ai-comments routes call these. The worker side (drafting and
// posting) is ai-comments.ts.
//
//   getAiCommentSettings / updateAiCommentSettings   the three ai_configs switches
//        (enabled, auto-approve, daily cap). Any member reads, an admin writes;
//        ai_configs is browser read-only, so this is the only write path.
//   listAiComments   the queue. Bodhinox stores no comment text, so each
//        waiting draft is shown with its comment read live from Meta (by the
//        worker role: the app role cannot read the token). A comment Meta no
//        longer shows (hidden, deleted) comes back as unavailable and cannot be
//        approved from the page's point of view.
//   decideAiComment  an admin approves (optionally editing the reply) or rejects
//        a PENDING draft, as themselves, under the app role's RLS policy. An
//        approval also queues the posting job in the same transaction, so the
//        acknowledgement never outruns the work; the worker posts it once
//        through the shared outbound intent. A draft someone else already
//        decided is `already_decided` (409), never overwritten.
//
// No comment text, draft or token is logged; the audit row keeps ids and flags.
import { Prisma } from '@prisma/client';
import { hasMinRole } from '@/lib/auth/roles';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { auditTx, enqueueJobTx } from '@/lib/payments/ledger';
import { decrypt } from '@/lib/whatsapp/encryption';
import { instagramConfig } from './config';
import type { InstagramActor } from './connection';
import { asWorker } from './connection';
import { InstagramError } from './errors';
import { getComment, validCommentReply } from './graph';
import { INSTAGRAM_AI_COMMENTS_JOB } from './jobs';

export const MAX_DAILY_CAP = 500;
const PENDING_PAGE = 25;
const HISTORY_PAGE = 50;
const COMMENT_FETCH_CONCURRENCY = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Failures the routes answer as 409 with a fixed code (the page maps it to Instagram.aiComments.*). */
export class AiCommentError extends Error {
  constructor(readonly code: 'already_decided' | 'ai_not_configured') {
    super(`Instagram AI comments: ${code}`);
    this.name = 'AiCommentError';
  }
}

export interface AiCommentSettings {
  /** An AI provider config exists for the workspace. */
  configured: boolean;
  /** ... and its master switch is on. */
  aiActive: boolean;
  enabled: boolean;
  autoApprove: boolean;
  dailyCap: number;
}

export interface AiCommentItem {
  id: string;
  status: 'pending' | 'approved' | 'rejected' | 'sent' | 'unknown' | 'failed' | 'expired';
  sentiment: 'positive' | 'neutral' | 'negative';
  intent: string | null;
  reply: string;
  autoApproved: boolean;
  errorCode: string | null;
  createdAt: string;
  decidedAt: string | null;
  /** Pending drafts only: the comment as Meta shows it now. */
  comment: { available: boolean; text: string | null; username: string | null } | null;
}

function precheck(actor: InstagramActor, write: boolean): void {
  if (!instagramConfig()) throw new InstagramError('instagram_not_enabled');
  if (write && !hasMinRole(actor.role, 'admin')) throw new InstagramError('forbidden');
}

// ---------------------------------------------------------------- settings

interface SettingsRow { is_active: boolean; enabled: boolean; auto_approve: boolean; daily_cap: number }

async function readSettings(tx: TenantTransaction, accountId: string): Promise<AiCommentSettings> {
  const [row] = await tx.$queryRaw<SettingsRow[]>`SELECT is_active, instagram_ai_comments_enabled AS enabled,
    instagram_ai_comments_auto_approve AS auto_approve, instagram_ai_comments_daily_cap AS daily_cap
    FROM ai_configs WHERE account_id=${accountId}::uuid`;
  return row
    ? { configured: true, aiActive: row.is_active, enabled: row.enabled, autoApprove: row.auto_approve, dailyCap: row.daily_cap }
    : { configured: false, aiActive: false, enabled: false, autoApprove: false, dailyCap: 50 };
}

export async function getAiCommentSettings(actor: InstagramActor): Promise<AiCommentSettings> {
  precheck(actor, false);
  return withTenant(actor, (tx) => readSettings(tx, actor.accountId));
}

export interface AiCommentSettingsPatch { enabled?: boolean; autoApprove?: boolean; dailyCap?: number }

export async function updateAiCommentSettings(actor: InstagramActor, patch: AiCommentSettingsPatch): Promise<AiCommentSettings> {
  precheck(actor, true);
  const { enabled, autoApprove, dailyCap } = patch;
  if (dailyCap !== undefined && (!Number.isInteger(dailyCap) || dailyCap < 1 || dailyCap > MAX_DAILY_CAP)) throw new InstagramError('invalid_request');
  return withTenant(actor, async (tx) => {
    const current = await readSettings(tx, actor.accountId);
    // Drafting needs a working AI setup; switching it off is always allowed.
    if (!current.configured || (enabled === true && !current.aiActive)) throw new AiCommentError('ai_not_configured');
    await tx.$executeRaw`UPDATE ai_configs SET
        instagram_ai_comments_enabled=COALESCE(${enabled ?? null}::boolean, instagram_ai_comments_enabled),
        instagram_ai_comments_auto_approve=COALESCE(${autoApprove ?? null}::boolean, instagram_ai_comments_auto_approve),
        instagram_ai_comments_daily_cap=COALESCE(${dailyCap ?? null}::integer, instagram_ai_comments_daily_cap)
      WHERE account_id=${actor.accountId}::uuid`;
    await auditTx(tx, actor.accountId, actor.userId, 'instagram.ai_comments.settings', actor.accountId, {
      enabled: enabled ?? null, auto_approve: autoApprove ?? null, daily_cap: dailyCap ?? null,
    });
    return readSettings(tx, actor.accountId);
  });
}

// ---------------------------------------------------------------- queue

interface QueueRow {
  id: string;
  instagram_account_id: string;
  comment_id: string;
  status: AiCommentItem['status'];
  sentiment: AiCommentItem['sentiment'];
  intent: string | null;
  reply_text: string;
  auto_approved: boolean;
  error_code: string | null;
  created_at: Date;
  decided_at: Date | null;
}

/** The waiting drafts' comments, read live. One account's token is decrypted once; a failure is "unavailable". */
async function attachComments(accountId: string, rows: QueueRow[]): Promise<Map<string, NonNullable<AiCommentItem['comment']>>> {
  const out = new Map<string, NonNullable<AiCommentItem['comment']>>();
  if (!rows.length) return out;
  const accounts = [...new Set(rows.map((r) => r.instagram_account_id))];
  const tokens = new Map<string, string>();
  const secrets = await asWorker(accountId, (tx) => tx.$queryRaw<{ id: string; access_token_enc: string | null; status: string }[]>(Prisma.sql`
    SELECT id::text AS id, access_token_enc, status FROM instagram_accounts
    WHERE account_id=${accountId}::uuid AND id IN (${Prisma.join(accounts.map((id) => Prisma.sql`${id}::uuid`))})`));
  for (const secret of secrets) {
    if (secret.status !== 'active' || !secret.access_token_enc) continue;
    try {
      tokens.set(secret.id, decrypt(secret.access_token_enc));
    } catch {
      // An unreadable token leaves its comments unavailable.
    }
  }
  const unavailable = { available: false, text: null, username: null };
  for (let i = 0; i < rows.length; i += COMMENT_FETCH_CONCURRENCY) {
    await Promise.all(rows.slice(i, i + COMMENT_FETCH_CONCURRENCY).map(async (row) => {
      const token = tokens.get(row.instagram_account_id);
      if (!token) { out.set(row.id, unavailable); return; }
      try {
        const comment = await getComment(row.comment_id, token);
        out.set(row.id, comment.hidden === true || !comment.text
          ? unavailable : { available: true, text: comment.text, username: comment.username });
      } catch {
        out.set(row.id, unavailable);
      }
    }));
  }
  return out;
}

export async function listAiComments(actor: InstagramActor, view: 'pending' | 'history'): Promise<AiCommentItem[]> {
  precheck(actor, false);
  const rows = await withTenant(actor, (tx) => view === 'pending'
    ? tx.$queryRaw<QueueRow[]>`SELECT id::text AS id, instagram_account_id::text AS instagram_account_id, comment_id, status, sentiment, intent,
        reply_text, auto_approved, error_code, created_at, decided_at FROM instagram_ai_comment_queue
      WHERE account_id=${actor.accountId}::uuid AND status='pending' ORDER BY created_at ASC, id LIMIT ${PENDING_PAGE}`
    // Comments the AI skipped (expired with an error code) are not history: nothing was drafted.
    : tx.$queryRaw<QueueRow[]>`SELECT id::text AS id, instagram_account_id::text AS instagram_account_id, comment_id, status, sentiment, intent,
        reply_text, auto_approved, error_code, created_at, decided_at FROM instagram_ai_comment_queue
      WHERE account_id=${actor.accountId}::uuid AND status<>'pending' AND NOT (status='expired' AND error_code IS NOT NULL)
      ORDER BY updated_at DESC, id LIMIT ${HISTORY_PAGE}`);
  const comments = view === 'pending' ? await attachComments(actor.accountId, rows) : new Map();
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    sentiment: row.sentiment,
    intent: row.intent,
    reply: row.reply_text,
    autoApproved: row.auto_approved,
    errorCode: row.error_code,
    createdAt: new Date(row.created_at).toISOString(),
    decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : null,
    comment: comments.get(row.id) ?? null,
  }));
}

export type AiCommentDecision = { decision: 'approve'; replyText?: string } | { decision: 'reject' };

/** Decides a pending draft as the admin. Returns the new status. */
export async function decideAiComment(actor: InstagramActor, id: string, input: AiCommentDecision): Promise<'approved' | 'rejected'> {
  precheck(actor, true);
  if (!UUID.test(id)) throw new InstagramError('not_found');
  const edited = input.decision === 'approve' && input.replyText !== undefined;
  const replyText = input.decision === 'approve' ? input.replyText?.trim() : undefined;
  if (input.decision === 'approve' && replyText !== undefined && !validCommentReply(replyText)) throw new InstagramError('invalid_request');
  const status = input.decision === 'approve' ? 'approved' : 'rejected';
  await withTenant(actor, async (tx) => {
    // The RLS policy admits only a pending row, decided by this user; the guard trigger holds the rest.
    const changed = await tx.$executeRaw`UPDATE instagram_ai_comment_queue
      SET status=${status}, reply_text=COALESCE(${replyText ?? null}::text, reply_text), decided_by=${actor.userId}::uuid, decided_at=now()
      WHERE account_id=${actor.accountId}::uuid AND id=${id}::uuid AND status='pending'`;
    if (changed === 0) {
      const [row] = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM instagram_ai_comment_queue
        WHERE account_id=${actor.accountId}::uuid AND id=${id}::uuid`;
      throw row ? new AiCommentError('already_decided') : new InstagramError('not_found');
    }
    // Queued in the same transaction as the approval: the page never says "approved" for a reply nobody will post.
    if (status === 'approved') await enqueueJobTx(tx, actor.accountId, INSTAGRAM_AI_COMMENTS_JOB, {}, `igai:approve:${actor.accountId}:${id}`);
    await auditTx(tx, actor.accountId, actor.userId, `instagram.ai_comment.${input.decision}`, id, { edited });
  });
  return status;
}
