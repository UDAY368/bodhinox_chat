import { describe, it, expect } from "vitest";
import {
  matchesContactFilters,
  normalizeConversation,
  loadInboxConversations,
  mergeConversations,
  nextSyncCursor,
  INBOX_SYNC_OVERLAP_MS,
} from "./conversations";
import type { Conversation } from "@/types";
import { buildQuery } from '@/lib/data/builder';
import type { DataClient } from '@/lib/data/types';

function makeConversation(
  contact: Partial<Conversation["contact"]> | null,
): Conversation {
  return {
    id: "c1",
    user_id: "u1",
    contact_id: "ct1",
    status: "open",
    unread_count: 0,
    created_at: "",
    updated_at: "",
    contact: contact
      ? {
          id: "ct1",
          user_id: "u1",
          account_id: "a1",
          phone: "123",
          created_at: "",
          updated_at: "",
          ...contact,
        }
      : undefined,
  };
}

const tag = (id: string, name = id) => ({
  id,
  user_id: "u1",
  name,
  color: "#fff",
  created_at: "",
});

it('loads every conversation beyond the default 1000-row page for Inbox filtering', async () => {
  const rows = Array.from({ length: 1001 }, (_, i) => ({ ...makeConversation(null), id: `c${i}` }));
  const db = { from: (name: string) => buildQuery(name, async spec => ({
    data: rows.slice(spec.offset ?? 0, (spec.offset ?? 0) + (spec.limit ?? 1000)), error: null,
  })) } as unknown as DataClient;
  const result = await loadInboxConversations(db);
  expect(result.error).toBeNull();
  expect(result.data).toHaveLength(1001);
  expect(result.data?.at(-1)?.id).toBe('c1000');
});

it('reads only conversations changed since the cursor on an incremental sync', async () => {
  const specs: { filters?: unknown[] }[] = [];
  const db = { from: (name: string) => buildQuery(name, async spec => {
    specs.push(spec);
    return { data: [], error: null };
  }) } as unknown as DataClient;
  await loadInboxConversations(db, { updatedSince: '2026-11-10T10:00:00.000Z' });
  expect(specs[0].filters).toContainEqual({ field: 'updated_at', op: 'gte', value: '2026-11-10T10:00:00.000Z' });
  await loadInboxConversations(db);
  expect(specs[1].filters ?? []).not.toContainEqual(expect.objectContaining({ field: 'updated_at' }));
});

describe('incremental inbox sync', () => {
  const conv = (id: string, lastMessageAt: string | undefined, extra: Partial<Conversation> = {}) =>
    ({ ...makeConversation(null), id, last_message_at: lastMessageAt, ...extra });

  it('moves the cursor to the newest updated_at minus the overlap, never backwards', () => {
    const at = '2026-11-10T10:00:00.000Z';
    const cursor = nextSyncCursor([{ updated_at: '2026-11-10T09:00:00.000Z' }, { updated_at: at }], null);
    expect(cursor).toBe(new Date(Date.parse(at) - INBOX_SYNC_OVERLAP_MS).toISOString());
    expect(nextSyncCursor([], cursor)).toBe(cursor);
    expect(nextSyncCursor([{ updated_at: '2026-11-10T08:00:00.000Z' }], cursor)).toBe(cursor);
    expect(nextSyncCursor([], null)).toBeNull();
  });

  it('replaces changed rows, adds new ones and keeps the server order', () => {
    const prev = [conv('a', '2026-11-10T10:00:00Z'), conv('b', '2026-11-10T09:00:00Z'), conv('z', undefined)];
    const merged = mergeConversations(prev, [
      conv('b', '2026-11-10T11:00:00Z', { last_message_text: 'new' }),
      conv('c', '2026-11-10T09:30:00Z'),
    ]);
    expect(merged.map((c) => c.id)).toEqual(['b', 'a', 'c', 'z']);
    expect(merged[0].last_message_text).toBe('new');
  });

  it('keeps the open conversation read and returns the same list when nothing changed', () => {
    const prev = [conv('a', '2026-11-10T10:00:00Z', { unread_count: 0 })];
    expect(mergeConversations(prev, [])).toBe(prev);
    expect(mergeConversations(prev, [conv('a', '2026-11-10T10:05:00Z', { unread_count: 3 })], 'a')[0].unread_count).toBe(0);
    expect(mergeConversations(prev, [conv('a', '2026-11-10T10:05:00Z', { unread_count: 3 })], 'other')[0].unread_count).toBe(3);
  });
});

describe("matchesContactFilters", () => {
  it("matches everything when no filters are set", () => {
    const conv = makeConversation({ company: "Acme", tags: [tag("t1")] });
    expect(matchesContactFilters(conv, { tagIds: [], company: null })).toBe(
      true,
    );
    expect(makeConversation(null)).toBeDefined();
    expect(
      matchesContactFilters(makeConversation(null), {
        tagIds: [],
        company: null,
      }),
    ).toBe(true);
  });

  it("uses OR logic across tags", () => {
    const conv = makeConversation({ tags: [tag("t1"), tag("t2")] });
    expect(
      matchesContactFilters(conv, { tagIds: ["t2", "t9"], company: null }),
    ).toBe(true);
    expect(
      matchesContactFilters(conv, { tagIds: ["t9"], company: null }),
    ).toBe(false);
  });

  it("excludes conversations whose contact has no tags when a tag filter is active", () => {
    const conv = makeConversation({ tags: [] });
    expect(
      matchesContactFilters(conv, { tagIds: ["t1"], company: null }),
    ).toBe(false);
    expect(
      matchesContactFilters(makeConversation(null), {
        tagIds: ["t1"],
        company: null,
      }),
    ).toBe(false);
  });

  it("matches company exactly, trimming whitespace", () => {
    const conv = makeConversation({ company: "  Acme  " });
    expect(
      matchesContactFilters(conv, { tagIds: [], company: "Acme" }),
    ).toBe(true);
    expect(
      matchesContactFilters(conv, { tagIds: [], company: "Other" }),
    ).toBe(false);
  });

  it("requires both tag and company to match when both are set (AND across facets)", () => {
    const conv = makeConversation({ company: "Acme", tags: [tag("t1")] });
    expect(
      matchesContactFilters(conv, { tagIds: ["t1"], company: "Acme" }),
    ).toBe(true);
    expect(
      matchesContactFilters(conv, { tagIds: ["t1"], company: "Other" }),
    ).toBe(false);
    expect(
      matchesContactFilters(conv, { tagIds: ["tX"], company: "Acme" }),
    ).toBe(false);
  });
});

describe("normalizeConversation", () => {
  it("flattens embedded contact_tags into contact.tags", () => {
    const raw = {
      id: "c1",
      user_id: "u1",
      contact_id: "ct1",
      status: "open" as const,
      unread_count: 0,
      created_at: "",
      updated_at: "",
      contact: {
        id: "ct1",
        user_id: "u1",
        account_id: "a1",
        phone: "123",
        created_at: "",
        updated_at: "",
        contact_tags: [{ tags: tag("t1", "VIP") }, { tags: null }],
      },
    };
    const normalized = normalizeConversation(raw);
    expect(normalized.contact?.tags).toEqual([tag("t1", "VIP")]);
    // The raw join key is dropped from the flattened contact.
    expect(
      (normalized.contact as unknown as Record<string, unknown>).contact_tags,
    ).toBeUndefined();
  });

  it("passes through a conversation with no contact", () => {
    const raw = {
      id: "c1",
      user_id: "u1",
      contact_id: "ct1",
      status: "open" as const,
      unread_count: 0,
      created_at: "",
      updated_at: "",
      contact: null,
    };
    // A contactless row passes through untouched (consumers use `?.`).
    expect(normalizeConversation(raw).contact).toBeNull();
  });
});
