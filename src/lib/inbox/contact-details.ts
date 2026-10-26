import { createClient } from '@/lib/data/client';
import type { QueryResult } from '@/lib/data/types';
import type {
  Contact,
  ContactCustomValue,
  ContactNote,
  CustomField,
  Deal,
  Tag,
} from '@/types';

export interface SidebarFlowRun {
  id: string;
  flow_id: string;
  vars: Record<string, unknown>;
  status: string;
  started_at: string;
  last_advanced_at: string;
}

export interface ContactDetails {
  contact: Contact;
  deals: Deal[];
  notes: ContactNote[];
  tags: (Tag & { contact_tag_id: string })[];
  availableTags: Tag[];
  customFields: CustomField[];
  customValues: Record<string, string>;
  flowRuns: SidebarFlowRun[];
  flowNames: Record<string, string>;
}

function checked<T>({ data, error }: QueryResult<T>): T {
  if (error) throw new Error(error.message);
  if (data === null) throw new Error('Contact details response was empty');
  return data;
}

/** The authenticated data client enforces account scope on every resource. */
export async function loadContactDetails(
  contactId: string
): Promise<ContactDetails> {
  const db = createClient();
  const results = await Promise.all([
    db.from('contacts').select<Contact>('*').eq('id', contactId).single(),
    db
      .from('deals')
      .select<Deal>('*, stage:pipeline_stages(*)')
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false }),
    db
      .from('contact_notes')
      .select<ContactNote>('*')
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false }),
    db
      .from('contact_tags')
      .select<{ id: string; tags: Tag | null }>('id, tag_id, tags(*)')
      .eq('contact_id', contactId),
    db.from('tags').select<Tag>('*').order('name'),
    db.from('custom_fields').select<CustomField>('*').order('field_name'),
    db
      .from('contact_custom_values')
      .select<ContactCustomValue>('*')
      .eq('contact_id', contactId),
    db
      .from('flow_runs')
      .select<SidebarFlowRun>(
        'id,flow_id,vars,status,started_at,last_advanced_at'
      )
      .eq('contact_id', contactId)
      .order('started_at', { ascending: false })
      .limit(20),
  ]);
  const [
    contact,
    deals,
    notes,
    assignments,
    availableTags,
    customFields,
    values,
    flowRuns,
  ] = [
    checked(results[0]),
    checked(results[1]),
    checked(results[2]),
    checked(results[3]),
    checked(results[4]),
    checked(results[5]),
    checked(results[6]),
    checked(results[7]),
  ];
  const flowIds = [...new Set(flowRuns.map((run) => run.flow_id))];
  const flows = flowIds.length
    ? checked(
        await db
          .from('flows')
          .select<{ id: string; name: string }>('id,name')
          .in('id', flowIds)
      )
    : [];
  return {
    contact,
    deals,
    notes,
    availableTags,
    customFields,
    flowRuns,
    tags: assignments.flatMap((row) =>
      row.tags ? [{ ...row.tags, contact_tag_id: row.id }] : []
    ),
    customValues: Object.fromEntries(
      values.map((row) => [row.custom_field_id, row.value ?? ''])
    ),
    flowNames: Object.fromEntries(flows.map((flow) => [flow.id, flow.name])),
  };
}

export async function saveContactBasics(
  contactId: string,
  values: Partial<Pick<Contact, 'name' | 'email' | 'company'>>
): Promise<Contact> {
  const patch: Record<string, string> = {};
  for (const key of ['name', 'email', 'company'] as const) {
    if (values[key] === undefined) continue;
    if (typeof values[key] !== 'string') throw new Error(`Invalid ${key}`);
    const value = values[key].trim();
    if (value.length > (key === 'email' ? 254 : 255))
      throw new Error(`${key} is too long`);
    if (key === 'email' && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
      throw new Error('Invalid email address');
    patch[key] = value;
  }
  if (!Object.keys(patch).length) throw new Error('No contact details to save');
  return checked(
    await createClient()
      .from('contacts')
      .update(patch)
      .eq('id', contactId)
      .select<Contact>('*')
      .single()
  );
}

export async function saveContactField(
  contactId: string,
  fieldId: string,
  value: string
): Promise<void> {
  if (typeof value !== 'string' || value.length > 10000)
    throw new Error('Invalid custom field value');
  const { error } = await createClient().from('contact_custom_values').upsert(
    {
      contact_id: contactId,
      custom_field_id: fieldId,
      value,
    },
    { onConflict: 'contact_id,custom_field_id' }
  );
  if (error) throw new Error(error.message);
}

export async function createAddressField({
  accountId,
  userId,
}: {
  accountId: string;
  userId: string;
}): Promise<CustomField> {
  const db = createClient();
  const fields = checked(
    await db.from('custom_fields').select<CustomField>('*')
  );
  const existing = fields.find(
    (field) => field.field_name.trim().toLowerCase() === 'address'
  );
  if (existing) return existing;
  return checked(
    await db
      .from('custom_fields')
      .insert({
        field_name: 'Address',
        field_type: 'text',
        account_id: accountId,
        user_id: userId,
      })
      .select<CustomField>('*')
      .single()
  );
}

export function flowAnswers(
  vars: unknown
): Array<{ key: string; value: string }> {
  if (!vars || typeof vars !== 'object' || Array.isArray(vars)) return [];
  return Object.entries(vars).flatMap(([key, value]) => {
    if (typeof value === 'string')
      return value.trim() ? [{ key, value: value.trim() }] : [];
    if (
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    )
      return [{ key, value: String(value) }];
    return [];
  });
}
