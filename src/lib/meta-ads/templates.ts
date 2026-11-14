// Saved ad setups (ads phase 3): an admin saves the Create ad form (goal,
// budget, audience, text, placements, targeting) under a name and starts the
// next ad from it. The settings are the form's own values, kept as JSON (at
// most 16 KB) and only ever filled back into the form, where Create ad
// validates them again; nothing here reaches Meta. Members read; admins write
// through the worker role.

import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { hasMinRole } from '@/lib/auth/roles';
import { MetaAdsError, type MetaAdsActor } from './connection';

export const MAX_TEMPLATES = 50;
const MAX_SETTINGS_BYTES = 16_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AdTemplateDto { id: string; name: string; settings: Record<string, unknown>; createdAt: string }
interface Row { id: string; name: string; settings: Record<string, unknown>; created_at: Date }
const dto = (r: Row): AdTemplateDto => ({ id: r.id, name: r.name, settings: r.settings, createdAt: r.created_at.toISOString() });

const worker = <T>(actor: MetaAdsActor, work: Parameters<typeof withTenant<T>>[1]) =>
  withTenant({ accountId: actor.accountId, userId: actor.userId, role: 'owner' }, work, getWorkerPrisma());

function requireAdmin(actor: MetaAdsActor): void {
  if (!hasMinRole(actor.role, 'admin')) throw new MetaAdsError('forbidden');
}

export function parseTemplateInput(body: unknown): { name: string; settings: Record<string, unknown> } | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.trim().replace(/\s+/g, ' ') : '';
  const settings = b.settings;
  if (name.length < 1 || name.length > 100) return null;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return null;
  if (Buffer.byteLength(JSON.stringify(settings), 'utf8') > MAX_SETTINGS_BYTES) return null;
  return { name, settings: settings as Record<string, unknown> };
}

export async function listAdTemplates(actor: MetaAdsActor): Promise<AdTemplateDto[]> {
  return withTenant({ accountId: actor.accountId, userId: actor.userId, role: actor.role }, async (tx) => (await tx.$queryRaw<Row[]>`
    SELECT id::text AS id, name, settings, created_at FROM meta_ad_templates
    WHERE account_id=${actor.accountId}::uuid ORDER BY lower(name) LIMIT ${MAX_TEMPLATES}`).map(dto));
}

export async function saveAdTemplate(actor: MetaAdsActor, input: { name: string; settings: Record<string, unknown> }): Promise<AdTemplateDto> {
  requireAdmin(actor);
  return worker(actor, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ad-templates:${actor.accountId}`}))`;
    const [count] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM meta_ad_templates WHERE account_id=${actor.accountId}::uuid`;
    if ((count?.n ?? 0) >= MAX_TEMPLATES) throw new MetaAdsError('limit_reached');
    const [taken] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM meta_ad_templates
      WHERE account_id=${actor.accountId}::uuid AND lower(name)=lower(${input.name})`;
    if (taken?.n) throw new MetaAdsError('name_taken');
    const [row] = await tx.$queryRaw<Row[]>`INSERT INTO meta_ad_templates(account_id, name, settings, created_by)
      VALUES(${actor.accountId}::uuid, ${input.name}, ${JSON.stringify(input.settings)}::jsonb, ${actor.userId}::uuid)
      RETURNING id::text AS id, name, settings, created_at`;
    await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
      VALUES(${actor.accountId}::uuid,${actor.userId}::uuid,'meta_ads.template_save',${row.id},'{}'::jsonb)`;
    return dto(row);
  });
}

export async function deleteAdTemplate(actor: MetaAdsActor, id: string): Promise<void> {
  requireAdmin(actor);
  if (!UUID.test(id)) throw new MetaAdsError('invalid_request');
  await worker(actor, async (tx) => {
    const removed = await tx.$executeRaw`DELETE FROM meta_ad_templates WHERE account_id=${actor.accountId}::uuid AND id=${id}::uuid`;
    if (!removed) throw new MetaAdsError('not_found');
    await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
      VALUES(${actor.accountId}::uuid,${actor.userId}::uuid,'meta_ads.template_delete',${id},'{}'::jsonb)`;
  });
}
