# Test database guard and migration safety (Phase 15)

## Local-only test database guard

Every vitest run refuses to reach a database that is not on this machine. The check is in
`src/lib/db/test-db-guard.ts` and runs in three places:

1. `src/lib/db/test-db-guard.setup.ts` (registered as `setupFiles` in `vitest.config.ts`) checks
   every environment variable whose name contains `DATABASE_URL` before each test file loads, and
   again in a root `beforeAll`, after the file's own `config({ path: '.env.test' })` ran.
2. The same setup file patches `pg.Client` so any socket a test opens (Prisma's `PrismaPg` adapter
   and raw `pg.Pool`s both use it) must go to `127.0.0.1`, `localhost` or `::1`. This also covers
   URLs a test assigns to `process.env` after start-up.
3. `src/lib/db/prisma.ts` checks the URL again when it builds a client while `VITEST=true` or
   `NODE_ENV=test`. In production neither is set, so runtime behaviour is unchanged.

A refusal names the variable only, never the URL, host or password.

The only way past it is `ALLOW_REMOTE_TEST_DB=1`, which only `npm run test:db` (and therefore
`npm run test:all`) set, through `scripts/remote-test-db.cjs`. Those are the documented commands
for the shared remote test database in `.env.test`. `scripts/test-db-local.cjs` removes
`ALLOW_REMOTE_TEST_DB` from the environment it builds, so a value left in the shell cannot weaken a
local run. Everything else stays local:

| Command | Database | Guard |
| --- | --- | --- |
| `npm run test:all:local`, `npm run test:db:local` | local Docker (`scripts/test-db-local.cjs`) | on |
| `npm run test:e2e:local` | local Docker | Playwright, guarded by `scripts/e2e-server.cjs` |
| CI `npm test -- --maxWorkers=1` | CI service database on `127.0.0.1` | on, passes |
| `npm run test:db`, `npm run test:all` | remote test database in `.env.test` | off (`ALLOW_REMOTE_TEST_DB=1`) |
| `npx vitest run <file>` with `.env.test` pointing remote | refused | on |

Running a single database test file locally: `scripts/test-db-local.cjs run <name>` adds `<name>`
to its own `integration.test load.test` filters, and vitest ORs filters, so it runs the whole
database suite. For one file, start the container with `node scripts/test-db-local.cjs setup` and
run vitest with the variables from `.env.test.docker` only (delete every other `*DATABASE_URL*`
first and set `DATABASE_ENV_FILE=.env.test.docker`).

## Migration safety

Merging to `main` runs `prisma migrate deploy` against production while the previous release is
still serving, so `src/lib/db/migrations-lint.test.ts` (unit stage, runs in CI before the
production migrate job) checks every migration after `20261112100600_platform_validate`:

- name matches `^\d{14}_[a-z0-9_]+$`;
- no `DROP TABLE|COLUMN|CONSTRAINT|POLICY|FUNCTION|TRIGGER|INDEX|VIEW|MATERIALIZED VIEW|TYPE|SEQUENCE|SCHEMA|EXTENSION`,
  `RENAME`, `ALTER COLUMN ... TYPE`, `SET NOT NULL`, `TRUNCATE`, `DISABLE` / `NO FORCE ROW LEVEL SECURITY`
  or `DISABLE TRIGGER` unless the same line carries `-- additive-exception: <reason>`;
- no lock-heavy DDL on an existing table (a `CREATE INDEX` without `CONCURRENTLY`, `CREATE POLICY`,
  `ENABLE` / `FORCE ROW LEVEL SECURITY`, `CREATE TRIGGER`, a `CHECK` constraint without `NOT VALID`,
  also inside dynamic SQL in a `DO` block) unless the table is created earlier in the same migration or
  the statement carries `-- additive-exception: <reason>`;
- an index migration is one `CREATE INDEX CONCURRENTLY` statement without `IF NOT EXISTS`;
  every other migration's first statement is `SET LOCAL lock_timeout = '5s';`;
- a foreign key added to an existing table is `NOT VALID` (validated in a later migration);
- a `SECURITY DEFINER` function sets `search_path=public,pg_temp` and revokes `PUBLIC`.

`prisma/migration-checksums.json` holds the sha256 of every `migration.sql` with CRLF normalized
to LF (production checks out on Linux). The same test fails when a listed migration changes, is
removed, or a new migration is not listed. After adding a migration run
`node scripts/release/migration-checksums.cjs` (reads repository files only, no database). The script is append-only: it adds missing migrations, keeps every recorded hash, and exits 1 naming any recorded migration whose file changed, writing nothing. `--rewrite <name>` re-records one migration and is only for a migration that has never been deployed.

`src/lib/db/rls-sweep.integration.test.ts` checks the migrated schema: forced RLS with an
`app_account_id()` policy on every table with `account_id`/`tenant_id` (plus `accounts`), an
allowlist with a reason and pinned app-role access for every other table, no superuser or
`BYPASSRLS` on the constrained roles, a reviewed snapshot of secret-like columns the app role can
read, and pinned `search_path` without `PUBLIC` execute on every `SECURITY DEFINER` function.
