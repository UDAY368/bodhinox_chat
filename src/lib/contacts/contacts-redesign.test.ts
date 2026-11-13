// Contacts redesign: typed custom field values, the import's column matching,
// the contacts table's owner / consent filters and sorting, the bulk "assign
// owner" action, the profile's field-by-field saves and the custom field
// rules, with the database mocked (the SQL runs in contacts-redesign.integration.test.ts).
import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ tenant: vi.fn(), mask: vi.fn() }));
vi.mock('@/lib/db/tenant', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db/tenant')>()),
  withTenant: h.tenant,
}));
vi.mock('@/lib/inbox/masking-apply', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/inbox/masking-apply')>()),
  loadPhoneMask: h.mask,
}));

import { validateWrite } from '@/lib/data/contracts';
import { bulkContactAction, scopeFromQuery, sortFromQuery, sortSql } from './bulk';
import { checkChoices, fieldChoices, isValidDate, normalizeFieldValue, parseChoices } from './custom-field-types';
import { createCustomField, deleteCustomField, updateCustomField } from './custom-fields';
import { guessImportTargets, mappingProblem, readCsvTable, rowsFromMapping } from './import-mapping';
import { ProfileError, setContactCustomValue, updateContactField } from './profile';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CONTACT = '33333333-3333-4333-8333-333333333333';
const FIELD = '44444444-4444-4444-8444-444444444444';
const ctx = { accountId: ACCOUNT, userId: USER, role: 'agent' as const };

/** A transaction whose queries answer in order; records every statement's text. */
function fakeTx(answers: unknown[]) {
  const statements: string[] = [];
  const next = () => (answers.length ? answers.shift() : []);
  const text = (q: unknown) => (q as Prisma.Sql)?.sql ?? (Array.isArray(q) ? (q as string[]).join('?') : String(q));
  const tx = {
    $queryRaw: vi.fn(async (q: unknown) => { statements.push(text(q)); return next(); }),
    $executeRaw: vi.fn(async (q: unknown) => { statements.push(text(q)); const n = next(); return typeof n === 'number' ? n : 1; }),
    $queryRawUnsafe: vi.fn(async () => []),
  };
  h.tenant.mockImplementation(async (_ctx: unknown, op: (t: typeof tx) => unknown) => op(tx));
  return { tx, statements };
}

beforeEach(() => {
  h.tenant.mockReset();
  h.mask.mockReset();
  h.mask.mockResolvedValue(false);
});

describe('typed custom field values', () => {
  const number = { field_type: 'number' };
  const date = { field_type: 'date' };
  const choice = { field_type: 'choice', field_options: ['Starter', 'Growth'] };

  it('keeps every text value, and treats an unknown or old type as text', () => {
    expect(normalizeFieldValue({ field_type: 'text' }, '  anything 12 ')).toEqual({ ok: true, value: 'anything 12' });
    expect(normalizeFieldValue({ field_type: 'legacy' }, 'x')).toEqual({ ok: true, value: 'x' });
    expect(normalizeFieldValue({ field_type: 'text' }, 'x'.repeat(1001))).toEqual({ ok: false, problem: 'too_long' });
  });

  it('accepts plain numbers only', () => {
    expect(normalizeFieldValue(number, '12')).toEqual({ ok: true, value: '12' });
    expect(normalizeFieldValue(number, '+007.50')).toEqual({ ok: true, value: '7.50' });
    expect(normalizeFieldValue(number, '-3')).toEqual({ ok: true, value: '-3' });
    for (const bad of ['twelve', '1,000', '1e5', '12.', '.5'])
      expect(normalizeFieldValue(number, bad)).toEqual({ ok: false, problem: 'not_a_number' });
  });

  it('accepts real calendar dates as YYYY-MM-DD', () => {
    expect(normalizeFieldValue(date, '2027-01-15')).toEqual({ ok: true, value: '2027-01-15' });
    expect(isValidDate('2026-02-29')).toBe(false);
    expect(isValidDate('2028-02-29')).toBe(true);
    expect(normalizeFieldValue(date, '15/01/2027')).toEqual({ ok: false, problem: 'not_a_date' });
  });

  it('matches a choice without case and stores the choice as written', () => {
    expect(normalizeFieldValue(choice, 'growth')).toEqual({ ok: true, value: 'Growth' });
    expect(normalizeFieldValue(choice, 'Annual')).toEqual({ ok: false, problem: 'not_a_choice' });
    expect(fieldChoices({ field_type: 'choice', field_options: ['a', 3, 'b'] })).toEqual(['a', 'b']);
    expect(fieldChoices({ field_type: 'text', field_options: ['a'] })).toEqual([]);
  });

  it('treats a blank value as clearing it', () => {
    expect(normalizeFieldValue(number, '   ')).toEqual({ ok: true, value: '' });
  });

  it('reads choices one per line without repeats', () => {
    expect(parseChoices(' Starter\n\ngrowth\r\nGrowth\nAnnual ')).toEqual(['Starter', 'growth', 'Annual']);
    expect(checkChoices(['a'])).toBe('too_few');
    expect(checkChoices(Array.from({ length: 51 }, (_, i) => `c${i}`))).toBe('too_many');
    expect(checkChoices(['a', 'x'.repeat(101)])).toBe('too_long');
    expect(checkChoices(['a', 'b'])).toBeNull();
  });
});

describe('import column matching', () => {
  const fields = [{ id: FIELD, field_name: 'Plan' }];

  it('guesses contact fields and custom fields by header, each once', () => {
    expect(guessImportTargets(['Full name', 'Mobile', 'City', 'Labels', 'Plan', 'Phone', 'Notes'], fields))
      .toEqual(['name', 'phone', 'city', 'tags', `cf:${FIELD}`, '', '']);
  });

  it('needs a phone column and no field twice', () => {
    expect(mappingProblem(['name', ''])).toBe('no_phone');
    expect(mappingProblem(['phone', 'name', 'name'])).toBe('duplicate');
    expect(mappingProblem(['phone', '', ''])).toBeNull();
  });

  it('reads rows through the matching, custom values by field id', () => {
    const table = readCsvTable('﻿First,Last,Mobile,Plan,Skip\nRitu,Malhotra,\'+91 98765 43210,Growth,x\n\n,,,,\nAsha,,9876543210,,y\n');
    expect(table?.rows).toHaveLength(2);
    const rows = rowsFromMapping(table!, ['firstName', 'lastName', 'phone', `cf:${FIELD}`, '']);
    expect(rows[0]).toMatchObject({ name: 'Ritu Malhotra', phone: '+91 98765 43210', customValues: { [FIELD]: 'Growth' }, tagNames: [] });
    expect(rows[1]).toMatchObject({ name: 'Asha', phone: '9876543210', customValues: {} });
    expect(readCsvTable('only,a,header\n')).toBeNull();
  });
});

describe('contacts table owner and consent filters, and sorting', () => {
  it('reads the owner and consent filters from the query string', () => {
    expect(scopeFromQuery(new URLSearchParams(`ownerId=${USER}&consent=opted_out`))).toEqual({ ownerId: USER, consent: 'opted_out' });
    expect(scopeFromQuery(new URLSearchParams('ownerId=none'))).toEqual({ ownerId: 'none' });
  });

  it('only sorts by fixed columns, newest first by default', () => {
    expect(sortFromQuery(new URLSearchParams(''))).toEqual({ sort: 'created', dir: 'desc' });
    expect(sortFromQuery(new URLSearchParams('sort=name'))).toEqual({ sort: 'name', dir: 'asc' });
    expect(sortFromQuery(new URLSearchParams('sort=seen&dir=asc'))).toEqual({ sort: 'seen', dir: 'asc' });
    expect(sortFromQuery(new URLSearchParams('sort=password_hash;drop'))).toEqual({ sort: 'created', dir: 'desc' });
    expect(sortSql('owner', 'desc').sql).toMatch(/^lower\(\(SELECT p\.full_name FROM profiles p .*\)\) DESC NULLS LAST/);
    expect(sortSql('created', 'asc').values).toEqual([]);
  });

  it('refuses an owner filter that is neither a member id nor none', async () => {
    await expect(bulkContactAction(ctx, { scope: { ownerId: 'someone' }, action: { type: 'delete' }, expected: 1 })).rejects.toThrow();
    await expect(bulkContactAction(ctx, { scope: { consent: 'maybe' }, action: { type: 'delete' }, expected: 1 })).rejects.toThrow();
    expect(h.tenant).not.toHaveBeenCalled();
  });
});

describe('bulk assign owner', () => {
  const run = (ownerId: string | null) => bulkContactAction(ctx, { scope: { contactIds: [CONTACT] }, action: { type: 'assign_owner', ownerId }, expected: 1 });

  it('refuses an owner who is not a member of the workspace', async () => {
    const { statements } = fakeTx([[{ id: CONTACT }], []]);
    await expect(run(USER)).rejects.toThrow('member of this workspace');
    expect(statements.some((s) => s.includes('UPDATE contacts'))).toBe(false);
  });

  it('sets the owner and adds one timeline row per changed contact', async () => {
    const { statements } = fakeTx([[{ id: CONTACT }], [{ ok: 1 }], [{ id: CONTACT }], 1]);
    await expect(run(USER)).resolves.toEqual({ matched: 1, changed: 1 });
    expect(statements.some((s) => s.includes('UPDATE contacts SET owner_id='))).toBe(true);
    expect(statements.some((s) => s.includes('INSERT INTO contact_activity'))).toBe(true);
  });

  it('refuses a value that does not fit a typed field', async () => {
    fakeTx([[{ id: CONTACT }], [{ id: FIELD, field_type: 'number', field_options: null }]]);
    await expect(bulkContactAction(ctx, { scope: { contactIds: [CONTACT] }, action: { type: 'set_field', fieldId: FIELD, value: 'lots' }, expected: 1 }))
      .rejects.toThrow('does not fit');
  });
});

describe('profile field saves', () => {
  const row = { id: CONTACT, name: 'Asha', phone: '+919876543210', email: null, company: null, city: null, owner_id: null, blocked_at: null, updated_at: null };

  it('refuses unknown fields and wrong value types before the database', async () => {
    await expect(updateContactField(ctx, CONTACT, 'password_hash', 'x')).rejects.toThrow(ProfileError);
    await expect(updateContactField(ctx, CONTACT, 'blocked', 'yes')).rejects.toThrow(ProfileError);
    await expect(updateContactField(ctx, CONTACT, 'name', 5)).rejects.toThrow(ProfileError);
    expect(await updateContactField(ctx, 'not-a-uuid', 'name', 'x')).toBeNull();
    expect(h.tenant).not.toHaveBeenCalled();
  });

  it('answers null for a contact of another workspace', async () => {
    fakeTx([[]]);
    expect(await updateContactField(ctx, CONTACT, 'city', 'Pune')).toBeNull();
  });

  it('saves a changed text field once, with a timeline row naming the field only', async () => {
    const { tx, statements } = fakeTx([[row], [{ ...row, city: 'Pune' }], 1]);
    const saved = await updateContactField(ctx, CONTACT, 'city', ' Pune ');
    expect(saved).toMatchObject({ city: 'Pune' });
    const activity = tx.$executeRaw.mock.calls.find(([q]) => String((q as Prisma.Sql).sql ?? q).includes('contact_activity'));
    expect(JSON.stringify(activity)).toContain('"field\\":\\"city');
    expect(JSON.stringify(activity)).not.toContain('Pune');
    expect(statements.filter((s) => s.includes('UPDATE contacts'))).toHaveLength(1);
  });

  it('writes nothing when the value did not change', async () => {
    const { statements } = fakeTx([[{ ...row, city: 'Pune' }]]);
    await updateContactField(ctx, CONTACT, 'city', 'Pune');
    expect(statements.some((s) => s.includes('UPDATE contacts'))).toBe(false);
  });

  it('checks email, number format, duplicates, masking and owner membership', async () => {
    fakeTx([[row]]);
    await expect(updateContactField(ctx, CONTACT, 'email', 'not-an-email')).rejects.toMatchObject({ code: 'invalid_email' });
    fakeTx([[row]]);
    await expect(updateContactField(ctx, CONTACT, 'phone', '98765 43210')).rejects.toMatchObject({ code: 'invalid_phone' });
    fakeTx([[row], [{ ok: 1 }]]);
    await expect(updateContactField(ctx, CONTACT, 'phone', '+44 7700 900123')).rejects.toMatchObject({ code: 'duplicate_phone', status: 409 });
    h.mask.mockResolvedValue(true);
    fakeTx([[row]]);
    await expect(updateContactField(ctx, CONTACT, 'phone', '+44 7700 900123')).rejects.toMatchObject({ code: 'phone_masked', status: 403 });
    h.mask.mockResolvedValue(false);
    fakeTx([[row], []]);
    await expect(updateContactField(ctx, CONTACT, 'owner_id', USER)).rejects.toMatchObject({ code: 'not_member' });
  });

  it('records a block and an owner change by id', async () => {
    const block = fakeTx([[row], [{ ...row, blocked_at: new Date('2026-11-13T00:00:00Z') }], 1]);
    expect(await updateContactField(ctx, CONTACT, 'blocked', true)).toMatchObject({ blocked_at: '2026-11-13T00:00:00.000Z' });
    expect(JSON.stringify(block.tx.$executeRaw.mock.calls)).toContain('blocked');
    const owner = fakeTx([[row], [{ ok: 1 }], [{ ...row, owner_id: USER }], 1]);
    expect(await updateContactField(ctx, CONTACT, 'owner_id', USER)).toMatchObject({ owner_id: USER });
    expect(JSON.stringify(owner.tx.$executeRaw.mock.calls)).toContain(USER);
  });

  it('checks a custom value against the field type', async () => {
    fakeTx([[{ id: CONTACT }], [{ field_type: 'number', field_options: null }]]);
    await expect(setContactCustomValue(ctx, CONTACT, FIELD, 'many')).rejects.toMatchObject({ code: 'not_a_number' });
    fakeTx([[{ id: CONTACT }], []]);
    await expect(setContactCustomValue(ctx, CONTACT, FIELD, '3')).rejects.toMatchObject({ code: 'field_not_found', status: 404 });
    const ok = fakeTx([[{ id: CONTACT }], [{ field_type: 'number', field_options: null }], [], 1, 1]);
    await expect(setContactCustomValue(ctx, CONTACT, FIELD, ' 3 ')).resolves.toEqual({ value: '3' });
    expect(ok.statements.some((s) => s.includes('INSERT INTO contact_custom_values'))).toBe(true);
    const clear = fakeTx([[{ id: CONTACT }], [{ field_type: 'text', field_options: null }], [{ value: 'old' }], 1, 1]);
    await expect(setContactCustomValue(ctx, CONTACT, FIELD, '')).resolves.toEqual({ value: '' });
    expect(clear.statements.some((s) => s.includes('DELETE FROM contact_custom_values'))).toBe(true);
  });
});

describe('custom field rules', () => {
  it('refuses bad names, types and choices before the database', async () => {
    await expect(createCustomField(ctx, { name: ' ', type: 'text' })).rejects.toMatchObject({ code: 'name_required' });
    await expect(createCustomField(ctx, { name: 'City', type: 'text' })).rejects.toMatchObject({ code: 'name_reserved' });
    await expect(createCustomField(ctx, { name: 'Plan', type: 'money' })).rejects.toMatchObject({ code: 'invalid_type' });
    await expect(createCustomField(ctx, { name: 'Plan', type: 'choice', choices: ['Only'] })).rejects.toMatchObject({ code: 'too_few' });
    await expect(updateCustomField(ctx, FIELD, { type: 'number' })).rejects.toMatchObject({ code: 'invalid_type' });
    await expect(deleteCustomField(ctx, 'nope')).rejects.toMatchObject({ code: 'not_found', status: 404 });
    expect(h.tenant).not.toHaveBeenCalled();
  });

  it('refuses a name another field has', async () => {
    fakeTx([[{ ok: 1 }]]);
    await expect(createCustomField(ctx, { name: 'Plan', type: 'text' })).rejects.toMatchObject({ code: 'name_taken', status: 409 });
  });

  it('will not leave a segment without conditions, and strips the field from the others', async () => {
    const only = { id: 'a', name: 'Annual', filter: { conditions: [{ field: 'custom_field', fieldId: FIELD, op: 'is', value: 'x' }] } };
    fakeTx([[{ id: FIELD }], [only]]);
    await expect(deleteCustomField(ctx, FIELD)).rejects.toMatchObject({ code: 'segment_needs_field', segments: ['Annual'] });
    const mixed = { id: 'b', name: 'Mixed', filter: { match: 'any', conditions: [{ field: 'name', op: 'is_empty' }, { field: 'custom_field', fieldId: FIELD, op: 'is_empty' }] } };
    const { tx } = fakeTx([[{ id: FIELD }], [mixed], 1, 4, 1]);
    await expect(deleteCustomField(ctx, FIELD)).resolves.toEqual({ values: 4, segments: 1 });
    const saved = JSON.stringify(tx.$executeRaw.mock.calls[0]);
    expect(saved).toContain('is_empty');
    expect(saved).not.toContain(FIELD);
  });
});

describe('browser data contract', () => {
  it('keeps the owner and a field type server-managed, while plain text fields stay creatable', () => {
    for (const op of ['insert', 'update', 'upsert'] as const)
      expect(() => validateWrite('contacts', { owner_id: USER }, ctx, true, op)).toThrow(/server-managed/);
    expect(() => validateWrite('contacts', { city: 'Pune' }, ctx, true, 'update')).not.toThrow();
    const admin = { ...ctx, role: 'admin' as const };
    expect(() => validateWrite('custom_fields', { field_type: 'choice' }, admin, true, 'insert')).toThrow(/server-managed/);
    expect(() => validateWrite('custom_fields', { field_type: 'text' }, admin, true, 'update')).toThrow(/server-managed/);
    expect(() => validateWrite('custom_fields', { field_options: ['a', 'b'] }, admin, true, 'update')).toThrow(/server-managed/);
    expect(() => validateWrite('custom_fields', { field_type: 'text', field_name: 'Plan' }, admin, true, 'insert')).not.toThrow();
    // Server routes still write them.
    expect(() => validateWrite('contacts', { owner_id: USER }, ctx, false, 'update')).not.toThrow();
  });
});
