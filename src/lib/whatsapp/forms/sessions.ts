/**
 * Form sessions: one row per form send. The flow token is a random,
 * single-use value Meta echoes back with the customer's submission, so a
 * reply can be tied to its form, contact and (optionally) waiting flow run.
 * Every query runs inside the caller's tenant transaction (RLS scopes it).
 */

import { randomBytes } from 'node:crypto';
import type { TenantTransaction } from '@/lib/db/tenant';

/** 32 random bytes as base64url: 43 characters, matching the table CHECK. */
export function newFlowToken(): string {
  return randomBytes(32).toString('base64url');
}

const TOKEN = /^[A-Za-z0-9_-]{43,200}$/;

/** Shape check before a token reaches the database. */
export function isFlowToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN.test(value);
}

/** Default lifetime of a sent form: a customer may open it later the same week. */
export const FORM_SESSION_TTL_HOURS = 72;

export interface CreateFormSessionInput {
  accountId: string;
  formId: string;
  contactId?: string | null;
  conversationId?: string | null;
  flowRunId?: string | null;
  nodeKey?: string | null;
  /** 1 hour - 30 days. */
  ttlHours: number;
}

export async function createFormSession(
  tx: TenantTransaction,
  input: CreateFormSessionInput,
): Promise<{ flowToken: string; sessionId: string; expiresAt: Date }> {
  const hours = Math.min(Math.max(Math.round(input.ttlHours), 1), 720);
  const expiresAt = new Date(Date.now() + hours * 3_600_000);
  const flowToken = newFlowToken();
  const rows = await tx.$queryRaw<{ id: string }[]>`INSERT INTO whatsapp_form_sessions(account_id,flow_token,form_id,
      contact_id,conversation_id,flow_run_id,node_key,expires_at)
    VALUES(${input.accountId}::uuid,${flowToken},${input.formId}::uuid,${input.contactId ?? null}::uuid,
      ${input.conversationId ?? null}::uuid,${input.flowRunId ?? null}::uuid,${input.nodeKey ?? null},${expiresAt})
    RETURNING id`;
  if (!rows.length) throw new Error('Form session could not be created');
  return { flowToken, sessionId: rows[0].id, expiresAt };
}

export interface FormSessionRow {
  id: string;
  form_id: string;
  contact_id: string | null;
  conversation_id: string | null;
  flow_run_id: string | null;
  node_key: string | null;
  expires_at: Date;
  completed_at: Date | null;
}

/**
 * The account's session for a token, or null (unknown, malformed or another
 * account's). `forUpdate` locks the row until the transaction ends, so two
 * submissions on one session are recorded one after the other.
 */
export async function findSessionByToken(
  tx: TenantTransaction,
  accountId: string,
  flowToken: string,
  options: { forUpdate?: boolean } = {},
): Promise<FormSessionRow | null> {
  if (!isFlowToken(flowToken)) return null;
  const rows = options.forUpdate
    ? await tx.$queryRaw<FormSessionRow[]>`SELECT id,form_id,contact_id,conversation_id,flow_run_id,node_key,
        expires_at,completed_at
      FROM whatsapp_form_sessions WHERE account_id=${accountId}::uuid AND flow_token=${flowToken} FOR UPDATE`
    : await tx.$queryRaw<FormSessionRow[]>`SELECT id,form_id,contact_id,conversation_id,flow_run_id,node_key,
        expires_at,completed_at
      FROM whatsapp_form_sessions WHERE account_id=${accountId}::uuid AND flow_token=${flowToken}`;
  return rows[0] ?? null;
}

/**
 * Marks a session completed once; true only for the first completion. The
 * forms data endpoint may already have completed it before the submission
 * message arrives, so callers do not read trust from this result.
 */
export async function completeFormSession(tx: TenantTransaction, accountId: string, sessionId: string): Promise<boolean> {
  const updated = await tx.$executeRaw`UPDATE whatsapp_form_sessions SET completed_at=NOW()
    WHERE account_id=${accountId}::uuid AND id=${sessionId}::uuid AND completed_at IS NULL`;
  return updated === 1;
}
