import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ calls: [] as Array<[string, unknown[]]>, result: { data: [] as unknown[], error: null as unknown } }));
vi.mock('@/lib/data/client', () => ({
  createClient: () => {
    const b: Record<string, unknown> = {};
    for (const m of ['from', 'select', 'order', 'limit', 'or']) b[m] = (...args: unknown[]) => { h.calls.push([m, args]); return b; };
    b.then = (resolve: (v: unknown) => unknown) => Promise.resolve(h.result).then(resolve);
    return b;
  },
}));

import { pickerSearchFilter, searchContacts } from './contact-search';

beforeEach(() => {
  h.calls = [];
  h.result = { data: [{ id: 'c1', name: 'Asha', phone: '919876543210' }], error: null };
});

describe('pickerSearchFilter', () => {
  it('matches the name, and the phone by its digits', () => {
    expect(pickerSearchFilter('Asha')).toBe('name.ilike.%Asha%');
    expect(pickerSearchFilter(' +91 98765 ')).toBe('name.ilike.%+91 98765%,phone.ilike.%9198765%');
  });

  it('drops characters that would split the filter or act as wildcards', () => {
    expect(pickerSearchFilter('Sharma, Raj (Pune)%_*')).toBe('name.ilike.%Sharma Raj Pune%');
    expect(pickerSearchFilter('  ,() ')).toBeNull();
  });
});

describe('searchContacts', () => {
  it('asks for a bounded page, filtered on name or phone', async () => {
    expect(await searchContacts('9876')).toEqual([{ id: 'c1', name: 'Asha', phone: '919876543210' }]);
    expect(h.calls).toContainEqual(['from', ['contacts']]);
    expect(h.calls).toContainEqual(['limit', [20]]);
    expect(h.calls).toContainEqual(['or', ['name.ilike.%9876%,phone.ilike.%9876%']]);
  });

  it('lists the first contacts when nothing is typed, and never more than 50', async () => {
    await searchContacts('', 500);
    expect(h.calls.some(([m]) => m === 'or')).toBe(false);
    expect(h.calls).toContainEqual(['limit', [50]]);
  });

  it('throws when the search fails, so the picker can say so', async () => {
    h.result = { data: [], error: { message: 'x' } };
    await expect(searchContacts('a')).rejects.toThrow();
  });
});
