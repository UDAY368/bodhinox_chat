// One writer for contact fields set by automations and flows.

import { Prisma } from '@prisma/client'
import type { DataClient } from '@/lib/data/types'
import { withTenant } from '@/lib/db/tenant'
import { getWorkerPrisma } from '@/lib/db/prisma'
import { queueContactEvent } from './tag-write'

/** Built-in contact columns a bot may overwrite. */
export const WRITABLE_CONTACT_FIELDS = ['name', 'email', 'company'] as const

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const present = (value: string | null | undefined): boolean => typeof value === 'string' && value.trim() !== ''

export interface ContactFieldWriteOptions {
  /** The originating contact event an automation run passes on (loop guard); omitted, the write is a new event. */
  eventId?: string
}

/**
 * Writes `name` / `email` / `company`, or a custom field given as
 * `custom:<custom_field_id>`. Returns false when the field is not
 * writable, the custom field is not this account's, or the contact is not
 * this account's.
 *
 * Stage 5: when the value really changes, the field_changed event (field id
 * and whether it had and has a value, never the values) is queued for the
 * matching automations in the same transaction as the write.
 */
export async function writeContactField(db: DataClient, accountId: string, contactId: string, field: string, value: string,
  options: ContactFieldWriteOptions = {}): Promise<boolean> {
  if (!UUID.test(contactId)) return false
  if (field.startsWith('custom:')) {
    const customFieldId = field.slice('custom:'.length)
    if (!UUID.test(customFieldId)) return false
    // Defense in depth: the worker client is scoped, but confirm the field
    // definition belongs to this account before writing.
    const { data: definition } = await db
      .from('custom_fields')
      .select('id')
      .eq('id', customFieldId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!definition) return false
    return withTenant({ accountId, role: 'owner' }, async (tx) => {
      const [contact] = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM contacts
        WHERE account_id=${accountId}::uuid AND id=${contactId}::uuid FOR UPDATE`
      if (!contact) return false
      const [old] = await tx.$queryRaw<{ value: string | null }[]>`SELECT value FROM contact_custom_values
        WHERE account_id=${accountId}::uuid AND contact_id=${contactId}::uuid AND custom_field_id=${customFieldId}::uuid`
      // UNIQUE(contact_id, custom_field_id): repeated runs overwrite rather than duplicate.
      await tx.$executeRaw`INSERT INTO contact_custom_values(account_id, contact_id, custom_field_id, value)
        VALUES(${accountId}::uuid, ${contactId}::uuid, ${customFieldId}::uuid, ${value})
        ON CONFLICT (contact_id, custom_field_id) DO UPDATE SET value=EXCLUDED.value`
      if ((old?.value ?? null) !== value) await queueContactEvent(tx, { accountId, contactId, eventId: options.eventId,
        event: { type: 'field_changed', field, hadValue: present(old?.value), hasValue: present(value) } })
      return true
    }, getWorkerPrisma()).catch(() => { throw new Error('Custom field write failed') })
  }
  if (!(WRITABLE_CONTACT_FIELDS as readonly string[]).includes(field)) return false
  // A fixed column name from the list above, never input.
  const column = Prisma.raw(field)
  return withTenant({ accountId, role: 'owner' }, async (tx) => {
    const [old] = await tx.$queryRaw<{ value: string | null }[]>(Prisma.sql`SELECT ${column}::text AS value FROM contacts
      WHERE account_id=${accountId}::uuid AND id=${contactId}::uuid FOR UPDATE`)
    if (!old) return false
    await tx.$executeRaw(Prisma.sql`UPDATE contacts SET ${column}=${value}, updated_at=now()
      WHERE account_id=${accountId}::uuid AND id=${contactId}::uuid`)
    if (old.value !== value) await queueContactEvent(tx, { accountId, contactId, eventId: options.eventId,
      event: { type: 'field_changed', field, hadValue: present(old.value), hasValue: present(value) } })
    return true
  }, getWorkerPrisma()).catch(() => { throw new Error('Contact field write failed') })
}
