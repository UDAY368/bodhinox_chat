import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// A WABA resolves to the one workspace holding one of its numbers connected:
// a number an admin disconnected (status 'disconnected', access_token '') no
// longer counts, as in crm_resolve_whatsapp_account.
config({ path: ".env.test", quiet: true });
const connectionString = process.env.TEST_DATABASE_URL;
const accountX = randomUUID(), accountY = randomUUID(), accountZ = randomUUID();
const userX = randomUUID(), userY = randomUUID(), userZ = randomUUID();
const users: Record<string, string> = { [accountX]: userX, [accountY]: userY, [accountZ]: userZ };
let pool: pg.Pool;

async function tenant<T>(accountId: string | null, operation: (db: pg.PoolClient) => Promise<T>, role = "bodhinox_app") {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query(`SET LOCAL ROLE ${role}`);
    await db.query("SELECT set_config('app.account_id',$1,true),set_config('app.user_id',$2,true),set_config('app.account_role','owner',true)", [accountId || "", accountId ? users[accountId] : ""]);
    const result = await operation(db);
    await db.query("COMMIT");
    return result;
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
}

const resolveWaba = (waba: string) =>
  tenant(null, async db => (await db.query("SELECT crm_resolve_waba_account($1) AS account_id", [waba])).rows[0].account_id, "bodhinox_worker");
const connect = (accountId: string, phone: string, waba: string) =>
  tenant(accountId, db => db.query("INSERT INTO whatsapp_config(user_id,phone_number_id,waba_id,access_token,status) VALUES($1,$2,$3,'test-only-encrypted-token','connected') RETURNING id", [users[accountId], phone, waba])).then(r => r.rows[0].id as string);
const disconnect = (accountId: string, id: string) =>
  tenant(accountId, db => db.query("UPDATE whatsapp_config SET status='disconnected',access_token='' WHERE id=$1", [id]));

describe.skipIf(!connectionString)("crm_resolve_waba_account with disconnected numbers", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString, max: 2 });
    const name = await pool.query("SELECT current_database() AS name");
    if (!/test/i.test(name.rows[0].name)) throw new Error("Integration tests require a separately named test database");
    await pool.query("BEGIN");
    await pool.query("SET LOCAL ROLE bodhinox_auth");
    for (const [accountId, userId] of Object.entries(users)) {
      await pool.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'WABA test owner','test-only-hash')", [userId, `${userId}@example.invalid`]);
      await pool.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'WABA test',$2)", [accountId, userId]);
      await pool.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner')", [accountId, userId]);
      await pool.query("INSERT INTO profiles(user_id,email,full_name,account_id,account_role) VALUES($1,$2,'WABA test owner',$3,'owner')", [userId, `${userId}@example.invalid`, accountId]);
    }
    await pool.query("COMMIT");
  });
  afterAll(async () => { await pool?.end(); });

  it("moves a WABA to the workspace that reconnects its number after another disconnected it", async () => {
    const waba = randomUUID(), phone = randomUUID();
    const rowX = await connect(accountX, phone, waba);
    expect(await resolveWaba(waba)).toBe(accountX);
    await disconnect(accountX, rowX);
    expect(await resolveWaba(waba)).toBeNull();
    await connect(accountY, phone, waba);
    expect(await resolveWaba(waba)).toBe(accountY);
    // Only the worker may call it.
    await expect(tenant(accountY, db => db.query("SELECT crm_resolve_waba_account($1)", [waba]))).rejects.toMatchObject({ code: "42501" });
  });

  it("keeps failing closed when two workspaces hold numbers of one WABA connected", async () => {
    const waba = randomUUID();
    await connect(accountX, randomUUID(), waba);
    await connect(accountZ, randomUUID(), waba);
    expect(await resolveWaba(waba)).toBeNull();
  });

  it("still counts a disconnected row that kept its token (failed registration)", async () => {
    const waba = randomUUID();
    await tenant(accountY, db => db.query("INSERT INTO whatsapp_config(user_id,phone_number_id,waba_id,access_token,status) VALUES($1,$2,$3,'test-only-encrypted-token','disconnected')", [userY, randomUUID(), waba]));
    expect(await resolveWaba(waba)).toBe(accountY);
    await connect(accountZ, randomUUID(), waba);
    expect(await resolveWaba(waba)).toBeNull();
  });
});
