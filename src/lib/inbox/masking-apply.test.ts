import { describe, expect, it } from 'vitest';
import {
  audienceFilterProbesPhone,
  classifyMaskedPhoneSearch,
  loadPhoneMask,
  maskContactIdentifier,
  maskContactRow,
  maskEmbeddedContact,
  maskMarkers,
  maskNotificationRow,
  maskRealtimePayload,
  maskTemplateParams,
  PHONE_MASK_MARKER,
} from './masking-apply';
import { compileMutation, compileSelect } from '@/lib/repositories/query';
import { ContractError } from '@/lib/data/contracts';
import type { TenantContext } from '@/lib/data/types';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const masked: TenantContext = { accountId: ACCOUNT, userId: USER, role: 'agent' as const, maskPhones: true };
const plain: TenantContext = { accountId: ACCOUNT, userId: USER, role: 'agent' as const };

describe('maskContactIdentifier', () => {
  it('masks numbers with maskPhone and other ids keeping a prefix and last three', () => {
    expect(maskContactIdentifier('+919876543210')).toBe('+91 98•••••210');
    expect(maskContactIdentifier('919876543210')).toBe('+91 98•••••210');
    expect(maskContactIdentifier('IN.1234567890123')).toBe('IN.••••••••••123');
    expect(maskContactIdentifier('abcdef')).toBe('•••def');
    expect(maskContactIdentifier(null)).toBeNull();
    expect(maskContactIdentifier('')).toBe('');
  });
});

describe('row helpers', () => {
  const row = { id: 'c1', name: 'Asha', phone: '+919876543210', phone_normalized: '919876543210', wa_user_id: '919876543210' };
  it('masks every number field and leaves the rest', () => {
    const out = maskContactRow(row, true);
    expect(JSON.stringify(out)).not.toContain('9876543210');
    expect(out).toMatchObject({ id: 'c1', name: 'Asha', phone: '+91 98•••••210' });
    expect(maskContactRow(row, false)).toBe(row);
  });
  it('masks an embedded contact', () => {
    const out = maskEmbeddedContact({ id: 'o1', contact: row }, true);
    expect(JSON.stringify(out)).not.toContain('9876543210');
    expect(maskEmbeddedContact({ id: 'o1', contact: null }, true)).toEqual({ id: 'o1', contact: null });
  });
  it('replaces SQL markers at any depth, keeping null numbers null', () => {
    const value = {
      id: 'v1',
      contact: { phone: { [PHONE_MASK_MARKER]: '+919876543210' }, wa_user_id: { [PHONE_MASK_MARKER]: null } },
      list: [{ phone: { [PHONE_MASK_MARKER]: '+14155550123' } }],
      vars: { phone: { other: 1 } },
    };
    expect(maskMarkers(value)).toEqual({
      id: 'v1',
      contact: { phone: '+91 98•••••210', wa_user_id: null },
      list: [{ phone: '+1 41•••••123' }],
      vars: { phone: { other: 1 } },
    });
  });
  it('masks realtime row snapshots only when required', () => {
    const event = { table: 'contacts', new: row, old: { ...row } };
    expect(JSON.stringify(maskRealtimePayload(event, true))).not.toContain('9876543210');
    expect(maskRealtimePayload(event, false)).toBe(event);
  });
});

describe('notification text', () => {
  const row = {
    id: 'n1',
    type: 'assigned_message',
    title: 'New chat from +91 98765 43210',
    body: 'Customer 919876543210 wrote at 2026-11-02; order #12345',
    link: '/inbox?c=abc',
  };
  it("masks numbers in a masked member's notification title and body only", () => {
    const out = maskNotificationRow(row, true);
    expect(JSON.stringify(out)).not.toContain('98765');
    expect(out.title).toBe('New chat from +91 98•••••210');
    expect(out.body).toContain('+91 98•••••210');
    expect(out.body).toContain('2026-11-02');
    expect(out.body).toContain('#12345');
    expect(out.link).toBe('/inbox?c=abc');
    expect(row.title).toBe('New chat from +91 98765 43210');
    expect(maskNotificationRow(row, false)).toBe(row);
  });
  it('masks notification text in realtime events, and only contact fields elsewhere', () => {
    const event = { table: 'notifications', eventType: 'INSERT', new: row, old: {} };
    expect(JSON.stringify(maskRealtimePayload(event, true))).not.toContain('98765');
    const message = { table: 'messages', eventType: 'INSERT', new: { content_text: 'call 9876543210' }, old: {} };
    // Customer message content is not rewritten (documented limit); only contact number fields are.
    expect(maskRealtimePayload(message, true)).toEqual(message);
  });
});

describe('broadcast recipient template variables', () => {
  const row = {
    id: 'r1',
    contact_id: 'c1',
    template_params: ['Asha', '+919876543210', { nested: 'call 919876543210' }],
    status: 'pending',
  };
  it('masks numbers in template_params at any depth and leaves other fields', () => {
    const out = maskTemplateParams({ id: 'b1', broadcast_recipients: [row] });
    expect(JSON.stringify(out)).not.toContain('9876543210');
    expect(out.broadcast_recipients[0].template_params).toEqual(['Asha', '+91 98•••••210', { nested: 'call +91 98•••••210' }]);
    expect(out.broadcast_recipients[0].contact_id).toBe('c1');
    expect(maskTemplateParams({ template_params: null })).toEqual({ template_params: null });
    expect(row.template_params[1]).toBe('+919876543210');
  });
  it('masks them in realtime INSERT and UPDATE events', () => {
    const insert = { table: 'broadcast_recipients', eventType: 'INSERT', new: row, old: {} };
    expect(JSON.stringify(maskRealtimePayload(insert, true))).not.toContain('9876543210');
    const update = { table: 'broadcast_recipients', eventType: 'UPDATE', new: row, old: row };
    expect(JSON.stringify(maskRealtimePayload(update, true))).not.toContain('9876543210');
    expect(maskRealtimePayload(insert, false)).toBe(insert);
  });
});

describe('search rules', () => {
  it('allows text, last-four suffixes, and denies longer digit runs', () => {
    expect(classifyMaskedPhoneSearch('%asha%')).toEqual({ kind: 'text' });
    expect(classifyMaskedPhoneSearch('%3210%')).toEqual({ kind: 'suffix', digits: '3210' });
    expect(classifyMaskedPhoneSearch('*43210*')).toEqual({ kind: 'deny' });
    expect(classifyMaskedPhoneSearch('+91 98765 43210')).toEqual({ kind: 'deny' });
  });
  it('flags audience filters that probe numbers by digits', () => {
    expect(audienceFilterProbesPhone({ conditions: [{ field: 'phone', value: '98765' }] })).toBe(true);
    expect(audienceFilterProbesPhone({ conditions: [{ field: 'phone' }] })).toBe(false);
    expect(audienceFilterProbesPhone({ conditions: [{ field: 'name', value: '98765' }] })).toBe(false);
  });
});

describe('loadPhoneMask', () => {
  const tx = (rows: unknown[]) => ({ $queryRawUnsafe: async <T,>() => rows as T });
  it('never masks owners, admins or user-less contexts', async () => {
    expect(await loadPhoneMask(tx([{ role: 'agent', mask_phone_numbers: true }]), { accountId: ACCOUNT, userId: USER, role: 'admin' })).toBe(false);
    expect(await loadPhoneMask(tx([{ role: 'agent', mask_phone_numbers: true }]), { accountId: ACCOUNT })).toBe(false);
  });
  it('reads the live membership and fails closed without one', async () => {
    expect(await loadPhoneMask(tx([{ role: 'agent', mask_phone_numbers: true }]), plain)).toBe(true);
    expect(await loadPhoneMask(tx([{ role: 'viewer', mask_phone_numbers: false }]), plain)).toBe(false);
    // A stale flag on a member promoted to admin is ignored.
    expect(await loadPhoneMask(tx([{ role: 'admin', mask_phone_numbers: true }]), plain)).toBe(false);
    expect(await loadPhoneMask(tx([]), plain)).toBe(true);
  });
});

describe('query compiler for a masked member', () => {
  const select = (spec: object, context: TenantContext = masked) =>
    compileSelect({ resource: 'contacts', operation: 'select', filters: [], ...spec }, context, true);

  it('wraps number columns, including nested contacts, for masking', () => {
    const top = select({ projection: 'id,name,phone,wa_user_id' });
    expect(top.text).toContain(`'phone', jsonb_build_object('${PHONE_MASK_MARKER}'`);
    expect(top.text).toContain(`'wa_user_id', jsonb_build_object('${PHONE_MASK_MARKER}'`);
    expect(top.text).not.toContain(`'name', jsonb_build_object`);
    const nested = compileSelect(
      { resource: 'conversations', operation: 'select', filters: [], projection: '*, contact:contacts(*)' },
      masked,
      true
    );
    expect(nested.text).toContain(`'phone', jsonb_build_object('${PHONE_MASK_MARKER}'`);
    expect(select({ projection: 'phone' }, plain).text).not.toContain(PHONE_MASK_MARKER);
  });

  it('compiles a last-digits search as a suffix match and full numbers as no match', () => {
    const suffix = select({ or: ['name.ilike.%3210%,phone.ilike.%3210%'] });
    expect(suffix.text).toContain(`regexp_replace(COALESCE(t."phone",''),'[^0-9]','','g') LIKE`);
    expect(suffix.values).toContain('%3210');
    const full = select({ or: ['name.ilike.%9876543210%,phone.ilike.%9876543210%'] });
    expect(full.text).toMatch(/OR FALSE\)/);
    expect(full.values.filter((v) => typeof v === 'string' && v.includes('9876543210'))).toEqual(['%9876543210%']);
  });

  it('never compares a number directly, through a relation either', () => {
    for (const op of ['eq', 'neq', 'gt', 'lt', 'in'] as const) {
      const value = op === 'in' ? ['+919876543210'] : '+919876543210';
      const query = select({ filters: [{ field: 'phone', op, value }] });
      expect(query.text).toContain('AND FALSE');
      expect(query.values).not.toContain('+919876543210');
    }
    const related = compileSelect(
      { resource: 'conversations', operation: 'select', filters: [{ field: 'contacts.phone', op: 'eq', value: '+919876543210' }] },
      masked,
      true
    );
    expect(related.values).not.toContain('+919876543210');
    // Presence checks reveal nothing about the number.
    expect(select({ filters: [{ field: 'phone', op: 'is', value: null }] }).text).toContain('t."phone" IS NULL');
  });

  it('refuses ordering or upserting by a number', () => {
    expect(() => select({ orders: [{ field: 'phone', ascending: true }] })).toThrow(ContractError);
    expect(() =>
      compileMutation(
        { resource: 'contacts', operation: 'upsert', filters: [], values: { phone: '+919876543210' }, onConflict: 'account_id,phone_normalized' },
        masked,
        true
      )
    ).toThrow(ContractError);
  });

  it('refuses writing a number field on insert, update or upsert, keeping other writes', () => {
    const mutate = (operation: 'insert' | 'update' | 'upsert', values: object | object[], context: TenantContext = masked) =>
      compileMutation(
        { resource: 'contacts', operation, filters: [{ field: 'id', op: 'eq', value: ACCOUNT }], values } as never,
        context,
        true
      );
    for (const field of ['phone', 'phone_normalized', 'wa_user_id', 'wa_parent_user_id']) {
      for (const operation of ['insert', 'update', 'upsert'] as const) {
        let thrown: unknown;
        try {
          mutate(operation, { name: 'Asha', [field]: '+91 98•••••210' });
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(ContractError);
        expect(thrown).toMatchObject({ code: 'PHONE_MASKED', status: 403 });
      }
    }
    // A null number is a write too, and any row of a batch counts.
    expect(() => mutate('update', { phone: null })).toThrow(ContractError);
    expect(() => mutate('insert', [{ name: 'A' }, { name: 'B', phone: '+14155550123' }])).toThrow(ContractError);
    expect(mutate('update', { name: 'Asha', company: 'Acme' }).text).toContain('UPDATE');
    expect(mutate('update', { phone: '+14155550123' }, plain).values).toContain('+14155550123');
    // Other resources are unaffected.
    expect(() =>
      compileMutation({ resource: 'tags', operation: 'insert', filters: [], values: { name: '+14155550123' } } as never, masked, true)
    ).not.toThrow();
  });

  it('leaves unmasked members unchanged', () => {
    const query = select({ filters: [{ field: 'phone', op: 'eq', value: '+919876543210' }] }, plain);
    expect(query.values).toContain('+919876543210');
  });
});
