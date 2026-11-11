// Stage 5 (5D): timed pause of automated replies.
//
//   conversations.bot_paused        automated replies are paused
//   conversations.bot_paused_until  NULL: until someone resumes them (the
//                                   behaviour before Stage 5); a time: the
//                                   pause ends then, and an expired pause
//                                   reads as not paused (pauseActive) and is
//                                   cleared on the next write (clearExpiredPause)
//   conversations.bot_paused_by     the member who paused (null: a flow, an
//                                   automation, or a path that predates Stage 5)
//
// The trigger conversations_pause_reset (20261118300000) turns any write of
// bot_paused=true that does not come from this module into "until resumed",
// and clears the time and author on resume. The writers here mark their
// transaction with app.pause_explicit so the trigger keeps what they set.
import { Prisma } from '@prisma/client';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { PAUSE_MINUTES_CHOICES } from '@/lib/flows/types';
import { pauseEndsAt } from './pause-state';

/** Which conversations a pause covers: one conversation, or every conversation of a contact. */
export type PauseTarget = { conversationId: string; contactId?: never } | { contactId: string; conversationId?: never };

export type PauseInput = PauseTarget & {
  /** One of PAUSE_MINUTES_CHOICES (src/lib/flows/types.ts); null pauses until resumed. */
  minutes: number | null;
  /** The member who paused (null for a flow or automation). */
  byUserId: string | null;
};

export type ResumeInput = PauseTarget & { byUserId: string | null };

export class AutomationPauseError extends Error {
  constructor(readonly code: 'invalid_pause') {
    super(code);
    this.name = 'AutomationPauseError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A pause length the pause control and the Actions step offer (30 minutes to 1 day, or until resumed). */
export function isPauseChoice(minutes: unknown): minutes is number | null {
  return (PAUSE_MINUTES_CHOICES as readonly unknown[]).includes(minutes);
}

export { pauseActive, pauseEndsAt, type PauseRow } from './pause-state';

/** Marks the transaction as a 5D pause writer, so conversations_pause_reset keeps its until and author. */
export async function markExplicitPause(tx: TenantTransaction): Promise<void> {
  await tx.$queryRaw`SELECT set_config('app.pause_explicit', 'on', true)`;
}

function targetSql(accountId: string, target: PauseTarget): Prisma.Sql {
  if (target.conversationId !== undefined) {
    if (!UUID.test(target.conversationId)) throw new AutomationPauseError('invalid_pause');
    return Prisma.sql`account_id=${accountId}::uuid AND id=${target.conversationId}::uuid`;
  }
  if (typeof target.contactId !== 'string' || !UUID.test(target.contactId)) throw new AutomationPauseError('invalid_pause');
  return Prisma.sql`account_id=${accountId}::uuid AND contact_id=${target.contactId}::uuid`;
}

const run = <T>(accountId: string, op: (tx: TenantTransaction) => Promise<T>, tx?: TenantTransaction): Promise<T> =>
  tx ? op(tx) : withTenant({ accountId, role: 'owner' }, op, getWorkerPrisma());

/**
 * Pauses automated replies for one conversation or all of a contact's
 * conversations, for `minutes` (a PAUSE_MINUTES_CHOICES value) or until
 * resumed, recording who paused. Tenant-scoped by account id; returns how many
 * conversations it paused (0 when the target is not this workspace's).
 */
export async function pauseAutomations(accountId: string, input: PauseInput, tx?: TenantTransaction): Promise<number> {
  if (!isPauseChoice(input.minutes)) throw new AutomationPauseError('invalid_pause');
  if (input.byUserId !== null && !UUID.test(input.byUserId)) throw new AutomationPauseError('invalid_pause');
  const where = targetSql(accountId, input);
  const until = pauseEndsAt(input.minutes);
  return run(accountId, async (t) => {
    await markExplicitPause(t);
    return t.$executeRaw(Prisma.sql`UPDATE conversations SET bot_paused=true, bot_paused_until=${until}::timestamptz,
      bot_paused_by=${input.byUserId}::uuid, updated_at=now() WHERE ${where}`);
  }, tx);
}

/**
 * Resumes automated replies (and the AI auto-reply, as the inbox's resume
 * button always did). Returns how many conversations it touched.
 */
export async function resumeAutomations(accountId: string, input: ResumeInput, tx?: TenantTransaction): Promise<number> {
  const where = targetSql(accountId, input);
  return run(accountId, (t) => t.$executeRaw(Prisma.sql`UPDATE conversations SET bot_paused=false, ai_autoreply_disabled=false,
    bot_paused_until=NULL, bot_paused_by=NULL, updated_at=now() WHERE ${where}`), tx);
}

/**
 * Clears a pause whose time has passed, so code that reads bot_paused directly
 * sees it resumed. Idempotent; a pause that is still running, or one until
 * resumed, is untouched. Returns whether it cleared one.
 */
export async function clearExpiredPause(accountId: string, conversationId: string, tx?: TenantTransaction): Promise<boolean> {
  const cleared = await run(accountId, (t) => t.$executeRaw`UPDATE conversations SET bot_paused=false, updated_at=now()
    WHERE account_id=${accountId}::uuid AND id=${conversationId}::uuid AND bot_paused
      AND bot_paused_until IS NOT NULL AND bot_paused_until <= now()`, tx);
  return cleared > 0;
}

/**
 * The agent stepping in, inside the send's own transaction: automated replies
 * pause for the workspace's agent_reply_pause_minutes, or until resumed when
 * that is unset (the behaviour before Stage 5). A pause until resumed that is
 * already in place stays so, and a running timed pause is never shortened.
 */
export async function pauseForAgentReply(tx: TenantTransaction, accountId: string, conversationId: string,
  userId: string | null): Promise<void> {
  await markExplicitPause(tx);
  await tx.$executeRaw`UPDATE conversations c SET bot_paused=true,
      bot_paused_until=CASE
        WHEN c.bot_paused AND c.bot_paused_until IS NULL THEN NULL
        ELSE (SELECT CASE WHEN s.agent_reply_pause_minutes IS NULL THEN NULL
          ELSE GREATEST(now() + make_interval(mins => s.agent_reply_pause_minutes),
            CASE WHEN c.bot_paused THEN c.bot_paused_until END) END
          FROM (SELECT (SELECT agent_reply_pause_minutes FROM workspace_inbox_settings
            WHERE account_id=${accountId}::uuid) AS agent_reply_pause_minutes) s)
      END,
      bot_paused_by=CASE WHEN c.bot_paused AND c.bot_paused_until IS NULL THEN c.bot_paused_by ELSE ${userId}::uuid END,
      updated_at=now()
    WHERE c.account_id=${accountId}::uuid AND c.id=${conversationId}::uuid`;
}

/** A POST /api/inbox/pause body after validation. */
export interface PauseRequest {
  conversationId: string;
  action: 'pause' | 'resume';
  minutes: number | null;
  scope: 'conversation' | 'contact';
}

/** Validates a POST /api/inbox/pause body; null when anything is off. Pure. */
export function parsePauseRequest(body: unknown): PauseRequest | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const input = body as Record<string, unknown>;
  const conversationId = input.conversation_id;
  const action = input.action;
  const minutes = input.minutes === undefined ? null : input.minutes;
  const scope = input.scope === undefined ? 'conversation' : input.scope;
  if (typeof conversationId !== 'string' || !UUID.test(conversationId)) return null;
  if (action !== 'pause' && action !== 'resume') return null;
  if (scope !== 'conversation' && scope !== 'contact') return null;
  if (action === 'pause' && !isPauseChoice(minutes)) return null;
  return { conversationId, action, minutes: action === 'pause' ? (minutes as number | null) : null, scope };
}

/** pauseForAgentReply in its own worker transaction, for send paths without one. */
export async function pauseForAgentReplyNow(accountId: string, conversationId: string, userId: string | null): Promise<void> {
  await withTenant({ accountId, role: 'owner' }, (tx) => pauseForAgentReply(tx, accountId, conversationId, userId), getWorkerPrisma());
}
