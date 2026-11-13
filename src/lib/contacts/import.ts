// ============================================================
// CSV import, one batch per request. The browser parses the file and
// normalises numbers; this inserts new contacts with ON CONFLICT on the
// (account_id, phone_normalized) unique index, so a duplicate never fails
// the batch, and optionally updates contacts that already exist. Runs in
// the caller's tenant transaction on the app role (RLS: agent and above).
// ============================================================

import { z } from 'zod';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { ForbiddenError } from '@/lib/auth/errors';
import { AudienceFilterError } from '@/lib/audience/filter';
import { requireContactRoom } from '@/lib/billing/limits';
import { loadPhoneMask, PHONE_MASKED_MESSAGE } from '@/lib/inbox/masking-apply';
import { MAX_CUSTOM_VALUE, normalizeFieldValue } from './custom-field-types';

export const IMPORT_BATCH_SIZE = 200;

const optionalText = (max: number) =>
  z.string().trim().max(max).optional().transform((v) => v || null);

/** An opt-out or block carried over from the file (our export's columns); never in the future. */
const consentAt = z.string().datetime({ offset: true }).optional()
  .refine((v) => !v || Date.parse(v) <= Date.now() + 60_000, 'A date in the file is in the future')
  .transform((v) => v ?? null);

const rowSchema = z.object({
  /** Digits only, country code first (the browser's parseImportPhone result). */
  phone: z.string().regex(/^[1-9]\d{7,14}$/, 'Invalid phone number'),
  name: optionalText(200),
  email: optionalText(320),
  company: optionalText(200),
  city: optionalText(200),
  tagIds: z.array(z.string().uuid()).max(50).default([]),
  /** Contacts redesign: custom field values by field id, from the import's column matching. */
  customValues: z.record(z.string().uuid(), z.string().max(MAX_CUSTOM_VALUE)).default({})
    .refine((v) => Object.keys(v).length <= 50, 'Too many custom fields in one row'),
  /** Set only: an import never clears an opt-out or a block. */
  optedOutAt: consentAt,
  blockedAt: consentAt,
}).strict();

const batchSchema = z.object({
  rows: z.array(rowSchema).min(1).max(IMPORT_BATCH_SIZE),
  updateExisting: z.boolean().default(false),
}).strict();

export type ImportBatchInput = z.input<typeof batchSchema>;

export interface ImportBatchResult {
  /** New contacts created. */
  imported: number;
  /** Existing contacts whose name, email, company, opt-out or block changed (updateExisting). */
  updated: number;
  /** Rows matching an existing contact (or repeated in the batch) that were left as they are. */
  skipped: number;
  /** New contact-tag links. */
  tagsAssigned: number;
  /** Custom field values written (new contacts, and existing ones with updateExisting). */
  fieldsSet: number;
  /** Custom field values refused: not of the field's type (a word in a number field) or an unknown field. */
  fieldsRejected: number;
}

export async function importContactBatch(ctx: TenantContext, input: unknown): Promise<ImportBatchResult> {
  const parsed = batchSchema.safeParse(input);
  if (!parsed.success) throw new AudienceFilterError(parsed.error.issues[0]?.message ?? 'Invalid import');
  const { updateExisting } = parsed.data;

  // Keep the first row for each number, as the import preview does.
  const seen = new Set<string>();
  const rows = parsed.data.rows.filter((row) => !seen.has(row.phone) && seen.add(row.phone));
  let skipped = parsed.data.rows.length - rows.length;

  return withTenant(ctx, async (tx) => {
    // A masked member never sees numbers, so may not write or probe them.
    if (await loadPhoneMask(tx, ctx)) throw new ForbiddenError(PHONE_MASKED_MESSAGE);

    const phones = JSON.stringify(rows.map((row) => row.phone));
    const existing = await tx.$queryRaw<{ id: string; phone_normalized: string }[]>`
      SELECT id::text, phone_normalized FROM contacts
      WHERE account_id=${ctx.accountId}::uuid
        AND phone_normalized IN (SELECT value FROM jsonb_array_elements_text(${phones}::jsonb))`;
    const idByPhone = new Map(existing.map((row) => [row.phone_normalized, row.id]));

    const fresh = rows.filter((row) => !idByPhone.has(row.phone));
    const created = new Set<string>();
    if (fresh.length > 0) {
      await requireContactRoom(tx, ctx.accountId, fresh.length);
      // A number added since the read above (another import, an inbound
      // message) hits the unique index and is skipped, not an error.
      const inserted = await tx.$queryRaw<{ id: string; phone_normalized: string }[]>`
        INSERT INTO contacts(account_id,user_id,phone,name,email,company,city,opted_out_at,opt_out_source,blocked_at)
        SELECT ${ctx.accountId}::uuid, ${ctx.userId}::uuid, '+' || x.phone, x.name, x.email, x.company, x.city,
          x."optedOutAt", CASE WHEN x."optedOutAt" IS NOT NULL THEN 'import' END, x."blockedAt"
        FROM jsonb_to_recordset(${JSON.stringify(fresh)}::jsonb)
          AS x(phone text, name text, email text, company text, city text, "optedOutAt" timestamptz, "blockedAt" timestamptz)
        ON CONFLICT (account_id, phone_normalized) WHERE phone_normalized <> '' DO NOTHING
        RETURNING id::text, phone_normalized`;
      for (const row of inserted) {
        idByPhone.set(row.phone_normalized, row.id);
        created.add(row.phone_normalized);
      }
    }

    // Rows whose number was already a contact.
    const others = rows.filter((row) => !created.has(row.phone));
    let updated = 0;
    if (updateExisting) {
      // Blank cells keep what is stored; only a changed value counts as an
      // update. An opt-out or block is added when the contact has none; an
      // import never clears one (SET expressions read the row's old values).
      const changes = others.filter((row) => row.name || row.email || row.company || row.city || row.optedOutAt || row.blockedAt);
      if (changes.length > 0)
        updated = await tx.$executeRaw`
          UPDATE contacts c SET
            name=COALESCE(x.name, c.name), email=COALESCE(x.email, c.email), company=COALESCE(x.company, c.company),
            city=COALESCE(x.city, c.city),
            opted_out_at=COALESCE(c.opted_out_at, x."optedOutAt"),
            opt_out_source=CASE WHEN c.opted_out_at IS NULL AND x."optedOutAt" IS NOT NULL THEN 'import' ELSE c.opt_out_source END,
            blocked_at=COALESCE(c.blocked_at, x."blockedAt"), updated_at=now()
          FROM jsonb_to_recordset(${JSON.stringify(changes)}::jsonb)
            AS x(phone text, name text, email text, company text, city text, "optedOutAt" timestamptz, "blockedAt" timestamptz)
          WHERE c.account_id=${ctx.accountId}::uuid AND c.phone_normalized=x.phone
            AND (c.name IS DISTINCT FROM COALESCE(x.name, c.name) OR c.email IS DISTINCT FROM COALESCE(x.email, c.email)
              OR c.company IS DISTINCT FROM COALESCE(x.company, c.company) OR c.city IS DISTINCT FROM COALESCE(x.city, c.city)
              OR (c.opted_out_at IS NULL AND x."optedOutAt" IS NOT NULL) OR (c.blocked_at IS NULL AND x."blockedAt" IS NOT NULL))`;
    }
    skipped += others.length - updated;

    // Tags go on new contacts, and on existing ones when the user chose to update them.
    const links = rows.flatMap((row) => {
      const contactId = idByPhone.get(row.phone);
      return contactId && (created.has(row.phone) || updateExisting)
        ? row.tagIds.map((tagId) => ({ contact_id: contactId, tag_id: tagId }))
        : [];
    });
    const tagsAssigned = links.length
      ? await tx.$executeRaw`
          INSERT INTO contact_tags(account_id,contact_id,tag_id)
          SELECT ${ctx.accountId}::uuid, c.id, t.id
          FROM jsonb_to_recordset(${JSON.stringify(links)}::jsonb) AS x(contact_id uuid, tag_id uuid)
          JOIN contacts c ON c.account_id=${ctx.accountId}::uuid AND c.id=x.contact_id
          JOIN tags t ON t.account_id=${ctx.accountId}::uuid AND t.id=x.tag_id
          ON CONFLICT (contact_id, tag_id) DO NOTHING`
      : 0;

    // Custom field values, checked against each field's type (custom-field-types.ts); like tags,
    // on new contacts, and on existing ones when the user chose to update them. A blank cell keeps
    // what is stored. Values are never logged.
    const fieldIds = [...new Set(rows.flatMap((row) => Object.keys(row.customValues)))];
    let fieldsSet = 0;
    let fieldsRejected = 0;
    if (fieldIds.length) {
      const fields = new Map((await tx.$queryRaw<{ id: string; field_type: string; field_options: unknown }[]>`
        SELECT id::text, field_type, field_options FROM custom_fields
        WHERE account_id=${ctx.accountId}::uuid AND id = ANY(${fieldIds}::uuid[])`).map((f) => [f.id, f]));
      const values: { contact_id: string; field_id: string; value: string }[] = [];
      for (const row of rows) {
        const contactId = idByPhone.get(row.phone);
        if (!contactId || !(created.has(row.phone) || updateExisting)) continue;
        for (const [fieldId, raw] of Object.entries(row.customValues)) {
          const field = fields.get(fieldId.toLowerCase());
          const typed = field ? normalizeFieldValue(field, raw) : null;
          if (!typed || !typed.ok) fieldsRejected++;
          else if (typed.value) values.push({ contact_id: contactId, field_id: fieldId.toLowerCase(), value: typed.value });
        }
      }
      if (values.length)
        fieldsSet = await tx.$executeRaw`
          INSERT INTO contact_custom_values(account_id, contact_id, custom_field_id, value)
          SELECT ${ctx.accountId}::uuid, c.id, f.id, x.value
          FROM jsonb_to_recordset(${JSON.stringify(values)}::jsonb) AS x(contact_id uuid, field_id uuid, value text)
          JOIN contacts c ON c.account_id=${ctx.accountId}::uuid AND c.id=x.contact_id
          JOIN custom_fields f ON f.account_id=${ctx.accountId}::uuid AND f.id=x.field_id
          ON CONFLICT (contact_id, custom_field_id) DO UPDATE SET value=EXCLUDED.value`;
    }

    return { imported: created.size, updated, skipped, tagsAssigned, fieldsSet, fieldsRejected };
  });
}
