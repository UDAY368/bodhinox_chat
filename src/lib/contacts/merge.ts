// Contact merge (batch 7). An admin or owner picks the contact to keep; the
// other is merged into it in ONE transaction by crm_merge_contacts
// (prisma/migrations/20261207020000_contact_merge): both contacts are locked
// in id order, every row that points at the merged contact moves (unique
// clashes resolved, WhatsApp conversations on the same number folded into
// one), blank fields are filled, the stricter consent wins, the merged
// contact is deleted and one audit row is written. Runs on the app role inside
// the caller's tenant transaction; the function reads the workspace and role
// from the tenant settings, never from an argument.
import { Prisma } from '@prisma/client';
import { hasMinRole, type AccountRole } from '@/lib/auth/roles';
import { withTenant } from '@/lib/db/tenant';

export type MergeErrorCode =
  | 'forbidden' | 'not_found' | 'invalid_request' | 'phone_conflict' | 'identity_conflict' | 'contact_busy';

const STATUS: Record<MergeErrorCode, number> = {
  forbidden: 403, not_found: 404, invalid_request: 400, phone_conflict: 409, identity_conflict: 409, contact_busy: 409,
};

export class MergeError extends Error {
  readonly status: number;
  constructor(readonly code: MergeErrorCode) {
    super(`Contact merge: ${code}`);
    this.name = 'MergeError';
    this.status = STATUS[code];
  }
}

export interface MergeActor {
  accountId: string;
  userId: string;
  role: AccountRole;
}

/** What moves from the merged contact to the kept one (counts only). */
export interface MergeCounts {
  conversations: number;
  messages: number;
  tags: number;
  notes: number;
  orders: number;
  deals: number;
  appointments: number;
  payments: number;
  formAnswers: number;
  sequences: number;
  customValues: number;
  identities: number;
  lists: number;
  tasks: number;
  /** WhatsApp conversations folded into the kept contact's conversation on the same number. */
  combinedConversations: number;
}

const COUNT_KEYS: (keyof MergeCounts)[] = ['conversations', 'messages', 'tags', 'notes', 'orders', 'deals', 'appointments',
  'payments', 'formAnswers', 'sequences', 'customValues', 'identities', 'lists', 'tasks', 'combinedConversations'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFUSALS = new Set<MergeErrorCode>(['not_found', 'invalid_request', 'phone_conflict', 'identity_conflict', 'contact_busy']);

function counts(raw: unknown): MergeCounts {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return Object.fromEntries(COUNT_KEYS.map((key) => [key, Number(source[key] ?? 0)])) as unknown as MergeCounts;
}

async function run(actor: MergeActor, keepId: string, mergedId: string, apply: boolean): Promise<MergeCounts> {
  if (!hasMinRole(actor.role, 'admin')) throw new MergeError('forbidden');
  if (typeof keepId !== 'string' || typeof mergedId !== 'string' || !UUID.test(keepId) || !UUID.test(mergedId))
    throw new MergeError('not_found');
  if (keepId.toLowerCase() === mergedId.toLowerCase()) throw new MergeError('invalid_request');
  // A long conversation moves many messages; give it more than the default 30 s.
  const result = await withTenant({ accountId: actor.accountId, userId: actor.userId, role: actor.role }, async (tx) => {
    const [row] = await tx.$queryRaw<{ result: { error?: string; counts?: unknown } }[]>(Prisma.sql`
      SELECT crm_merge_contacts(${keepId}::uuid, ${mergedId}::uuid, ${apply}) AS result`);
    return row.result;
  }, undefined, { timeoutMs: 120_000 });
  if (result.error) {
    const code = result.error as MergeErrorCode;
    throw new MergeError(REFUSALS.has(code) ? code : 'invalid_request');
  }
  return counts(result.counts);
}

/** Checks the merge and counts what would move; changes nothing. */
export function previewMerge(actor: MergeActor, keepId: string, mergedId: string): Promise<MergeCounts> {
  return run(actor, keepId, mergedId, false);
}

/** Merges `mergedId` into `keepId` (admin/owner). Returns what moved. */
export function mergeContacts(actor: MergeActor, keepId: string, mergedId: string): Promise<MergeCounts> {
  return run(actor, keepId, mergedId, true);
}
