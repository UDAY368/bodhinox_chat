# Contributing to Bodhinox Chat

Read AGENTS.md and the installed Next.js guides before changing framework behavior. Original attribution remains in LICENSE and README.md.

Use Node24, npm, TypeScript, React and the existing UI components. Application data uses Prisma/PostgreSQL with constrained app/auth/worker roles. Every domain query runs inside withTenant; user_id is historical audit identity and account_id is the tenancy boundary. Current role comes from active membership and a live session.

Use additive Prisma migrations. Do not edit deployed checksums. Database tests use a separate test database, never production. scripts/ci-environment.cjs overwrites local env files and is intended only for disposable CI.

Preserve fixed resource/query/RPC contracts; never expose arbitrary tables, raw SQL, worker flags, system credentials, provider tokens or password hashes through a browser API. Require JWT/currentmembership/role and mutation-origin/CSRF checks before external actions.

Queue background tasks before acknowledging them. Outbound intents and inbound stage checkpoints prevent blind re-sends after ambiguous outcomes; surface reconciliation instead of automatically clearing those records. Keep customer content and secrets out of logs.

Validate with npm run typecheck, npm run lint, npm test -- --maxWorkers=1, and npm run build. Add meaningful security, durability and tenancy tests for behavior changes. Update the feature inventory and deployment runbook as behavior changes.
