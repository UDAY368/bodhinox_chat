import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases } from '@/lib/db/prisma';
import { handleJob } from './handlers';
import type { Job } from './queue';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const workerUrl =
  process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
const account = randomUUID(),
  foreignAccount = randomUUID(),
  user = randomUUID();
const contacts = [randomUUID(), randomUUID()],
  foreignContact = randomUUID();
const automation = randomUUID(),
  tag = randomUUID(),
  foreignTag = randomUUID(),
  resultTag = randomUUID(),
  field = randomUUID();
const at = '2026-10-15T09:00:00.000Z';
let owner: pg.Client;
function job(type: string, payload: Record<string, unknown>): Job {
  return {
    id: randomUUID(),
    type,
    payload,
    tenant_id: account,
    attempts: 1,
    max_attempts: 5,
    lease_token: randomUUID(),
  };
}
async function scheduledJobs(slot = at) {
  return (
    await owner.query(
      "SELECT * FROM jobs WHERE tenant_id=$1 AND type=$2 AND payload->>'slot'=$3 ORDER BY payload->>'contactId'",
      [account, 'automation.trigger', slot]
    )
  ).rows as Job[];
}
async function skippedLogs(slot: string) {
  return (
    await owner.query(
      "SELECT error_message FROM automation_logs WHERE automation_id=$1 AND status='failed' AND starts_with(error_message,$2)",
      [automation, `Scheduled run at ${slot} skipped`]
    )
  ).rows.map((row) => row.error_message as string);
}
async function setAudience(audience: unknown) {
  await owner.query('UPDATE automations SET trigger_config=$2 WHERE id=$1', [
    automation,
    JSON.stringify({
      schedule: '* * * * *',
      timezone: 'UTC',
      ...(audience ? { audience } : {}),
    }),
  ]);
}
describe.skipIf(!ownerUrl || !workerUrl)(
  'real PostgreSQL scheduled contact audiences',
  { timeout: 60000 },
  () => {
    beforeAll(async () => {
      owner = new pg.Client({ connectionString: ownerUrl });
      await owner.connect();
      const database = (await owner.query('SELECT current_database() AS name'))
        .rows[0].name;
      if (!/test/i.test(database))
        throw new Error('Scheduling tests require an isolated test database');
      await owner.query('BEGIN');
      await owner.query(
        "INSERT INTO auth_users(id,email,full_name,password_hash,email_verified_at) VALUES($1,$2,'Scheduled test owner','test-only',NOW())",
        [user, `${user}@example.invalid`]
      );
      for (const id of [account, foreignAccount]) {
        await owner.query(
          "INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Scheduled fixture',$2)",
          [id, user]
        );
        await owner.query(
          "INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner')",
          [id, user]
        );
      }
      await owner.query(
        "INSERT INTO contacts(id,account_id,user_id,phone,name) VALUES($1,$2,$3,'+14155550101','Same customer'),($4,$2,$3,'+14155550102','Second customer'),($5,$6,$3,'+14155550101','Same customer')",
        [
          contacts[0],
          account,
          user,
          contacts[1],
          foreignContact,
          foreignAccount,
        ]
      );
      await owner.query(
        "INSERT INTO tags(id,account_id,user_id,name) VALUES($1,$2,$3,'Audience'),($4,$2,$3,'Result'),($5,$6,$3,'Audience')",
        [tag, account, user, resultTag, foreignTag, foreignAccount]
      );
      await owner.query(
        'INSERT INTO contact_tags(account_id,contact_id,tag_id) VALUES($1,$2,$3),($4,$5,$6)',
        [account, contacts[0], tag, foreignAccount, foreignContact, foreignTag]
      );
      await owner.query(
        "INSERT INTO custom_fields(id,account_id,user_id,field_name,field_type) VALUES($1,$2,$3,'Eligible','text')",
        [field, account, user]
      );
      await owner.query(
        "INSERT INTO contact_custom_values(account_id,contact_id,custom_field_id,value) VALUES($1,$2,$3,'yes')",
        [account, contacts[1], field]
      );
      await owner.query(
        "INSERT INTO automations(id,account_id,user_id,name,trigger_type,trigger_config,is_active) VALUES($1,$2,$3,'Scheduled fixture','time_based',$4,true)",
        [
          automation,
          account,
          user,
          JSON.stringify({ schedule: '* * * * *', audience: { type: 'all' } }),
        ]
      );
      await owner.query(
        "INSERT INTO automation_steps(account_id,automation_id,step_type,step_config,position) VALUES($1,$2,'add_tag',$3,0)",
        [account, automation, JSON.stringify({ tag_id: resultTag })]
      );
      await owner.query('COMMIT');
    });
    afterAll(async () => {
      if (owner) {
        await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [
          [account, foreignAccount],
        ]);
        await owner.query('DELETE FROM auth_users WHERE id=$1', [user]);
        await owner.end();
      }
      await disconnectDatabases();
    });
    it('fans out one durable job per selected tenant contact and deduplicates the UTC slot', async () => {
      const schedule = job('automation.schedule', { minute: at });
      await handleJob(schedule);
      await handleJob(schedule);
      const jobs = await scheduledJobs();
      expect(jobs.map((row) => row.payload.contactId).sort()).toEqual(
        [...contacts].sort()
      );
      for (const row of jobs) expect(row.tenant_id).toBe(account);
      for (const row of jobs) {
        await handleJob(row);
        await handleJob(row);
      }
      const tagged = await owner.query(
        'SELECT contact_id FROM contact_tags WHERE account_id=$1 AND tag_id=$2 ORDER BY contact_id',
        [account, resultTag]
      );
      expect(tagged.rows.map((row) => row.contact_id)).toEqual(
        [...contacts].sort()
      );
      expect(
        (
          await owner.query(
            'SELECT id FROM automation_logs WHERE automation_id=$1',
            [automation]
          )
        ).rowCount
      ).toBe(2);
    });
    it('resolves tag and custom-field selections and rejects foreign filter references', async () => {
      await setAudience({ type: 'tags', tagIds: [tag] });
      const tagSlot = '2026-10-15T09:01:00.000Z';
      await handleJob(job('automation.schedule', { minute: tagSlot }));
      expect(
        (await scheduledJobs(tagSlot)).map((row) => row.payload.contactId)
      ).toEqual([contacts[0]]);
      await setAudience({
        type: 'custom_field',
        customField: { fieldId: field, operator: 'is', value: 'yes' },
      });
      const fieldSlot = '2026-10-15T09:02:00.000Z';
      await handleJob(job('automation.schedule', { minute: fieldSlot }));
      expect(
        (await scheduledJobs(fieldSlot)).map((row) => row.payload.contactId)
      ).toEqual([contacts[1]]);
      await setAudience({ type: 'tags', tagIds: [foreignTag] });
      const foreignSlot = '2026-10-15T09:03:00.000Z';
      // Refused and logged (once, even when the tick runs again), not thrown: other automations keep their occurrence.
      await handleJob(job('automation.schedule', { minute: foreignSlot }));
      await handleJob(job('automation.schedule', { minute: foreignSlot }));
      expect(await scheduledJobs(foreignSlot)).toHaveLength(0);
      expect(await skippedLogs(foreignSlot)).toEqual([expect.stringMatching(/workspace/)]);
    });
    it('rejects legacy contact schedules without recipients, but preserves account-wide webhook-only jobs', async () => {
      await setAudience(undefined);
      const legacySlot = '2026-10-15T09:04:00.000Z';
      await handleJob(job('automation.schedule', { minute: legacySlot }));
      expect(await scheduledJobs(legacySlot)).toHaveLength(0);
      expect(await skippedLogs(legacySlot)).toEqual([expect.stringMatching(/recipients/)]);
      await owner.query(
        'UPDATE automation_steps SET step_type=\'send_webhook\',step_config=\'{"url":"https://example.com/hook"}\' WHERE automation_id=$1',
        [automation]
      );
      const slot = '2026-10-15T09:05:00.000Z';
      await handleJob(job('automation.schedule', { minute: slot }));
      expect(await scheduledJobs(slot)).toHaveLength(1);
      expect((await scheduledJobs(slot))[0].payload.contactId).toBeUndefined();
    });
    it('[audit-50/56] fires each minute the scheduler missed exactly once, never one from before the automation existed', async () => {
      await owner.query("UPDATE automations SET created_at='2026-10-15T09:08:30Z' WHERE id=$1", [automation]);
      await handleJob(job('automation.schedule', { from: '2026-10-15T09:06:00.000Z', minute: '2026-10-15T09:10:00.000Z' }));
      for (const minute of ['06', '07']) expect(await scheduledJobs(`2026-10-15T09:${minute}:00.000Z`)).toHaveLength(0);
      for (const minute of ['08', '09', '10']) expect(await scheduledJobs(`2026-10-15T09:${minute}:00.000Z`)).toHaveLength(1);
      // An overlapping catch-up (a retried pass, or the next tick) never fires a minute twice.
      await handleJob(job('automation.schedule', { from: '2026-10-15T09:09:00.000Z', minute: '2026-10-15T09:11:00.000Z' }));
      for (const minute of ['09', '10', '11']) expect(await scheduledJobs(`2026-10-15T09:${minute}:00.000Z`)).toHaveLength(1);
    });
    // Audit #13: audiences past one page are read in pages, and one oversize
    // automation is logged and skipped without costing the others their occurrence.
    it('queues every recipient past one page and logs an oversize automation instead of failing the tick', async () => {
      const big = randomUUID(), bigTag = randomUUID(), tagged = randomUUID(), everyone = randomUUID();
      const slot = '2026-10-16T09:00:00.000Z';
      try {
        await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Paging fixture',$2)", [big, user]);
        await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner')", [big, user]);
        // 10,009 contacts, 8 of which opt out below: 10,001 sendable (over the cap for "all"); 1,050 carry the tag (over one page).
        await owner.query(`INSERT INTO contacts(account_id,user_id,phone,name)
          SELECT $1,$2,'+1415' || lpad(g::text,7,'0'),'Paged ' || g FROM generate_series(1,10009) g`, [big, user]);
        await owner.query("INSERT INTO tags(id,account_id,user_id,name) VALUES($1,$2,$3,'Paged')", [bigTag, big, user]);
        await owner.query(`INSERT INTO contact_tags(account_id,contact_id,tag_id)
          SELECT $1,id,$2 FROM contacts WHERE account_id=$1 ORDER BY phone LIMIT 1050`, [big, bigTag]);
        // Eight more tagged contacts that opted out are left out in SQL before the cap.
        await owner.query(`UPDATE contacts SET opted_out_at=NOW() WHERE id IN (
          SELECT contact_id FROM contact_tags WHERE account_id=$1 ORDER BY contact_id LIMIT 8)`, [big]);
        for (const [id, name, audience] of [[everyone, 'Everyone', { type: 'all' }], [tagged, 'Tagged', { type: 'tags', tagIds: [bigTag] }]] as const) {
          await owner.query("INSERT INTO automations(id,account_id,user_id,name,trigger_type,trigger_config,is_active) VALUES($1,$2,$3,$4,'time_based',$5,true)",
            [id, big, user, name, JSON.stringify({ schedule: '* * * * *', timezone: 'UTC', audience })]);
          await owner.query("INSERT INTO automation_steps(account_id,automation_id,step_type,step_config,position) VALUES($1,$2,'add_tag',$3,0)",
            [big, id, JSON.stringify({ tag_id: bigTag })]);
        }
        await handleJob({ ...job('automation.schedule', { minute: slot }), tenant_id: big });
        const queued = await owner.query(
          "SELECT payload->>'automationId' AS automation, count(DISTINCT payload->>'contactId')::int AS n FROM jobs WHERE tenant_id=$1 AND type='automation.trigger' AND payload->>'slot'=$2 GROUP BY 1",
          [big, slot]);
        expect(queued.rows).toEqual([{ automation: tagged, n: 1042 }]);
        const logs = await owner.query("SELECT automation_id, error_message FROM automation_logs WHERE account_id=$1 AND status='failed'", [big]);
        expect(logs.rows).toEqual([{ automation_id: everyone, error_message: expect.stringMatching(/10000-contact limit/) }]);
        const notices = await owner.query("SELECT user_id FROM notifications WHERE account_id=$1 AND type='automation_notice'", [big]);
        expect(notices.rows).toEqual([{ user_id: user }]);
        // Skipped, not turned off: the next occurrence tries again.
        expect((await owner.query('SELECT is_active FROM automations WHERE id=$1', [everyone])).rows[0].is_active).toBe(true);
      } finally {
        await owner.query('DELETE FROM jobs WHERE tenant_id=$1', [big]);
        await owner.query('DELETE FROM accounts WHERE id=$1', [big]);
      }
    });
  }
);
