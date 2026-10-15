import { expect, it } from 'vitest';
import { encodeQuery, decodeQuery } from './transport';
it('uses a fixed resource URL and REST verb without table/action request properties', () => {
  const encoded = encodeQuery({
    resource: 'contacts',
    operation: 'insert',
    values: { name: 'Ada', phone: '123' },
    filters: [],
    returning: true,
  });
  expect(encoded.url).toContain('/api/crm/contacts?');
  expect(encoded.init.method).toBe('POST');
  expect(JSON.parse(encoded.init.body as string)).toEqual({
    name: 'Ada',
    phone: '123',
  });
  expect(() =>
    encodeQuery({ resource: 'auth_users', operation: 'select', filters: [] })
  ).toThrow();
});
it('rejects unknown and duplicated URL parameters', () => {
  expect(() =>
    decodeQuery(
      new Request('https://example.test/api/crm/contacts?table=auth_users'),
      'contacts'
    )
  ).toThrow();
  expect(() =>
    decodeQuery(
      new Request('https://example.test/api/crm/contacts?limit=5&limit=10'),
      'contacts'
    )
  ).toThrow();
});
it('omits legacy caller timestamps without stripping any other mutation field or changing caller data', () => {
  const row = {
    name: 'Saved',
    updated_at: '2000-01-01T00:00:00.000Z',
    created_at: '2000-01-01T00:00:00.000Z',
    unread_count: 99,
  };
  const encoded = encodeQuery({
    resource: 'contacts',
    operation: 'update',
    values: row,
    filters: [{ field: 'id', op: 'eq', value: 'id' }],
  });
  expect(JSON.parse(encoded.init.body as string)).toEqual({
    name: 'Saved',
    unread_count: 99,
  });
  expect(row.updated_at).toBe('2000-01-01T00:00:00.000Z');
  const batch = encodeQuery({
    resource: 'contacts',
    operation: 'insert',
    values: [row],
    filters: [],
  });
  expect(JSON.parse(batch.init.body as string)[0]).not.toHaveProperty(
    'updated_at'
  );
});
