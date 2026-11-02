import { beforeEach, describe, expect, it, vi } from 'vitest';

// If any of these load while notes run, a note could reach a WhatsApp send
// path: each factory records that it was imported, and every export throws.
const loaded = vi.hoisted(() => new Set<string>());
const trap = (name: string) => {
  loaded.add(name);
  return new Proxy({}, { get: (_t, key) => (key === 'then' ? undefined : () => { throw new Error(`${name} used by notes`); }) });
};
vi.mock('@/lib/whatsapp/send-message', () => trap('send-message'));
vi.mock('@/lib/whatsapp/meta-api', () => trap('meta-api'));
vi.mock('@/lib/whatsapp/interactive-delivery', () => trap('interactive-delivery'));
vi.mock('@/lib/jobs/dispatch', () => trap('dispatch'));
vi.mock('@/lib/jobs/queue', () => trap('queue'));

import {
  createConversationNote,
  deleteConversationNote,
  MAX_NOTE_MENTIONS,
  NoteError,
  noteExcerpt,
  normalizeMentions,
  normalizeNoteBody,
  updateConversationNote,
} from './notes';
import type { TenantTransaction } from '@/lib/db/tenant';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const AUTHOR = '22222222-2222-4222-8222-222222222222';
const MEMBER = '33333333-3333-4333-8333-333333333333';
const FORMER = '44444444-4444-4444-8444-444444444444';
const CONV = '55555555-5555-4555-8555-555555555555';
const NOTE = '66666666-6666-4666-8666-666666666666';
const CONTACT = '77777777-7777-4777-8777-777777777777';
const actor = { accountId: ACCOUNT, userId: AUTHOR, role: 'agent' as const };

/** A fake transaction that answers by SQL text and records every statement. */
function fakeTx(state: { members?: string[]; noteAuthor?: string; conversation?: boolean } = {}) {
  const statements: { sql: string; values: unknown[] }[] = [];
  const members = state.members ?? [AUTHOR, MEMBER];
  const noteRow = (body = 'hi', mentions: string[] = []) => ({
    id: NOTE, conversation_id: CONV, author_id: state.noteAuthor ?? AUTHOR, body, mentions,
    created_at: new Date('2026-11-02T10:00:00Z'), edited_at: null,
  });
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?').replace(/\s+/g, ' ');
    statements.push({ sql, values });
    if (/FROM conversations/.test(sql)) return state.conversation === false ? [] : [{ id: CONV, contact_id: CONTACT }];
    if (/FROM account_memberships m/.test(sql)) {
      const ids = values.find(Array.isArray) as string[];
      return ids.filter((id) => members.includes(id)).map((user_id) => ({ user_id, in_app: true, email: false }));
    }
    if (/FROM account_memberships/.test(sql)) {
      const ids = values.find(Array.isArray) as string[];
      return ids.filter((id) => members.includes(id)).map((user_id) => ({ user_id }));
    }
    if (/FROM profiles/.test(sql)) return [{ full_name: 'Asha' }];
    if (/INSERT INTO conversation_notes/.test(sql)) return [noteRow(values[3] as string, values[4] as string[])];
    if (/UPDATE conversation_notes SET body/.test(sql)) return [noteRow(values[0] as string, values[1] as string[])];
    if (/UPDATE conversation_notes SET deleted_at/.test(sql)) return 1;
    if (/FROM conversation_notes/.test(sql)) return [noteRow('old', [MEMBER])];
    if (/INSERT INTO notifications|INSERT INTO notification_email_queue/.test(sql)) return 1;
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  const tx = { $queryRaw: vi.fn(async (s: TemplateStringsArray, ...v: unknown[]) => run(s, ...v)),
    $executeRaw: vi.fn(async (s: TemplateStringsArray, ...v: unknown[]) => run(s, ...v)) };
  return { tx: tx as unknown as TenantTransaction, statements };
}

beforeEach(() => loaded.clear());

describe('input rules', () => {
  it('trims the body and enforces 1..4000 characters', () => {
    expect(normalizeNoteBody('  hello  ')).toBe('hello');
    for (const bad of ['', '   ', 5, null, 'x'.repeat(4001)]) {
      expect(() => normalizeNoteBody(bad)).toThrow(NoteError);
    }
    expect(normalizeNoteBody('x'.repeat(4000))).toHaveLength(4000);
  });

  it('accepts unique member ids up to the cap', () => {
    expect(normalizeMentions(undefined)).toEqual([]);
    expect(normalizeMentions([MEMBER, MEMBER.toUpperCase()])).toEqual([MEMBER]);
    expect(() => normalizeMentions(['not-a-uuid'])).toThrow(NoteError);
    expect(() => normalizeMentions(MEMBER)).toThrow(NoteError);
    const many = Array.from({ length: MAX_NOTE_MENTIONS + 1 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect(() => normalizeMentions(many)).toThrow(NoteError);
  });

  it('flattens and shortens the notification excerpt', () => {
    expect(noteExcerpt('a\n\n b')).toBe('a b');
    expect(noteExcerpt('x'.repeat(200))).toHaveLength(140);
  });
});

describe('createConversationNote', () => {
  it('stores only current members as mentions and notifies them, never the author', async () => {
    const { tx, statements } = fakeTx();
    const { note, notified } = await createConversationNote(tx, actor, CONV, { body: ' Call @Ravi ', mentions: [MEMBER, FORMER, AUTHOR] });
    expect(note).toMatchObject({ id: NOTE, body: 'Call @Ravi', mentions: [MEMBER, AUTHOR] });
    expect(notified).toEqual([MEMBER]);
    const insert = statements.find((s) => s.sql.includes('INSERT INTO notifications'))!;
    expect(insert.values).toContain('mention');
    expect(insert.values).toContain(`/inbox?c=${CONV}`);
    expect(insert.values).toContain(`note-mention:${NOTE}`);
    expect(insert.values).toContain('Asha mentioned you in a note');
    expect(statements.filter((s) => s.sql.includes('INSERT INTO notifications'))).toHaveLength(1);
  });

  it('does not notify when nobody is mentioned', async () => {
    const { tx, statements } = fakeTx();
    expect((await createConversationNote(tx, actor, CONV, { body: 'just a note' })).notified).toEqual([]);
    expect(statements.some((s) => /notifications|profiles/.test(s.sql))).toBe(false);
  });

  it('refuses an unknown conversation before writing', async () => {
    const { tx, statements } = fakeTx({ conversation: false });
    await expect(createConversationNote(tx, actor, CONV, { body: 'x' })).rejects.toMatchObject({ code: 'not_found', status: 404 });
    await expect(createConversationNote(tx, actor, 'nope', { body: 'x' })).rejects.toMatchObject({ code: 'not_found' });
    expect(statements.some((s) => s.sql.includes('INSERT'))).toBe(false);
  });

  it('never goes through a WhatsApp send path, the jobs queue or messages', async () => {
    const { tx, statements } = fakeTx();
    await createConversationNote(tx, actor, CONV, { body: 'internal', mentions: [MEMBER] });
    await updateConversationNote(tx, actor, CONV, NOTE, { body: 'edited', mentions: [MEMBER] });
    await deleteConversationNote(tx, actor, CONV, NOTE);
    expect([...loaded]).toEqual([]);
    const writes = statements.filter((s) => /^\s*(INSERT|UPDATE|DELETE)/i.test(s.sql));
    for (const write of writes) {
      expect(write.sql).toMatch(/^\s*(INSERT INTO|UPDATE) (conversation_notes|notifications|notification_email_queue)\b/);
    }
    expect(statements.some((s) => /\b(messages|jobs|outbound_intents)\b/.test(s.sql))).toBe(false);
  });
});

describe('updateConversationNote', () => {
  it('lets only the author edit', async () => {
    const { tx, statements } = fakeTx({ noteAuthor: MEMBER });
    await expect(updateConversationNote(tx, { ...actor, role: 'admin' }, CONV, NOTE, { body: 'x' }))
      .rejects.toMatchObject({ code: 'forbidden', status: 403 });
    expect(statements.some((s) => s.sql.includes('UPDATE'))).toBe(false);
  });

  it('re-sends the mention with the same dedupe key so only new members are notified', async () => {
    const { tx, statements } = fakeTx();
    const { note } = await updateConversationNote(tx, actor, CONV, NOTE, { body: 'new text', mentions: [MEMBER] });
    expect(note).toMatchObject({ body: 'new text', mentions: [MEMBER] });
    const insert = statements.find((s) => s.sql.includes('INSERT INTO notifications'))!;
    expect(insert.sql).toContain('ON CONFLICT DO NOTHING');
    expect(insert.values).toContain(`note-mention:${NOTE}`);
  });
});

describe('deleteConversationNote', () => {
  it('lets the author or an admin delete, and refuses other agents', async () => {
    await expect(deleteConversationNote(fakeTx().tx, actor, CONV, NOTE)).resolves.toBeUndefined();
    await expect(deleteConversationNote(fakeTx({ noteAuthor: MEMBER }).tx, { ...actor, role: 'admin' }, CONV, NOTE)).resolves.toBeUndefined();
    await expect(deleteConversationNote(fakeTx({ noteAuthor: MEMBER }).tx, { ...actor, role: 'owner' }, CONV, NOTE)).resolves.toBeUndefined();
    await expect(deleteConversationNote(fakeTx({ noteAuthor: MEMBER }).tx, actor, CONV, NOTE)).rejects.toMatchObject({ code: 'forbidden' });
  });
});
