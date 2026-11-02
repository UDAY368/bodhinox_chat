// One writer for contact fields set by automations and flows.

import type { DataClient } from '@/lib/data/types'

/** Built-in contact columns a bot may overwrite. */
export const WRITABLE_CONTACT_FIELDS = ['name', 'email', 'company'] as const

/**
 * Writes `name` / `email` / `company`, or a custom field given as
 * `custom:<custom_field_id>`. Returns false when the field is not
 * writable or the custom field is not this account's.
 */
export async function writeContactField(db: DataClient, accountId: string, contactId: string, field: string, value: string): Promise<boolean> {
  if (field.startsWith('custom:')) {
    const customFieldId = field.slice('custom:'.length)
    if (!customFieldId) return false
    // Defense in depth: the worker client is scoped, but confirm the field
    // definition belongs to this account before writing.
    const { data: definition } = await db
      .from('custom_fields')
      .select('id')
      .eq('id', customFieldId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!definition) return false
    // Upsert on the table's UNIQUE(contact_id, custom_field_id) so repeated
    // runs overwrite rather than duplicate.
    const { error } = await db
      .from('contact_custom_values')
      .upsert({ contact_id: contactId, custom_field_id: customFieldId, value }, { onConflict: 'contact_id,custom_field_id' })
    if (error) throw new Error('Custom field write failed')
    return true
  }
  if (!(WRITABLE_CONTACT_FIELDS as readonly string[]).includes(field)) return false
  const { error } = await db
    .from('contacts')
    .update({ [field]: value, updated_at: new Date().toISOString() })
    .eq('id', contactId)
    .eq('account_id', accountId)
  if (error) throw new Error('Contact field write failed')
  return true
}
