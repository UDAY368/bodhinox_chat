# Backup and restore

Requirement ids: OPS-01. Env var names only; no secrets, tenant ids or customer content belong in this file or in incident notes.

Targets: RPO ≤ 24 h, RTO ≤ 4 h (OPS-01). Production evidence: owner-pending.

1. **Before any merge that carries a migration**: take a Railway Postgres backup (already step 3 of `docs/deployment/railway.md`).
2. **Owner drill in Railway (the production evidence)**: restore the latest Railway backup into a **staging or new service**, never over production. Record in the drill log: backup time, restore start/end, time until the app (pointed at the restored DB, staging only) answers `/api/health` and a sign-in works. RPO = restore point age; RTO = detection to working service.
3. **Dump verification (local)**: with a dump the owner provides (staging preferred; a production `pg_dump` contains customer data, is the owner's decision, stays outside the repo and is deleted after):
   `npx tsx scripts/restore-drill.ts --dump <file>` → starts `bodhinox-restore-drill` (`pgvector/pgvector:pg18`, 127.0.0.1:55433), creates the four NOLOGIN roles as the migrations do, `pg_restore --no-owner` (or `psql -f` for plain SQL), `db-bootstrap-roles` with throwaway passwords, `prisma migrate status`, `db-preflight`, row counts, one `withTenant` read as `bodhinox_app`. Writes `docs/testing/restore-drill-<date>.json` (counts and timings only; `--out` to change). `npx tsx scripts/restore-drill.ts --cleanup` removes the container. The script never reads `.env.local`/`.env.test` and refuses non-local URLs; `*.dump` and `restore-drill/` are git-ignored.
   `migrateStatus: behind-or-diverged` means the dump is older than HEAD (expected for an old backup); `result: pass` requires preflight pass, a migrate status other than `error`, a count for every counted table (a partly loaded dump fails) and a tenant read that passed (a dump with no accounts fails). `restore.exitCode` and `errorLines` are reported, not gated: `pg_restore --no-owner` exits non-zero on benign ownership errors, so read them in the report.
4. **Restore to production (owner only)**: written go/no-go first (who, why, data-loss window accepted). Stop the worker, put web in maintenance (scale to 0 or redeploy a maintenance build), restore the Railway backup, run `db:roles` with the production role passwords. A backup taken before a migration-carrying merge has an older schema than the deployed code: compare `_prisma_migrations` with the release's newest migration, then either dispatch the "Apply production Prisma migrations" workflow or redeploy the release that matches the restored schema, and confirm deep check `migrations.latest` equals that release's newest migration. Then start web, verify `/api/health` and the deep check, start the worker, check `unknown` intents and reconcile before any re-send.
5. **Drill log**: date, operator, backup age, RPO, RTO, result, follow-ups.

## Owner drill, step by step (about 45 minutes, no effect on the live site)

Do this once now and then every three months. Nothing here touches the production database.

1. **Note the time you start.** This is the "detection" time for the RTO figure.
2. **Pick the backup.** Railway → the Bodhinox project → the production Postgres service → **Backups**. Note the newest backup's time; that age is the RPO.
3. **Restore into a new service, never over production.** On that backup choose **Restore**, and restore it into a new Postgres service (Railway creates a new volume/service for it). Name it `postgres-restore-drill-<date>`. If Railway only offers "restore in place", stop and do not continue: use step 3 of the list above (a `pg_dump` from the backup run through `scripts/restore-drill.ts`) instead.
4. **Set the role passwords on the restored database.** From your own computer, write a throwaway env file outside the repo (never `.env.local`) holding `MIGRATION_DATABASE_URL` (the restored service's public URL as the `postgres` user) and `DATABASE_URL`, `AUTH_DATABASE_URL`, `WORKER_DATABASE_URL` as the same host with users `bodhinox_app`, `bodhinox_auth`, `bodhinox_worker` and new random passwords. Run `DATABASE_ENV_FILE=<that file> npm run db:roles`. Never reuse production passwords. Delete the file at step 8.
5. **Point a staging web service at it.** Railway → duplicate the web service into the staging environment (or use the existing staging service), set its `DATABASE_URL`, `AUTH_DATABASE_URL`, `WORKER_DATABASE_URL` and `PLATFORM_DATABASE_URL` to the restored service with the throwaway role passwords, and turn off outbound sending on that copy (no worker service, and leave the WhatsApp/Meta/payment variables unset) so restored data can never message a customer.
6. **Check it works.** Open `<staging url>/api/health` (must answer `ok`), then sign in with your own owner account and open Inbox, Contacts and Orders. Note the time: restore end and first working sign-in give the RTO.
7. **Write the drill log** (table below): date, who, backup age (RPO), detection to working sign-in (RTO), result, anything that went wrong.
8. **Clean up.** Delete the staging copy's database variables, then delete the `postgres-restore-drill-<date>` service. A restored copy holds customer data; it must not be left running.

Pass = health `ok`, sign-in works, the three screens show the expected workspace data, RPO ≤ 24 h and RTO ≤ 4 h.

### Drill log

| Date | Operator | Backup age (RPO) | Detection → working sign-in (RTO) | Result | Follow-ups |
|---|---|---|---|---|---|
| _owner to fill after the first drill_ | | | | | |

Local rehearsal evidence (2026-11-05, local Docker test DB dump, 1.3 MB): container 10.9 s, restore 10.1 s, roles 0.3 s, total 25 s; 120 migrations, migrate status up to date, preflight pass, tenant read pass. This proves the script, not production recovery.
