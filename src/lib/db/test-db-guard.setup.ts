// vitest setupFiles entry (vitest.config.ts): enforces the local-only test database guard in
// three places, so no test can reach a remote or production database by accident:
//   1. now, before the test file is imported (stray shell variables);
//   2. in a root beforeAll, after the test file's own dotenv config({ path: '.env.test' }) ran;
//   3. at every pg socket open (Prisma's PrismaPg adapter and raw pg Pools both use pg.Client),
//      which also covers URLs assigned to process.env inside a test.
// src/lib/db/prisma.ts checks again when it builds a client. ALLOW_REMOTE_TEST_DB=1 (set only by
// npm run test:db / test:all) disables it.
import pg from "pg";
import { beforeAll } from "vitest";
import { assertLocalTestDatabaseEnv, assertLocalTestDatabaseHost } from "./test-db-guard";

assertLocalTestDatabaseEnv();

beforeAll(() => {
  assertLocalTestDatabaseEnv();
});

const PATCHED = Symbol.for("bodhinox.testDbGuard");
type GuardedClient = { host?: string; _connect: (callback: (error?: Error) => void) => void };
const proto = pg.Client.prototype as unknown as GuardedClient & { [PATCHED]?: true };
if (!proto[PATCHED]) {
  const original = proto._connect;
  proto._connect = function guardedConnect(this: GuardedClient, callback: (error?: Error) => void) {
    try {
      assertLocalTestDatabaseHost(this.host);
    } catch (error) {
      process.nextTick(() => callback(error as Error));
      return;
    }
    return original.call(this, callback);
  };
  proto[PATCHED] = true;
}
