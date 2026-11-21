// Batch 7 on a real PostgreSQL: the contact duplicate finder and merge (crm_merge_contacts,
// prisma/migrations/20261207020000_contact_merge). The merge moves every child row of the merged contact to the
// kept one and leaves nothing pointing at the deleted contact; unique clashes are resolved without errors; one
// audit row is written. Workspace B cannot merge (or see) workspace A's contacts, and agents are refused both in
// the library and inside the database function.
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { encrypt } from '@/lib/whatsapp/encryption';
import { dismissDuplicate, findDuplicates, type DuplicateActor } from './duplicates';
import { mergeContacts, previewMerge, type MergeActor } from './merge';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;

const accountA = randomUUID(), accountB = randomUUID(), accountC = randomUUID();
const ownerA = randomUUID(), adminA = randomUUID(), agentA = randomUUID(), ownerB = randomUUID(), ownerC = randomUUID();
const asAdmin: MergeActor = { accountId: accountA, userId: adminA, role: 'admin' };
const asAgent: MergeActor = { accountId: accountA, userId: agentA, role: 'agent' };
const asOwnerB: MergeActor = { accountId: accountB, userId: ownerB, role: 'owner' };
const asOwnerC: DuplicateActor = { accountId: accountC, userId: ownerC, role: 'owner' };
const seed = String(Date.now()).slice(-9);
let owner: pg.Client;

const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows as T[];
const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await q<T>(sql, params))[0];
const id = async (sql: string, params: unknown[] = []) => (await one<{ id: string }>(sql, params)).id;
const errorCode = (p: Promise<unknown>) => p.then(() => null, (e: { code?: string }) => e.code ?? 'error');

async function contact(accountId: string, userId: string, fields: { phone?: string; name?: string; email?: string | null }) {
  return id('INSERT INTO contacts(account_id,user_id,phone,name,email) VALUES($1,$2,$3,$4,$5) RETURNING id',
    [accountId, userId, fields.phone ?? '', fields.name ?? null, fields.email ?? null]);
}
async function message(accountId: string, conversationId: string, text: string, messageId = `wamid.m.${randomUUID()}`) {
  await q(`INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,message_id)
    VALUES($1,$2,'customer','text',$3,$4)`, [accountId, conversationId, text, messageId]);
}

/** Every column that can name a contact: foreign keys to contacts and the log columns without one. */
async function contactColumns(): Promise<{ table: string; column: string }[]> {
  return q<{ table: string; column: string }>(`SELECT table_name AS table, column_name AS column FROM information_schema.columns
    WHERE table_schema = 'public' AND data_type = 'uuid' AND column_name LIKE '%contact_id'
      AND table_name NOT IN ('contacts', 'contact_identity_links')
    UNION SELECT c.conrelid::regclass::text, a.attname FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.contype = 'f' AND c.confrelid = 'public.contacts'::regclass AND a.attname <> 'account_id'
    ORDER BY 1, 2`);
}

describe.skipIf(!ownerUrl || !appUrl)('Contact duplicates and merge on PostgreSQL', { timeout: 120_000 }, () => {
  let config = '', instagramA = '', instagramC = '';

  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await one<{ name: string }>('SELECT current_database() AS name')).name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string; role: string }[]>`SELECT current_database() AS name, current_user AS role`;
    if (!/test/i.test(app[0].name) || app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await q("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Merge test', 'test-only-hash' FROM unnest($1::uuid[]) x",
      [[ownerA, adminA, agentA, ownerB, ownerC]]);
    await q("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Merge A',$2),($3,'Merge B',$4),($5,'Merge C',$6)",
      [accountA, ownerA, accountB, ownerB, accountC, ownerC]);
    await q(`INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin'),($1,$4,'agent'),
      ($5,$6,'owner'),($7,$8,'owner')`, [accountA, ownerA, adminA, agentA, accountB, ownerB, accountC, ownerC]);
    config = await id(`INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,waba_id,access_token,status)
      VALUES($1,$2,$3,$4,$5,'connected') RETURNING id`, [accountA, ownerA, `76${seed}`, `86${seed}`, encrypt('test-only-token')]);
    instagramA = await id(`INSERT INTO instagram_accounts(account_id,ig_user_id,username,access_token_enc,scopes,connected_by_user_id)
      VALUES($1,$2,'shop',$3,ARRAY['instagram_business_basic'],$4) RETURNING id`, [accountA, `91${seed}`, encrypt('test-only-ig'), ownerA]);
    instagramC = await id(`INSERT INTO instagram_accounts(account_id,ig_user_id,username,access_token_enc,scopes,connected_by_user_id)
      VALUES($1,$2,'shop',$3,ARRAY['instagram_business_basic'],$4) RETURNING id`, [accountC, `92${seed}`, encrypt('test-only-ig'), ownerC]);
  });

  afterAll(async () => {
    try {
      await q('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB, accountC]]);
      await q('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[ownerA, adminA, agentA, ownerB, ownerC]]);
    } finally {
      await owner?.end();
      await disconnectDatabases();
    }
  });

  describe('duplicate finder', () => {
    let trunk = '', plain = '', mailUpper = '', mailLower = '', igOnly = '', waOnly = '', loner = '';

    beforeAll(async () => {
      trunk = await contact(accountC, ownerC, { phone: '+44 07700 900123', name: 'Trunk' });
      plain = await contact(accountC, ownerC, { phone: '+44 7700 900123', name: 'Plain' });
      mailUpper = await contact(accountC, ownerC, { phone: '+91 98765 11111', name: 'Mail one', email: ' Asha@Example.com ' });
      mailLower = await contact(accountC, ownerC, { phone: '+91 98765 22222', name: 'Mail two', email: 'asha@example.com' });
      igOnly = await contact(accountC, ownerC, { name: 'Ravi Kumar' });
      await q(`INSERT INTO contact_channel_identities(account_id,contact_id,instagram_account_id,external_id) VALUES($1,$2,$3,$4)`,
        [accountC, igOnly, instagramC, `93${seed}`]);
      waOnly = await contact(accountC, ownerC, { phone: '+91 98765 33333', name: ' ravi kumar' });
      loner = await contact(accountC, ownerC, { phone: '+91 98765 44444', name: 'Loner', email: 'loner@example.com' });
    });

    const pairKey = (a: string, b: string) => [a, b].sort().join('.');

    it('finds the trunk-0 phone, email and name pairs, paged in SQL by a keyset cursor', async () => {
      const first = await findDuplicates(asOwnerC, { limit: 2 });
      expect(first.pairs).toHaveLength(2);
      expect(first.nextCursor).toMatch(/^[0-9a-f-]{36}\.[0-9a-f-]{36}$/);
      const second = await findDuplicates(asOwnerC, { limit: 2, cursor: first.nextCursor });
      expect(second.nextCursor).toBeNull();
      const all = [...first.pairs, ...second.pairs];
      const found = new Map(all.map((p) => [pairKey(p.contacts[0].id, p.contacts[1].id), p.reasons]));
      expect(found).toEqual(new Map([
        [pairKey(trunk, plain), ['phone']],
        [pairKey(mailUpper, mailLower), ['email']],
        [pairKey(igOnly, waOnly), ['name']],
      ]));
      expect(all.flatMap((p) => p.contacts.map((c) => c.id))).not.toContain(loner);
      const ig = all.flatMap((p) => p.contacts).find((c) => c.id === igOnly);
      expect(ig).toMatchObject({ instagram: true, conversations: 0 });
    });

    it('never offers a dismissed pair again; other workspaces and agents cannot see or dismiss', async () => {
      await dismissDuplicate(asOwnerC, mailLower, mailUpper);
      await dismissDuplicate(asOwnerC, mailUpper, mailLower); // idempotent
      const page = await findDuplicates(asOwnerC, { limit: 50 });
      expect(page.pairs.map((p) => pairKey(p.contacts[0].id, p.contacts[1].id))).not.toContain(pairKey(mailUpper, mailLower));
      expect(page.pairs).toHaveLength(2);

      const fromB = await findDuplicates(asOwnerB);
      expect(fromB.pairs.flatMap((p) => p.contacts.map((c) => c.id))).not.toContain(trunk);
      expect(await errorCode(dismissDuplicate(asOwnerB, trunk, plain))).toBe('not_found');
      const agentC: DuplicateActor = { ...asOwnerC, role: 'agent' };
      expect(await errorCode(findDuplicates(agentC))).toBe('forbidden');
      expect(await errorCode(dismissDuplicate(agentC, trunk, plain))).toBe('forbidden');
      expect(await errorCode(findDuplicates(asOwnerC, { cursor: 'not-a-cursor' }))).toBe('invalid_request');
    });
  });

  describe('merge', () => {
    let keep = '', merged = '', third = '';
    let keepWa = '', mergedWa = '', mergedIg = '', identity = '';
    let tag1 = '', tag2 = '', seq1 = '', seq2 = '', field = '', list1 = '', list2 = '';

    beforeAll(async () => {
      keep = await contact(accountA, ownerA, { phone: '+44 7700 900456', name: 'Asha' });
      merged = await contact(accountA, ownerA, { phone: '+44 07700 900456', name: 'Asha P', email: 'asha@example.com' });
      third = await contact(accountA, ownerA, { phone: '+91 98765 55555', name: 'Third' });
      await q('UPDATE contacts SET opted_out_at = now(), opt_out_source = $2 WHERE id = $1', [merged, 'keyword']);

      // Tags: tag1 on both (a unique clash), tag2 only on the merged contact.
      tag1 = await id("INSERT INTO tags(account_id,user_id,name) VALUES($1,$2,'VIP') RETURNING id", [accountA, ownerA]);
      tag2 = await id("INSERT INTO tags(account_id,user_id,name) VALUES($1,$2,'Lead') RETURNING id", [accountA, ownerA]);
      await q('INSERT INTO contact_tags(account_id,contact_id,tag_id) VALUES($1,$2,$3),($1,$4,$3),($1,$4,$5)', [accountA, keep, tag1, merged, tag2]);

      // WhatsApp conversations on the same number fold into one; one merged message repeats a keep message id.
      keepWa = await id(`INSERT INTO conversations(account_id,user_id,contact_id,channel,whatsapp_config_id) VALUES($1,$2,$3,'whatsapp',$4) RETURNING id`,
        [accountA, ownerA, keep, config]);
      mergedWa = await id(`INSERT INTO conversations(account_id,user_id,contact_id,channel,whatsapp_config_id) VALUES($1,$2,$3,'whatsapp',$4) RETURNING id`,
        [accountA, ownerA, merged, config]);
      await message(accountA, keepWa, 'keep hello', `wamid.dup.${seed}`);
      await message(accountA, mergedWa, 'merged one');
      await message(accountA, mergedWa, 'merged two');
      await message(accountA, mergedWa, 'same message', `wamid.dup.${seed}`);
      // An Instagram identity and conversation only the merged contact has.
      identity = await id(`INSERT INTO contact_channel_identities(account_id,contact_id,instagram_account_id,external_id) VALUES($1,$2,$3,$4) RETURNING id`,
        [accountA, merged, instagramA, `94${seed}`]);
      mergedIg = await id(`INSERT INTO conversations(account_id,user_id,contact_id,channel,instagram_account_id) VALUES($1,$2,$3,'instagram',$4) RETURNING id`,
        [accountA, ownerA, merged, instagramA]);
      await message(accountA, mergedIg, 'ig hi', `mid.${randomUUID()}`);

      await q("INSERT INTO contact_notes(account_id,contact_id,user_id,note_text) VALUES($1,$2,$3,'Prefers mornings')", [accountA, merged, ownerA]);
      await q("INSERT INTO orders(account_id,source,contact_id,currency,subtotal_minor) VALUES($1,'manual',$2,'INR',1000)", [accountA, merged]);
      const pipeline = await id("INSERT INTO pipelines(account_id,user_id,name) VALUES($1,$2,'Sales') RETURNING id", [accountA, ownerA]);
      const stage = await id("INSERT INTO pipeline_stages(account_id,pipeline_id,name) VALUES($1,$2,'New') RETURNING id", [accountA, pipeline]);
      await q("INSERT INTO deals(account_id,user_id,pipeline_id,stage_id,contact_id,title) VALUES($1,$2,$3,$4,$5,'Deal')",
        [accountA, ownerA, pipeline, stage, merged]);
      const location = await id("INSERT INTO appointment_locations(account_id,name,timezone) VALUES($1,'Shop','Asia/Kolkata') RETURNING id", [accountA]);
      const service = await id("INSERT INTO appointment_services(account_id,name,mode,duration_minutes) VALUES($1,'Consult','offline',30) RETURNING id", [accountA]);
      await q(`INSERT INTO appointments(account_id,contact_id,service_id,location_id,start_at,end_at,timezone,status,source,confirmed_at,service_name)
        VALUES($1,$2,$3,$4,'2027-01-05T05:30:00Z','2027-01-05T06:00:00Z','Asia/Kolkata','confirmed','staff',now(),'Consult')`,
      [accountA, merged, service, location]);
      await q(`INSERT INTO whatsapp_form_responses(account_id,contact_id,message_id,response) VALUES($1,$2,$3,'{"size":"M"}')`,
        [accountA, merged, `wamid.form.${seed}`]);
      // Sequences: seq1 on both (a unique clash), seq2 only on the merged contact.
      seq1 = await id("INSERT INTO sequences(account_id,channel,name,status) VALUES($1,'whatsapp','Welcome','active') RETURNING id", [accountA]);
      seq2 = await id("INSERT INTO sequences(account_id,channel,name,status) VALUES($1,'whatsapp','Winback','active') RETURNING id", [accountA]);
      await q('INSERT INTO sequence_subscriptions(account_id,sequence_id,contact_id) VALUES($1,$2,$3),($1,$2,$4),($1,$5,$4)',
        [accountA, seq1, keep, merged, seq2]);
      await q(`INSERT INTO contact_activity(account_id,contact_id,kind,detail) VALUES($1,$2,'field_changed','{"field":"name"}')`, [accountA, merged]);
      await q(`INSERT INTO domain_events(account_id,type,subject_kind,subject_id,contact_id,data) VALUES($1,'contact.updated','contact',$2,$2,'{}')`,
        [accountA, merged]);
      await q("INSERT INTO tasks(account_id,contact_id,kind,title) VALUES($1,$2,'manual','Call back')", [accountA, merged]);
      // Custom field: blank on the kept contact, filled on the merged one.
      field = await id("INSERT INTO custom_fields(account_id,user_id,field_name) VALUES($1,$2,'Tier') RETURNING id", [accountA, ownerA]);
      await q("INSERT INTO contact_custom_values(account_id,contact_id,custom_field_id,value) VALUES($1,$2,$3,''),($1,$4,$3,'Gold')",
        [accountA, keep, field, merged]);
      list1 = await id("INSERT INTO contact_lists(account_id,user_id,name) VALUES($1,$2,'Newsletter') RETURNING id", [accountA, ownerA]);
      list2 = await id("INSERT INTO contact_lists(account_id,user_id,name) VALUES($1,$2,'Events') RETURNING id", [accountA, ownerA]);
      await q('INSERT INTO contact_list_members(account_id,list_id,contact_id) VALUES($1,$2,$3),($1,$2,$4),($1,$5,$4)',
        [accountA, list1, keep, merged, list2]);
      const [low, high] = [merged, third].sort();
      await q('INSERT INTO contact_duplicate_dismissals(account_id,contact_low_id,contact_high_id) VALUES($1,$2,$3)', [accountA, low, high]);
    });

    it('refuses agents in the library and inside the database function', async () => {
      expect(await errorCode(previewMerge(asAgent, keep, merged))).toBe('forbidden');
      expect(await errorCode(mergeContacts(asAgent, keep, merged))).toBe('forbidden');
      const direct = withTenant(asAgent, (tx) => tx.$queryRaw(Prisma.sql`SELECT crm_merge_contacts(${keep}::uuid, ${merged}::uuid, true)`));
      await expect(direct).rejects.toThrow(/admin required/);
      expect(await one('SELECT id FROM contacts WHERE id = $1', [merged])).toBeTruthy();
    });

    it("refuses another workspace's contacts as not found and changes nothing", async () => {
      expect(await errorCode(previewMerge(asOwnerB, keep, merged))).toBe('not_found');
      expect(await errorCode(mergeContacts(asOwnerB, keep, merged))).toBe('not_found');
      const bContact = await contact(accountB, ownerB, { phone: '+91 98765 66666', name: 'B' });
      expect(await errorCode(mergeContacts(asOwnerB, bContact, merged))).toBe('not_found');
      expect(await errorCode(mergeContacts(asAdmin, keep, bContact))).toBe('not_found');
      expect(await errorCode(mergeContacts(asAdmin, bContact, merged))).toBe('not_found');
      expect((await q('SELECT id FROM contacts WHERE id = ANY($1::uuid[])', [[keep, merged, bContact]])).length).toBe(3);
      expect(await one('SELECT contact_id FROM conversations WHERE id = $1', [mergedWa])).toEqual({ contact_id: merged });
    });

    it('refuses the same contact, and two different WhatsApp numbers', async () => {
      expect(await errorCode(mergeContacts(asAdmin, keep, keep))).toBe('invalid_request');
      expect(await errorCode(previewMerge(asAdmin, keep, third))).toBe('phone_conflict');
    });

    it('previews what will move without changing anything', async () => {
      const counts = await previewMerge(asAdmin, keep, merged);
      expect(counts).toMatchObject({
        conversations: 2, messages: 4, tags: 1, notes: 1, orders: 1, deals: 1, appointments: 1, formAnswers: 1,
        sequences: 2, customValues: 1, identities: 1, lists: 1, tasks: 1, combinedConversations: 1,
      });
      expect(await one('SELECT id FROM contacts WHERE id = $1', [merged])).toBeTruthy();
      expect(await one("SELECT count(*)::int AS n FROM audit_logs WHERE account_id = $1 AND action = 'contact.merged'", [accountA]))
        .toEqual({ n: 0 });
    });

    it('moves every child row to the kept contact in one transaction and leaves no orphans', async () => {
      const columns = await contactColumns();
      // The sweep below must cover every contact child the brief names.
      for (const table of ['conversations', 'contact_tags', 'contact_notes', 'orders', 'deals', 'appointments',
        'whatsapp_form_responses', 'sequence_subscriptions', 'contact_activity', 'domain_events', 'tasks']) {
        expect(columns.map((c) => c.table)).toContain(table);
      }

      const counts = await mergeContacts(asAdmin, keep, merged);
      expect(counts).toMatchObject({ conversations: 2, messages: 4, tags: 1, orders: 1, combinedConversations: 1 });

      // No row anywhere still names the merged contact (contact_identity_links is history and keeps its ids).
      for (const { table, column } of columns) {
        const row = await one<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${column} = $1`, [merged]);
        expect({ table, column, n: row.n }).toEqual({ table, column, n: 0 });
      }
      expect(await one('SELECT id FROM contacts WHERE id = $1', [merged])).toBeUndefined();

      // Conversations: the WhatsApp one folded into the kept conversation (the repeated message once), Instagram moved.
      expect(await one('SELECT id FROM conversations WHERE id = $1', [mergedWa])).toBeUndefined();
      const texts = (await q<{ content_text: string }>('SELECT content_text FROM messages WHERE conversation_id = $1 ORDER BY content_text', [keepWa]))
        .map((m) => m.content_text);
      expect(texts).toEqual(['keep hello', 'merged one', 'merged two']);
      expect(await one('SELECT contact_id FROM conversations WHERE id = $1', [mergedIg])).toEqual({ contact_id: keep });
      expect(await one('SELECT contact_id FROM contact_channel_identities WHERE id = $1', [identity])).toEqual({ contact_id: keep });
      expect(await one('SELECT kind, from_contact_id, to_contact_id FROM contact_identity_links WHERE identity_id = $1', [identity]))
        .toEqual({ kind: 'link', from_contact_id: merged, to_contact_id: keep });

      // Unique clashes resolved: one of each tag, sequence and list on the kept contact.
      expect((await q<{ tag_id: string }>('SELECT tag_id FROM contact_tags WHERE contact_id = $1 ORDER BY tag_id', [keep])).map((r) => r.tag_id))
        .toEqual([tag1, tag2].sort());
      expect((await q<{ sequence_id: string }>('SELECT sequence_id FROM sequence_subscriptions WHERE contact_id = $1 ORDER BY sequence_id', [keep]))
        .map((r) => r.sequence_id)).toEqual([seq1, seq2].sort());
      expect((await q<{ list_id: string }>('SELECT list_id FROM contact_list_members WHERE contact_id = $1 ORDER BY list_id', [keep]))
        .map((r) => r.list_id)).toEqual([list1, list2].sort());
      expect(await one('SELECT value FROM contact_custom_values WHERE contact_id = $1 AND custom_field_id = $2', [keep, field]))
        .toEqual({ value: 'Gold' });
      for (const table of ['contact_notes', 'orders', 'deals', 'appointments', 'whatsapp_form_responses', 'contact_activity', 'tasks']) {
        expect({ table, n: (await one<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE contact_id = $1`, [keep])).n })
          .toEqual({ table, n: 1 });
      }
      expect(await one("SELECT subject_id FROM domain_events WHERE account_id = $1 AND contact_id = $2 AND subject_kind = 'contact'", [accountA, keep]))
        .toEqual({ subject_id: keep });
      expect(await one('SELECT count(*)::int AS n FROM contact_duplicate_dismissals WHERE account_id = $1', [accountA])).toEqual({ n: 0 });

      // Blank fields filled; the stricter consent wins; the kept number stays.
      const kept = await one<{ email: string; opted_out_at: Date | null; phone_normalized: string; name: string }>(
        'SELECT email, opted_out_at, phone_normalized, name FROM contacts WHERE id = $1', [keep]);
      expect(kept).toMatchObject({ email: 'asha@example.com', name: 'Asha', phone_normalized: '447700900456' });
      expect(kept.opted_out_at).not.toBeNull();

      // One audit row, ids and counts only.
      const audit = await q<{ user_id: string; resource_id: string; metadata: Record<string, unknown> }>(
        "SELECT user_id, resource_id, metadata FROM audit_logs WHERE account_id = $1 AND action = 'contact.merged'", [accountA]);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ user_id: adminA, resource_id: keep, metadata: { merged_contact_id: merged } });
      expect(JSON.stringify(audit[0].metadata)).not.toMatch(/asha|7700|example\.com/i);

      // The merged id is gone: a second merge is not found.
      expect(await errorCode(mergeContacts(asAdmin, keep, merged))).toBe('not_found');
    });
  });
});
