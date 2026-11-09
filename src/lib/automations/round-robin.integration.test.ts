import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disconnectDatabases, getWorkerPrisma } from "@/lib/db/prisma";
import { canOwnConversations, nextRoundRobinAgent, pickNextMember } from "./round-robin";

describe("pickNextMember", () => {
  it("rotates in order and wraps", () => {
    expect(pickNextMember(["a", "b", "c"], null)).toBe("a");
    expect(pickNextMember(["a", "b", "c"], "a")).toBe("b");
    expect(pickNextMember(["a", "b", "c"], "c")).toBe("a");
  });
  it("continues after a member who left", () => {
    expect(pickNextMember(["a", "c"], "b")).toBe("c");
  });
  it("returns null without members", () => {
    expect(pickNextMember([], "a")).toBeNull();
  });
});

const configured = config({ path: ".env.test", quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
const accountId = randomUUID(), otherAccountId = randomUUID();
const users = [randomUUID(), randomUUID(), randomUUID()], viewer = randomUUID(), outsider = randomUUID();
let owner: pg.Client;

describe.skipIf(!ownerUrl || !workerUrl)("round-robin assignment on PostgreSQL", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    const ownerName = (await owner.query("SELECT current_database() AS name")).rows[0].name;
    const workerName = await getWorkerPrisma().$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
    if (!/test/i.test(ownerName) || workerName[0].name !== ownerName) throw new Error("Round-robin tests require isolated matching test database URLs");
    await owner.query("BEGIN");
    await owner.query("SET LOCAL ROLE bodhinox_auth");
    for (const id of [...users, viewer, outsider])
      await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Round robin test','test-only-hash')", [id, `${id}@example.invalid`]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Round robin',$2),($3,'Other account',$4)", [accountId, users[0], otherAccountId, outsider]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'agent'),($1,$4,'admin'),($1,$5,'viewer'),($6,$7,'owner')",
      [accountId, users[0], users[1], users[2], viewer, otherAccountId, outsider]);
    await owner.query("COMMIT");
  });
  afterAll(async () => {
    if (owner) {
      await owner.query("DELETE FROM accounts WHERE id IN ($1,$2)", [accountId, otherAccountId]);
      await owner.query("DELETE FROM auth_users WHERE id = ANY($1::uuid[])", [[...users, viewer, outsider]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it("spreads concurrent assignments evenly over replying members only", async () => {
    const picks = await Promise.all(Array.from({ length: 6 }, () => nextRoundRobinAgent(accountId)));
    const counts = new Map<string, number>();
    for (const id of picks) counts.set(id!, (counts.get(id!) ?? 0) + 1);
    expect([...counts.keys()].sort()).toEqual([...users].sort());
    expect([...counts.values()]).toEqual([2, 2, 2]);
    expect(picks).not.toContain(viewer);
    expect(picks).not.toContain(outsider);
  });

  it("lets only a current owner, admin or agent own a pinned conversation (audit #51)", async () => {
    expect(await canOwnConversations(accountId, users[1])).toBe(true);
    expect(await canOwnConversations(accountId, users[2].toUpperCase())).toBe(true);
    expect(await canOwnConversations(accountId, viewer)).toBe(false);
    expect(await canOwnConversations(accountId, outsider)).toBe(false);
    expect(await canOwnConversations(accountId, randomUUID())).toBe(false);
    expect(await canOwnConversations(accountId, "not-a-uuid")).toBe(false);
  });
});
