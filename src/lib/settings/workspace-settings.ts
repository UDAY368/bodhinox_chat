/**
 * Settings › Workspace: the workspace name and default language (accounts).
 * Time zone and working hours stay in workspace_inbox_settings and are saved
 * through /api/inbox/settings; this module never duplicates them.
 *
 * Any member reads; owners and admins write (RLS: accounts.tenant_update needs
 * admin). Every change is audited as settings.workspace with field names only.
 */
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { isAppLocale, type AppLocale } from '@/lib/i18n/locales';

export const WORKSPACE_NAME_MAX = 80;

export interface WorkspaceSettings {
  name: string;
  default_language: AppLocale | null;
}

export class WorkspaceSettingsError extends Error {
  constructor(public readonly code: 'name_required' | 'name_too_long' | 'invalid_language' | 'invalid_body') {
    super(code);
    this.name = 'WorkspaceSettingsError';
  }
}

/** Validate a PUT body: { name?, default_language? }; unknown keys are rejected. */
export function parseWorkspaceUpdate(body: unknown): Partial<WorkspaceSettings> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new WorkspaceSettingsError('invalid_body');
  const { name, default_language, ...rest } = body as Record<string, unknown>;
  if (Object.keys(rest).length || (name === undefined && default_language === undefined)) throw new WorkspaceSettingsError('invalid_body');
  const update: Partial<WorkspaceSettings> = {};
  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) throw new WorkspaceSettingsError('name_required');
    const trimmed = name.trim();
    if (trimmed.length > WORKSPACE_NAME_MAX) throw new WorkspaceSettingsError('name_too_long');
    update.name = trimmed;
  }
  if (default_language !== undefined) {
    if (default_language !== null && !isAppLocale(default_language)) throw new WorkspaceSettingsError('invalid_language');
    update.default_language = default_language;
  }
  return update;
}

type Row = { name: string; default_language: string | null };
const toSettings = (row: Row): WorkspaceSettings => ({
  name: row.name,
  default_language: isAppLocale(row.default_language) ? row.default_language : null,
});

export async function getWorkspaceSettings(tenant: TenantContext): Promise<WorkspaceSettings> {
  const rows = await withTenant(tenant, (tx) => tx.$queryRaw<Row[]>`
    SELECT name, default_language FROM accounts WHERE id=${tenant.accountId}::uuid`);
  if (!rows[0]) throw new Error('Workspace not found');
  return toSettings(rows[0]);
}

export async function saveWorkspaceSettings(tenant: TenantContext, update: Partial<WorkspaceSettings>): Promise<WorkspaceSettings> {
  return withTenant(tenant, async (tx) => {
    const rows = await tx.$queryRaw<Row[]>`
      UPDATE accounts SET
        name = CASE WHEN ${update.name !== undefined} THEN ${update.name ?? ''} ELSE name END,
        default_language = CASE WHEN ${update.default_language !== undefined} THEN ${update.default_language ?? null}::text ELSE default_language END,
        updated_at = now()
      WHERE id=${tenant.accountId}::uuid
      RETURNING name, default_language`;
    if (!rows[0]) throw new Error('Workspace not updated');
    await tx.$executeRaw`
      INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
      VALUES(${tenant.accountId}::uuid,${tenant.userId ?? null}::uuid,'settings.workspace',${tenant.accountId},
        ${JSON.stringify({ name_changed: update.name !== undefined, language_changed: update.default_language !== undefined })}::jsonb)`;
    return toSettings(rows[0]);
  });
}
