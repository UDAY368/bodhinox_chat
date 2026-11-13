import { beforeEach, describe, expect, it, vi } from 'vitest';

// Automations, flows, forms, AI goals and the v1 API write custom fields through
// writeContactField: a number, date or choice field only takes a value of its type.
const h = vi.hoisted(() => ({ written: [] as unknown[][], definition: null as Record<string, unknown> | null }));

vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => ({}) }));
vi.mock('./tag-write', () => ({ queueContactEvent: vi.fn(async () => undefined) }));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (_ctx: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      $queryRaw: async (strings: TemplateStringsArray) =>
        strings.join('?').includes('FROM contacts') ? [{ id: CONTACT }] : [{ value: null }],
      $executeRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
        h.written.push(values);
        return 1;
      },
    }),
}));

import { writeContactField } from './field-write';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const CONTACT = '22222222-2222-4222-8222-222222222222';
const FIELD = '33333333-3333-4333-8333-333333333333';

const db = {
  from: () => {
    const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: h.definition, error: null }) };
    return chain;
  },
} as never;

const write = (value: string) => writeContactField(db, ACCOUNT, CONTACT, `custom:${FIELD}`, value);

describe('writeContactField with typed custom fields', () => {
  beforeEach(() => {
    h.written = [];
  });

  it('refuses a value that is not a number for a number field', async () => {
    h.definition = { id: FIELD, field_type: 'number', field_options: null };
    expect(await write('lots')).toBe(false);
    expect(h.written).toEqual([]);
  });

  it('stores a number field value in its normal form', async () => {
    h.definition = { id: FIELD, field_type: 'number', field_options: null };
    expect(await write(' +0042 ')).toBe(true);
    expect(h.written[0]).toContain('42');
  });

  it('stores a choice with the field\'s own spelling and refuses other values', async () => {
    h.definition = { id: FIELD, field_type: 'choice', field_options: ['Starter', 'Growth'] };
    expect(await write('growth')).toBe(true);
    expect(h.written[0]).toContain('Growth');
    expect(await write('Enterprise')).toBe(false);
    expect(h.written).toHaveLength(1);
  });

  it('writes a text field value as given', async () => {
    h.definition = { id: FIELD, field_type: 'text', field_options: null };
    expect(await write('  any text ')).toBe(true);
    expect(h.written[0]).toContain('  any text ');
  });
});
