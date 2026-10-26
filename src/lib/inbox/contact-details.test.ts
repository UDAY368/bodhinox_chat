import { beforeEach, expect, it, vi } from 'vitest';
import { buildQuery } from '@/lib/data/builder';
import type { QuerySpec } from '@/lib/data/types';
import {
  createAddressField,
  flowAnswers,
  loadContactDetails,
  saveContactBasics,
  saveContactField,
} from './contact-details';

const state = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('@/lib/data/client', () => ({
  createClient: () => ({
    from: (resource: string) => buildQuery(resource, state.execute),
  }),
}));

const specs: QuerySpec[] = [];
const contact = { id: 'c1', phone: '123', name: 'Alice' };
beforeEach(() => {
  specs.length = 0;
  state.execute.mockReset().mockImplementation(async (spec: QuerySpec) => {
    specs.push(spec);
    const rows: Record<string, unknown> = {
      contacts: contact,
      deals: [],
      contact_notes: [],
      contact_tags: [{ id: 'ct1', tags: { id: 'tag1', name: 'Customer' } }],
      tags: [{ id: 'tag1', name: 'Customer' }],
      custom_fields: [],
      contact_custom_values: [{ custom_field_id: 'field1', value: 'Pune' }],
      flow_runs: [{ id: 'run1', flow_id: 'f1', vars: { City: 'Pune' } }],
      flows: [{ id: 'f1', name: 'Enquiry' }],
    };
    return { data: rows[spec.resource] ?? [], error: null };
  });
});

it('loads contact scoped data and the latest twenty flow runs without combining their answers', async () => {
  const details = await loadContactDetails('c1');
  expect(details.contact).toEqual(contact);
  expect(details.tags).toEqual([
    { id: 'tag1', name: 'Customer', contact_tag_id: 'ct1' },
  ]);
  expect(details.customValues).toEqual({ field1: 'Pune' });
  expect(details.flowNames).toEqual({ f1: 'Enquiry' });
  for (const resource of [
    'deals',
    'contact_notes',
    'contact_tags',
    'contact_custom_values',
    'flow_runs',
  ]) {
    expect(specs.find((s) => s.resource === resource)?.filters).toContainEqual({
      field: 'contact_id',
      op: 'eq',
      value: 'c1',
    });
  }
  expect(specs.find((s) => s.resource === 'contacts')?.filters).toEqual([
    { field: 'id', op: 'eq', value: 'c1' },
  ]);
  expect(specs.find((s) => s.resource === 'flow_runs')).toMatchObject({
    limit: 20,
    orders: [{ field: 'started_at', ascending: false, nullsFirst: undefined }],
  });
  expect(specs.find((s) => s.resource === 'flows')?.filters).toEqual([
    { field: 'id', op: 'in', value: ['f1'] },
  ]);
});

it('surfaces a failed load instead of presenting partial data as empty', async () => {
  state.execute.mockResolvedValue({
    data: null,
    error: { message: 'Access denied' },
  });
  await expect(loadContactDetails('c1')).rejects.toThrow('Access denied');
});

it('only updates provided editable basics, retaining phone and other identity fields', async () => {
  const result = await saveContactBasics('c1', {
    name: ' Alice ',
    email: ' a@example.com ',
    phone: '999',
  } as never);
  expect(result).toEqual(contact);
  expect(specs[0]).toMatchObject({
    resource: 'contacts',
    operation: 'update',
    values: { name: 'Alice', email: 'a@example.com' },
    filters: [{ field: 'id', op: 'eq', value: 'c1' }],
  });
});

it('rejects invalid or oversized basics before issuing any write', async () => {
  await expect(saveContactBasics('c1', { email: 'invalid' })).rejects.toThrow();
  await expect(
    saveContactBasics('c1', { name: 'x'.repeat(256) })
  ).rejects.toThrow();
  expect(specs).toHaveLength(0);
});

it('upserts just the edited custom value without deleting the other values', async () => {
  await saveContactField('c1', 'field1', 'Pune');
  expect(specs).toHaveLength(1);
  expect(specs[0]).toMatchObject({
    resource: 'contact_custom_values',
    operation: 'upsert',
    onConflict: 'contact_id,custom_field_id',
    values: { contact_id: 'c1', custom_field_id: 'field1', value: 'Pune' },
  });
});

it('propagates save failures', async () => {
  state.execute.mockResolvedValue({
    data: null,
    error: { message: 'Forbidden' },
  });
  await expect(saveContactBasics('c1', { company: 'ACME' })).rejects.toThrow(
    'Forbidden'
  );
  await expect(saveContactField('c1', 'field1', '')).rejects.toThrow(
    'Forbidden'
  );
});

it('reuses an existing canonical Address field regardless of letter case', async () => {
  const address = { id: 'f1', field_name: 'ADDRESS' };
  state.execute.mockResolvedValue({ data: [address], error: null });
  expect(await createAddressField({ accountId: 'a1', userId: 'u1' })).toEqual(
    address
  );
  expect(specs).toHaveLength(0);
  expect(state.execute).toHaveBeenCalledTimes(1);
});

it('creates Address through the normal account scoped field resource', async () => {
  state.execute
    .mockResolvedValueOnce({ data: [], error: null })
    .mockResolvedValueOnce({ data: { id: 'address' }, error: null });
  await createAddressField({ accountId: 'a1', userId: 'u1' });
  expect(state.execute.mock.calls[1][0]).toMatchObject({
    resource: 'custom_fields',
    operation: 'insert',
    values: {
      field_name: 'Address',
      field_type: 'text',
      account_id: 'a1',
      user_id: 'u1',
    },
  });
});

it('shows only nonempty primitive answers with their literal keys', () => {
  expect(
    flowAnswers({
      City: ' Pune ',
      consent: false,
      count: 0,
      blank: ' ',
      nested: { token: 'x' },
      list: ['x'],
      absent: null,
      bad: NaN,
    })
  ).toEqual([
    { key: 'City', value: 'Pune' },
    { key: 'consent', value: 'false' },
    { key: 'count', value: '0' },
  ]);
  expect(flowAnswers(null)).toEqual([]);
  expect(flowAnswers(['x'])).toEqual([]);
});
