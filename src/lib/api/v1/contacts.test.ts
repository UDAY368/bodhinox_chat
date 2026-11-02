import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DataClient } from '@/lib/data/types';

// Mock the two collaborators `setContactTags` writes through so the
// tests can assert exactly which joins it adds and removes.
const resolveImportTagIds = vi.fn();
vi.mock('@/lib/contacts/resolve-import-tags', () => ({
  resolveImportTagIds: (...args: unknown[]) => resolveImportTagIds(...args),
}));
const addContactTagAndDispatch = vi.fn();
vi.mock('@/lib/contacts/tag-events', () => ({
  addContactTagAndDispatch: (...args: unknown[]) =>
    addContactTagAndDispatch(...args),
}));

import {
  resolveAuditUserId,
  serializeContact,
  findOrCreateContact,
  setContactTags,
  ContactError,
} from './contacts';

describe('serializeContact', () => {
  it('flattens contact_tags(tags(*)) onto a tags array and nulls missing fields', () => {
    const row = {
      id: 'c1',
      phone: '+14155550123',
      name: 'Jane',
      email: null,
      company: 'Acme',
      avatar_url: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
      contact_tags: [
        { tags: { id: 't1', name: 'vip', color: '#fff' } },
        { tags: null }, // orphaned join — dropped
      ],
    };
    expect(serializeContact(row)).toEqual({
      id: 'c1',
      phone: '+14155550123',
      name: 'Jane',
      email: null,
      company: 'Acme',
      avatar_url: null,
      tags: [{ id: 't1', name: 'vip', color: '#fff' }],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
    });
  });

  it('tolerates a row with no contact_tags key', () => {
    const row = {
      id: 'c2',
      phone: '+1',
      name: null,
      email: null,
      company: null,
      avatar_url: null,
      created_at: 'a',
      updated_at: 'b',
    };
    expect(serializeContact(row).tags).toEqual([]);
  });
});

describe('findOrCreateContact', () => {
  const noopDb = {} as DataClient;

  it('rejects a non-E.164 phone with a 400 ContactError', async () => {
    await expect(
      findOrCreateContact(noopDb, 'acc', 'user', { phone: 'not-a-number' })
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      findOrCreateContact(noopDb, 'acc', 'user', { phone: 'not-a-number' })
    ).rejects.toBeInstanceOf(ContactError);
  });

  it('rejects a number without a leading + before any DB call (#586)', async () => {
    // "4155551212" is a US national number to the integrator but Meta
    // would deliver it to +41 (Switzerland); persisting it would repeat
    // that on every later send. Digits with a country code but no `+`
    // are refused too — the API can't tell the two apart.
    for (const phone of ['4155551212', '14155551212', '+1234567']) {
      await expect(
        findOrCreateContact(noopDb, 'acc', 'user', { phone })
      ).rejects.toMatchObject({ status: 400 });
    }
  });
});

describe('setContactTags', () => {
  /**
   * Fake just enough of the Supabase query builder for the two
   * `contact_tags` calls `setContactTags` makes: the current-joins read
   * and the diff delete. Records which tag ids were removed.
   */
  function fakeContactTagsDb(currentTagIds: string[]) {
    const removed: string[] = [];
    const builder = {
      select: () => ({
        eq: async () => ({
          data: currentTagIds.map((tag_id) => ({ tag_id })),
          error: null,
        }),
      }),
      delete: () => ({
        eq: () => ({
          in: async (_col: string, ids: string[]) => {
            removed.push(...ids);
            return { error: null };
          },
        }),
      }),
    };
    const db = {
      from: (table: string) => {
        expect(table).toBe('contact_tags');
        return builder;
      },
    } as unknown as DataClient;
    return { db, removed };
  }

  // `resolveImportTagIds` returns EVERY tag in the account (it loads them
  // all for case-insensitive matching), not just the requested names.
  const allAccountTags = new Map([
    ['a', 'tag-a'],
    ['b', 'tag-b'],
    ['c', 'tag-c'],
  ]);

  beforeEach(() => {
    resolveImportTagIds.mockReset();
    addContactTagAndDispatch.mockReset();
    resolveImportTagIds.mockResolvedValue({
      tagIdByKey: allAccountTags,
      skippedNames: [],
    });
    addContactTagAndDispatch.mockResolvedValue({
      added: true,
      dispatched: false,
    });
  });

  it('only attaches the requested tags and removes unrelated ones (#560)', async () => {
    // Contact currently has c; account also has a and b; request is ["a"].
    const { db, removed } = fakeContactTagsDb(['tag-c']);

    await setContactTags(db, 'acc', 'user', 'c1', ['a']);

    const added = addContactTagAndDispatch.mock.calls.map(
      ([input]) => (input as { tagId: string }).tagId
    );
    expect(added).toEqual(['tag-a']);
    expect(removed).toEqual(['tag-c']);
  });

  it('normalizes requested names like resolveImportTagIds (trim, case, empty, dupes)', async () => {
    const { db, removed } = fakeContactTagsDb([]);

    await setContactTags(db, 'acc', 'user', 'c1', [' A ', 'a', 'B', '', '  ']);

    const added = addContactTagAndDispatch.mock.calls.map(
      ([input]) => (input as { tagId: string }).tagId
    );
    expect(added.sort()).toEqual(['tag-a', 'tag-b']);
    expect(removed).toEqual([]);
  });

  it('clears every tag when passed an empty list', async () => {
    const { db, removed } = fakeContactTagsDb(['tag-a', 'tag-c']);

    await setContactTags(db, 'acc', 'user', 'c1', []);

    expect(addContactTagAndDispatch).not.toHaveBeenCalled();
    expect(removed.sort()).toEqual(['tag-a', 'tag-c']);
  });
});

describe('resolveAuditUserId with several WhatsApp numbers', () => {
  function auditDb(configs: Record<string, unknown>[], owner = 'owner-1'): DataClient {
    return {
      from(table: string) {
        const filters: Record<string, unknown> = {};
        const b: Record<string, unknown> = {
          select: () => b,
          eq: (field: string, value: unknown) => { filters[field] = value; return b; },
          maybeSingle: async () => {
            if (table === 'accounts') return { data: { owner_user_id: owner }, error: null };
            const rows = configs.filter((c) => filters.is_default === undefined || c.is_default === filters.is_default);
            return rows.length > 1
              ? { data: null, error: { message: 'multiple rows' } }
              : { data: rows[0] ?? null, error: null };
          },
        };
        return b;
      },
    } as unknown as DataClient;
  }

  it("attributes to the default number's owner, not the account owner", async () => {
    const db = auditDb([
      { id: 'b', user_id: 'second-owner', is_default: false },
      { id: 'a', user_id: 'default-owner', is_default: true },
    ]);
    await expect(resolveAuditUserId(db, 'acct-1')).resolves.toBe('default-owner');
  });

  it('keeps the single-number owner and falls back to the account owner with no number', async () => {
    await expect(resolveAuditUserId(auditDb([{ id: 'a', user_id: 'only-owner', is_default: true }]), 'acct-1')).resolves.toBe('only-owner');
    await expect(resolveAuditUserId(auditDb([]), 'acct-1')).resolves.toBe('owner-1');
  });
});
