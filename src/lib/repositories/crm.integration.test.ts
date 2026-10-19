import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getAuthPrisma,
  getPrisma,
  getWorkerPrisma,
  disconnectDatabases,
} from '@/lib/db/prisma';
import { executeQuery } from './crm';
import { executeRpc } from './rpc';
import { browserQuery, decodeQuery } from '@/lib/data/transport';
import { buildQuery } from '@/lib/data/builder';
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';
import { signAccessToken } from '@/lib/auth/jwt';
import { withTenant } from '@/lib/db/tenant';
import { encodeEventCursor } from '@/lib/realtime/cursor';
import { GET as streamEvents } from '@/app/api/events/route';
import type { TenantContext } from '@/lib/data/types';
import { createScopedClient } from '@/lib/data/server';
import {
  insertSteps,
  loadStepsTree,
  replaceSteps,
} from '@/lib/automations/steps-tree';
config({ path: '.env.test', quiet: true });
const database = process.env.TEST_APP_DATABASE_URL ?? process.env.DATABASE_URL;
const authDatabase = process.env.TEST_AUTH_DATABASE_URL;
let fixturesCreated = false;
const userA = randomUUID(),
  userB = randomUUID(),
  accountA = randomUUID(),
  accountB = randomUUID();
const a: TenantContext = { accountId: accountA, userId: userA, role: 'owner' },
  b: TenantContext = { accountId: accountB, userId: userB, role: 'owner' };
const client =
  (context: TenantContext, browser = false) =>
  (table: string) =>
    buildQuery(table, (spec) => executeQuery(spec, context, browser));
describe.skipIf(!database || !authDatabase)(
  'CRM compatibility against constrained PostgreSQL roles',
  () => {
    beforeAll(async () => {
      process.env.DATABASE_URL = database;
      process.env.AUTH_DATABASE_URL = authDatabase;
      const identity = await getAuthPrisma().$queryRawUnsafe<
        { name: string }[]
      >('SELECT current_database() AS name');
      if (!/test/i.test(identity[0].name))
        throw new Error('Requires isolated test database');
      const app = await getPrisma().$queryRawUnsafe<
        { name: string; role: string }[]
      >('SELECT current_database() AS name,current_user AS role');
      if (!/test/i.test(app[0].name) || app[0].role !== 'bodhinox_app')
        throw new Error(
          'Requires isolated database and constrained application credentials'
        );
      await getAuthPrisma().$transaction(async (tx) => {
        for (const [user, account] of [
          [userA, accountA],
          [userB, accountB],
        ]) {
          await tx.$executeRawUnsafe(
            "INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1::uuid,$2,'Data integration','test-only-hash')",
            user,
            `${user}@example.invalid`
          );
          await tx.$executeRawUnsafe(
            "INSERT INTO accounts(id,name,owner_user_id) VALUES($1::uuid,'Data integration',$2::uuid)",
            account,
            user
          );
          await tx.$executeRawUnsafe(
            "INSERT INTO account_memberships(account_id,user_id,role) VALUES($1::uuid,$2::uuid,'owner')",
            account,
            user
          );
          await tx.$executeRawUnsafe(
            "INSERT INTO profiles(user_id,email,full_name,account_id,account_role) VALUES($1::uuid,$2,'Data integration',$3::uuid,'owner')",
            user,
            `${user}@example.invalid`,
            account
          );
        }
      });
      fixturesCreated = true;
    }, 30000);
    afterAll(async () => {
      if (fixturesCreated) {
        await getAuthPrisma().$executeRawUnsafe(
          'DELETE FROM accounts WHERE id IN($1::uuid,$2::uuid)',
          accountA,
          accountB
        );
        await getAuthPrisma().$executeRawUnsafe(
          'DELETE FROM auth_users WHERE id IN($1::uuid,$2::uuid)',
          userA,
          userB
        );
      }
      await disconnectDatabases();
    }, 30000);
    it('executes the browser presence heartbeat and persists its status without deserializing void', async () => {
      const result = await executeRpc(
        'touch_presence',
        { p_status: 'online' },
        a,
        true
      );
      expect(result).toEqual({ data: null, error: null });
      const presence = await client(a)('member_presence')
        .select('user_id,status')
        .eq('user_id', userA)
        .single();
      expect(presence.error).toBeNull();
      expect(presence.data).toEqual({ user_id: userA, status: 'online' });
      const denied = await executeRpc(
        'touch_presence',
        { p_status: 'online' },
        { accountId: accountA, role: 'viewer' },
        true
      );
      expect(denied.error?.code).toBe('42501');
    }, 30000);
    it('computes session timestamps from customer history without exposing another tenant', async () => {
      const contact = await client(a)('contacts').insert({ phone: '240019' }).select('id').single();
      expect(contact.error).toBeNull();
      const conversation = await client(a)('conversations').insert({ contact_id: contact.data!.id }).select('id,last_customer_message_at').single();
      expect(conversation.error).toBeNull();
      expect(conversation.data!.last_customer_message_at).toBeNull();
      const id = conversation.data!.id;
      const inserted = await client(a)('messages').insert([
        { conversation_id: id, sender_type: 'customer', content_type: 'text', content_text: 'Older', created_at: '2026-10-17T10:00:00Z' },
        { conversation_id: id, sender_type: 'customer', content_type: 'text', content_text: 'Latest customer', created_at: '2026-10-18T10:00:00Z' },
        { conversation_id: id, sender_type: 'bot', content_type: 'text', content_text: 'Business reply', created_at: '2026-10-19T12:00:00Z' },
      ]);
      expect(inserted.error).toBeNull();
      const visible = await client(a, true)('conversations').select('last_customer_message_at').eq('id', id).single();
      expect(visible.error).toBeNull();
      expect(Date.parse(visible.data!.last_customer_message_at)).toBe(Date.parse('2026-10-18T10:00:00Z'));
      const foreign = await client(b, true)('conversations').select('id,last_customer_message_at').eq('id', id).maybeSingle();
      expect(foreign).toMatchObject({ data: null, error: null });
    }, 30000);
    it('stamps contact edits on the server and marks only an authorized conversation read', async () => {
      const contact = await client(a)('contacts')
        .insert({ phone: '552211' })
        .select('id,updated_at')
        .single();
      expect(contact.error).toBeNull();
      const prior = '2000-01-01T00:00:00.000Z';
      const edited = await browserQuery(
        {
          resource: 'contacts',
          operation: 'update',
          values: { name: 'Edited', updated_at: prior },
          filters: [{ field: 'id', op: 'eq', value: contact.data!.id }],
          projection: 'name,updated_at',
          returning: true,
          cardinality: 'single',
        },
        async (url, init) => {
          const request = new Request(`https://crm.test${url}`, init);
          const query = decodeQuery(request, 'contacts', await request.json());
          return Response.json(await executeQuery(query, a, true));
        }
      );
      expect(edited.error).toBeNull();
      expect(edited.data?.name).toBe('Edited');
      expect(new Date(edited.data!.updated_at).getTime()).toBeGreaterThan(
        new Date(prior).getTime()
      );
      const conversation = await client(a)('conversations')
        .insert({ contact_id: contact.data!.id, unread_count: 3 })
        .select('id')
        .single();
      expect(conversation.error).toBeNull();
      const args = { p_conversation_id: conversation.data!.id };
      expect(
        (await executeRpc('mark_conversation_read', args, b, true)).error?.code
      ).toBe('RECORD_NOT_FOUND');
      expect(
        (
          await executeRpc(
            'mark_conversation_read',
            args,
            { ...a, role: 'viewer' },
            true
          )
        ).error?.code
      ).toBe('FORBIDDEN');
      expect(
        (
          await client(a)('conversations')
            .select('unread_count')
            .eq('id', args.p_conversation_id)
            .single()
        ).data?.unread_count
      ).toBe(3);
      expect(await executeRpc('mark_conversation_read', args, a, true)).toEqual(
        { data: null, error: null }
      );
      expect(
        (
          await client(a)('conversations')
            .select('unread_count')
            .eq('id', args.p_conversation_id)
            .single()
        ).data?.unread_count
      ).toBe(0);
      const config = await client(a)('whatsapp_config').insert({
        phone_number_id: '991122334455',
        access_token: 'fixture-unused-encrypted-value',
        verify_token: 'fixture-unused-encrypted-value',
      });
      expect(config.error).toBeNull();
      expect(
        (
          await executeRpc(
            'set_media_retention',
            { p_enabled: false },
            { ...a, role: 'agent' },
            true
          )
        ).error?.code
      ).toBe('FORBIDDEN');
      expect(
        await executeRpc('set_media_retention', { p_enabled: false }, a, true)
      ).toEqual({ data: null, error: null });
      expect(
        (
          await client(a)('whatsapp_config')
            .select('mirror_inbound_media')
            .single()
        ).data?.mirror_inbound_media
      ).toBe(false);
    }, 30000);
    it('persists, filters, orders, counts and returns nested tags', async () => {
      const contacts = client(a);
      const inserted = await contacts('contacts')
        .insert({ phone: '987654321', name: "Alice'); SELECT 1;--" })
        .select('*')
        .single();
      expect(inserted.error).toBeNull();
      expect(inserted.data?.account_id).toBe(accountA);
      const duplicate = await contacts('contacts').insert({
        phone: '987654321',
      });
      expect(duplicate.error?.code).toBe('23505');
      const tag = await contacts('tags')
        .insert({ name: 'Priority', color: '#123456' })
        .select('*')
        .single();
      expect(tag.error).toBeNull();
      const link = await contacts('contact_tags')
        .upsert(
          { contact_id: inserted.data!.id, tag_id: tag.data!.id },
          { onConflict: 'contact_id,tag_id', ignoreDuplicates: true }
        )
        .select('*');
      expect(link.error).toBeNull();
      const listed = await contacts('contacts')
        .select('id,name,contact_tags(tags(id,name))', { count: 'exact' })
        .eq('id', inserted.data!.id)
        .order('name')
        .range(0, 9);
      expect(listed.error).toBeNull();
      expect(listed.count).toBe(1);
      expect(listed.data?.[0].contact_tags).toEqual([
        { tags: { id: tag.data!.id, name: 'Priority' } },
      ]);
      const updated = await contacts('contacts')
        .update({ name: 'Updated' })
        .eq('id', inserted.data!.id)
        .select('id,name')
        .single();
      expect(updated.data?.name).toBe('Updated');
      const missing = await client(b)('contacts')
        .select('*')
        .eq('id', inserted.data!.id)
        .maybeSingle();
      expect(missing).toMatchObject({ data: null, error: null });
      const rpc = await executeRpc(
        'filter_contacts_by_tags',
        { p_tag_ids: [tag.data!.id] },
        a
      );
      expect(rpc.error).toBeNull();
      expect(rpc.data).toHaveLength(1);
    }, 30000);
    it('rejects foreign related IDs before persisting a join', async () => {
      const ca = await client(a)('contacts')
        .insert({ phone: '777333' })
        .select('*')
        .single();
      const tb = await client(b)('tags')
        .insert({ name: 'Foreign' })
        .select('*')
        .single();
      const result = await client(a)('contact_tags').insert({
        contact_id: ca.data!.id,
        tag_id: tb.data!.id,
      });
      expect(result.error?.code).toBe('RELATED_RECORD_FORBIDDEN');
    }, 30000);
    it('masks settings credentials and denies viewer writes', async () => {
      const result = await client(
        { ...a, role: 'viewer' },
        true
      )('contacts').insert({ phone: '111333' });
      expect(result.error?.code).toBe('FORBIDDEN');
      const privateField = await client(
        a,
        true
      )('whatsapp_config').select('access_token');
      expect(privateField.error).not.toBeNull();
    }, 30000);
    it('persists nested automation steps and flow nodes under the request tenant only', async () => {
      const db = createScopedClient(a);
      const foreignDb = createScopedClient(b);
      const automation = await db
        .from('automations')
        .insert({ name: 'Scoped tree', trigger_type: 'keyword_match' })
        .select('id')
        .single();
      expect(automation.error).toBeNull();
      const id = automation.data!.id;
      expect(
        await insertSteps(
          id,
          [
            {
              step_type: 'condition',
              step_config: {},
              branches: {
                yes: [
                  { step_type: 'send_message', step_config: { text: 'Hi' } },
                ],
              },
            },
          ],
          db
        )
      ).toBeNull();
      expect((await loadStepsTree(id, db))[0].branches.yes).toHaveLength(1);
      expect(await loadStepsTree(id, foreignDb)).toEqual([]);
      expect(
        await insertSteps(
          id,
          [{ step_type: 'send_message', step_config: {} }],
          foreignDb
        )
      ).toMatch(/outside this tenant/);
      expect(
        await replaceSteps(
          id,
          [{ step_type: 'send_message', step_config: { text: 'Replaced' } }],
          db
        )
      ).toBeNull();
      expect(await loadStepsTree(id, db)).toHaveLength(1);
      const flow = await db
        .from('flows')
        .insert({ name: 'Scoped flow', trigger_type: 'manual' })
        .select('id')
        .single();
      expect(flow.error).toBeNull();
      const flowId = flow.data!.id;
      expect(
        (
          await db.from('flow_nodes').insert({
            flow_id: flowId,
            node_key: 'start',
            node_type: 'send_message',
            config: {},
          })
        ).error
      ).toBeNull();
      expect(
        (
          await db
            .from('flows')
            .update({ name: 'Renamed' })
            .eq('id', flowId)
            .select('name')
            .single()
        ).data?.name
      ).toBe('Renamed');
      expect(
        (
          await foreignDb.from('flow_nodes').insert({
            flow_id: flowId,
            node_key: 'foreign',
            node_type: 'send_message',
            config: {},
          })
        ).error?.code
      ).toBe('RELATED_RECORD_FORBIDDEN');
      await foreignDb.from('flows').delete().eq('id', flowId);
      expect(
        (await db.from('flows').select('id').eq('id', flowId).single()).data?.id
      ).toBe(flowId);
      expect(
        (await db.from('flows').delete().eq('id', flowId)).error
      ).toBeNull();
      expect(
        (await db.from('flow_nodes').select('id').eq('flow_id', flowId)).data
      ).toEqual([]);
    }, 30000);
    it('streams only authorized outbox events and advances across a full cursor batch', async () => {
      const keys = await generateKeyPair('RS256', { extractable: true });
      process.env.AUTH_JWT_PRIVATE_KEY = await exportPKCS8(keys.privateKey);
      process.env.AUTH_JWT_PUBLIC_KEY = await exportSPKI(keys.publicKey);
      process.env.AUTH_JWT_KID = 'crm-sse-test';
      process.env.AUTH_JWT_ISSUER = 'https://crm.sse.test';
      process.env.AUTH_JWT_AUDIENCE = 'crm-sse-test';
      const sessionId = randomUUID();
      await getAuthPrisma().$executeRawUnsafe(
        'UPDATE auth_users SET email_verified_at=NOW() WHERE id=$1::uuid',
        userA
      );
      await getAuthPrisma().$executeRawUnsafe(
        "INSERT INTO auth_sessions(id,user_id,account_id,csrf_hash,expires_at) VALUES($1::uuid,$2::uuid,$3::uuid,'test-only-csrf',NOW()+interval '1 hour')",
        sessionId,
        userA,
        accountA
      );
      const token = await signAccessToken({
        userId: userA,
        accountId: accountA,
        sessionId,
      });
      const stamp = new Date(Date.now() - 1000).toISOString();
      const resumeAt = new Date(Date.now() - 5000).toISOString();
      // One transaction deliberately gives 201 events the same microsecond timestamp.
      await withTenant(a, (tx) =>
        tx.$executeRawUnsafe(
          "INSERT INTO outbox_events(account_id,event_type,payload,created_at) SELECT $1::uuid,'messages.UPDATE',jsonb_build_object('table','messages','eventType','UPDATE','new',jsonb_build_object('id',n),'old','{}'::jsonb),$2::timestamptz FROM generate_series(1,201) n",
          accountA,
          stamp
        )
      );
      await withTenant(b, (tx) =>
        tx.$executeRawUnsafe(
          'INSERT INTO outbox_events(account_id,event_type,payload,created_at) VALUES($1::uuid,\'messages.UPDATE\',\'{"table":"messages","eventType":"UPDATE","new":{"id":"foreign"},"old":{}}\'::jsonb,$2::timestamptz)',
          accountB,
          stamp
        )
      );
      const abort = new AbortController();
      const cursor = encodeEventCursor({
        at: resumeAt,
        id: '00000000-0000-0000-0000-000000000000',
      });
      const response = await streamEvents(
        new Request(
          `https://crm.sse.test/api/events?tables=messages&cursor=${cursor}`,
          {
            headers: { authorization: `Bearer ${token}` },
            signal: abort.signal,
          }
        )
      );
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      let output = '';
      try {
        while ((output.match(/event: change/g) ?? []).length < 201) {
          const item = await reader.read();
          if (item.done) break;
          output += new TextDecoder().decode(item.value);
        }
      } finally {
        abort.abort();
        await reader.cancel();
      }
      expect(output.match(/event: change/g)).toHaveLength(201);
      expect(output).not.toContain('foreign');
      expect(output).toContain('event: resync');
      expect(output).toContain('id: ');
    }, 30000);
    it('retains worker historical authors after removal while rejecting assignment to the removed member', async () => {
      const identity = await getWorkerPrisma().$queryRawUnsafe<
        { name: string; role: string }[]
      >('SELECT current_database() AS name,current_user AS role');
      if (
        !/test/i.test(identity[0].name) ||
        identity[0].role !== 'bodhinox_worker'
      )
        throw new Error(
          'Requires isolated database and constrained worker credentials'
        );
      await getAuthPrisma().$executeRawUnsafe(
        "INSERT INTO account_memberships(account_id,user_id,role) VALUES($1::uuid,$2::uuid,'admin')",
        accountA,
        userB
      );
      expect(
        (
          await executeRpc(
            'transfer_account_ownership',
            { p_new_owner_user_id: userB },
            a
          )
        ).error
      ).toBeNull();
      const owner: TenantContext = {
        accountId: accountA,
        userId: userB,
        role: 'owner',
      };
      expect(
        (await executeRpc('remove_account_member', { p_user_id: userA }, owner))
          .error
      ).toBeNull();
      const contact = await buildQuery('contacts', (spec) =>
        executeQuery(spec, owner, false, true)
      )
        .insert({ user_id: userA, phone: '445566', name: 'Historical author' })
        .select('*')
        .single();
      expect(contact.error).toBeNull();
      expect(contact.data?.user_id).toBe(userA);
      const selected = await buildQuery('contacts', (spec) =>
        executeQuery(spec, owner, false, true)
      )
        .select('id,name')
        .eq('id', contact.data!.id)
        .single();
      expect(selected.data).toMatchObject({
        id: contact.data!.id,
        name: 'Historical author',
      });
      const assignment = await buildQuery('conversations', (spec) =>
        executeQuery(spec, owner, false, true)
      )
        .insert({
          user_id: userA,
          contact_id: contact.data!.id,
          assigned_agent_id: userA,
        })
        .select('*');
      expect(assignment.error?.code).toBe('RELATED_RECORD_FORBIDDEN');
    }, 30000);
  }
);
