// ============================================================
// Contact CSV export — all contacts or one segment, with tags,
// custom fields and consent. Every export is audit-logged (row count
// only, never contents).
// ============================================================

import { Prisma } from '@prisma/client';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { AudienceFilterError, compileAudienceFilter } from './filter';
import { loadSegmentFilter } from './segments';

// shortcut: built in memory; switch to a streamed or emailed export if workspaces outgrow this cap.
export const MAX_EXPORT_ROWS = 50_000;

/** Quote a CSV cell and neutralise spreadsheet formulas (=, +, -, @, tab, CR). */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

type Row = {
  name: string | null; phone: string; email: string | null; company: string | null;
  opted_out_at: Date | null; blocked_at: Date | null; created_at: Date | null;
  tags: string; custom: Record<string, string | null>;
};

export async function exportContactsCsv(ctx: TenantContext, segmentId: string | null): Promise<{ csv: string; rows: number }> {
  return withTenant(ctx, async (tx) => {
    const where = segmentId
      ? compileAudienceFilter(ctx.accountId, await loadSegmentFilter(tx, ctx.accountId, segmentId))
      : Prisma.sql`c.account_id=${ctx.accountId}::uuid`;
    const [{ count }] = await tx.$queryRaw<{ count: number }[]>(Prisma.sql`SELECT count(*)::int AS count FROM contacts c WHERE ${where}`);
    if (count > MAX_EXPORT_ROWS)
      throw new AudienceFilterError(`Exports are limited to ${MAX_EXPORT_ROWS.toLocaleString('en')} contacts; export a narrower segment`);

    const fields = await tx.$queryRaw<{ id: string; field_name: string }[]>`
      SELECT id::text, field_name FROM custom_fields WHERE account_id=${ctx.accountId}::uuid ORDER BY field_name, id`;
    const rows = await tx.$queryRaw<Row[]>(Prisma.sql`
      SELECT c.name, c.phone, c.email, c.company, c.opted_out_at, c.blocked_at, c.created_at,
        COALESCE((SELECT string_agg(t.name, '; ' ORDER BY t.name) FROM contact_tags ct JOIN tags t ON t.id=ct.tag_id
          WHERE ct.account_id=${ctx.accountId}::uuid AND ct.contact_id=c.id), '') AS tags,
        COALESCE((SELECT jsonb_object_agg(v.custom_field_id::text, v.value) FROM contact_custom_values v
          WHERE v.account_id=${ctx.accountId}::uuid AND v.contact_id=c.id), '{}'::jsonb) AS custom
      FROM contacts c WHERE ${where} ORDER BY c.created_at, c.id`);

    await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
      VALUES(${ctx.accountId}::uuid,${ctx.userId}::uuid,'contacts.export',${segmentId},${JSON.stringify({ rows: rows.length })}::jsonb)`;

    const header = ['Name', 'Phone', 'Email', 'Company', 'Tags', 'Opted out at', 'Blocked at', 'Created at', ...fields.map((f) => f.field_name)];
    const lines = rows.map((r) =>
      [r.name, r.phone, r.email, r.company, r.tags, r.opted_out_at, r.blocked_at, r.created_at, ...fields.map((f) => r.custom[f.id])]
        .map(csvCell)
        .join(','),
    );
    // BOM so spreadsheet apps read UTF-8 names correctly.
    return { csv: `﻿${[header.map(csvCell).join(','), ...lines].join('\r\n')}\r\n`, rows: rows.length };
  });
}
