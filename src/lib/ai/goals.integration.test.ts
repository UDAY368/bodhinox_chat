/// <reference types="vite/client" />
// Stage 5 (5G) AI goals on a real PostgreSQL: captured lead answers land on
// the run's own contact only (never another contact or another workspace's
// custom field), a retried turn does not call the model twice, and the AI
// settings write that carries Instagram goals is refused by the proxy without
// the CSRF proof. The model is stubbed; nothing reaches a provider or Meta.
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ generateReply: vi.fn() }));
vi.mock('./generate', async (importOriginal) => ({ ...(await importOriginal<typeof import('./generate')>()), generateReply: mocks.generateReply }));
vi.mock('./config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config')>()),
  loadAiConfig: vi.fn(async () => ({ provider: 'openai', model: 'test-model', systemPrompt: null })),
}));
vi.mock('./budget', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./budget')>()),
  reserveAi: vi.fn(async () => ({ id: 'test' })), settleAi: vi.fn(async () => {}), failAi: vi.fn(async () => {}),
}));

import { disconnectDatabases } from '@/lib/db/prisma';
import {
  cleanupTenants, closeFixture, createTenantPair, fixtureDatabaseUrls, fixtureOwnerPool, signedRequest, type TenantPair,
} from '@/test/tenancy/fixtures';
import type { FlowNodeRow, FlowRunRow, ParsedInbound } from '@/lib/flows/types';
import { proxy } from '@/proxy';
import { instagramAutoReplyGoals, runGoalTurn } from './goals';

const databases = fixtureDatabaseUrls();

describe.skipIf(!databases)('AI goals (real database)', () => {
  let pair: TenantPair;
  let otherContact = '';

  beforeAll(async () => {
    pair = await createTenantPair({ label: 's5goal' });
    otherContact = (await fixtureOwnerPool().query('INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,$3,$4) RETURNING id',
      [pair.a.accountId, pair.a.users.owner.userId, `+9199${String(Date.now()).slice(-8)}`, 'Other lead'])).rows[0].id;
  }, 120000);
  afterAll(async () => {
    if (pair) {
      await fixtureOwnerPool().query('DELETE FROM outbound_intents WHERE account_id = ANY($1::uuid[])', [[pair.a.accountId, pair.b.accountId]]);
      await cleanupTenants([pair.a.accountId, pair.b.accountId]);
    }
    await closeFixture();
    await disconnectDatabases();
  }, 60000);

  it('writes captured answers to the run contact only, and a retried turn does not ask the model again', async () => {
    const { a, b } = pair;
    const aField = `custom:${a.ids.custom_fields}`, bField = `custom:${b.ids.custom_fields}`;
    const email = `lead-${randomUUID().slice(0, 8)}@shop.example`;
    mocks.generateReply.mockResolvedValue({
      text: JSON.stringify({ values: { [aField]: 'Pune', [bField]: 'tamper' }, confidence: { [aField]: 0.99, [bField]: 0.99 } }),
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const run = { id: randomUUID(), account_id: a.accountId, user_id: a.users.owner.userId, contact_id: a.contactId,
      conversation_id: a.conversationId, transition_seq: 1, vars: {} } as unknown as FlowRunRow;
    const node = { node_key: 'ai', node_type: 'ai_reply', config: { next_node_key: 'n', handoff_next: 'h', finish_next: 'f',
      goals: [{ type: 'capture_lead', fields: ['email', aField, bField], on_refusal: 'continue' }] } } as unknown as FlowNodeRow;
    const message = { kind: 'text', text: `it is ${email}, I live in Pune`, meta_message_id: `wamid.${randomUUID()}` } as ParsedInbound;
    const bValuesBefore = (await fixtureOwnerPool().query('SELECT count(*)::int AS n FROM contact_custom_values WHERE custom_field_id=$1', [b.ids.custom_fields])).rows[0].n;

    const first = await runGoalTurn(run, node, message);
    const second = await runGoalTurn(run, node, message);
    expect(mocks.generateReply).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ vars: { ai_lead_email: email } });
    expect(second).toMatchObject({ vars: { ai_lead_email: email } });

    const pool = fixtureOwnerPool();
    expect((await pool.query('SELECT email FROM contacts WHERE id=$1', [a.contactId])).rows[0].email).toBe(email);
    expect((await pool.query('SELECT email FROM contacts WHERE id=$1', [otherContact])).rows[0].email).toBeNull();
    expect((await pool.query('SELECT value FROM contact_custom_values WHERE contact_id=$1 AND custom_field_id=$2', [a.contactId, a.ids.custom_fields])).rows[0]?.value).toBe('Pune');
    // Another workspace's custom field is never written, for any contact.
    expect((await pool.query('SELECT count(*)::int AS n FROM contact_custom_values WHERE custom_field_id=$1', [b.ids.custom_fields])).rows[0].n).toBe(bValuesBefore);
    expect((await pool.query('SELECT email FROM contacts WHERE id=$1', [b.contactId])).rows[0].email).not.toBe(email);
  }, 60000);

  it('the Instagram auto-reply moves past a link this conversation already sent, never counting another workspace', async () => {
    const { a, b } = pair;
    const url = `https://shop.example/${randomUUID().slice(0, 8)}`;
    const pool = fixtureOwnerPool();
    await pool.query(`INSERT INTO ai_workspace_settings(account_id, instagram_goals) VALUES($1, $2::jsonb)
      ON CONFLICT (account_id) DO UPDATE SET instagram_goals=EXCLUDED.instagram_goals`,
    [a.accountId, JSON.stringify([{ type: 'share_link', url }, { type: 'grow_followers' }])]);
    const goals = () => instagramAutoReplyGoals({ accountId: a.accountId, conversationId: a.conversationId, contactId: a.contactId,
      inboundMessageId: null, latestText: 'hi' });
    // The link sent in another workspace's conversation does not count.
    await pool.query(`INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,status)
      VALUES($1,$2,'bot','text',$3,'sent')`, [b.accountId, b.conversationId, `See ${url}`]);
    expect(await goals()).toMatchObject({ kind: 'instructions', allowedUrls: [url] });
    await pool.query(`INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,status)
      VALUES($1,$2,'bot','text',$3,'sent')`, [a.accountId, a.conversationId, `Here it is: ${url}`]);
    const next = await goals();
    expect(next).toMatchObject({ kind: 'instructions', allowedUrls: [] });
    expect(next.kind === 'instructions' ? next.instructions : '').toContain('follow');
    await pool.query('UPDATE ai_workspace_settings SET instagram_goals=\'[]\'::jsonb WHERE account_id=$1', [a.accountId]);
  }, 60000);

  it('the proxy refuses an AI settings write without the CSRF proof', async () => {
    const request = await signedRequest(pair.a.users.admin, 'PUT', '/api/ai/settings', { instagram_goals: [{ type: 'grow_followers' }] }, { omitCsrf: true });
    const response = await proxy(new NextRequest(request));
    expect(response.status).toBe(403);
    const stored = await fixtureOwnerPool().query('SELECT instagram_goals FROM ai_workspace_settings WHERE account_id=$1', [pair.a.accountId]);
    expect(stored.rows[0]?.instagram_goals ?? []).toEqual([]);
  }, 60000);
});
