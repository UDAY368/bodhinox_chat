# Bodhinox Chat

WhatsApp CRM and automation adapted from [ArnasDon/wacrm](https://github.com/ArnasDon/wacrm), upstream commit `27c6bdf43633d1746410168431a8b0e22b4f2ba6`. Original MIT attribution is preserved in LICENSE.

The application keeps Next.js 16, React 19, TypeScript, Tailwind 4, Base UI/shadcn components, React Flow and the existing CRM screens. PostgreSQL on Railway replaces Supabase entirely. Prisma manages schema and migrations; JWT authentication, private S3 media, server-sent events and PostgreSQL jobs replace its hosted services.

## Features

See the [functionality and acceptance matrix](docs/architecture/bodhinox-functionality.md) for module coverage and remaining provider setup.

For account creation, WhatsApp connection and step-by-step examples of CRM workflows, see the [Bodhinox Chat user guide](docs/user-guide.md).

- Team inbox: conversations, text, templates, interactive replies, media, voice notes, reactions, unread state, assignments and browser notifications.
- Contacts: search, CSV import, tags, custom fields and WhatsApp identity matching.
- Sales pipelines: configurable stages, deals and contact associations.
- Broadcasts: audience selection, template personalization, persisted recipients, background delivery, delivery/read/reply tracking and explicit retry controls.
- Automations: event/keyword/tag triggers, conditions, WhatsApp replies, delays, waiting for replies, CRM mutations and scheduled triggers.
- Visual flows: node editor, interactive choices, input collection, conditions, media, handoff, fallback policies, runs and event logs.
- AI: provider settings, draft assistance, automatic replies, knowledge documents/embeddings and playground. Configure your own provider credentials.
- Teams: one-time invitations, owner/admin/agent/viewer permissions, memberships in multiple accounts and ownership transfer.
- Security: Argon2id passwords, verified email, JWT sessions, rotating refresh tokens, session revocation, TOTP/recovery codes and mandatory privileged MFA in production.
- Integrations: official Meta WhatsApp Cloud API, scoped public API keys, signed outbound webhooks and the bundled MCP API client.

This foundation uses the official Meta integration from the upstream project. WasenderAPI is a separate integration option and has not been substituted into these provider calls. Product-specific Bodhinox workflows can be built on this foundation.

## Local setup

Use Node.js 24.11 or newer within the 24.x series. From a fresh checkout:

```sh
npm ci
cp .env.local.example .env.local
# Fill server-only credentials. Never commit .env.local.
npm run db:preflight
npm run db:migrate
npm run db:roles
npm run dev
```

Run `npm run worker` in a second terminal. It handles persisted incoming messages, broadcasts, scheduled automation, delayed executions, flow timeout sweeps and webhook deliveries.

For this Railway database, the local public endpoint is `iriguchi.proxy.rlwy.net:26854`. `5432` is the database container's private port. Set `sslrootcert` to the absolute path of `deploy/railway-postgres-ca.crt`, with `sslmode=verify-ca&uselibpqcompat=true`. Certificate-chain verification remains enabled. The project CA is public; database passwords remain secret.

Generate independent role passwords and RSA JWT keys. `DATABASE_URL`, `AUTH_DATABASE_URL` and `WORKER_DATABASE_URL` must use `bodhinox_app`, `bodhinox_auth` and `bodhinox_worker`. The owner credential belongs only in `MIGRATION_DATABASE_URL` for operator migration commands. Deployed web and worker services do not receive it.

## Railway deployment through GitHub

Production services use `Dockerfile` (web) and `Dockerfile.worker` (worker), one replica each, in the existing Bodhinox_Chat project. The web healthcheck is `/api/health`. A private Railway bucket supplies media credentials through Railway reference variables, so they do not appear in GitHub.

Read [the deployment runbook](docs/deployment/railway.md) before applying migrations or changing the source branch. GitHub validation uses an isolated PostgreSQL 18/pgvector service, ephemeral RSA keys and no customer credentials. Production migrations use the manually dispatched workflow with a dedicated GitHub secret and environment. Apply reviewed migrations before deploying application code that depends on them.

Resend SMTP is configured in the ignored local environment and the Railway `Bodhinox-Web` service environment, with `bodhinox.com` as the app sender; `bodhinox.in` is also verified for sending. Complete a signup and email-delivery acceptance check before onboarding users. Configure `META_APP_SECRET` and connect the WhatsApp phone/WABA in Settings before accepting Meta webhooks or sending real messages. Meta and AI-provider delivery still require their credentials and an end-to-end acceptance check.

## Validation and architecture

```sh
npm run typecheck
npm run lint
npm test -- --maxWorkers=1
npm run build
npm run test:e2e
```

`npm run test:e2e` runs the Playwright browser suite in `e2e/`. It starts its own dev server on port 3100 from `.env.test` only (production keys from `.env.local` are blanked), seeds throwaway users and two workspaces, and removes them afterwards. Stop any local `next dev` first, since both use `.next`. Run artifacts go to the OS temp folder (`bodhinox-e2e`), because files written inside the project make the dev server reload the page.

Integration suites require an isolated `.env.test` database and constrained role URLs. They must never target the production database. `scripts/ci-environment.cjs` creates ephemeral configuration only for the CI service; do not run it over your working local credentials.

See [repository review](docs/architecture/2026-10-14-wacrm-repository-review.md), [database validation](docs/architecture/database-validation.md), [authentication validation](docs/architecture/authentication-validation.md), and [data-access validation](docs/architecture/data-access-validation.md). These distinguish source functionality, simulated provider tests and actual PostgreSQL checks.

Outbound sends have persisted intents. An interrupted or ambiguous provider outcome requires reconciliation; it is not automatically resent. This prevents blind duplicate messages and does not promise exactly-once delivery to external providers.
