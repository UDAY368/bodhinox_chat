// Automation folders (Stage 5, 5F): one folder list per channel section.
// Agents and above (who edit flows) create, rename and delete folders and file
// flows in them; every member reads them. Deleting a folder keeps its flows:
// the foreign key moves them back to the top level. A flow may only be filed
// in a folder of its own workspace (composite foreign key) and its own channel
// (checked here; a legacy flow that runs on both channels fits either).
// Runs as the app role inside withTenant: FORCE RLS keeps every query to the
// caller's workspace, so another workspace's folder or flow reads as missing.
import { NextResponse } from 'next/server';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import type { Channel } from '@/types';

export const FOLDER_LIMIT = 100;
export const FOLDER_NAME_MAX = 60;

export interface FlowFolder {
  id: string;
  channel: Channel;
  name: string;
  created_at: string;
  flow_count: number;
}

export type FolderErrorCode = 'invalid_name' | 'name_taken' | 'limit_reached' | 'not_found' | 'flow_not_found' | 'wrong_channel';

export class FolderError extends Error {
  constructor(public readonly code: FolderErrorCode) {
    super(code);
    this.name = 'FolderError';
  }
}

const STATUS: Record<FolderErrorCode, number> = {
  invalid_name: 422, name_taken: 409, limit_reached: 422, not_found: 404, flow_not_found: 404, wrong_channel: 422,
};
const KEY: Record<FolderErrorCode, string> = {
  invalid_name: 'nameInvalid', name_taken: 'nameTaken', limit_reached: 'limitReached', not_found: 'notFound',
  flow_not_found: 'notFound', wrong_channel: 'wrongChannel',
};

export function folderErrorResponse(error: unknown): NextResponse | null {
  if (!(error instanceof FolderError)) return null;
  const t = getT('Flows.folders');
  return NextResponse.json({ error: t(KEY[error.code]), code: error.code },
    { status: STATUS[error.code], headers: { 'Cache-Control': 'no-store' } });
}

/** A trimmed, single-spaced name of 1–60 characters, or null. */
export function normaliseFolderName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/\s+/g, ' ');
  return name.length >= 1 && name.length <= FOLDER_NAME_MAX ? name : null;
}

const isUniqueViolation = (error: unknown) =>
  !!error && typeof error === 'object' && /unique|duplicate|23505/i.test(String((error as { message?: unknown }).message ?? '') + String((error as { code?: unknown }).code ?? ''));

async function mapUnique<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (error) {
    if (isUniqueViolation(error)) throw new FolderError('name_taken');
    throw error;
  }
}

export async function listFolders(context: TenantContext, channel: Channel): Promise<FlowFolder[]> {
  return withTenant(context, (tx) => tx.$queryRaw<FlowFolder[]>`
    SELECT f.id::text, f.channel, f.name, f.created_at::text AS created_at,
      (SELECT count(*)::int FROM flows x WHERE x.account_id=f.account_id AND x.folder_id=f.id) AS flow_count
    FROM flow_folders f WHERE f.account_id=${context.accountId}::uuid AND f.channel=${channel}
    ORDER BY lower(f.name)`);
}

export async function createFolder(context: TenantContext, channel: Channel, rawName: unknown): Promise<FlowFolder> {
  const name = normaliseFolderName(rawName);
  if (!name) throw new FolderError('invalid_name');
  return mapUnique(() => withTenant(context, async (tx) => {
    const [{ count }] = await tx.$queryRaw<{ count: number }[]>`SELECT count(*)::int AS count FROM flow_folders
      WHERE account_id=${context.accountId}::uuid AND channel=${channel}`;
    if (count >= FOLDER_LIMIT) throw new FolderError('limit_reached');
    const [row] = await tx.$queryRaw<FlowFolder[]>`INSERT INTO flow_folders(account_id,channel,name,created_by)
      VALUES(${context.accountId}::uuid,${channel},${name},${context.userId ?? null}::uuid)
      RETURNING id::text, channel, name, created_at::text AS created_at, 0 AS flow_count`;
    return row;
  }));
}

export async function renameFolder(context: TenantContext, id: string, rawName: unknown): Promise<void> {
  const name = normaliseFolderName(rawName);
  if (!name) throw new FolderError('invalid_name');
  const changed = await mapUnique(() => withTenant(context, (tx) => tx.$executeRaw`
    UPDATE flow_folders SET name=${name} WHERE account_id=${context.accountId}::uuid AND id=${id}::uuid`));
  if (changed === 0) throw new FolderError('not_found');
}

/** Deletes the folder; its flows move to the top level (ON DELETE SET NULL). */
export async function deleteFolder(context: TenantContext, id: string): Promise<void> {
  const deleted = await withTenant(context, (tx) => tx.$executeRaw`
    DELETE FROM flow_folders WHERE account_id=${context.accountId}::uuid AND id=${id}::uuid`);
  if (deleted === 0) throw new FolderError('not_found');
}

/** Files a flow in a folder of its channel, or at the top level (null). */
export async function moveFlowToFolder(context: TenantContext, flowId: string, folderId: string | null): Promise<void> {
  await withTenant(context, async (tx) => {
    const [flow] = await tx.$queryRaw<{ channel_scope: string | null }[]>`SELECT channel_scope FROM flows
      WHERE account_id=${context.accountId}::uuid AND id=${flowId}::uuid FOR UPDATE`;
    if (!flow) throw new FolderError('flow_not_found');
    if (folderId !== null) {
      const [folder] = await tx.$queryRaw<{ channel: string }[]>`SELECT channel FROM flow_folders
        WHERE account_id=${context.accountId}::uuid AND id=${folderId}::uuid`;
      if (!folder) throw new FolderError('not_found');
      const scope = flow.channel_scope ?? 'whatsapp';
      if (scope !== 'any' && scope !== folder.channel) throw new FolderError('wrong_channel');
    }
    const changed = await tx.$executeRaw`UPDATE flows SET folder_id=${folderId}::uuid
      WHERE account_id=${context.accountId}::uuid AND id=${flowId}::uuid`;
    if (changed === 0) throw new FolderError('flow_not_found');
  });
}
